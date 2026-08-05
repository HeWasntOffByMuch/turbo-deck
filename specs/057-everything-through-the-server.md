# 057 — Route everything through the server

## Problem

Spec 056 built an authoritative server beside the single-player game. The game
does not talk to it: `src/render/loop.ts` steps `stepGame` locally at 60Hz and
never opens a socket, so there are two implementations of what the game *is* and
only one of them is ever played.

This spec commits to one. The server becomes the only place the game is
simulated, and `src/render/` becomes what CLAUDE.md always said it was -- a
layer that reads state and draws it. Single-player does not go away; it becomes
a server running in the same tab, reached through a loopback transport instead
of a socket.

## The tick-rate correction this forces

Spec 056 chose 20Hz for a server that ran *beside* a 60Hz game. That choice does
not survive the game moving onto it.

`PERFECT_WINDOW_TICKS = 4` at 60Hz is a 66ms window, and perfect parries and
dodges drawing bonus cards is the game's core loop. At 20Hz a tick is 50ms, so
that window can only be 50ms (a quarter tighter) or 100ms (half again looser).
Neither is the game that exists.

So the two rates are separated, which they should have been from the start:

- **`SERVER_TICK_RATE` = 60** — the sim's fixed timestep, unchanged from the
  single-player sim, so every duration constant in `src/sim/constants.ts` keeps
  meaning what it means and CLAUDE.md's 60-ticks-per-second rule stays true.
- **`BROADCAST_EVERY_N_TICKS` = 3** — deltas go out at 20Hz, exactly the network
  rate spec 056 asked for.

Interest management, delta tracking and the wire format are untouched by this:
they were never coupled to how often the world advanced, only to how often it is
described. If the parry windows are ever redesigned for a coarser sim, this is
one constant.

## Shape

```
src/server/net/transport.ts       Channel + ServerTransport: the seam that lets
                                  the same server run behind a socket or in a tab
src/server/net/transport-ws.ts    the `ws` implementation (Node only)
src/server/net/transport-loop.ts  in-process, zero-copy: single-player
src/server/client/game-client.ts  the client session: replicated world,
                                  prediction, reconciliation. No DOM, no three.js
src/server/client/replica.ts      entities as the client knows them
```

`GameServer` stops importing `ws` and `node:crypto` so it can be bundled for a
browser. Both arrive by injection instead:

```ts
interface GameServerOptions {
  readonly transport?: ServerTransport;      // omit for a headless test server
  readonly adminVerifier?: AdminTokenVerifier;  // omit and admin:* is refused
}

type AdminTokenVerifier =
  (token: string, nowMs: number) =>
    | { readonly ok: true; readonly subject: string }
    | { readonly ok: false; readonly reason: string };
```

The Node entry supplies the HMAC verifier from `admin/auth.ts`; an in-tab server
supplies nothing, and its admin namespace refuses everything. A game server
running inside a player's own browser has no business having an admin channel.

The client is the mirror of the server's delta tracker:

```ts
class GameClient {
  constructor(channel: Channel, options: { playerId: string; displayName: string });
  connect(): Promise<WelcomeInfo>;
  sendInput(input: PredictedInput): void;
  /** What the renderer draws. Read-only, no rules. */
  view(): ReplicatedWorld;
}
```

## Migration stages

This lands over several specs. The order is chosen so the game is playable at
every step and nothing is deleted before its replacement is carrying traffic.

1. **This spec.** Transport seam, rate split, client session, loopback. The
   server becomes embeddable and the client becomes real. The renderer still
   draws the local sim; nothing about playing the game changes yet.
2. **The card economy moves.** `src/cards/` is already pure data and pure
   functions, so it does not move -- but the *session* that wires it to combat
   (`src/game/session.ts`) is reimplemented server-side, and hands/decks/synergy
   windows become server state broadcast to the client.
3. **The renderer swaps its source.** `GameLoop` stops calling `stepGame` and
   starts reading `GameClient.view()`. Single-player boots a loopback server in
   the tab. This is the commit where the answer to "why is there no player in
   the admin panel" becomes "there is one".
4. **The old runtime is deleted.** `src/sim/combat.ts` and `src/game/session.ts`
   stop being a second implementation. The pure helpers they were built on
   (`collision.ts`, `pathfinding.ts`, `prng.ts`, terrain) stay exactly where they
   are -- they were always shared, and the server already uses them.

## Invariants tested

- **Loopback is the socket.** A client driven over `LoopbackTransport` and one
  driven over `WebSocketTransport` receive byte-identical frame sequences for
  the same inputs. The transport cannot be where behaviour hides.
- **Rate split.** The sim advances 60 times a second and deltas are emitted 20
  times a second; a client that counts frames sees one per three ticks, and
  positions in them move by three ticks' worth of travel.
- **Replication.** After any sequence of inputs, every entity in the client's
  replicated world matches the server's authoritative entity in the fields the
  protocol carries. Divergence here is the bug this whole layer exists to avoid.
- **Prediction stays silent when it is right.** A client predicting with the
  server's own movement rules receives no corrections while walking in the open.
- **Admin is refused without a verifier.** An in-tab server rejects every
  `admin:*` message including auth, and audits the attempt.
- **Determinism survives embedding.** The same seed and inputs through a
  loopback server produce the same state as through a socket server.

## Out of scope

- Stages 2-4 above; each gets its own spec.
- Lockstep or rollback netcode. Corrections stay snap-and-replay.
- Running the loopback server on a worker thread. It runs on the main thread at
  first, which is what the local sim already does.
- Server-side anti-cheat beyond what 056 has (speed, collision, terrain).
