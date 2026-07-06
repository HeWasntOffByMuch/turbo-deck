import type { Rng } from '../shared/prng.js';

export type CardEffect =
  | { kind: 'damage'; amount: number }
  | { kind: 'heal'; amount: number }
  | { kind: 'buffDamage'; amount: number; durationTicks: number };

export type SynergyEffect =
  | { kind: 'damageMultiplier'; multiplier: number }
  | { kind: 'manaRefund'; amount: number };

export interface CardDef {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly cost: number;
  readonly effect: CardEffect;
}

export interface CardInstance {
  readonly instanceId: number;
  readonly defId: string;
}

export interface SynergyDef {
  readonly id: string;
  readonly requiredTags: readonly string[];
  readonly effect: SynergyEffect;
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
