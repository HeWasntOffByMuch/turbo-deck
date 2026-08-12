/**
 * A streak that follows the flight it was made by (spec 139).
 *
 * The sim already records where a ribbon particle has been: `system.ts` claims a
 * track at birth and pushes a sample onto it every time the particle has
 * travelled `ribbonSpacing` world units, which is the same distance-gated rule
 * `world/trail.ts` uses for projectiles -- a streak is a property of the flight
 * and not of the frame rate. Nothing ever drew those samples. `modeCode` fell
 * through to the billboard and every emitter that asked for a ribbon got a
 * camera-facing quad, which is exactly what spec 123 found `RenderMode.mesh`
 * doing.
 *
 * This is the arithmetic that turns a track into quads, and it is here rather
 * than in `layer.ts` so it can be replayed in Node. It writes into a caller's
 * `Float32Array` and allocates nothing, for the same reason as everything else
 * in this system.
 *
 * ## Why the shape is a chain and not one long quad
 *
 * A single velocity-aligned quad is straight by construction, and a drop of
 * blood is not: it leaves at 200-odd units a second under 1100 of gravity, so
 * over the fifth of a second it is airborne it falls twenty units clear of the
 * line it left on. Drawn as one quad that curve is thrown away and what is left
 * is a rigid bar the length of a body. Drawn as a chain, the curve *is* the
 * shape, and it costs a handful of instances in a batch that is already
 * uploading floats.
 *
 * ## Widths, not alphas
 *
 * The taper is width, and the alpha over the whole streak stays the particle's
 * own. Fading the tail out instead would be the same picture at full resolution
 * and a worse one here: the frame is quantized to a few levels, so a ramp along
 * a three-pixel streak arrives as one or two hard steps -- a streak with a
 * notch in it. A width that narrows is geometry, and geometry survives the
 * quantizer.
 */

import { RIBBON_SAMPLES } from './pool.js';

/** Floats per segment: fromXYZ, toXYZ, width at the from end, width at the to end. */
export const SEGMENT_STRIDE = 8;

/**
 * The most segments one particle can produce: the whole trail, plus the head.
 *
 * The head is its own segment because samples are distance-gated -- the newest
 * one lags the particle by up to `ribbonSpacing`, and without it a fast streak
 * is visibly detached from the drop that is drawing it.
 */
export const MAX_SEGMENTS = RIBBON_SAMPLES;

/**
 * How thin a tail may get, in world units.
 *
 * A hard floor rather than a fraction, because the failure it prevents is a
 * property of the *frame* and not of the streak. At the Play tab's default zoom
 * one virtual pixel is about 0.84 world units (`DEFAULT_VIEW_HALF_WIDTH` of 320
 * over `MAX_RENDER_W` of 760), so a quad narrower than this is sub-pixel and the
 * rasteriser catches it in some places and misses it in others: a streak comes
 * out as a dashed line that crawls from frame to frame. The first cut of this
 * tapered to 0.35 and the browser check showed exactly that -- solid near the
 * head, beads down the tail. An authored taper below the floor still tapers, it
 * just stops before it disappears.
 */
const MIN_WIDTH = 1;

/** Below this, the newest sample and the particle are the same point. */
const COINCIDENT = 1e-3;

/**
 * Chain a trail into segments, oldest first.
 *
 * `samples` is the pool's flat sample store, `base` the track's offset into it
 * and `held` how many samples it holds. `(headX, headY, headZ)` is where the
 * particle is *now*. `width` is the head's width and `taper` the fraction of it
 * the tail narrows to.
 *
 * Returns the number of segments written into `out`, each `SEGMENT_STRIDE`
 * floats. Ends meet exactly -- segment n's `to` is segment n+1's `from` -- so a
 * chain has no gaps to show a seam through.
 */
export function ribbonSegments(
  samples: Float32Array,
  base: number,
  held: number,
  headX: number,
  headY: number,
  headZ: number,
  width: number,
  taper: number,
  out: Float32Array,
): number {
  if (held <= 0) return 0;
  // Never wider than the head: a streak thinner than the floor to begin with has
  // nothing to taper, and inverting it would draw a wedge pointing backwards.
  const tailWidth = Math.min(width, Math.max(MIN_WIDTH, width * Math.max(0, Math.min(1, taper))));
  // `held` points plus the head is `held` segments.
  const segments = Math.min(held, Math.floor(out.length / SEGMENT_STRIDE));
  const last = segments;

  for (let s = 0; s < segments; s++) {
    const fromAt = base + (held - segments + s) * 3;
    const fromX = samples[fromAt] ?? 0;
    const fromY = samples[fromAt + 1] ?? 0;
    const fromZ = samples[fromAt + 2] ?? 0;

    let toX = headX;
    let toY = headY;
    let toZ = headZ;
    if (s + 1 < segments) {
      const toAt = fromAt + 3;
      toX = samples[toAt] ?? 0;
      toY = samples[toAt + 1] ?? 0;
      toZ = samples[toAt + 2] ?? 0;
    } else if (
      Math.abs(toX - fromX) < COINCIDENT &&
      Math.abs(toY - fromY) < COINCIDENT &&
      Math.abs(toZ - fromZ) < COINCIDENT
    ) {
      // The head link on the tick the distance gate fired: the newest sample IS
      // the particle, so this link is a zero-length quad. Dropping it costs the
      // streak nothing -- it already reaches the drop -- and saves an instance
      // per particle per frame on a burst where every drop hits this eventually.
      return s;
    }

    // 0 at the oldest end of the chain, 1 at the head.
    const fromT = s / last;
    const toT = (s + 1) / last;
    const at = s * SEGMENT_STRIDE;
    out[at] = fromX;
    out[at + 1] = fromY;
    out[at + 2] = fromZ;
    out[at + 3] = toX;
    out[at + 4] = toY;
    out[at + 5] = toZ;
    out[at + 6] = tailWidth + (width - tailWidth) * fromT;
    out[at + 7] = tailWidth + (width - tailWidth) * toT;
  }
  return segments;
}

/**
 * One segment behind a particle that has no trail to draw.
 *
 * Two ways to end up here, and both have to draw something. A particle in its
 * first tick has a single sample and nowhere to have travelled yet; and tracks
 * are a bounded side-table, so a fight loud enough to run them out hands the
 * losers -1 and they would otherwise be invisible. A short velocity-aligned
 * stub is the honest degradation -- it is the straight streak this spec is
 * replacing, at a length short enough that nobody reads it as a pipe.
 */
export function fallbackSegment(
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  width: number,
  taper: number,
  out: Float32Array,
): number {
  if (out.length < SEGMENT_STRIDE) return 0;
  const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
  // Along the direction of travel, a couple of widths back. Straight down when a
  // particle is not moving at all, so the quad is never degenerate.
  const length = width * 2;
  const scale = speed > 1e-4 ? length / speed : 0;
  out[0] = x - vx * scale;
  out[1] = speed > 1e-4 ? y - vy * scale : y - length;
  out[2] = z - vz * scale;
  out[3] = x;
  out[4] = y;
  out[5] = z;
  out[6] = Math.min(width, Math.max(MIN_WIDTH, width * Math.max(0, Math.min(1, taper))));
  out[7] = width;
  return 1;
}
