# 197 — A connection the tab cannot break

## Problem

Switching to another tab for a few minutes drops the player. Spec 157 already
fought this once and won the round it could see: the heartbeat and the reconnect
backoff came off `requestAnimationFrame` — which a hidden tab throttles to
nothing — and onto a wall-clock `setInterval`, on the stated grounds that a
browser "clamps [it] to about a second when hidden but never stops, which is the
whole difference between 'slower' and 'never'".

That is true for the first five minutes and false afterwards. Chrome applies
**intensive throttling** to a page that has been hidden and silent for five
minutes: chained timers run at most **once per minute**. An open WebSocket does
not exempt it. So `KEEPALIVE_MS` becomes 60000, the server's
`CONNECTION_TIMEOUT_TICKS` (600 — ten seconds) fires on the very first gap, and
the player is dropped for having looked at their email.

Two smaller faults sit under the same interval and each makes the recovery
worse than the drop:

- **The backoff ladder counts firings, not time.** `view.ts` adds a flat
  `KEEPALIVE_TICKS` (30) per firing, which is 60 ticks per second only if the
  interval really fires every 500ms. Clamped to a second it is 30 ticks per
  second, so `DEFAULT_BACKOFF_TICKS` — sized in spec 157 to cover
  `RESUME_GRACE_TICKS` with margin — takes 79 seconds of wall clock instead of
  39.5 against a 30-second grace. Under intensive throttling the *first* retry
  is a minute out, by which time the body has been reaped, and the ladder runs
  for over an hour before giving up.
- **Nothing listens for `visibilitychange`.** Coming back to the tab is the one
  moment we know the outage's cause is gone, and it is the moment the client
  does nothing at all: it waits for the next tick of the clock that is the
  problem.

The world itself needs none of this. The server is authoritative and never
stopped; the body stood in the arena the whole time. Only the evidence that
somebody is still holding the other end of the socket went missing.

## Shape

### The heartbeat that needs no JavaScript

The fix is to stop asking the page's timers to prove the connection is alive,
because that is precisely what a throttled page cannot do. A WebSocket peer
answers a protocol-level `ping` with a `pong` **in the network stack**, with no
JavaScript involved — so it works in a tab whose timers are down to one a minute,
and it is not something the page can be throttled out of.

Spec 157 left this out as a deployment question ("`transport-ws.ts` sends no ping
frames... an intermediary that needs protocol-level pings is a deployment
question"). It is not only that: it is the only liveness signal a background tab
still has.

```ts
// server/net/transport.ts
export interface Channel {
  // ...unchanged...
  /**
   * Out-of-band evidence the peer is still there, for a transport that has any.
   * Optional because most do not.
   */
  onAlive?(handler: () => void): void;
}
```

Optional, and that is the point rather than a convenience. `transport.ts` states
the rule this interface is written to — "the smallest thing both implementations
can honestly provide" — and a loopback channel has no wire to prove anything
about. An absent member says "this transport has no such signal"; a required one
would make `LoopbackChannel` invent one.

```ts
// server/net/transport-ws.ts
export interface WebSocketTransportOptions {
  // ...unchanged...
  /** Ms between protocol pings. Defaults to `SERVER_PING_MS`; injected by tests. */
  readonly pingMs?: number;
}
```

One sweep timer on the transport rather than one per socket, `unref`'d so it
never holds the process open, and `SocketChannel.onAlive` is `socket.on('pong')`.

```ts
// server/config.ts
/** Ms between the server's protocol pings. Three chances inside the timeout. */
export const SERVER_PING_MS = 3000;
```

`server.ts` stamps the same field a frame stamps:

```ts
channel.onAlive?.(() => { connection.lastSeenTick = this.state.tick; });
```

A pong is *better* evidence than the application ping it backs up, and worth
saying why: the app ping proves the tab's JavaScript is running, where a pong
proves the socket is open end to end. A dead router — the case
`CONNECTION_TIMEOUT_TICKS` exists for, since it delivers no `close` — yields no
pong either, so the timeout still does its job.

### The backoff runs on real time

```ts
// render/iso3d/world/keepalive.ts  (new, pure)
export const KEEPALIVE_MS = 500;
export function backoffTicksFor(elapsedMs: number, tickRate: number): number;
```

`view.ts` measures the gap between firings and converts it, instead of adding a
constant that assumes the gap. The ladder then takes the same 39.5 seconds
whether the interval fires twice a second or once a minute, which is what it was
sized to be.

A large gap is safe and is the behaviour we want: `ReconnectingChannel.deliver`
opens at most one attempt per call and its rung only advances on a *failed*
attempt, so an hour delivered in one step is an immediate retry rather than a
ladder burnt through to `givenUp`.

### Coming back is an event

The interval's body becomes a named `pump()`, and `visibilitychange → visible`
calls it. Same ping, same conversion, same `deliver` — the tab does not wait out
a throttled timer to notice it is being looked at.

### Smaller things in the same seam

- **The frame clock is reset on return.** `last` and the FPS window are reset the
  way `start()` and `stop()` already reset them, so the first frame after ten
  hidden minutes is one tick long rather than one ten-minute `dt` fed to the
  camera and averaged into the meter.

## Invariants tested

- `backoffTicksFor` returns 30 for a 500ms gap and 60 for 1000ms — the ladder
  measures wall clock, so the total time to walk `DEFAULT_BACKOFF_TICKS` is the
  same at both firing rates, and equals the ~39.5s spec 157 sized it to.
- It never returns zero, so a firing always moves the clock forward.
- A 60s gap — intensive throttling — delivers enough ticks in one firing to
  trigger a due retry immediately.
- `SERVER_PING_MS` fits at least three times inside
  `CONNECTION_TIMEOUT_TICKS`, asserted as arithmetic so the two cannot drift.
- A `SocketChannel` over a real `ws` pair reports `onAlive` repeatedly while the
  client sends **no application frames at all**.
- `LoopbackChannel` has no `onAlive`, and a server accepting one does not throw.
- A connection whose channel reports alive has `lastSeenTick` advanced by that
  alone, and so survives past `CONNECTION_TIMEOUT_TICKS` with no frame received.
- A connection that reports neither frames nor pongs is still swept, unchanged.

## Out of scope

- **An idle timeout.** With pongs, a hidden tab holds its body for as long as the
  tab is open. That is already true of a *visible* idle tab, which pings twice a
  second while its owner is asleep, so this makes the two consistent rather than
  introducing something new. "How long may a player stand in the arena doing
  nothing" is a real question and a different one; it is about input, not about
  sockets.
- **A frozen or discarded tab.** Chrome may freeze a background page outright
  under memory pressure. Nothing in the page can answer for that, and the resume
  path is what covers it — this spec's job is to make sure the resume is
  *reached*, which the real-time ladder and the visibility kick do.
- **Firefox and Safari.** Both throttle background timers less aggressively than
  Chrome, and neither is made worse by a heartbeat that does not depend on them.
- **`Goodbye` on unload**, unchanged from spec 157: closing a tab is still an
  accidental drop and still leaves a body for thirty seconds.
