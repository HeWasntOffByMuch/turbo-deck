/**
 * The ABILITIES definition table (spec 062).
 *
 * Same contract as SKILLS and ITEMS: an entity stores an ability *id*, and
 * every number the ability acts on is read from here at the moment it is used.
 * Retuning a swing changes it for everyone mid-session, with no migration and
 * nothing for a client to have an opinion about.
 *
 * The starting set exists to exercise each {@link AbilityKind} end to end, not
 * to be balanced. One melee, one flat projectile, one lobbed projectile, one
 * ground-targeted blast, one self-buff-shaped heal, and one channel.
 */

import { SERVER_TICK_RATE } from '../config.js';

export type AbilityKind = 'melee' | 'projectile' | 'ground' | 'self' | 'channel';

/** How the client is expected to supply a target when it asks to cast. */
export type AbilityTargeting = 'direction' | 'point' | 'self';

export interface ProjectileSpec {
  /** World units per second. */
  readonly speed: number;
  /**
   * Peak height above the straight line, in world units. 0 is a flat bolt; a
   * positive value lobs, which is what makes an arcing shot readable as one.
   */
  readonly arcHeight: number;
  readonly radius: number;
  /** Ticks before it expires in flight, so a missed shot cannot live forever. */
  readonly lifetimeTicks: number;
}

export interface AbilityDefinition {
  readonly id: string;
  readonly name: string;
  readonly kind: AbilityKind;
  readonly targeting: AbilityTargeting;
  /**
   * Ticks between committing and the effect landing. The caster is rooted and
   * the cast can be cancelled at any point inside it -- this window *is* the
   * commitment the old parry system used to read.
   */
  readonly windupTicks: number;
  readonly cooldownTicks: number;
  readonly cost: number;
  readonly range: number;
  readonly damage: number;
  /** melee: squared cosine of the cone half-angle. 0.5 == a 90-degree wedge. */
  readonly arcCosSq?: number;
  /** ground, and the impact of a projectile that has one. */
  readonly radius?: number;
  readonly projectile?: ProjectileSpec;
  /** channel: how long it runs, and how often it pulses while it does. */
  readonly channelTicks?: number;
  readonly pulseIntervalTicks?: number;
  /** Negative damage heals; kept explicit so the sign is never a surprise. */
  readonly healing?: number;
  /**
   * The weapon swing (spec 070). Its cooldown is stamped from the caster's own
   * `attackSpeed` rather than from {@link cooldownTicks}, which is what makes
   * that stat mean anything; the table's number is the fallback for a caster
   * whose stats say nothing. Exactly one ability per unit should carry it.
   */
  readonly basicAttack?: boolean;
  readonly description: string;
}

function seconds(value: number): number {
  return Math.max(1, Math.round(value * SERVER_TICK_RATE));
}

const DEFINITIONS: readonly AbilityDefinition[] = [
  {
    id: 'melee.slash',
    name: 'Slash',
    kind: 'melee',
    targeting: 'direction',
    windupTicks: seconds(0.2),
    cooldownTicks: seconds(0.6),
    cost: 0,
    range: 70,
    damage: 14,
    arcCosSq: 0.5,
    basicAttack: true,
    description: 'A quick forward cut. Free, and the fallback when nothing else is up.',
  },
  {
    id: 'melee.heavy',
    name: 'Heavy Blow',
    kind: 'melee',
    targeting: 'direction',
    windupTicks: seconds(0.65),
    cooldownTicks: seconds(3),
    cost: 2,
    range: 90,
    damage: 42,
    arcCosSq: 0.65,
    description: 'A long wind-up worth interrupting, and worth landing.',
  },
  {
    id: 'bolt.arcane',
    name: 'Arcane Bolt',
    kind: 'projectile',
    targeting: 'direction',
    windupTicks: seconds(0.3),
    cooldownTicks: seconds(0.8),
    cost: 3,
    range: 700,
    damage: 18,
    projectile: { speed: 620, arcHeight: 0, radius: 8, lifetimeTicks: seconds(2) },
    description: 'A flat, fast bolt that travels until it hits something.',
  },
  {
    id: 'bolt.lob',
    name: 'Firepot',
    kind: 'projectile',
    targeting: 'point',
    windupTicks: seconds(0.5),
    cooldownTicks: seconds(4),
    cost: 5,
    range: 520,
    damage: 30,
    radius: 90,
    projectile: { speed: 300, arcHeight: 130, radius: 12, lifetimeTicks: seconds(4) },
    description: 'A slow lobbed pot that bursts where it lands.',
  },
  {
    id: 'ground.quake',
    name: 'Quake',
    kind: 'ground',
    targeting: 'point',
    windupTicks: seconds(0.9),
    cooldownTicks: seconds(8),
    cost: 7,
    range: 420,
    damage: 46,
    radius: 140,
    description: 'A telegraphed blast at a chosen point. Slow enough to walk out of.',
  },
  {
    id: 'self.mend',
    name: 'Mend',
    kind: 'self',
    targeting: 'self',
    windupTicks: seconds(0.8),
    cooldownTicks: seconds(10),
    cost: 6,
    range: 0,
    damage: 0,
    healing: 60,
    description: 'Heals the caster. Long enough to be punished for using it badly.',
  },
  {
    id: 'channel.drain',
    name: 'Drain',
    kind: 'channel',
    targeting: 'direction',
    windupTicks: seconds(0.25),
    cooldownTicks: seconds(6),
    cost: 4,
    range: 220,
    damage: 7,
    arcCosSq: 0.75,
    channelTicks: seconds(2),
    pulseIntervalTicks: seconds(0.25),
    description: 'Pulses damage in a narrow cone while held. Cancel to stop early.',
  },
];

export const ABILITIES: ReadonlyMap<string, AbilityDefinition> = new Map(
  DEFINITIONS.map((ability) => [ability.id, ability]),
);

export const ALL_ABILITIES: readonly AbilityDefinition[] = DEFINITIONS;

export function abilityById(id: string): AbilityDefinition | null {
  return ABILITIES.get(id) ?? null;
}

/** The swing a right-click attack and a monster's melee both use (spec 070). */
export const BASIC_ATTACK_ID = 'melee.slash';

/** What a fresh character can use. Everything else is unlocked elsewhere later. */
export const STARTING_ABILITIES: readonly string[] = [
  'melee.slash',
  'melee.heavy',
  'bolt.arcane',
  'bolt.lob',
  'ground.quake',
  'self.mend',
  'channel.drain',
];

/**
 * Total ticks a cast occupies the caster, from commit to free. The release frees
 * the caster, so there is nothing past the wind-up but a channel's pulses (spec
 * 068).
 */
export function totalCastTicks(ability: AbilityDefinition): number {
  const channel = ability.kind === 'channel' ? (ability.channelTicks ?? 0) : 0;
  return ability.windupTicks + channel;
}
