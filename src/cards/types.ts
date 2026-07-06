import type { Rng } from '../shared/prng.js';

/** One-shot effect of an active card, applied when it is played. */
export type ActiveEffect =
  | { kind: 'damage'; amount: number }
  | { kind: 'heal'; amount: number }
  | { kind: 'buffDamage'; amount: number; durationTicks: number };

/**
 * A passive card's effect, applied continuously while the card is held (in a
 * hand slot or the bonus slot). These are mechanic modifiers -- combos emerge
 * from how they stack, they are not named synergies.
 */
export type PassiveEffect =
  | { kind: 'attackDamage'; amount: number }
  | { kind: 'nthStrikeDamage'; everyN: number; bonusFraction: number }
  | { kind: 'healthRegen'; perSecond: number }
  | { kind: 'manaRegen'; perSecond: number }
  | { kind: 'healOnHurt'; amount: number }
  | { kind: 'enemyTempo'; speedMultiplier: number; damageMultiplier: number };

interface CardBase {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly cost: number;
}

export type CardDef =
  | (CardBase & { readonly kind: 'active'; readonly effect: ActiveEffect })
  | (CardBase & { readonly kind: 'passive'; readonly passive: PassiveEffect });

export interface CardInstance {
  readonly instanceId: number;
  readonly defId: string;
}

export type Catalog = ReadonlyMap<string, CardDef>;

export type MutableHand = [CardInstance | null, CardInstance | null, CardInstance | null];
export type Hand = readonly [CardInstance | null, CardInstance | null, CardInstance | null];

export interface DeckState {
  readonly drawPile: readonly CardInstance[];
  readonly hand: Hand;
  readonly discardPile: readonly CardInstance[];
  readonly bonusSlot: CardInstance | null;
  readonly rng: Rng;
}

export const HAND_SIZE = 3;
