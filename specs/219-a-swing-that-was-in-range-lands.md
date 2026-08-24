# 219 — A swing that was in range lands

## Problem

Three defects, measured through the real `step()` with a `small_spider`
(`melee.slash`, 30-tick wind-up, 24-tick backswing) and a player who runs:

1. **A monster withdraws from its own wind-up.** Wind-up began t38; at t50 —
   12 ticks into 30 — the cast ended `Cancelled`, with `hits=0` *and*
   `misses=0`. Not a miss: the swing ceased to exist.
2. **A monster breaks its own backswing.** Committed t68 (blow landed), rooted
   to t79, then `BackswingCancelled` at t80 of a t68–t92 backswing, stepping
   1.92/tick.
3. **A named target out of reach at the release is a miss**, even when the
   wind-up ran to completion. Player wind-up on a dummy shoved out of reach
   mid-swing: `hits=0, misses=1, damage=0`.

(1) and (2) are one bug and are documented nowhere. `world.ts` treats *any*
move intent as a withdrawal — right for a player pressing a key — while
`monsterIntent` computes `closing = !alert && distance > reach` with no regard
for a live cast. `wantsToSwing` checks `monster.cast === null`; `closing` never
does. So the chase logic emits a move intent straight through the monster's own
swing and the body withdraws from itself, at exactly the tick the target
crosses standoff distance. (1) also *masks* (3) for monsters: fixing the range
rule alone changes nothing for them, because they cancel before release.

(3) is deliberate and this spec reverses it. Spec 070 states "A named target
out of `range + radius` at the release takes no damage", on the argument that
checking at the commit "would make the wind-up unreadable from the other side".
The rule this replaces it with keeps that readability where it actually lives —
in the wind-up being long enough to withdraw from — and moves the range
question to the one instant the attacker can act on it.

**The rule: a wind-up that began in reach lands.** Distance at the release
stops being asked.

## Shape

`CastState` gains one field:

```ts
/**
 * Was the named target within `range + radius` when the wind-up *began*?
 * Meaningless (and false) for a cast that names no target.
 */
readonly targetInReach: boolean;
```

Stamped at the two places `phase` becomes `CastPhase.Windup`, and nowhere
else:

- `startCast`, for a cast that needs no turn (`phase = Windup` at commit);
- the `CastPhase.Turning -> Windup` transition in `advanceCast`, which
  re-stamps it beside `windupStartTick`.

Both go through one helper so the two cannot drift:

```ts
function withinReach(
  ability: AbilityDefinition,
  caster: ServerEntity,
  targetX: number, targetY: number, targetRadius: number,
): boolean;
```

Measured at the wind-up rather than at the commit because a body turns first
(spec 065) and the turn is not the swing: `windupStartTick` is already
re-stamped there for exactly this reason, and the reach belongs beside it.

`landOnTarget` drops its distance test and reads `cast.targetInReach`. Alive,
hostile and *present in `candidates`* still gate it — a target that left the
simulated set is still a miss, which is the natural bound on "unconditional".

One inconsistency closes on the way past. `startCast`'s gate measures
`castRangeFor` — the row plus Intelligence's shaping — and `landOnTarget`
measured raw `ability.range`, so a `unit`-targeted melee *skill* cast by a
shaped caster could be legally started at a distance the release then refused,
which made spec 147's range shaping decorative for that whole ability kind.
`withinReach` is `castRangeFor` for everyone, so the two questions are one
function. A basic attack is unaffected: `castRangeFor` returns the row's own
range for anything flagged `basicAttack`.

`world.ts`'s withdrawal-by-walking becomes **player-only**:

```ts
if (steered.kind === EntityKindValue.Player && steered.cast !== null && asksToMove(rawIntent))
```

That one line covers every branch of `monsterIntent` — chase, flee, idle,
`walkHome`, and a target that died mid-wind-up — rather than guarding
`closing` and leaving the others. The root already in place
(`steered.cast !== null` zeroes `moveX/moveY`) then holds the monster still
through the wind-up *and* the backswing, and the intent cached for the cast
pass is the rooted one, so the second withdrawal site needs no change.

Nothing crosses the wire. `CastState` is server-side; the `castStarted`
projection carries no such field, so there is no protocol change and no client
prediction to keep in step.

## Invariants tested

- A monster whose target runs out of reach mid-wind-up **completes the swing**
  and damages that target: no `castEnded` with `Cancelled` between the wind-up
  and the release.
- A monster does not move for the whole of its backswing: position is
  unchanged from the commit to `endTick`, and no `BackswingCancelled`.
- A player whose named target leaves reach mid-wind-up still lands the blow.
- A cast that begins **out** of reach still misses — `targetInReach` is false,
  so a `direction`-targeted melee naming a body three times its range away is
  the miss it has always been. (This is the case `startCast`'s range gate does
  *not* cover, and the reason the field exists rather than a refusal.)
- A target that is dead, or absent from `candidates`, at the release is a miss
  whatever `targetInReach` says.
- The reach a swing is judged by is `castRangeFor`, so a shaped caster's melee
  skill lands at the range it was allowed to be started at.
- A player still withdraws from a wind-up by walking (cost refunded, no
  cooldown) and still walks out of a backswing (`BackswingCancelled`, interval
  untouched).
- Reach is measured at the wind-up's start, not at the commit: a target that
  leaves reach *while the caster is still turning* is a miss.
- An untargeted cone is unchanged — `landCone` keeps its geometry.
- Same seed and inputs replay to bit-identical state; the `Rng` draw count does
  not move.

## Out of scope

- **`landCone`.** A cursor-aimed sweep names no target and has no "was in
  range" to remember; it is an area attack whose shape is the whole mechanic.
  Making it unconditional would land it on bodies behind the caster.
- **Projectiles.** A shot already travels and can already be outrun; nothing
  here touches `launchProjectile` or the impact in `world.ts`.
- **Fleeing overriding a commitment.** A monster that panics mid-swing keeps
  its swing under this change, because the root is now unconditional for
  monsters. Whether panic *should* drop a backswing is a separate question and
  is not decided here.
- **`startCast`'s range gate.** Unchanged: `point` and `unit` targeting are
  still refused past reach, `direction` is still always legal to start.
- **Monster attack pacing.** A monster now stands still for its whole backswing
  where it used to break out early, which lengthens the gap between its blows
  at range. No BAT or standoff number is retuned here.
