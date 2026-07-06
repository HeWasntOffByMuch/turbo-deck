import { shuffle } from '../shared/prng.js';
import type { Rng } from '../shared/prng.js';
import { HAND_SIZE, type CardInstance, type DeckState, type MutableHand } from './types.js';

interface DrawResult {
  card: CardInstance | null;
  drawPile: CardInstance[];
  discardPile: CardInstance[];
  rng: Rng;
}

/**
 * Draw one card from drawPile, reshuffling discardPile into a fresh
 * drawPile if drawPile is empty. Returns `card: null` only when both were
 * empty to begin with -- i.e. the deck is genuinely exhausted.
 */
function drawOne(drawPile: readonly CardInstance[], discardPile: readonly CardInstance[], rng: Rng): DrawResult {
  if (drawPile.length > 0) {
    const [card, ...rest] = drawPile as [CardInstance, ...CardInstance[]];
    return { card, drawPile: rest, discardPile: [...discardPile], rng };
  }
  if (discardPile.length > 0) {
    const [shuffled, nextRng] = shuffle(discardPile, rng);
    const [card, ...rest] = shuffled as [CardInstance, ...CardInstance[]];
    return { card, drawPile: rest, discardPile: [], rng: nextRng };
  }
  return { card: null, drawPile: [], discardPile: [...discardPile], rng };
}

export function initDeck(defIds: readonly string[], rng: Rng): DeckState {
  const instances: CardInstance[] = defIds.map((defId, i) => ({ instanceId: i, defId }));
  const [shuffled, afterShuffle] = shuffle(instances, rng);

  let drawPile = shuffled;
  let currentRng = afterShuffle;
  const hand: MutableHand = [null, null, null];
  for (let i = 0; i < HAND_SIZE; i++) {
    const drawn = drawOne(drawPile, [], currentRng);
    hand[i] = drawn.card;
    drawPile = drawn.drawPile;
    currentRng = drawn.rng;
  }

  return {
    drawPile,
    hand,
    discardPile: [],
    bonusSlot: null,
    rng: currentRng,
  };
}

export function useCard(state: DeckState, handIndex: number): { state: DeckState; used: CardInstance } {
  const card = state.hand[handIndex];
  if (!card) {
    throw new Error(`useCard: hand slot ${handIndex} is empty`);
  }

  const drawn = drawOne(state.drawPile, state.discardPile, state.rng);
  const discardPile = drawn.card ? [...drawn.discardPile, card] : [...state.discardPile, card];

  const hand = [...state.hand] as MutableHand;
  hand[handIndex] = drawn.card;

  return {
    state: {
      drawPile: drawn.drawPile,
      hand,
      discardPile,
      bonusSlot: state.bonusSlot,
      rng: drawn.rng,
    },
    used: card,
  };
}

/** Draw a bonus card (perfect parry/dodge). No-op if one is already pending. */
export function drawBonusCard(state: DeckState): DeckState {
  if (state.bonusSlot !== null) {
    return state;
  }
  const drawn = drawOne(state.drawPile, state.discardPile, state.rng);
  return {
    drawPile: drawn.drawPile,
    hand: state.hand,
    discardPile: drawn.discardPile,
    bonusSlot: drawn.card,
    rng: drawn.rng,
  };
}

/** Consume the pending bonus card, if any. No replacement is drawn. */
export function useBonusCard(state: DeckState): { state: DeckState; used: CardInstance } | undefined {
  if (state.bonusSlot === null) {
    return undefined;
  }
  const used = state.bonusSlot;
  return {
    state: {
      ...state,
      bonusSlot: null,
      discardPile: [...state.discardPile, used],
    },
    used,
  };
}
