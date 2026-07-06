import { CARD_CATALOG } from '../cards/catalog.js';
import type { GameInput, GameState } from '../game/session.js';
import { ATTACK_RANGE } from '../sim/constants.js';

/**
 * A deterministic, moderately-skilled bot policy: not game logic, just a
 * stand-in for a consistent player so that win-rate differences between
 * archetypes reflect deck composition rather than bot skill variance.
 */
export function botInput(state: GameState, plannedReactionTick: number | null, tick: number): GameInput {
  const { player, enemy } = state.combat;
  const distance = enemy.position - player.position;
  const inRange = Math.abs(distance) <= ATTACK_RANGE;
  const moveDir: -1 | 0 | 1 = inRange ? 0 : distance > 0 ? 1 : -1;
  const defend = enemy.phase === 'windup' && plannedReactionTick === tick;

  let playHandIndex: 0 | 1 | 2 | undefined;
  let playBonusCard = false;

  if (state.deck.bonusSlot) {
    const def = CARD_CATALOG.get(state.deck.bonusSlot.defId);
    if (def && def.cost <= player.mana) playBonusCard = true;
  }
  if (!playBonusCard) {
    for (let i = 0; i < state.deck.hand.length; i++) {
      const card = state.deck.hand[i];
      if (!card) continue;
      const def = CARD_CATALOG.get(card.defId);
      if (def && def.cost <= player.mana) {
        playHandIndex = i as 0 | 1 | 2;
        break;
      }
    }
  }

  return {
    moveDir,
    attack: inRange,
    parry: defend,
    dodge: false,
    ...(playHandIndex !== undefined ? { playHandIndex } : {}),
    ...(playBonusCard ? { playBonusCard } : {}),
  };
}
