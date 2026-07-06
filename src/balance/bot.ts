import { CARD_CATALOG } from '../cards/catalog.js';
import type { GameInput, GameState } from '../game/session.js';
import { ENEMY_RADIUS, PLAYER_ATTACK_RANGE } from '../sim/constants.js';

/**
 * A deterministic, moderately-skilled bot policy: not game logic, just a
 * stand-in for a consistent player so that win-rate differences between
 * archetypes reflect deck composition rather than bot skill variance.
 */
export function botInput(state: GameState, plannedReactionTick: number | null, tick: number): GameInput {
  const { player, enemy } = state.combat;
  const dx = enemy.position.x - player.position.x;
  const dy = enemy.position.y - player.position.y;
  const distSq = dx * dx + dy * dy;
  const reach = PLAYER_ATTACK_RANGE + ENEMY_RADIUS;
  const inRange = distSq <= reach * reach;

  // Close in on the enemy when out of range; always aim at it so attacks connect.
  const moveX: -1 | 0 | 1 = inRange ? 0 : dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const moveY: -1 | 0 | 1 = inRange ? 0 : dy > 0 ? 1 : dy < 0 ? -1 : 0;
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
    moveX,
    moveY,
    attack: inRange,
    aimX: dx,
    aimY: dy,
    parry: defend,
    dodge: false,
    ...(playHandIndex !== undefined ? { playHandIndex } : {}),
    ...(playBonusCard ? { playBonusCard } : {}),
  };
}
