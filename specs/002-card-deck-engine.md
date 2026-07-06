# 002 — Card/deck engine

## Problem

The hand-of-3, draw-on-use, synergy-driven card economy is the core power
fantasy of the game. It needs to exist as pure data + pure functions before
any combat sim touches it, so it's trivially property-testable and so new
cards/synergies are just data, never engine changes.

## Shape

`src/shared/prng.ts` — an immutable seeded PRNG (`Rng`, wrapping
`pure-rand`'s xoroshiro128plus) and a `shuffle(items, rng)` helper. Every
draw returns `[value, nextRng]`; nothing mutates in place, so any state that
embeds an `Rng` is a pure snapshot.

`src/cards/types.ts`:
```ts
interface CardDef {
  id: string;          // catalog id, e.g. 'fireball'
  name: string;
  tags: string[];       // keywords synergies key off of
  cost: number;          // mana cost, spent in the sim
  effect: CardEffect;    // opaque data; the sim interprets it later
}

interface CardInstance {
  instanceId: number;   // unique per physical card copy in this run
  defId: string;
}

interface SynergyDef {
  id: string;
  requiredTags: string[]; // multiset: e.g. ['fire','fire'] needs 2 fire-tagged cards
  effect: SynergyEffect;   // opaque data; the sim interprets it later
}

interface DeckState {
  drawPile: CardInstance[];
  hand: (CardInstance | null)[]; // fixed length 3
  discardPile: CardInstance[];
  bonusSlot: CardInstance | null; // perfect-parry/dodge bonus draws land here
  rng: Rng;
}
```

`src/cards/deck.ts` — pure functions, each taking and returning `DeckState`:
- `initDeck(defIds: string[], rng): DeckState` — builds one `CardInstance`
  per id, shuffles, deals an initial hand of 3 (fewer if the deck is
  smaller than 3).
- `useCard(state, handIndex): { state, used: CardInstance }` — discards the
  played card, then refills that slot: draw from `drawPile` if non-empty;
  else reshuffle `discardPile` (the pool *before* this card was added to
  it) into a new `drawPile` and draw from that; else (both were empty) the
  slot becomes `null` — the deck is exhausted.
- `drawBonusCard(state): DeckState` — draws into `bonusSlot` from the same
  draw/reshuffle/exhausted logic as `useCard`, but only if `bonusSlot` is
  currently empty; a no-op otherwise (at most one bonus card pending).
- `useBonusCard(state): { state, used: CardInstance } | undefined` —
  consumes `bonusSlot` into `discardPile` with no replacement draw;
  `undefined` if it was empty.

`src/cards/synergy.ts`:
- `getActiveSynergies(hand, synergyDefs, catalog): SynergyDef[]` — a
  synergy is active when, for every distinct tag in its `requiredTags`
  multiset, the number of hand cards carrying that tag is at least the
  number of times the tag appears in `requiredTags`. Pure function of
  (hand, defs, catalog); adding a card or synergy is a data change only.

`src/cards/catalog.ts` — a handful of example `CardDef`s and `SynergyDef`s
used by tests (and later the renderer/balance harness) to exercise real
synergy combinations.

## Invariants tested

- `hand.length` is always exactly 3 (slots may be `null`).
- Conservation: `drawPile.length + discardPile.length + hand.filter(Boolean).length + (bonusSlot ? 1 : 0)` equals the total instance count, across any sequence of `useCard`/`drawBonusCard`/`useBonusCard` calls.
- `useCard` on slot `i` either leaves `hand[i]` non-null (refilled) or leaves it `null`, and it is `null` if and only if both `drawPile` and `discardPile` were empty before this call.
- Same seed + same sequence of operations produces byte-identical resulting `DeckState` (modulo the `Rng` internal state, which is opaque but must itself be deterministic — asserted indirectly via repeated draws producing the same card order).
- `getActiveSynergies` is a pure function: same hand + defs → same result, and is order-independent with respect to which card in hand carries which required tag.

## Out of scope

- Interpreting `CardEffect`/`SynergyEffect` payloads (that's the sim's job,
  spec 004).
- Mana cost enforcement (the sim tracks and spends mana, spec 003/004).
- Any rendering of cards.
