# 254 — Mobile Offense buys cooldown, not less follow-through

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

## Follow-up: the bar says so

Shipped, the mechanic had **no feedback at all**, and that was a regression
rather than an omission. The reward it replaced was a Flow stack, and Flow has a
row in `data/status-visuals.ts` — so a successful cancel used to put a mark over
the player's head, and the first playtest of this change was somebody correctly
reporting that a working feature did nothing. Cooldown coming off a *different*
button from the one that earned it is the least visible thing this game hands
out: a sweep the player is not looking at, moving by a fraction of a second,
mid-swing.

**The client derives it; nothing was added to the protocol.** The server never
says "1.2s came off Arc Lash" — it sends the owner their whole cooldown table
whenever it changes, so a refund is the *difference* between two of them
(`client/cooldown-refund.ts`), which is the shape `world/xp-gain.ts` already is
and for its reason. Two consequences worth stating: it reports whatever actually
happened, so Strength's `breakCooldownRefund` gets the same mark with no second
case; and the diff must be taken against the **server-confirmed** table, never
`visibleCooldowns()`, whose predictions are retired by dropping away — which is
itself a decrease that nothing refunded.

What is drawn, per affected slot: a `success` frame, in the same register as the
`aimed`/`casting`/`unaffordable` frames the slot already carries, and the amount
floating off it (`-1.2`). Four things about the label were forced rather than
chosen:

- **It is written the way the slot already writes seconds** — `toFixed(1)` under
  ten, whole at or above, no unit — because the number saying how much came off
  and the number saying how much is left sit on the same square.
- That rule **bounds it to four characters**, 23 font pixels against the 24 of
  slot-plus-gap at the bar's smallest size. The ordinary case is several marks at
  once, since one cancel pays every cooling ability, so a fifth character would
  print into the neighbour.
- The numeric face is uppercase-only, so `-1.2s` would draw the `s` as a **solid
  block**. Asserted with `isDrawable`.
- Its life is **the damage number's own** (`NUMBER_LIFE`, 800ms) rather than a
  number picked here, since it is the same kind of thing one layer over. A test
  asserts the two agree across the layer boundary.

`MOTION`'s existing rule — every animation under a quarter second, or it reads as
a wait rather than as a response — is **split rather than loosened**: it is a
rule about the interface *answering* something, and nothing waits on a notice.
`RESPONSE_TIMINGS` and `NOTICE_TIMINGS` are asserted to cover `MOTION` exactly,
so a timing added later has to be classified rather than escape both checks.

## ...and the mark had to be told to move

Reported as *the label is still not rising, it just appears high above the skill
bar* — and both halves of that sentence were the same fault seen from either end.

The travel was **one slot side**, which is right in spirit and wrong in fact: the
bar states its size in *physical* pixels (`ACTION_SLOT_CSS`, 46) and converts
through the interface scale, so a shipped slot is **20 to 23 UI pixels** where
the gallery — which applies no scale — draws the full 46. Twenty pixels over
800ms is a quarter of a pixel a frame at 60fps, and sub-pixel-per-frame motion is
not slow motion, it is no motion: the label appears somewhere and sits there. The
golden looked right for the same reason the bug shipped.

Two changes, neither of them taste:

- **Linear**, because a decelerating float reads as having arrived and then
  creeping. The other three `MOTION` entries ease out because each is *arriving*
  somewhere; `world/damage-popup.ts` rises its numbers at a constant rate, and
  this is the same object one layer over.
- **A floor on the travel, derived**: one whole pixel per frame for the whole
  life, `durationMs / 1000 * 60`. A bigger slot still gets a bigger rise.

The test that would have caught it is not "it ends higher than it started" —
the broken version satisfied that. It is that **every frame moves it**, sampled
at 60fps across the whole life, at the smallest slot the bar is ever drawn at.

## ...and the helper was the wrong one

Reported a third time: *it sits even higher now and doesn't move — there's
something fundamentally wrong with your approach*. Which was right, and the
fault was one line.

`animate()` snaps to `tween.to` under reduce-motion, and that is correct for
every caller it had: a window, a modal and a meter are all **arriving**
somewhere, so the end of the tween is the resting state and jumping to it is the
same picture without the travel. **A float has no resting state.** The end of its
journey is where it disappears, so snapping parks the label at the far end of a
trip it never took — as distant from the slot it is about as the animation ever
gets, and static there for its whole life. Raising the travel to fix "it doesn't
move" therefore moved it *further away*, which is exactly what the third report
says.

`drift()` is `animate()` for something that floats: same value while motion is
full, holds its **start** when motion is reduced. So a reduced client sees the
mark where a full one sees it on the frame it lands — beside its slot, legible,
and not travelling, which is what was asked for. The rule lives beside the motion
table so the next float finds it, and `motion.test.ts` pins the difference.

The three visual reports on this feature share one shape, and it is worth naming:
each was true of a headless assertion or an unscaled golden and false of the
shipped page — the number masked by a prediction, the travel measured on a slot
twice the size the game draws, the snap taken by a preference no test had set. So
the mount now publishes `data-ui-refunds`: the motion preference the interface is
honouring, and how far each live mark has actually travelled. Not the mark's
start — a start plus a promise that it animates is precisely what was true while
it did not.

## The guess is a floor, and deleting it took the floor out

The first fix for the masked number retired the guess outright on a refund, and
that was wrong for a reason nothing in the code names: **the guess is doing a
second job.**

`GameClient.estimated` deliberately runs `oneWayTicks()` ahead of the server, so
that an input *arrives* on the tick it was predicted for. But `readyAtTick` on
the wire is in the **server's** frame. So every "am I off cooldown yet" this
client asks — `autoAttack`'s, and the aim's — compares a server tick against a
clock running in front of it, and would ask early by the one-way latency every
single time. What stops it is the guess: it is computed in the client's own
frame, sits exactly that far above the server's stamp, and `visibleCooldowns`
taking the max of the two is the compensation. Delete it and the floor goes too;
the next ask is early and comes back `onCooldown`.

So a refund **moves** the guess instead: the server took a known span off this
cooldown, so the same instant expressed in this client's clock comes down by the
same span. The reduction stops being hidden and the guard is untouched.

The test had to move with it. `expect(shown).toBe(after)` was the wrong claim —
the bar legitimately sits a tick above the truth, because that lead is the guard.
What it must do is come *down by the refund*, and never below the server's own
number: the overlay may push a cooldown later and must never light a button
early.

## The bug the feedback uncovered

Drawing the mark made a second report possible — *the number on the button does
not change* — and that one was real, older than this spec, and had been invisible
because nothing in the game could previously make a cooldown go **down**.

`visibleCooldowns()` raises the server's table by what this client has spent and
not yet been told about, and retires a guess once the server has caught up with
it. It tested that by comparing the two **values** (`entry.readyAtTick >=
predicted.readyAtTick`), which is wrong by a tick whenever the client's lookahead
and the tick the server actually committed on differ at all — and a guess one
tick *above* the truth is never retired, so `max(server, guess)` goes on
returning it and everything the server says about that ability afterwards is
masked.

Harmless while the server could only raise a cooldown: the button greyed out a
tick long and nobody could see it. Not harmless once one can come down. Measured
over a **zero-latency loopback** — the case nobody would think to check — the
refund landed correctly on the server, the mark was drawn, and the number on the
button sat **1.22s behind the truth** for the rest of the cooldown:

```
delay  0t: server=646 client=719   the bar is 1.22s behind
delay  3t: server=669 client=669   0.00s
delay  6t: server=693 client=693   0.00s
```

**The obvious repair is wrong, and the suite said so.** Retiring the guess when
the server has stamped *anything* for that cast (`> predicted.fromTick`) is what
the rule reads as though it means, and it fixes the masking — and it also takes
`combat-latency.test.ts`'s bars-without-commits gap from one to **eleven** over a
run. The value comparison is load-bearing by accident: keeping a guess that is a
tick above the truth alive for that tick is what stops a press landing on the
boundary of an expiring cooldown from being predicted and then refused, which is
a bar that flashes and goes. Fixing the masking that way trades a stale number
for eleven phantom swings.

So the value rule stays exactly as it was, and a **refund retires the guess
outright** as a narrow exception ahead of it — the one case where the server has
said something strictly *newer* than the guess rather than merely caught up with
it. `mobile-offense-session.test.ts` sweeps the latency, because one point of it
is not evidence about the others: the version that shipped passed at 3, 6 and 12
ticks and failed only at 0.

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
