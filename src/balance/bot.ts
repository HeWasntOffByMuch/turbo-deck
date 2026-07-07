import { CARD_CATALOG } from '../cards/catalog.js';
import type { GameInput, GameState } from '../game/session.js';
import { ENEMY_RADIUS, PLAYER_ATTACK_RANGE } from '../sim/constants.js';
import type { Vec2 } from '../sim/types.js';

function distanceSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * A deterministic, moderately-skilled bot policy: not game logic, just a
 * stand-in for a consistent player so that win-rate differences between
 * archetypes reflect deck composition rather than bot skill variance.
 */
export function botInput(state: GameState, plannedReactionTick: number | null, tick: number): GameInput {
  const { player, enemies } = state.combat;

  // Pick the nearest enemy to fight; attacking it wakes it from grazing.
  let target = enemies[0] ?? null;
  let nearestSq = target ? distanceSq(target.position, player.position) : Infinity;
  for (const enemy of enemies) {
    const d = distanceSq(enemy.position, player.position);
    if (d < nearestSq) {
      target = enemy;
      nearestSq = d;
    }
  }

  const dx = target ? target.position.x - player.position.x : 0;
  const dy = target ? target.position.y - player.position.y : 0;
  const reach = PLAYER_ATTACK_RANGE + ENEMY_RADIUS;
  const inRange = target !== null && nearestSq <= reach * reach;

  // Close in on the target when out of range; always aim at it so attacks connect.
  const moveX: -1 | 0 | 1 = inRange || !target ? 0 : dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const moveY: -1 | 0 | 1 = inRange || !target ? 0 : dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const defend = plannedReactionTick === tick && enemies.some((e) => e.behavior === 'hunting' && e.phase === 'windup');

  let playHandIndex: 0 | 1 | 2 | undefined;
  let playBonusCard = false;

  // The bot only plays ACTIVE cards; it holds passives so their modifiers stay
  // in effect, which is what lets archetypes express their builds.
  if (state.deck.bonusSlot) {
    const def = CARD_CATALOG.get(state.deck.bonusSlot.defId);
    if (def && def.kind === 'active' && def.cost <= player.mana) playBonusCard = true;
  }
  if (!playBonusCard) {
    for (let i = 0; i < state.deck.hand.length; i++) {
      const card = state.deck.hand[i];
      if (!card) continue;
      const def = CARD_CATALOG.get(card.defId);
      if (def && def.kind === 'active' && def.cost <= player.mana) {
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
