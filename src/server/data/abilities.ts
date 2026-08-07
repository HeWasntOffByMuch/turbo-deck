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

/**
 * How the client is expected to supply a target when it asks to cast.
 *
 * One field, and it names both halves of the question (spec 080): what the
 * player has to supply before the ability may be asked for, and what the blow
 * resolves against once it is. They are the same thing, so they are one field.
 *
 * - `direction` -- a point on the ground; the cone or the lane runs from the
 *   caster toward it, and reaches as far as it reaches.
 * - `point` -- a point on the ground, and the cast is refused past its range.
 * - `unit` -- a *body*, named by id. Single-target, gated at that body's edge,
 *   and refused outright when nothing was named.
 * - `self` -- nothing; it lands on the caster whatever came with the request.
 */
export type AbilityTargeting = 'direction' | 'point' | 'unit' | 'self';

/**
 * What a shot draws as (spec 083).
 *
 * A picture and nothing more, exactly as `arcHeight` became one in spec 079:
 * nothing under `src/server/sim/` reads this, and two shots with the same
 * numbers and different looks behave identically. It rides no wire either -- a
 * projectile entity's `typeId` is already its ability id, and this table is
 * shared code the client imports, so the look is a lookup rather than a field.
 */
export type ProjectileLook = 'orb' | 'arrow' | 'shuriken';

export interface ProjectileSpec {
  /** World units per second, before `PROJECTILE_SPEED_SCALE` (spec 084). */
  readonly speed: number;
  /**
   * Peak height above the straight line, in world units. 0 is a flat bolt; a
   * positive value lobs, which is what makes an arcing shot readable as one.
   */
  readonly arcHeight: number;
  readonly radius: number;
  /**
   * The distance a shot may cover before it expires, written as ticks at the
   * speed above. Slowing every shot by a global scale lengthens this to match,
   * so a row's *reach* is what it says whatever the scale is (spec 083).
   */
  readonly lifetimeTicks: number;
  /** What it draws as. Absent is an orb -- the look every shot had before. */
  readonly look?: ProjectileLook;
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
   * `attackDelayTicks` rather than from {@link cooldownTicks}, which is what makes
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
    id: 'ranged.shot',
    name: 'Hunting Shot',
    kind: 'projectile',
    // Point-targeted, so `startCast` refuses a shot at something out of range
    // rather than launching an arrow that was never going to reach.
    targeting: 'point',
    windupTicks: seconds(0.35),
    cooldownTicks: seconds(1),
    cost: 0,
    range: 420,
    damage: 12,
    // Lobbed, which is what makes it unblockable: an arcing shot flies over
    // whatever is between the archer and the body it named (spec 079). How
    // *high* it goes over is a look and nothing else -- both travel types reach
    // the same body on the same tick -- so spec 084 doubling it is a picture.
    projectile: { speed: 900, arcHeight: 110, radius: 7, lifetimeTicks: seconds(2), look: 'arrow' },
    basicAttack: true,
    description: 'An arrow, lobbed over whatever is in the way. Lands where the target is, not where it was.',
  },
  {
    id: 'ranged.star',
    name: 'Throwing Star',
    kind: 'projectile',
    targeting: 'point',
    windupTicks: seconds(0.2),
    cooldownTicks: seconds(0.7),
    cost: 0,
    range: 300,
    damage: 8,
    // Flat, and therefore stoppable by anything that steps into the line.
    projectile: {
      speed: 1150,
      arcHeight: 0,
      radius: 6,
      lifetimeTicks: seconds(1.5),
      look: 'shuriken',
    },
    basicAttack: true,
    description: 'A fast flat star. Whatever wanders into the line takes it instead.',
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
    id: 'bolt.seek',
    name: 'Seeking Bolt',
    kind: 'projectile',
    // The one row that exists to exercise a named cast at a range worth walking
    // (spec 080). Everything under it was already built: a projectile carrying
    // a target id tracks its mark and is disjointed by its death (spec 079).
    targeting: 'unit',
    windupTicks: seconds(0.45),
    cooldownTicks: seconds(2.5),
    cost: 4,
    range: 480,
    damage: 26,
    projectile: { speed: 700, arcHeight: 40, radius: 9, lifetimeTicks: seconds(3) },
    description: 'A bolt that follows the body it was aimed at, until it arrives or burns out.',
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

/**
 * The swing a body falls back to when nothing it carries names another
 * (specs 070, 076). Which attack a unit actually uses is
 * `EffectiveStats.basicAttackId`, derived from its main hand or its row.
 */
export const BASIC_ATTACK_ID = 'melee.slash';

/** What a fresh character can use. Everything else is unlocked elsewhere later. */
export const STARTING_ABILITIES: readonly string[] = [
  'melee.slash',
  'melee.heavy',
  'bolt.arcane',
  'bolt.lob',
  'bolt.seek',
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
