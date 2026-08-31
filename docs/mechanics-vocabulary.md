# Mechanics vocabulary and the Technical Description standard

**Status: Current rule.** Every player-facing string describing a mechanic is
written to this document. New skills, sigils, statuses and items are reviewed
against it.

The principle underneath all of it: **the interface exposes the game's actual
rules rather than requiring players to reverse-engineer them.**

When two of these fight, the earlier one wins:

1. Mechanical accuracy
2. Consistency
3. Unambiguity
4. Scanability
5. Brevity

Brevity is last. A description that is short and slightly wrong is worse than
one that is long and right, because a player builds a plan on it.

---

## Part 1 — The controlled vocabulary

The rule that governs this list: **one term per concept.** Two words for one
mechanic is two mechanics as far as a player is concerned, and a player who has
learned that Guard is a pool has to unlearn it the moment something calls it
poise. Every term below names the code that owns it, so a description and the
sim cannot mean different things by the same word.

Terms are given as: what it means · when to use it · what it must not be swapped
with · an example.

### 1.1 Skills and abilities

| Term | Meaning |
|---|---|
| **Ability** | Anything cast from `data/abilities.ts`. The umbrella term. Covers basic attacks, skills and the flask. |
| **Basic attack** | The ability a weapon swings with — the row carrying `basicAttack: true`. Its interval comes from Base Attack Time, not from its cooldown. |
| **Skill** | An ability carrying `skill: true`, castable only from an equipped skill slot. |
| **Sigil** | The *item* that carries a skill (`ItemDefinition.activeSkillId`). The sigil is the object; the skill is what it does. |
| **Cast** | The whole act, from committing to being free again. |
| **Wind-up** | The rooted window between committing and the effect landing (`windupTicks`). |
| **Attack point** | The instant the effect lands, at the end of the wind-up. |
| **Backswing** | The rooted follow-through after the attack point (`backswingTicks`). |
| **Cancel point** | The tick within the backswing from which it may be broken off (spec 256, `backswingCancelTicks`). Before it the body is committed; the length of the backswing itself is not something progression moves. |
| **Withdraw** | Cancelling during the wind-up. Everything is refunded and the ability did not happen. |
| **Break off** | Cancelling during the backswing, from the cancel point on. Nothing is refunded, because the blow already landed. |

**Do not use:** *spell*, *power*, *move*, *technique*, *attack* (as a noun for an
ability), *animation cancel*, *cast time* (say wind-up), *recovery* (say
backswing), *interrupt* for the caster's own choice (that is withdrawing; an
interrupt is something done **to** you).

**Withdraw and break off are never interchangeable.** They are two different
outcomes either side of the attack point: one refunds, one does not. This is the
decision the game is built on and the words have to keep it apart.

> Guard Break — `Withdraw during the wind-up to refund the cost.`

### 1.2 Damage and healing

| Term | Meaning |
|---|---|
| **Damage** | Health removed. Always a number, never a rating. |
| **Deals X damage** | The only form. Never *does*, *inflicts*, *causes*. |
| **Heals X** | Health restored, capped at maximum. |
| **Overheal** | Healing past maximum. Discarded unless a trait converts it. |
| **Shield** | A separate pool absorbed before health (`shield`, `shieldUntilTick`). Not armour and not healing. |
| **Armour** | A fraction of incoming damage removed (`armor`). Always shown as a percentage. |
| **Critical hit** | A damage multiplier rolled on every blow, before anything else. |
| **Weak point** | Perception's separate roll, which also applies Exposed. |

**Do not use:** *DPS*, *hitpoints*/*HP* (say health), *mitigation*, *absorb* for
armour, *DoT*, *damage over time* as a noun, *tick* for a pulse. Nothing in this
game heals over time; if something ever does, it is written
`Heals X every Ys, N times.`

**Damage over time is an affliction**, and it is written as a rate, a cadence
and a count: `Deals 4.5 damage every 0.5s, 8 times.` The count rather than a
span, because a span is `pulses * interval` **plus one tick** — slack so the last
pulse lands inside the expiry comparison — and reporting that reads out an
implementation guard as though a designer had chosen 4.02 seconds. The total is
worth stating beside it (`36 damage in total over 4s`), because the total is what
a player actually compares, and it is derived through the sim's own
`dotTotalDamage` so an escalating affliction is not reported as `pulse × pulses`.

**Damage and healing are never one term with a sign.** Internally a negative
damage heals; a player is never shown that. A heal says *Heals*.

**Shield is never called healing**, because it expires and healing does not.

> Mend — `Heals 60.`
> Whirlwind — `Deals 28 damage to up to 6 enemies within 160.`

### 1.3 Buffs, debuffs and status effects

There is **one** word: **status**. A status is a named, timed condition on a
body, held in `sim/statuses.ts` and shown by `data/status-visuals.ts`.

| Term | Meaning |
|---|---|
| **Status** | The category. Every timed condition is one. |
| **Boon** | A status that helps the body carrying it. |
| **Affliction** | A status that hurts the body carrying it. |
| **Applies X** | Puts status X on a body. |
| **Removes X** | Takes status X off a body. |

**Do not use:** *buff*, *debuff*, *DoT*, *HoT*, *aura*, *effect* (too broad —
an effect is what a skill *does*, a status is what a body *carries*), *proc*,
*CC*, *crowd control*.

**Boon and affliction are presentation, never a rule.** They decide a mark's
colour. No mechanic reads them — there is no "remove all afflictions" in this
game, and describing one as though there were would be describing a verb the
player does not have.

**A status is always named with a capital**, and always by the name in
`STATUS_VISUALS`, so the word in a skill description and the word under the icon
are the same word.

> Crippling Strike — `Applies Slowed for 2.5s.`

### 1.4 Durations and timers

| Form | Use |
|---|---|
| `for Xs` | How long something lasts. |
| `every Xs` | How often a repeat happens. |
| `over Xs` | The span something is spread across. |
| `within Xs` | A window a condition has to be met inside. |

Durations are **seconds, never ticks**. The tables are in ticks at 60/s; the
writer converts. Up to **two** decimal places, with trailing zeros trimmed:
`2s`, `1.4s`, `0.35s`. Two rather than one because one is not enough to be
accurate — 0.35s is 21 ticks and one decimal reports it as 0.4s — and accuracy
outranks brevity.

**Do not use:** *turns*, *rounds*, *frames*, *ticks*, *briefly*, *a short time*,
*permanently* for something that expires.

**"for" and "every" are never interchangeable.** `for 2s` is a window;
`every 2s` is a cadence. A channel has both.

> Drain — `Deals 7 damage every 0.25s for 2s.`

### 1.5 Stacking and refreshing

This game has exactly one stacking rule, in `applyStatus`, and every status obeys
it. Say it the same way every time.

| Term | Meaning |
|---|---|
| **Stacks up to X times** | Re-applying adds one stack, to a ceiling of X. |
| **Does not stack** | The ceiling is 1. Written only when a reader would expect otherwise. |
| **Refreshes the duration** | Re-applying restarts the full duration. **Every status does this**, at every stack count. |
| **Keeps the stronger** | Re-applying takes the larger magnitude of the two, never the sum and never the newer. |

**Do not use:** *refreshes*, alone (refreshes what?), *reapplies*, *extends* —
nothing in this game extends a duration by adding to it, and *extends* would say
it does.

**Stacking and refreshing are separate facts and both are stated** where they
matter. A status that stacks says both; a status that does not stack says only
that it refreshes, and only where a player might expect a second application to
add to the first.

> Flow — `Stacks up to 3 times. Refreshes the duration.`
> Slowed — `Does not stack. Refreshes the duration and keeps the stronger slow.`

### 1.6 Cooldowns

| Term | Meaning |
|---|---|
| **Cooldown** | Time before the ability can be cast again, starting when it is cast (`cooldownTicks`). |
| **Attack interval** | The basic attack's cadence, from Base Attack Time. Not a cooldown. |

**Do not use:** *recharge*, *refresh* (that word belongs to durations),
*downtime*, *CD*.

**Cooldown and attack interval are never swapped.** A basic attack's rate comes
from Base Attack Time and its `cooldownTicks` is not what governs it; calling
both "cooldown" would tell a player that attack speed shortens a skill.

**A withdrawn cast does not start a cooldown.** Where that matters it is stated.

> Quake — `Cooldown 8s.`

### 1.7 Resources and costs

| Term | Meaning |
|---|---|
| **Resource** | The blue pool (`maxResource`). The game's only spendable magic pool. |
| **Guard** | The stagger pool (`poise` internally). Spent by some skills, broken by damage to it. |
| **Health** | Paid by Arcane Overflow and by skills carrying a blood price. |
| **Flask charge** | What Hearthdraught spends (`chargeCost`). Refilled by resting in a safe zone. |
| **Costs X** | The form. |

**Do not use:** *mana*, *energy*, *stamina*, *power*, *poise* (in front of a
player — the pool is called Guard), *spirit*.

**Guard is never called poise player-side**, and the internal name is never
shown. `Guard Break` is named for the pool.

**Every cost is refunded in full by a withdrawal**, whatever it is priced in.
Stated once in the standard rather than on every row.

> Guard Break — `Costs 3 Resource and 15 Guard.`

### 1.8 Targets and areas

| Term | Meaning |
|---|---|
| **Target** | One named body (`targeting: 'unit'`). |
| **Self** | The caster (`targeting: 'self'`). |
| **Point** | A place on the ground, refused past range (`targeting: 'point'`). |
| **Direction** | A heading from the caster; the shape runs along it (`targeting: 'direction'`). |
| **Enemies within X** | A circle of radius X. |
| **In a X° cone** | A cone. **X is the full opening angle**, half either side. |
| **In a line X wide** | A lane. X is the full width. |
| **Up to X targets** | The cap. |
| **Facing tolerance** | The **full** angular window, centred on the aim, the caster must be pointing within before the wind-up starts (`castAngleDeg`). A wide one is a skill you can throw while turning; a narrow one makes you commit to a direction first. |

**Do not use:** *AoE* as a noun, *splash*, *blast radius* (say radius), *nearby*,
*the nearest X*, *foes*, *units* (say enemies).

**"Up to X targets" is never written as "the X nearest".** Selection is
candidate order, not distance — `sim/skill-area.ts` says so explicitly — so
naming distance would be a claim the code does not make.

**Every reach is measured to a body's edge**, not its centre. This is uniform, so
it is stated here and not on every row.

> Whirlwind — `Hits up to 6 enemies within 160 of you.`

### 1.9 Range

**Range** is the maximum distance to the target, in world units, measured to the
body's edge. Written as a bare number: `Range 85.`

**Do not use:** *reach*, *distance*, *metres*, *yards*, *melee range* as a
number.

**Range and radius are never interchangeable.** Range is how far away the thing
may be; radius is how wide the effect is. Firepot has both and they are different
numbers.

### 1.10 Conditions and triggers

| Form | Use |
|---|---|
| `While X:` | A state that must hold for the whole time. |
| `When X:` | An event, at the instant it happens. |
| `If X,` | A one-off test at the moment of use. |
| `Against X,` | A property of the body being hit. |

**Do not use:** *on X* (ambiguous between state and event), *whenever*, *upon*,
*chance to trigger*, *procs*.

**While and When are never interchangeable**, and the difference is testable:
*While Staggered* is true for a span, *When staggered* is true for one tick.

> `While Slowed: move speed is reduced.`
> `When hit: Flow is lost.`

### 1.11 Chance and probability

Written `X% chance to Y.` — a percentage, first in the clause.

**Do not use:** *may*, *can*, *sometimes*, *rarely*, *a chance to*, *likely*,
*occasionally*, odds (`1 in 4`).

**A chance is always stated with its number.** If the number is not knowable at
authoring time — because it is derived from an attribute — the description says
what the chance is *derived from* rather than omitting it or guessing:
`Weak-point chance scales with Perception.`

> `4% chance to find a weak point.`

### 1.12 Scaling and modifiers

| Form | Use |
|---|---|
| `+X` / `-X` | A flat change to a stat. |
| `+X%` / `-X%` | A proportional change. |
| `X% of maximum health` | A proportion of a pool. |
| `Scales with X` | Where a number comes from an attribute, and the coefficient is not worth showing. |
| `A / D / -` | **What an ability or a weapon scales with** (specs 216, 242). Three positions, always Strength / Agility / Intelligence, one grade character each, `-` for none, each drawn in that attribute's own hue. Never reordered by strongest — position *is* the attribute. A weapon fraction is appended (`- / A / - + weapon`) rather than given a position, because it is not an attribute. |
| `Xx` | An outright multiplier. |

**Do not use:** *increases*/*decreases* where a sign will do, *enhanced*,
*improved*, *bonus*, *more* / *less* as mechanical terms (they mean specific
different things in other games and nothing here).

**A reduction is written as what it leaves, never as a subtraction to be
compounded.** The sim's reductions are reciprocal factors that cannot reach zero
(`scaling.ts`), so *"-50% cost"* would invite the reading that two of them is
free. Write `Costs are multiplied by 0.5.` or `Costs 50% less` only where a
single source is involved.

### 1.13 Immunity, resistance and removal

| Term | Meaning |
|---|---|
| **Immune to X** | X cannot be applied at all. |
| **Reduces X by Y%** | X still lands, smaller. |
| **Removes X** | Takes a status off a body that has it. |

**Do not use:** *cleanse*, *dispel*, *purge*, *resist* as a verb, *immune*
loosely (it is absolute), *ward*.

**This game has no cleanse and no dispel.** `clearStatus` has no player-facing
caller and no ability row uses the `removeStatus` effect. Until one does, no
description may imply that a status can be removed on purpose, and no status is
marked dispellable — see §3.4.

**Immunity and resistance are never swapped.** Stagger immunity after a break is
absolute for 2s. Adaptation is a resistance and caps at 30%.

### 1.14 The combat states

These are the ones a player has to read fastest, so they are fixed hardest.

| Term | Meaning |
|---|---|
| **Guard** | The pool. Damage to it is **Guard damage**. |
| **Guard break** | Emptying the pool. Causes a Stagger. |
| **Staggered** | Rooted, cannot cast, current cast dropped, Flow lost. Both a guard break and a skill's stun produce exactly this state. |
| **Stagger immunity** | 2s after any Stagger, during which a guard break cannot cause another. A skill's stun ignores this window and still stamps it. |
| **Resolute** | Constitution's low-health state: immune to Stagger, including from skills. |

**Do not use:** *stun*, *knockdown*, *daze*, *interrupt*, *floored*, *CC* — all
of them name the same one state, which is **Staggered**.

> Stunning Blow's name is flavour and is kept; its Technical Description says
> `Staggers the target for 1.4s.`, because that is the state the sim enters.

---

## Part 2 — The Technical Description standard

A **Technical Description** is the authoritative player-facing statement of what
a mechanic does. It appears in the Skills tab, on sigils, on items, in
status tooltips, and anywhere else a mechanic is exposed.

It is **derived from the row the sim reads**, by
`src/server/data/description.ts`. That is what makes the brief's bar —
*two designers independently describing the same mechanic produce nearly
identical descriptions* — a property of the code rather than a hope: there is one
writer, so there is one description. A number that is retuned is described
correctly on the next frame, with nothing to remember.

### 2.1 Information order

Always this order. A line that has nothing to say is **omitted, never left
blank**, so the order is stable and a reader learns where to look.

1. **Target** — what you must supply and what it lands on.
2. **Effect** — what happens, in the order the row lists it.
3. **Cost** — everything it is priced in.
4. **Timing** — wind-up, backswing, cooldown, channel.
5. **Note** — the small number of rules a row cannot state for itself.

Effects come **before** costs because the first question is what a thing does.
Timing comes last because it is the part a player checks once and then knows.

The **effect order is the row's own order**, because `sim/skill-effects.ts` runs
it in that order and reordering it is a balance change. Guard Break strips guard
*before* it deals damage, and its description says so in that sequence.

### 2.2 Sentence structure

- One fact per sentence. One sentence per line.
- Imperative-free and second-person-free: `Deals 42 damage.`, not `You deal` and
  not `Deal`.
- Every line ends in a full stop, including a fragment. **Notation is the one
  exception** (spec 242): the scaling line is `A / D / -`, the same three-position
  form a weapon's tooltip uses, and it is no more a sentence than a chord symbol
  is. It is held to the notation's own grammar instead, which
  `description.test.ts` asserts — so the exemption cannot be borrowed by a prose
  line trying to drop its full stop.
- The subject is the ability, and it is implicit. Never name the ability inside
  its own description.
- Conditions lead: `While Slowed: ...`, `When hit: ...`, `Against a staggered
  target, ...`.
- The caster is **you**; the thing hit is **the target** or **enemies**. Never
  *the caster*, *the user*, *the wielder*.

### 2.3 Numbers

| Kind | Form | Example |
|---|---|---|
| Damage, healing, range, radius | Bare integer | `Deals 42 damage.` `Range 90.` |
| Duration | Seconds, up to two decimals, zeros trimmed | `for 2.5s` `for 0.35s` |
| Percentage | At most one decimal, zeros trimmed, `%` | `40%` `0.8%` |
| Proportion of a pool | Percentage of the named pool | `35% of maximum health` |
| Chance | Percentage, leading | `4% chance to ...` |
| Target cap | `up to N` | `up to 6 enemies` |
| Repeat count | `N times` | `every 0.5s, 8 times` |
| Stack cap | `Stacks up to N times.` | |
| Angle | Integer degrees, **full** opening angle | `in a 90° cone` |

Rounding: durations to two decimals, percentages to one, every other quantity to
two — trailing zeros trimmed throughout. A number is never shown with
more precision than the player can act on, and never with less than the sim uses
in a way that changes the answer.

Every one of those decimal allowances was bought by an accuracy failure rather
than chosen, and the pattern is worth noticing. Durations went to two because
0.35s is 21 ticks and one decimal calls it 0.4s. Percentages went to one because
Lightfoot grants 0.8% armour a rank, and an integer percentage calls that 1% — a
quarter more than it is. Quantities went to two because Burn's pulse is 4.5 and
Bleed's exertion multiplier is 1.75, which an integer and one decimal
respectively overstate. This document's own priority order puts accuracy above
consistency, so each time the rule moved and the number did not.

**Ticks never appear.** Neither do internal ids, internal pool names, or raw
fractions where a percentage is meant.

### 2.4 What must always be shown

A Technical Description is incomplete without these, wherever the row has them:

- Every **cost**, in every currency.
- The **cooldown**.
- The **wind-up**, because withdrawing from it is the game's core decision.
- Every **status applied**, by name, with its duration.
- Every **target cap**.
- Any **stacking rule** that differs from a single application.
- **Range**, for anything not cast on yourself.

### 2.5 What may be omitted

- A **zero or absent** field. A row with no cooldown says nothing about
  cooldowns; it does not say `Cooldown 0s.`
- **Backswing** where it is zero, which is every row but the basic attacks.
- Universal rules stated in this document rather than on each row: that reach is
  measured to a body's edge, that a withdrawal refunds everything, that every
  status refreshes its duration.
- **Derived scaling**, where showing the coefficient would be less useful than
  naming the source. `Scales with Perception.` beats a coefficient a player
  cannot check.
- The **flavour line**, which is never part of the technical text at all.

### 2.6 Flavour

Flavour is the authored `description` on the row. It is **never** concatenated
into the technical lines, never used to state a mechanic, and is rendered
visually separated — a different colour, below the mechanical block.

A flavour line that makes a mechanical claim is a bug, because it will drift.
*"Slow enough to walk out of"* is flavour. *"Lands where the target is, not
where it was"* is a mechanic and belongs in the technical block if it is true and
nowhere if it is not.

### 2.7 Worked example

Guard Break, in full:

```
Guard Break

Target: one enemy. Range 85.          <- target
Removes 50 Guard.                     <- effects, in the row's order
Deals 25 Guard damage.
Deals 12 damage.
Costs 3 Resource and 15 Guard.        <- costs
Wind-up 0.4s. Cooldown 6s.            <- timing
Facing tolerance 35°.                 <- note

"Strips an enemy's guard and leaves    <- flavour, separated
 what is left of it hanging."
```

Two designers writing that from the row get the same lines, because there is no
choice left to make: the order is fixed, the forms are fixed, and the numbers are
read out of the row.

---

## Part 3 — Statuses in the HUD

### 3.1 What is shown

Every status with a row in `STATUS_VISUALS` is shown on the body carrying it, as
a mark above its health bar: a glyph, coloured by kind, with a stack count when
the row can stack.

The **local player additionally gets a status row of their own**, above the pool
bars at the bottom of the frame. That row carries the remaining duration and the
Technical Description on hover.

The split is deliberate. A mark over a body is 13px and moving, and identifies a
condition at a glance; it is not a thing a player can point at, and a 13px hit
target over every body in interest range that swallowed a click would break the
movement order the game is driven by. A row anchored to the frame is a thing a
player can point at, so that is where the readable detail goes.

### 3.2 Timers

A status with a finite duration shows its remaining time, counting down, in
seconds — **one decimal below ten seconds, whole seconds above**.

That is a deliberately different rule from §2.3's stated durations, which carry
up to two decimals. A stated duration is read once, at leisure, and wants to be
exact; a countdown is read while it moves, and two decimals changing sixty times
a second is a number nobody can take in. The countdown also rounds **up**, so a
mark that is still on a body never reads `0.0`.

A status that **does not end shows no timer at all** — not a dash, not a full
bar, not a large number. Nothing in the sim is indefinite today; the rule is
stated because the first one that is must not inherit a misleading clock. An
expiry that is not a finite number is read as indefinite.

A mark thins out over its last eight ticks, which is the same fade the stagger
swirl uses, so two marks that end together end together.

### 3.3 Stack counts

Shown when the row's ceiling is above 1, and shown even at one stack — a
stacking status that hid its `1` would read as one that does not stack. A row
with a ceiling of 1 never draws a count, because a number that can only ever be
one means nothing.

### 3.4 Categories

**Two, and no more: boon and affliction.**

They answer the question a player asks first and answers fastest — *is that good
for them or bad for them* — and they are the only categorisation this game can
make truthfully.

The ones deliberately **not** introduced, and what would justify each:

- **Neutral.** No status in the table is neutral. Add it when one is.
- **Dispellable / non-dispellable.** There is no cleanse and no dispel. Marking a
  status dispellable would describe a verb the player does not have. Add it the
  day an ability removes a status.
- **Source (yours / theirs).** Genuinely useful — Exposed is worth something to
  everyone attacking that body — but the wire does not carry who applied a
  status, and adding a field to say so is a protocol change rather than a
  presentation one.

The bar for a third category is that it changes what a player would *do*. A
category that only sorts is a legend to learn, not a picture to read.

The category is also **stated in words**, not only in colour: every status
tooltip ends in `Beneficial.` or `Harmful.`. Colour alone is a distinction a
colour-blind player does not have, and the two marks are a warm red against a
cool blue — the single most common confusion there is.

**This is presentation, and it is not the categorisation the sim reads.** Since
spec 240 there is a second, mechanical one in `data/status-semantics.ts`:
`beneficial`, `harmful`, `affliction`, `damageOverTime`, `bookkeeping`, covering
every status id including the ones no player is ever shown. It exists because
one map holds a poison and a half-second reaction window alike, and something
had to be able to tell them apart — see `progression-and-scaling.md` Part 3.

The two are held in step by a test rather than by convention: a status drawn as
a boon must carry `beneficial` and one drawn as an affliction must carry
`harmful`. They do **not** merge, because they answer different questions. Here
the question is *what colour is this mark*, and there it is *is this body
suffering from something* — and Exposed, which is drawn as an affliction, is
harmful and deliberately not one.

---

## Part 4 — Open questions

Ambiguities found while applying this standard. **None of them is resolved by
guessing in a description**: where the answer is unclear the writer omits the
line rather than inventing one, and the question is recorded here.

### 4.1 What is the Resource pool called?

`maxResource` is "Resource" in the item tooltip's stat table and unnamed
everywhere else — the pool bar has no label. "Resource" is a category, not a
name, and it is the only pool in the game a player spends deliberately.

*Needed:* a decision on the in-world name. Everything else in this document
follows from it, and `description.ts` has one string to change.

### 4.2 Does Exposed benefit everyone, or only the player who applied it?

Both, in different senses, and the current text cannot express it.
`sim/blow.ts` reads Exposed off the **target** and multiplies any attacker's
damage by `1 + magnitude` — so everyone benefits. But the magnitude was captured
from whoever applied it, so *how much* everyone benefits is that player's
Perception. Two attackers hitting the same Exposed body get the same bonus, and
it is the exposer's number.

*Needed:* a decision on whether the tooltip states the magnitude at all. It
cannot state a fixed one, and "scales with the Perception of whoever applied it"
is accurate and long.

### 4.3 What does the Adapted mark's stack count mean?

Adaptation is per ability (`adapt:bolt.arcane`), and the mark folds the whole
family into one glyph keeping the **largest** stack count. So a body showing
"3" has adapted three times to *some* ability, and the player cannot tell which
— and if they are attacking with a different one, the mark is true and
irrelevant to them.

*Needed:* either accept that the mark means "this body is adapting to something"
and word it that way, or carry the ability id on the wire for the viewer's own
attacks only.

### 4.4 Is Slowed's magnitude knowable to anyone but the slowed player?

`EntityField.MoveScale` rides only for the body's own client; the status mark
carries no magnitude. So a player who lands Crippling Strike can see *that* the
target is Slowed and not by how much, while the target can see both.

*Needed:* a decision on whether the caster's tooltip may state the skill's
authored magnitude (40%) — accurate for that skill, but not a statement about the
mark.

### 4.5 Which six does Whirlwind hit?

Candidate order — the world's insertion order — not distance.
`sim/skill-area.ts` is explicit that this is for determinism and that sorting by
distance "would be a better game and a worse guarantee". So `up to 6 enemies` is
the honest phrasing and there is no correct way to describe *which* six.

*Needed:* nothing for the description, which is already correct. Recorded because
"the 6 nearest" is what a reader will assume, and that assumption is wrong.

### 4.6 Channel pulse count

Drain pulses on the release tick and every 0.25s while the channel runs, for 2s
— which is 8 pulses, and the first is free in the sense that it lands the
instant the channel begins. `Deals 7 damage every 0.25s for 2s.` is accurate
about the cadence and leaves a reader to work out the count.

*Needed:* a decision on whether a total (`8 pulses`) or a total damage figure is
worth showing. It is derivable and this document's brevity rule says do not show
what is derivable — but total damage is what a player actually compares.

### 4.7 Stunning Blow is named for a state the vocabulary calls Staggered

The skill name is flavour and reads well. Its Technical Description says
`Staggers`, per §1.14. The two are consistent but a player may not connect them.

*Needed:* a decision — rename the skill, or accept the name as flavour. This
document assumes the latter.

### 4.8 The stat skills in `data/skills.ts`

Thirty-six rows granting `traits` keys — `windupPoiseArmor`,
`flowBackswingCancelPct`, `shapingCostRelief`. Each is a real number in the sim, and none is described
anywhere a player can read; the character sheet shows the authored sentence and
the trigger.

**Closed.** `GRANT_LABELS` in `data/description.ts` is that table, over both
halves of a `StatModifier`, and `describeStatSkill` composes it into a
requirement, a trigger and one line per thing the row grants — the rate at rank
0, the total with the rate beside it above.

Three trait fields are deliberately **not** labelled, and the safe default is
what makes that honest: a field with no row draws no line, so the row's authored
sentence carries it and nothing is invented. They are `juggernautBelow` (a health
threshold, not a magnitude), `masteryRelief` (a count that *lowers* a
requirement, which no signed quantity reads correctly) and
`overflowHealthPerResource` (a price the skill charges for a benefit, so a
"+2" reads as a gain). `description.test.ts` asserts that list exactly, so a
fourth gap fails rather than passing quietly.

The other rule the tree forced: **a "reduction" trait is named as a reduction.**
`backswingCancelReduction: 0.05` is a positive number meaning *less* of the
backswing you have to sit through, so `+5% Backswing` said the opposite of what
the trait does and `+5% Backswing you may break off` says what it is. Two fields
are genuinely signed the other way — `prepareTicks` is authored negative and
`preparedWindupScale` is a negative delta on a multiplier — and must not be
renamed to match.

Spec 256 sharpened the same rule into a second one: **name the thing the number
moves, not the thing it is near.** That trait used to be `backswingReduction` and
really did divide the backswing; it now moves the *cancel point* and the phase is
the same length for everybody. A label that still said "Backswing reduction"
would have been correctly formed, correctly signed, and describing a mechanic
that no longer exists. The character sheet's `Recovery` row went the same way —
it was the banned word in §1's do-not-use list, and it is `Break off` now.

### 4.9 An arc buys nothing, and three strings say it does

**The most serious thing found while applying this standard.** The ability
table's comment on Hunting Shot says a lobbed shot is *"unblockable: an arcing
shot flies over whatever is between the archer and the body it named"*, and two
flavour lines said the same.

`sim/world.ts` says the opposite outright:

> `arcHeight` is a *look*: whether the shot rises on its way. **It buys nothing
> mechanical**, so an arrow and a star reach the same body at the same tick and
> only differ in what the eye follows.

`projectileHits` confirms it — a flat 2D overlap of two radii, with no height
term anywhere in it. What actually decides whether a bystander can take a shot
is whether the shot **named** a body: a shot with a target id resolves against
that body and ignores everything else, and a point-aimed shot takes the first
hostile thing it overlaps. Hunting Shot is point-aimed, so it is blockable, and
its second claim — *"lands where the target is, not where it was"* — is a
description of Seeking Bolt rather than of itself.

The writer now derives that line from `targeting` and says nothing about `arc`,
and the two flavour lines have been rewritten to make no mechanical claim.

*Needed:* a design decision, because there are two defensible fixes and they are
not the same game. Either the arc is only ever a look — in which case
`ProjectileSpec.arc` belongs beside `look` and the comment on Hunting Shot
should go — or a lobbed shot is *meant* to clear bodies, in which case
`projectileHits` needs a height term and the claim becomes true. This document
cannot choose; it can only refuse to describe a mechanic that is not there.

### 4.10 Prepared's expiry does not survive the wire

`world.ts` applies Prepared with `Number.MAX_SAFE_INTEGER - tick`, and
`messages.ts` writes `expiresAtTick` as a **u32**. `2^53 - 1` does not fit in
32 bits, so the client receives the truncated remainder — around 4.29 billion
ticks, or roughly two years.

It happens to land somewhere harmless, which is luck rather than design: it is
above every real duration, so the mark stays up and the status behaves. But the
number the client holds is not the number the server sent, and any timer drawn
from it is meaningless.

Handled from both ends rather than either: `StatusVisual.indefinite` says the
*design* has no clock, so no description promises a refresh; and
`INDEFINITE_AFTER_TICKS` in `world/status-marks.ts` refuses an absurd remaining
time, so no timer is drawn from a *value* that cannot be trusted.

*Needed:* an explicit sentinel on the wire — a reserved `expiresAtTick` of 0 or
`0xFFFFFFFF` meaning "no expiry" — so the client is told rather than inferring.
That is a protocol change and belongs in its own spec.

### 4.11 A projectile's speed is not the speed it travels at

`ProjectileSpec.speed` is documented as the value *before*
`PROJECTILE_SPEED_SCALE`, so the 900 on Hunting Shot's row is not 900 world
units per second in a running game. Flight speed is worth telling a player —
it is what leading a moving target is made of — and the row cannot honestly
supply it.

*Needed:* either the scale applied at the point of description, or a decision
that flight speed is not shown. The writer currently omits it.

### 4.12 A pair and a status were both called Momentum

Found by the rule that pairs are never named on the character sheet, when the
tree's descriptions started naming the statuses they act on.

`StatusId.Momentum` is a status: `STATUS_VISUALS` gives it a name, spec 186 draws
it over every head in the world, and §1.3 requires any description of it to use
that word. `pair.momentum` in `synergies.ts` was *also* called Momentum, and a
pair's name is by design never shown anywhere — `character-model.test.ts` asserts
it of the whole serialised view, because naming the fifteen pairs would turn
things to discover into things to build toward.

The two could not both hold. A sheet reading `+0.6s Momentum duration` beside a
hidden pair called Momentum is exactly the "found it" a player would draw, and
wrongly. The hidden half was renamed to **Breakthrough**, which changes nothing
any player can see; the status keeps the name it already wears in the world.

*Needed:* nothing. Recorded because the collision was invisible until something
tried to describe the tree, and a second one would be too.

### 4.13 `poise` is still in sixteen authored strings

The standard's §1.7 says the pool is Guard in front of a player and the internal
name never appears. `description.ts` obeys it and `description.test.ts` enforces
it — **over the writer's output only.**

Sixteen authored strings in `data/synergies.ts`, `data/milestones.ts` and
`data/attributes.ts` still say "poise", and at least some of them are
player-facing: `character-model.ts` renders a milestone's `name — effect` as the
`nextEffect` line on an attribute row, so a player is already being shown the
word. Two were fixed in passing because this work touched their rows (Brutal
Follow-Through's trigger and the Breakthrough pair's effect); the rest were left
alone rather than swept blind.

*Needed:* a pass over those three tables, and a test that covers *authored*
strings as well as generated ones. The generated half being clean is currently
proving less than it appears to.
