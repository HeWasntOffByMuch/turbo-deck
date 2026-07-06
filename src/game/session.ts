import { drawBonusCard, initDeck, useBonusCard, useCard } from '../cards/deck.js';
import { getActiveSynergies } from '../cards/synergy.js';
import type { Catalog, CardEffect, DeckState, SynergyDef } from '../cards/types.js';
import { Rng } from '../shared/prng.js';
import { initCombat, step as combatStep } from '../sim/combat.js';
import type { CombatState, ExternalEffect, InputFrame, SimEvent } from '../sim/types.js';

export interface GameState {
  readonly combat: CombatState;
  readonly deck: DeckState;
}

export interface GameInput {
  readonly moveX: -1 | 0 | 1;
  readonly moveY: -1 | 0 | 1;
  readonly attack: boolean;
  readonly aimX: number;
  readonly aimY: number;
  readonly parry: boolean;
  readonly dodge: boolean;
  readonly playHandIndex?: 0 | 1 | 2;
  readonly playBonusCard?: boolean;
}

export type GameEvent =
  | { readonly kind: 'cardPlayed'; readonly handIndex: number; readonly defId: string }
  | { readonly kind: 'bonusCardPlayed'; readonly defId: string }
  | { readonly kind: 'bonusCardDrawn' }
  | { readonly kind: 'playCardIgnoredEmptySlot' }
  | SimEvent;

export function initGame(seed: number, defIds: readonly string[]): GameState {
  return {
    combat: initCombat(seed),
    deck: initDeck(defIds, Rng.fromSeed(seed)),
  };
}

function effectToExternalEffect(effect: CardEffect, cost: number, synergies: readonly SynergyDef[]): ExternalEffect {
  let amount = effect.amount;
  let manaCost = cost;
  for (const synergy of synergies) {
    if (synergy.effect.kind === 'damageMultiplier' && effect.kind !== 'heal') {
      amount *= synergy.effect.multiplier;
    } else if (synergy.effect.kind === 'manaRefund') {
      manaCost = Math.max(0, manaCost - synergy.effect.amount);
    }
  }

  if (effect.kind === 'damage') return { kind: 'damageEnemy', manaCost, amount };
  if (effect.kind === 'heal') return { kind: 'healPlayer', manaCost, amount };
  return { kind: 'buffPlayerDamage', manaCost, amount, durationTicks: effect.durationTicks };
}

export function stepGame(
  state: GameState,
  input: GameInput,
  catalog: Catalog,
  synergyDefs: readonly SynergyDef[],
): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  let deck = state.deck;
  let externalEffect: ExternalEffect | undefined;

  if (input.playHandIndex !== undefined) {
    const card = deck.hand[input.playHandIndex];
    if (card) {
      const def = catalog.get(card.defId);
      if (def) {
        const synergies = getActiveSynergies(deck.hand, synergyDefs, catalog);
        externalEffect = effectToExternalEffect(def.effect, def.cost, synergies);
        deck = useCard(deck, input.playHandIndex).state;
        events.push({ kind: 'cardPlayed', handIndex: input.playHandIndex, defId: card.defId });
      }
    } else {
      events.push({ kind: 'playCardIgnoredEmptySlot' });
    }
  } else if (input.playBonusCard === true && deck.bonusSlot) {
    const card = deck.bonusSlot;
    const def = catalog.get(card.defId);
    if (def) {
      const synergies = getActiveSynergies(deck.hand, synergyDefs, catalog);
      externalEffect = effectToExternalEffect(def.effect, def.cost, synergies);
      const used = useBonusCard(deck);
      if (used) {
        deck = used.state;
        events.push({ kind: 'bonusCardPlayed', defId: card.defId });
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
  };

  const combatResult = combatStep(state.combat, combatInput);
  events.push(...combatResult.events);

  if (combatResult.events.some((event) => event.kind === 'perfectDefense')) {
    deck = drawBonusCard(deck);
    events.push({ kind: 'bonusCardDrawn' });
  }

  return { state: { combat: combatResult.state, deck }, events };
}
