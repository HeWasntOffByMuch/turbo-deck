import { shuffle } from '../shared/prng.js';
import type { Rng } from '../shared/prng.js';

/**
 * The spell-card model (spec 018). Cards carry only an identity -- their id and
 * which set they belong to. What a card *does* (its geometry and how copies
 * fuse) lives in `synergy.ts`; how a played hand becomes a sim effect lives in
 * the game layer. This file is pure data + a hand-of-4 deck, threading the
 * seeded Rng immutably, with no sim or render dependencies.
 */

export type SpellId =
  // Regular cards, present from the start of any run.
  | 'attack'
  | 'dash'
  // Fire set.
  | 'fireBlast'
  | 'blazeAura'
  | 'meteorStrike'
  // Earth set.
  | 'groundStomp'
  | 'rockyRaise'
  | 'buryFeet';

export type CardSet = 'regular' | 'fire' | 'earth';

export interface SpellCardDef {
  readonly id: SpellId;
  readonly name: string;
  readonly set: CardSet;
  /** One-line reminder of the base effect, for the HUD. */
  readonly blurb: string;
}

export const SPELL_CARDS: Record<SpellId, SpellCardDef> = {
  attack: { id: 'attack', name: 'Attack', set: 'regular', blurb: 'Cone strike' },
  dash: { id: 'dash', name: 'Dash', set: 'regular', blurb: 'Lunge toward the cursor' },
  fireBlast: { id: 'fireBlast', name: 'Fire Blast', set: 'fire', blurb: 'Damage cone' },
  blazeAura: { id: 'blazeAura', name: 'Blaze Aura', set: 'fire', blurb: 'Burning aura (DOT)' },
  meteorStrike: { id: 'meteorStrike', name: 'Meteor Strike', set: 'fire', blurb: 'Aimed AOE' },
  groundStomp: { id: 'groundStomp', name: 'Ground Stomp', set: 'earth', blurb: 'Forward line hit' },
  rockyRaise: { id: 'rockyRaise', name: 'Rocky Raise', set: 'earth', blurb: 'Shield (~8s)' },
  buryFeet: { id: 'buryFeet', name: 'Bury Feet', set: 'earth', blurb: 'Aimed AOE stun' },
};

/** The deck a run starts with (spec 018): 3 dash, 3 attack, 2 fire blast, 1 blaze aura. */
export const STARTING_DECK: readonly SpellId[] = [
  'dash',
  'dash',
  'dash',
  'attack',
  'attack',
  'attack',
  'fireBlast',
  'fireBlast',
  'blazeAura',
];

export const HAND_SIZE = 4;

export interface SpellCard {
  /** Stable identity within a deck; the renderer diffs on it to animate. */
  readonly instanceId: number;
  readonly id: SpellId;
}

export type SpellHand = readonly [
  SpellCard | null,
  SpellCard | null,
  SpellCard | null,
  SpellCard | null,
];

export interface SpellDeck {
  readonly drawPile: readonly SpellCard[];
  readonly hand: SpellHand;
  readonly discardPile: readonly SpellCard[];
  readonly rng: Rng;
}

interface DrawResult {
  readonly card: SpellCard | null;
  readonly drawPile: readonly SpellCard[];
  readonly discardPile: readonly SpellCard[];
  readonly rng: Rng;
}

/**
 * Draw one card, reshuffling the discard pile into a fresh draw pile when the
 * draw pile is empty. `card` is null only when both piles are exhausted.
 */
function drawOne(drawPile: readonly SpellCard[], discardPile: readonly SpellCard[], rng: Rng): DrawResult {
  if (drawPile.length > 0) {
    const [card, ...rest] = drawPile as [SpellCard, ...SpellCard[]];
    return { card, drawPile: rest, discardPile, rng };
  }
  if (discardPile.length > 0) {
    const [shuffled, nextRng] = shuffle(discardPile, rng);
    const [card, ...rest] = shuffled as [SpellCard, ...SpellCard[]];
    return { card, drawPile: rest, discardPile: [], rng: nextRng };
  }
  return { card: null, drawPile, discardPile, rng };
}

/** Build a deck from a list of spell ids (defaults to the starting deck), then deal a hand of four. */
export function initSpellDeck(rng: Rng, ids: readonly SpellId[] = STARTING_DECK): SpellDeck {
  const cards: SpellCard[] = ids.map((id, instanceId) => ({ instanceId, id }));
  const [shuffled, afterShuffle] = shuffle(cards, rng);
  let drawPile: readonly SpellCard[] = shuffled;
  let currentRng = afterShuffle;
  const hand: (SpellCard | null)[] = [null, null, null, null];
  for (let i = 0; i < HAND_SIZE; i++) {
    const drawn = drawOne(drawPile, [], currentRng);
    hand[i] = drawn.card;
    drawPile = drawn.drawPile;
    currentRng = drawn.rng;
  }
  return { drawPile, hand: hand as unknown as SpellHand, discardPile: [], rng: currentRng };
}

/**
 * Spend the card in `index`: discard it and leave the slot empty. The
 * replacement is drawn separately, via `drawIntoSlot`, so callers can impose a
 * draw-delay cooldown between spending a card and its refill.
 */
export function discardFromHand(deck: SpellDeck, index: number): { deck: SpellDeck; card: SpellCard } {
  const card = deck.hand[index];
  if (!card) throw new Error(`discardFromHand: hand slot ${index} is empty`);
  const hand = [...deck.hand] as (SpellCard | null)[];
  hand[index] = null;
  return {
    deck: { ...deck, hand: hand as unknown as SpellHand, discardPile: [...deck.discardPile, card] },
    card,
  };
}

/**
 * Draw one card into the empty `index`, reshuffling the discard pile when the
 * draw pile runs dry. A no-op (returning the current occupant) if the slot is
 * already filled; `card` is null only when the whole deck is exhausted.
 */
export function drawIntoSlot(deck: SpellDeck, index: number): { deck: SpellDeck; card: SpellCard | null } {
  const occupant = deck.hand[index];
  if (occupant) return { deck, card: occupant };
  const drawn = drawOne(deck.drawPile, deck.discardPile, deck.rng);
  const hand = [...deck.hand] as (SpellCard | null)[];
  hand[index] = drawn.card;
  return {
    deck: { drawPile: drawn.drawPile, hand: hand as unknown as SpellHand, discardPile: drawn.discardPile, rng: drawn.rng },
    card: drawn.card,
  };
}
