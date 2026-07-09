import type { PlayingCard, Suit } from './standard.js';
import { evaluateHand, MAX_POKER_STRENGTH } from './poker.js';

/**
 * The two mappings that give every card a dual identity (spec 014): what a card
 * does when played *now* as a single action, and what the whole hand is worth
 * if you *hold* it and cash it in as a combo. This is where the "play it vs.
 * hold it" tension actually lives, so it stays pure and self-contained.
 *
 * Durations are expressed in seconds; the game layer converts to sim ticks so
 * this module keeps no dependency on the sim's tick rate.
 */

// --- Single-card actions: suit picks the effect, rank scales the magnitude. ---
const CLUB_BASE = 3;
const CLUB_PER_RANK = 1.5; // clubs -> damage
const HEART_BASE = 4;
const HEART_PER_RANK = 1.5; // hearts -> heal
const SPADE_BASE = 0.12;
const SPADE_PER_RANK = 0.03; // spades -> guard (damage reduction)
const SPADE_CAP = 0.8;
const GUARD_SECONDS = 1.5;
const DIAMOND_BASE = 0.1;
const DIAMOND_PER_RANK = 0.03; // diamonds -> slow
const DIAMOND_CAP = 0.7;
const SLOW_SECONDS = 1.8;

export type CardAction =
  | { readonly kind: 'damage'; readonly amount: number }
  | { readonly kind: 'heal'; readonly amount: number }
  | { readonly kind: 'guard'; readonly reductionPct: number; readonly durationSeconds: number }
  | { readonly kind: 'slow'; readonly multiplier: number; readonly durationSeconds: number };

export function cardAction(card: PlayingCard): CardAction {
  switch (card.suit) {
    case 'clubs':
      return { kind: 'damage', amount: Math.round(CLUB_BASE + card.rank * CLUB_PER_RANK) };
    case 'hearts':
      return { kind: 'heal', amount: Math.round(HEART_BASE + card.rank * HEART_PER_RANK) };
    case 'spades':
      return { kind: 'guard', reductionPct: Math.min(SPADE_CAP, SPADE_BASE + card.rank * SPADE_PER_RANK), durationSeconds: GUARD_SECONDS };
    case 'diamonds': {
      const slow = Math.min(DIAMOND_CAP, DIAMOND_BASE + card.rank * DIAMOND_PER_RANK);
      return { kind: 'slow', multiplier: 1 - slow, durationSeconds: SLOW_SECONDS };
    }
  }
}

/** One-word verb for the HUD, describing what playing this card does. */
export function actionVerb(suit: Suit): string {
  return suit === 'clubs' ? 'Damage' : suit === 'hearts' ? 'Heal' : suit === 'spades' ? 'Guard' : 'Slow';
}

// --- Combo payoff: poker strength sets the tier, suit mix sets the flavor. ---
const STANCE_ATTACK_MAX = 20; // +attack damage on a top-tier all-clubs hand
const STANCE_REDUCE_MAX = 0.7; // incoming damage reduction on an all-spades hand
const STANCE_REGEN_MAX = 12; // HP/second on an all-hearts hand
const STANCE_SLOW_MAX = 0.65; // enemy slow strength on an all-diamonds hand
const STANCE_DUR_MIN = 3;
const STANCE_DUR_PER_TIER = 0.6;
const STANCE_LOCKOUT_EXTRA = 2.5; // downtime after the stance ends before re-activating

export interface StanceGrant {
  /** Flat bonus to the player's outgoing strike damage while the stance holds. */
  readonly attackBonus: number;
  /** Fraction of incoming damage prevented (0..1). */
  readonly reductionPct: number;
  /** Health regenerated per second. */
  readonly regenPerSecond: number;
  /** Enemy speed/telegraph multiplier (<1 = slower); 1 means no slow. */
  readonly slowMultiplier: number;
  readonly durationSeconds: number;
  /** Ticks-from-now-equivalent, in seconds, before Activate is allowed again. */
  readonly lockoutSeconds: number;
}

function suitFraction(cards: readonly PlayingCard[], suit: Suit): number {
  if (cards.length === 0) return 0;
  return cards.filter((c) => c.suit === suit).length / cards.length;
}

/**
 * Turn the held hand into a stance. Poker `strength` (0..8) drives an overall
 * tier factor; each stat is that tier scaled by the matching suit's share of
 * the hand, so a flush pours everything into one stat while a mixed hand blends.
 */
export function handStance(cards: readonly PlayingCard[]): StanceGrant {
  const strength = evaluateHand(cards).strength;
  const tier = 0.15 + 0.85 * (strength / MAX_POKER_STRENGTH); // 0.15 (high card) .. 1.0 (four of a kind)
  const slowStrength = STANCE_SLOW_MAX * tier * suitFraction(cards, 'diamonds');
  return {
    attackBonus: STANCE_ATTACK_MAX * tier * suitFraction(cards, 'clubs'),
    reductionPct: STANCE_REDUCE_MAX * tier * suitFraction(cards, 'spades'),
    regenPerSecond: STANCE_REGEN_MAX * tier * suitFraction(cards, 'hearts'),
    slowMultiplier: 1 - slowStrength,
    durationSeconds: STANCE_DUR_MIN + strength * STANCE_DUR_PER_TIER,
    lockoutSeconds: STANCE_DUR_MIN + strength * STANCE_DUR_PER_TIER + STANCE_LOCKOUT_EXTRA,
  };
}
