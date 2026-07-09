import type { SpellSpec } from '../shared/spell-spec.js';
import type { SpellId } from './spells.js';

/**
 * Synergy resolution (spec 018): turn the spell cards played inside one window
 * into the geometric `SpellSpec`s the sim will execute. Every game rule (how a
 * card looks, how copies fuse) stays in this pure layer; the sim only runs the
 * geometry it is handed.
 *
 * Fusion rule: group the played cards by id and resolve each group by its
 * count. One copy is the base effect; two-or-more of the same card fuse into a
 * stronger, different effect. Counts above the highest defined tier clamp down.
 */

export type { SpellSpec };

/** Ticks per second; mirrors the sim's fixed timestep (kept local to avoid a sim dependency). */
const TPS = 60;

/**
 * Per-card fusion table, keyed by copies-in-window. Index 0 is the single-copy
 * base; index 1 the two-copy fusion; a third entry (dash) the three-copy fusion.
 * `resolveOne` clamps a group's count to the last defined tier.
 */
const TABLE: Record<SpellId, readonly SpellSpec[]> = {
  attack: [
    { kind: 'cone', range: 72, arcCosSq: 0.5, damage: 12 },
    { kind: 'cone', range: 94, arcCosSq: 0.3, damage: 26 },
  ],
  dash: [
    { kind: 'dash', distance: 150, durationTicks: 10, damage: 0 },
    { kind: 'dash', distance: 260, durationTicks: 15, damage: 0 },
    { kind: 'dash', distance: 320, durationTicks: 17, damage: 16 },
  ],
  fireBlast: [
    { kind: 'cone', range: 118, arcCosSq: 0.34, damage: 16 },
    { kind: 'cone', range: 158, arcCosSq: 0.25, damage: 34 },
  ],
  blazeAura: [
    { kind: 'aura', radius: 95, pulseDamage: 5, pulseIntervalTicks: 12, durationTicks: 3 * TPS },
    // Two auras fuse into three staggered explosions at the player's feet.
    { kind: 'pointAoe', origin: 'player', radius: 78, damage: 14, stunTicks: 0, delayTicks: 0, count: 3, spreadTicks: 9 },
  ],
  meteorStrike: [
    { kind: 'pointAoe', origin: 'target', radius: 92, damage: 40, stunTicks: 0, delayTicks: 30, count: 1, spreadTicks: 0 },
    { kind: 'pointAoe', origin: 'target', radius: 130, damage: 72, stunTicks: 0, delayTicks: 30, count: 1, spreadTicks: 0 },
  ],
  groundStomp: [
    { kind: 'rect', length: 165, halfWidth: 26, damage: 16 },
    { kind: 'rect', length: 225, halfWidth: 34, damage: 30 },
  ],
  rockyRaise: [
    { kind: 'shield', amount: 60, durationTicks: 8 * TPS },
    { kind: 'shield', amount: 120, durationTicks: 8 * TPS },
  ],
  buryFeet: [
    { kind: 'pointAoe', origin: 'target', radius: 92, damage: 6, stunTicks: Math.round(2.5 * TPS), delayTicks: 18, count: 1, spreadTicks: 0 },
    { kind: 'pointAoe', origin: 'target', radius: 130, damage: 10, stunTicks: 4 * TPS, delayTicks: 18, count: 1, spreadTicks: 0 },
  ],
};

/** Resolve a single card group (`count` copies of `id`) to its tiered spec. */
function resolveOne(id: SpellId, count: number): SpellSpec {
  const tiers = TABLE[id];
  const tier = Math.min(count, tiers.length) - 1;
  return tiers[tier] as SpellSpec;
}

/**
 * Resolve every card played in one synergy window into the specs the sim casts.
 * Grouping is by id and the result order follows first appearance of each id, so
 * it is deterministic and independent of the order copies of the same card were
 * played.
 */
export function resolveSynergies(playedIds: readonly SpellId[]): SpellSpec[] {
  const counts = new Map<SpellId, number>();
  const order: SpellId[] = [];
  for (const id of playedIds) {
    if (!counts.has(id)) order.push(id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return order.map((id) => resolveOne(id, counts.get(id) as number));
}
