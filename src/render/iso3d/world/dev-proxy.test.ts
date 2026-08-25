/**
 * Everything the client asks its own origin for is forwarded in development
 * (spec 226).
 *
 * The bug this exists to prevent shipped once and is worth describing exactly,
 * because it is invisible from either side alone. With a bare `?server` the
 * client dials its **own origin** -- that is what makes "no port to type" work
 * -- so in development both the socket and the sign-in request go to vite. The
 * socket was proxied and the sign-in was not, which meant the game connected
 * perfectly and the player was told the server does not hand out sessions.
 *
 * Every piece was individually correct: the endpoint existed, the client called
 * it, CORS was set. CORS could not help, because the request never left the dev
 * server.
 *
 * Why nothing caught it is worth stating exactly, because the obvious answer is
 * wrong. It is **not** that no harness covers the configuration: `probe-chat.ts`
 * and `probe-trade.ts` both stand up a real dev server and load a bare
 * `?server`, and both would have gone red. Neither is run by anything -- they
 * are manual, not in `package.json`, not in CI. What the *automated* gates
 * cover is the other configuration: every probe that runs unattended passes an
 * explicit `?server=ws://host:port`, which points the auth origin straight at
 * the game server and skips the proxy; and `connection.test.ts` sits on the
 * broken configuration -- its page origin is literally `localhost:5173` -- but
 * asserted only `plan.url` and never `plan.httpOrigin`.
 *
 * So this asserts the join rather than either end: the paths the client builds
 * against its own origin, and the prefixes `vite.config.ts` forwards. Change
 * one without the other and this fails.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import viteConfig from '../../../../vite.config.js';
import { AUTH_PATH_PREFIX } from './auth-client.js';
import { httpOriginOf, WS_PATH } from './connection.js';

/** The proxy table, however `defineConfig` handed it back. */
function proxyKeys(): readonly string[] {
  const config = viteConfig as { server?: { proxy?: Record<string, unknown> } };
  return Object.keys(config.server?.proxy ?? {});
}

/** Whether some proxy entry would claim `path`. Vite matches on prefix. */
function proxied(path: string): boolean {
  return proxyKeys().some((key) => path === key || path.startsWith(`${key}/`));
}

/** The target of one proxy entry, however it was written. */
function targetOf(key: string): string {
  const config = viteConfig as {
    server?: { proxy?: Record<string, { target?: string } | string> };
  };
  const entry = config.server?.proxy?.[key];
  return typeof entry === 'string' ? entry : entry?.target ?? '';
}

const authTarget = (): string => targetOf(AUTH_PATH_PREFIX);
const socketTarget = (): string => targetOf(WS_PATH);

describe('the dev proxy', () => {
  it('forwards the auth prefix the client actually builds its URLs from', () => {
    // Not the literal '/api/auth': the *constant*, so renaming it in
    // `auth-client.ts` and forgetting the config is a red test rather than a
    // 404 nobody sees until a playtester reports it.
    expect(proxied(AUTH_PATH_PREFIX)).toBe(true);
  });

  it('forwards every auth endpoint the client can call', () => {
    for (const endpoint of ['guest', 'register', 'login', 'logout', 'session']) {
      expect(proxied(`${AUTH_PATH_PREFIX}/${endpoint}`), endpoint).toBe(true);
    }
  });

  it('forwards the game socket, on the path the client dials', () => {
    expect(proxied(WS_PATH)).toBe(true);
  });

  it('aims the auth proxy at exactly the socket target, converted to http', () => {
    // The two entries name **one server**, so the auth target must be the
    // socket target with its scheme swapped -- asserted as that relationship
    // rather than as a pattern, which is the part the first version of this
    // test got wrong: it checked `/^https?:/` against a config whose env is
    // unset in CI, so it only ever saw the default and would have stayed green
    // while `GAME_SERVER=wss://...` silently proxied cleartext to port 443.
    expect(authTarget()).toBe(httpOriginOf(socketTarget()));
  });

  it('never hands a ws or wss scheme to an http proxy entry', () => {
    // `http-proxy` picks its transport with `target.protocol === 'https:'` and
    // defaults the port with `/^https|wss/`, so a `wss:` target is a cleartext
    // request to a TLS port -- a silent downgrade rather than a failure.
    expect(authTarget()).toMatch(/^https?:\/\//);
    expect(httpOriginOf('wss://play.example.com:8787/ws')).toBe('https://play.example.com:8787');
    expect(httpOriginOf('ws://localhost:8787/ws')).toBe('http://localhost:8787');
  });

  it('carries no path on the auth target, which a proxy would prefix onto every request', () => {
    expect(new URL(authTarget()).pathname).toBe('/');
    // Including when the socket target has one, which is the ordinary form.
    expect(httpOriginOf('ws://localhost:8787/ws')).not.toContain('/ws');
  });

  it('leaves the socket entry on a ws target, which is what an upgrade needs', () => {
    expect(socketTarget()).toMatch(/^wss?:\/\//);
    const config = viteConfig as {
      server?: { proxy?: Record<string, { ws?: boolean } | string> };
    };
    const entry = config.server?.proxy?.[WS_PATH];
    // Without this the proxy answers the handshake as plain HTTP.
    expect(typeof entry === 'string' ? false : entry?.ws).toBe(true);
  });
});

describe('the conversion, under an environment CI never has', () => {
  /**
   * The hole the first version of this file left, and it is the one that
   * matters: `vite.config.ts` is evaluated **once, at import**, against the
   * ambient environment. CI runs with `GAME_SERVER` unset, so every assertion
   * above sees only the `ws://localhost:8787` default -- and a config that
   * passed the variable through raw would sail through CI while silently
   * proxying cleartext to port 443 for anyone running a TLS playtest server.
   *
   * So the config is re-imported against a stubbed environment. That is the
   * only way to exercise a decision made at module scope from a test that does
   * not control how the process was launched.
   */
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function authTargetWith(gameServer: string): Promise<string> {
    vi.stubEnv('GAME_SERVER', gameServer);
    vi.resetModules();
    const fresh = (await import('../../../../vite.config.js')).default as {
      server?: { proxy?: Record<string, { target?: string } | string> };
    };
    const entry = fresh.server?.proxy?.[AUTH_PATH_PREFIX];
    return typeof entry === 'string' ? entry : entry?.target ?? '';
  }

  it('turns a wss socket target into https, not a cleartext request to 443', async () => {
    expect(await authTargetWith('wss://play.example.com:8787/ws')).toBe('https://play.example.com:8787');
  });

  it('turns a ws socket target into http', async () => {
    expect(await authTargetWith('ws://10.0.0.4:9000/ws')).toBe('http://10.0.0.4:9000');
  });

  it('drops the path in every form, so nothing is prefixed onto forwarded requests', async () => {
    expect(await authTargetWith('ws://localhost:9000/ws')).toBe('http://localhost:9000');
    expect(await authTargetWith('ws://localhost:9000')).toBe('http://localhost:9000');
  });
});
