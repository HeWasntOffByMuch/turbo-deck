/**
 * The effect table (spec 118).
 *
 * This is the *one place* an effect is described. A call site says
 * `vfx.play('hit_metal_spark', { ... })` and knows nothing else; adding an
 * effect is adding an entry here, and retuning one is editing numbers here (or
 * in the Studio tab, which writes back to this shape as JSON).
 *
 * Sparks are the first entry and land with spec 119, which is also where the
 * low-resolution verification and the glow comparison are. The rest of the
 * library -- fire, blood, auras, smoke, the remaining hit effects -- follows it.
 * `spark_bounce` is here because a spark's ricochet is a sub-effect and a
 * sub-effect has to be an entry like any other.
 */

import { compileRegistry, type CompiledRegistry } from './compile.js';
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
 * A blow landing on metal (spec 119's subject).
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

/** Every authored effect, in one array. */
export const EFFECTS: readonly EffectDefinition[] = [SPARK_BOUNCE, HIT_METAL_SPARK];

/**
 * The compiled table, built once at module load.
 *
 * Exported as a value rather than behind a function so that the cost is paid at
 * import and there is exactly one of it -- two registries would mean two
 * `pool.emitter` numbering schemes and particles drawn with the wrong emitter.
 */
export const REGISTRY: CompiledRegistry = compileRegistry(EFFECTS);
