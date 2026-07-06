import { drawBonusCard, initDeck, useBonusCard, useCard } from '../cards/deck.js';
import type { ActiveEffect, Catalog, CardInstance, DeckState, PassiveEffect } from '../cards/types.js';
import { Rng } from '../shared/prng.js';
import { initCombat, step as combatStep } from '../sim/combat.js';
import { IDENTITY_MODIFIERS, type CombatState, type ExternalEffect, type InputFrame, type Modifiers, type SimEvent } from '../sim/types.js';
import { TICK_RATE } from '../sim/constants.js';

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
  | { readonly kind: 'passiveRetired'; readonly defId: string }
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

function activeEffectToExternalEffect(effect: ActiveEffect, cost: number): ExternalEffect {
  if (effect.kind === 'damage') return { kind: 'damageEnemy', manaCost: cost, amount: effect.amount };
  if (effect.kind === 'heal') return { kind: 'healPlayer', manaCost: cost, amount: effect.amount };
  return { kind: 'buffPlayerDamage', manaCost: cost, amount: effect.amount, durationTicks: effect.durationTicks };
}

function foldPassive(mods: Modifiers, p: PassiveEffect): Modifiers {
  switch (p.kind) {
    case 'attackDamage':
      return { ...mods, attackDamageBonus: mods.attackDamageBonus + p.amount };
    case 'nthStrikeDamage':
      return {
        ...mods,
        // Aggregate multiple copies: fire on the most frequent cadence, sum the bonuses.
        nthStrikeEveryN: mods.nthStrikeEveryN === 0 ? p.everyN : Math.min(mods.nthStrikeEveryN, p.everyN),
        nthStrikeBonusFraction: mods.nthStrikeBonusFraction + p.bonusFraction,
      };
    case 'healthRegen':
      return { ...mods, healthRegenPerTick: mods.healthRegenPerTick + p.perSecond / TICK_RATE };
    case 'manaRegen':
      return { ...mods, manaRegenPerTick: mods.manaRegenPerTick + p.perSecond / TICK_RATE };
    case 'healOnHurt':
      return { ...mods, healOnHurt: mods.healOnHurt + p.amount };
    case 'enemyTempo':
      return {
        ...mods,
        enemySpeedMultiplier: mods.enemySpeedMultiplier * p.speedMultiplier,
        enemyDamageMultiplier: mods.enemyDamageMultiplier * p.damageMultiplier,
      };
  }
}

/** Aggregate the passive effects of every held card (hand + bonus slot) into sim Modifiers. */
export function computeModifiers(deck: DeckState, catalog: Catalog): Modifiers {
  const held: (CardInstance | null)[] = [...deck.hand, deck.bonusSlot];
  let mods = IDENTITY_MODIFIERS;
  for (const card of held) {
    if (!card) continue;
    const def = catalog.get(card.defId);
    if (def && def.kind === 'passive') mods = foldPassive(mods, def.passive);
  }
  return mods;
}

export function stepGame(
  state: GameState,
  input: GameInput,
  catalog: Catalog,
): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  let deck = state.deck;
  let externalEffect: ExternalEffect | undefined;

  if (input.playHandIndex !== undefined) {
    const card = deck.hand[input.playHandIndex];
    if (card) {
      const def = catalog.get(card.defId);
      if (def) {
        if (def.kind === 'active') {
          externalEffect = activeEffectToExternalEffect(def.effect, def.cost);
          deck = useCard(deck, input.playHandIndex).state;
          events.push({ kind: 'cardPlayed', handIndex: input.playHandIndex, defId: card.defId });
        } else {
          // Passive: retiring it removes it from hand (its effect ends), no mana spent.
          deck = useCard(deck, input.playHandIndex).state;
          events.push({ kind: 'passiveRetired', defId: card.defId });
        }
      }
    } else {
      events.push({ kind: 'playCardIgnoredEmptySlot' });
    }
  } else if (input.playBonusCard === true && deck.bonusSlot) {
    const card = deck.bonusSlot;
    const def = catalog.get(card.defId);
    if (def) {
      const used = useBonusCard(deck);
      if (used) {
        deck = used.state;
        if (def.kind === 'active') {
          externalEffect = activeEffectToExternalEffect(def.effect, def.cost);
          events.push({ kind: 'bonusCardPlayed', defId: card.defId });
        } else {
          events.push({ kind: 'passiveRetired', defId: card.defId });
        }
      }
    }
  }

  // Modifiers reflect what is held AFTER this tick's play, so retiring a passive
  // ends its effect immediately.
  const mods = computeModifiers(deck, catalog);

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

  const combatResult = combatStep(state.combat, combatInput, mods);
  events.push(...combatResult.events);

  if (combatResult.events.some((event) => event.kind === 'perfectDefense')) {
    deck = drawBonusCard(deck);
    events.push({ kind: 'bonusCardDrawn' });
  }

  return { state: { combat: combatResult.state, deck }, events };
}
