# 264 — A session that ends when you do

## Problem

Three claims about a session are made somewhere in the tree and none of them is
true of the running game.

**A tab left open holds a body forever.** `sweepConnections` cuts a connection
that has gone quiet, and quiet is measured by `lastSeenTick` — stamped by any
frame arriving and, since spec 197, by a WebSocket pong. That pong is answered
in the browser's *network stack* with no JavaScript running, which is exactly
what spec 197 wanted: a hidden tab whose timers are throttled to one a minute is
not a lost socket. The consequence nobody wrote down is that it is not a lost
socket **ever**. Nothing on the server tracks whether the player did anything —
`lastActiveTick` in `state/store.ts` is a per-chunk field and has nothing to do
with players — so an open tab is an immortal body, and the only cost of walking
away from the keyboard for a week is that somebody else has to look at you.

Worse, the client sends an `Input` every frame whether or not anything is
pressed (`view.ts:4058`, unconditional, with a zero move vector when idle), so
"a message arrived" cannot be the measure either.

**Closing the tab holds the body for thirty seconds whatever you were doing.**
`RESUME_GRACE_TICKS` is deliberate and its reason is good: pulling the plug must
not be an escape from a fight. But it is applied to *every* departure, so a
player who logs off standing in the village square is a statue for half a minute
— and `disconnect`'s one escape from it, `options.intentional`, is reachable
only from `drop` (a kick or a ban). `GameClient.disconnect()` is the client half
that would send `Goodbye`, and it has **no caller anywhere in the tree**, tests
included: another complete half wired to nothing.

**A guest character is discarded by any server hiccup.** `ensureAuthToken`
checks a stored token against `/api/auth/session` and, on anything that is not
`ok` and not a 404, forgets it and mints a brand-new guest. The comment says
`// 401: expired, revoked, or rotated by a claim on another device` and the code
says every other status too — a 500, a 502 from a proxy, a 503 during a restart,
a 429. For a player who has not registered that is the **permanent loss of their
character**, with the old `players` row left in the database reachable by no
credential that exists. It is also where "copies of the same player" come from:
the person is now a second player id, and their first body is still standing in
the world for its grace period.

Beside it, `expires_at` is fixed at issue and never extended — `touch()` bumps
`last_seen_at` and nothing else — so a guest who plays every day is signed out
for good on day thirty.

## Shape

Three changes, each at the one line that already decides the thing.

**Being in a fight is what buys the grace**, rather than the manner of leaving.
`sim/restoration.ts` already owns `StatusId.InCombat`, stamped by a blow landed,
a blow taken and an affliction pulse, and its `combatTicks` is 8 seconds. It has
had one reader — resting — since it was written; this is the second.

```ts
// server.ts
private inCombat(entityId: number): boolean;   // statusOf(entity.statuses, InCombat, tick)

// disconnect()
const resumable = options.intentional !== true && … && this.inCombat(connection.entityId);
```

Out of combat the body is reaped on the tick the socket closes. In combat it
lingers for `RESUME_GRACE_TICKS` exactly as it does today. The **server**
decides, never the client: a `Goodbye` from a player in a fight buys the same
thirty seconds a pulled plug does, so clicking away is not an escape either.
Nothing is lost by going at once — `syncFromEntity` writes position, facing and
health into the record on every broadcast, so what `logout` saves is current to
within 50ms.

**A player who is not asking for anything is not playing.** A second stamp
beside `lastSeenTick`, and the difference between them is the whole point:

```ts
interface Connection {
  lastSeenTick: number;    // this socket is up            (pongs count)
  lastInputTick: number;   // this player is here          (pongs do not)
}
```

`lastInputTick` is stamped by an `Input` that **asks for something** — a
non-zero move vector, a non-zero button mask, or a facing that differs from the
last one stamped — and by any client message that is not `Input`, `Ping` or
`RequestChunk`. An idle tab sends nothing else, so it stamps nothing.
`sweepConnections` gains one clause:

```ts
if (this.state.tick - connection.lastInputTick >= AFK_TIMEOUT_TICKS
    && !this.inCombat(connection.entityId)) {
  void this.drop(connection, 'idle');   // intentional: no lingering body
}
```

`AFK_TIMEOUT_TICKS` is five minutes. The combat clause is not politeness: a
player being fought over should not evaporate mid-blow, and `InCombat` is
re-stamped by every hit, so the timer cannot fire on somebody who is in one.

**A credential is discarded only when the server says it is wrong.**

```ts
if (check.status !== 401) return { ok: false, reason: … };   // keep the token
forgetAuthToken(storage);                                     // 401 only
```

A refusal the server did not make is a refusal that has not happened: the
connection fails, the player is told, and their character is still theirs on the
next load. And `touch()` slides `expires_at` forward by the TTL along with
`last_seen_at`, so a session stays alive as long as it is used and the thirty
days measure absence rather than age.

## Invariants tested

- A connection that closes while `InCombat` leaves a lingering body, and one
  that closes without it is reaped on the same tick — asserted through `receive`
  and the real sweep, not by calling `disconnect` directly.
- `Goodbye` from a body in combat still lingers. Intent does not beat the fight.
- `drop` (kick, ban, flood, idle) never leaves a body, in combat or out.
- A connection sending only zero-vector `Input`s, `Ping`s and `RequestChunk`s is
  dropped after `AFK_TIMEOUT_TICKS`; one whose inputs carry a move vector, a
  button or a changed facing is never dropped, however long it runs.
- An idle connection that is in combat is not dropped, and is dropped once the
  window closes.
- A pong alone does not stamp `lastInputTick` — the spec 197 case, asserted
  directly, because it is the one that makes the whole feature necessary.
- `ensureAuthToken` keeps the stored token on 500, 502, 503 and 429, and forgets
  it on 401 only. A kept token is still the one presented on the next load.
- `touch()` moves `expires_at` forward; a session touched inside its TTL
  outlives its original expiry, and one never touched does not.
- Two connections naming one player still resolve to one body (spec 157's
  displacement, unchanged) — a control, because every assertion above is about
  bodies going away and a server that reaped everything would pass them all.

## Out of scope

- **Warning a player before the AFK drop.** It needs a server message and client
  handling for it, and the drop already says `idle` on the way out.
- **Sweeping the guest rows already orphaned** by the discard bug. They are
  unreachable rather than harmful, and deleting player rows wants its own spec
  with its own answer for "how long is an unclaimed guest kept".
- **Wiring `pagehide` to `Goodbye`.** With the server deciding from combat state
  a real tab close is already immediate, and the AFK sweep covers a socket whose
  close never arrives. `GameClient.disconnect()` stays callerless.
- **Pausing the world for a hidden tab.** Spec 255 names this and its decisions
  are its own.
