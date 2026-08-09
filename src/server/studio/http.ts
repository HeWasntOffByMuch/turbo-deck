/**
 * A router, because `src/server/index.ts` had one `if` (spec 108).
 *
 * Small on purpose: method, a path pattern with `:name` segments, a handler.
 * Nothing here is a framework -- there is no middleware chain, no body parser
 * registry and no content negotiation, because the studio API is seven routes
 * that all speak JSON and one that takes an upload.
 *
 * The one thing it does insist on is that a route declares whether it is
 * `public`. The default is authenticated, so a route added later without
 * thinking about it is closed rather than open. These routes spend money.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export type Params = Readonly<Record<string, string>>;

export interface RequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly params: Params;
  readonly url: URL;
  /** Who the token said they were, or null on a public route. */
  readonly subject: string | null;
}

export type Handler = (context: RequestContext) => Promise<void> | void;

export interface Route {
  readonly method: string;
  readonly pattern: string;
  readonly handler: Handler;
  /** Opt-in, and only for things that cannot spend or reveal anything. */
  readonly public?: boolean;
}

export type Authorize = (
  request: IncomingMessage,
) => { readonly ok: true; readonly subject: string } | { readonly ok: false; readonly reason: string };

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // The studio API is same-origin only. No CORS header is set anywhere here,
    // deliberately: a browser on another origin must not be able to spend money
    // with a token it phished out of local storage.
    'cache-control': 'no-store',
  });
  response.end(text);
}

/** Matches a pattern like `/api/studio/jobs/:id` against a concrete path. */
export function matchPath(pattern: string, path: string): Params | null {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (const [index, expected] of patternParts.entries()) {
    const actual = pathParts[index];
    if (actual === undefined) return null;
    if (expected?.startsWith(':')) {
      const name = expected.slice(1);
      if (actual === '') return null;
      params[name] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

/** Reads a request body, refusing anything implausibly large. */
export async function readBody(request: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limitBytes) {
      throw new Error(`request body over ${limitBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(request: IncomingMessage, limitBytes: number): Promise<unknown> {
  const body = await readBody(request, limitBytes);
  if (body.length === 0) return {};
  return JSON.parse(body.toString('utf8')) as unknown;
}

export class Router {
  private readonly routes: Route[] = [];

  constructor(private readonly authorize: Authorize) {}

  add(route: Route): this {
    this.routes.push(route);
    return this;
  }

  /**
   * Handles a request, or returns false so the caller's own handler can.
   *
   * Returning false rather than 404ing is what lets the studio API be bolted
   * onto the existing admin-page server without either knowing about the other.
   */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    /** Routes whose path matches, whatever their verb. Drives the 401/405 order. */
    const onPath = this.routes.filter((route) => matchPath(route.pattern, url.pathname) !== null);

    for (const route of onPath) {
      const params = matchPath(route.pattern, url.pathname);
      if (params === null) continue;
      if (route.method !== (request.method ?? 'GET')) continue;

      let subject: string | null = null;
      if (route.public !== true) {
        const auth = this.authorize(request);
        if (!auth.ok) {
          sendJson(response, 401, { error: auth.reason });
          return true;
        }
        subject = auth.subject;
      }

      try {
        await route.handler({ request, response, params, url, subject });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!response.headersSent) sendJson(response, 500, { error: message });
      }
      return true;
    }

    // A path this router owns, reached with the wrong verb, is a 405 rather than
    // falling through to the admin page -- which would answer a POST with HTML.
    //
    // Authenticated first, though, when every route on the path is: a 405 tells
    // an anonymous caller that the path exists, and these paths are a list of
    // the ways to spend money. Closed by default applies to what the door says
    // as well as to whether it opens.
    if (onPath.length > 0) {
      if (onPath.every((route) => route.public !== true) && !this.authorize(request).ok) {
        sendJson(response, 401, { error: 'missing or invalid bearer token' });
        return true;
      }
      sendJson(response, 405, { error: `${request.method ?? 'GET'} not allowed here` });
      return true;
    }
    return false;
  }
}
