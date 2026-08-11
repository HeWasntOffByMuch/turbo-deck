/**
 * The stress fixture (spec 118).
 *
 * One definition that exercises every branch of the update loop at once, shared
 * by `alloc.test.ts` and `scripts/profile-vfx.ts` so the thing being asserted in
 * CI and the thing being measured by hand are the same thing. Two copies of this
 * would drift, and the drift would be invisible: both would still pass.
 *
 * Not part of the shipped effect library -- `registry.ts` is that -- and
 * deliberately unbalanced, since the point is coverage rather than looks.
 */

import type { EffectDefinition } from './types.js';

/**
 * A definition that exercises every part of the update loop at once: bursts and
 * a continuous rate, curves, a gradient, turbulence, collision with a bounce,
 * a sub-effect on collide, a ribbon and a light.
 */
export const STRESS_EFFECTS: readonly EffectDefinition[] = [
  {
    id: 'ping',
    priority: 0,
    emitters: [
      {
        id: 'e',
        shape: { kind: 'point' },
        emission: { kind: 'burst', count: 2 },
        lifetimeTicks: [4, 8],
        speed: [10, 40],
        gravity: -400,
        size: { keys: [[0, 2], [1, 0]] },
        alpha: { keys: [[0, 1], [1, 0]] },
        color: { stops: [[0, 'sparkWarm'], [1, 'sparkEmber']] },
        render: 'billboard',
        blend: 'additive',
      },
    ],
  },
  {
    id: 'kitchen_sink',
    priority: 2,
    emitters: [
      {
        id: 'shower',
        shape: { kind: 'cone', angle: 1, radius: 4 },
        emission: { kind: 'rate', perSecond: 240 },
        lifetimeTicks: [30, 70],
        speed: [120, 300],
        spreadRadians: 0.6,
        gravity: -900,
        drag: 1.2,
        angularVelocity: [-4, 4],
        turbulence: { amplitude: 260, frequency: 0.02 },
        acceleration: { x: 5, y: 0, z: -5 },
        size: { keys: [[0, 3], [0.4, 4], [1, 1]] },
        alpha: { keys: [[0, 1], [0.8, 0.7], [1, 0]] },
        color: { stops: [[0, 'fireCore'], [0.5, 'fireBody'], [1, 'smokeDark']] },
        rotation: { keys: [[0, 0], [1, 3]] },
        velocityScale: { keys: [[0, 1], [1, 0.4]] },
        render: 'stretched',
        blend: 'alpha',
        sprite: { sheet: 'puff', frames: 8, fps: 12, randomStart: true },
        collision: { restitution: 0.4, friction: 0.3, maxBounces: 3, onCollide: 'ping' },
        light: { color: 'emberGlow', intensity: { keys: [[0, 1], [1, 0]] }, radius: 80 },
      },
      {
        id: 'streak',
        shape: { kind: 'sphere', radius: 6 },
        emission: { kind: 'rate', perSecond: 30 },
        lifetimeTicks: [40, 60],
        speed: [80, 160],
        gravity: -200,
        size: { keys: [[0, 2]] },
        alpha: { keys: [[0, 1], [1, 0]] },
        color: { stops: [[0, 'sparkHot']] },
        render: 'ribbon',
        blend: 'additive',
        ribbonSpacing: 4,
      },
    ],
  },
];
