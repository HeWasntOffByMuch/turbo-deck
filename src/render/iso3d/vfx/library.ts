/**
 * The effect library (spec 121).
 *
 * Every effect in the game, as data. `registry.ts` concatenates this with the
 * blood and spark entries and compiles the lot once.
 *
 * ## Builders, not copies
 *
 * `fire`, `puff` and `aura` are parameterized because the brief for each of them
 * says so in as many words -- one puff definition drives footsteps, teleports,
 * steam, debris and a poison cloud through tint, scale, count, rise speed,
 * spread and lifetime. They are functions that *return config*; nothing here is
 * behaviour. Adding a variant is a call with different numbers, in this file,
 * and no call site anywhere changes.
 *
 * ## The shape language
 *
 * `docs/vfx-plan.md` section 6 is the contract these are authored against: hot
 * core and cool edge, silhouette over detail, direction is information, a
 * critical is louder in the same language rather than a new one. Where an effect
 * here departs from it, the reason is in a comment.
 */

import type { EffectDefinition, Emitter, Priority } from './types.js';
import type { PaletteKey } from './palette.js';
import type { Gradient } from './curve.js';

// --- fire --------------------------------------------------------------------

export interface FireParams {
  readonly id: string;
  /** World units the flame stands. Everything else is derived from it. */
  readonly height: number;
  readonly priority?: Priority;
  /** The three colours of the flame, base to tip. Tint is what makes it blue. */
  readonly core?: PaletteKey;
  readonly body?: PaletteKey;
  readonly deep?: PaletteKey;
  /** Follows a rig instead of standing still. */
  readonly attached?: boolean;
  /** Ticks before it stops itself. 0 burns until stopped. */
  readonly durationTicks?: number;
  /** Emitters per second, scaled from the defaults. */
  readonly vigour?: number;
  /** Leave off the smoke column: a torch indoors, a trail on a moving shot. */
  readonly smoke?: boolean;
  /** Leave off the ground glow: anything not standing on the ground. */
  readonly glow?: boolean;
}

/**
 * Fire, as five layers rather than one emitter.
 *
 * A single flame sprite reads as a decal of a fire. What reads as burning is the
 * relationship between the layers: a solid core that flickers fast, embers that
 * leave it and keep rising, a shimmer that says the air above is moving, smoke
 * that arrives late and outlives everything, and a glow on the ground that says
 * the fire is *in* the world rather than drawn over it.
 *
 * Every colour goes through the gradient, so the whole thing tints together --
 * `play('campfire', { tint: 'icePale' })` is blue fire, embers and smoke
 * included, because sub-effect tint inheritance carries it down.
 */
export function fire(params: FireParams): EffectDefinition {
  const h = params.height;
  const vigour = params.vigour ?? 1;
  const core = params.core ?? 'fireCore';
  const body = params.body ?? 'fireBody';
  const deep = params.deep ?? 'fireDeep';
  const world = !params.attached;

  const emitters: Emitter[] = [
    // (a) The flame itself: a flipbook, axis-locked so it stands up rather than
    // leaning with the camera, with upward drag and a little turbulence.
    {
      id: 'flame',
      shape: { kind: 'circle', radius: h * 0.16 },
      emission: { kind: 'rate', perSecond: 22 * vigour },
      lifetimeTicks: [16, 26],
      speed: [h * 0.35, h * 0.8],
      spreadRadians: 0.22,
      gravity: 0,
      drag: 1.5,
      acceleration: { x: 0, y: h * 1.1, z: 0 },
      turbulence: { amplitude: h * 0.9, frequency: 0.05 },
      size: { keys: [[0, h * 0.42], [0.35, h * 0.5], [1, h * 0.16]] },
      alpha: { keys: [[0, 1], [0.7, 1], [1, 0]] },
      color: { stops: [[0, core], [0.4, body], [1, deep]] },
      render: 'axis-billboard',
      blend: 'additive',
      sprite: { sheet: 'flame', frames: 8, fps: 18, randomStart: true },
      worldSpace: world,
      light: { color: body, intensity: { keys: [[0, 0.9], [1, 0.4]] }, radius: h * 4 },
    },
    // (b) Embers: points that leave the flame and keep going, flickering.
    {
      id: 'embers',
      shape: { kind: 'circle', radius: h * 0.2 },
      emission: { kind: 'rate', perSecond: 7 * vigour },
      lifetimeTicks: [40, 90],
      speed: [h * 0.6, h * 1.4],
      spreadRadians: 0.5,
      gravity: h * 0.5,
      drag: 0.9,
      turbulence: { amplitude: h * 1.6, frequency: 0.03 },
      // The flicker: alpha steps rather than ramps, so an ember winks.
      alpha: { keys: [[0, 1], [0.3, 0.35], [0.45, 1], [0.7, 0.4], [0.85, 1], [1, 0]] },
      size: { keys: [[0, h * 0.055], [1, h * 0.03]] },
      color: { stops: [[0, core], [0.5, body], [1, deep]] },
      render: 'billboard',
      blend: 'additive',
      worldSpace: world,
    },
    // (c) The heat shimmer, as something that survives pixelation.
    //
    // Not a refraction pass. At 300 pixels tall, sampling the frame with an
    // offset moves whole pixels around and reads as tearing, not as heat. This
    // is a few big, faint, fast-rising dither-cutout quads: what they actually
    // do is punch a shifting stipple through whatever is behind them, which is
    // the *impression* of disturbed air and costs one more batch of quads.
    {
      id: 'shimmer',
      shape: { kind: 'circle', radius: h * 0.22 },
      emission: { kind: 'rate', perSecond: 9 * vigour },
      lifetimeTicks: [18, 30],
      speed: [h * 0.5, h * 0.9],
      spreadRadians: 0.3,
      acceleration: { x: 0, y: h * 0.6, z: 0 },
      turbulence: { amplitude: h * 0.7, frequency: 0.06 },
      size: { keys: [[0, h * 0.3], [1, h * 0.62]] },
      alpha: { keys: [[0, 0.22], [0.5, 0.16], [1, 0]] },
      color: { stops: [[0, core], [1, body]] },
      render: 'axis-billboard',
      blend: 'dither-cutout',
      sprite: { sheet: 'glow', frames: 1, fps: 0 },
      offset: { x: 0, y: h * 0.55, z: 0 },
      worldSpace: world,
    },
  ];

  if (params.smoke !== false) {
    // (d) The column: dark, slow, and it starts above the flame rather than in
    // it -- smoke that appears at the base reads as the fire being dirty.
    emitters.push({
      id: 'smoke',
      shape: { kind: 'circle', radius: h * 0.2 },
      emission: { kind: 'rate', perSecond: 5 * vigour },
      lifetimeTicks: [90, 170],
      speed: [h * 0.3, h * 0.6],
      spreadRadians: 0.35,
      drag: 0.5,
      acceleration: { x: 0, y: h * 0.35, z: 0 },
      turbulence: { amplitude: h * 0.8, frequency: 0.02 },
      size: { keys: [[0, h * 0.3], [1, h * 1.1]] },
      alpha: { keys: [[0, 0], [0.2, 0.5], [0.7, 0.35], [1, 0]] },
      color: { stops: [[0, 'smokeLight'], [1, 'smokeDark']] },
      render: 'axis-billboard',
      blend: 'dither-cutout',
      sprite: { sheet: 'puff', frames: 8, fps: 6, randomStart: true },
      offset: { x: 0, y: h * 0.9, z: 0 },
      angularVelocity: [-0.5, 0.5],
      worldSpace: world,
    });
  }

  if (params.glow !== false) {
    // (e) The ground glow: a flat quad under the fire, so the ground it stands
    // on is lit rather than merely near a light.
    emitters.push({
      id: 'glow',
      shape: { kind: 'point' },
      emission: { kind: 'rate', perSecond: 6 },
      lifetimeTicks: [10, 14],
      speed: [0, 0],
      size: { keys: [[0, h * 1.5], [1, h * 1.7]] },
      alpha: { keys: [[0, 0.3], [1, 0]] },
      color: { stops: [[0, 'emberGlow'], [1, deep]] },
      render: 'ground-quad',
      blend: 'additive',
      sprite: { sheet: 'glow', frames: 1, fps: 0 },
      offset: { x: 0, y: 1.5, z: 0 },
      worldSpace: world,
    });
  }

  return {
    id: params.id,
    priority: params.priority ?? 1,
    cullDistance: 2200,
    durationTicks: params.durationTicks ?? 0,
    emitters,
  };
}

// --- smoke, dust and clouds --------------------------------------------------

export interface PuffParams {
  readonly id: string;
  readonly priority?: Priority;
  readonly color: Gradient;
  readonly size: number;
  readonly count: number;
  readonly rise: number;
  readonly spread: number;
  readonly lifetime: readonly [number, number];
  /** A lingering area rather than a burst: a poison cloud, a vent. */
  readonly area?: { readonly radius: number; readonly perSecond: number; readonly durationTicks: number };
  /** Hug the ground instead of rising. A cloud that sits in a doorway. */
  readonly groundHugging?: boolean;
  readonly churn?: number;
}

/**
 * One soft volume, parameterized (spec 121).
 *
 * Footsteps, landings, teleports, debris, steam, a poison cloud and the smoke
 * off an extinguished fire are all this, with different numbers. The brief asked
 * for exactly that, and it is worth stating why it works: at this resolution the
 * *only* things that distinguish a dust puff from a poison cloud are colour,
 * size, how fast it rises and how long it lasts. There is no detail left to
 * differ in.
 */
export function puff(params: PuffParams): EffectDefinition {
  const churn = params.churn ?? 1;
  const emission = params.area
    ? ({ kind: 'rate', perSecond: params.area.perSecond } as const)
    : ({ kind: 'burst', count: params.count } as const);

  return {
    id: params.id,
    priority: params.priority ?? 0,
    cullDistance: 1800,
    durationTicks: params.area?.durationTicks ?? 0,
    emitters: [
      {
        id: 'puff',
        // A lingering cloud is a *volume*, so it emits from one rather than from
        // a point -- that is what makes it read as an ability's zone with edges
        // instead of as a fountain somebody left running.
        shape: params.area
          ? { kind: 'circle', radius: params.area.radius }
          : { kind: 'sphere', radius: params.size * 0.3 },
        emission,
        lifetimeTicks: params.lifetime,
        speed: [params.rise * 0.4, params.rise],
        spreadRadians: params.spread,
        gravity: params.groundHugging ? -2 : 0,
        drag: 1.6,
        acceleration: { x: 0, y: params.groundHugging ? 0 : params.rise * 0.5, z: 0 },
        turbulence: { amplitude: params.rise * 1.2 * churn, frequency: 0.03 },
        size: { keys: [[0, params.size * 0.6], [0.4, params.size], [1, params.size * 1.4]] },
        alpha: { keys: [[0, 0], [0.15, 0.7], [0.65, 0.5], [1, 0]] },
        color: params.color,
        render: params.groundHugging ? 'ground-quad' : 'axis-billboard',
        blend: 'dither-cutout',
        sprite: { sheet: 'puff', frames: 8, fps: 8, randomStart: true },
        angularVelocity: [-0.8 * churn, 0.8 * churn],
      },
    ],
  };
}

// --- auras -------------------------------------------------------------------

export interface AuraParams {
  readonly id: string;
  readonly color: PaletteKey;
  /** World units. Stacked auras must differ by enough to read apart. */
  readonly radius: number;
  readonly priority?: Priority;
  /** Turns per second. 0 is a still ring. */
  readonly spin?: number;
  /** How much the radius breathes, as a fraction. */
  readonly pulse?: number;
  readonly thin?: boolean;
  /** Motes orbiting the ring. Poison and arcane want them; a shield does not. */
  readonly motes?: number;
}

/**
 * A status, drawn as a ring on the ground (spec 121).
 *
 * Ground-projected rather than a shell around the body, and that is the whole
 * reason two statuses can be on at once: rings at different radii stack
 * concentrically and read as two things, where two overlapping body glows read
 * as one muddy colour. `auras.test.ts` asserts the radii are far enough apart to
 * survive the virtual resolution.
 *
 * The ring never expires on its own -- an aura is state, and it is stopped when
 * the state ends. `durationTicks` is deliberately absent.
 */
export function aura(params: AuraParams): EffectDefinition {
  const spin = params.spin ?? 0.25;
  const pulse = params.pulse ?? 0.06;
  const emitters: Emitter[] = [
    {
      id: 'ring',
      shape: { kind: 'point' },
      // Re-stamped rather than held: a single long-lived quad cannot pulse,
      // because size is a curve over a particle's own life.
      emission: { kind: 'rate', perSecond: 12 },
      lifetimeTicks: [12, 12],
      speed: [0, 0],
      size: {
        keys: [
          [0, params.radius * (1 - pulse)],
          [0.5, params.radius * (1 + pulse)],
          [1, params.radius * (1 - pulse)],
        ],
      },
      alpha: { keys: [[0, 0], [0.25, 0.75], [0.75, 0.75], [1, 0]] },
      color: { stops: [[0, params.color]] },
      rotation: { keys: [[0, 0], [1, spin * Math.PI * 2]] },
      render: 'ground-quad',
      blend: 'dither-cutout',
      sprite: { sheet: params.thin ? 'ring_thin' : 'ring', frames: 1, fps: 0 },
      offset: { x: 0, y: 2, z: 0 },
      worldSpace: false,
    },
  ];

  if (params.motes && params.motes > 0) {
    emitters.push({
      id: 'motes',
      shape: { kind: 'circle', radius: params.radius * 0.42, shell: true },
      emission: { kind: 'rate', perSecond: params.motes },
      lifetimeTicks: [45, 75],
      speed: [4, 10],
      spreadRadians: 0.4,
      acceleration: { x: 0, y: 14, z: 0 },
      drag: 1.1,
      size: { keys: [[0, 2.4], [1, 1.2]] },
      alpha: { keys: [[0, 0], [0.2, 1], [0.8, 1], [1, 0]] },
      color: { stops: [[0, params.color]] },
      render: 'billboard',
      blend: 'additive',
      worldSpace: false,
    });
  }

  return {
    id: params.id,
    priority: params.priority ?? 2,
    cullDistance: 2000,
    emitters,
  };
}

// --- hit effects -------------------------------------------------------------

/**
 * The oversized flash at a contact point, tinted by damage type.
 *
 * Three ticks and deliberately much larger than the blow. At 300 pixels tall a
 * subtle flash is no flash; this is the layer that says *when*, and every damage
 * type gets one so that "something landed" reads before "what landed" does.
 */
function flash(id: string, hot: PaletteKey, cool: PaletteKey, size: number, priority: Priority = 2): EffectDefinition {
  return {
    id,
    priority,
    cullDistance: 1500,
    emitters: [
      // The halo, in the type's *cool* colour, dithered so it dissolves into the
      // frame's weave rather than banding against it.
      {
        id: 'halo',
        shape: { kind: 'point' },
        emission: { kind: 'burst', count: 1 },
        lifetimeTicks: [4, 5],
        speed: [0, 0],
        size: { keys: [[0, size], [1, size * 1.6]] },
        alpha: { keys: [[0, 0.8], [1, 0]] },
        color: { stops: [[0, cool]] },
        render: 'billboard',
        blend: 'additive',
        sprite: { sheet: 'glow', frames: 1, fps: 0 },
      },
      // The core, and the reason this is two emitters rather than one.
      //
      // The first version was a single dithered halo running hot-to-cool over its
      // life, and on the library contact sheet all seven damage types came out as
      // the same desaturated grey-brown smudge: at this size the dithered falloff
      // is most of the disc, so most of what reaches the screen is the *faint*
      // outer stipple and the hue never gets a chance to say anything. A small
      // hard-edged centre at full alpha is what makes a lightning hit look like
      // lightning and an ice hit look like ice.
      {
        id: 'core',
        shape: { kind: 'point' },
        emission: { kind: 'burst', count: 1 },
        lifetimeTicks: [3, 4],
        speed: [0, 0],
        size: { keys: [[0, size * 0.5], [0.6, size * 0.62], [1, size * 0.2]] },
        alpha: { keys: [[0, 1], [0.7, 1], [1, 0]] },
        color: { stops: [[0, hot], [0.7, hot], [1, cool]] },
        render: 'billboard',
        blend: 'additive',
        sprite: { sheet: 'disc', frames: 1, fps: 0 },
      },
    ],
  };
}

export const LIBRARY: readonly EffectDefinition[] = [
  // --- fire ------------------------------------------------------------------
  fire({ id: 'torch', height: 14, vigour: 0.7, smoke: false }),
  fire({ id: 'campfire', height: 26 }),
  fire({ id: 'fire_burning_unit', height: 30, attached: true, priority: 2, glow: false }),
  fire({ id: 'fire_ground_patch', height: 18, vigour: 1.4 }),
  fire({ id: 'fire_trail', height: 10, vigour: 1.6, smoke: false, glow: false, durationTicks: 8 }),
  fire({ id: 'fire_ignite', height: 34, vigour: 3, durationTicks: 14, priority: 2 }),

  // --- smoke, dust and clouds ------------------------------------------------
  // Terrain-tinted footfalls. The material is the caller's business; these are
  // the four the ground can be.
  puff({
    id: 'puff_footstep',
    color: { stops: [[0, 'dustPale'], [1, 'dustStone']] },
    size: 7,
    count: 3,
    rise: 16,
    spread: 0.9,
    lifetime: [14, 24],
  }),
  puff({
    id: 'puff_footstep_sand',
    color: { stops: [[0, 'dustSand'], [1, 'dustEarth']] },
    size: 8,
    count: 4,
    rise: 18,
    spread: 1,
    lifetime: [16, 28],
  }),
  puff({
    id: 'puff_footstep_snow',
    color: { stops: [[0, 'dustSnow'], [1, 'dustPale']] },
    size: 8,
    count: 4,
    rise: 14,
    spread: 0.8,
    lifetime: [18, 30],
  }),
  puff({
    id: 'puff_splash',
    color: { stops: [[0, 'splashWater'], [1, 'iceWhite']] },
    size: 9,
    count: 6,
    rise: 40,
    spread: 1.1,
    lifetime: [10, 18],
  }),
  puff({
    id: 'puff_landing',
    color: { stops: [[0, 'dustPale'], [1, 'dustEarth']] },
    size: 13,
    count: 10,
    rise: 22,
    spread: 1.45,
    lifetime: [16, 28],
    groundHugging: true,
  }),
  puff({
    id: 'puff_teleport',
    color: { stops: [[0, 'arcaneLilac'], [1, 'arcaneDeep']] },
    size: 15,
    count: 12,
    rise: 90,
    spread: 0.35,
    lifetime: [16, 30],
    priority: 1,
  }),
  puff({
    id: 'puff_debris',
    color: { stops: [[0, 'dustStone'], [1, 'smokeDark']] },
    size: 12,
    count: 8,
    rise: 26,
    spread: 1.2,
    lifetime: [20, 40],
  }),
  puff({
    id: 'puff_steam',
    color: { stops: [[0, 'dustPale'], [1, 'smokeLight']] },
    size: 14,
    count: 0,
    rise: 44,
    spread: 0.3,
    lifetime: [40, 70],
    area: { radius: 6, perSecond: 12, durationTicks: 0 },
  }),
  puff({
    id: 'smoke_extinguish',
    color: { stops: [[0, 'smokeLight'], [1, 'smokeDark']] },
    size: 18,
    count: 14,
    rise: 30,
    spread: 0.5,
    lifetime: [60, 110],
  }),
  // The zone, with a real area and a real end: an ability's ground, not a vent.
  puff({
    id: 'cloud_poison',
    color: { stops: [[0, 'poisonPale'], [0.5, 'poisonDeep'], [1, 'poisonMurk']] },
    size: 26,
    count: 0,
    rise: 5,
    spread: 1.2,
    lifetime: [110, 190],
    area: { radius: 70, perSecond: 26, durationTicks: 600 },
    groundHugging: true,
    churn: 0.35,
    priority: 1,
  }),

  // --- auras -----------------------------------------------------------------
  // Radii are separated on purpose so two at once are concentric rings rather
  // than one smear. `auras.test.ts` holds the separation to account.
  aura({ id: 'aura_selected', color: 'auraSelected', radius: 34, spin: 0.15, thin: true, priority: 3 }),
  aura({ id: 'aura_buff', color: 'auraBuff', radius: 44, spin: 0.2, motes: 6 }),
  aura({ id: 'aura_debuff', color: 'auraDebuff', radius: 54, spin: -0.2 }),
  aura({ id: 'aura_poison', color: 'poisonDeep', radius: 64, spin: 0.1, motes: 8 }),
  aura({ id: 'aura_shield', color: 'auraShield', radius: 74, spin: 0.35, thin: true }),
  aura({ id: 'aura_heal', color: 'auraHeal', radius: 84, spin: 0.3, motes: 10 }),
  aura({ id: 'aura_channel', color: 'auraChannel', radius: 94, spin: 0.5, pulse: 0.1, priority: 3 }),
  // The one a player must never miss, so it is priority 3 and it pulses hard.
  aura({ id: 'aura_telegraph', color: 'auraTelegraph', radius: 110, spin: 0, pulse: 0.16, priority: 3 }),

  // --- hit effects, one flash per damage type --------------------------------
  flash('impact_flash', 'physicalBone', 'physicalGrey', 15),
  flash('hit_physical', 'physicalBone', 'physicalGrey', 15),
  flash('hit_fire', 'fireCore', 'fireDeep', 18),
  flash('hit_poison', 'poisonPale', 'poisonMurk', 16),
  flash('hit_ice', 'iceWhite', 'iceDeep', 16),
  flash('hit_lightning', 'boltWhite', 'boltViolet', 20),
  flash('hit_arcane', 'arcaneLilac', 'arcaneDeep', 17),
  // Louder in the same language: bigger flash, never a different colour scheme.
  flash('hit_critical', 'sparkHot', 'sparkWarm', 26, 3),

  // Chips and dust: what a physical blow throws that a magical one does not.
  {
    id: 'impact_physical',
    priority: 2,
    cullDistance: 1400,
    emitters: [
      {
        id: 'chips',
        shape: { kind: 'cone', angle: 0.9, radius: 2 },
        emission: { kind: 'burst', count: 8 },
        lifetimeTicks: [14, 30],
        speed: [120, 280],
        spreadRadians: 0.8,
        gravity: -1000,
        drag: 1.1,
        angularVelocity: [-9, 9],
        size: { keys: [[0, 2.8], [1, 1.8]] },
        alpha: { keys: [[0, 1], [0.85, 1], [1, 0]] },
        color: { stops: [[0, 'physicalBone'], [1, 'physicalGrey']] },
        render: 'billboard',
        blend: 'alpha',
        sprite: { sheet: 'chip', frames: 1, fps: 0 },
        collision: { restitution: 0.3, friction: 0.5, maxBounces: 2 },
      },
      {
        id: 'dust',
        shape: { kind: 'circle', radius: 5 },
        emission: { kind: 'burst', count: 5 },
        lifetimeTicks: [16, 28],
        speed: [18, 46],
        spreadRadians: 1.3,
        drag: 2,
        size: { keys: [[0, 6], [1, 13]] },
        alpha: { keys: [[0, 0.6], [1, 0]] },
        color: { stops: [[0, 'dustPale'], [1, 'dustStone']] },
        render: 'axis-billboard',
        blend: 'dither-cutout',
        sprite: { sheet: 'puff', frames: 8, fps: 10, randomStart: true },
      },
    ],
  },

  // The directional shockwave: a ring on the ground that runs outward along the
  // blow. Direction is information, and this is the cheapest way to say it.
  {
    id: 'shockwave_ring',
    priority: 2,
    cullDistance: 1600,
    emitters: [
      {
        id: 'ring',
        shape: { kind: 'point' },
        emission: { kind: 'burst', count: 1 },
        lifetimeTicks: [10, 12],
        speed: [0, 0],
        size: { keys: [[0, 8], [1, 70]] },
        alpha: { keys: [[0, 0.85], [1, 0]] },
        color: { stops: [[0, 'physicalBone'], [1, 'dustStone']] },
        render: 'ground-quad',
        blend: 'dither-cutout',
        sprite: { sheet: 'ring_thin', frames: 1, fps: 0 },
        offset: { x: 0, y: 2, z: 0 },
      },
    ],
  },

  // A block: a hard flash at the point of contact and a shower off the guard.
  {
    id: 'hit_block',
    priority: 2,
    cullDistance: 1400,
    emitters: [
      {
        id: 'hex',
        shape: { kind: 'point' },
        emission: { kind: 'burst', count: 1 },
        lifetimeTicks: [5, 7],
        speed: [0, 0],
        size: { keys: [[0, 26], [1, 34]] },
        alpha: { keys: [[0, 0.9], [1, 0]] },
        color: { stops: [[0, 'auraShield'], [1, 'iceDeep']] },
        render: 'billboard',
        blend: 'additive',
        sprite: { sheet: 'ring', frames: 1, fps: 0 },
      },
      {
        id: 'sparks',
        shape: { kind: 'cone', angle: 1.2, radius: 2 },
        emission: { kind: 'burst', count: 10 },
        lifetimeTicks: [8, 18],
        speed: [180, 380],
        spreadRadians: 1.1,
        gravity: -900,
        drag: 1.8,
        size: { keys: [[0, 3], [1, 0.9]] },
        alpha: { keys: [[0, 1], [1, 0]] },
        color: { stops: [[0, 'sparkHot'], [0.4, 'sparkWarm'], [1, 'sparkEmber']] },
        render: 'stretched',
        blend: 'additive',
        stretch: 0.04,
      },
    ],
  },

  // The swing, swept along the arc the weapon travelled.
  {
    id: 'slash_arc',
    priority: 2,
    cullDistance: 1400,
    emitters: [
      {
        id: 'arc',
        shape: { kind: 'arc', radius: 34, sweep: 2.1 },
        emission: { kind: 'burst', count: 14 },
        lifetimeTicks: [6, 11],
        speed: [30, 70],
        spreadRadians: 0.12,
        size: { keys: [[0, 7], [1, 2]] },
        alpha: { keys: [[0, 0.9], [1, 0]] },
        color: { stops: [[0, 'physicalBone'], [1, 'dustPale']] },
        render: 'stretched',
        blend: 'additive',
        stretch: 0.08,
      },
    ],
  },

  // --- deaths, one per archetype ---------------------------------------------
  {
    id: 'death_dissolve',
    priority: 2,
    cullDistance: 1800,
    emitters: [
      {
        id: 'motes',
        shape: { kind: 'mesh' },
        emission: { kind: 'ramp', perSecond: { keys: [[0, 90], [1, 0]] }, overTicks: 40 },
        lifetimeTicks: [40, 80],
        speed: [8, 26],
        spreadRadians: 0.7,
        acceleration: { x: 0, y: 26, z: 0 },
        drag: 1.2,
        turbulence: { amplitude: 30, frequency: 0.04 },
        size: { keys: [[0, 3], [1, 0.8]] },
        alpha: { keys: [[0, 1], [0.7, 0.8], [1, 0]] },
        color: { stops: [[0, 'arcaneLilac'], [1, 'arcaneDeep']] },
        render: 'billboard',
        blend: 'additive',
      },
    ],
  },
  {
    id: 'death_collapse',
    priority: 2,
    cullDistance: 1800,
    emitters: [
      {
        id: 'dust',
        shape: { kind: 'circle', radius: 16 },
        emission: { kind: 'burst', count: 14 },
        lifetimeTicks: [26, 50],
        speed: [20, 60],
        spreadRadians: 1.4,
        drag: 2.2,
        size: { keys: [[0, 9], [1, 22]] },
        alpha: { keys: [[0, 0], [0.15, 0.65], [1, 0]] },
        color: { stops: [[0, 'dustPale'], [1, 'dustStone']] },
        render: 'axis-billboard',
        blend: 'dither-cutout',
        sprite: { sheet: 'puff', frames: 8, fps: 9, randomStart: true },
      },
    ],
  },
  {
    id: 'death_ash',
    priority: 2,
    cullDistance: 1800,
    emitters: [
      {
        id: 'ash',
        shape: { kind: 'sphere', radius: 14 },
        emission: { kind: 'burst', count: 20 },
        lifetimeTicks: [70, 140],
        speed: [10, 34],
        spreadRadians: 1,
        gravity: -26,
        drag: 1.6,
        turbulence: { amplitude: 34, frequency: 0.035 },
        angularVelocity: [-3, 3],
        size: { keys: [[0, 2.6], [1, 1.6]] },
        alpha: { keys: [[0, 0.95], [0.75, 0.8], [1, 0]] },
        color: { stops: [[0, 'sparkEmber'], [0.4, 'smokeDark'], [1, 'oilBlack']] },
        render: 'billboard',
        blend: 'alpha',
        sprite: { sheet: 'chip', frames: 1, fps: 0 },
      },
    ],
  },
];
