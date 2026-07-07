import { shuffle } from '../shared/prng.js';
import type { Rng } from '../shared/prng.js';

/**
 * A standard 52-card deck, for the poker-combo prototype (spec 014). This is a
 * parallel card model to the catalog/deck engine used by the legacy game: cards
 * carry only a suit and a rank, and their meaning (an action, or a slice of a
 * poker hand) is decided by the game/cards layers on top, not stored here.
 *
 * Pure data + pure functions, threading the seeded Rng immutably -- no sim or
 * render dependencies, identical in Node or the browser.
 */

export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades';

/** 2..10 face value; 11=J, 12=Q, 13=K, 14=A (ace high; low only for the wheel). */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export const SUITS: readonly Suit[] = ['clubs', 'diamonds', 'hearts', 'spades'];
export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export interface PlayingCard {
  /** Stable identity within a deck; the renderer diffs on it to animate. */
  readonly instanceId: number;
  readonly suit: Suit;
  readonly rank: Rank;
}

export const HAND_SIZE = 5;

export type StandardHand = readonly [
  PlayingCard | null,
  PlayingCard | null,
  PlayingCard | null,
  PlayingCard | null,
  PlayingCard | null,
];

export interface StandardDeck {
  readonly drawPile: readonly PlayingCard[];
  readonly hand: StandardHand;
  readonly discardPile: readonly PlayingCard[];
  readonly rng: Rng;
}

/** Short display label, e.g. "A♠", "10♥". */
export function cardLabel(card: PlayingCard): string {
  const rank =
    card.rank === 14 ? 'A' : card.rank === 13 ? 'K' : card.rank === 12 ? 'Q' : card.rank === 11 ? 'J' : String(card.rank);
  const glyph = card.suit === 'clubs' ? '♣' : card.suit === 'diamonds' ? '♦' : card.suit === 'hearts' ? '♥' : '♠';
  return `${rank}${glyph}`;
}

function buildDeck(): PlayingCard[] {
  const cards: PlayingCard[] = [];
  let instanceId = 0;
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      cards.push({ instanceId, suit, rank });
      instanceId++;
    }
  }
  return cards;
}

interface DrawResult {
  readonly card: PlayingCard | null;
  readonly drawPile: readonly PlayingCard[];
  readonly discardPile: readonly PlayingCard[];
  readonly rng: Rng;
}

/**
 * Draw one card, reshuffling the discard pile into a fresh draw pile when the
 * draw pile is empty. `card` is null only when both piles are exhausted.
 */
function drawOne(drawPile: readonly PlayingCard[], discardPile: readonly PlayingCard[], rng: Rng): DrawResult {
  if (drawPile.length > 0) {
    const [card, ...rest] = drawPile as [PlayingCard, ...PlayingCard[]];
    return { card, drawPile: rest, discardPile, rng };
  }
  if (discardPile.length > 0) {
    const [shuffled, nextRng] = shuffle(discardPile, rng);
    const [card, ...rest] = shuffled as [PlayingCard, ...PlayingCard[]];
    return { card, drawPile: rest, discardPile: [], rng: nextRng };
  }
  return { card: null, drawPile, discardPile, rng };
}

export function initStandardDeck(rng: Rng): StandardDeck {
  const [shuffled, afterShuffle] = shuffle(buildDeck(), rng);
  let drawPile: readonly PlayingCard[] = shuffled;
  let currentRng = afterShuffle;
  const hand: (PlayingCard | null)[] = [null, null, null, null, null];
  for (let i = 0; i < HAND_SIZE; i++) {
    const drawn = drawOne(drawPile, [], currentRng);
    hand[i] = drawn.card;
    drawPile = drawn.drawPile;
    currentRng = drawn.rng;
  }
  return { drawPile, hand: hand as unknown as StandardHand, discardPile: [], rng: currentRng };
}

/** Spend the card in `index`, discard it, and draw its replacement into the same slot. */
export function playFromHand(deck: StandardDeck, index: number): { deck: StandardDeck; card: PlayingCard } {
  const card = deck.hand[index];
  if (!card) throw new Error(`playFromHand: hand slot ${index} is empty`);

  const drawn = drawOne(deck.drawPile, deck.discardPile, deck.rng);
  // If the deck is genuinely exhausted the spent card still goes to discard;
  // otherwise the replacement is drawn first, then the spent card is discarded.
  const discardPile = [...drawn.discardPile, card];
  const hand = [...deck.hand] as (PlayingCard | null)[];
  hand[index] = drawn.card;

  return {
    deck: { drawPile: drawn.drawPile, hand: hand as unknown as StandardHand, discardPile, rng: drawn.rng },
    card,
  };
}

/**
 * Cash in the whole hand: discard all five and draw a fresh five. Returns the
 * spent cards so the caller can evaluate them for the combo. Empty slots (a
 * fully exhausted deck) are ignored.
 */
export function activateHand(deck: StandardDeck): { deck: StandardDeck; cards: PlayingCard[] } {
  const spent = deck.hand.filter((c): c is PlayingCard => c !== null);
  let drawPile = deck.drawPile;
  let discardPile: readonly PlayingCard[] = [...deck.discardPile, ...spent];
  let rng = deck.rng;
  const hand: (PlayingCard | null)[] = [null, null, null, null, null];
  for (let i = 0; i < HAND_SIZE; i++) {
    const drawn = drawOne(drawPile, discardPile, rng);
    hand[i] = drawn.card;
    drawPile = drawn.drawPile;
    discardPile = drawn.discardPile;
    rng = drawn.rng;
  }
  return { deck: { drawPile, hand: hand as unknown as StandardHand, discardPile, rng }, cards: spent };
}
