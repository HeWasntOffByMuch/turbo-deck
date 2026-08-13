# Session drops and "not logged in" — state of the system

> **Status: fixed in spec 157.** Everything below is the investigation as it
> stood before the fix, kept because the reproductions and the reasoning are
> what the spec is built on. What shipped, and the one item deliberately not
> taken, is recorded at the bottom under *What was done*.

Investigation of the reported symptom: playing normally, and then every action
starts refusing with **"not logged in"** in the red refusal column, while the
body is still standing in the world and the connection is still live.

The symptom is real, it is reproducible, and it is not a transport problem. All
three reproductions below were run against a real `GameServer` over
`LoopbackTransport`; the scratch tests were deleted after the run and their
shape is written out here so they can be re-created as regression tests.

---

## 1. How identity works today

Three separate things are called "session" in this codebase, and the bug lives
in the seam between them.

| Thing | Keyed by | Lives in | Lifetime |
|---|---|---|---|
| `PlayerSession` (the character) | `playerId` | `PlayerManager.sessions` | login → `logout()` |
| `Connection` (the socket) | object identity | `GameServer.connections` | accept → close/timeout |
| the lingering entry (the held body) | `playerId` | `GameServer.lingering` | disconnect → 30s grace |

`playerId` is the primary key for two of the three, and **nothing enforces that
one `playerId` has at most one live connection.**

### The query parameters, reconciled

`src/render/iso3d/world/connection.ts` is the whole rule and it is pure, so it
is easy to state exactly:

- **`?server=…`** is what switches a tab from loopback to remote. No `?server`
  means single-player and none of the rest applies.
- **`?id=…`** *forces* the `playerId` and writes it into `sessionStorage`
  (`turbo-deck.net.playerId`), so it sticks for that tab afterwards even if you
  drop the parameter on the next load.
- **`?name=…`** sets `displayName` and writes `turbo-deck.net.name`.
- With no `?id`, the id is minted once per tab and kept in `sessionStorage`.

`sessionStorage` is the right choice and the comment in that file explains why
(per-tab, survives F5). Two things follow from it that are worth knowing:

- **Sessions are tied to `playerId`, never to the name.** `?name=` reaches
  `PlayerManager.login`, but `login` only uses `displayName` inside
  `createCharacter`. For a character that already has a save,
  `session.displayName` comes from `record.displayName` and **the query
  parameter is silently ignored**. So `?name=Foo` renames you exactly once —
  the first time that id is ever seen — and appears to do nothing forever
  after. That is a separate, smaller bug, but it is the answer to "are sessions
  tied to names": they are not, at all.
- **Duplicating a tab copies `sessionStorage`** (Chrome's "Duplicate tab", and
  any window opened from `window.open`). That hands two live tabs the same
  `playerId`, which is door #2 below. The same is true of any two tabs sharing
  a `?id=` link, and of `scripts/server-bot.ts`, which uses `playerId: name`
  from a fixed list.

---

## 2. Root cause: `reap` is keyed on `playerId` and does not check who owns it

`GameServer.reap(playerId, entityId)` ends a session:

```ts
private async reap(playerId: string | null, entityId: number): Promise<void> {
  if (entityId >= 0) { … this.state = removeEntity(this.state, entityId); }
  if (playerId !== null) {
    this.lingering.delete(playerId);
    await this.players.logout(playerId);   // <-- deletes PlayerManager.sessions[playerId]
  }
}
```

It is called from `disconnect()` and from `sweepConnections()`. In both cases
the `playerId` it is handed came from a connection or a lingering entry that is
already over — but by the time it runs, **that `playerId` may belong to a
different, live connection**, and `logout()` deletes the session out from under
it. The socket stays up, the body stays in the world, and every handler that
does `players.get(connection.playerId)` from then on returns
`{ ok: false, reason: 'not logged in' }` — which is the message on screen.

There is a matching gap on the way in. `hello()` checks that *this connection*
has not already said hello:

```ts
if (connection.playerId !== null) { … 'already connected' … }
```

but it never checks whether *this `playerId`* is already logged in on another
connection. So a second login for the same id runs the whole fresh-login path:
`players.login()` overwrites `sessions[playerId]`, a second entity is spawned,
and `attachEntity` re-points the session at it. The first connection is left
holding an `entityId` that its session no longer refers to.

### The three doors into it

**Door 1 — the reconnect the server has not noticed yet.** The common case, and
the one most likely to be what you are hitting. A blip kills the socket in a way
that never delivers a `close` (dead router, sleeping laptop, phone changing
network). `ReconnectingChannel` gives up on the inner socket and reopens; the
client says hello with a **valid** resume token. But resume is only possible
through the `lingering` map, and `lingering` is only populated by a `close` the
server actually observed — which has not happened yet, because the server is
still waiting out `CONNECTION_TIMEOUT_TICKS`. So the valid token matches
nothing, the client is given a fresh login and a second body, and ten seconds
later the old connection times out, lingers, and thirty seconds after that is
reaped — logging out the session the live client is using.

**About forty seconds after a successful reconnect, the game starts saying
"not logged in".** That delay is why it does not look connected to the blip.

**Door 2 — two tabs on one id.** Duplicated tab, shared `?id=` link, or two bots
with the same name. Whichever tab leaves *first* — even by saying `Goodbye`
properly, which reaps immediately — logs the other one out.

**Door 3 — a stale token on reload.** Covered in §4; the client's stored token
goes stale after any reconnect. Reloading then produces a fresh login beside a
lingering body, and the lingering body's reap 30s later kills the live session.

### Evidence

Each of these was run and observed, not inferred:

```
C (door 1): reconnect with a valid token, server has not seen the close
    same body?  false          <- valid token ignored, second body spawned
    bodies:     2
    …after the old connection times out and its grace expires…
    session:    GONE           <- live client, still pinging, no session
    bodies:     1

B (door 2): two tabs on 'bob', tab A sends Goodbye
    players.get('bob') === null   <- passes; tab B is logged out instantly

A (door 3): stale token relogin, then the orphan's grace expires
    session:    GONE
    bodies:     1              <- body standing, session gone
```

### The leak beside it

`lingering` is a `Map` keyed by `playerId`, so a second disconnect for the same
id **overwrites** the first entry, and the first entity is then reaped by
nothing. Confirmed: after two drops on one id and both graces fully expired,
with nobody connected at all —

```
LEAK bodies after both graces: 1
LEAK entity A present:         true
```

That body is in the world until the process restarts. It is in interest sets,
in `PositionHistory`, in chunk occupancy, and it is a valid target. This is the
same class of bug spec 145's "one Hello per connection" fix was written for; it
was closed for one socket saying hello twice and left open for two sockets
saying hello once each.

---

## 3. Recommended fix

The ordering matters — 3.1 alone removes the symptom, and the rest close the
remaining doors.

**3.1 — Make `reap` and `logout` ownership-checked.** This is the one-line-ish
change that stops the bleeding. Before `players.logout(playerId)`, confirm no
live connection currently owns that `playerId`:

```ts
private ownedByLiveConnection(playerId: string): boolean {
  for (const c of this.connections) if (c.playerId === playerId) return true;
  return false;
}
```

and in `reap`, skip the `logout` (and the `lingering.delete`) when it is true.
Still remove the entity — an orphaned body should go — but never end a session
somebody is holding. Worth passing the expected `entityId` too, and refusing to
remove a body that the session has since been re-pointed away from.

**3.2 — Take over instead of duplicating, in `hello`.** When a `playerId` says
hello and is already live on another connection, the right answer is almost
certainly to *displace* the old one: `drop()` the old connection with a reason
("logged in elsewhere"), then hand the new connection the **existing** entity
and session rather than spawning a second body. That single change closes doors
1, 2 and 3 at the source, because it makes "a second login for this id" a
defined operation instead of an accident. It also makes the resume token an
optimisation rather than the only path back to your body.

If displacement is not wanted, the alternative is to refuse the second login
outright — but that turns door 1 into a lockout for the duration of
`CONNECTION_TIMEOUT_TICKS`, which is worse for the reported symptom.

**3.3 — Reap the lingering entry on a fresh login.** In `hello`, on the path
that falls through to `players.login()`, an existing `lingering` entry for that
`playerId` must be reaped (body removed) rather than left armed. Note the
current code only calls `lingering.delete` inside the token-matched branch; a
token mismatch or an empty token leaves the entry in place. Fixing 3.2 mostly
subsumes this, but it should be explicit either way, because it is what stops
the entity leak.

**3.4 — Give the lingering map room for more than one body per id**, or assert
it can never need it. Once 3.2 lands it genuinely cannot, and an assertion is
better than a `Map` that silently drops a body.

---

## 4. Secondary findings — each independently worth fixing

These do not cause "not logged in" on their own, but each one *feeds* the bug
above by producing extra reconnects and extra fresh logins.

**4.1 — The stored resume token goes stale after every reconnect.** The server
mints a fresh `sessionToken` on every welcome, including a resumed one, and
`GameClient` correctly updates its in-memory `this.token`. But
`rememberSession(sessionStorage, …)` is called in exactly one place —
`view.ts:1619`, inside the `.then()` of the *initial* `client.connect()`. An
in-session reconnect goes through `client.resume()`, which never writes back.
So after any blip, `sessionStorage` holds a token the server will not accept,
and the next reload is a fresh login rather than a resume. **Fix:** register a
welcome listener that calls `rememberSession` every time, not once.

**4.2 — A backgrounded tab stops pinging and is dropped in ten seconds.** The
ping lives in `GameClient.advanceTick()` (`localTick % PING_EVERY_TICKS`), and
`advanceTick` is driven by the `requestAnimationFrame` loop in `view.ts`. A
hidden tab has rAF throttled to zero in every current browser, so ticks stop,
pings stop, and `CONNECTION_TIMEOUT_TICKS` (10s) fires. `ReconnectingChannel.
deliver(wireTick)` is on the same clock, so the *reconnect backoff also stalls*
while hidden — the tab cannot even retry until it is looked at again. Switching
away for a minute and back is therefore a guaranteed drop, and on return it
takes door 1 or door 3. **Fix:** drive the heartbeat and the reconnect backoff
off a `setInterval` (which browsers clamp to ~1s when hidden but do not stop),
independently of the render loop. 1Hz against a 10s timeout is ample.

**4.3 — The reconnect ladder gives up before the grace window closes.**
`DEFAULT_BACKOFF_TICKS` is `[30, 60, 120, 240, 480]` — five attempts, ~15.5s
total — and then `ReconnectingChannel` fires `onClose` and is permanently
`givenUp`. `RESUME_GRACE_TICKS` is 30s. So an outage between ~16s and 30s is
one the *server* would still honour a resume for and the *client* has already
stopped trying. Nothing retries after that; the tab is dead until manually
reloaded. The comment in `reconnecting.ts` argues the ladder is sized against
the grace, but it is sized to roughly half of it. **Fix:** extend the ladder to
cover the full grace (add a couple of rungs, or cap the backoff at ~5s and keep
retrying until the grace has certainly expired), and once 3.2 lands, consider
never giving up at all — with take-over semantics a late reconnect is just a
login.

**4.4 — Flood strikes never decay.** `RateLimiter.strikes` is incremented on
every over-budget frame and is never reset or aged. `FLOOD_STRIKES` is 60, and
crossing it calls `drop(connection, 'flooding')` — an *intentional* disconnect,
so no body is held and it is not resumable. A long, well-behaved session that
trips the verb bucket sixty times *in total* over an hour is dropped as a
flooder. **Fix:** decay the strike count over time (or reset it whenever the
bucket refills to full), so it measures a rate rather than a lifetime total.

**4.5 — No WebSocket-level keepalive.** `transport-ws.ts` sets up no ping/pong
frames and no `maxPayload`. Application traffic is constant while a tab is in
the foreground, so intermediaries are not currently killing idle connections —
but combined with 4.2 a hidden tab is silent at every layer, and a proxy in
front of the server is free to drop it. Worth adding `ws`'s own heartbeat when
this is deployed behind anything.

**4.6 — No `Goodbye` on page unload.** Nothing in `view.ts` listens for
`pagehide`/`beforeunload`, so closing a tab or navigating away is always an
*accidental* drop and always leaves a body standing for 30s. That is spec 150's
intended anti-combat-logging behaviour and should probably stay for a close —
but it means a deliberate reload is indistinguishable from a rage-quit, and it
is what makes door 3 easy to hit.

**4.7 — Minor: any mid-session `Error` rejects a pending welcome.**
`game-client.ts:1671` calls `this.rejectWelcome?.(…)` on every `Error` message,
including ordinary refusals like "not logged in". If one arrives while a
`connect()` is in flight, it fails the handshake promise for an unrelated
reason.

---

## 5. Suggested regression tests

All of these run headlessly against `GameServer` + `LoopbackTransport`, in the
style of `src/server/client/resume.test.ts`:

1. Two connections on one `playerId`; the first sends `Goodbye`; the second must
   still have a session and must still be able to act. (door 2)
2. Connect, reconnect with a valid token *without closing* the first socket,
   run past `CONNECTION_TIMEOUT_TICKS + RESUME_GRACE_TICKS`; the live client
   must still have a session, and there must be exactly one player body. (door 1)
3. Connect, drop, relogin with a stale token, run past the grace; live session
   survives. (door 3)
4. Two drops on one id, both graces expired, nobody connected: player body count
   must be zero. (the leak)
5. A client that is silent for longer than the grace is fully reaped — the
   existing behaviour, so that 3.1's ownership check does not accidentally make
   sessions immortal.

Test 5 matters: the fix in 3.1 is a guard against ending a session somebody
owns, and it must not become a reason a session is never ended.

---

## 6. What was done (spec 157)

Implemented in `specs/157-one-player-one-connection.md`, with
`src/server/client/spec157.test.ts` as the regression suite — 11 tests, of
which 7 fail against the unfixed server, including one that drives a real
action and asserts no "not logged in" refusal ever reaches a live client.

- **3.1, 3.2, 3.3 — all taken.** `hello()` now takes a player over rather than
  duplicating them: the newest connection adopts the existing entity and
  session, the old one is *displaced* holding nothing, and `reap()` refuses to
  log out a `playerId` that a live connection is holding. A fresh login reaps
  any lingering entry for its id first, which closes the orphan leak.
- **3.4** is moot: with takeover, two lingering entries for one id cannot arise.
- **4.1 — taken.** `GameClient.onWelcome` fires on every welcome; the Play tab
  writes the resume token from there instead of once.
- **4.2 — taken.** `GameClient.keepAlive()` plus a 500ms `setInterval` in
  `view.ts` drives the heartbeat and the reconnect backoff off the wall clock.
  `keepAlive` detects a stalled loop by comparing `localTick` against the last
  call, so it stays clock-free and sends nothing while the tab is visible.
- **4.3 — taken.** The ladder is `[30, 60, 120, 240, 480, 480, 480, 480]`, and
  a test asserts its sum exceeds `RESUME_GRACE_TICKS` so the two cannot drift.
- **4.4 — taken.** `STRIKE_DECAY_TICKS` (600) retires strikes after a quiet
  spell, making the flood check a rate rather than a lifetime total.
- **4.5, 4.6 — not taken**, as recommended above; both are noted in the spec's
  Out of scope.
- **4.7 — attempted and backed out.** Narrowing which errors fail a pending
  handshake cannot be done by code: `hello` refuses 'already connected' with
  `RejectedAction`, the same code an ordinary refusal carries, and spec 145's
  hello-twice test rightly depends on that failing its `connect()`. It needs a
  handshake-specific error code, which is a protocol change. The takeover fix
  removes the refusal storm that made it visible, so it is cheaper left alone.
- **The `?name=` rename is deliberately still broken.** Writing the name on
  every login is worse than the bug — a tab loading with `?id=` and no `?name=`
  would silently rename you to `Player 1a2b`, because the wire cannot tell
  "asked for this name" from "defaulted to it". A real fix is a rename verb.

One thing worth recording, because it was nearly shipped: the first cut of the
takeover read `held.entityId` *after* `displace()` had cleared it, so every
takeover welcomed the client to entity -1 and hung the handshake. Taking a body
over and taking it away are the same two fields, and the order between them is
the whole difference.
