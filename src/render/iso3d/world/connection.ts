/**
 * Which server this tab talks to, and who it says it is (spec 144).
 *
 * Pure: it takes a query string, an origin, a storage and a way to mint an id,
 * and returns a decision. Nothing here opens a socket or touches the DOM, so
 * the whole rule is a table in a Node test rather than something only a browser
 * can answer -- which matters more than usual, because getting it wrong means
 * two tabs claiming the same player and the failure looks like a server bug.
 *
 * The identity lives in `sessionStorage`, and that is the whole trick behind
 * "two tabs are two players": session storage is per-tab *and* survives a
 * reload, which is exactly the lifetime wanted. `localStorage` would make both
 * tabs the same person; a fresh id per load would make F5 a stranger.
 */

import type { StorageLike } from '../../../ui/core/layout-store.js';

export const PLAYER_ID_KEY = 'turbo-deck.net.playerId';
export const PLAYER_NAME_KEY = 'turbo-deck.net.name';
/** The resume token from this tab's last session (spec 150). */
export const SESSION_TOKEN_KEY = 'turbo-deck.net.session';
/**
 * The auth session token this tab signed in with (spec 226).
 *
 * `localStorage`, not `sessionStorage`, and it is the one identity here that
 * deliberately does not follow the "two tabs are two players" rule above: an
 * *account* is a person, so a second tab is the same person, and a guest
 * character you keep is worth nothing if closing the tab loses the credential
 * that reaches it. Which body each tab drives is still settled per tab, by the
 * resume token beside it.
 */
export const AUTH_TOKEN_KEY = 'turbo-deck.net.auth';

/**
 * The path a browser client dials. The server accepts the upgrade on any path
 * -- `WebSocketTransport` passes no `path` to `WebSocketServer` -- so this is a
 * convention rather than something enforced at the other end. It is written
 * down here and in `PROTOCOL.md` so the dev proxy and the client cannot drift,
 * and it is not `/` because vite's own HMR socket lives there.
 */
export const WS_PATH = '/ws';

/** Where `?server` points when the page is not served from anywhere useful. */
const FALLBACK_ORIGIN = 'ws://localhost:8787';

export type ConnectionPlan =
  | { readonly mode: 'loopback' }
  | {
      readonly mode: 'remote';
      readonly url: string;
      readonly playerId: string;
      readonly displayName: string;
      /**
       * The token this tab last held, so a *reload* comes back to the same body
       * rather than spawning a second one beside it (spec 150). Empty when
       * there is none, which is every first load.
       */
      readonly resumeToken: string;
      /**
       * The session token to present in `Hello` (spec 226). Empty when this tab
       * has never signed in; `ensureAuthToken` is what fills it, and a server
       * with no auth gate ignores it either way.
       */
      readonly authToken: string;
      /**
       * A `?server=` value that was typed and then ignored (spec 226).
       *
       * `explicitUrl` recognises four lowercase scheme prefixes and answers
       * null for everything else, and null falls back to the page's own origin
       * -- so `?server=localhost:8787` does **not** dial :8787, it dials
       * whatever served the page, silently. That is the same shape of confusion
       * as the missing proxy: the client goes somewhere the player did not ask
       * for and says nothing.
       *
       * Reported rather than refused, because falling back is the right
       * behaviour for a bare `?server` and there is no way to tell a typo from
       * a deliberate bare one except by whether a value was given. Empty when
       * nothing was ignored. `view.ts` is what warns; this file stays pure.
       */
      readonly ignoredServerValue: string;
      /**
       * Where this tab's `/api/auth/*` calls go: the same host as `url`, over
       * http(s) rather than ws(s). Derived here rather than at the call site so
       * that the one place which decides which server this tab talks to decides
       * both halves of it.
       */
      readonly httpOrigin: string;
    };

/** Just the two fields of `location` this needs, so a test can pass a literal. */
export interface OriginLike {
  readonly protocol: string;
  readonly host: string;
}

function read(storage: StorageLike, key: string): string | null {
  // A storage can throw rather than return null -- private browsing, a disabled
  // cookie policy, a quota. The cost of that must be a fresh id, never a black
  // screen, which is the same rule `src/ui/input/`'s two preferences hold.
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: StorageLike, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Nothing to do and nothing worth saying: the id is still good for this
    // page, it just will not survive a reload.
  }
}

/**
 * Turn whatever `?server` said into a URL, or null to mean "same origin".
 *
 * `http`/`https` are accepted and converted because that is what somebody
 * pastes out of their address bar, and refusing it would be a puzzle rather
 * than a safeguard.
 */
function explicitUrl(value: string): string | null {
  if (value.startsWith('ws://') || value.startsWith('wss://')) return value;
  if (value.startsWith('http://')) return `ws://${value.slice('http://'.length)}`;
  if (value.startsWith('https://')) return `wss://${value.slice('https://'.length)}`;
  return null;
}

/** Keep the token this session was issued, for the next load of this tab. */
export function rememberSession(storage: StorageLike, token: string): void {
  write(storage, SESSION_TOKEN_KEY, token);
}

function sameOrigin(origin: OriginLike): string {
  if (origin.host === '') return `${FALLBACK_ORIGIN}${WS_PATH}`;
  const scheme = origin.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${origin.host}${WS_PATH}`;
}

/**
 * The identity this tab plays as. Minted once and kept, so a reload is the same
 * player and the server hands back the same character.
 */
function identify(
  params: URLSearchParams,
  storage: StorageLike,
  newId: () => string,
): { playerId: string; displayName: string } {
  const forced = params.get('id');
  let playerId = forced ?? read(storage, PLAYER_ID_KEY);
  if (playerId === null || playerId === '') {
    playerId = newId();
    write(storage, PLAYER_ID_KEY, playerId);
  } else if (forced !== null) {
    write(storage, PLAYER_ID_KEY, playerId);
  }

  const asked = params.get('name');
  if (asked !== null && asked !== '') {
    write(storage, PLAYER_NAME_KEY, asked);
    return { playerId, displayName: asked };
  }
  const stored = read(storage, PLAYER_NAME_KEY);
  if (stored !== null && stored !== '') return { playerId, displayName: stored };
  // Enough of the id to tell two tabs apart at a glance, which is all an
  // unnamed player needs.
  return { playerId, displayName: `Player ${playerId.slice(0, 4)}` };
}

/**
 * No `?server` is single-player, exactly as before. That is the default on
 * purpose: the loopback tab is the one every other spec's preview script
 * drives, and it must not start needing a server to boot.
 */
/**
 * Two storages, because this function reads two identities with two lifetimes
 * (spec 226).
 *
 * `tabStorage` is `sessionStorage`: which body this tab drives, and the resume
 * token that comes back to it. Per tab *and* surviving a reload is exactly the
 * lifetime "two tabs are two players" needs.
 *
 * `accountStorage` is `localStorage`: who the person is. An account is not
 * per-tab, and a guest character you keep is worth nothing if closing the tab
 * loses the only credential that reaches it.
 *
 * A second parameter rather than a default, and that is the whole point of the
 * change: it was one storage, `sessionStorage` was passed, and every *writer*
 * used `localStorage` -- so `authToken` came back empty on every load,
 * `needsGuestSession` was always true, and **the page minted a brand-new
 * character every time it was refreshed**. Signing into an account survived
 * exactly until the reload that signing in itself triggers. Making the caller
 * name both is what stops that being expressible.
 */
export function planConnection(
  search: string,
  origin: OriginLike,
  tabStorage: StorageLike,
  newId: () => string,
  accountStorage: StorageLike,
): ConnectionPlan {
  const params = new URLSearchParams(search);
  if (!params.has('server')) return { mode: 'loopback' };

  const asked = params.get('server') ?? '';
  const explicit = explicitUrl(asked);
  const url = explicit ?? sameOrigin(origin);
  // A value was given and none of the four schemes matched, so it was dropped.
  const ignoredServerValue = explicit === null && asked !== '' ? asked : '';
  const { playerId, displayName } = identify(params, tabStorage, newId);
  const resumeToken = read(tabStorage, SESSION_TOKEN_KEY) ?? '';
  // The one field that comes from the other storage. Read from where
  // `rememberAuthToken` writes, which is what was wrong.
  const authToken = read(accountStorage, AUTH_TOKEN_KEY) ?? '';
  return {
    mode: 'remote',
    url,
    playerId,
    displayName,
    resumeToken,
    authToken,
    ignoredServerValue,
    httpOrigin: httpOriginOf(url),
  };
}

/**
 * The http(s) origin for a ws(s) url.
 *
 * A string swap rather than `new URL`, because the two schemes map one to one
 * and the rest of the url is already whatever `explicitUrl`/`sameOrigin`
 * settled on -- including the `/ws` path, which is dropped here since the auth
 * endpoints hang off the root.
 */
export function httpOriginOf(wsUrl: string): string {
  const swapped = wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  const afterScheme = swapped.indexOf('//') + 2;
  // The origin ends at the first of a path, a query or a fragment. Cutting on
  // '/' alone kept a query on a URL that had no path -- `ws://h:8787?x=1`
  // produced an "origin" of `http://h:8787?x=1`, so the endpoint appended to it
  // landed on `/` with a mangled query and the auth handler refused it.
  let end = swapped.length;
  for (const mark of ['/', '?', '#']) {
    const at = swapped.indexOf(mark, afterScheme);
    if (at !== -1 && at < end) end = at;
  }
  return swapped.slice(0, end);
}

/** Store the session token this tab signed in with. */
export function rememberAuthToken(storage: StorageLike, token: string): void {
  write(storage, AUTH_TOKEN_KEY, token);
}

/** Forget it, after a server has refused it. */
export function forgetAuthToken(storage: StorageLike): void {
  try {
    storage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    /* a storage that will not delete is not a reason to fail a connection */
  }
}
