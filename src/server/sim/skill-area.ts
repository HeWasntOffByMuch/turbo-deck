/**
 * Who an area skill lands on (spec 188).
 *
 * Pure geometry and nothing else: it is handed the caster, the aim the cast
 * captured, a shape and the candidates the caller has already filtered by
 * hostility, and it answers with the bodies inside the shape. It applies
 * nothing, rolls nothing and changes nothing -- which is what makes "an AoE
 * only affects valid targets" a property a test can assert without standing up
 * a fight.
 *
 * Three rules it shares with every other landing in this game, none of them new:
 *
 *  - **A body is caught by its edge**, not by its centre. Every shape adds the
 *    target's radius to the reach it allows, the same way `landOnTarget` and
 *    `landBlast` already do, so a big body is clipped by the rim of a blast
 *    rather than having to stand in the middle of it.
 *  - **The caster is never a candidate**, and neither is anything at zero
 *    health. Both are refused here rather than by each shape, so a fourth shape
 *    cannot forget.
 *  - **Order is the candidate order**, which the caller built by walking the
 *    world's insertion-ordered entity map. That is what makes `maxTargets`
 *    deterministic: the same fight replays and the same six bodies are picked.
 *    Sorting by distance would be a better game and a worse guarantee, and if
 *    it is ever wanted it belongs here where it is one comparator rather than
 *    at the four call sites.
 *
 * Pure. No clock, no randomness, no entity is written.
 */

import type { SkillArea } from '../data/skill-effects.js';
import type { Vec3 } from '../state/types.js';
import { isInCone } from './combat.js';
import type { ServerEntity } from './types.js';

/** The `arcCosSq` a full opening angle in degrees comes to. */
export function arcCosSqOf(angleDeg: number): number {
  // The cone test compares `cos(theta)^2` against the *half* angle, which is
  // what a caller means by "a 90-degree cone": 45 degrees either side.
  const half = (Math.max(0, Math.min(360, angleDeg)) * Math.PI) / 360;
  const cos = Math.cos(half);
  return cos * cos;
}

/** A shape's principal reach -- what `spellRangePct` and friends scale. */
export function areaReachOf(area: SkillArea): number {
  return area.shape === 'circle' ? area.radius : area.range;
}

/**
 * The same shape with its reach scaled.
 *
 * Used for Intelligence's `spellRadiusPct`, so a shaped skill widens the way a
 * Quake already does. The *secondary* dimensions -- a cone's angle, a lane's
 * width -- are deliberately left alone: shaping makes a spell reach further,
 * and a cone that also opened wider would be two effects sold as one.
 */
export function scaleArea(area: SkillArea, factor: number): SkillArea {
  const scale = Math.max(0, factor);
  if (area.shape === 'circle') return { ...area, radius: area.radius * scale };
  return { ...area, range: area.range * scale };
}

/**
 * The bodies `area` catches, in candidate order, capped at `maxTargets`.
 *
 * `aim` is the point the cast captured at commit -- never where the caster
 * happens to be looking now, which is the rule spec 062 states for every other
 * landing and the reason turning mid-wind-up cannot re-point a committed blow.
 */
export function selectByArea(
  area: SkillArea,
  caster: ServerEntity,
  aim: { readonly x: number; readonly y: number },
  candidates: readonly ServerEntity[],
): readonly ServerEntity[] {
  const cap = area.maxTargets === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(area.maxTargets));
  if (cap === 0) return [];

  const origin: Vec3 =
    area.shape === 'circle' && area.origin === 'aim'
      ? { x: aim.x, y: aim.y, z: caster.position.z }
      : caster.position;

  // The direction a cone or a lane runs. Falls back to the body's own heading
  // when the aim is on top of it, which is the same fallback `landCone` makes
  // and for the same reason: a zero-length aim has no direction in it.
  const aimX = aim.x - caster.position.x;
  const aimY = aim.y - caster.position.y;
  const length = Math.hypot(aimX, aimY);
  const dirX = length > 1e-6 ? aimX / length : Math.cos(caster.facing);
  const dirY = length > 1e-6 ? aimY / length : Math.sin(caster.facing);

  const found: ServerEntity[] = [];
  for (const target of candidates) {
    if (target.id === caster.id || target.health <= 0) continue;
    if (!inside(area, origin, dirX, dirY, target)) continue;
    found.push(target);
    if (found.length >= cap) break;
  }
  return found;
}

function inside(
  area: SkillArea,
  origin: Vec3,
  dirX: number,
  dirY: number,
  target: ServerEntity,
): boolean {
  switch (area.shape) {
    case 'circle': {
      const dx = target.position.x - origin.x;
      const dy = target.position.y - origin.y;
      const reach = area.radius + target.radius;
      return dx * dx + dy * dy <= reach * reach;
    }
    case 'cone':
      // The same predicate a melee swing uses, so a skill's cone and a weapon's
      // cone mean the same thing.
      return isInCone(
        origin,
        dirX,
        dirY,
        area.range + target.radius,
        arcCosSqOf(area.angleDeg),
        target.position,
      );
    case 'line': {
      const dx = target.position.x - origin.x;
      const dy = target.position.y - origin.y;
      // How far along the lane, and how far off it. A body behind the caster
      // has a negative `along` and is out; one past the end is out; one whose
      // edge touches the lane's own half-width is in.
      const along = dx * dirX + dy * dirY;
      if (along < -target.radius || along > area.range + target.radius) return false;
      const across = Math.abs(dx * -dirY + dy * dirX);
      return across <= area.width / 2 + target.radius;
    }
  }
}
