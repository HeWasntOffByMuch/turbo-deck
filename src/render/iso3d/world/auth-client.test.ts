/**
 * Signing a tab in (spec 226).
 *
 * The rule worth testing here is the one that decides whether the client works
 * against a server that predates auth: **a sign-in failure is not fatal.** The
 * socket is tried either way, because a server with no auth gate ignores the
 * token and one that wanted it refuses the `Hello` itself with a better
 * message than this layer could invent.
 *
 * `fetch` is stubbed rather than mocked wholesale, so what is asserted is the
 * request that goes out -- the endpoint, and whether the stored token was
 * presented -- as well as what comes back.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageLike } from '../../../ui/core/layout-store.js';
import { AUTH_TOKEN_KEY, httpOriginOf, planConnection } from './connection.js';
import {
  ensureAuthToken,
  needsGuestSession,
  registerAccount,
  signInToAccount,
  signOutOfAccount,
} from './auth-client.js';

function storage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

interface Call {
  readonly url: string;
  readonly authorization: string;
}

/** Answers each call in turn; records what was asked. */
function stubFetch(replies: readonly { status: number; body?: unknown }[]): Call[] {
  const calls: Call[] = [];
  let index = 0;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, authorization: headers['authorization'] ?? '' });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return Promise.resolve({
      ok: (reply?.status ?? 500) >= 200 && (reply?.status ?? 500) < 300,
      status: reply?.status ?? 500,
      json: () => Promise.resolve(reply?.body ?? {}),
    } as Response);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('needing a session', () => {
  it('is what an empty stored token means, and nothing else', () => {
    expect(needsGuestSession('')).toBe(true);
    expect(needsGuestSession('   ')).toBe(true);
    expect(needsGuestSession('a-real-looking-token')).toBe(false);
  });
});

describe('the http origin a tab signs in against', () => {
  it('is the ws url with the scheme swapped and the path dropped', () => {
    expect(httpOriginOf('ws://localhost:8787/ws')).toBe('http://localhost:8787');
    expect(httpOriginOf('wss://play.example.com/ws')).toBe('https://play.example.com');
    expect(httpOriginOf('ws://localhost:8787')).toBe('ws://localhost:8787'.replace('ws:', 'http:'));
  });

  it('rides on the plan, so one decision settles both halves', () => {
    const plan = planConnection('?server', { protocol: 'https:', host: 'play.example.com' }, storage(), () => 'id');
    if (plan.mode !== 'remote') throw new Error('expected remote');
    expect(plan.httpOrigin).toBe('https://play.example.com');
    expect(plan.authToken).toBe('');
  });
});

describe('ensuring a token', () => {
  it('creates a guest when there is none, and stores it', async () => {
    const store = storage();
    const calls = stubFetch([{ status: 201, body: { session: { token: 'tok-1', playerId: 'p_1' } } }]);

    const outcome = await ensureAuthToken('http://localhost:8787', '', store);
    expect(outcome).toMatchObject({ ok: true, token: 'tok-1', fresh: true });
    expect(store.map.get(AUTH_TOKEN_KEY)).toBe('tok-1');
    expect(calls[0]?.url).toBe('http://localhost:8787/api/auth/guest');
  });

  it('keeps a stored token that the server still recognises, with no new guest', async () => {
    const store = storage({ [AUTH_TOKEN_KEY]: 'tok-old' });
    const calls = stubFetch([{ status: 200, body: { identity: { playerId: 'p_1' } } }]);

    const outcome = await ensureAuthToken('http://localhost:8787', 'tok-old', store);
    expect(outcome).toMatchObject({ ok: true, token: 'tok-old', fresh: false });
    // One call, and it presented the token rather than asking for a new guest.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:8787/api/auth/session');
    expect(calls[0]?.authorization).toBe('Bearer tok-old');
  });

  it('replaces a token the server has stopped recognising', async () => {
    // The two ways this happens are an expiry and a claim rotating it, and both
    // leave a perfectly well-formed string in storage.
    const store = storage({ [AUTH_TOKEN_KEY]: 'tok-stale' });
    const calls = stubFetch([
      { status: 401 },
      { status: 201, body: { session: { token: 'tok-new', playerId: 'p_2' } } },
    ]);

    const outcome = await ensureAuthToken('http://localhost:8787', 'tok-stale', store);
    expect(outcome).toMatchObject({ ok: true, token: 'tok-new', fresh: true });
    expect(store.map.get(AUTH_TOKEN_KEY)).toBe('tok-new');
    expect(calls.map((c) => c.url)).toEqual([
      'http://localhost:8787/api/auth/session',
      'http://localhost:8787/api/auth/guest',
    ]);
  });

  it('leaves a stored token alone against a server that does not do auth', async () => {
    // An older build: no endpoint, so the token is meaningless rather than
    // wrong, and the connection is about to succeed without it.
    const store = storage({ [AUTH_TOKEN_KEY]: 'tok-old' });
    stubFetch([{ status: 404 }]);
    const outcome = await ensureAuthToken('http://localhost:8787', 'tok-old', store);
    expect(outcome).toMatchObject({ ok: true, fresh: false });
    expect(store.map.get(AUTH_TOKEN_KEY)).toBe('tok-old');
  });

  it('reports rather than throwing when the endpoint is missing entirely', async () => {
    stubFetch([{ status: 404 }]);
    const outcome = await ensureAuthToken('http://localhost:8787', '', storage());
    expect(outcome.ok).toBe(false);
  });

  it('reports rather than throwing when the network is gone', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('connection refused')));
    const outcome = await ensureAuthToken('http://localhost:8787', '', storage());
    expect(outcome).toMatchObject({ ok: false, reason: 'connection refused' });
  });

  it('reports a session with no token in it rather than storing an empty string', async () => {
    const store = storage();
    stubFetch([{ status: 201, body: { session: {} } }]);
    const outcome = await ensureAuthToken('http://localhost:8787', '', store);
    expect(outcome.ok).toBe(false);
    expect(store.map.has(AUTH_TOKEN_KEY)).toBe(false);
  });

  it('does not throw when storage refuses to keep the token', async () => {
    const hostile: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    stubFetch([{ status: 201, body: { session: { token: 'tok-1' } } }]);
    // Degraded rather than broken: this session works, the next load signs in
    // again and gets a different character. The same rule `planConnection`
    // already follows for a refused player id.
    await expect(ensureAuthToken('http://localhost:8787', '', hostile)).resolves.toMatchObject({ ok: true });
  });
});

describe('creating an account', () => {
  it('sends the form and presents the guest token, which is what makes it a claim', async () => {
    const calls = stubFetch([
      { status: 201, body: { session: { token: 'tok-new', playerId: 'p_1', displayName: 'Ada L' } } },
    ]);
    const outcome = await registerAccount('http://localhost:8787', 'guest-tok', {
      login: 'ada',
      password: 'a decent password',
      displayName: 'Ada L',
    });

    expect(outcome).toMatchObject({ ok: true, token: 'tok-new', playerId: 'p_1', displayName: 'Ada L' });
    expect(calls[0]?.url).toBe('http://localhost:8787/api/auth/register');
    // Without this header the server makes a *new* character beside the
    // account instead of claiming the one being played.
    expect(calls[0]?.authorization).toBe('Bearer guest-tok');
  });

  it('reports the refusal in the server’s own words', async () => {
    stubFetch([{ status: 409, body: { error: 'that login is already taken', code: 'login_taken' } }]);
    const outcome = await registerAccount('http://localhost:8787', 'guest-tok', {
      login: 'ada',
      password: 'a decent password',
      displayName: '',
    });
    expect(outcome).toEqual({ ok: false, reason: 'that login is already taken' });
  });

  it('falls back to the status when the server sent no message', async () => {
    stubFetch([{ status: 500, body: {} }]);
    const outcome = await registerAccount('http://localhost:8787', '', {
      login: 'ada',
      password: 'a decent password',
      displayName: '',
    });
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.reason).toContain('500');
  });

  it('refuses a success with no token rather than reporting one', async () => {
    stubFetch([{ status: 201, body: { session: { playerId: 'p_1' } } }]);
    const outcome = await registerAccount('http://localhost:8787', '', {
      login: 'ada',
      password: 'a decent password',
      displayName: '',
    });
    expect(outcome.ok).toBe(false);
  });

  it('reports rather than throwing when the network is gone', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('connection refused')));
    const outcome = await registerAccount('http://localhost:8787', '', {
      login: 'ada',
      password: 'a decent password',
      displayName: '',
    });
    expect(outcome).toEqual({ ok: false, reason: 'connection refused' });
  });
});

describe('signing in', () => {
  it('reports the guest character the server kept, so the UI can say what stayed behind', async () => {
    stubFetch([
      {
        status: 200,
        body: {
          session: { token: 'tok-acct', playerId: 'p_account', displayName: 'Ada L' },
          retainedGuestPlayerId: 'p_guest',
        },
      },
    ]);
    const outcome = await signInToAccount('http://localhost:8787', 'guest-tok', {
      login: 'ada',
      password: 'a decent password',
    });
    expect(outcome).toMatchObject({ ok: true, playerId: 'p_account', retainedGuestPlayerId: 'p_guest' });
  });

  it('reports null when there was no guest to retain', async () => {
    stubFetch([{ status: 200, body: { session: { token: 't', playerId: 'p', displayName: 'A' } } }]);
    const outcome = await signInToAccount('http://localhost:8787', '', { login: 'a', password: 'b' });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.retainedGuestPlayerId).toBeNull();
  });

  it('gives the generic refusal back unchanged', async () => {
    stubFetch([{ status: 401, body: { error: 'login or password is incorrect' } }]);
    const outcome = await signInToAccount('http://localhost:8787', '', { login: 'a', password: 'b' });
    expect(outcome).toEqual({ ok: false, reason: 'login or password is incorrect' });
  });
});

describe('signing out', () => {
  it('revokes at the server and forgets the token here', async () => {
    const store = storage({ [AUTH_TOKEN_KEY]: 'tok' });
    const calls = stubFetch([{ status: 200, body: { revoked: true } }]);
    await signOutOfAccount('http://localhost:8787', 'tok', store);
    expect(calls[0]?.url).toBe('http://localhost:8787/api/auth/logout');
    expect(store.map.has(AUTH_TOKEN_KEY)).toBe(false);
  });

  it('forgets it anyway when the server cannot be reached', async () => {
    // Otherwise a sign-out on a dropped connection is a button that visibly
    // does nothing, and the next load signs straight back in.
    const store = storage({ [AUTH_TOKEN_KEY]: 'tok' });
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    await signOutOfAccount('http://localhost:8787', 'tok', store);
    expect(store.map.has(AUTH_TOKEN_KEY)).toBe(false);
  });
});
