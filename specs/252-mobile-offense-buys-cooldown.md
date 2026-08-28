# 252 — Mobile Offense buys cooldown, not less follow-through

## Problem

Mobile Offense's loop is a circle:

```
cancel the backswing  ->  gain Flow  ->  Flow shortens the backswing
```

The player has *already* left the follow-through by the time the reward lands,
so what it pays out is the thing they just declined to spend. Worse, the payout
shrinks the window the trigger is read in: the backswing is what
`cancelBackswing` is called out of, so a shorter one is fewer ticks in which the
mechanic can fire at all. A reward that makes its own trigger rarer is a reward
pointed the wrong way.

The trigger is right and stays exactly as it is — walking out of a
follow-through is the one action this system rewards for its own sake, it costs
nothing mechanically, it demands attention to a phase boundary, and spec 144
guarantees it can never buy attacks per second. Only the payout changes.

## Shape

One trait, one tuning row, one write in the one place the mechanic already
fires.

```ts
// data/scaling.ts, under `agility`
/** Cooldown one tier of Mobile Offense takes off, per follow-through left. */
mobileOffenseCooldownTicks: seconds(0.4),

// data/modifiers.ts + state/types.ts
/** Ticks of active-ability cooldown a backswing cancel removes. Summed. */
readonly mobileOffenseCooldownTicks: number;

// sim/abilities.ts -- inside cancelBackswing, the non-Interrupted branch
function refundSkillCooldowns(
  entity: ServerEntity,
  tick: number,
): { cooldowns: Readonly<Record<string, number>>; refunds: CooldownRefund[] };
```

`agi.mobileOffense` grants `mobileOffenseCooldownTicks` per tier and no longer
grants `flowTicks` or `flowBackswingPct`; the Agility 35 milestone that deepens
it grants one more tier's worth of the same number instead of more Flow
backswing. Tier 1 is 0.4s, tier 2 0.8s, tier 3 1.2s, all of them the one
constant times the tiers held.

**What is reduced.** Entries in `entity.cooldowns` whose ability is
`skill: true` — the four equipped active abilities, which is what "active
ability" already means in this game (`skillAbilityIds`, `activeSkillId`, the
four `skill1..skill4` slots). Two exclusions, both deliberate:

- a **basic attack** stamps its interval into the same map (`nextReadyTick`
  runs it from the wind-up's start), so touching it would move the cadence —
  the one thing spec 144 says animation cancelling may never buy;
- the **flask** is paced by charges as well as by its cooldown, and its whole
  design is insurance that runs out. The smallest coherent rule leaves a
  charge model alone rather than accelerating half of it.

Only entries with `readyAt > tick` are touched, the new value is floored at
`tick` (ready now, never earlier), and a cancel that moves nothing returns the
**same map object** so the replication path (`server.ts` compares
`entity.cooldowns` by identity) stays silent.

Instrumentation is a sim event in the register `restoration` already occupies —
pure, read by nobody in the sim, there so a designer can inspect the derivation
rather than only the total:

```ts
| {
    readonly kind: 'cooldownRefunded';
    readonly entityId: number;
    /** What paid for it. `mobileOffense` is the only source today. */
    readonly source: string;
    /** Total ticks removed across every ability. */
    readonly ticks: number;
    readonly abilities: readonly { readonly abilityId: string; readonly ticks: number }[];
  }
```

`BuildMetrics` gains `mobileOffenseTriggers`, `cooldownTicksRefunded` and
`cooldownRefundedByAbility`; `BuildSummary` gains `cooldownSecondsRefunded` and
`activeAbilityUsesPerMinute`. `npm run balance` grows a Mobile Offense section
that fights one Agility build at ranks 0/1/2/3 with a policy that walks out of
its follow-throughs, which is the only way the trigger fires at all — the
twelve-build table stands still and never cancels anything.

## Invariants tested

- A deliberate backswing cancel with tiers held reduces every cooling-down
  active ability; tier 1 removes exactly 0.4s, tier 2 0.8s, tier 3 1.2s.
- Several active abilities cooling at once are all reduced, by the same amount.
- An ability already ready is left exactly as it is, and a cancel that changes
  nothing returns the identical cooldown map.
- A cooldown shorter than the reduction lands at the current tick and never
  below it; the ability is castable on the next tick and no earlier.
- The basic attack's entry is never touched, and the attack interval, wind-up,
  attack point and backswing are byte-identical with and without the trait.
- The flask's cooldown and charges are untouched.
- Nothing fires without the trait, nothing fires on a wind-up cancel, nothing
  fires on an interrupt (death, a poise break), nothing fires on ordinary
  movement with no cast running.
- No status duration and no other server timer moves.
- The reduction happens inside `step`, from the server's own entity: a client
  saying it cancelled cannot produce one.
- Flow is still granted by the same cancel where the character has `flowTicks`,
  and Flow's backswing reduction still works from its remaining sources.

## Measured

`npm run balance`, one Agility-25 spread at ranks 0/1/2/3, walking out of every
follow-through, 30s against a ravager, four sigils on 8-12s cooldowns:

```
  RANK   PER CX  CANCELS  TRIGGERS  CD SEC  USES/MIN  KILLS  DPS
  x0     0.00    20       0         0.0     28.00     4      5.5
  x1     1.52    20       20        30.3    32.00     5      6.6
  x2     2.93    20       20        58.5    40.00     5      6.9
  x3     4.46    20       20        89.2    46.00     6      8.1
```

**Flagged as strong, and deliberately not retuned here.** Rank 3 removes 89
seconds of cooldown from a 30-second fight — three times real time — and presses
an active ability **1.64x** as often as rank 0, for three points. The reason the
figure is that large is structural rather than a mis-set constant: one trigger
pays *every* cooling active ability, so the value of a tier is multiplied by how
many actives the character is carrying, and four is the maximum the game allows.
Read `PER CX` for the honest per-trigger figure (4.46s of 4.8s offered, the rest
clamped away) and `USES/MIN` for what any of it was worth.

The three obvious levers, in the order they should be considered, are all
deliberately left for a spec with playtesting behind it: an internal cooldown on
the trigger, paying only the *longest*-cooling ability rather than all of them,
or a smaller constant. None is a correctness fix — the mechanic clamps, cannot
go negative, and cannot touch the cadence — so changing the number now would be
tuning against a harness rather than against a game.

## Out of scope

- **No replacement Flow mechanic.** Flow keeps the backswing reduction it has,
  because Mobile Offense is no longer a source of it and two other purchases
  are: the Agility 20 milestone that introduces Flow, and the `agi.flow`
  specialization whose entire payoff it is. Removing it would leave the Flow
  status with no live effect at all and gut a purchasable, and inventing a new
  one is explicitly not this spec's job.
- No rebalance of the 0.4s. The instrumentation exists to say whether it is
  extreme; changing it is a later, separate decision.
- `breakCooldownRefund` (Strength's break refund) is untouched, including the
  fact that it reduces the basic attack's entry too.
- No wire change. The reduced cooldowns already replicate through the owner's
  cooldown message; the new event is server-side instrumentation only.
