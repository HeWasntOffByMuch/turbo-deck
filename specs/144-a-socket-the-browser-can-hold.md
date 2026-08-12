# 144 — A socket the browser can hold

## Problem

The server has been authoritative, multi-player and tested since spec 057, and
`scripts/server-bot.ts` proves the protocol works over a real wire — but only
from Node. The browser cannot reach a shared server at all: `mountWorld` builds
a `LoopbackTransport` and its own in-tab `GameServer` unconditionally
(`view.ts:114-120`), so two tabs are two universes. The only `Channel` over a
socket is `SocketChannel` in `transport-ws.ts`, which imports the `ws` package
and so can never enter the browser bundle. This spec adds the missing half —
a `Channel` over the DOM `WebSocket`, and the branch in `view.ts` that uses it —
so that two tabs on one machine play the same fight.

## Assumptions

Three facts the design leans on, each verified against the tree rather than
assumed:

- **The server needs no change to accept a browser.** `WebSocketTransport` is
  constructed with `httpServer` (`index.ts:135`), so it takes the
  `new WebSocketServer({ server })` branch (`transport-ws.ts:56-57`) with no
  `path` option — the upgrade is accepted on *any* path, on the same port as
  the admin console. This spec fixes `/ws` as the path a browser client dials
  and writes it into `PROTOCOL.md`, but leaves the server permissive so
  `npm run server:bots` (which dials the bare origin) keeps working.
- **`MapInfo` already carries `mapId`** (`map-messages.ts:69`), a hash of the
  exact serialized document (`map-index.ts:56`). So a client can *know* whether
  the map it bundled is the map the server is colliding against. This is what
  lets 144 be honest about prediction without waiting for collider paging —
  see "The ground a prediction stands on" below.
- **`src/server/net/` is not in `DETERMINISTIC_CORE`** (`eslint.config.js:16-54`
  lists `server/sim|world|player|data` only), and no lint rule bans the
  `WebSocket` global. A browser channel may legally live beside `transport-ws.ts`.

## Shape

### A channel over the DOM WebSocket

New file `src/server/net/transport-browser.ts` — a peer of `transport-ws.ts`,
importing nothing from Node.

```ts
/** The subset of the DOM WebSocket this channel uses. `ws`'s class satisfies it too. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: ArrayBufferView): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: never) => void): void;
}

export type ConnectionPhase = 'connecting' | 'connected' | 'closed';

export interface BrowserChannelOptions {
  /** Defaults to `globalThis.WebSocket`. Injected so a Node test can pass `ws`. */
  readonly create?: (url: string) => WebSocketLike;
  readonly onPhase?: (phase: ConnectionPhase) => void;
}

export function connectChannel(url: string, options?: BrowserChannelOptions): Channel;
```

`connectChannel` returns a `Channel` **synchronously**, before the socket is
open. That is deliberate and is the one place this implementation is more than
a wrapper: `GameClient` registers `onMessage`/`onClose` inside its constructor
(`game-client.ts:550-558`) and `connect()` sends `Hello` immediately, so a
channel that only existed after `open` would force `mountWorld` to become
async and would restructure the loopback path this spec is required to leave
alone. So frames sent before `open` are **queued**, in order, and flushed on
`open`; `isOpen` still reports the socket's true state and never lies. A socket
that closes before it ever opens discards the queue and fires `onClose` once.

Two details the `ws` implementation gets for free and this one must do by hand:
the one-reader rule (`transport.ts:19`) is honoured with a single replaceable
handler field, the way `LoopbackChannel` does it, because the DOM has no
`removeAllListeners`; and `binaryType` is set to `'arraybuffer'` so a message
event carries an `ArrayBuffer`, which is wrapped as `new Uint8Array(ev.data)` —
`Channel.onMessage` hands out `Uint8Array`.

`close` and `error` both route to `onClose`, fired at most once.

### Which server, and who am I

New pure module `src/render/iso3d/world/connection.ts`. No DOM, no socket — it
takes strings and a storage-like and returns a decision, so the whole rule is a
table in a Node test rather than something only a browser can answer. This is
the same shape `src/ui/input/` already uses for its two persisted preferences.

```ts
export type ConnectionPlan =
  | { readonly mode: 'loopback' }
  | { readonly mode: 'remote'; readonly url: string; readonly playerId: string;
      readonly displayName: string };

export function planConnection(
  search: string,            // location.search
  origin: { protocol: string; host: string },
  storage: StorageLike,      // sessionStorage: per-tab, survives reload
  newId: () => string,       // crypto.randomUUID, injected so a test is exact
): ConnectionPlan;
```

The rules, in order:

- **No `?server`** → `{ mode: 'loopback' }`. Today's path, untouched.
- **`?server`** (bare, or any non-URL value) → same-origin: `ws://` for `http:`,
  `wss://` for `https:`, plus the host, plus `/ws`.
- **`?server=<url>`** → that URL verbatim, so a second machine or a different
  port needs no code change.
- **playerId** is read from `sessionStorage`, minted with `newId()` and stored
  if absent. `sessionStorage` is per-tab *and* survives a reload, which is
  exactly the lifetime wanted: two tabs are two players, and F5 is still you.
  `?id=` overrides it, for a test that needs a fixed id.
- **displayName** is `?name=` if given (and stored, so a reload keeps it),
  else the stored name, else `Player <first 4 of id>`.

`crypto.randomUUID` rather than `Math.random` — not because `src/render/` is
linted for it (it is not), but because there is one rule about ambient
randomness in this repo and an exception nobody can see is how it stops being
a rule.

### The branch in view.ts

`mountWorld` gains exactly one branch, as early as possible so everything after
it is common:

```ts
const plan = planConnection(location.search, location, sessionStorage, () => crypto.randomUUID());
```

- `mode: 'loopback'` — construct `LoopbackTransport` + `GameServer` and drive
  `server.tick()` from the frame loop, **exactly as today**, with the same
  `playerId: 'you'` and `displayName: 'You'`.
- `mode: 'remote'` — construct no `GameServer` and no transport. `server` becomes
  `null`; the `server.tick()` call at `view.ts:1242` becomes conditional on it,
  which is the only line in the frame loop that changes. `client.advanceTick()`
  and `sendInput()` are untouched: the client's clock is its own either way.

`warmRouting(world)` (~1s) and the local `buildWorldFromMap` stay on both paths
for now — the drawn world already comes from `StreamedMap` and only the
predictor and `RoutePlanner` read the local build. Spec 146 is what removes it.

### The ground a prediction stands on

The honest problem a remote client has is that its bundled `maps/arena.json` may
not be the server's map, and predicting against the wrong colliders is worse
than not predicting at all. `mapId` answers it exactly:

```ts
// src/render/iso3d/world/prediction-ground.ts — pure
export interface PredictionGround {
  colliders: WorldColliders | null;
  terrain: TerrainSampler | null;
}
```

One mutable holder, read through the predictor's closure on every call (the
closure already reads its options per call, `prediction.ts:105-122`). While
either field is `null` the predictor takes the flat step — the same
`createFlatPredictor` behaviour a client gets today when no predictor is passed.

- **Loopback** fills the holder synchronously at mount from the local build, so
  the closure sees the identical objects it sees today and the existing
  prediction tests hold unchanged.
- **Remote** leaves it empty until `MapInfo` arrives, then fills it from the
  local build **only if `info.mapId === mapIdOf(mapText)`**. On a mismatch it
  stays empty, the client predicts flat, and the status line says so.

This is the seam spec 146 fills: collider paging replaces "fill from the local
build on a matching id" with "grow from `StreamedMap`", and nothing else moves.
Failing *safe* rather than *wrongly* is the property, and it is the reason the
holder exists in 144 rather than 145.

### Saying where the socket is

A small DOM element in the top-left of the view root, three states, driven off
`onPhase` and removed on `connected` after a short settle so it is not permanent
chrome. It carries `data-connection="connecting|connected|closed"` and its text
in `data-text`, following the convention `error-log.ts` and `view-controls.ts`
already set — a probe reads the attribute rather than photographing a pixel.
On `closed` it stays up and says so; there is no reconnect in this spec (149).

### The dev proxy

`vite.config.ts` gains a second proxy key beside `/api/studio`, for the same
reason that one exists — so the browser is never told about `:8787` and no CORS
header has to exist:

```ts
'/ws': { target: process.env['GAME_SERVER'] ?? 'ws://localhost:8787', ws: true }
```

`ws: true` is required and the studio entry does not have it. The prefix must
not be `/`, because vite's own HMR socket lives on the dev-server root.

### How to run it

Two terminals, no file edited:

```sh
npm run server        # authoritative server + admin console on :8787
npm run dev           # renderer on :5173, proxying /ws -> :8787
```

Then two tabs:

- `http://localhost:5173/?server&name=Ana`
- `http://localhost:5173/?server&name=Ben`

`http://localhost:5173/` with no `?server` is still today's single-player tab.
To skip the proxy or reach another port: `?server=ws://localhost:8787/ws`.

## Invariants tested

Node, no browser, no DOM:

- **`planConnection` is a table.** No `?server` → loopback. `?server` on
  `http:` → `ws://<host>/ws`; on `https:` → `wss://`. `?server=<url>` → that
  url verbatim. A playerId is minted once and reused from storage on the next
  call; two different storages get two different ids; `?id=` overrides; `?name=`
  sets and persists the display name; an absent name derives from the id. A
  storage that throws on read or write costs a fresh id, never an exception —
  the rule `src/ui/input/` already holds for its preferences.
- **The channel queues rather than drops.** Frames sent before `open` arrive
  after it, in order. A socket that closes before opening fires `onClose` once
  and sends nothing. `onMessage` registered twice leaves exactly one reader.
  An `ArrayBuffer` message arrives as a `Uint8Array` with the same bytes.
  `close` then `error` fires `onClose` once, not twice.
- **A real client over a real socket.** A real `GameServer` on a real
  `WebSocketTransport`, and a real `GameClient` over `connectChannel` with the
  `ws` package's `WebSocket` injected as `create` — connect, receive a
  `Welcome`, send input, and see the entity move. This is the same thing
  `scripts/server-bot.ts` does by hand, run under vitest against the channel
  this spec adds. (Injected rather than using a global `WebSocket`, because CI
  is on Node 20 where that global is not stable.)
- **Two ids, two players, one server.** Two `GameClient`s over two browser
  channels against one real socket server end up as two distinct entity ids and
  each appears in the other's view. `trade-wire.test.ts` already asserts the
  loopback version of this with two clients; this is the socket version.
- **Prediction fails safe.** With an empty `PredictionGround` the predictor's
  output is identical to `createFlatPredictor`'s, step for step. With it filled
  from the local build, identical to today's collider predictor — the existing
  `prediction.test.ts` "predicting against the real world" block is the guard
  and is not modified.
- **The loopback path did not move.** `presentation-only.test.ts` and
  `mount-presentation.test.ts` still pass unchanged: the same seed and inputs
  produce identical authoritative state.

In a browser, `npx tsx scripts/preview-multiplayer.ts`: two real pages against
one real `npm run server`, reading `data-connection` off each and asserting both
reach `connected` with different entity ids. The socket only exists once a
browser has opened one, and neither the mount branch nor the DOM `WebSocket` can
be reached from Node.

## Out of scope

- **Collider paging** — spec 146. Until then a remote client on a map that is
  not the one it bundled predicts flat, deliberately and visibly.
- **Separated spawns, nameplates, replicated turn rate, PvP verification** —
  spec 145. Two players connected today spawn on the identical
  `DEFAULT_SPAWN {600, 450}` and interpenetrate, because nothing collides
  entity against entity.
- **Reconnect, heartbeat, timeout** — spec 149. A closed socket says "closed"
  and stays closed. `Channel` deliberately cannot express reconnection
  (`transport.ts:9-12`), and widening it would make `LoopbackChannel` lie; the
  reconnect spec must wrap `Channel`, not change it.
- **Loss, jitter and reorder** — spec 147. Note latency simulation already
  exists (four copies of a `DelayLine`); that spec extracts one rather than
  inventing one.
- **Rate matching** (148), **lag compensation** (149), **hostile-client
  hardening** (151).
- **Anything needing a second machine**, TLS, accounts, or a database. The
  `?server=<url>` escape hatch is there so none of that is needed to test.
