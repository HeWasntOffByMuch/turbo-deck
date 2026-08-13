# Reward philosophy

**What this document is.** A set of rules to consult when designing and
implementing future gameplay, loot, progression, encounter and feedback systems
in this repo. It is not a description of a system that exists. Almost everything
below is labelled, and the labels mean what they say:

| Label | Meaning |
|---|---|
| **Current rule** | A constraint on work done from now on. Binding on the next system, whether or not any code enforces it yet. |
| **Implemented** | Shipped and in the tree. A file path is given. |
| **Not yet implemented** | Named here, deliberately absent from the code. |
| **Future direction** | A shape a later spec may take. Not a commitment, and explicitly not a licence to build it as a side effect of some other task. |

The only thing implemented under this heading today is delayed rarity reveal
(spec 156). Everything else here is a rule or a direction. **A future direction
is not a backlog item you may pick up while doing something else** — it earns a
`specs/` entry of its own or it does not happen.

---

## 1. World-embedded rewards over constant UI reward selection

**Current rule.** Excitement should come from the world responding to play, not
from stopping the player and asking them to pick a card.

The player we are building for says *"what the hell is that?"* — not
*"LEGENDARY! +500 SCORE!"*. The difference is where the event happens: one is a
thing in the arena that the player noticed, the other is the interface operating
on the player. Reward beats belong in combat, exploration, mastery, loot,
discovery, character ownership and mechanical consequence.

This is not a ban on rarity, randomness, anticipation, or the occasional
dramatic reward. It is a rule about *where they live*. A rare drop is an
unusual object lying in the grass; it is not a modal.

**Current rule.** A new reward system does not get to add a screen that
interrupts play. If the reward cannot be expressed in the world, in the HUD, or
in a window the player chose to open, the design is not finished.

## 2. Reward rhythm

**Current rule.** Reward layers come from *different sources*, at different
cadences:

```
frequent satisfaction → occasional surprise → rare anticipation → long-term aspiration
```

### Frequent satisfaction — reliable, never random

Satisfying impact, a clean Weak Point hit, breaking Guard, causing Stagger,
responsive movement, Flow behaving, readable hit feedback, enemies reacting.

**Current rule: do not randomize basic combat satisfaction.** These are
consequences of play and must be reliable, or the player cannot learn anything.
A weapon whose *feel* varies roll to roll is a broken weapon, not an exciting
one.

*Implemented:* the health-bar chunk and kick (`src/render/iso3d/world/health-bar.ts`,
specs 145/146), attack-phase legibility (`src/server/sim/attack-timing.ts`,
spec 144), Guard and Stagger (`src/server/sim/poise.ts`, spec 147).

### Occasional surprise — texture

An unusual restorative pickup, an interesting affix, an elite variant, an
unexpected interaction between two existing mechanics, a contextual roll. Often
enough to give the game texture, rarely enough that it is still an event.

*Not yet implemented.* None of these exist.

### Rare anticipation — where rare loot lives

An unusual item appears, and the player knows something exceptional happened
*before* being handed every fact about it. **The anticipation is part of the
reward**, not packaging around it.

*Implemented, in one narrow form:* delayed rarity reveal (spec 156). A drop
lands, an unusual cue plays, and the item's identity resolves a beat later. See
§10 for the presentation constraints it works under.

### Long-term aspiration — mostly deliberate

Seeing a weapon you cannot yet use well; an item that implies a strange future
build; realizing a stat combination could enable an interaction you have not
tried; encountering something that makes you reconsider where your points are
going.

**Current rule.** Aspiration should be *deliberate* rather than purely random.
It is authored: the fifteen attribute pairs in `src/server/data/synergies.ts`
exist to be discovered, and they were written, not rolled.

## 3. Reliability versus mystery

**Current rule.** Do not randomize every layer. Use this hierarchy:

| Layer | How random |
|---|---|
| Character progression | mostly deliberate |
| Build interactions | discoverable |
| Basic loot | predictable |
| Exceptional loot | surprising |
| Rare world events | mysterious |

Contrast is the whole mechanism. **If everything is surprising, nothing is.** If
every system becomes a random reward generator, each individual reward means
less than it did when only one of them was.

This is the reason spec 156's `common` tier has a reveal delay of exactly zero
ticks and no anticipation cue. Ordinary loot is meant to be quiet. The rare
drop's beat only works because most drops do not have one.

## 4. Mechanical rewards over UI jackpots

**Current rule.** Prefer *"my build just did something awesome"* over *"the game
awarded me a bonus"*.

A jackpot moment should ideally be the systems producing an unusual but
understandable result: an especially effective Weak Point exploit, a Guard break
that leads into a Stagger and a full punish, a Flow or Momentum interaction
paying off, a spell landing in a way the player set up. The reward is that it
happened, and that the player caused it.

*Not yet implemented.* No mechanic exists specifically to produce these; the
rule is a preference over how future combat and loot work is designed. **Do not
add new combat mechanics in service of this heading** — it is a lens, not a
feature list.

## 5. Behaviour-changing loot

**Future direction.** Rare equipment should prefer modifiers that create a
decision or change what the player can do, over modifiers that only change a
magnitude.

Less interesting:

```
+12% damage
```

More interesting in shape:

```
a specific existing combat event changes what the weapon can do next
```

Where practical, such modifiers should hang off concepts that already exist:
Guard, Stagger, Weak Point, Flow, Momentum, Vulnerable, Prepared, Exposed,
Attuned, Sundered, and the Wind-up / Attack Point / Backswing phases.

**Not yet implemented, and explicitly out of scope for spec 156.** There is no
affix system. `ItemDefinition.modifiers` is a flat `StatModifier` and every row
in `src/server/data/items.ts` is a magnitude. Do not invent production affixes
without a spec that says so.

## 6. Contextual loot

**Future direction.** Loot may eventually be influenced by *how* an encounter
was resolved — repeated Guard breaks and Staggers nudging relevant properties,
Weak Point-heavy play nudging precision-related ones, other existing combat
states feeding a weighting.

The feeling to aim for is *"the world seems to notice how I play."* The feeling
to avoid is *"perform action X exactly five times to manufacture affix Y."*
**A deterministic crafting recipe disguised as combat is a failure of this
heading, not an implementation of it.** If a wiki could state the recipe, it is
the wrong design.

**Not yet implemented.** `rollLoot` in `src/server/data/loot.ts` reads a monster
id, a seeded `Rng` and the live drop rate, and nothing else. It has no access to
combat history and should not be given one casually.

## 7. Bounded bad-luck protection

**Future direction.** Exceptional loot should eventually consider bounded
bad-luck protection rather than relying on independent rolls forever: a long
stretch without anything noteworthy gradually improving the odds or the quality,
within explicit bounds.

Two constraints if it is ever built:

- the bounds are explicit, so the worst and best cases are both statable;
- **the meter stays hidden.** No `Legendary Meter: 97/100`. A visible pity
  counter converts anticipation into arithmetic, which is the opposite of what
  this document is for.

**Not yet implemented.** Drops today are independent rolls against a flat chance.

## 8. Discovery rewards

**Future direction.** Some rewards should be the realization that something
*exists*: a hidden item interaction, an unusual stat interaction, an uncommon
enemy variant, a secret route, strange merchant stock, an ability behaving
unexpectedly.

**Current rule.** Discovery should not be automatically converted into an
achievement, a popup or a reward screen. Telling the player they have discovered
something is often the thing that destroys the discovery. The fifteen attribute
pairs already follow this rule and it is enforced by tests: they are live in the
sim, and they are **never named on the character sheet**, because naming them
would turn fifteen things to find into fifteen things to grind toward.

**Not yet implemented** as a system. There is no discovery tracking and there
should not be one added quietly.

## 9. Visible consequences of progression

**Future direction.** Progression should increasingly change what a player can
visibly *do*, not only what their numbers are.

The precedent already in the tree is the structural commitment in
`attackTimingFor`: **Agility scales the attack point and the backswing and never
`baseAttackTimeTicks`**, so a high-Agility character attacks exactly as often as
anyone else and spends far less of each cycle rooted. That is a visible
difference in how a body behaves, produced by an attribute, and it is the model
to copy.

**Not yet implemented** beyond what specs 144 and 147 already do. Do not add new
stat mechanics under this heading without a spec.

## 10. Restrained presentation

**Current rule.** Loot presentation is restrained. Specifically, do not reach
for:

- screen-filling banners or rarity text;
- particle explosions;
- fanfares on every drop;
- reward-card interruptions;
- camera effects;
- `LEGENDARY!!!`.

The shape to aim for instead:

```
impact / brief quiet
→ distinctive audio cue
→ physical item becomes legible
→ subtle rarity effect develops
→ item identity becomes available
```

**Current rule.** Not every tier gets ceremony. Basic loot stays quiet so
unusual loot keeps its contrast (§3).

**Current rule.** Presentation must never obstruct responsive play. Spec 156
resolves this explicitly: a drop can be picked up before its reveal finishes,
and doing so simply ends the presentation. An invisible timer that blocks the
player's hands is not anticipation.

*Implemented:* `src/render/iso3d/world/loot-drop.ts` (pure — what to draw and
which cue to emit) and the drop's presentation in `scene.ts`. Cues are **names**
emitted into a sink; no asset is named in loot logic and the server never learns
what a cue is.

## 11. Reuse the existing vocabulary

**Current rule.** Future systems use the words this game already uses. A synonym
is a second concept whether or not anybody meant it to be.

| Term | What it is | Do not invent |
|---|---|---|
| **Guard** / Poise | The combat resource attacks deplete. `Guard` in player-facing text; `poise` is the field name in code (`src/server/sim/poise.ts`). | a second resistance meter |
| **Stagger** | The state caused by emptying Guard. A meaningful combat event. | "break", "knockout", "interrupt meter" |
| **Weak Point** | Perception's precision mechanic. **Separate from a critical hit**: a crit is a bigger number, a Weak Point is a bigger number *and* an opening anyone can use. | a second "precision kill" system |
| **Flow** | Agility's timed status. | a second combo meter |
| **Momentum** | A timed status earned through Guard/Stagger play. | — |
| **Prepared** | Intelligence's banked opener, held until spent. | another preparation state |
| **Exposed** | An existing timed status. | a parallel vulnerability debuff |
| **Vulnerable** | The window after a body commits. **A fact about the world, not about the observer**: Perception may change how well a player exploits it, but the state is not owned by whoever is looking at it. | a per-observer vulnerability |
| **Attuned** | An existing timed status. | — |
| **Sundered** | An existing timed status. | a parallel armour-break debuff |
| **Wind-up / Attack Point / Backswing** | The three phases of an attack (spec 144). The Attack Point is the boundary: before it a withdrawal refunds everything and the attack did not happen; after it, only the legs come back. | "startup", "release phase", "recovery phase" |

The statuses are in `src/server/sim/statuses.ts` and the attack phases in
`src/server/sim/attack-timing.ts`. If a design needs one of these ideas, it
takes the existing one — including its existing semantics — or it argues in a
spec for changing it.

Adapting a term at a UI boundary is allowed when it is deliberate and written
down. Inventing a synonym because the existing word was not to hand is not.

## 12. Principles versus implemented systems

**Current rule.** This document does not describe the game. It describes how to
decide.

What exists today, under this heading, in full:

- **Implemented:** rarity as a property of an item row, a per-monster drop
  table, a drop that lands in the world as an entity, an authoritative reveal
  clock, and a restrained tier-shaped presentation over it — all of spec 156 and
  nothing beyond it.

What does not exist, and must not appear as a side effect of some other task:

- **Not yet implemented:** contextual loot; bad-luck protection; affixes;
  instanced item state; shared or rolled loot; a loot feed; achievements;
  discovery tracking; reward-card UI; new health or orb mechanics; new combat
  states; new progression mechanics.

**Current rule.** If a task ends with more of that second list implemented than
it started with, and no spec was written for it, the work has escaped its scope
and should be removed or isolated before it lands.
