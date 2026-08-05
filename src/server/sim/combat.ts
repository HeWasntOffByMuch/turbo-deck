/**
 * The combat resolver (spec 056).
 *
 * Server-side and final: the client plays a swing animation the instant the
 * button goes down, but whether anything was *hit* is decided here, and the
 * result carries everything the client needs to render the consequence --
 * damage, hitstop, knockback vector and duration. The client never recomputes
 * any of it, which is what keeps two clients watching the same fight in
 * agreement about how hard it looked.
 *
 * Geometry matches the single-player sim's melee cone (`ATTACK_ARC_COS_SQ`, a
 * 90-degree wedge) and reuses its constants, so a swing means the same thing in
 * both programs.
 */

import { ATTACK_ARC_COS_SQ } from '../../sim/constants.js';
import type { Rng } from '../../shared/prng.js';
import { applyArmor } from '../player/stats.js';
import { ActivityValue, type ServerEntity, type ServerSimEvent } from './types.js';

/** Hitstop is at least this long and grows with the fraction of health removed. */
export const MIN_HITSTOP_TICKS = 1;
export const MAX_HITSTOP_TICKS = 6;
/** Ticks of hitstop per full health bar of damage dealt in one blow. */
export const HITSTOP_TICKS_PER_HEALTH_FRACTION = 12;

/** Knockback impulse in world units per tick, before the target's resistance. */
export const KNOCKBACK_IMPULSE = 9;
export const KNOCKBACK_TICKS = 3;

/** Damage multiplier on a critical hit. */
export const CRIT_MULTIPLIER = 1.75;

/** Ticks an attacker is locked in its swing, so it cannot walk mid-strike. */
export const ATTACK_COMMIT_TICKS = 3;

export interface AttackResolution {
  /** Entities whose state changed, keyed by id -- the caller merges these in. */
  readonly updated: ReadonlyMap<number, ServerEntity>;
  readonly events: readonly ServerSimEvent[];
  readonly rng: Rng;
}

/**
 * Whether `target` is inside `attacker`'s swing: within reach of its centre,
 * and inside the forward wedge. Squared throughout -- no square roots, and no
 * trigonometry -- so it is exactly the comparison the single-player sim makes.
 */
export function isInAttackArc(attacker: ServerEntity, target: ServerEntity): boolean {
  const dx = target.position.x - attacker.position.x;
  const dy = target.position.y - attacker.position.y;
  const distanceSq = dx * dx + dy * dy;
  const reach = attacker.stats.attackRange + target.radius;
  if (distanceSq > reach * reach) return false;
  if (distanceSq < 1e-9) return true;

  const aimX = Math.cos(attacker.facing);
  const aimY = Math.sin(attacker.facing);
  const dot = dx * aimX + dy * aimY;
  if (dot <= 0) return false;
  return (dot * dot) / distanceSq >= ATTACK_ARC_COS_SQ;
}

/** Longer freezes for bigger chunks of a health bar; always at least one tick. */
export function hitstopFor(damage: number, targetMaxHealth: number): number {
  if (targetMaxHealth <= 0) return MIN_HITSTOP_TICKS;
  const fraction = Math.min(1, damage / targetMaxHealth);
  const ticks = Math.round(MIN_HITSTOP_TICKS + fraction * HITSTOP_TICKS_PER_HEALTH_FRACTION);
  return Math.max(MIN_HITSTOP_TICKS, Math.min(MAX_HITSTOP_TICKS, ticks));
}

/**
 * Resolves one attacker's swing against every candidate target.
 *
 * `candidates` is whatever the caller decided is nearby and hostile -- interest
 * management and faction rules live outside, so this stays a pure geometry and
 * arithmetic pass. The Rng is threaded through the crit rolls and returned, in
 * the repo's usual style, so the whole thing is reproducible from a seed.
 */
export function resolveAttack(
  attacker: ServerEntity,
  candidates: readonly ServerEntity[],
  tick: number,
  rng: Rng,
): AttackResolution {
  const updated = new Map<number, ServerEntity>();
  const events: ServerSimEvent[] = [];
  let currentRng = rng;

  updated.set(attacker.id, {
    ...attacker,
    attackReadyTick: tick + attacker.stats.attackCooldownTicks,
    activity: ActivityValue.Attacking,
    activityUntilTick: tick + ATTACK_COMMIT_TICKS,
  });

  let connected = false;
  for (const target of candidates) {
    if (target.id === attacker.id) continue;
    if (target.health <= 0) continue;
    if (!isInAttackArc(attacker, target)) continue;

    connected = true;

    // Crit is rolled per target, in id order, so a multi-hit swing is
    // reproducible rather than depending on iteration luck.
    const [roll, nextRng] = currentRng.nextInt(0, 9999);
    currentRng = nextRng;
    const critical = roll / 10000 < attacker.stats.critChance;

    const raw = attacker.stats.attackDamage * (critical ? CRIT_MULTIPLIER : 1);
    const damage = applyArmor(raw, target.stats);
    const health = Math.max(0, target.health - damage);
    const killed = health <= 0;

    const dx = target.position.x - attacker.position.x;
    const dy = target.position.y - attacker.position.y;
    const length = Math.hypot(dx, dy);
    const impulse = KNOCKBACK_IMPULSE * (1 - target.stats.knockbackResist);
    const knockbackX = length > 1e-6 ? (dx / length) * impulse : Math.cos(attacker.facing) * impulse;
    const knockbackY = length > 1e-6 ? (dy / length) * impulse : Math.sin(attacker.facing) * impulse;
    const hitstopTicks = hitstopFor(damage, target.stats.maxHealth);

    updated.set(target.id, {
      ...target,
      health,
      knockbackX,
      knockbackY,
      knockbackUntilTick: tick + KNOCKBACK_TICKS,
      hitstopUntilTick: tick + hitstopTicks,
      activity: killed ? ActivityValue.Dead : ActivityValue.Stunned,
      activityUntilTick: tick + hitstopTicks,
      // Being hit is what makes a passive monster take an interest in you.
      targetId: target.targetId ?? attacker.id,
    });

    events.push({
      kind: 'hit',
      attackerId: attacker.id,
      targetId: target.id,
      damage,
      targetHealth: health,
      hitstopTicks,
      knockbackX,
      knockbackY,
      knockbackTicks: KNOCKBACK_TICKS,
      killed,
      critical,
      blocked: target.stats.armor > 0 && damage < raw,
    });

    if (killed) events.push({ kind: 'died', entityId: target.id, killerId: attacker.id });
  }

  if (!connected) events.push({ kind: 'attackMissed', attackerId: attacker.id });

  return { updated, events, rng: currentRng };
}
