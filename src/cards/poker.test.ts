import { describe, expect, it } from 'vitest';
import { evaluateHand, POKER_ORDER, type PokerCategory } from './poker.js';
import type { PlayingCard, Rank, Suit } from './standard.js';

let nextId = 0;
function card(suit: Suit, rank: Rank): PlayingCard {
  return { instanceId: nextId++, suit, rank };
}

/** Parse a compact "As Kh 5d" notation into cards for readable fixtures. */
function hand(spec: string): PlayingCard[] {
  const suitOf: Record<string, Suit> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };
  const rankOf: Record<string, Rank> = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
  return spec.split(/\s+/).map((tok) => {
    const suit = suitOf[tok.slice(-1)] as Suit;
    const r = tok.slice(0, -1);
    const rank = (rankOf[r] ?? Number(r)) as Rank;
    return card(suit, rank);
  });
}

describe('evaluateHand', () => {
  const cases: readonly (readonly [string, PokerCategory])[] = [
    ['2c 5d 9h Js', 'highCard'],
    ['2c 2d 9h Js', 'pair'],
    ['2c 2d 9h 9s', 'twoPair'],
    ['2c 2d 2h 9s', 'trips'],
    ['5c 6d 7h 8s', 'straight'],
    ['Ac 2d 3h 4s', 'straight'], // the wheel (ace low)
    ['Jc Qd Kh As', 'straight'], // broadway
    ['2c 5c 9c Jc', 'flush'],
    ['2c 2d 2h 2s', 'fourKind'],
    ['5c 6c 7c 8c', 'straightFlush'],
    ['Jc Qc Kc Ac', 'straightFlush'], // royal
  ];

  for (const [spec, expected] of cases) {
    it(`classifies "${spec}" as ${expected}`, () => {
      expect(evaluateHand(hand(spec)).category).toBe(expected);
    });
  }

  it('strength equals the category position in POKER_ORDER and is strictly increasing', () => {
    const strengths = cases.map(([spec]) => evaluateHand(hand(spec)).strength);
    for (const [spec, expected] of cases) {
      expect(evaluateHand(hand(spec)).strength).toBe(POKER_ORDER.indexOf(expected));
    }
    // A pair outranks a high card; a flush outranks a straight; in the four-card
    // variant trips outranks a flush; four of a kind tops the ladder.
    expect(evaluateHand(hand('2c 2d 9h Js')).strength).toBeGreaterThan(evaluateHand(hand('2c 5d 9h Js')).strength);
    expect(evaluateHand(hand('2c 5c 9c Jc')).strength).toBeGreaterThan(evaluateHand(hand('5c 6d 7h 8s')).strength);
    expect(evaluateHand(hand('2c 2d 2h 9s')).strength).toBeGreaterThan(evaluateHand(hand('2c 5c 9c Jc')).strength);
    expect(Math.max(...strengths)).toBe(POKER_ORDER.length - 1);
  });
});
