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

/** A played card carries its upgrade level so fusion can scale its damage (spec 019). */
export interface SpellCardPlay {
  readonly id: SpellId;
  readonly level: number;
}

/**
 * Per-card fusion table, keyed by copies-in-window. Index 0 is the single-copy
 * base; index 1 the two-copy fusion; a third entry (dash) the three-copy fusion.
 * `resolveOne` clamps a group's count to the last defined tier.
 */
const TABLE: Record<SpellId, readonly SpellSpec[]> = {
  attack: [
    // Basic attacks interrupt enemy wind-ups and bank adrenaline (spec 023).
    { kind: 'cone', range: 72, arcCosSq: 0.5, damage: 12, interrupt: true },
    { kind: 'cone', range: 94, arcCosSq: 0.3, damage: 26, interrupt: true },
  ],
  dash: [
    { kind: 'dash', distance: 150, durationTicks: 10, damage: 0 },
    { kind: 'dash', distance: 260, durationTicks: 15, damage: 0 },
    { kind: 'dash', distance: 320, durationTicks: 17, damage: 16 },
  ],
  fireBlast: [
    { kind: 'cone', range: 118, arcCosSq: 0.34, damage: 16 },
    // Two blasts fuse into a longer, wider cone that hits much harder.
    { kind: 'cone', range: 200, arcCosSq: 0.18, damage: 50 },
  ],
  blazeAura: [
    { kind: 'aura', radius: 95, pulseDamage: 5, pulseIntervalTicks: 12, durationTicks: 3 * TPS },
    // Two auras fuse into a *bigger, hotter* aura -- same behaviour, more area + damage.
    { kind: 'aura', radius: 135, pulseDamage: 10, pulseIntervalTicks: 12, durationTicks: 3 * TPS },
  ],
  meteorStrike: [
    { kind: 'pointAoe', origin: 'target', radius: 92, damage: 40, stunTicks: 0, delayTicks: 30, count: 1, spreadTicks: 0 },
    { kind: 'pointAoe', origin: 'target', radius: 130, damage: 72, stunTicks: 0, delayTicks: 30, count: 1, spreadTicks: 0 },
  ],
  baskingPath: [
    { kind: 'dash', distance: 220, durationTicks: 14, damage: 0, trailRadius: 55, trailPulseDamage: 4, trailPulseIntervalTicks: 12, trailDurationTicks: Math.round(2.5 * TPS) },
    { kind: 'dash', distance: 300, durationTicks: 17, damage: 0, trailRadius: 70, trailPulseDamage: 7, trailPulseIntervalTicks: 12, trailDurationTicks: 3 * TPS },
  ],
  conjureFlame: [
    { kind: 'empower', charges: 3, bonusDamage: 10 },
    { kind: 'empower', charges: 3, bonusDamage: 22 },
  ],
  fireStorm: [
    { kind: 'pointAoe', origin: 'nearestEnemyToTarget', radius: 110, damage: 26, stunTicks: 0, delayTicks: 8, count: 1, spreadTicks: 0 },
    { kind: 'pointAoe', origin: 'nearestEnemyToTarget', radius: 150, damage: 46, stunTicks: 0, delayTicks: 8, count: 1, spreadTicks: 0 },
  ],
  burningSpeed: [
    { kind: 'burningSpeed', hasteMult: 1.3, durationTicks: 7 * TPS, selfBurnDps: 4, foeBurnRadius: 95, foeBurnDps: 4, foeBurnDurationTicks: 3 * TPS },
    { kind: 'burningSpeed', hasteMult: 1.42, durationTicks: 7 * TPS, selfBurnDps: 4, foeBurnRadius: 110, foeBurnDps: 4, foeBurnDurationTicks: 8 * TPS },
    { kind: 'burningSpeed', hasteMult: 1.45, durationTicks: 7 * TPS, selfBurnDps: 4, foeBurnRadius: 120, foeBurnDps: 4, foeBurnDurationTicks: 9 * TPS },
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

/** Scale a spec's damage-bearing fields by `mult` (upgrade levels); geometry is unchanged. */
function scaleSpec(spec: SpellSpec, mult: number): SpellSpec {
  if (mult === 1) return spec;
  const r = (n: number): number => Math.round(n * mult);
  switch (spec.kind) {
    case 'cone':
      return { ...spec, damage: r(spec.damage) };
    case 'rect':
      return { ...spec, damage: r(spec.damage) };
    case 'aura':
      return { ...spec, pulseDamage: r(spec.pulseDamage) };
    case 'pointAoe':
      return { ...spec, damage: r(spec.damage) };
    case 'dash':
      return {
        ...spec,
        damage: r(spec.damage),
        ...(spec.trailPulseDamage !== undefined ? { trailPulseDamage: r(spec.trailPulseDamage) } : {}),
      };
    case 'shield':
      return { ...spec, amount: r(spec.amount) };
    case 'empower':
      return { ...spec, bonusDamage: r(spec.bonusDamage) };
    case 'burningSpeed':
      // Upgrades sharpen the offensive payoff (the foe burn), not the haste.
      return { ...spec, foeBurnDps: r(spec.foeBurnDps) };
  }
}

/** Resolve one card group to its tiered spec, scaled by the group's total upgrades. */
function resolveOne(id: SpellId, count: number, sumLevel: number): SpellSpec {
  const tiers = TABLE[id];
  const tier = Math.min(count, tiers.length) - 1;
  const base = tiers[tier] as SpellSpec;
  // Each upgrade level over 1 across the group adds +40% damage.
  return scaleSpec(base, 1 + 0.4 * (sumLevel - count));
}

/**
 * Resolve every card played in one synergy window into the specs the sim casts.
 * Grouping is by id and the result order follows first appearance of each id, so
 * it is deterministic and independent of the order copies of the same card were
 * played.
 */
export function resolveSynergies(plays: readonly SpellCardPlay[]): SpellSpec[] {
  const counts = new Map<SpellId, number>();
  const levels = new Map<SpellId, number>();
  const order: SpellId[] = [];
  for (const play of plays) {
    if (!counts.has(play.id)) order.push(play.id);
    counts.set(play.id, (counts.get(play.id) ?? 0) + 1);
    levels.set(play.id, (levels.get(play.id) ?? 0) + play.level);
  }
  return order.map((id) => resolveOne(id, counts.get(id) as number, levels.get(id) as number));
}
