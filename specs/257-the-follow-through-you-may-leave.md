# 257 — The follow-through you may leave

## Problem

Agility's tree holds two ideas that eat each other. One half **shortens the
follow-through**: the attribute's own `backswingScale` (a reciprocal, 45% off at
the cap), Quick Recovery's `backswingReduction`, and `flowBackswingPct` on every
Flow stack. The other half **rewards walking out of it**: cancelling a backswing
is what grants Flow, and Mobile Offense exists to pay for that cancel. Every
point spent on the first half shrinks the window the second half is played in.

Spec 254 took apart the tightest loop of that -- Mobile Offense used to pay in
Flow, and Flow shortened the follow-through, so the reward for leaving one was a
shorter one -- and named the rest of it in passing: *"it shrank the window the
trigger is read in, since a shorter backswing is fewer ticks in which
`cancelBackswing` can be reached at all."* That window is what this spec is
about. Quick Recovery, `agi.flow` and the attribute itself were all still
shortening it.

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
  backswingCancelPer: 0.002,  // per point above the starting attribute
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
shipped maxima are 0.11 (attribute at the hard cap), 0.15 (Quick Recovery, 0.05
a tier) and 0.15 (Flow, three stacks at 0.05 each -- 0.02 from the Agility 20
milestone that grants Flow at all and 0.01 a tier from `agi.flow`) against the
0.45 between base and floor. That is 0.41 of it, so nothing in the tree is bought into a filled cap
and the floor is a guard rather than a shared ceiling -- and the two thirds a
player *buys* outweigh the third the attribute hands over, because controlling
commitment should be built toward rather than accrued.

On the shipped slash (24 ticks of follow-through) that reads:

| build | committed | may leave after | ticks freed |
|---|---|---|---|
| Agility 5, nothing | 70% | 17 ticks | 7 |
| Agility 60, nothing bought | 59% | 14 | 10 |
| Agility 60, Quick Recovery 3 | 44% | 11 | 13 |
| Agility 60, Quick Recovery 3, Flow 3, three stacks | 29% | 7 | 17 |

with `intervalTicks` at 72 in every row.

The client mirrors the rule rather than being told it: `ClientView.selfCommitted`
is true while the local body is inside the committed part of its follow-through,
`moveIntent` ranks it exactly where the stagger root sits, and the cancel tick is
recomputed from the *replicated* `releaseTick`, `endTick` and Flow stacks. Being
one tick late costs a tick; being one tick early costs a correction, so the
client is allowed to be late and never early.

Two client paths, not one, and the second is the worse failure. `sendInput`
must not predict the *walk*; `GameClient.cancelCast` -- the stop key -- must not
drop the *cast*, because a cast lives in this client's own map and arrives as an
event rather than in a delta, so nothing puts one back. Dropped early, the body
reads as free locally and walks against a rooted server for the whole rest of the
phase rather than for a round trip.

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
- Over a real loopback the client neither steps nor drops its cast inside the
  committed window, walks on the tick the cancel point is reached, and takes
  **zero** corrections doing it.
- Death and a guard break still take a body out of its follow-through inside the
  committed window.
- Perfect Exit still fires, and still reads the **wind-up**: it is unaffected by
  the backswing gate, and a backswing cancel never pays its resource.
- A replay of the same seed and inputs through a fight full of cancellations
  reaches identical state.

## Measured

`npx tsx scripts/probe-attack.ts --agility`, four builds at Agility 60, every
number off a real fight rather than off `attackTimingFor`:

```
  build                     swing  cancel@  left@  natural  freed   ready@
  nothing                      24       34     34       44     10      73
  quick recovery 3             24       31     31       44     13      73
  flow (3 stacks)              24       31     31       44     13      73
  quick recovery 3 + flow      24       27     27       44     17      73
```

Movement freedom 10t to 17t; the follow-through 24t and the next attack due on
tick 73 in every row. That is the whole claim of the spec in one table.

`npm run balance`'s Mobile Offense section, which walks out of every
follow-through and therefore now walks out of them at the cancel point:

```
  RANK   PER CX  CANCELS  TRIGGERS  CD SEC  USES/MIN  KILLS  DPS    ROOT%
  x0     0.00    19       0         0.0     28.00     4      5.5    73.3
  x1     1.54    19       19        29.2    32.00     5      6.5    77.2
  x2     2.78    19       19        52.8    36.00     5      6.7    82.6
  x3     4.26    17       17        72.4    42.00     6      7.9    85.5
```

Spec 254 measured 20 cancels and 89.2s at rank 3 with no cancel point in the
game. Every trigger still fires — a cancel that is legal is still a cancel —
and what moved is that the body spends longer in each follow-through before it
may leave, so slightly fewer swings fit around the abilities it is now pressing
40% more often. **Still flagged as strong and still deliberately not retuned**,
for spec 254's stated reason: the figure is large because one trigger pays every
cooling active ability, which is a structural property rather than a mis-set
constant.

## Out of scope

- Mobile Offense's reward. Spec 254 made it active-ability cooldown and this
  spec leaves it exactly there: only the *legality* of the trigger moves, and it
  moves in the direction 254 wanted -- that spec's own complaint was that the
  payout shrank the window the trigger is read in, and the window is now a fixed
  length that nothing in the tree can shorten.
- Perfect Exit's design. Audited against the new model and left alone.
- The wind-up. `attackPointScale` and `handlingScale` are untouched, so Agility
  still shortens how long a blow takes to land.
- Broad Agility rebalancing. The cancel-point curve is deliberately conservative
  and `scripts/probe-attack.ts --agility` is the instrument for retuning it.
