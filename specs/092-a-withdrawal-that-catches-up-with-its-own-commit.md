# 092 — A withdrawal that catches up with its own commit

Written after the fix, like spec 090, and for the same reason: it began as a bug
report and the shape of the answer was not knowable until the cause was.

## Problem

Reported: *"normally the shot fires after the wind-up bar has completed, but
when turning away mid-wind-up a shot will often go off even though the player
clicked away on the ground before the wind-up finished."*

This is spec 090's opening report, still alive after four fixes. What is new is
the detail that it happens *on the way out of an attack order* — click away, the
bar vanishes at about half, the arrow flies anyway.

The bar vanishing at half is not a clock problem. The client drops its predicted
cast the instant the player asks to withdraw, so the bar going at 50% is the
client keeping its own promise. The only question is why the server did not
withdraw.

### What was actually wrong

A connection holds casts and cancels in **two separate queues**, each entry
stamped with the input seq it must wait for. Every tick, `server.ts` takes at
most one of each and folds them into one `ServerInput`. `due` turns true for a
whole backlog at once, and on any tick the input queue empties — which is most
ticks, since the browser's frame clock and the server's tick clock are not in
phase — `starved` makes *everything* due regardless of seq. So a request and a
withdrawal issued a moment apart routinely ride the same input.

And an input carrying both was resolved wrongly, in two different ways:

1. **With nothing in progress, the cancel was swallowed and the commit went
   ahead.** `cancelCast` found no cast, reported `cancelled: false`, and the code
   fell through to `startCast` on the same tick. The player clicked away, the bar
   vanished, and the arrow flew. This is the report, exactly.

2. **With a cast in progress, the commit was dropped in silence.** The cancel
   succeeded and `continue`d past the new request — no `castStarted`, no
   `castRejected`, no event of any kind. The client pairs the n-th reply with the
   n-th request (spec 080), so every answer after it was attributed to the wrong
   press: a refusal handed back a cooldown and a root belonging to a different
   cast.

Neither is exotic. (1) reproduces through the real server and wire the first
time it is asked for.

### What was not wrong

- **The wind-up bar's clock.** Chased first, on the strength of the "half-ish"
  detail, and it measures clean: the drawn tick is `estimatedTick` plus the
  frame's fraction, `estimatedTick` is corrected forward on every delta and never
  runs backwards, and after the server confirms a cast the bar is drawn from the
  server's own `releaseTick`. The 50% is the client's synchronous withdrawal,
  not a disagreement about when the blow lands.
- **The client not sending the cancel.** Spec 090 added `client.cancelCast()` to
  the right-click-on-ground branch and it fires. The message is sent, arrives,
  and is queued. It is spent on the wrong tick, not missing.

## Shape

### The order between the two queues is written down

```ts
// server.ts
interface PendingCast  { readonly afterInputSeq: number; readonly arrivedAt: number; /* ... */ }
interface PendingCancel { readonly afterInputSeq: number; readonly arrivedAt: number }
```

`arrivedAt` comes from a per-connection counter bumped by every cast and every
cancel, so the order *between* the queues survives being split across them. When
both are due, the earlier one goes out and the other waits a tick:

```ts
const castFirst = nextCast !== undefined &&
  (nextCancel === undefined || nextCast.arrivedAt < nextCancel.arrivedAt);
```

So a commit followed by a withdrawal becomes: tick T starts the cast, tick T+1
withdraws from it — one tick of wind-up, refunded, no blow. A withdrawal
followed by a commit becomes: tick T withdraws, tick T+1 starts the new cast.
Both readings are preserved because both are real; "not that one" and "not the
last one, and now this" are different asks and the tick they collide on must not
blur them.

### And `step` holds the rule anyway

`server.ts` no longer builds an input carrying both, but `mergeInputs` (spec 090)
folds a batch of client frames into one and or-s `cancelCast` across it, and the
bots and the tests call `step` directly. So the contract lives in the sim too —
the lesson spec 090 already paid for once with the dropped-input defect:

- The withdrawal outranks the commit. The two readings do not cost the same:
  swallowing the cancel throws a blow the player called off, swallowing the
  commit costs a press.
- The commit is **answered**, not dropped, with a new rejection reason:

```ts
// abilities.ts
export type CastRejection = /* ... */ | 'withdrawn';
```

`reason` is a string on the wire, so this costs no protocol version.

## Invariants tested

- **A request and a withdrawal issued together throw nothing**, through the real
  server, the real wire format and the real input queue. Checked to fail without
  the fix, which is the only reason to believe it covers anything.
- **A withdrawal issued *before* a request does not eat it**: the cast still
  starts. The ordering is the fix, not "cancels always win".
- **Every request is answered exactly once**, including one that collides with a
  cancel for a cast already running — the pairing spec 080 depends on.
- **In `step`, a single input carrying both** starts nothing, refuses the request
  with `withdrawn`, and charges neither cost nor cooldown; with a cast already
  running it withdraws from that one and still refuses the new request.

## Out of scope

- **Merging the two queues into one.** One ordered queue of asks would make
  `arrivedAt` unnecessary and is probably where this ends up, but it moves the
  `due` gate, the starvation rule and every test that drives them. Recording the
  order is the smaller change that fixes the defect.
- **The wind-up bar's percentage.** Measured and found honest (above). The 50%
  in the report is the client's own synchronous withdrawal and is correct
  behaviour; spec 090 already argues why the bar should not wait for a round
  trip.
- **Un-throwing a shot already loosed.** Spec 079 stands: a withdrawal that
  genuinely arrives after the release is refused, and the test that pins it is
  untouched.
