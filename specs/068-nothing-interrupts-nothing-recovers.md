# 068 — A blow you commit to lands, and frees you when it does

## Problem

Two rules either side of the release tick get in the way of the fight spec 062
set out to build, and both were felt in play rather than read off the code.

1. **Being hit cancels the cast.** `applyDamage` clears the target's `cast` and
   announces `CastEndReason.Interrupted`. Spec 065 kept this deliberately when it
   removed the hitstop the rule used to be keyed on — but it also added the
   `Turning` phase, and the interrupt covers that too. So the whole readable
   commitment, the turn *and* the wind-up, is erased by any hit that lands during
   it. Committing to a blow is the decision the game is built on; a monster
   chipping at you deletes the decision rather than making it cost something.

2. **The cast keeps rooting you after the blow has landed.** A release drops into
   `CastPhase.Recovery` and the caster stays rooted until `endTick`, with the bar
   still drawn and draining. That is a body lock, distinct from the ability's
   cooldown, and it is not wanted right now: once the swing has gone off the
   character should be free.

The result should be that a cast, once begun, runs to its release regardless of
what happens to the caster, and ends *at* its release.

## Shape

### Nothing interrupts a cast

`applyDamage` (`src/server/sim/abilities.ts`) stops clearing `cast` and stops
emitting `castEnded`. Health, aggro (`targetId`) and the `hit` event are
unchanged.

The one case that still drops a cast is **death** — a corpse may not go on
swinging — and it is still announced, because a client roots itself while it
believes it is casting and a silently dropped cast strands it:

```ts
if (killed && target.cast) events.push({ kind: 'castEnded', …, reason: Interrupted });
```

`CastEndReason.Interrupted` therefore survives, with death as its only source.
The two ways a player ends a cast, cancelling and releasing, are untouched.

### Recovery goes

The phase is removed, not zeroed — a phase that can never be entered is worse
than no phase:

- `AbilityDefinition.recoveryTicks` is removed, and `totalCastTicks` becomes
  `windupTicks + channel`. The seven abilities lose the field.
- `CastPhase.Recovery` / `CastPhaseValue.Recovery` and `ActivityValue.Recovering`
  / `EntityActivity.Recovering` are removed. The remaining members keep their
  numbers, and no message's byte layout changes, so `PROTOCOL_VERSION` stays 4.
- `advanceCast` ends a non-channel cast **on its release tick**: `cast: null`,
  activity `Idle`, one `castEnded(Released)`. A channel still runs its pulses and
  ends when they are done.
- `castBar` (`src/render/iso3d/world/cast.ts`) loses its recovery branch; the
  bar now describes turning, wind-up and channel only.

`CastState.endTick` stays — for a channel it is the end of the pulses; for
everything else it now equals `releaseTick`.

## Invariants tested

- **A hit does not stop a cast.** A caster struck mid-wind-up still holds its
  cast, still releases on the tick it would have, and still lands its damage; the
  same holds for a hit during the `Turning` phase, and the aim it committed to is
  unchanged by the hit.
- **Death still ends a cast**, and says so with `Interrupted`.
- **A cast ends at its release.** `melee.slash` reports `Windup` and then nothing
  else, emits exactly one `castEnded(Released)` on the release tick, and the
  caster's `cast` is null from that tick on.
- **The caster moves again the tick after the blow lands** — rooted through the
  turn and the wind-up, free immediately after.
- **A channel is unaffected** up to its end: wind-up, channel, pulses, then over.
- Cancelling during the turn or the wind-up still refunds cost and cooldown.
- The same `(seed, inputs)` still replays to bit-identical state and events.

## Out of scope

- **Cooldowns.** `ability.cooldownTicks` is how often a blow may be thrown and
  stays exactly as it is; this removes the character lock, not the pacing.
- **Retuning wind-ups.** No `windupTicks` moves: what a blow costs in time before
  it lands is the readable half of committing, and it is the half being kept.
- **Bringing interruption back as its own mechanic.** If some abilities should
  break a cast later, that is a property of the ability that does it, not a rule
  every hit obeys.
