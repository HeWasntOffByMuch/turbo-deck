import { describe, expect, it } from 'vitest';
import { Rng } from '../shared/prng.js';
import {
  addCard,
  deckCardIds,
  discardFromHand,
  drawIntoSlot,
  HAND_SIZE,
  initSpellDeck,
  removeOneCard,
  STARTING_DECK,
  upgradeOneCard,
  type SpellCard,
  type SpellDeck,
  type SpellId,
} from './spells.js';

function handIds(deck: SpellDeck): (string | null)[] {
  return deck.hand.map((c) => (c ? c.id : null));
}

/** Every card across all piles. */
function allCards(deck: SpellDeck): SpellCard[] {
  return [...deck.drawPile, ...deck.hand.filter((c): c is SpellCard => c !== null), ...deck.discardPile];
}

function countId(deck: SpellDeck, id: SpellId): number {
  return allCards(deck).filter((c) => c.id === id).length;
}

describe('spell deck', () => {
  it('deals a full hand of four from the nine-card starting deck', () => {
    const deck = initSpellDeck(Rng.fromSeed(1));
    expect(deck.hand.filter((c) => c !== null)).toHaveLength(HAND_SIZE);
    expect(deck.drawPile).toHaveLength(STARTING_DECK.length - HAND_SIZE);
    expect(deck.discardPile).toHaveLength(0);
    // Every dealt card is one of the starting ids.
    for (const card of deck.hand) if (card) expect(STARTING_DECK).toContain(card.id);
  });

  it('is deterministic for a given seed', () => {
    expect(handIds(initSpellDeck(Rng.fromSeed(42)))).toEqual(handIds(initSpellDeck(Rng.fromSeed(42))));
  });

  it('discardFromHand empties the slot and banks the card', () => {
    const deck = initSpellDeck(Rng.fromSeed(3));
    const played = deck.hand[1];
    const { deck: after, card } = discardFromHand(deck, 1);
    expect(after.hand[1]).toBeNull();
    expect(card).toBe(played);
    expect(after.discardPile).toContain(played);
  });

  it('drawIntoSlot refills an empty slot and is a no-op on a filled one', () => {
    let deck = initSpellDeck(Rng.fromSeed(4));
    const occupant = deck.hand[0];
    expect(drawIntoSlot(deck, 0).card).toBe(occupant); // filled: unchanged
    deck = discardFromHand(deck, 0).deck;
    const refilled = drawIntoSlot(deck, 0);
    expect(refilled.deck.hand[0]).not.toBeNull();
    expect(refilled.card).toBe(refilled.deck.hand[0]);
  });

  it('reshuffles the discard once the draw pile is exhausted', () => {
    let deck = initSpellDeck(Rng.fromSeed(7));
    // Drain everything: repeatedly play slot 0 then immediately refill it.
    let draws = 0;
    for (let i = 0; i < STARTING_DECK.length + 2; i++) {
      if (deck.hand[0]) {
        deck = discardFromHand(deck, 0).deck;
        const r = drawIntoSlot(deck, 0);
        deck = r.deck;
        if (r.card) draws++;
      }
    }
    // With a reshuffle we can keep drawing well past the initial pile size.
    expect(draws).toBeGreaterThan(STARTING_DECK.length - HAND_SIZE);
  });
});

describe('deck edits (wave rewards)', () => {
  it('deckCardIds lists the distinct ids in the deck', () => {
    const ids = deckCardIds(initSpellDeck(Rng.fromSeed(1)));
    expect(new Set(ids)).toEqual(new Set(['dash', 'attack', 'fireBlast', 'blazeAura']));
  });

  it('removeOneCard drops exactly one copy', () => {
    const deck = initSpellDeck(Rng.fromSeed(2));
    const before = countId(deck, 'dash');
    const after = removeOneCard(deck, 'dash');
    expect(countId(after, 'dash')).toBe(before - 1);
    expect(allCards(after)).toHaveLength(allCards(deck).length - 1);
  });

  it('upgradeOneCard raises one copy\'s level and leaves counts unchanged', () => {
    const deck = initSpellDeck(Rng.fromSeed(3));
    const after = upgradeOneCard(deck, 'attack');
    expect(countId(after, 'attack')).toBe(countId(deck, 'attack'));
    const levels = allCards(after).filter((c) => c.id === 'attack').map((c) => c.level).sort();
    expect(levels.at(-1)).toBe(2); // exactly one bumped
    expect(levels.filter((l) => l === 2)).toHaveLength(1);
  });

  it('addCard adds one fresh level-1 copy with a unique instanceId', () => {
    const deck = initSpellDeck(Rng.fromSeed(4));
    const after = addCard(deck, 'meteorStrike');
    expect(countId(after, 'meteorStrike')).toBe(1);
    const ids = allCards(after).map((c) => c.instanceId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate instance ids
    expect(allCards(after).find((c) => c.id === 'meteorStrike')?.level).toBe(1);
  });
});
