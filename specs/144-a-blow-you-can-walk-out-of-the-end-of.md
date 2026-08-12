# 144 — A blow you can walk out of the end of

## Problem

An attack here is one span with one gate. `windupTicks` is how long the body is
committed, and the cooldown -- stamped at the release since spec 091 -- is how
long until the next one. Three things follow that are all wrong in the same way.

**There is no backswing.** Spec 068 freed the caster on the tick the blow lands,
so a swing has a wind-up and then nothing: the body snaps from committed to idle
with the sword still out. There is no follow-through to cancel, and therefore no
skill in cancelling it.

**The cadence is measured from the wrong end.** `readyAt = releaseTick +
attackDelayTicks` means the wind-up is *free time* bolted onto the front of every
attack. Two bodies with the same delay swing at different rates because their
weapons wind up differently, which is exactly what spec 088 introduced
`attackDelayTicks` to stop.

**Attacking faster does not make the swing faster.** Nothing scales
`windupTicks`. A body on a short delay spends the same 0.8s drawing the bow and
the saving comes entirely out of the standing-still afterwards -- so at the fast
end the wind-up bar is most of the cycle, which is what `scripts/probe-windup.ts`
was written to look at and what it found.

This spec is the Heroes of Newerth model, which answers all three with one idea:
**the attack interval and the attack animation are two separate spans that start
at the same instant**, and the animation has a point partway through it where the
blow becomes real.

```
                         ATTACK INTERVAL
     |--------------------------------------------------|
     0                                                READY
     |
     |---------- WIND-UP ----------|
                                   X COMMIT
                                   |
                                   |---- BACKSWING ----|
                                   |
                                   + projectile launch / melee hit
```

Before `X`, walking away is a withdrawal: no hit, no arrow, cost refunded, no
cooldown. After `X`, walking away skips the backswing and nothing else -- the
blow has landed, the cooldown is running, and the next attack is still due at
`0 + interval`. Cancelling the backswing buys movement, never attacks per second.

## Shape

### The formula, in one module

`src/server/sim/attack-timing.ts`, pure, part of the deterministic core.

```ts
export interface AttackSpeedInputs {
  /** Additive flat attack speed. 0 is base, 100 is twice the rate. */
  readonly attackSpeed: number;
  /** Percent multipliers, 1 for none. Kept apart because they stack apart. */
  readonly attackSpeedMultiplier: number;
  readonly attackSpeedSlowMultiplier: number;
}

export function attackSpeedFactor(inputs: AttackSpeedInputs): number;

export interface AttackTiming {
  readonly factor: number;
  readonly intervalTicks: number;
  readonly attackPointTicks: number;
  readonly backswingTicks: number;
  readonly attacksPerSecond: number;
}

export function resolveAttackTiming(
  base: { baseAttackTimeTicks; baseAttackPointTicks; baseAttackBackswingTicks },
  inputs: AttackSpeedInputs,
  tickRate: number,
): AttackTiming;
```

```
factor   = (1 + attackSpeed / 100) * multiplier * slowMultiplier
interval = baseAttackTime / factor
point    = baseAttackPoint / factor
backswing= baseBackswing / factor
aps      = factor / baseAttackTime
```

Clamped on the factor, not on the result, so one bound governs both ends:
`MIN_ATTACK_SPEED_FACTOR`/`MAX_ATTACK_SPEED_FACTOR` derived from the interval
bounds spec 088 already chose (`MIN_ATTACK_DELAY_TICKS`, `MAX_ATTACK_DELAY_TICKS`).
A zero or negative factor is *never*, not *instantly*, and lands on the slow end.

### Where the numbers come from

BAT is the **unit's**, the attack point and backswing are the **ability's**.
That split is spec 088's, kept: how often a body may swing is a property of the
body, and how the swing is shaped is a property of what it is swinging.

- `EffectiveStats.baseAttackTimeTicks` replaces `attackDelayTicks`, which was
  the *resolved* interval and is now derived rather than stored -- there must be
  one authoritative definition of attack timing and a stored copy of a computed
  number is a second one.
- `EffectiveStats.attackSpeed`, `.attackSpeedMultiplier`,
  `.attackSpeedSlowMultiplier` are the three inputs, replicated.
- `AbilityDefinition.windupTicks` is re-read as the **base attack point**; a new
  `backswingTicks` beside it is the base backswing, defaulting to 0.

Attack speed scales a **basic attack only**. A Heavy Blow's wind-up is the
ability's statement about itself; the attack-speed stat is about attacking. A
non-basic ability therefore resolves to `factor: 1`, its own `windupTicks`, its
own `cooldownTicks`, and no backswing -- which is spec 068's rule, unchanged.

### The phase, and the boundary

`CastPhase.Backswing = 2` (the value was free between `Channel` and `Turning`).
`CastState` gains three fields:

```ts
readonly windupStartTick: number;   // when the attack point clock started
readonly committed: boolean;        // false until the attack point, true after
readonly timing: AttackTiming;      // snapshotted at the start, never recomputed
```

`windupStartTick` rather than `startedTick` because spec 065 turns the body
first: the attack does not *start* until the wind-up does, and the interval is
measured from there. The snapshot is what makes a buff that lands mid-swing
affect the next attack rather than teleporting this one.

The lifecycle:

```
startCast   -> Turning (aim captured, cost spent, no clock)
            -> Windup  (windupStartTick stamped, releaseTick = +point)
attack point-> COMMIT: cooldown stamped, blow resolved / projectile launched
            -> Backswing (rooted, cancellable, nothing left to undo)
end         -> free
```

Cooldown, for a basic attack, is stamped at the commit and reads
`windupStartTick + intervalTicks`. Stamped at the commit so a withdrawn wind-up
never stamps one at all -- spec 091's rule, preserved exactly. Read from the
start so the interval covers the wind-up -- the HoN rule, which is the one thing
091 gets wrong. A non-basic ability keeps 091 whole: `tick + cooldownTicks`.

The backswing is clamped so `release + backswing <= windupStart + interval`. A
body must never be animation-locked past the moment it may swing again, or the
backswing becomes the real cadence and the interval stops meaning anything.

### Two cancellations, named apart

```ts
export type CastCancelKind = 'none' | 'windup' | 'backswing';
export function cancelCast(entity, tick, reason): CancelResult; // { kind, ... }
```

One entry point, because every caller reaches it the same way -- a move order, an
`Esc`, a death -- and two implementations behind it, because the outcomes have
nothing in common:

- **`cancelWindup`** (`committed === false`): refund the cost, clear any
  cooldown, `castEnded` with `Cancelled`. **The attack did not happen.**
- **`cancelBackswing`** (`committed === true`): drop the cast, free the body,
  keep the cost, keep the cooldown, `castEnded` with the new
  `BackswingCancelled`. **The attack already happened; only the animation was
  skipped.**

A distinct end reason rather than a flag, because the client refunds its
predicted cooldown on anything that is not `Released` and must not refund this
one.

### The wire

`CastStateMessage` gains `startTick` -- the tick the wind-up began. The cast bar
derives the wind-up's length from `releaseTick - startTick` instead of reading
`ability.windupTicks` off the table, which is no longer the length when attack
speed has scaled it. The backswing draws from `releaseTick` to `endTick` and is
marked not-cancellable, meaning "withdrawing from this refunds nothing".

### Animation

`animationPlaybackRate = factor`, applied by the unit driver, so an authored clip
whose events sit at the base attack point still fires them at the scaled one. The
gameplay commit stays authoritative and the clip follows it -- `unit-driver.ts`
already takes replicated facts and returns machine commands, and this is one more
fact.

## Invariants tested

- The three worked examples: BAT 1.70 / point 0.40 / backswing 0.50 at attack
  speed 0, 100 and 200 give factor 1/2/3, interval 1.70/0.85/0.567, point
  0.40/0.20/0.133, backswing 0.50/0.25/0.167, APS 0.588/1.176/1.765.
- APS is linear in attack speed; interval is reciprocal.
- A factor driven to zero or negative clamps to the slow bound, never to a
  negative or infinite interval.
- Cancelling at 50% of the wind-up: no `hit`, no `attackMissed`, no projectile
  spawned, cost refunded, no cooldown stamped, `kind: 'windup'`.
- Cancelling on the tick *before* the release: same.
- Cancelling on the tick *after* the release: the hit still happened, the
  projectile still exists, the cooldown is unchanged, the body may move that
  same tick, `kind: 'backswing'`.
- A ranged attack's projectile survives the backswing being cancelled and hits.
- Spamming attack orders cannot produce attacks closer together than
  `intervalTicks`, measured over a long run.
- Cancelling every backswing over a long run produces the *same* number of
  attacks as never cancelling one.
- Raising attack speed shortens the interval, the wind-up and the backswing by
  the same factor.
- A stat change during a wind-up does not move that attack's release; the next
  attack uses the new stats.
- The backswing never outlasts the interval, for every ability in the table
  against every monster row.
- Same seed and same inputs replay to bit-identical state, with and without
  backswing cancellations in the sequence.

## Out of scope

- **Where a player's attack speed comes from.** Spec 091 took the cadence off
  the weapon deliberately, and `stats.test.ts` asserts it. This spec builds the
  socket and leaves it at zero for players; an item that grants attack speed is
  a content decision and gets its own spec. Monsters author BAT per row as they
  already do.
- Turn rate, and the `Turning` phase's own timing. Untouched.
- Backswing on non-basic abilities. Spec 068 removed recovery from casts and
  that stands; the column exists and every non-basic row leaves it at 0.
- Attack-cancel *animation blending*. The machine transitions out of the attack
  state as it already does when the cast ends; making that blend prettier is a
  presentation change.
- Command queueing. There is no input buffer here and this does not add one: an
  attack order during the cooldown is refused by `startCast` as it always was,
  and `target.ts` re-asks on the tick the cooldown expires.
