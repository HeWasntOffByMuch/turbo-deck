# 024 — Adrenaline as a cost economy

## Problem

Spec 023 made a synergy spend the whole adrenaline bank. That is too coarse:
one synergy erases everything you banked, so there is no reason to bank past a
single dump. Rework adrenaline into a spending economy tied to the cards
themselves:

- **Synergies no longer wipe the bank.** A cast spends only what its cards cost,
  so a bank persists across several casts and keeps empowering them.
- **Spell cards cost adrenaline to play.** Any non-`attack`, non-`dash` card
  (the fire/earth sets) costs `ADRENALINE_COST_PER_SPELL` adrenaline; you cannot
  play one you cannot afford. `attack` (which *builds* adrenaline) and `dash`
  stay free.
- **No stalling when broke.** Because spell cards are gated on adrenaline, a hand
  with no generator and an empty bank would soft-lock. So whenever the bank is
  empty, a basic `attack` is guaranteed to be in the hand.

Empower is unchanged from 023: each banked point still adds +20% damage to a
synergy cast. Now the bank drains gradually through card costs instead of all at
once.

## Shape

### Sim (`src/sim/`)

`castSpells.spendAdrenaline` changes from a boolean (reset-to-zero) to a
**number** — the amount to deduct. Applied after any basic-attack gain, clamped
at zero:

```ts
| { kind:'castSpells'; …; spendAdrenaline?: number }   // was: boolean
```

### Game (`src/game/spell-session.ts`)

```ts
ADRENALINE_COST_PER_SPELL = 1
spellCardCost(id): number      // 0 for the regular set (attack/dash), else the cost
```

- **Play gate:** playing a costed card is refused unless
  `player.adrenaline >= (cost already committed to the open window) + this card's
  cost`. A refused play stays in hand and emits `playRejectedNoAdrenaline`.
- **Resolve:** a synergy (some id count ≥ 2) with `adrenaline > 0` still empowers
  its specs by the *current bank*. The cast carries
  `spendAdrenaline = Σ spellCardCost(card)` over the window (independent of
  whether it fused), so lone spell cards pay their cost too.
- **Generator guarantee:** while broke (`player.adrenaline === 0`) and holding no
  `attack`, refills are **draw-biased** — an empty slot draws an `attack` (pulled
  from the piles, minted only if none remain) instead of the top card, so a
  generator returns on the normal draw-delay rhythm rather than by an instant
  swap. Draw-bias only acts on an empty slot, so the one state it cannot fix — a
  full hand of unaffordable spell cards with no free card to cycle — is caught by
  a dead-end breaker that swaps one spell card for an `attack` immediately (the
  displaced card returns to the discard).

### Render (`src/render/spells/`)

- Each spell card shows its adrenaline cost; a card the player cannot currently
  afford is dimmed.
- A refused play pops a brief "NEED ADR" marker.

## Invariants tested

- `spellCardCost`: 0 for `attack`/`dash`; `ADRENALINE_COST_PER_SPELL` for a
  fire/earth card.
- Sim: `spendAdrenaline: n` deducts exactly `n` (clamped at 0); a basic-attack
  gain in the same cast applies before the deduction.
- Play gate: a costed card is refused at insufficient adrenaline (stays in hand,
  emits `playRejectedNoAdrenaline`) and allowed once the bank covers it;
  `attack`/`dash` are always playable.
- Resolve: a synergy empowers by the bank and spends only the cards' cost, so
  the bank persists (e.g. bank 5, two-cost synergy ⇒ empowered ×2, bank 3
  after). A lone spell card pays its cost but is not empowered.
- Guarantee: while broke with no `attack` held, an emptied slot refills to an
  `attack` (respecting the draw delay, not an instant swap); a locked full hand
  of unaffordable spells is broken immediately; it is a no-op when an `attack` is
  held or the bank is non-zero.
- Determinism: same seed + inputs ⇒ bit-identical state, gate and guarantee
  included.

## Out of scope

- Cost is a flat per-card amount; no per-card or per-set cost tuning.
- Empower magnitude (+20%/point) and the interrupt mechanic (spec 023) are
  unchanged.
- The legacy catalog game and balance harness are untouched.
