/**
 * The auth endpoints over a real socket (spec 226).
 *
 * Everything about *what* the endpoints decide is asserted in `auth.test.ts`
 * and `guest.test.ts` against the service directly. What only a socket can
 * answer is whether a correctly-formed request is **claimed** at all -- and the
 * answer was no for one shape of it, found by a raw-socket probe rather than by
 * anything in this suite.
 *
 * `request.url` is the request target *verbatim*, and RFC 9112 permits
 * absolute-form: `POST http://host/api/auth/guest HTTP/1.1`. Matched with
 * `startsWith('/api/auth/')` that declines, and the request falls through to
 * the server's own 404 -- a correct request, refused, with the endpoint sitting
 * right there. A proxy or a hand-written client sends that form routinely.
 *
 * Raw sockets rather than `fetch`, because `fetch` will not emit an
 * absolute-form target: the bug is unreachable through a well-behaved client,
 * which is exactly why it survived.
 */

import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuthHttp } from './http.js';
import { openTestStack, type TestStack } from '../persistence/testing.js';

let stack: TestStack;
let server: Server;
let port: number;

beforeEach(async () => {
  stack = openTestStack();
  const handle = createAuthHttp({ auth: stack.current.auth });
  server = createServer((request, response) => {
    void handle(request, response).then((claimed) => {
      // Whatever auth does not claim gets the same plain 404 `index.ts` gives,
      // so an unclaimed request is visible as such.
      if (!claimed) response.writeHead(404).end('not found');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  stack.dispose();
});

/**
 * Send a literal request and return everything that came back.
 *
 * `Connection: close` is inserted rather than left to the caller, and it is not
 * a detail: HTTP/1.1 keeps the socket open, so without it `close` never fires
 * and every one of these resolves on the safety timeout instead -- eight tests
 * measuring four seconds of nothing each, and passing.
 */
function raw(head: string, body = ''): Promise<string> {
  const payload =
    `${head}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n` +
    (body === ''
      ? 'Content-Length: 0\r\n\r\n'
      : `content-type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);

  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(payload));
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
    });
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    // A backstop only. If this is what resolves, the request hung.
    setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, 4000);
  });
}

const statusOf = (response: string): string => response.split('\r\n')[0] ?? '';

describe('which requests the auth handler claims', () => {
  it('claims an ordinary origin-form request', async () => {
    const response = await raw('POST /api/auth/guest HTTP/1.1');
    expect(statusOf(response)).toContain('201');
  });

  it('claims an absolute-form request, which a proxy may well send', async () => {
    const response = await raw(`POST http://127.0.0.1:${port}/api/auth/guest HTTP/1.1`);
    // Was a 404 before `pathnameOf`: the target does not start with a slash, so
    // the prefix test declined and the request fell through.
    expect(statusOf(response)).toContain('201');
    expect(response).not.toContain('not found');
  });

  it('claims a request carrying a query string', async () => {
    const response = await raw('POST /api/auth/guest?from=probe HTTP/1.1');
    expect(statusOf(response)).toContain('201');
  });

  it('leaves a path that is not auth to whoever else wants it', async () => {
    const response = await raw('GET /api/studio/config HTTP/1.1');
    expect(statusOf(response)).toContain('404');
    expect(response).toContain('not found');
  });

  it('answers the preflight a cross-origin sign-in sends first', async () => {
    const response = await raw(
      'OPTIONS /api/auth/guest HTTP/1.1\r\nOrigin: http://localhost:5173\r\nAccess-Control-Request-Method: POST',
    );
    expect(statusOf(response)).toContain('204');
    expect(response.toLowerCase()).toContain('access-control-allow-origin: *');
    // Absent on purpose: nothing here is authenticated by an ambient
    // credential, and adding it would make the wildcard origin unsafe.
    expect(response.toLowerCase()).not.toContain('access-control-allow-credentials');
  });

  it('refuses the wrong method rather than falling through to a 404', async () => {
    const response = await raw('GET /api/auth/guest HTTP/1.1');
    expect(statusOf(response)).toContain('405');
    expect(response).toContain('use POST');
  });

  it('answers its own 404 for an endpoint it does not have', async () => {
    const response = await raw('POST /api/auth/nonesuch HTTP/1.1');
    expect(statusOf(response)).toContain('404');
    // Auth's JSON 404, not the server's plain-text one: the request was claimed.
    expect(response).toContain('no such auth endpoint');
  });

  it('never puts a credential in a response it refused', async () => {
    // `raw` computes the length: one typed short by a byte leaves the server
    // waiting on a body that never finishes, and the test then measures a
    // timeout rather than a refusal.
    const response = await raw(
      'POST /api/auth/login HTTP/1.1',
      JSON.stringify({ login: 'nobody', password: 'not a password' }),
    );
    expect(statusOf(response)).toContain('401');
    expect(response).toContain('login or password is incorrect');
    // The refusal carries no session of any kind -- checked on the body rather
    // than the whole response, since headers legitimately mention no such word.
    const payload = response.slice(response.indexOf('\r\n\r\n'));
    expect(payload).not.toContain('token');
    expect(payload).not.toContain('session');
  });
});
