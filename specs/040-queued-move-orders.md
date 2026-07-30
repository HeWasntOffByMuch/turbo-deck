# 040 — Queued move orders

## Problem

A move order is a single destination: every right-click throws away the
standing one. Routing around the arena's walls (spec 037) makes that limiting —
you cannot plan a two-leg path around a corner, or line up a retreat before
committing to the fight. MOBAs solve this with shift-click: hold shift and the
click *appends* a waypoint instead of replacing the order. The sim owns this,
because where the unit walks is a game outcome.

## Shape

The player gains a queue of destinations to walk after the current one:

```ts
// PlayerState
/** Destinations to walk after `moveTarget`, in order; empty when none queued. */
readonly moveQueue: readonly Vec2[];

// InputFrame
/**
 * Append `moveTarget` to the queue instead of replacing the standing order.
 * Ignored when no `moveTarget` accompanies it.
 */
readonly queueMove?: boolean;
```

`SpellInput` (game layer) mirrors `queueMove` and passes it through untouched.

Rules:

- A plain order (`moveTarget`, no `queueMove`) behaves exactly as before, and
  additionally **clears** the queue: an un-shifted click is a fresh plan.
- A queued order with a standing destination appends to `moveQueue`, capped at
  `MOVE_QUEUE_MAX` (8) — beyond that the click is dropped, not rotated.
- A queued order with **no** standing destination becomes the standing order
  immediately (nothing to queue behind), routed like a plain one.
- On arrival, the head of the queue becomes the standing order on that same
  tick and is routed around walls (spec 037) from where the unit stands.
- `cancelMove` (playing a card halts the unit) clears the queue as well as the
  standing order.
- A queued order does **not** cancel an in-flight attack (spec 028) and does not
  hand back cards reserved in an open synergy window; only a plain order does.
  Queuing is planning, not committing.

## Invariants tested

- A queued click with a standing order leaves `moveTarget` unchanged and appends
  to `moveQueue`; a plain click replaces `moveTarget` and empties `moveQueue`.
- A queued click with no standing order sets `moveTarget` and leaves the queue
  empty.
- Walking a two-point queue reaches the first destination, then the second, and
  ends with `moveTarget === null` and an empty queue.
- A queued destination behind a wall is routed (non-empty `movePath`) when it is
  promoted, not when it is queued.
- `cancelMove` clears both the standing order and the queue.
- A queued order does not raise `attackCancelled` while an attack is pending; a
  plain one still does.
- The queue is capped at `MOVE_QUEUE_MAX`.
- Replay determinism holds: the same seed + input sequence (including queued
  orders) produces bit-identical state.

## Out of scope

- Queuing anything other than movement (no queued casts or attack-moves).
- Reordering, removing, or clearing individual queue entries.
- Enemy pathing: enemies keep chasing the player and never queue orders.
- Rendering the queued waypoints — spec 041 covers the view.
