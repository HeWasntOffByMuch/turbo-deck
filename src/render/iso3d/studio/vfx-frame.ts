/**
 * How big a box the preview has to draw to hold an effect (spec 122).
 *
 * Pure -- no three.js, no DOM -- and measured rather than declared: the effect is
 * played in a real `VfxSystem` for a couple of hundred ticks and the extent of
 * what it actually spawned is read off the pool. That is the only honest source.
 * A bound derived from the authored numbers has to know that a `size` of 110 is a
 * *radius* for a sigil lying flat, a *height* for a flame standing up, and a
 * half-width for a billboard, which is three special cases and a fourth waiting
 * for the next shape.
 *
 * ## Why a sphere and not a box
 *
 * The preview's camera orbits. A box that fits an effect head-on does not fit it
 * from above -- which is exactly the report this exists to answer: a hundred-unit
 * aura framed fine at a low angle and had its far side cut off the moment the
 * camera was raised, because a ring seen from overhead is twice as tall on screen
 * as one seen edge-on. A bounding sphere is the same size from every angle, so a
 * frame that holds it holds it at every camera the panel can reach.
 */

import { compileRegistry } from '../vfx/compile.js';
import { VfxSystem } from '../vfx/system.js';
import type { EffectDefinition } from '../vfx/types.js';

export interface PreviewFrame {
  /** Orthographic span that contains the effect from any angle, world units. */
  readonly span: number;
  /** Where the camera should point, so the effect is centred rather than cropped. */
  readonly centreY: number;
}

/** Air around the effect, as a fraction. A shape touching the edge reads as cropped. */
const MARGIN = 1.18;

/**
 * Measure an effect.
 *
 * `ticks` is how long to watch it for. Long enough that a rate emitter has
 * reached steady state and a burst has finished travelling; short enough that
 * this is a few hundred microseconds, which is what lets it run on every effect
 * selection rather than being cached.
 */
export function previewFrame(effect: EffectDefinition, spawnY: number, ticks = 240): PreviewFrame {
  const system = new VfxSystem({
    registry: compileRegistry([effect]),
    hooks: { ground: () => 0 },
    limits: { maxParticles: 3000, maxInstances: 8, pressureFloor: 0.25 },
  });
  system.play(effect.id, { x: 0, y: spawnY, z: 0, seed: 20260810 });

  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let reach = 0;
  const pool = system.pool;

  // Stepped one tick at a time and measured at every one, because the widest
  // moment of a burst is somewhere in the middle of it and the last frame of a
  // spark is one straggler.
  for (let tick = 0; tick < ticks; tick++) {
    system.update(1);
    for (let i = 0; i < pool.count; i++) {
      // A particle's own size, so a big blob's edge is inside the frame and not
      // just its centre.
      const size = pool.size[i] ?? 0;
      const y = pool.y[i] ?? 0;
      low = Math.min(low, y - size);
      high = Math.max(high, y + size);
      const x = Math.abs(pool.x[i] ?? 0) + size;
      const z = Math.abs(pool.z[i] ?? 0) + size;
      reach = Math.max(reach, x, z);
    }
  }

  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    // An effect that spawned nothing at all. Frame the spawn point and let the
    // "no particles" readout be the thing that says so.
    return { span: 80, centreY: spawnY };
  }

  const centreY = (low + high) / 2;
  // The corner: the widest particle and the highest one need not be the same
  // one, so this is an upper bound rather than the exact hull. Erring outwards
  // costs a little empty ground and erring inwards is the bug being fixed.
  const radius = Math.hypot(reach, (high - low) / 2);
  return { span: Math.max(40, radius * 2 * MARGIN), centreY };
}
