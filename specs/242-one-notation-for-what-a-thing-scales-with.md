# 242 — One notation for what a thing scales with

## Problem

Spec 238 gave abilities explicit scaling and gave the tooltip a sentence for it:

```
Scales with Strength A and Agility D.
```

A weapon, since spec 216, says the same thing like this:

```
A / D / -
```

So the two halves of the game's offence describe the identical fact two
different ways, and **nothing about them looks comparable**. A player deciding
between a sigil and a sword is reading a sentence against a notation and doing
the translation in their head; a player who has learned to read `A / D / -` off
a weapon learns nothing that helps them read a skill.

The sentence is also the worse of the two at the job. It grows with the number
of attributes involved, it buries the grades in prose, and it cannot show the
absent positions at all — `Scales with Strength A` does not say that Agility and
Intelligence buy nothing, where `A / - / -` says it in two characters.

## Shape

The weapon's notation, borrowed whole. Three positions, always Strength /
Agility / Intelligence, one grade character each, `-` for `None`, each drawn in
that attribute's own hue. Never reordered by strongest — **position is the
attribute**.

The line needs more than one colour, so `TechnicalLine` gains runs:

```ts
export interface TechnicalLine {
  readonly text: string;
  readonly tone: Tone;
  readonly spans?: readonly TechnicalSpan[];   // absent for every line but this one
}
export interface TechnicalSpan {
  readonly text: string;
  readonly attribute?: ScalingAttribute;       // absent = the line's own tone
}
```

`attribute` rather than a colour, because `data/description.ts` is in the
deterministic core: the writer says what a run *is* and `src/ui/` says what that
looks like, which is the division `Tone` already exists for.

The weapon fraction is **appended** rather than given a position, because it is
not an attribute: `- / A / -  + weapon`. The letters it brings are the weapon's
and are on the weapon's own tooltip.

`ATTRIBUTE_TOKENS` moves to `src/ui/theme/theme.ts`. There are two builders now
— the bag's, for a weapon, and the action bar's, for a skill — and a second copy
of "Strength is this colour" would be free to drift in the exact place the
notation exists to make the two comparable.

## Invariants tested

- Every ability's notation matches the notation's own grammar, and its runs
  concatenate to its `text` — so the tooltip's wrap and its repeat-hover key
  describe what is on screen. A control asserts the exempt set is non-trivial.
- Every *other* line still ends in a full stop.
- A basic attack draws no scaling line; an unscaled ability draws none either —
  asserted structurally, on the absence of runs, so there is no wording for a
  stale test to keep passing against.
- A sigil carrying Whirlwind and a Worn Sword produce **byte-identical** spans,
  from two different builders.
- The scaling line is drawn for a weapon, or for a sigil whose skill scales, and
  for nothing else.
- On the action bar: the three grades carry attribute tokens and the separators
  carry the line's own, so what is hued is the grades and not the punctuation.
- Each attribute names a token the palette has, the three are distinct, and none
  of them is `danger` or `success`.

## Out of scope

- **Changing any grade.** This is how the same answer is written, not what it is.
- The character sheet and the shop, which show neither weapon nor ability
  scaling today.
- A legend. The hues are the ones the bag has used for weapon grades since spec
  216, so the notation arrives already learned.

## Note

§2.2 of `mechanics-vocabulary.md` requires every technical line to end in a full
stop. Notation is now the one stated exception — `A / D / -` is no more a
sentence than a chord symbol is — and it is held to the notation's own grammar
instead of to nothing, so the exemption cannot be borrowed by a prose line
trying to drop its full stop.
