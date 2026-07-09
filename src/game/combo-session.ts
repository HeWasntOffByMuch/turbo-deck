import { discardFromHand, drawIntoSlot, HAND_SIZE, initStandardDeck, type PlayingCard, type StandardDeck } from '../cards/standard.js';
import { evaluateHand, type PokerCategory } from '../cards/poker.js';
import { cardAction, handStance } from '../cards/stance.js';
import { Rng } from '../shared/prng.js';
import { initCombat, step as combatStep } from '../sim/combat.js';
import { TICK_RATE } from '../sim/constants.js';
import { type CombatState, type ExternalEffect, type InputFrame, type SimEvent } from '../sim/types.js';

/**
 * Composition root for the poker-combo prototype (spec 014): the only place a
 * card's suit/rank is translated into a sim effect. It owns a standard deck
 * alongside the combat sim and threads them deterministically -- the same
 * (seed, inputs) always replays to the same state.
 */

/**
 * A spent hand slot does not refill immediately: the replacement is delayed by
 * CARD_DRAW_DELAY_TICKS so that churning the hand for actions (or fishing for a
 * combo) is punished with a real hole in your options. It is significant on
 * purpose -- roughly the cadence of an enemy's slam -- so you cannot answer
 * every threat with a fresh card. This is the core knob for the play-vs-hold
 * balance; raise it to punish cycling harder.
 */
export const CARD_DRAW_DELAY_TICKS = Math.round(3 * TICK_RATE);

export interface ComboGameState {
  readonly combat: CombatState;
  readonly deck: StandardDeck;
  /** Per hand slot: the tick its delayed refill draws, or null if not pending. */
  readonly refillAtTick: readonly (number | null)[];
}

export interface ComboInput {
  readonly moveX: -1 | 0 | 1;
  readonly moveY: -1 | 0 | 1;
  readonly attack: boolean;
  readonly aimX: number;
  readonly aimY: number;
  readonly parry: boolean;
  readonly dodge: boolean;
  /** Play the card in this hand slot as a single suit action. */
  readonly playHandIndex?: 0 | 1 | 2 | 3;
  /** Cash the whole hand in as a poker-strength stance. */
  readonly activate?: boolean;
  /** Summon the next escalating wave. */
  readonly spawnWave?: boolean;
}

export type ComboEvent =
  | { readonly kind: 'cardPlayed'; readonly index: number; readonly card: PlayingCard }
  | { readonly kind: 'playIgnoredEmptySlot' }
  | { readonly kind: 'activated'; readonly category: PokerCategory; readonly strength: number }
  | { readonly kind: 'activateIgnoredLocked' }
  | SimEvent;

const seconds = (s: number): number => Math.round(s * TICK_RATE);

export function initComboGame(seed: number): ComboGameState {
  return {
    // Wave mode: the arena starts empty and only the Spawn Wave button populates it.
    combat: initCombat(seed, { ambientSpawner: false, initialEnemies: 0 }),
    deck: initStandardDeck(Rng.fromSeed(seed)),
    refillAtTick: Array.from({ length: HAND_SIZE }, () => null),
  };
}

/** Translate a single-card suit action into the sim's external-effect payload. */
function actionEffect(card: PlayingCard): ExternalEffect {
  const action = cardAction(card);
  switch (action.kind) {
    case 'damage':
      return { kind: 'damageEnemy', manaCost: 0, amount: action.amount };
    case 'heal':
      return { kind: 'healPlayer', manaCost: 0, amount: action.amount };
    case 'guard':
      return { kind: 'guard', reductionPct: action.reductionPct, durationTicks: seconds(action.durationSeconds) };
    case 'slow':
      return { kind: 'slowEnemies', multiplier: action.multiplier, durationTicks: seconds(action.durationSeconds) };
  }
}

export function stepComboGame(state: ComboGameState, input: ComboInput): { state: ComboGameState; events: ComboEvent[] } {
  const events: ComboEvent[] = [];
  let deck = state.deck;
  let externalEffect: ExternalEffect | undefined;
  // Slots emptied this tick; their delayed refill is scheduled after combat steps.
  const emptied: number[] = [];

  if (input.playHandIndex !== undefined) {
    const card = deck.hand[input.playHandIndex];
    if (card) {
      externalEffect = actionEffect(card);
      deck = discardFromHand(deck, input.playHandIndex).deck;
      emptied.push(input.playHandIndex);
      events.push({ kind: 'cardPlayed', index: input.playHandIndex, card });
    } else {
      events.push({ kind: 'playIgnoredEmptySlot' });
    }
  } else if (input.activate === true) {
    // Gate on the sim's lockout so we never consume the hand for a refused stance.
    if (state.combat.tick < state.combat.player.activateLockUntil) {
      events.push({ kind: 'activateIgnoredLocked' });
    } else {
      const cards = state.deck.hand.filter((c): c is PlayingCard => c !== null);
      if (cards.length > 0) {
        const { category, strength } = evaluateHand(cards);
        const grant = handStance(cards);
        externalEffect = {
          kind: 'applyStance',
          attackBonus: grant.attackBonus,
          reductionPct: grant.reductionPct,
          regenPerTick: grant.regenPerSecond / TICK_RATE,
          slowMultiplier: grant.slowMultiplier,
          durationTicks: seconds(grant.durationSeconds),
          lockoutTicks: seconds(grant.lockoutSeconds),
        };
        // Activate consumes the whole hand under the same draw-delay, so it can't
        // be used as a free "refill everything now" button.
        deck.hand.forEach((c, i) => {
          if (c) {
            deck = discardFromHand(deck, i).deck;
            emptied.push(i);
          }
        });
        events.push({ kind: 'activated', category, strength });
      }
    }
  }

  const combatInput: InputFrame = {
    moveX: input.moveX,
    moveY: input.moveY,
    attack: input.attack,
    aimX: input.aimX,
    aimY: input.aimY,
    parry: input.parry,
    dodge: input.dodge,
    ...(externalEffect ? { externalEffect } : {}),
    ...(input.spawnWave ? { spawnWave: true } : {}),
  };

  const combatResult = combatStep(state.combat, combatInput);
  const tick = combatResult.state.tick;
  events.push(...combatResult.events);

  // Schedule delayed refills for slots emptied this tick, then draw any that are due.
  const refillAtTick = [...state.refillAtTick];
  for (const slot of emptied) refillAtTick[slot] = tick + CARD_DRAW_DELAY_TICKS;
  for (let slot = 0; slot < HAND_SIZE; slot++) {
    const at = refillAtTick[slot];
    if (at !== null && at !== undefined && tick >= at) {
      deck = drawIntoSlot(deck, slot).deck;
      refillAtTick[slot] = null;
    }
  }

  return { state: { combat: combatResult.state, deck, refillAtTick }, events };
}
