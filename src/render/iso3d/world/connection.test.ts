/**
 * Which server, and who am I (spec 144).
 *
 * A table, because getting this wrong means two tabs claiming the same player
 * and the symptom looks like a server bug rather than a query-string bug.
 */

import { describe, expect, it } from 'vitest';
import type { StorageLike } from '../../../ui/core/layout-store.js';
import {
  httpOriginOf,
  planConnection,
  AUTH_TOKEN_KEY,
  PLAYER_ID_KEY,
  PLAYER_NAME_KEY,
  SESSION_TOKEN_KEY,
} from './connection.js';

function storage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

/** A storage that refuses everything -- private browsing, a quota, a policy. */
function hostileStorage(): StorageLike {
  return {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };
}

const HTTP = { protocol: 'http:', host: 'localhost:5173' };
const HTTPS = { protocol: 'https:', host: 'play.example.com' };

function ids(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe('planConnection', () => {
  it('is single-player when nothing asks otherwise', () => {
    expect(planConnection('', HTTP, storage(), ids(), storage())).toEqual({ mode: 'loopback' });
    // Other params must not accidentally turn multiplayer on.
    expect(planConnection('?seed=4&units=grazer:pig', HTTP, storage(), ids(), storage())).toEqual({
      mode: 'loopback',
    });
  });

  it('defaults a bare ?server to the same origin', () => {
    const plan = planConnection('?server', HTTP, storage(), ids(), storage());
    expect(plan.mode).toBe('remote');
    if (plan.mode !== 'remote') return;
    expect(plan.url).toBe('ws://localhost:5173/ws');
  });

  it('uses wss when the page is https', () => {
    const plan = planConnection('?server', HTTPS, storage(), ids(), storage());
    if (plan.mode !== 'remote') throw new Error('expected remote');
    expect(plan.url).toBe('wss://play.example.com/ws');
  });

  it('takes an explicit url verbatim, and converts an http one', () => {
    const cases: readonly [string, string][] = [
      ['?server=ws://localhost:8787/ws', 'ws://localhost:8787/ws'],
      ['?server=wss://other.example.com/game', 'wss://other.example.com/game'],
      ['?server=http://localhost:8787/ws', 'ws://localhost:8787/ws'],
      ['?server=https://other.example.com/', 'wss://other.example.com/'],
    ];
    for (const [search, expected] of cases) {
      const plan = planConnection(search, HTTP, storage(), ids(), storage());
      if (plan.mode !== 'remote') throw new Error(`expected remote for ${search}`);
      expect(plan.url).toBe(expected);
    }
  });

  it('falls back to a real host when the page has no origin', () => {
    const plan = planConnection('?server', { protocol: 'file:', host: '' }, storage(), ids(), storage());
    if (plan.mode !== 'remote') throw new Error('expected remote');
    expect(plan.url).toBe('ws://localhost:8787/ws');
  });

  it('mints an id once and reuses it -- a reload is the same player', () => {
    const store = storage();
    const mint = ids();
    const first = planConnection('?server', HTTP, store, mint, storage());
    const second = planConnection('?server', HTTP, store, mint, storage());
    if (first.mode !== 'remote' || second.mode !== 'remote') throw new Error('expected remote');
    expect(first.playerId).toBe('id-1');
    expect(second.playerId).toBe('id-1');
    expect(store.map.get(PLAYER_ID_KEY)).toBe('id-1');
  });

  it('gives two tabs two players', () => {
    // Two sessionStorages is exactly what two tabs are.
    const mint = ids();
    const a = planConnection('?server', HTTP, storage(), mint, storage());
    const b = planConnection('?server', HTTP, storage(), mint, storage());
    if (a.mode !== 'remote' || b.mode !== 'remote') throw new Error('expected remote');
    expect(a.playerId).not.toBe(b.playerId);
  });

  it('lets ?id pin the identity, and stores it', () => {
    const store = storage();
    const plan = planConnection('?server&id=ana', HTTP, store, ids(), storage());
    if (plan.mode !== 'remote') throw new Error('expected remote');
    expect(plan.playerId).toBe('ana');
    expect(store.map.get(PLAYER_ID_KEY)).toBe('ana');
  });

  it('takes ?name, persists it, and derives one when absent', () => {
    const store = storage();
    const named = planConnection('?server&name=Ana', HTTP, store, ids(), storage());
    if (named.mode !== 'remote') throw new Error('expected remote');
    expect(named.displayName).toBe('Ana');
    expect(store.map.get(PLAYER_NAME_KEY)).toBe('Ana');

    // A reload without ?name keeps it.
    const again = planConnection('?server', HTTP, store, ids(), storage());
    if (again.mode !== 'remote') throw new Error('expected remote');
    expect(again.displayName).toBe('Ana');

    const anon = planConnection('?server&id=abcdef', HTTP, storage(), ids(), storage());
    if (anon.mode !== 'remote') throw new Error('expected remote');
    expect(anon.displayName).toBe('Player abcd');
  });

  it('dials the built-in server when nothing asks otherwise (spec 153)', () => {
    const plan = planConnection('', HTTPS, storage(), ids(), storage(), 'wss://play.example.net/ws');
    if (plan.mode !== 'remote') throw new Error('expected remote');
    expect(plan.url).toBe('wss://play.example.net/ws');
    // Everything else about a remote plan still holds on this path.
    expect(plan.playerId).toBe('id-1');
    expect(plan.resumeToken).toBe('');
  });

  it('lets an explicit ?server beat the built-in one', () => {
    const plan = planConnection(
      '?server=wss://other.example.com/game',
      HTTPS,
      storage(),
      ids(),
      storage(),
      'wss://play.example.net/ws',
    );
    if (plan.mode !== 'remote') throw new Error('expected remote');
    expect(plan.url).toBe('wss://other.example.com/game');
  });

  it('lets ?server=local turn a built-in server off', () => {
    // The half the preview scripts depend on: a build with a server baked in is
    // still drivable single-player, and neither word is read as a hostname.
    for (const word of ['local', 'off']) {
      expect(
        planConnection(
          `?server=${word}`,
          HTTPS,
          storage(),
          ids(),
          storage(),
          'wss://play.example.net/ws',
        ),
      ).toEqual({ mode: 'loopback' });
      // And with no default configured at all, which is `npm run dev`.
      expect(planConnection(`?server=${word}`, HTTPS, storage(), ids(), storage())).toEqual({
        mode: 'loopback',
      });
    }
  });

  it('normalises a built-in server exactly like a typed one', () => {
    const https = planConnection('', HTTPS, storage(), ids(), storage(), 'https://play.example.net/ws');
    if (https.mode !== 'remote') throw new Error('expected remote');
    expect(https.url).toBe('wss://play.example.net/ws');

    // A misconfigured value is never dialled literally; it degrades to this
    // origin, which is the same answer a bare `?server` gets.
    const junk = planConnection('', HTTPS, storage(), ids(), storage(), 'play.example.net');
    if (junk.mode !== 'remote') throw new Error('expected remote');
    expect(junk.url).toBe('wss://play.example.com/ws');
  });

  it('is still single-player when no server is built in', () => {
    // The regression that matters: an unconfigured build behaves as it always
    // has, so `npm run dev` and every preview script are untouched.
    expect(planConnection('', HTTP, storage(), ids(), storage(), '')).toEqual({ mode: 'loopback' });
    expect(planConnection('?seed=4', HTTP, storage(), ids(), storage(), '')).toEqual({ mode: 'loopback' });
  });

  it('costs a fresh id rather than an exception when storage refuses', () => {
    const mint = ids();
    const first = planConnection('?server&name=Ana', HTTP, hostileStorage(), mint, hostileStorage());
    const second = planConnection('?server&name=Ana', HTTP, hostileStorage(), mint, hostileStorage());
    if (first.mode !== 'remote' || second.mode !== 'remote') throw new Error('expected remote');
    expect(first.playerId).toBe('id-1');
    // Nothing persisted, so the next load is a new player -- degraded, not broken.
    expect(second.playerId).toBe('id-2');
    expect(first.displayName).toBe('Ana');
  });
});

describe('the two identities a tab holds', () => {
  /**
   * The bug this pins shipped and was severe: `planConnection` read the auth
   * token out of the storage it was handed -- `sessionStorage` -- while every
   * writer used `localStorage`. So `authToken` came back empty on every load,
   * `needsGuestSession` was always true, and **the page minted a brand-new
   * character every refresh**. Signing into an account survived exactly until
   * the reload that signing in itself triggers.
   *
   * Two storages that genuinely differ is the only arrangement that can catch
   * it: pass one object for both and the two reads are indistinguishable.
   */
  it('reads the account token from the account storage, not the tab one', () => {
    const tab = storage({ [PLAYER_ID_KEY]: 'p-tab', [SESSION_TOKEN_KEY]: 'resume-tab', [AUTH_TOKEN_KEY]: 'WRONG' });
    const account = storage({ [AUTH_TOKEN_KEY]: 'right-token' });

    const plan = planConnection('?server', HTTP, tab, ids(), account);
    if (plan.mode !== 'remote') throw new Error('expected remote');
    expect(plan.authToken).toBe('right-token');
    // And the per-tab identity still comes from the per-tab storage.
    expect(plan.playerId).toBe('p-tab');
    expect(plan.resumeToken).toBe('resume-tab');
  });

  it('carries an empty auth token when the person has never signed in', () => {
    const plan = planConnection('?server', HTTP, storage(), ids(), storage());
    if (plan.mode !== 'remote') throw new Error('expected remote');
    expect(plan.authToken).toBe('');
  });

  it('costs an empty token rather than an exception when the account storage refuses', () => {
    const plan = planConnection('?server', HTTP, storage(), ids(), hostileStorage());
    if (plan.mode !== 'remote') throw new Error('expected remote');
    // Degraded, not broken: this load signs in fresh. The same rule the player
    // id already follows.
    expect(plan.authToken).toBe('');
  });
});

describe('the http origin an auth request goes to', () => {
  it('drops a path, a query and a fragment alike', () => {
    const cases: readonly [string, string][] = [
      ['ws://localhost:8787/ws', 'http://localhost:8787'],
      ['wss://play.example.com/ws', 'https://play.example.com'],
      ['ws://localhost:8787', 'http://localhost:8787'],
      // Cutting on '/' alone kept these, so the endpoint appended after them
      // landed on `/` with a mangled query and the server refused it.
      ['ws://localhost:8787?x=1', 'http://localhost:8787'],
      ['ws://localhost:8787#frag', 'http://localhost:8787'],
      ['wss://h:8787?a=b', 'https://h:8787'],
    ];
    for (const [wsUrl, want] of cases) {
      expect(httpOriginOf(wsUrl), wsUrl).toBe(want);
    }
  });
});

describe('a ?server value that means nothing', () => {
  /**
   * `explicitUrl` is a four-way lowercase prefix test with a null default, so
   * everything else -- `localhost:8787`, `8787`, `/ws`, `HTTP://...` -- falls
   * back to the page's own origin. That is right for a bare `?server` and is a
   * silent wrong turn for a typo, so the plan says which happened.
   */
  it('reports the value it dropped, and still falls back', () => {
    for (const value of ['localhost:8787', '8787', '/ws', '//localhost:8787/ws', 'HTTP://localhost:8787', 'true']) {
      const plan = planConnection(`?server=${value}`, HTTP, storage(), ids(), storage());
      if (plan.mode !== 'remote') throw new Error('expected remote');
      expect(plan.ignoredServerValue, value).toBe(value);
      // Fallen back, not refused: the tab still connects somewhere.
      expect(plan.url, value).toBe('ws://localhost:5173/ws');
    }
  });

  it('reports nothing for a bare ?server, which is a deliberate same-origin dial', () => {
    const bare = planConnection('?server', HTTP, storage(), ids(), storage());
    if (bare.mode !== 'remote') throw new Error('expected remote');
    expect(bare.ignoredServerValue).toBe('');

    const empty = planConnection('?server=', HTTP, storage(), ids(), storage());
    if (empty.mode !== 'remote') throw new Error('expected remote');
    expect(empty.ignoredServerValue).toBe('');
  });

  it('reports nothing when the value was understood', () => {
    for (const value of ['ws://h:1/ws', 'wss://h/ws', 'http://h:1/ws', 'https://h/ws']) {
      const plan = planConnection(`?server=${value}`, HTTP, storage(), ids(), storage());
      if (plan.mode !== 'remote') throw new Error('expected remote');
      expect(plan.ignoredServerValue, value).toBe('');
    }
  });
});
