# 091 — A cooldown the blow pays for

## Problem

Reported: *"the wind-up triggers the attack cooldown; it shouldn't. Only a
legitimate attack that went off — a projectile shot, a melee hit — should put
attacking on cooldown. And that cooldown should be independent of the weapon
too."*

Two things, both true of the code as it stood.

1. **The cooldown was stamped at the commit.** Spec 062 did that deliberately,
   so that a cast cancelled at the last moment was not strictly better than not
   casting at all. But the refund in `cancelCast` was already doing that job:
   the cost comes back, and what a withdrawal costs is the time it took. So all
   the early stamp bought was a cooldown that had to be handed back again — and
   in the meantime, a wind-up you withdrew from greyed the button out for a
   swing that never happened, and announced a cooldown over the wire that was
   then withdrawn a tick or two later.

2. **The attack cadence was still a weapon's number.** Spec 088 collapsed attack
   speed to a flat 1.2s delay but left the modifiers applying, and the two paths
   into `attackDelayTicks` were the equipped weapon's `attackSpeedPct` and the
   flat `attackCooldownTicks` from skills. So a bow put you on a different clock
   from a sword, and picking one up bought a faster one. The user's answer to
   spec 088's question — "1.2s is the baseline, modifiers still apply" — is
   reversed here for the weapon half, and the skill half goes with it: the
   cadence is a property of *attacking*, not of what the body is holding.

## Shape

### The cooldown moves to the release

`startCast` no longer writes `cooldowns`. `advanceCast`'s release branch — the
one place a blow actually goes off, for a melee arc, a projectile launch or the
first pulse of a channel — stamps it:

```ts
// abilities.ts, in the Windup -> release branch and nowhere else
cooldowns: { ...caster.cooldowns, [ability.id]: tick + cooldownTicksFor(ability, caster) },
```

A cast that is withdrawn from never reaches that branch, which is the whole
point. `cancelCast` keeps refunding the cost and keeps clearing any cooldown
entry it finds, because clearing an entry that was never written is a no-op and
the alternative is a second rule to remember.

The client mirror predicts the same shape, from the release rather than the
commit:

```ts
// client/combat.ts
readyAtTick: stampAt + ability.windupTicks + cooldownTicksFor(ability, entity),
```

`stampAt` is the cast's `startedTick`, so this is the same arithmetic the server
will do, one wind-up later.

The visible consequence, and it is intended: the gap between two loosed shots is
now `attackDelayTicks + windupTicks`, not `attackDelayTicks`. The delay is the
wait between a shot and the *start* of the next draw. That is what "the cooldown
starts when the blow goes off" means, and it is the reading the report asks for.

### The cadence stops reading the weapon

```ts
// player/stats.ts
const attackDelayTicks = attackDelayTicksFrom(0, 1);
```

Flat, and derived from nothing. `attackSpeedPct` and the flat
`attackCooldownTicks` still exist as stats and still mean what they say —
nothing reads them for this any more, which is why `finesse.precision` and
`finesse.flurry` no longer shorten the cadence. They are left in place rather
than deleted because the fields are wire-visible and a stat that means something
somewhere else is not this spec's business.

## Invariants tested

- **A commit stamps no cooldown.** Mid-wind-up, the entity's `cooldowns` has no
  entry for the ability being wound up, on the server and in the client's view.
- **A withdrawal announces none either.** Commit, cancel, and the entry is
  undefined throughout — not written then withdrawn. This is the whole claim, so
  it is pinned on both sides of the wire.
- **The release stamps it**, at `releaseTick + cooldownTicksFor(...)`: the basic
  attack from the caster's own delay, everything else from the ability table.
  Two casters with different delays swinging on the same tick differ by exactly
  the difference in their delays, because they share a release.
- **The client's prediction matches**: `readyAtTick` is
  `startedTick + windupTicks + delay`, so the button greys at the same moment on
  both ends rather than a wind-up early.
- **The cadence is the same for every weapon and every skill**: `attackDelayTicks`
  is the 1.2s baseline for a bare body, for a body holding a bow, and for one
  that has taken both Finesse skills.
- **Two shots from a body that had to turn 180 degrees** (spec 090's harness)
  still pay for the turn once, and the interval between the two loosed shots is
  now the delay plus one wind-up, with no pause in front of either.

## Out of scope

- **Retuning the 1.2s.** The number is spec 088's and stands; this changes what
  the clock is attached to and what may modify it, not how long it is.
- **The global-cooldown question.** Cooldowns are still per-ability: two
  different abilities do not share a clock, and nothing here makes attacking and
  casting one budget.
- **Deleting `attackSpeedPct` and `attackCooldownTicks`.** They stay as stats,
  unread by the cadence. Removing them is a data and wire change with no user
  behind it.
- **The wind-up bar reading roughly half when the shot goes off.** Reported
  alongside this and not reproduced by any harness here — measured on a loopback
  the bar is one tick short of full at the loose. It is a separate defect and
  wants a separate measurement.
