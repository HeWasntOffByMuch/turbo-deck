import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Rng } from '../shared/prng.js';
import { cardLabel, discardFromHand, drawIntoSlot, HAND_SIZE, initStandardDeck, type PlayingCard, type StandardDeck } from './standard.js';

function allCards(deck: StandardDeck): PlayingCard[] {
  return [...deck.drawPile, ...deck.hand.filter((c): c is PlayingCard => c !== null), ...deck.discardPile];
}

function instanceIds(deck: StandardDeck): number[] {
  return allCards(deck)
    .map((c) => c.instanceId)
    .sort((a, b) => a - b);
}

describe('standard deck', () => {
  it('deals a full hand from 52 distinct instances', () => {
    const deck = initStandardDeck(Rng.fromSeed(1));
    expect(deck.hand.filter((c) => c !== null)).toHaveLength(HAND_SIZE);
    const ids = instanceIds(deck);
    expect(ids).toHaveLength(52);
    expect(new Set(ids).size).toBe(52);
    expect(ids[0]).toBe(0);
    expect(ids[51]).toBe(51);
  });

  it('is deterministic: same seed deals the same hand', () => {
    const a = initStandardDeck(Rng.fromSeed(42));
    const b = initStandardDeck(Rng.fromSeed(42));
    expect(a.hand.map((c) => c && cardLabel(c))).toEqual(b.hand.map((c) => c && cardLabel(c)));
  });

  it('discarding a card empties its slot without drawing; drawing refills it', () => {
    let deck = initStandardDeck(Rng.fromSeed(7));
    const before = instanceIds(deck);
    const spent = deck.hand[2];

    const discarded = discardFromHand(deck, 2);
    deck = discarded.deck;
    expect(discarded.card).toBe(spent);
    expect(deck.hand[2]).toBeNull(); // no instant refill
    expect(deck.hand.filter((c) => c !== null)).toHaveLength(HAND_SIZE - 1);
    expect(instanceIds(deck)).toEqual(before); // spent card now sits in discard

    const filled = drawIntoSlot(deck, 2);
    deck = filled.deck;
    expect(deck.hand[2]).not.toBeNull();
    expect(deck.hand[2]?.instanceId).not.toBe(spent?.instanceId);
    expect(deck.hand.filter((c) => c !== null)).toHaveLength(HAND_SIZE);
    expect(instanceIds(deck)).toEqual(before);
  });

  it('drawing into an already-filled slot is a no-op', () => {
    const deck = initStandardDeck(Rng.fromSeed(11));
    const occupant = deck.hand[0];
    const { deck: after, card } = drawIntoSlot(deck, 0);
    expect(card).toBe(occupant);
    expect(after).toBe(deck);
  });

  it('never loses or duplicates a card across a long random sequence of discards and draws', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 200, maxLength: 200 }),
        (seed, slots) => {
          let deck = initStandardDeck(Rng.fromSeed(seed));
          const expected = instanceIds(deck);
          for (const slot of slots) {
            // Toggle the slot: spend it if filled, refill it if empty.
            deck = deck.hand[slot] ? discardFromHand(deck, slot).deck : drawIntoSlot(deck, slot).deck;
            expect(instanceIds(deck)).toEqual(expected);
            expect(deck.hand).toHaveLength(HAND_SIZE);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
