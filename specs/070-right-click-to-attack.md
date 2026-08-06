# 070 — Right-click to attack

## Problem

Attacking is bound to left-click, which fires the first hotbar ability at
whatever the cursor happens to be over. That has three problems. It is a
*direction* attack, so a swing is a cone that catches whatever is standing in
it rather than the thing you meant to hit. It is one press per blow, so a fight
is a click race rather than a positioning decision. And it does not know what
you are fighting: there is no target, so there is nothing to walk to, nothing to
keep swinging at, and nothing to stop swinging at when it dies.

This spec replaces it with the MOBA shape the wind-up design was always written
against: **right-click a unit to attack it**. The click sets a target; the
client walks into range and then swings, again and again, until the target is
dead or the order is replaced. Left-click is unbound. A hovered unit gets an
outline so it is clear what a click would pick.

How often those swings come is a *stat*, not a table constant — `attackSpeed` —
so a fast unit and a slow one attack at visibly different rates with the same
weapon.

## Shape

### The stat

```ts
// state/types.ts — EffectiveStats
/** Attacks per second, as a multiplier on the base cadence. 1 = unmodified. */
readonly attackSpeed: number;
```

`attackCooldownTicks` stays and becomes what its name says: the *base* interval
between swings, in ticks, with only flat modifiers on it. Dexterity's
contribution moves out of it and into `attackSpeed`, so the two never
double-count. Together:

```ts
// player/stats.ts
export const MIN_ATTACK_SPEED = 0.25;
export const MAX_ATTACK_SPEED = 3;

/** Ticks between one basic attack and the next, for these stats. */
export function attackIntervalTicks(stats: EffectiveStats): number;
//  = max(1, round(stats.attackCooldownTicks / stats.attackSpeed))
```

`StatModifier` gains `attackSpeed` (flat) and `attackSpeedPct`, so an item can
say "+20% attack speed" in the same currency as everything else.

The stat is on the wire (`writeStats`/`readStats`) because the client draws the
cooldown sweep against it; `PROTOCOL_VERSION` goes to 6.

### The basic attack

```ts
// data/abilities.ts — AbilityDefinition
/**
 * The weapon swing. Its cooldown comes from the caster's `attackSpeed`
 * rather than from `cooldownTicks`, which is what makes the stat mean
 * anything. Exactly one ability per unit is its basic attack.
 */
readonly basicAttack?: boolean;
```

`melee.slash` is flagged, and is what a right-click attack and a monster's
swing both use. Everything else keeps its table cooldown: a heavy blow is slow
because it *is* slow, not because you are.

### A cast that names its target

```ts
// sim/types.ts — CastState, CastAttempt, ServerInput
/** The entity this cast was aimed at, or 0 for an aim at a point. */
readonly targetEntityId: number;
```

Carried on `UseAbilityMessage` and `CastStateMessage` too. When a melee cast
carries a target id, it resolves against **that entity and nothing else**:
alive, hostile, and within `range + radius` of the caster *at the release*. A
bystander standing in the arc takes nothing; a target that walked out is a miss
(`attackMissed`), not a free hit. A melee cast with no target id keeps the cone
it has today, which is what the hotbar's direction-aimed abilities still use.

Nothing else about a cast changes: it is committed, the body turns into it
(spec 065), the wind-up runs, and it may be withdrawn from until it releases.

### The target, and the auto-attack

Client-side, and pure, in the same place and for the same reason `intent.ts`
is: a target is *input*. What it produces is a per-tick move vector and an
ability request, both of which the server validates exactly as it validates a
held key and a hotbar press. Routing it server-side would mean the client
either re-deriving the same path anyway or mispredicting every step of every
chase.

```ts
// render/iso3d/world/target.ts
export interface AutoAttackInput {
  readonly self: Point;
  readonly target: TargetSnapshot | null;
  /** The basic attack's reach, plus the target's body radius. */
  readonly reach: number;
  /** True while a cast is in progress -- a committed body does not re-commit. */
  readonly rooted: boolean;
  /** The tick the basic attack is ready again, from the server's table. */
  readonly readyAtTick: number;
  readonly tick: number;
}

export interface AutoAttack {
  /** Where to walk to close the gap, or null when there is nothing to close. */
  readonly chaseTo: Point | null;
  /** Ask to swing this tick. */
  readonly attack: boolean;
  /** The target is dead or gone: the view should forget it. */
  readonly drop: boolean;
}

export function autoAttack(input: AutoAttackInput): AutoAttack;
```

The chase point is on the line from the target back toward the player, at
`reach * STANDOFF_FRACTION` — the same standoff a monster keeps (`world.ts`),
so a chase stops at the edge of its reach instead of walking into the body it
is trying to hit.

### One tick of prediction, corrected

Falling out of the cadence change rather than aimed at, but real enough to name.
Spec 069's client judged "is this ability ready" at `estimated + roundTrip` and
stamped the cast it predicted for `estimated + commitDelay`. Those are different
quantities -- a request waits on the server's *input queue*, not on the wire, and
on a loopback that is three ticks while the round trip is zero -- so every
cooldown the client stamped ran from a tick later than the one it checked
against. It was invisible at a 36-tick swing and impossible to miss at
nineteen: a press the server took was drawn with no bar until `CastState`
arrived.

Both questions are now asked at the tick the server will commit on. Leaning past
it is worse than either, and the latency harness says so: the extra requests are
refused, and a refusal stamps a cooldown of its own that outlives the press it
came from and blocks the next real one.

### The clicks

| Input | Before | After |
|---|---|---|
| Left-click | swing `HOTBAR[0]` at the cursor | *nothing* |
| Right-click on a unit | move order to the ground under it | target it, chase, auto-attack |
| Right-click on ground | move order | move order, and forget the target |
| `1`..`7`, hotbar buttons | cast at the cursor | unchanged |
| `Esc` | cancel the wind-up | unchanged, and forgets the target |

Which unit a click picked is `pickHoveredUnit` from spec 041, which already
exists, is tested, and was never wired into the world view. The same pick
drives the hover outline (`attachOutline`, also already there) and a ring under
the current target.

## Invariants tested

- `attackSpeed` rises with dexterity and with `attackSpeed`/`attackSpeedPct`
  modifiers, and is clamped to `[MIN_ATTACK_SPEED, MAX_ATTACK_SPEED]`.
- `attackIntervalTicks` is never below 1 tick, and halves when `attackSpeed`
  doubles.
- A basic attack's cooldown is stamped from `attackIntervalTicks(stats)`, not
  from `ability.cooldownTicks`; a non-basic ability still uses the table. Two
  casters with different `attackSpeed` and the same ability get different
  cooldowns from the same `startCast`.
- A melee cast naming a target damages that target and *only* that target, with
  a second hostile standing well inside the same cone.
- A named target out of `range + radius` at the release takes no damage and the
  swing reports `attackMissed`.
- A named target that dies before the release is a miss, not a hit on a corpse.
- `autoAttack`: chases when out of reach and stops chasing when inside it;
  attacks only when in reach, not rooted, and off cooldown; drops a dead or
  missing target; asks for nothing at all with no target.
- The chase point is inside the target's reach and on the near side of it.
- `UseAbility` and `CastState` round-trip `targetEntityId` through the codec,
  and `EffectiveStats` round-trips `attackSpeed`.
- A monster swings at the player it is chasing by id, and its cadence follows
  its own `attackSpeed`.
- Determinism: the same seed and the same input sequence -- targeted casts
  included -- produce a bit-identical world.

## Out of scope

- **Server-side targeting.** The server never holds "who is this player
  attacking". It answers one request at a time, as it always has.
- **Tab-targeting, target-of-target, or a target frame.** The HUD gets one line
  of readout and a ring on the ground; a real target frame is its own change.
- **Attacking with anything but the basic attack.** Hotbar abilities stay
  cursor-aimed; auto-attacking does not queue or weave them.
- **Retaliation.** Being hit does not set a target for the player. Monsters
  keep the aggro rule they have.
- **Per-weapon attack speed tables.** `attackSpeed` is a stat, fed by dexterity
  and modifiers, and a weapon carries it the way it carries everything else --
  as a modifier. Two existing weapons say what they always meant in the new
  currency (the Keen Longsword's `attackCooldownTicks: -1` becomes
  `attackSpeedPct: 0.15`, the Iron Maul's `+4` becomes `-0.2`), because a flat
  tick off a base interval and a percentage of a cadence are different claims
  and only one of them survives the stat. No new weapons, and no table of
  per-weapon swing timers.
