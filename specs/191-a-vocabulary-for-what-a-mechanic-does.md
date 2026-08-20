# 191 — A vocabulary for what a mechanic does

## Problem

There is no agreed way to tell a player what anything in this game does, and
the evidence is in the tables.

`data/abilities.ts` carries one `description` per row and every one of them is
prose. Some is pure flavour — *"A long wind-up worth interrupting, and worth
landing."* Some makes mechanical claims the row does not contain — *"Lands
where the target is, not where it was."* Some makes claims that are true but
unverifiable against the row beside them — *"Slow enough to walk out of."*
Nowhere does any of it say what Heavy Blow costs, how long its wind-up is, how
wide its cone is, or that it can be withdrawn from. All four are in the row.

`data/skills.ts` is the same shape with a second problem: thirty-six rows whose
`perLevel` grants are numbers and whose descriptions are sentences about
feelings, so a player cannot tell that Crushing Blows is +18% guard damage per
level from anything they can read.

The eight rows in `data/status-visuals.ts` are worse off again, because a status
is the one thing in this game whose whole purpose is to be read mid-fight and
acted on. Spec 186 gave them a mark over the head with a colour and a stack
count. It did not give them a *name a player can look up*, a remaining
duration, or any statement of what the condition does — so a player who sees the
Exposed glyph appear on the body they are fighting learns that something
happened, and nothing else. The mark says "somebody could point at this"; it
does not say what to do about it.

The consequence is that the rules are all in the tables and none of them are in
the game. A player who wants to know whether Crippling Strike's slow stacks, or
whether Whirlwind picks the nearest six bodies or an arbitrary six, has to read
`sim/skill-effects.ts` and `sim/skill-area.ts`. Both questions have exact
answers. Neither is written down anywhere a player will ever be.

The design principle this spec is built on: **the interface should expose the
game's actual rules rather than requiring players to reverse-engineer them.**

## Shape

Three pieces: a document that states the rules of the language, a writer that
speaks it, and the HUD change that finally puts a status where it can be read.

### 1. The standard (`docs/mechanics-vocabulary.md`)

Durable direction, in `docs/` beside `reward-philosophy.md` and for the same
reason: it outlives any one spec, and future skill, item and status work is
decided against it. Two halves.

**A controlled vocabulary.** One term per concept, with what it means, when it
is used, which terms it must not be swapped with, and an example. Small on
purpose — the failure mode of a glossary is synonyms, and two words for one
mechanic is two mechanics as far as a player is concerned. The terms are drawn
from what the sim actually implements, so every entry names the code that owns
it: Guard is `poise`, Stagger is `stagger()`, Resource is `maxResource`.

**A grammar.** How a duration, a percentage, a chance, a target count, a stack
limit, a condition and a trigger are each written, so that `Deals 42 damage.`
and `for 2.5s` and `Up to 6 targets.` are the only forms any of them ever take.

### 2. The writer (`src/server/data/description.ts`)

Pure, dependency-free, part of the deterministic core — beside the tables it
describes, because it reads them.

```ts
export type Tone = 'target' | 'effect' | 'cost' | 'timing' | 'note';

export interface TechnicalLine {
  readonly text: string;
  readonly tone: Tone;
}

export interface TechnicalDescription {
  readonly name: string;
  /** The mechanical lines, in the standard's order. Never empty. */
  readonly lines: readonly TechnicalLine[];
  /** Authored flavour, kept out of `lines` and never mixed into them. */
  readonly flavor: string | null;
}

export function describeAbility(ability: AbilityDefinition): TechnicalDescription;
export function describeStatus(visual: StatusVisual): TechnicalDescription;
export function technicalText(described: TechnicalDescription): string;
```

**The Technical Description is derived, not authored**, and that is the whole
design. The brief's bar is that *two designers independently describing the same
mechanic produce nearly identical descriptions*; the strongest available form of
that is one function that produces exactly one description, from the same row
the sim reads. A derived description cannot drift from the numbers, cannot be
forgotten when a number is retuned, and cannot describe a field the row does not
have.

`inventory-model.ts` already works this way — an item's stat lines come from its
`modifiers` rather than from a sentence somebody wrote — and this is that
precedent applied to the three tables that never got it.

What a row genuinely does not carry is **authored**, and the split is stated
rather than negotiated per row: a `StatusVisual` knows its name, kind and stack
ceiling and does *not* know what the condition does, because that lives in
`sim/blow.ts` and `SCALING`. So `StatusVisual` gains an authored `effect` line
written to the standard, and the writer composes it with the parts it can
derive. Nothing that can be derived may be authored, which is the rule that
keeps a second copy of a number from appearing.

### 3. The status a player can read (`world/status-marks.ts`, `hud.ts`)

`StatusMark` gains the two things a mark cannot currently say:

```ts
export interface StatusMark {
  // ...as before: id, name, icon, kind, stacks, showsCount, opacity
  /** Ticks until it ends, or null when it does not end. */
  readonly remainingTicks: number | null;
  /** "2.4" — what a timer draws, or null when there is no timer to draw. */
  readonly timer: string | null;
}
```

`remainingTicks` is **null rather than zero** for a status that does not end,
and `timer` is null with it. No status in the sim is indefinite today, so this
is the shape the rule needs rather than a feature: an expiry that is not a
finite number is read as indefinite and draws no timer, which is the honest
answer and satisfies *"permanent or indefinite statuses should not display a
misleading timer"* without inventing a wire field nothing writes.

The **local player gets a status row of their own**, above the pool bars, and
that is where the timers and the hover live. The floating marks over bodies stay
exactly as spec 186 built them. The reason is that the two rows answer different
questions: a mark over a body says *that* something is on it, at 13px, on a
target that is moving — and a 13px hit target over every body in interest range
that swallowed a click would break the movement order this game is driven by. A
row anchored to the frame is a thing a player can point at, so it carries the
count, the remaining seconds, and a `title` holding the full Technical
Description — the same affordance the action bar already uses to explain an
ability.

**No new visual categories.** `boon`/`affliction` stays two, because dispellable
and non-dispellable would be a distinction this game cannot make: there is no
cleanse and no dispel: `clearStatus` has no player-facing caller and the
`removeStatus` effect has no row using it. A mark that said "dispellable" would
be telling a player about a verb they do not have. The condition for adding a
third category is stated in the doc rather than left to taste — the day a cast
removes a status, the mark that says which ones it can take is worth drawing.

## Invariants tested

- **The writer is total.** Every row in `ALL_ABILITIES` and every row in
  `STATUS_VISUALS` produces at least one line, and no line is empty or contains
  a raw tick count, a raw id, or `undefined`.
- **Derived numbers match their row.** A test reads the damage, cost, cooldown,
  wind-up, range and radius back out of the generated text and asserts each
  against the field it came from, so a retune that does not reach the
  description fails.
- **Grammar conformance.** Every generated line ends in a full stop; every
  duration matches `Ns`/`N.Ns`; every percentage is an integer followed by `%`;
  no line contains a banned synonym (the doc's list — "buff", "debuff", "DoT",
  "proc", "CC", "AoE" as a noun).
- **Flavour is separated.** `describeAbility(...).lines` never contains the
  row's authored `description`, and `flavor` is never concatenated into the
  technical text by `technicalText`.
- **No invented behaviour.** A row with no `effects` produces no effect line
  beyond its damage; a row with no `area` produces no target-count line; a row
  with no `castAngleDeg` produces no facing line.
- **`maxTargets` is never described as nearest.** Selection is candidate order
  (`sim/skill-area.ts` says so explicitly), so the text says *up to N* and never
  *the N closest*.
- **Timers.** `statusMarks` returns `remainingTicks` counting down against the
  drawn tick; a non-finite expiry returns `null` for both `remainingTicks` and
  `timer`; a status whose window has passed is still dropped entirely.
- **The player's row does not move the pool bars.** The existing rule the
  floating row already obeys, asserted for the new one.
- **Determinism is untouched.** `presentation-only.test.ts` still passes: the
  writer is pure and reads no entity, and the HUD row draws from replicated
  state and the drawn tick.

## Out of scope

- **Localisation.** Every string is English in a table. The writer is the place
  a message catalogue would eventually go, and this spec does not build one.
- **A styled hover panel.** The player's row uses `title`, which is what the
  action bar and the weapon switch already use. Replacing all three with a
  drawn tooltip is a HUD change of its own.
- **Timers over other bodies.** Stated above as a decision, not an omission: it
  needs a readable form at 13px that is not digits, and that is a design
  question rather than a description one.
- **Rewriting `data/skills.ts`'s thirty-six rows into derived text.** The stat
  skills grant `StatModifier` and `traits`, and turning a trait key into a
  sentence is a fourth writer over a table whose entries are far less uniform
  than an ability's. The doc states how they should be written; the derivation
  is a follow-up.
- **Any change to what a mechanic does.** No number in any table moves. This
  spec is about saying what they already are.
