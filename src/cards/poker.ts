import type { PlayingCard, Rank } from './standard.js';
import { HAND_SIZE } from './standard.js';

/**
 * Poker classification of a four-card hand (spec 015). Pure and total: any array
 * of cards (0..HAND_SIZE) yields a category. The `strength` ordinal is what the
 * stance formula scales against, so it is the single source of "how good is this
 * hand". A full house needs five cards, so it is absent here; the ranking is the
 * common four-card variant order, where trips is rarer than a flush or straight
 * and four of a kind edges out the straight flush.
 */

export type PokerCategory =
  | 'highCard'
  | 'pair'
  | 'twoPair'
  | 'straight'
  | 'flush'
  | 'trips'
  | 'straightFlush'
  | 'fourKind';

/** Ordered weakest..strongest; the index is the `strength` ordinal (0..7). */
export const POKER_ORDER: readonly PokerCategory[] = [
  'highCard',
  'pair',
  'twoPair',
  'straight',
  'flush',
  'trips',
  'straightFlush',
  'fourKind',
];

/** Strongest strength ordinal (four of a kind); what the stance tier scales against. */
export const MAX_POKER_STRENGTH = POKER_ORDER.length - 1;

export const POKER_LABELS: Readonly<Record<PokerCategory, string>> = {
  highCard: 'High Card',
  pair: 'Pair',
  twoPair: 'Two Pair',
  straight: 'Straight',
  flush: 'Flush',
  trips: 'Three of a Kind',
  straightFlush: 'Straight Flush',
  fourKind: 'Four of a Kind',
};

export interface PokerResult {
  readonly category: PokerCategory;
  /** Index of `category` in POKER_ORDER, 0 (high card) .. MAX_POKER_STRENGTH. */
  readonly strength: number;
}

/** True if the four distinct ranks form a run, counting A as low for the wheel. */
function isStraight(ranks: readonly Rank[]): boolean {
  if (ranks.length !== HAND_SIZE) return false;
  const unique = [...new Set(ranks)].sort((a, b) => a - b);
  if (unique.length !== HAND_SIZE) return false;
  if ((unique[HAND_SIZE - 1] as number) - (unique[0] as number) === HAND_SIZE - 1) return true;
  // Wheel: A-2-3-4 (ace counts low).
  return unique[0] === 2 && unique[1] === 3 && unique[2] === 4 && unique[3] === 14;
}

export function evaluateHand(cards: readonly PlayingCard[]): PokerResult {
  const byRank = new Map<Rank, number>();
  for (const card of cards) byRank.set(card.rank, (byRank.get(card.rank) ?? 0) + 1);
  const multiplicities = [...byRank.values()].sort((a, b) => b - a);

  const flush = cards.length === HAND_SIZE && cards.every((c) => c.suit === cards[0]?.suit);
  const straight = isStraight(cards.map((c) => c.rank));

  const category = classify(multiplicities, flush, straight);
  return { category, strength: POKER_ORDER.indexOf(category) };
}

function classify(multiplicities: readonly number[], flush: boolean, straight: boolean): PokerCategory {
  const [top = 0, second = 0] = multiplicities;
  if (top === 4) return 'fourKind';
  if (straight && flush) return 'straightFlush';
  if (top === 3) return 'trips';
  if (flush) return 'flush';
  if (straight) return 'straight';
  if (top === 2 && second === 2) return 'twoPair';
  if (top === 2) return 'pair';
  return 'highCard';
}
