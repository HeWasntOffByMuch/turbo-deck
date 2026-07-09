import {
  discardFromHand,
  drawIntoSlot,
  HAND_SIZE,
  initSpellDeck,
  type SpellCard,
  type SpellDeck,
  type SpellId,
} from '../cards/spells.js';
import { resolveSynergies } from '../cards/synergy.js';
import { Rng } from '../shared/prng.js';
import { initCombat, step as combatStep } from '../sim/combat.js';
import { TICK_RATE } from '../sim/constants.js';
import { type CombatState, type ExternalEffect, type InputFrame, type SimEvent } from '../sim/types.js';

/**
 * Composition root for the spell-card game (spec 018): the only place a played
 * card becomes a sim effect. It owns the deck alongside the combat sim and
 * threads them deterministically -- the same (seed, inputs) always replays to
 * the same state.
 *
 * The interesting piece is the synergy window. Playing a card does not fire an
 * effect immediately: it drops the card into a short buffer. Any further cards
 * played before the window closes join the buffer, and when it closes they are
 * resolved together -- two of the same card fuse into a stronger effect. Cards
 * leave the hand the instant they are played; the slot only refills a longer
 * draw-delay later, so cycling the hand costs you options.
 */

/** How long the window stays open for follow-up cards after the first play (0.25s). */
export const SYNERGY_WINDOW_TICKS = Math.round(0.25 * TICK_RATE);

/**
 * A spent hand slot refills only after this delay -- long enough (roughly an
 * enemy's slam cadence) that you cannot answer every threat with a fresh card.
 */
export const CARD_DRAW_DELAY_TICKS = Math.round(1.5 * TICK_RATE);

export interface SpellGameState {
  readonly combat: CombatState;
  readonly deck: SpellDeck;
  /** Per hand slot: the tick its delayed refill draws, or null if not pending. */
  readonly refillAtTick: readonly (number | null)[];
  /** Ids of cards played into the open synergy window, in play order. */
  readonly windowCards: readonly SpellId[];
  /** Tick the open window resolves, or null when no window is open. */
  readonly windowClosesAtTick: number | null;
}

export interface SpellInput {
  readonly moveX: -1 | 0 | 1;
  readonly moveY: -1 | 0 | 1;
  /** Aim direction (player -> cursor) for cones, rects and dashes. */
  readonly aimX: number;
  readonly aimY: number;
  /** Cursor world point for target-origin AOEs (meteor, bury feet). */
  readonly targetX: number;
  readonly targetY: number;
  /** Play the card in this hand slot into the synergy window. */
  readonly playHandIndex?: 0 | 1 | 2 | 3;
  /** Summon the next escalating wave. */
  readonly spawnWave?: boolean;
}

export type SpellGameEvent =
  | { readonly kind: 'cardPlayed'; readonly index: number; readonly id: SpellId }
  | { readonly kind: 'playIgnoredEmptySlot' }
  | { readonly kind: 'spellsResolved'; readonly ids: readonly SpellId[] }
  | SimEvent;

export function initSpellGame(seed: number, ids?: readonly SpellId[]): SpellGameState {
  return {
    // Wave mode: the arena starts empty; the Spawn Wave control populates it.
    combat: initCombat(seed, { ambientSpawner: false, initialEnemies: 0 }),
    deck: initSpellDeck(Rng.fromSeed(seed), ids),
    refillAtTick: Array.from({ length: HAND_SIZE }, () => null),
    windowCards: [],
    windowClosesAtTick: null,
  };
}

export function stepSpellGame(state: SpellGameState, input: SpellInput): { state: SpellGameState; events: SpellGameEvent[] } {
  const events: SpellGameEvent[] = [];
  let deck = state.deck;
  let windowCards = state.windowCards;
  let windowClosesAtTick = state.windowClosesAtTick;
  // Slots emptied this tick; their delayed refill is scheduled after combat steps.
  const emptied: number[] = [];

  // --- Play a card into the synergy window ---
  if (input.playHandIndex !== undefined) {
    const idx = input.playHandIndex;
    const card: SpellCard | null = deck.hand[idx];
    if (card) {
      deck = discardFromHand(deck, idx).deck;
      emptied.push(idx);
      windowCards = [...windowCards, card.id];
      // The first card of a window arms the timer; later plays just join the buffer.
      if (windowClosesAtTick === null) windowClosesAtTick = state.combat.tick + SYNERGY_WINDOW_TICKS;
      events.push({ kind: 'cardPlayed', index: idx, id: card.id });
    } else {
      events.push({ kind: 'playIgnoredEmptySlot' });
    }
  }

  // --- Resolve the window if it is due (the tick advances in combatStep) ---
  const tick = state.combat.tick + 1;
  let externalEffect: ExternalEffect | undefined;
  let resolvedIds: readonly SpellId[] | null = null;
  if (windowClosesAtTick !== null && tick >= windowClosesAtTick) {
    resolvedIds = windowCards;
    const spells = resolveSynergies(windowCards);
    externalEffect = { kind: 'castSpells', spells, aimX: input.aimX, aimY: input.aimY, targetX: input.targetX, targetY: input.targetY };
    windowCards = [];
    windowClosesAtTick = null;
  }

  const combatInput: InputFrame = {
    moveX: input.moveX,
    moveY: input.moveY,
    // Attacks are cards; the sim's built-in melee is never triggered here.
    attack: false,
    aimX: input.aimX,
    aimY: input.aimY,
    parry: false,
    dodge: false,
    ...(externalEffect ? { externalEffect } : {}),
    ...(input.spawnWave ? { spawnWave: true } : {}),
  };

  const combatResult = combatStep(state.combat, combatInput);
  events.push(...combatResult.events);
  if (resolvedIds !== null) events.push({ kind: 'spellsResolved', ids: resolvedIds });

  // Schedule delayed refills for slots emptied this tick, then draw any now due.
  const refillAtTick = [...state.refillAtTick];
  for (const slot of emptied) refillAtTick[slot] = tick + CARD_DRAW_DELAY_TICKS;
  for (let slot = 0; slot < HAND_SIZE; slot++) {
    const at = refillAtTick[slot];
    if (at !== null && at !== undefined && tick >= at) {
      deck = drawIntoSlot(deck, slot).deck;
      refillAtTick[slot] = null;
    }
  }

  return { state: { combat: combatResult.state, deck, refillAtTick, windowCards, windowClosesAtTick }, events };
}
