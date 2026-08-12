# 150 — A socket that comes back

## Problem

A dropped socket is the end of a session. `disconnect()` cancels the trade,
removes the entity, and logs the player out; the next `Hello` is a fresh login
that spawns a new body. What survives is *persistence* — position, inventory,
coins and skills all reload from `PersistedPlayer` — but not the session: the
entity id changes, anything in flight is gone, and the client does not even try
to come back, because `channel.onClose` sets `connected = false` and stops. And
nothing times a connection out, so a socket that dies without a `close` holds
its player forever.

## Assumptions

- **`Channel` must not learn about reconnection.** `transport.ts:9-12` states
  the omission as a decision: "the smallest thing both implementations can
  honestly provide... a loopback channel would have to lie about all three."
  Widening it would make `LoopbackChannel` lie. So reconnection goes in a
  wrapper *above* `Channel` — one that mints a fresh inner channel per attempt
  and presents a single stable one upward. The interface is untouched.
- **Persistence is not resumption.** The record already survives. What this
  spec adds is the *session*: the same entity, the same id, and the state that
  is not in the record.

## Shape

### The entity lingers; the trade does not

On socket loss a connection becomes **lingering** rather than gone:

- the entity **stays in the world** for `RESUME_GRACE_TICKS` (1800 — 30s),
  standing still, taking no input;
- its trade is cancelled **immediately**, because the other party must not be
  made to wait on somebody who may never come back;
- its open vendor is closed, for the same reason and with no cost to anybody;
- on expiry it is reaped by exactly the path that reaps it today.

The body standing there is deliberate rather than incidental. It is what stops
pulling the plug being an escape from a fight — and it is the reason the trade
has to be cancelled in the same breath, because "your entity is still there" and
"your half of a trade is still live" are very different promises.

### A token, and why it is not from the seeded PRNG

`WelcomeMessage` gains `sessionToken: str`. `HelloMessage` gains
`resumeToken: str` — empty for a fresh login. A `Hello` whose `resumeToken`
matches a lingering session for that `playerId` re-attaches to the existing
entity; anything else is a new login, exactly as now.

The token comes from `crypto.randomUUID()`, not from the `Rng` the world is
built on. That Rng is seeded and reproducible on purpose, which is precisely
what a resume token must not be: anyone who knows the seed and the tick could
mint somebody else's. It is the one place in the server where unpredictability
is the requirement rather than the enemy, and it is worth the sentence because
every other random number here comes from the other kind.

`crypto.randomUUID` rather than `node:crypto`, because `server.ts` is bundled
into the browser tab for single-player and may not import Node.

`PROTOCOL_VERSION` 14 → 15.

### Heartbeat and timeout

Every frame received stamps `lastSeenTick`. A connection that has said nothing
for `CONNECTION_TIMEOUT_TICKS` (600 — 10s) is treated as a lost socket and
begins lingering. The client already pings every 30 ticks, so ten seconds is
twenty missed heartbeats: long enough that a stall is not a disconnection,
short enough that a half-open socket does not hold a body all evening.

This is the half that a `close` event cannot cover. A socket killed by a dead
router or a suspended phone never delivers one, and before this the entity
stayed forever.

### Coming back

`src/server/net/reconnecting.ts` — a `Channel` over a supplier of channels.

```ts
export class ReconnectingChannel implements Channel {
  constructor(options: {
    open: () => Channel;
    onReopen?: () => void;
    onPhase?: (phase: ConnectionPhase) => void;
    backoffTicks?: readonly number[];
  });
  /** Drives the backoff. Once per sim tick, like `UnreliableChannel`. */
  deliver(tick: number): void;
}
```

Its contract is the thing worth stating: **`onClose` fires when the wrapper
gives up, not when a socket drops.** From above it is one channel that survives
outages. Backoff is `[30, 60, 120, 240, 480]` ticks — half a second to eight,
about fifteen seconds in total, comfortably inside the thirty the server holds a
body for. Driven off the sim tick rather than a timer, so it is pure and a test
drives it with a loop.

`GameClient` keeps the `sessionToken` from its `Welcome` and, on `onReopen`,
re-sends `Hello` carrying it. It clears its replica first: the resumed
connection gets a fresh `DeltaTracker`, so every visible entity arrives as a
spawn again, and a stale replica would hold bodies nothing will ever remove.

### A clean goodbye

`ClientMessageType.Goodbye` — no payload. `disconnect()` sends it before
closing, and a connection that said goodbye is reaped at once with **no**
lingering body. Pulling the plug and choosing to leave should not look the same
to the world, and this is the one bit that tells them apart.

## Invariants tested

- **A resumed session is the same body.** Drop the socket, reconnect with the
  token: the same `entityId`, the same position, the same inventory — and no
  second entity anywhere in the world.
- **A wrong token is a new login.** An empty, stale or forged token spawns
  afresh rather than seizing a lingering session. Asserted with another
  player's token too, which is the case that matters.
- **The body lingers, then goes.** After a drop the entity is still there;
  after `RESUME_GRACE_TICKS` it is gone, and the player is logged out and saved.
- **Nothing is orphaned.** A drop mid-trade cancels it for *both* sides
  immediately, with the item count across both bags unchanged — spec 132's rule,
  reused. A drop with a vendor open leaves no vendor open. A drop mid-cast does
  not leave a cast running forever.
- **Silence is a disconnection.** A connection that stops sending is lingering
  after `CONNECTION_TIMEOUT_TICKS` and reaped after the grace, without any
  `close` ever arriving.
- **Goodbye skips the grace.** A clean disconnect reaps immediately; no body is
  left standing.
- **The wrapper survives an outage.** With an opener that fails a few times and
  then succeeds, the channel delivers frames again, fires `onReopen` once per
  success and `onClose` never; with one that always fails, `onClose` fires
  exactly once, after the last backoff.
- **`Channel` did not change.** `LoopbackChannel` and the browser channel are
  untouched, and their tests are unmodified.

## Out of scope

- **Accounts.** The token authenticates a *session*, not a person. Anybody who
  knows a `playerId` can still log in as it, exactly as today — that is what
  "no accounts and no passwords" in the brief means, and the token narrows
  nothing about it.
- **Resuming across a server restart.** Lingering sessions live in memory and
  the `DataStore` is in-memory anyway. A restart is a fresh world.
- **Replaying what was missed.** A resumed client is re-sent the world as it is
  now, not what happened while it was away. There is no event log to replay from
  and no reason to build one for a thirty-second gap.
- **Reconnecting the loopback.** The in-tab transport cannot drop, so the Play
  tab wraps only the socket path. Wrapping the loopback would be a decorator
  around something that never fails.
- **Telling the other players.** A lingering body looks like a player standing
  still, because that is what it is. A "disconnected" marker over a head is a
  presentation question and a later one.
