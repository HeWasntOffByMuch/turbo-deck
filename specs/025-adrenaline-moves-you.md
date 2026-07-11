# 025 — Adrenaline is speed, not damage

## Problem

Empowering synergy damage by the whole bank (spec 023/024) snowballs and is
hard to read. Replace the payoff: **each banked point of adrenaline makes the
player walk 4% faster** (a flat, always-on movement bonus), and drop the damage
amplification entirely for now.

The rest of the economy is unchanged: `attack` builds adrenaline and interrupts;
fire/earth cards cost adrenaline to play; the generator guarantee still keeps an
`attack` in hand while broke. Only the *benefit* of holding adrenaline changes —
from bigger synergy hits to a faster walk.

## Shape

### Sim (`src/sim/`)

- `constants.ts`: `ADRENALINE_SPEED_PER_POINT = 0.04`.
- Player walk speed gains a factor `1 + ADRENALINE_SPEED_PER_POINT · adrenaline`,
  multiplied alongside the existing mis-timed slow and Burning-Speed haste. It
  reads the current bank each tick, so speed rises as you attack and falls as you
  spend on spells.

### Cards / game

- Remove `empowerSpecs` / `ADRENALINE_DAMAGE_PER_POINT` from `src/cards/synergy.ts`.
- `stepSpellGame` no longer empowers a synergy's specs; a cast still spends the
  played cards' cost (`spendAdrenaline`), so banking/spending is intact.

### Render

- The HUD gauge shows the live speed bonus (`+N% SPD`) instead of a damage bonus.

## Invariants tested

- Walk distance in one tick scales by `1 + 0.04 · adrenaline`; a zero bank walks
  at the base speed (movement tests unaffected).
- A synergy cast is no longer empowered (its specs equal the un-banked fusion),
  but still spends the cards' cost.
- Determinism: same seed + inputs ⇒ bit-identical state.

## Out of scope

- The interrupt mechanic, the play-cost gate, and the generator guarantee
  (specs 023/024) are unchanged.
- No cap or diminishing returns on the speed bonus beyond the `MAX_ADRENALINE`
  cap on the bank itself.
