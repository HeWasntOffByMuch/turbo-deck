import type { PlayingCard, Rank } from './standard.js';

/**
 * Poker classification of a 5-card hand (spec 014). Pure and total: any array
 * of cards (0..5) yields a category. The `strength` ordinal is what the stance
 * formula scales against, so it is the single source of "how good is this hand".
 */

export type PokerCategory =
  | 'highCard'
  | 'pair'
  | 'twoPair'
  | 'trips'
  | 'straight'
  | 'flush'
  | 'fullHouse'
  | 'fourKind'
  | 'straightFlush';

/** Ordered weakest..strongest; the index is the `strength` ordinal (0..8). */
export const POKER_ORDER: readonly PokerCategory[] = [
  'highCard',
  'pair',
  'twoPair',
  'trips',
  'straight',
  'flush',
  'fullHouse',
  'fourKind',
  'straightFlush',
];

export const POKER_LABELS: Readonly<Record<PokerCategory, string>> = {
  highCard: 'High Card',
  pair: 'Pair',
  twoPair: 'Two Pair',
  trips: 'Three of a Kind',
  straight: 'Straight',
  flush: 'Flush',
  fullHouse: 'Full House',
  fourKind: 'Four of a Kind',
  straightFlush: 'Straight Flush',
};

export interface PokerResult {
  readonly category: PokerCategory;
  /** Index of `category` in POKER_ORDER, 0 (high card) .. 8 (straight flush). */
  readonly strength: number;
}

/** True if the five distinct ranks form a run, counting A as low for the wheel. */
function isStraight(ranks: readonly Rank[]): boolean {
  if (ranks.length !== 5) return false;
  const unique = [...new Set(ranks)].sort((a, b) => a - b);
  if (unique.length !== 5) return false;
  if ((unique[4] as number) - (unique[0] as number) === 4) return true;
  // Wheel: A-2-3-4-5 (ace counts low).
  return unique[0] === 2 && unique[1] === 3 && unique[2] === 4 && unique[3] === 5 && unique[4] === 14;
}

export function evaluateHand(cards: readonly PlayingCard[]): PokerResult {
  const byRank = new Map<Rank, number>();
  for (const card of cards) byRank.set(card.rank, (byRank.get(card.rank) ?? 0) + 1);
  const multiplicities = [...byRank.values()].sort((a, b) => b - a);

  const flush = cards.length === 5 && cards.every((c) => c.suit === cards[0]?.suit);
  const straight = isStraight(cards.map((c) => c.rank));

  const category = classify(multiplicities, flush, straight);
  return { category, strength: POKER_ORDER.indexOf(category) };
}

function classify(multiplicities: readonly number[], flush: boolean, straight: boolean): PokerCategory {
  const [top = 0, second = 0] = multiplicities;
  if (straight && flush) return 'straightFlush';
  if (top === 4) return 'fourKind';
  if (top === 3 && second === 2) return 'fullHouse';
  if (flush) return 'flush';
  if (straight) return 'straight';
  if (top === 3) return 'trips';
  if (top === 2 && second === 2) return 'twoPair';
  if (top === 2) return 'pair';
  return 'highCard';
}
