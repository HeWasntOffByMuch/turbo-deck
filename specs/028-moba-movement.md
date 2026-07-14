# 028 — MOBA movement: click-to-move, speed & turn rate

## Problem

Movement today is instantaneous 8-directional keyboard nudging: the player
translates immediately in any of eight directions with no notion of which way
the unit is facing. This is an experimental change to make movement feel like a
MOBA (specifically Heroes of Newerth): the player is issued a discrete move
*order* to a world point (a right-click), and the unit obeys it constrained by
two per-unit properties — a **movement speed** and a **turn rate**. A unit must
first rotate to roughly face where it's going before it can start translating,
so whipping around costs time and reacting to a threat behind you is not free.

HoN's rule is deliberately forgiving: a unit only needs to face within **135°**
of the move direction before it can begin moving. Click directly behind the
hero and it starts moving after rotating just 45°, finishing the turn while
already travelling. Crucially, once moving it travels in a **straight line** to
the destination — the rotation is cosmetic from that point on; there is no
curved/arcing path, no sliding, and no momentum carried between orders.

Scope is the **player only**; enemy movement, dashing, and attacks are
unchanged and layer on top as before.

## Shape

New player state (`PlayerState`):

- `facing: number` — heading in radians, `0` = +x (east). Normalized to `(-π, π]`.
- `moveTarget: Vec2 | null` — the standing move-to destination in world units;
  `null` when the unit has no order / has arrived.

Input (`InputFrame`, and the game-layer inputs `GameInput` / `SpellInput`):

- Replaces `moveX/moveY` with `moveTarget?: Vec2` — a move order issued *this
  tick*, to a world point. Present ⇒ (re)set the standing destination; absent ⇒
  keep obeying the existing one. Orders are **discrete clicks only**: the
  renderer emits `moveTarget` on the tick of a right-click press, never while a
  button is held.

New constants (`sim/constants.ts`):

- `PLAYER_BASE_MOVE_SPEED = 300` — base speed in world units/second.
- `MOVE_SPEED_HARD_MIN = 100`, `MOVE_SPEED_HARD_MAX = 550` — HoN speed caps.
- `PLAYER_TURN_RATE = 540` — turn rate in degrees/second (a 180° about-face in
  1/3 s; HoN slow units are 360, fast ones 900+).
- `MOVE_FACING_THRESHOLD_DEG = 135` — a unit must face within this many degrees
  of its move direction before it begins translating; otherwise it rotates in
  place. (So a 180° reversal only needs a 45° turn to get moving.)
- `MOVE_ARRIVE_EPS = 2` — the order is fulfilled within this distance.

New pure helper (`sim/combat.ts`, exported for tests):

```ts
// ((base + flat) * pct) then each slow applied multiplicatively (damped by its
// slow resistance), finally clamped to [MIN, MAX] and rounded — the HoN formula.
computeMoveSpeed(
  base: number,
  flatBonus?: number,
  pctBonus?: number,
  slows?: readonly { multiplier: number; resistance?: number }[],
): number
```

Per tick, when the player is not dashing and not rooted (attack wind-up/recovery
still roots as before) and has a `moveTarget`:

1. desired heading = angle from position to target.
2. rotate `facing` toward desired by at most `PLAYER_TURN_RATE/TICK_RATE`
   degrees (snapping when within one step).
3. if the remaining angle between `facing` and desired ≤ 135°, translate
   **straight toward the target** (not along the lagging facing — no arc) by
   `computeMoveSpeed(PLAYER_BASE_MOVE_SPEED)/TICK_RATE × moveScale` (clamped to
   the arena; capped at the remaining distance). Otherwise stand and keep turning.
4. clear `moveTarget` on arrival (within `MOVE_ARRIVE_EPS`).

`moveScale` is the existing walk-speed multiplier (adrenaline / haste / slow),
so those systems keep working. A standing unit (no move order) keeps its
heading — it does **not** rotate to follow the cursor. If facing tracked the
mouse, a stationary hero would always already be pointing at the click point and
so would never spend any turn time; keeping the heading fixed is what makes
clicking behind you cost a real rotation.

## Invariants tested

- Same `(seed, inputs)` — inputs now carrying `moveTarget` — still replays to
  bit-identical state and events (trig stays deterministic).
- Player position stays clamped inside the arena for any order, including orders
  pointed outside it.
- A move order roughly ahead (within 135°) starts translating on the very first
  tick; an order directly behind (180°) produces **zero** translation on the
  first tick — the unit only rotates until within the 135° gate, then moves.
- Movement is a **straight line**: while travelling to a fixed order the player's
  path stays on the segment to the target (perpendicular offset ~0) — no arc.
- A unit given a reachable order eventually arrives (distance ≤ `MOVE_ARRIVE_EPS`)
  and clears its `moveTarget`; it does not drift afterwards (no momentum).
- `computeMoveSpeed` clamps to `[100, 550]`, rounds, and applies flat/pct/slow
  terms in the documented order.
- Attack commitment is unchanged: the player is rooted (no translation, no
  turning) through wind-up + recovery, then resumes toward its order.

## Out of scope

- Enemy movement / turn rate — enemies keep their existing homing model.
- Dashing keeps its own velocity override; turn-rate gating does not apply to it.
- Facing-gated **attacks/casts** (requiring the unit to face the target before a
  swing resolves). Attacks still resolve off the mouse `aim`.
- Flat/percentage/slow speed *modifiers* wired to cards — `computeMoveSpeed`
  supports them, but the sim only feeds the existing `moveScale`.
- Pathfinding / obstacle avoidance — movement is straight toward the order.
