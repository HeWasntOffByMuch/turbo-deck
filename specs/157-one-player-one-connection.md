# 157 — One player, one connection

## Problem

A live connection starts refusing everything with **"not logged in"** while its
body is still standing in the world and its socket is still up. Spec 150 gave a
session two keys — `PlayerManager.sessions` and `GameServer.lingering`, both
keyed on `playerId` — and nothing enforces that one `playerId` has at most one
live connection. `hello()` checks that *this connection* has not already said
hello (spec 145) and never that *this player* is not already logged in
elsewhere, so a second login for the same id overwrites the shared session and
spawns a second body. `reap()` then ends a session by id without asking whether
that id has since been claimed by somebody who is still playing, and
`players.logout()` deletes it out from under them.

Three doors into it, all reproduced against a real server:

- **A reconnect the server has not noticed yet.** The common one. A socket dies
  without delivering a `close`; the client reconnects with a *valid* token, but
  resume is only reachable through `lingering`, and `lingering` is only
  populated by a close the server observed — which has not happened, because it
  is still waiting out `CONNECTION_TIMEOUT_TICKS`. The valid token matches
  nothing, the client gets a fresh login and a second body, and forty seconds
  later the old connection times out, lingers, and is reaped, logging out the
  client that is actually playing. The delay is why it does not look connected
  to the blip that caused it.
- **Two tabs on one id.** Chrome's "Duplicate tab" copies `sessionStorage`, a
  shared `?id=` link does the same, and `scripts/server-bot.ts` uses fixed
  names. Whichever tab leaves *first* — even by saying `Goodbye` properly, which
  reaps at once — logs the other one out.
- **A stale token on reload.** `rememberSession` is called once, in the `.then()`
  of the *initial* connect, while the server mints a fresh token on every
  welcome including a resumed one. So the stored token goes stale after any
  reconnect and the next reload is a fresh login beside a lingering body, whose
  reap thirty seconds later kills the live session.

And a leak beside it: `lingering` is a `Map` keyed on `playerId`, so a second
drop on one id **overwrites** the first entry and the first entity is reaped by
nothing. Confirmed with both graces expired and nobody connected at all — the
body is in the world until the process restarts, in interest sets, in
`PositionHistory`, in chunk occupancy, and targetable.

## Assumptions

- **`playerId` is the identity and always was.** Spec 144 put it in per-tab
  `sessionStorage` so a reload is the same player and two tabs are two players.
  Nothing here changes that, and nothing here ties a session to a *name*:
  `?name=` reaches `PlayerManager.login` but only `createCharacter` reads it, so
  for a character with a save it is ignored. That is a real but separate bug —
  see Out of scope.
- **A second login is a thing that happens, not a thing to prevent.** Every door
  above is somebody legitimately trying to play. The fix is to make "log in as a
  player who is already logged in" a *defined operation* rather than an
  accident, and the only definition that does not strand somebody is: the newest
  connection wins and takes the body with it.
- **Refusing the second login is the wrong answer.** It turns door 1 into a
  ten-second lockout on exactly the connection that just recovered from an
  outage, which is worse than the symptom.

## Shape

### Take over, rather than duplicate

`hello()` gains one step, before the resume check and after the ban check: if
another **live** connection is already logged in as this `playerId`, this is a
takeover.

- the old connection is **displaced**: told `Disconnect`, its trade cancelled
  and its vendor closed, then closed — and it leaves *no* lingering body and
  reaps *nothing*, because its body and its session now belong to somebody else;
- the new connection adopts the existing `entityId` and the existing
  `PlayerSession`, is minted a fresh token, and is sent the same four messages a
  resume is sent — `Welcome`, `MapInfo`, `Stats`, `Inventory`.

No new entity, no second `login()`, no second body. The body does not move, so
a takeover is not an escape from a fight either.

This is what makes the resume token an optimisation rather than the only path
back to your body. It also subsumes door 2: two tabs on one id no longer both
run, and the one that leaves takes nothing with it.

```ts
/** The live connection logged in as this player, if any. Never `connection`. */
private liveConnectionFor(playerId: string, except?: Connection): Connection | null;
/** End a connection without ending what it was holding. */
private displace(connection: Connection): void;
```

`Connection` gains `displaced: boolean`, set before the close for the same
reason `leaving` is (spec 150): closing a channel fires its own close handler,
which reaches `disconnect` first, so the intent has to already be on the record
when it gets there.

### `reap` asks who owns the id

Defence in depth, and the change that makes the symptom impossible rather than
merely unlikely:

```ts
private async reap(playerId: string | null, entityId: number): Promise<void> {
  if (entityId >= 0) { /* … remove the entity, as now … */ }
  if (playerId === null) return;
  // Somebody is holding this id. The entity above was an orphan; the session
  // is not, and logging it out would refuse everything that player does next.
  if (this.liveConnectionFor(playerId)) return;
  this.lingering.delete(playerId);
  await this.players.logout(playerId);
}
```

The entity is still removed either way — an orphaned body should go. What is
conditional is ending the *session*.

### A fresh login clears the ground first

On the path that falls through to `players.login()`, any lingering entry for
this `playerId` is reaped **before** the login rather than left armed. Today
`lingering.delete` is only reached inside the token-matched branch, so an empty
or stale token leaves the entry in place — which is the leak, and door 3's
delayed logout.

This keeps spec 150's rule that **a wrong token is a new login**: you are still
spawned afresh at your saved position rather than seizing the body. What changes
is that the body you left is removed now instead of being reaped into your live
session half a minute later.

### The heartbeat leaves the render loop

`GameClient.advanceTick()` pings every 30 ticks, and `advanceTick` is driven by
`view.ts`'s `requestAnimationFrame` loop. A hidden tab has rAF throttled to
zero, so ticks stop, pings stop, and the ten-second timeout fires — and
`ReconnectingChannel.deliver(wireTick)` is on the same clock, so a hidden tab
cannot even retry until somebody looks at it again. Switching tabs for a minute
is a guaranteed drop, and coming back takes door 1.

Both move onto a wall-clock `setInterval` in `view.ts`, which browsers clamp to
about a second when hidden but do not stop. The tick-driven ping stays exactly
as it is, because every headless test depends on it; what is added is a
keep-alive that fires **only when the tick loop is not running**, and detects
that without a clock of its own:

```ts
/** A ping for a tick loop that has stopped. Pure: it reads `localTick`, not a clock. */
keepAlive(): void {
  if (!this.connected) return;
  if (this.localTick !== this.lastKeepAliveTick) { this.lastKeepAliveTick = this.localTick; return; }
  this.ping();
}
```

Two calls with no tick between them means the loop is stalled. While the tab is
visible this never sends anything, so the ping rate is unchanged and the
heartbeat bucket is not touched.

The reconnect backoff gets its own counter off the same interval — 30 ticks per
500ms tick of wall clock, which is exactly the rate the frame loop drove it at —
so `ReconnectingChannel` stays tick-driven and pure and its tests do not move.

### The ladder covers the grace

`DEFAULT_BACKOFF_TICKS` is `[30, 60, 120, 240, 480]` — about 15.5s — and then
the wrapper gives up forever. `RESUME_GRACE_TICKS` is 1800 (30s). An outage
between those two numbers is one the server would still honour and the client
has already stopped trying for. Three more rungs at the 480 cap take the ladder
to ~39.5s, past the whole grace with margin.

### Smaller things in the same seam

- **`rememberSession` on every welcome, not once.** `GameClient` gains
  `onWelcome(listener)` beside its existing `onError`, and `view.ts` writes the
  token from there. This is what makes a reload after a reconnect a resume.
- **Flood strikes decay.** `RateLimiter.strikes` is incremented and never reset,
  so `FLOOD_STRIKES` (60) is a lifetime total: a well-behaved session that trips
  the verb bucket sixty times over an hour is dropped as a flooder — and as an
  *intentional* disconnect, so no body is held. A strike more than
  `STRIKE_DECAY_TICKS` (600) after the last one starts the count again, which
  makes it the rate it was always meant to be.
- **Not: narrowing what fails the handshake.** `game-client.ts` rejects the
  pending welcome on *any* `Error` message, so an ordinary mid-session refusal
  arriving while a `connect()` is in flight — which is precisely what a resume
  is — fails it for an unrelated reason. This spec tried to narrow that to
  `BadProtocolVersion` and `Banned`, and backed it out: `hello` refuses 'already
  connected' and 'bad player id' with `RejectedAction`, which is the same code
  an ordinary refusal carries, and spec 145's hello-twice test rightly waits for
  the first of those to fail its `connect()`. Telling a handshake refusal from a
  gameplay one needs an error code that means it, and that is a protocol change
  rather than this one. Left as it is, and cheaper than it was, because the
  takeover removes the refusal storm that made it visible.

## Invariants tested

- **A takeover is the same body.** A second `Hello` for a live `playerId` gets
  the *same* `entityId`, at the same position, and the world holds exactly one
  player body afterwards.
- **The displaced connection takes nothing with it.** After a takeover the old
  connection is closed and the new one still has a session, still has a body,
  and still resolves actions — through the old connection's close, through the
  grace, and past `CONNECTION_TIMEOUT_TICKS + RESUME_GRACE_TICKS`.
- **Door 1.** Reconnect with a valid token *without* closing the first socket,
  then run past `CONNECTION_TIMEOUT_TICKS + RESUME_GRACE_TICKS`: the live client
  still has a session and there is exactly one body.
- **Door 2.** Two connections on one id; the first sends `Goodbye`; the second
  still has a session and can still act.
- **Door 3.** Drop, relogin with a stale token, run past the grace: the live
  session survives, and there is one body rather than two.
- **Nothing is orphaned.** Two drops on one id, both graces expired, nobody
  connected: the player body count is zero.
- **A silent client is still reaped.** The ownership check must not make
  sessions immortal: a connection that stops sending is lingering after
  `CONNECTION_TIMEOUT_TICKS`, reaped after the grace, and logged out — spec
  150's invariant, unchanged and re-asserted, because it is the one this change
  could plausibly break.
- **Goodbye still skips the grace**, and a kick still leaves no body.
- **`keepAlive` is silent while the loop runs.** Called between ticks it sends
  nothing; called twice with no tick between, it pings once.
- **Strikes decay.** Fifty-nine strikes, a quiet `STRIKE_DECAY_TICKS`, fifty-nine
  more: not flooding. A hundred and twenty back to back: flooding.
- **The ladder outlasts the grace.** The sum of `DEFAULT_BACKOFF_TICKS` exceeds
  `RESUME_GRACE_TICKS` — asserted as arithmetic, so the two constants cannot
  drift apart silently again.
- **Spec 150's tests are unmodified.** `resume.test.ts` passes as written; a
  wrong token is still a new login, and a resumed session is still the same body.

## Out of scope

- **Accounts.** Takeover means anybody who knows a `playerId` can displace its
  owner. They could already log in as it and get the character (spec 150 says
  so in as many words); before this change they got a *duplicate* body and broke
  the real player's session, so displacement is strictly the smaller hole. It is
  still a hole, and closing it is what accounts are for.
- **Renaming.** `?name=` is ignored for a character that already has a save,
  because `login` only reads `displayName` in `createCharacter`. Fixing it by
  writing the name on every login is worse than the bug: a tab that loads with
  `?id=` and no `?name=` would silently rename you to `Player 1a2b`, since the
  wire cannot tell "asked for this name" from "defaulted to it". A real fix is a
  rename verb, and that is a protocol change and a UI, not this spec.
- **WebSocket-level keepalive.** `transport-ws.ts` sends no ping frames. The
  application heartbeat now covers the silence that mattered; an intermediary
  that needs protocol-level pings is a deployment question.
- **`Goodbye` on page unload.** Nothing listens for `pagehide`, so closing a tab
  is always an accidental drop and always leaves a body for thirty seconds.
  That is spec 150's anti-combat-logging behaviour working as intended.
- **Never giving up.** With takeover a late reconnect is just a login, so an
  unbounded ladder would now be safe. It is still a decision about what a dead
  server should look like to a tab, and the banner says "closed" for a reason.
- **Resuming across a server restart**, unchanged from spec 150.
