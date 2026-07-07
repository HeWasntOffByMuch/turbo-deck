import { activateHand, initStandardDeck, playFromHand, type PlayingCard, type StandardDeck } from '../cards/standard.js';
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

export interface ComboGameState {
  readonly combat: CombatState;
  readonly deck: StandardDeck;
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
  readonly playHandIndex?: 0 | 1 | 2 | 3 | 4;
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

  if (input.playHandIndex !== undefined) {
    const card = deck.hand[input.playHandIndex];
    if (card) {
      externalEffect = actionEffect(card);
      deck = playFromHand(deck, input.playHandIndex).deck;
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
        deck = activateHand(deck).deck;
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
  events.push(...combatResult.events);

  return { state: { combat: combatResult.state, deck }, events };
}
