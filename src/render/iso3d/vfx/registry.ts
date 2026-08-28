/**
 * The effect table (spec 118).
 *
 * This is the *one place* an effect is described. A call site says
 * `vfx.play('hit_metal_spark', { ... })` and knows nothing else; adding an
 * effect is adding an entry here, and retuning one is editing numbers here (or
 * in the Studio tab, which writes back to this shape as JSON).
 *
 * Sparks are the first entry, and they landed with the core because the core
 * needed something real to be proved against -- the low-resolution verification
 * and the glow comparison in `scripts/probe-vfx.ts` are both driven by this
 * definition. Blood is spec 119; fire, auras, smoke and the remaining hit
 * effects follow it.
 * `spark_bounce` is here because a spark's ricochet is a sub-effect and a
 * sub-effect has to be an entry like any other.
 */

import { compileRegistry, type CompiledRegistry } from './compile.js';
import { LIBRARY } from './library.js';
import { BRUSH_EFFECTS } from './brush.js';
import type { EffectDefinition } from './types.js';

/**
 * The tiny flash where a spark strikes the ground again.
 *
 * Two particles and a dozen ticks. Small enough to be nearly free, and it is the
 * difference between sparks that bounce and sparks that pass through the floor.
 */
const SPARK_BOUNCE: EffectDefinition = {
  id: 'spark_bounce',
  priority: 0,
  cullDistance: 900,
  emitters: [
    {
      id: 'tick',
      shape: { kind: 'point' },
      emission: { kind: 'burst', count: 2 },
      lifetimeTicks: [4, 9],
      speed: [40, 110],
      spreadRadians: 1.4,
      gravity: -900,
      drag: 2.5,
      size: { keys: [[0, 2.2], [1, 0.6]] },
      alpha: { keys: [[0, 0.9], [1, 0]] },
      color: { stops: [[0, 'sparkWarm'], [1, 'sparkEmber']] },
      render: 'stretched',
      blend: 'additive',
      stretch: 0.03,
    },
  ],
};

/**
 * A blow landing on metal: the first authored effect, and the subject the
 * low-resolution verification and the glow comparison are both measured on.
 *
 * Three emitters, because the thing being drawn is three things: the flash at
 * the contact point that says *when*, the shower that says *where from*, and a
 * few long-lived stragglers so the moment has a tail rather than a hard end.
 *
 * The flash is deliberately oversized and only three ticks long. At 300 pixels
 * tall a subtle flash is no flash, and a long one reads as a fire.
 */
const HIT_METAL_SPARK: EffectDefinition = {
  id: 'hit_metal_spark',
  priority: 2,
  cullDistance: 1400,
  emitters: [
    {
      id: 'flash',
      shape: { kind: 'point' },
      emission: { kind: 'burst', count: 1 },
      lifetimeTicks: [3, 4],
      speed: [0, 0],
      size: { keys: [[0, 16], [1, 23]] },
      alpha: { keys: [[0, 0.95], [1, 0]] },
      color: { stops: [[0, 'sparkHot'], [1, 'sparkWarm']] },
      render: 'billboard',
      blend: 'additive',
    },
    {
      id: 'shower',
      shape: { kind: 'cone', angle: 1.05, radius: 2 },
      emission: { kind: 'burst', count: 14 },
      lifetimeTicks: [8, 20],
      speed: [220, 460],
      spreadRadians: 1.05,
      gravity: -900,
      drag: 1.6,
      size: { keys: [[0, 3.2], [0.25, 2.4], [1, 0.9]] },
      alpha: { keys: [[0, 1], [0.7, 1], [1, 0]] },
      color: { stops: [[0, 'sparkHot'], [0.35, 'sparkWarm'], [1, 'sparkEmber']] },
      velocityScale: { keys: [[0, 1], [1, 0.55]] },
      render: 'stretched',
      blend: 'additive',
      stretch: 0.04,
      collision: { restitution: 0.35, friction: 0.4, maxBounces: 2, onCollide: 'spark_bounce' },
      light: { color: 'sparkWarm', intensity: { keys: [[0, 1], [1, 0]] }, radius: 90 },
      sound: { cue: 'impact_metal', on: 'burst' },
    },
    {
      id: 'stragglers',
      shape: { kind: 'cone', angle: 0.5, radius: 1 },
      emission: { kind: 'burst', count: 3 },
      lifetimeTicks: [34, 52],
      speed: [140, 260],
      spreadRadians: 0.5,
      gravity: -900,
      drag: 1.1,
      size: { keys: [[0, 2.4], [1, 0.8]] },
      alpha: { keys: [[0, 1], [0.85, 0.9], [1, 0]] },
      color: { stops: [[0, 'sparkWarm'], [1, 'sparkEmber']] },
      render: 'stretched',
      blend: 'additive',
      stretch: 0.05,
      collision: { restitution: 0.45, friction: 0.35, maxBounces: 2, onCollide: 'spark_bounce' },
    },
  ],
};

/**
 * A blow that draws blood (spec 120).
 *
 * The droplets are the whole effect: they fly, they fall, and the ones that
 * reach the ground leave a stain that outlives them. There is no separate
 * "spawn a decal" step -- the collision does it, which is what keeps a spatter's
 * marks where its drops actually landed rather than in a ring around the victim.
 *
 * `chance` below 1 on purpose. Every drop leaving a mark fills a chunk's budget
 * in one fight and reads as a stencil rather than as a spatter.
 *
 * The drops draw as **ribbons** (spec 139), which is the one thing that makes a
 * spray read as fluid rather than as hardware. A `stretched` quad is aligned to
 * the velocity a particle has *this tick* and is that long from the tick it is
 * born, so a drop leaves the body as a rigid bar and stays one; a ribbon is the
 * path the drop actually flew, so it starts short, draws out as it travels, and
 * bends as gravity turns it over.
 */
const HIT_BLOOD: EffectDefinition = {
  id: 'hit_blood',
  priority: 2,
  cullDistance: 1500,
  emitters: [
    {
      id: 'spray',
      shape: { kind: 'cone', angle: 0.85, radius: 3 },
      emission: { kind: 'burst', count: 12 },
      lifetimeTicks: [14, 34],
      speed: [90, 260],
      spreadRadians: 0.7,
      gravity: -1100,
      drag: 0.8,
      size: { keys: [[0, 3.4], [1, 2.2]] },
      alpha: { keys: [[0, 1], [1, 1]] },
      color: { stops: [[0, 'bloodFresh'], [1, 'bloodDeep']] },
      render: 'ribbon',
      // Alpha rather than additive: blood is a fluid and does not glow.
      blend: 'alpha',
      // Close samples, because the whole streak is only a few of them: a drop
      // this size wants a tail about a body wide, not the 66 units twelve
      // samples at the default spacing would give it.
      ribbonSpacing: 3,
      ribbonTaper: 0.4,
      collision: {
        restitution: 0,
        friction: 0.8,
        maxBounces: 0,
        dieOnCollide: true,
        decal: { fluid: 'blood', size: [18, 42], chance: 0.55 },
      },
    },
    {
      id: 'mist',
      shape: { kind: 'cone', angle: 1.2, radius: 2 },
      emission: { kind: 'burst', count: 8 },
      lifetimeTicks: [6, 14],
      speed: [40, 130],
      spreadRadians: 1.1,
      gravity: -300,
      drag: 3.2,
      size: { keys: [[0, 2.6], [1, 0.8]] },
      alpha: { keys: [[0, 0.85], [1, 0]] },
      color: { stops: [[0, 'bloodFresh'], [1, 'bloodDeep']] },
      render: 'billboard',
      blend: 'dither-cutout',
    },
  ],
};

/**
 * The killing blow: the same language, louder, and it pools.
 *
 * Not a new shape vocabulary -- more drops, thrown further, and a much larger
 * stain at the impact point itself, which is what "pooling" is at this
 * resolution.
 */
const DEATH_BLOOD: EffectDefinition = {
  id: 'death_blood',
  priority: 2,
  cullDistance: 1600,
  emitters: [
    {
      id: 'spray',
      shape: { kind: 'cone', angle: 1, radius: 4 },
      emission: { kind: 'burst', count: 24 },
      lifetimeTicks: [16, 46],
      speed: [110, 340],
      spreadRadians: 0.9,
      gravity: -1100,
      drag: 0.7,
      size: { keys: [[0, 4], [1, 2.4]] },
      alpha: { keys: [[0, 1], [1, 1]] },
      color: { stops: [[0, 'bloodFresh'], [1, 'bloodDeep']] },
      render: 'ribbon',
      blend: 'alpha',
      // A touch further apart than `hit_blood`: this is the loud one, thrown
      // harder, and its arcs want the room to actually curve.
      ribbonSpacing: 3.5,
      ribbonTaper: 0.35,
      collision: {
        restitution: 0,
        friction: 0.8,
        maxBounces: 0,
        dieOnCollide: true,
        decal: { fluid: 'blood', size: [22, 56], chance: 0.7 },
      },
    },
    {
      id: 'pool',
      shape: { kind: 'point' },
      emission: { kind: 'burst', count: 1 },
      lifetimeTicks: [2, 2],
      speed: [0, 0],
      gravity: -600,
      size: { keys: [[0, 2]] },
      alpha: { keys: [[0, 0]] },
      color: { stops: [[0, 'bloodDeep']] },
      render: 'billboard',
      blend: 'alpha',
      collision: {
        restitution: 0,
        friction: 1,
        maxBounces: 0,
        dieOnCollide: true,
        decal: { fluid: 'blood', size: [70, 96], chance: 1 },
      },
    },
  ],
};

/**
 * Every authored effect, in one array.
 *
 * The impacts and the blood are written out here because they were the effects
 * the machinery was proved against; everything else is `library.ts`, where fire,
 * smoke, auras and the rest of the hit vocabulary are built from three
 * parameterized families (spec 121).
 */
export const EFFECTS: readonly EffectDefinition[] = [
  SPARK_BOUNCE,
  HIT_METAL_SPARK,
  HIT_BLOOD,
  DEATH_BLOOD,
  ...LIBRARY,
  // The painted vocabulary (spec 158). A file of its own rather than another
  // family in `library.ts`, because it is not another set of numbers over the
  // same shapes -- it brings its own geometry, its own two orientations and its
  // own emitter shape with it, and the argument for all three is worth keeping
  // beside the effects that spend them.
  ...BRUSH_EFFECTS,
];

/**
 * The compiled table, built once at module load.
 *
 * Exported as a value rather than behind a function so that the cost is paid at
 * import and there is exactly one of it -- two registries would mean two
 * `pool.emitter` numbering schemes and particles drawn with the wrong emitter.
 */
export const REGISTRY: CompiledRegistry = compileRegistry(EFFECTS);
