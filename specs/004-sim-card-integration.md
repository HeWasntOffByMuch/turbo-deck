# 004 — Wire the card engine to the sim

## Problem

The sim (spec 003) and card engine (spec 002) are both pure and know
nothing about each other. Something has to own both pieces of state
together, translate a played card into the sim's generic `ExternalEffect`,
and turn a `perfectDefense` sim event into a card draw. That composition
root is the last place game rules live before rendering.

## Shape

`src/game/session.ts`:
```ts
interface GameState { combat: CombatState; deck: DeckState; }

interface GameInput {
  moveDir: -1 | 0 | 1;
  attack: boolean;
  parry: boolean;
  dodge: boolean;
  playHandIndex?: 0 | 1 | 2;   // play this hand slot this tick
  playBonusCard?: boolean;     // play the pending bonus-slot card this tick
}

type GameEvent =
  | { kind: 'cardPlayed'; handIndex: number; defId: string }
  | { kind: 'bonusCardPlayed'; defId: string }
  | { kind: 'bonusCardDrawn' }
  | { kind: 'playCardIgnoredEmptySlot' }
  | SimEvent; // re-exported combat events pass through unchanged

function initGame(seed: number, defIds: readonly string[]): GameState;
function stepGame(
  state: GameState,
  input: GameInput,
  catalog: Catalog,
  synergyDefs: readonly SynergyDef[],
): { state: GameState; events: GameEvent[] };
```

`stepGame` for one tick:
1. If `playHandIndex` names a non-empty slot: compute active synergies over
   the *current* hand (the played card still counts toward its own
   synergies), fold any active `damageMultiplier` into the card's damage
   amount and any active `manaRefund` into its mana cost, then call
   `useCard` and translate the (possibly modified) `CardEffect` into an
   `ExternalEffect` for this tick's combat step.
2. Else if `playBonusCard` is set and a bonus card is pending: same
   translation, via `useBonusCard` (no replacement draw).
3. Feed the resulting `ExternalEffect` (if any) into `combat.step` along
   with the raw movement/attack/parry/dodge fields.
4. If the sim emitted `perfectDefense` this tick, call `drawBonusCard` on
   the deck and emit `bonusCardDrawn`.

Card-effect-kind to external-effect-kind mapping is a fixed 1:1 table
(`damage`→`damageEnemy`, `heal`→`healPlayer`, `buffDamage`→
`buffPlayerDamage`); adding a new `CardEffect` kind means extending both
that table and the sim's `ExternalEffect` union, which is the one place
the "cards are just data" promise has a seam — everything else about a new
card is catalog data only.

## Invariants tested

- Playing a card whose effect is `damage` reduces enemy health by (at
  least) its base amount once synergies are folded in, and spends mana
  equal to its (possibly refunded) cost.
- A `perfectDefense` event always results in `bonusSlot` going from empty
  to occupied (or staying occupied, if one was already pending) on that
  same tick.
- Playing an empty hand slot or a bonus slot with nothing pending is a
  no-op on `GameState` (aside from the `playCardIgnoredEmptySlot` event)
  — it must not crash or desync the deck/combat state.
- Fuzz/smoke: replaying thousands of ticks of seeded-random-but-valid
  `GameInput`s never throws and never leaves `GameState` in an illegal
  state (hand length 3, card-count conservation, health/mana within
  bounds) — reusing the same invariant checks as specs 002/003 rather than
  inventing new ones.

## Out of scope

- Which synergy effects exist beyond `damageMultiplier`/`manaRefund`
  (catalog data, not this spec).
- Rendering or input capture (spec 005).
- Balance/tuning of specific cards (spec 006, the balance harness).
