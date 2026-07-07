import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Rng } from '../shared/prng.js';
import { activateHand, cardLabel, HAND_SIZE, initStandardDeck, playFromHand, type PlayingCard, type StandardDeck } from './standard.js';

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

  it('playing a card refills only its slot and conserves the 52-card multiset', () => {
    let deck = initStandardDeck(Rng.fromSeed(7));
    const before = instanceIds(deck);
    const played = deck.hand[2];
    const { deck: next, card } = playFromHand(deck, 2);
    deck = next;
    expect(card).toBe(played);
    expect(deck.hand.filter((c) => c !== null)).toHaveLength(HAND_SIZE);
    expect(instanceIds(deck)).toEqual(before);
  });

  it('activating discards all five and draws a fresh five, conserving the deck', () => {
    let deck = initStandardDeck(Rng.fromSeed(9));
    const before = instanceIds(deck);
    const held = deck.hand.filter((c): c is PlayingCard => c !== null);
    const { deck: next, cards } = activateHand(deck);
    deck = next;
    expect(cards).toEqual(held);
    expect(deck.hand.filter((c) => c !== null)).toHaveLength(HAND_SIZE);
    expect(instanceIds(deck)).toEqual(before);
  });

  it('never loses or duplicates a card across a long random sequence of plays and activations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.array(fc.oneof(fc.constant<'activate'>('activate'), fc.integer({ min: 0, max: 4 })), { minLength: 200, maxLength: 200 }),
        (seed, ops) => {
          let deck = initStandardDeck(Rng.fromSeed(seed));
          const expected = instanceIds(deck);
          for (const op of ops) {
            deck = op === 'activate' ? activateHand(deck).deck : playFromHand(deck, op).deck;
            expect(instanceIds(deck)).toEqual(expected);
            expect(deck.hand.filter((c) => c !== null)).toHaveLength(HAND_SIZE);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
