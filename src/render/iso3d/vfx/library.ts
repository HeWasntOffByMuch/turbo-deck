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

import { ORDER_MARK_ARM, brushBeam, brushCross, brushExplosion, brushLane, brushShards, brushSwing } from './brush.js';
import { WARDEN_LASER } from '../../../server/data/warden.js';
import type { EffectDefinition, Emitter, Priority } from './types.js';
import type { PaletteKey } from './palette.js';
import type { Gradient } from './curve.js';
import { SCORCHED_EARTH } from '../../../server/data/aura-fields.js';

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
    // (a) The tongues: solid, stacked, upright.
    //
    // The whole direction of this family. A flipbook on a camera-facing quad has
    // no silhouette -- it is a picture of a flame rather than a flame -- and at
    // this resolution the silhouette is the entire read. These are real tapered
    // solids that rise, shrink and are replaced, so the outline is always several
    // overlapping tongues rather than one card.
    {
      id: 'tongues',
      shape: { kind: 'circle', radius: h * 0.17 },
      emission: { kind: 'rate', perSecond: 16 * vigour },
      lifetimeTicks: [14, 24],
      speed: [h * 0.25, h * 0.55],
      spreadRadians: 0.3,
      drag: 1.8,
      acceleration: { x: 0, y: h * 0.9, z: 0 },
      turbulence: { amplitude: h * 0.5, frequency: 0.06 },
      angularVelocity: [-1.4, 1.4],
      size: { keys: [[0, h * 0.5], [0.3, h * 0.62], [1, h * 0.12]] },
      alpha: { keys: [[0, 1], [0.75, 1], [1, 0]] },
      color: { stops: [[0, core], [0.45, body], [1, deep]] },
      render: 'mesh',
      mesh: { shape: 'tongue' },
      // Alpha, not additive: a tongue is a shape with an edge, and additive
      // blending is what turned the last version into a glow with no outline.
      blend: 'alpha',
      worldSpace: world,
      light: { color: body, intensity: { keys: [[0, 0.9], [1, 0.4]] }, radius: h * 4 },
    },
    // (b) The core: a short, fat, near-white tongue low in the fire, so the
    // middle is hot and the edges are not. The references all have this and it is
    // what stops a flame reading as flat orange.
    {
      id: 'core',
      shape: { kind: 'circle', radius: h * 0.08 },
      emission: { kind: 'rate', perSecond: 12 * vigour },
      lifetimeTicks: [8, 14],
      speed: [h * 0.2, h * 0.4],
      spreadRadians: 0.15,
      drag: 2.2,
      acceleration: { x: 0, y: h * 0.5, z: 0 },
      angularVelocity: [-2, 2],
      size: { keys: [[0, h * 0.34], [0.4, h * 0.4], [1, h * 0.1]] },
      alpha: { keys: [[0, 1], [0.7, 1], [1, 0]] },
      color: { stops: [[0, core], [1, body]] },
      render: 'mesh',
      mesh: { shape: 'tongue' },
      blend: 'alpha',
      offset: { x: 0, y: h * 0.06, z: 0 },
      worldSpace: world,
    },
    // (c) Embers: square chips of light that leave the fire and keep going. The
    // one part of this family a quad is right for -- an ember is a spark.
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
    // (d) The shimmer above the fire: barely-there solids rising fast.
    //
    // Not refraction. Sampling the frame with an offset moves whole pixels at
    // 300 tall and reads as tearing. Faint blobs drifting up through what is
    // behind them give the *impression* of disturbed air, and now that they are
    // solids they occlude each other slightly as they tumble, which sells it
    // better than the flat version did.
    {
      id: 'shimmer',
      shape: { kind: 'circle', radius: h * 0.22 },
      emission: { kind: 'rate', perSecond: 7 * vigour },
      lifetimeTicks: [18, 30],
      speed: [h * 0.5, h * 0.9],
      spreadRadians: 0.3,
      acceleration: { x: 0, y: h * 0.6, z: 0 },
      turbulence: { amplitude: h * 0.7, frequency: 0.06 },
      angularVelocity: [-1, 1],
      size: { keys: [[0, h * 0.28], [1, h * 0.6]] },
      alpha: { keys: [[0, 0.14], [0.5, 0.1], [1, 0]] },
      color: { stops: [[0, core], [1, body]] },
      render: 'mesh',
      mesh: { shape: 'blob' },
      blend: 'alpha',
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
      emission: { kind: 'rate', perSecond: 4.5 * vigour },
      lifetimeTicks: [70, 130],
      // Fast enough that the column *travels*. The first cut rose at a third of
      // this and lived twice as long, and the result was not a column at all --
      // a dozen thirty-unit blobs hanging in the same place above the fire,
      // which at this resolution is one grey mass with the flame lost inside it.
      speed: [h * 0.5, h * 0.9],
      spreadRadians: 0.3,
      drag: 0.5,
      acceleration: { x: 0, y: h * 0.7, z: 0 },
      turbulence: { amplitude: h * 0.8, frequency: 0.02 },
      size: { keys: [[0, h * 0.3], [1, h * 0.78]] },
      alpha: { keys: [[0, 0], [0.2, 0.34], [0.7, 0.24], [1, 0]] },
      color: { stops: [[0, 'smokeLight'], [1, 'smokeDark']] },
      render: 'mesh',
      mesh: { shape: 'blob' },
      blend: 'alpha',
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
        size: { keys: [[0, params.size * 0.55], [0.4, params.size], [1, params.size * 1.5]] },
        // Semi-transparent, so overlapping blobs build a mass with depth in it
        // rather than a stack of equally-opaque cards.
        alpha: { keys: [[0, 0], [0.15, 0.55], [0.65, 0.42], [1, 0]] },
        color: params.color,
        // A solid, always -- including the ground-hugging clouds. A poison cloud
        // is a *volume* an ability owns, and a flat quad on the floor is a decal
        // of one.
        render: 'mesh',
        mesh: { shape: 'blob' },
        blend: 'alpha',
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
  /** Turns per second. 0 is a still sigil. */
  readonly spin?: number;
  /** A lighter sigil: narrower bands and fewer marks. */
  readonly thin?: boolean;
  /** Shafts of light standing on the ring, per second. 0 is a bare sigil. */
  readonly shafts?: number;
  /** Diamonds floating above it, per second. */
  readonly diamonds?: number;
}

/**
 * Ticks a held particle lives for.
 *
 * Long enough that no fight outlasts it, short enough that a leak is bounded.
 * This is the sigil's whole lifetime: it is stamped once and then spun, rather
 * than re-emitted, because two crisp rings alive at once at slightly different
 * angles read as a doubled line. `hardStop` is what makes this safe -- see the
 * note on {@link aura}.
 */
const HELD = 36_000;

/**
 * A status, drawn as a sigil on the ground (specs 121, 124).
 *
 * Ground-projected rather than a shell around the body, and that is the whole
 * reason two statuses can be on at once: rings at different radii stack
 * concentrically and read as two things, where two overlapping body glows read
 * as one muddy colour. `auras.test.ts` asserts the radii are far enough apart to
 * survive the virtual resolution.
 *
 * ## Drawn, not emitted
 *
 * The sigil is one solid, stamped once and spun -- not a stream. The previous
 * version re-stamped a dithered quad twelve times a second so that a size curve
 * could make it breathe, and both halves of that were wrong: a stipple has no
 * edge to read, and two crisp rings alive at once at slightly different angles
 * are a doubled line. Spin comes from `angularVelocity` rather than from a
 * rotation curve, because a rotation curve is sampled from life fraction and
 * would overwrite the spin every tick.
 *
 * The pulse went with the stamping. What the two auras that used it actually
 * needed -- *do not miss this* -- is said here with more shafts and a brighter
 * ring, which is louder in the same language rather than a second one.
 *
 * ## It never expires, so it must be stopped hard
 *
 * An aura is state: it ends when the state ends, and `durationTicks` is
 * deliberately absent. A held particle whose effect is stopped *softly* would
 * then hang around for the ten minutes it was given, so every aura sets
 * `hardStop` and the system kills its particles the moment it is stopped.
 */
export function aura(params: AuraParams): EffectDefinition {
  const spin = params.spin ?? 0.25;
  const emitters: Emitter[] = [
    {
      id: 'ring',
      shape: { kind: 'point' },
      emission: { kind: 'burst', count: 1 },
      lifetimeTicks: [HELD, HELD],
      speed: [0, 0],
      // Constant, both of them. Every frame of this particle's life looks the
      // same except for its angle, which is the point of holding it.
      size: { keys: [[0, params.radius]] },
      alpha: { keys: [[0, 0.9]] },
      color: { stops: [[0, params.color]] },
      angularVelocity: [spin * Math.PI * 2, spin * Math.PI * 2],
      render: 'mesh',
      mesh: { shape: params.thin ? 'rune-ring-thin' : 'rune-ring' },
      // Alpha, not dither-cutout: this is the one thing in the whole library
      // that is a drawn line, and a drawn line wants an edge.
      blend: 'alpha',
      offset: { x: 0, y: 2, z: 0 },
      worldSpace: false,
    },
  ];

  if (params.shafts && params.shafts > 0) {
    // Standing on the ring itself, not inside it -- the sigil is what they come
    // out of, so their feet have to be on it or the effect is two effects.
    emitters.push({
      id: 'shafts',
      shape: { kind: 'circle', radius: params.radius * 0.86, shell: true },
      emission: { kind: 'rate', perSecond: params.shafts },
      lifetimeTicks: [26, 44],
      speed: [0, 0],
      size: { keys: [[0, params.radius * 0.35], [0.35, params.radius * 0.85], [1, params.radius * 0.5]] },
      alpha: { keys: [[0, 0], [0.3, 0.5], [0.6, 0.4], [1, 0]] },
      color: { stops: [[0, params.color]] },
      render: 'mesh',
      mesh: { shape: 'shaft' },
      blend: 'additive',
      offset: { x: 0, y: 2, z: 0 },
      worldSpace: false,
    });
  }

  if (params.diamonds && params.diamonds > 0) {
    emitters.push({
      id: 'diamonds',
      shape: { kind: 'circle', radius: params.radius * 0.6, shell: true },
      emission: { kind: 'rate', perSecond: params.diamonds },
      lifetimeTicks: [60, 100],
      speed: [3, 7],
      spreadRadians: 0.5,
      acceleration: { x: 0, y: 10, z: 0 },
      drag: 1.3,
      angularVelocity: [-1.6, 1.6],
      // Big enough to be a shape. The first cut was three units across, which at
      // 480x270 is two pixels -- a speck, and specks are what this whole
      // direction is a move away from.
      size: { keys: [[0, 3], [0.3, 7], [1, 3]] },
      alpha: { keys: [[0, 0], [0.2, 1], [0.75, 1], [1, 0]] },
      color: { stops: [[0, params.color]] },
      render: 'mesh',
      mesh: { shape: 'diamond' },
      blend: 'alpha',
      offset: { x: 0, y: 14, z: 0 },
      worldSpace: false,
    });
  }

  return {
    id: params.id,
    priority: params.priority ?? 2,
    cullDistance: 2000,
    hardStop: true,
    emitters,
  };
}

// --- bursts ------------------------------------------------------------------

export interface BurstParams {
  readonly id: string;
  /** World units the longest spike reaches. Everything else is derived from it. */
  readonly scale: number;
  /** The white-hot middle. */
  readonly hot: PaletteKey;
  /** The body of a spike. */
  readonly warm: PaletteKey;
  /** Its tip, and what the debris fades to. */
  readonly cool: PaletteKey;
  readonly spikes?: number;
  readonly chunks?: number;
  /** Cone half-angle. `Math.PI` is a ball; a small one is a jet. */
  readonly spread?: number;
  /** Lay the fan along the floor instead of letting it fly up. */
  readonly flat?: boolean;
  readonly dust?: boolean;
  readonly glow?: boolean;
  /** A wavefront on the floor, expanding past the fan and outliving it. */
  readonly ring?: boolean;
  readonly light?: boolean;
  readonly priority?: Priority;
}

/**
 * A wavefront on the floor (spec 126): a bright leading edge and a wider,
 * fainter half-step behind it, expanding and fading.
 *
 * Additive, because a wavefront is light rather than an object -- and two of
 * them rather than one because a single ring is a hoop, where the reference has
 * an edge with a glow trailing it.
 *
 * Its own function rather than a block inside {@link burst} because the heal
 * (spec 157) plays the wave with none of the burst around it, and a wave
 * authored twice is two waves that drift apart the first time one is tuned.
 * The walk order was its third caller until spec 175 answered a click with a
 * cross instead; what that changed is the number of callers and nothing here.
 */
export function waveEmitters(s: number, hot: PaletteKey, warm: PaletteKey): Emitter[] {
  return [
    {
      id: 'wave',
      shape: { kind: 'point' },
      emission: { kind: 'burst', count: 1 },
      lifetimeTicks: [26, 30],
      speed: [0, 0],
      size: { keys: [[0, s * 0.25], [0.55, s * 1.9], [1, s * 2.4]] },
      alpha: { keys: [[0, 0.95], [0.5, 0.75], [1, 0]] },
      color: { stops: [[0, hot], [1, warm]] },
      render: 'mesh',
      mesh: { shape: 'ring' },
      blend: 'additive',
      offset: { x: 0, y: 2.5, z: 0 },
    },
    {
      id: 'wave_halo',
      shape: { kind: 'point' },
      emission: { kind: 'burst', count: 1 },
      lifetimeTicks: [28, 34],
      speed: [0, 0],
      size: { keys: [[0, s * 0.2], [0.55, s * 1.65], [1, s * 2.15]] },
      alpha: { keys: [[0, 0.4], [0.5, 0.3], [1, 0]] },
      // It fades toward `warm`, never toward `cool`. A wavefront that ends on
      // the ramp's dark end goes *saturated* rather than dim as it thins, and on
      // frost colours that is a navy hoop lying on the ground after the effect
      // is over -- which reads as something broken, not as something fading.
      color: { stops: [[0, warm], [1, warm]] },
      render: 'mesh',
      mesh: { shape: 'ring' },
      blend: 'additive',
      offset: { x: 0, y: 2, z: 0 },
    },
  ];
}

/**
 * A burst: a crystal that opens and closes (spec 125).
 *
 * The reference for impacts is not a flash, it is a *shape* -- a faceted star at
 * the middle with a fan of long tapered spikes out of it, rocks thrown clear and
 * dust at the base. Everything here is a solid, and the spikes are the reason
 * `ORIENT.velocity` exists: a shard is authored pointing at +Y and the batch aims
 * it down its own direction of travel, so a fan thrown out of a point radiates
 * without anything having to compute a rotation per particle.
 *
 * ## The spikes barely move
 *
 * They are thrown at speed and stopped by heavy drag inside three or four ticks,
 * and what actually reads as the burst opening is their *size* curve. That is
 * deliberate: spikes that travelled would separate from the core and read as a
 * ring of darts leaving, where the reference is one object flowering and closing.
 * The drag never turns a velocity, only shrinks it, so the aim stays put while
 * they stop.
 *
 * Scale is the one number. `play(id, { scale })` multiplies it, so a crit is the
 * same burst read louder rather than a second definition.
 */
export function burst(params: BurstParams): EffectDefinition {
  const s = params.scale;
  const spikes = params.spikes ?? 14;
  const spread = params.spread ?? Math.PI;
  const flat = params.flat === true;
  // A ball, a jet, or a star lying on the floor. `circle` emits in the ground
  // plane, which is what makes the flat variant fan outward rather than upward.
  const fan = flat
    ? ({ kind: 'circle', radius: s * 0.05, shell: true } as const)
    : ({ kind: 'cone', angle: spread, radius: s * 0.05 } as const);

  const emitters: Emitter[] = [
    // (a) The core: one solid star, held for a few ticks. Not a stack of
    // particles at the same place -- that is a bright smear, not a shape.
    {
      id: 'core',
      shape: { kind: 'point' },
      emission: { kind: 'burst', count: 1 },
      lifetimeTicks: [10, 13],
      speed: [0, 0],
      size: { keys: [[0, s * 0.14], [0.25, s * 0.5], [0.6, s * 0.42], [1, 0]] },
      alpha: { keys: [[0, 1], [0.7, 1], [1, 0]] },
      color: { stops: [[0, params.hot], [0.6, params.hot], [1, params.warm]] },
      angularVelocity: [-1.2, 1.2],
      render: 'mesh',
      mesh: { shape: 'starburst' },
      blend: 'alpha',
      offset: { x: 0, y: s * 0.06, z: 0 },
    },
    // (b) The fan. The whole read.
    {
      id: 'spikes',
      shape: fan,
      emission: { kind: 'burst', count: spikes },
      lifetimeTicks: [12, 20],
      speed: [s * 1.6, s * 3.2],
      spreadRadians: flat ? 0.25 : 0.1,
      drag: 14,
      size: { keys: [[0, s * 0.2], [0.3, s], [0.7, s * 0.8], [1, 0]] },
      alpha: { keys: [[0, 1], [0.75, 1], [1, 0]] },
      color: { stops: [[0, params.hot], [0.35, params.warm], [1, params.cool]] },
      render: 'mesh',
      mesh: { shape: 'shard' },
      blend: 'alpha',
      offset: { x: 0, y: flat ? s * 0.03 : s * 0.05, z: 0 },
    },
    // (c) The few that get away: smaller shards that keep going and fall. The
    // reference has these scattered well outside the star, and without them the
    // burst reads as a decal rather than as something that threw material.
    {
      id: 'shards',
      shape: { kind: 'cone', angle: spread, radius: s * 0.08 },
      emission: { kind: 'burst', count: Math.max(5, Math.round(spikes * 0.8)) },
      lifetimeTicks: [16, 30],
      speed: [s * 3, s * 6.5],
      spreadRadians: 0.35,
      gravity: -s * 12,
      drag: 1.4,
      size: { keys: [[0, s * 0.2], [0.4, s * 0.16], [1, s * 0.05]] },
      alpha: { keys: [[0, 1], [0.7, 1], [1, 0]] },
      color: { stops: [[0, params.warm], [1, params.cool]] },
      render: 'mesh',
      mesh: { shape: 'shard' },
      blend: 'alpha',
    },
  ];

  if (params.chunks && params.chunks > 0) {
    // (d) Rock. It bounces, because debris that sinks into the floor is the one
    // thing that says "particle" out loud.
    emitters.push({
      id: 'chunks',
      shape: { kind: 'cone', angle: Math.min(spread, 1.1), radius: s * 0.1 },
      emission: { kind: 'burst', count: params.chunks },
      lifetimeTicks: [26, 52],
      speed: [s * 2.4, s * 5.5],
      spreadRadians: 0.6,
      gravity: -s * 14,
      drag: 0.7,
      angularVelocity: [-8, 8],
      size: { keys: [[0, s * 0.1], [1, s * 0.08]] },
      alpha: { keys: [[0, 1], [0.85, 1], [1, 0]] },
      color: { stops: [[0, 'dustStone'], [1, 'physicalGrey']] },
      render: 'mesh',
      mesh: { shape: 'chunk' },
      blend: 'alpha',
      collision: { restitution: 0.35, friction: 0.6, maxBounces: 2 },
    });
  }

  if (params.dust !== false) {
    emitters.push({
      id: 'dust',
      // At the base and no further. The first cut was half again this size at
      // half again this alpha, and six ticks after the bang the explosion was a
      // white boulder with an orange star somewhere inside it -- the dust has to
      // sit under the crystal, not replace it.
      shape: { kind: 'circle', radius: s * 0.22 },
      emission: { kind: 'burst', count: 9 },
      lifetimeTicks: [20, 34],
      speed: [s * 0.6, s * 1.4],
      spreadRadians: 1.45,
      drag: 2.4,
      acceleration: { x: 0, y: s * 0.25, z: 0 },
      angularVelocity: [-0.7, 0.7],
      size: { keys: [[0, s * 0.12], [0.5, s * 0.22], [1, s * 0.32]] },
      alpha: { keys: [[0, 0], [0.2, 0.34], [0.6, 0.24], [1, 0]] },
      color: { stops: [[0, 'dustStone'], [1, 'physicalGrey']] },
      render: 'mesh',
      mesh: { shape: 'blob' },
      blend: 'alpha',
    });
  }

  if (params.ring) emitters.push(...waveEmitters(s, params.hot, params.warm));

  if (params.glow !== false) {
    // The warm pool the reference scorches into the ground. Not a decal: the
    // decal field is blood's (spec 120) and a burn wants its own splat profile,
    // so this fades instead of staying. Noted in docs/vfx-plan.md.
    emitters.push({
      id: 'glow',
      shape: { kind: 'point' },
      emission: { kind: 'burst', count: 1 },
      lifetimeTicks: [18, 24],
      speed: [0, 0],
      size: { keys: [[0, s * 0.5], [0.3, s * 1.15], [1, s * 1.3]] },
      alpha: { keys: [[0, 0.7], [0.4, 0.45], [1, 0]] },
      color: { stops: [[0, params.warm], [1, params.cool]] },
      render: 'ground-quad',
      blend: 'dither-cutout',
      sprite: { sheet: 'glow', frames: 1, fps: 0 },
      offset: { x: 0, y: 1.5, z: 0 },
    });
  }

  if (params.light) {
    const core = emitters[0];
    if (core) {
      emitters[0] = {
        ...core,
        light: { color: params.warm, intensity: { keys: [[0, 1.4], [1, 0]] }, radius: s * 5 },
      };
    }
  }

  return {
    id: params.id,
    priority: params.priority ?? 2,
    cullDistance: 1800,
    emitters,
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
  // Selection is the quietest of these: a thin sigil turning slowly, and nothing
  // standing on it. It is on whenever a unit is clicked, so it must not shout.
  aura({ id: 'aura_selected', color: 'auraSelected', radius: 34, spin: 0.15, thin: true, priority: 3 }),
  aura({ id: 'aura_buff', color: 'auraBuff', radius: 44, spin: 0.2, shafts: 3, diamonds: 4 }),
  aura({ id: 'aura_debuff', color: 'auraDebuff', radius: 54, spin: -0.2, shafts: 2 }),
  aura({ id: 'aura_poison', color: 'poisonDeep', radius: 64, spin: 0.1, diamonds: 5 }),
  aura({ id: 'aura_shield', color: 'auraShield', radius: 74, spin: 0.35, thin: true, shafts: 5 }),
  aura({ id: 'aura_heal', color: 'auraHeal', radius: 84, spin: 0.3, shafts: 4, diamonds: 6 }),
  aura({ id: 'aura_channel', color: 'auraChannel', radius: 94, spin: 0.5, shafts: 7, diamonds: 4, priority: 3 }),
  // The one a player must never miss. Louder in the same language: a still sigil
  // ringed with shafts, never a different vocabulary.
  aura({ id: 'aura_telegraph', color: 'auraTelegraph', radius: 110, spin: 0, shafts: 10, priority: 3 }),
  // The field (spec 223), and the one aura here whose radius is **not an art
  // decision**: it is the reach in `data/aura-fields.ts`, imported rather than
  // retyped, because this ring is not decoration around the mechanic -- it is
  // where the fire is, and a player who cannot tell which bodies are inside it
  // cannot play the skill at all. Two literals that have to agree is the drift
  // `ground-decal.ts` exists to refuse one level down.
  //
  // Widest in the set by some way and therefore last, which keeps the
  // separation rule above holding by construction: it cannot smear into
  // anything, because nothing else is near it.
  //
  // Shafts and no diamonds. A diamond floats *above* a sigil -- it is a mote
  // over a body, and this sigil is not under one body, it is a region.
  // `priority: 3` for the reason the telegraph has it: a player standing in
  // fire needs to see the fire more than they need to see anything else in the
  // instance pool.
  aura({
    id: 'aura_scorched',
    color: 'fireAmber',
    radius: SCORCHED_EARTH.radius,
    spin: 0.12,
    shafts: 9,
    priority: 3,
  }),

  // --- healing ---------------------------------------------------------------
  // What restoring health looks like (spec 157). Played at the healed body's
  // *feet*, not at the chest a blow lands on: a heal comes up out of the ground,
  // and the three layers below are stacked in the order they are read -- the
  // ground says where, the streaks say which way, the plusses say what.
  //
  // Green throughout, and only the two green palette entries: `auraHeal` is the
  // colour the heal ring already is, so a heal landing and a heal status showing
  // are the same colour rather than two greens that nearly match.
  //
  // Nothing here is directional and nothing here is thrown. Every other impact
  // in this library follows the blow vector, because "direction is information"
  // and the information is where the blow came from; a heal has no such fact to
  // carry, and a spray aimed off a healed body would be inventing one.
  {
    id: 'heal_restore',
    priority: 2,
    cullDistance: 1500,
    emitters: [
      // (a) The wavefront on the floor, the same one an order and a shockwave
      // use. Peak radius is about 22 units, which is wider than a body and well
      // inside the 34-unit selection ring -- a heal is an event that happened
      // here, and one that reached the outer rings would read as a status.
      ...waveEmitters(9, 'auraHeal', 'auraBuff'),
      // (b) The streaks. Born on a disc about a body wide and thrown straight
      // up with no gravity, drawn as ribbons -- a ribbon is the path a particle
      // actually flew (spec 139), so "straight up" is a vertical line rather
      // than a bar that was born full length and stayed one.
      {
        id: 'streaks',
        shape: { kind: 'cone', angle: 0.05, radius: 13 },
        emission: { kind: 'burst', count: 11 },
        lifetimeTicks: [16, 28],
        speed: [95, 150],
        // No gravity at all. A rising streak that arcs over is a spray, and a
        // spray of anything off a body is the blood this replaces.
        drag: 0.5,
        // Four units wide, which is between three and four pixels at the
        // gameplay zoom. The first cut was 3.2 and the strip came out as a set
        // of hairlines under the plusses: a streak that survives quantization
        // has to be several pixels of solid colour, not one dithered one.
        size: { keys: [[0, 4.2], [0.65, 4.2], [1, 1.8]] },
        alpha: { keys: [[0, 1], [0.7, 1], [1, 0]] },
        color: { stops: [[0, 'auraHeal'], [1, 'auraBuff']] },
        render: 'ribbon',
        // Alpha rather than additive, for the reason the blood is: additive
        // green over a green field is a bright nothing, and what has to survive
        // here is the streak's edge.
        blend: 'alpha',
        ribbonSpacing: 3,
        ribbonTaper: 0.3,
        offset: { x: 0, y: 2, z: 0 },
      },
      // (c) The plusses. Slower than the streaks on purpose: they are still
      // climbing when the streaks have gone, so the effect ends on the symbol
      // rather than on the motion. Five, because this plays on every mote
      // picked up and a fistful of floating crosses is a status bar.
      {
        id: 'plusses',
        shape: { kind: 'cone', angle: 0.08, radius: 19 },
        // Staggered rather than burst, and this is the one tuning decision the
        // contact sheet actually changed. Five plusses born on the same tick in
        // the same small disc overlap into a single green mass -- the sheet
        // showed exactly that, a blob with no cross in it anywhere -- where six
        // arriving over a third of a second are a column of separate symbols
        // climbing past each other.
        emission: { kind: 'ramp', perSecond: { keys: [[0, 28], [1, 0]] }, overTicks: 20 },
        lifetimeTicks: [30, 46],
        // A wide spread of speeds on purpose: with a narrow one they climb in
        // step and stay at the same height as each other, which is the clump
        // again in slow motion.
        speed: [30, 78],
        drag: 0.9,
        // Twelve units is about ten pixels at the gameplay zoom, which is a
        // pixel and a half per texel of the 7x7 sheet -- so the bar of the
        // cross is four pixels and its tips are two. Smaller than this and the
        // arms fall under a pixel and the symbol is a dot.
        size: { keys: [[0, 9], [0.25, 12], [1, 10]] },
        // In fast and out slow. A cutout ramping in over a tenth of its life is
        // a speckle of half a plus for three ticks; what should be brief is the
        // arrival, and what earns the time is the symbol sitting there readable.
        alpha: { keys: [[0, 0], [0.06, 1], [0.75, 1], [1, 0]] },
        color: { stops: [[0, 'auraHeal'], [1, 'auraBuff']] },
        render: 'billboard',
        // The pixel-look blend, and the one thing that keeps a plus legible
        // while it fades: a cutout thins to a weave of solid pixels, where an
        // alpha fade goes translucent and the retro pass bands what is left.
        blend: 'dither-cutout',
        sprite: { sheet: 'plus', frames: 1, fps: 0 },
        offset: { x: 0, y: 8, z: 0 },
      },
    ],
  },

  // --- orders ----------------------------------------------------------------
  // Where a walk order landed (specs 127, 175). Two brush marks crossing, and
  // nothing else -- an order threw nothing, so there is nothing scattered around
  // it. Small enough to sit inside a selected unit's own sigil, because it
  // answers "my click landed there" and then stops existing; the standing order
  // it began is drawn by nothing at all.
  //
  // It was the shockwave's wavefront until spec 175, and it stopped being one
  // for two reasons. A ring says something arrived and *pushed*, which is a
  // statement about the world, where a click is a statement about the player's
  // own input and the mark a person makes to say "there" is a cross. And a flat
  // ring laid at `ground + 2` is spec 153's fault exactly -- right at one point
  // of itself, and inside the hill everywhere else.
  //
  // Priority 3 for the same reason a telegraph is: it is information about your
  // own input, two particles cost nothing, and a click whose answer was dropped
  // under budget pressure reads as a click that missed.
  brushCross({ id: 'order_move', arm: ORDER_MARK_ARM, priority: 3 }),

  // --- swings ----------------------------------------------------------------
  // Painted, in the air, in the vocabulary the blood and the explosions are
  // already in (spec 233). What these replace is `scene.addEffect`'s orange
  // debug disc, which is what every skill in the table drew.
  //
  // Whirlwind needs no call-site change at all: `landArea` already sends
  // `skill.whirlwind.impact` at the caster's own feet, *before* the target loop,
  // so this draws on a turn that caught nobody -- which is what a swing is.
  // Registering the id is the whole of the wiring.
  brushSwing({
    id: 'skill.whirlwind.impact',
    // Inside the ability's own 160: the marks are thrown outward from 72% of the
    // reach, so a swing authored at the reach paints past it -- and the one
    // thing a player must read off this picture is who was caught.
    reach: 132,
    sweep: Math.PI * 2,
    // Ten rather than seven: at this radius the circumference is 830 units, and
    // seven lobes left gaps a body could stand in -- a full turn has to read as
    // a turn rather than as a few bursts that happen to be arranged in a ring.
    lobes: 10,
    lifetimeTicks: 30,
    priority: 3,
  }),
  // --- the landings that were a debug ring (spec 234) ------------------------
  //
  // Five ids, and **not one call-site change between them**: the server has
  // always sent `${ability.id}.impact` and `.self`, and `scene.addEffect` has
  // always checked the registry before falling back to its orange disc. So the
  // whole of "replace the generic animation" is authoring the effect under the
  // id that was already being sent.
  //
  // Four are `brushExplosion` recoloured, and that is the rule rather than
  // laziness: `docs/vfx-plan.md` asks for a *critical* to be louder in the same
  // language rather than a new one, and the same argument holds across elements
  // -- `burst()` already draws eight damage types as one crystal in eight
  // ramps. A frost skill that arrived in its own private vocabulary would read
  // as a different game's effect.
  //
  // Every ramp is the one spec 215 already authored for that element's
  // affliction, so a body catching fire from an Ember Toss and the toss itself
  // are the same orange, and Blight's rot is the desaturated ramp that exists
  // precisely so decay does not read as poison.

  // Ember Toss: the reference blast, at the row's own 70-unit burst.
  brushExplosion({ id: 'skill.emberToss.impact', radius: 70, light: true }),

  // Rime Touch: the same composition in frost, and **no smoke at all** -- ice
  // does not produce a mass that rolls over it afterwards, and a grey cloud
  // over a frost burst reads as a fire that went out. Shorter and faster than
  // the fire blast for the same reason: frost arrives and is done.
  // Rime Touch: **shards**, not a blast (spec 235).
  //
  // The first two versions were `brushExplosion` in ice colours and both read as
  // *water*, which is a fact about the composition rather than about the ramp:
  // that builder makes a few dominant strokes into lobes, and a few big pale
  // sheets is what a splash looks like. Frost wants the opposite distribution --
  // many small pieces, radially even, coming down rather than burning off.
  //
  // `brushShards` is that, and the one thing it deliberately does not have is a
  // lobe: `brushExplosion`'s "asymmetry has to be composed" argument is right
  // about a blast and wrong about a shatter, because ice breaking has no side it
  // favours.
  // `length` is the number that decides whether this reads at all. At the
  // builder's default 0.19 the shards were 20 units against a 104-unit reach and
  // the sheet showed a scatter of specks -- the correction from "water" went
  // straight past "shards" into "nothing". A third of the reach is a piece you
  // can see the shape of.
  brushShards({ id: 'skill.rimeTouch.impact', reach: 104, count: 32, length: 0.34, lifetimeTicks: 34 }),

  // Blight: rot, and the two numbers that make it rot rather than an explosion
  // are the smoke and the speed. It creeps out and the mass outlives it, where
  // fire throws and burns off.
  //
  // Deliberately **short** for a zone-denial skill, and that is a correction
  // rather than a compromise: `landBlast` resolves Blight *once*, so nothing
  // persists at that point, and a cloud that hung about for the ten seconds the
  // affliction runs would draw a standing hazard over ground that stopped being
  // dangerous the instant it landed. `cloud_poison` is authored at 600 ticks and
  // Decay lasts 601, which agree for entirely unrelated reasons -- one is a
  // particle lifetime and the other is the affliction on whoever was caught.
  // The day Blight becomes a point-anchored field, this grows a long variant.
  brushExplosion({
    id: 'skill.blight.impact',
    radius: 110,
    // Rot-coloured throughout, including the soot. The first render used
    // `smokeDark` there with ten masses arriving on tick two, and the result was
    // a near-black shape that grew over the body -- an oil spill rather than
    // rot, and it swallowed the decay ramp underneath it entirely. The mass is
    // half the size, arrives later, and is made of the same desaturated ramp
    // spec 215 authored so that decay does not read as poison.
    // Bright end forward, and **no smoke at all**. Spec 215 authored this ramp
    // to be a thin cling on a body -- at blast scale `decayDeep` (0x6e6a52) is
    // mud, and five smoke masses of it grew a near-black shape over the target
    // that swallowed the rot underneath. Twice: the first render used
    // `smokeDark`, and halving it and recolouring the soot was not enough,
    // because the problem is the *ramp at this size* rather than the amount.
    //
    // So the pale end carries it and the dark end is only the edge. What is
    // left is a sickly burst rather than a cloud, which is also the honest
    // picture: `landBlast` resolves Blight once and nothing lingers there.
    // Nothing muddy anywhere in the ramp, including `deep`. Dropping the smoke
    // fixed the black mass and cost the burst its size, so this is the third
    // pass: pale lilac throughout, expanding at half the fire blast's rate.
    // Slower than fire and wider than frost is what makes it rot; darker than
    // either is what made it a hole in the ground.
    palette: { hot: 'decayBright', warm: 'decayBright', mid: 'decayBody', burnt: 'decayBody', deep: 'decayBody', soot: 'decayDeep' },
    smoke: 0,
    debris: 2,
    lifetimeTicks: 58,
    expansionSpeed: 4.4,
    // Wide and low. Rot spreads rather than reaching.
    strokeLength: [0.7, 1.2],
    strokeThickness: [1.0, 1.5],
  }),

  // Arc Lash: the electric one. Long, thin, fast and gone -- everything a fire
  // blast is not, in one composition rather than a new vocabulary.
  //
  // It is a **burst at the caster** rather than the 300-unit lane the ability
  // actually is, and that is a stated limit rather than a look choice: the
  // effect message carries no rotation (`sim/types.ts`), and `landArea` sends a
  // line shape's cue at the caster's own feet, so there is no bearing to lay a
  // lane along. A lane pointing the wrong way is worse than a burst pointing
  // nowhere. Spec 235 puts a rotation on that message and this grows a lane.
  // Arc Lash: the lane it actually is (spec 235).
  //
  // Two versions of this were a `brushExplosion` at the caster, because the
  // effect message had no bearing on it and `landArea` sends a line's cue at the
  // caster's feet -- so a burst was the only honest thing to draw. It read, in
  // the reviewer's words, as *"too big and makes no sense with that skill"*, and
  // both halves of that were true: a 150-unit violet ball is neither the shape
  // nor the size of a 300x60 lane.
  //
  // With the bearing it is the run: nodes strung down the aim, kinking either
  // side of the centre line, each arriving a tick after the last.
  brushLane({
    id: 'skill.arcLash.impact',
    // The row's own, exactly. A lane is one of the two shapes where the picture
    // and the mechanic *are* the same rectangle -- unlike a burst, whose marks
    // are thrown outward from a radius and so must be authored inside it.
    length: 300,
    width: 60,
    nodes: 7,
    marks: 3,
    lifetimeTicks: 22,
    priority: 3,
  }),

  // Acid Spray: the cone, and the first cue this ability has ever had.
  //
  // `landCone` computed a bearing and raised no `effect` event at all, so this
  // was the one skill with not even a debug ring -- there was no id being sent
  // to fall back from. Corrosion's own ramp, the one spec 215 authored.
  brushLane({
    id: 'skill.acidSpray.impact',
    length: 150,
    width: 54,
    // A cone rather than a lane, which in this builder is where the nodes go
    // and nothing else: what is thrown at each of them is identical.
    cone: 0.5,
    nodes: 6,
    marks: 4,
    lifetimeTicks: 28,
    bright: 'corrodeBright',
    mid: 'corrodeBody',
    deep: 'corrodeDeep',
  }),

  // The Warden's lance, once per damage pulse (spec 259).
  //
  // Nothing new drives this: `landArea` already sends `${ability.id}.impact` at
  // the caster's feet with the lane's bearing on it, every pulse, hit or miss --
  // so registering the id under that name is the whole of the wiring, and the
  // cadence is the sim's own damage tick rather than a clock the renderer keeps.
  //
  // Its length and width are **imported rather than typed**, the same rule
  // `skill.scorchedEarth.self` below states: this is not decoration around the
  // mechanic, it is where the beam is, and marks that ran past the lane would
  // paint ground that is safe. Two literals that have to agree is the drift a
  // shared constant exists to refuse.
  brushBeam({
    id: `${WARDEN_LASER.abilityId}.impact`,
    length: WARDEN_LASER.range,
    width: WARDEN_LASER.width,
    // Six along six hundred units is a spark cluster every hundred, which at
    // four pulses a second is a beam that crackles along its whole length
    // without any one place on it becoming a bonfire.
    nodes: 6,
    // **Longer than the gap between pulses**, and derived from it rather than
    // typed. The first cut was shorter, on the argument that each beat should
    // be visibly its own -- photographed, that is a beam whose sparks vanish
    // for a few ticks four times a second, which reads as a strobe rather than
    // as something sustained. The beam under them is continuous, so these have
    // to be. Five ticks of overlap is enough to close the gap and far short of
    // eight pulses accumulating: the marks that survive into the next beat are
    // the dimmest end of the previous one.
    lifetimeTicks: WARDEN_LASER.pulseIntervalTicks + 5,
  }),

  // Scorched Earth: the ignition, which is the moment the ring is not.
  // `aura_scorched` is the field standing there; this is it catching.
  //
  // Its radius is imported rather than typed, the same way that ring's is: this
  // is not decoration around the mechanic, it is where the fire is about to be,
  // and a burst that reached further than the field would promise ground that is
  // safe.
  brushExplosion({
    id: 'skill.scorchedEarth.self',
    radius: SCORCHED_EARTH.radius,
    // Three masses, briefly. A smoke mass is sized off the radius, and at the
    // field's 130 the five this had were a column taller than the body that lit
    // it -- the ignition read as the whole screen catching rather than as the
    // ground. The fire is what says the skill happened; the smoke is the beat
    // after it, and at this size a beat is all it may be.
    smoke: 3,
    smokeDelayTicks: 10,
    smokeLifeTicks: [34, 52],
    debris: 2,
    lifetimeTicks: 54,
    // Outward and low: the ground catching, rather than something going off.
    expansionSpeed: 5.5,
    strokeLength: [0.7, 1.2],
    light: true,
    priority: 3,
  }),

  // The melee skills, played by `world/swing-vfx.ts` at the attacker on the tick
  // the blow lands -- whether or not it landed on anybody. One sweep for four
  // skills, because what differs between a cripple and a rend is the
  // *affliction*, which is painted on the body it landed on; the blade going
  // past is the same blade.
  brushSwing({ id: 'swing_arc', reach: 74, sweep: 2.1, lobes: 4 }),
  // Louder in the same language, never a different one: Stunning Blow is wound
  // up from the shoulder over 0.9s and telegraphed the whole way.
  brushSwing({ id: 'swing_arc_heavy', reach: 88, sweep: 2.7, lobes: 5, lifetimeTicks: 32, priority: 3 }),

  // --- explosions ------------------------------------------------------------
  // The reference, at full size: a crystal that opens, throws rock and leaves a
  // warm mark. Everything below it is the same builder with smaller numbers.
  burst({ id: 'explosion_large', scale: 88, hot: 'fireCore', warm: 'fireBody', cool: 'fireDeep', spikes: 44, chunks: 18, light: true, priority: 3 }),
  burst({ id: 'explosion_small', scale: 46, hot: 'fireCore', warm: 'fireBody', cool: 'fireDeep', spikes: 30, chunks: 10, light: true }),
  // A jet rather than a ball: a charge that went off against something, so it
  // fires along the blow instead of in every direction.
  burst({ id: 'explosion_directed', scale: 62, hot: 'fireCore', warm: 'fireBody', cool: 'fireDeep', spikes: 30, chunks: 9, spread: 0.55, light: true }),
  // Along the floor. The star a ground slam leaves, which reads at a glance from
  // directly above where an upright one is a dot.
  burst({ id: 'explosion_ground', scale: 70, hot: 'fireCore', warm: 'fireBody', cool: 'fireDeep', spikes: 38, chunks: 12, flat: true, light: true }),

  // --- hit effects, one burst per damage type --------------------------------
  // The same crystal, small. A hit is not a different vocabulary from an
  // explosion; it is the quiet end of one.
  burst({ id: 'impact_flash', scale: 17, hot: 'physicalBone', warm: 'physicalGrey', cool: 'dustStone', spikes: 17, dust: false }),
  burst({ id: 'hit_physical', scale: 18, hot: 'physicalBone', warm: 'physicalGrey', cool: 'dustStone', spikes: 18, chunks: 5 }),
  burst({ id: 'hit_fire', scale: 22, hot: 'fireCore', warm: 'fireBody', cool: 'fireDeep', spikes: 21, light: true }),
  burst({ id: 'hit_poison', scale: 19, hot: 'poisonPale', warm: 'poisonDeep', cool: 'poisonMurk', spikes: 17 }),
  burst({ id: 'hit_ice', scale: 20, hot: 'iceWhite', warm: 'icePale', cool: 'iceDeep', spikes: 21, chunks: 6 }),
  burst({ id: 'hit_lightning', scale: 24, hot: 'boltWhite', warm: 'boltYellow', cool: 'boltViolet', spikes: 22, dust: false, light: true }),
  burst({ id: 'hit_arcane', scale: 21, hot: 'arcaneLilac', warm: 'arcaneMagenta', cool: 'arcaneDeep', spikes: 20, dust: false }),
  // The two the afflictions needed and the table did not have (spec 232).
  //
  // Written in the same builder as the six above rather than in the painted
  // vocabulary, because what makes this table legible is that every damage type
  // is *the same crystal in different colours* -- two of eight in a different
  // language would read as two effects rather than as two damage types. The day
  // the whole table moves to paint, these move with it.
  //
  // Their colours are not chosen here: spec 215 authored both ramps for the
  // afflictions they belong to, and `decay` is the only desaturated ramp in the
  // palette precisely so rot does not read as poison. A corrosion blow and a
  // Corrosion cling are the same yellow-green for the same reason a heal and a
  // heal ring are the same green.
  burst({ id: 'hit_corrosion', scale: 19, hot: 'corrodeBright', warm: 'corrodeBody', cool: 'corrodeDeep', spikes: 17 }),
  // `dust: false` for the reason `hit_arcane` has it: rot chips nothing off.
  burst({ id: 'hit_decay', scale: 18, hot: 'decayBright', warm: 'decayBody', cool: 'decayDeep', spikes: 15, dust: false }),
  // Louder in the same language: a bigger crystal, never a different one.
  burst({ id: 'hit_critical', scale: 34, hot: 'sparkHot', warm: 'sparkWarm', cool: 'sparkEmber', spikes: 30, chunks: 7, priority: 3, light: true }),

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
        render: 'mesh',
        mesh: { shape: 'blob' },
        blend: 'alpha',
      },
    ],
  },

  // The shockwave: the combined thing the reference shows (spec 126). The same
  // crystal and the same thrown rock as an explosion, laid flat so the streaks
  // run along the ground, plus a wavefront that outruns and outlives all of it.
  // Frost-coloured, because that is what a shockwave is here -- an impact that
  // pushed rather than burned.
  burst({
    id: 'shockwave_ring',
    scale: 64,
    hot: 'iceWhite',
    warm: 'icePale',
    cool: 'iceDeep',
    spikes: 42,
    chunks: 16,
    flat: true,
    ring: true,
    // No warm pool. `glow` is the scorch a fire leaves, and in frost colours it
    // is a dark blue stain sitting under the wave for ten ticks after the wave
    // has gone -- which on the sheet reads as a bug rather than as ice.
    glow: false,
    priority: 2,
  }),

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
        alpha: { keys: [[0, 0], [0.15, 0.6], [1, 0]] },
        color: { stops: [[0, 'dustPale'], [1, 'dustStone']] },
        render: 'mesh',
        mesh: { shape: 'blob' },
        blend: 'alpha',
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
