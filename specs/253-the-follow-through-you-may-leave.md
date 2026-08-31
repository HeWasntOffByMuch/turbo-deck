# 253 — The follow-through you may leave

## Problem

Agility's tree holds two ideas that eat each other. One half **shortens the
follow-through**: the attribute's own `backswingScale` (a reciprocal, 45% off at
the cap), Quick Recovery's `backswingReduction`, and `flowBackswingPct` on every
Flow stack. The other half **rewards walking out of it**: cancelling a backswing
is what grants Flow, and Mobile Offense exists to pay for that cancel. Every
point spent on the first half shrinks the window the second half is played in.

Underneath both, the follow-through is not a phase at all. `cancelCast` branches
on `cast.committed` and `cancelBackswing` succeeds unconditionally, so a
committed swing may be walked out of on the very first tick after the attack
point. There is no cancel point, nothing to buy, and nothing to be good at:
"escape the follow-through" is already free and instant for everybody, and the
progression that claims to improve it only makes the phase it improves smaller.

So the follow-through becomes a real phase with two halves, and Agility buys the
boundary between them rather than the length of the whole:

```
attack point -> committed follow-through -> cancel legal -> natural end
```

**Agility controls commitment; it does not erase it.** The nominal backswing
stops moving with Agility at all, and every Agility source that used to shorten
it now moves the cancel point earlier instead.

## Shape

**One number, and it is a fraction.** How much of the follow-through must elapse
before a *voluntary* cancel is legal. A fraction rather than a count of ticks
because attack speed already scales the backswing, and a fraction is invariant
under that scaling -- the same rule at every attack speed, with nothing to
re-derive.

`data/scaling.ts`, replacing `backswingPer`/`backswingFloor`:

```ts
agility: {
  backswingCancelBase: 0.7,   // committed, with no Agility at all
  backswingCancelPer: 0.003,  // per point above the starting attribute
  backswingCancelFloor: 0.25, // never less committed than this
}
```

`data/modifiers.ts` — `backswingReduction` and `flowBackswingPct` become:

```ts
readonly backswingCancelReduction?: number;   // sums; subtracted from the base
readonly flowBackswingCancelPct?: number;     // sums; subtracted per Flow stack
```

`state/types.ts` — `TraitStats.backswingScale` and `TraitStats.flowBackswingPct`
become `backswingCancelPct` and `flowBackswingCancelPct`, **in place** in
`TRAIT_WIRE_ORDER`, so the wire layout does not move.

`sim/attack-timing.ts` — the cancel point joins the numbers an attack runs on:

```ts
interface AttackTimingBase { …; readonly backswingCancelPct?: number }
interface AttackTiming    { …; readonly backswingCancelTicks: number }

/** Ticks of follow-through that must elapse before a voluntary cancel. */
export function backswingCancelTicksFrom(backswingTicks: number, pct: number): number;
```

`sim/abilities.ts`:

```ts
/** The resolved threshold: base, less Agility, less Quick Recovery, less Flow. */
export function backswingCancelPointOf(traits: TraitStats, flowStacks: number): number;
export function backswingCancelPointFor(entity: TimingSubject, tick: number): number;
/** Whether this body may walk out of what it has committed to, at `tick`. */
export function mayCancelBackswing(cast: CastState, tick: number): boolean;
```

`cancelCast` gains one gate and nothing else: a cast past the attack point whose
cancel point has not been reached is **refused** -- `cancelled: false`, `kind:
'none'` -- unless the reason is `Interrupted`. Death and a guard break come
through as `Interrupted` and are unaffected; so is a channel and any ability
with no follow-through, whose cancel tick is zero.

The threshold is resolved once, at the commit, into `cast.timing` -- beside the
interval, the attack point and the backswing, and for their reason: a buff
landing mid-swing belongs to the next attack. Flow gained by a cancel therefore
pays for the *next* follow-through, which is the loop the tree describes.

**Stacking**, subtractive and stated once:

```
effective = clamp(base
                  - above(agility) * backswingCancelPer
                  - backswingCancelReduction
                  - flowStacks * flowBackswingCancelPct,
                  floor, base)
```

The first two land on `TraitStats.backswingCancelPct` because they are what the
character *is*; Flow is a status, so it is applied where the swing is timed. The
shipped maxima are 0.165 (attribute), 0.09 (Quick Recovery, three tiers) and
0.15 (Flow, three stacks at 0.05 each) against a 0.45 budget, so nothing in the
tree is bought into a filled cap and the floor is a guard rather than a shared
ceiling.

The client mirrors the rule rather than being told it: `ClientView.selfCommitted`
is true while the local body is inside the committed part of its follow-through,
`moveIntent` ranks it exactly where the stagger root sits, and the cancel tick is
recomputed from the *replicated* `releaseTick`, `endTick` and Flow stacks. Being
one tick late costs a tick; being one tick early costs a correction, so the
client is allowed to be late and never early.

## Invariants tested

- A committed follow-through cannot be voluntarily cancelled before its cancel
  point, and can be on the tick it is reached.
- Quick Recovery moves the cancel point earlier, and each tier moves it further.
- Flow moves the cancel point earlier, stacks with Quick Recovery by
  subtraction, and the total is clamped at the floor.
- The **natural** backswing length is identical with and without Quick Recovery,
  with and without Flow, and at every value of Agility.
- The next basic attack is ready on the same tick whether the follow-through ran
  to its natural end or was cancelled at the earliest legal tick.
- Attacks per second are unchanged by Quick Recovery, by Flow, and by the two
  together, at every Agility value.
- A refused (too-early) cancel grants no Flow, so it cannot trigger Mobile
  Offense; a legal one does.
- Death and a guard break still take a body out of its follow-through inside the
  committed window.
- Perfect Exit still fires, and still reads the **wind-up**: it is unaffected by
  the backswing gate, and a backswing cancel never pays its resource.
- A replay of the same seed and inputs through a fight full of cancellations
  reaches identical state.

## Out of scope

- Mobile Offense's own reward. Its trigger is the cancel and stays there; what
  it grants (Flow duration, and Flow's own worth) is not retuned here.
- Perfect Exit's design. Audited against the new model and left alone.
- The wind-up. `attackPointScale` and `handlingScale` are untouched, so Agility
  still shortens how long a blow takes to land.
- Broad Agility rebalancing. The cancel-point curve is deliberately conservative
  and `scripts/probe-attack.ts --agility` is the instrument for retuning it.
