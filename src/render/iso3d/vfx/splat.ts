/**
 * Blood splats: authored masses, thrown procedurally (spec 119).
 *
 * Pure -- no three.js, no DOM, no clock. Emits an 8-bit coverage mask that
 * `textures.ts` turns into a texture and the gradient tints, which is what lets
 * one generator serve blood, sap, ichor, oil and slime.
 *
 * ## Why it is a hybrid, and not either pure option
 *
 * A handful of authored sprites repeats visibly inside one fight. The eye finds
 * a repeated blot faster than almost anything else on screen.
 *
 * Fully procedural noise -- fBm, worley, metaballs over a random field -- never
 * repeats, and never looks drawn either. At 240x150 with the frame quantized to
 * a handful of palette steps, noise arrives as grey mush. Silhouette is the
 * entire read at this resolution, and noise has none.
 *
 * So the *shape language* is authored -- {@link BLOTS} is a small set of
 * hand-written radial profiles, deliberately lumpy and asymmetric, which is what
 * makes them read as ink rather than as circles -- and everything else is drawn
 * from a seed: which blot, how big, how turned, mirrored or not, where the
 * satellite droplets land, how far the drips run, and how the whole thing is
 * stretched along the direction of the blow.
 *
 * ## Hard edges, always
 *
 * The mask is thresholded to 0 or 255 and never anything between. A soft edge is
 * something the frame's quantizer will turn into a visible band anyway, so the
 * decision is made here where it can be authored rather than there where it
 * cannot.
 *
 * ## On reusing `poisson.ts`
 *
 * The droplet scatter uses that file's *rule* -- best-of-N candidates, keeping
 * whichever is furthest from everything placed so far -- but not the function.
 * `poissonDisk` is radially uniform by construction and threads the sim's
 * immutable `Rng`; a spatter is directional by the whole point of it, and the
 * VFX layer has its own mutable generator. Same idea, different shape.
 */

import { VfxRng } from './rng.js';

/**
 * The authored blots, as radii at 16 evenly spaced angles, normalized to 1.
 *
 * Hand-written rather than generated. Each one is a mass with a couple of lobes
 * and a flat side or two -- the asymmetry is the whole point, since a profile
 * that is nearly constant is a circle and reads as a bullet hole.
 */
export interface BlotProfile {
  readonly radii: readonly number[];
}

export const BLOTS: readonly BlotProfile[] = [
  // A round mass with one heavy lobe and a bitten-in side.
  { radii: [1.0, 0.94, 0.82, 0.71, 0.78, 0.9, 0.97, 0.88, 0.72, 0.62, 0.7, 0.85, 0.96, 1.0, 0.99, 0.98] },
  // Two lobes, joined -- a drop that hit and split.
  { radii: [0.86, 1.0, 0.93, 0.64, 0.5, 0.58, 0.8, 0.95, 0.88, 0.66, 0.52, 0.61, 0.83, 0.97, 0.94, 0.9] },
  // Long and narrow: a glancing blow.
  { radii: [1.0, 0.93, 0.72, 0.52, 0.42, 0.44, 0.58, 0.8, 0.98, 0.92, 0.7, 0.5, 0.41, 0.45, 0.6, 0.82] },
  // Broad and ragged, with three shallow bites out of the rim.
  { radii: [0.95, 0.99, 0.86, 0.93, 0.78, 0.9, 1.0, 0.84, 0.9, 0.97, 0.8, 0.88, 0.99, 0.87, 0.92, 0.98] },
  // Nearly a teardrop, heavy at one end.
  { radii: [1.0, 0.97, 0.88, 0.74, 0.6, 0.49, 0.42, 0.4, 0.43, 0.5, 0.61, 0.75, 0.87, 0.95, 0.99, 1.0] },
];

export type FluidKind = 'blood' | 'sap' | 'ichor' | 'oil' | 'slime';

export interface SplatParams {
  /** Texture edge, in pixels. */
  readonly size: number;
  /** 0..1, how much of the tile the main blot fills. */
  readonly mass: number;
  readonly droplets: number;
  /** How far satellites carry, as a fraction of the tile. */
  readonly spread: number;
  /** Impact direction in tile space. Need not be normalized. */
  readonly dirX: number;
  readonly dirY: number;
  /** 0 radial, 1 strongly thrown along the direction. */
  readonly throwStrength: number;
  /** 0 watery -- long thin drips; 1 thick -- round, few. */
  readonly viscosity: number;
  /** Coverage cut. The edge is hard whatever this is; this decides where. */
  readonly threshold: number;
}

export const SPLAT_DEFAULTS: SplatParams = {
  size: 32,
  mass: 0.42,
  droplets: 7,
  spread: 0.72,
  dirX: 1,
  dirY: 0,
  throwStrength: 0.6,
  viscosity: 0.45,
  threshold: 0.5,
};

/**
 * What each fluid *is*, as the handful of parameters that actually differ.
 *
 * Colour is deliberately absent: the mask carries coverage and the effect's
 * gradient carries the tint, which is what makes "the same system for sap and
 * ichor and oil" a fact rather than an intention.
 */
export const FLUIDS: Record<FluidKind, Pick<SplatParams, 'viscosity' | 'droplets' | 'spread'>> = {
  blood: { viscosity: 0.45, droplets: 7, spread: 0.72 },
  // Thick and sticky: it stays where it lands.
  sap: { viscosity: 0.85, droplets: 3, spread: 0.36 },
  // Thin and far-flung, and it is meant to look wrong.
  ichor: { viscosity: 0.2, droplets: 11, spread: 0.95 },
  oil: { viscosity: 0.7, droplets: 4, spread: 0.5 },
  slime: { viscosity: 0.9, droplets: 5, spread: 0.42 },
};

/** The blot's radius at an angle, interpolated between its 16 authored samples. */
function profileRadius(blot: BlotProfile, angle: number): number {
  const count = blot.radii.length;
  const t = ((angle / (Math.PI * 2)) % 1 + 1) % 1;
  const scaled = t * count;
  const i = Math.floor(scaled);
  const frac = scaled - i;
  const a = blot.radii[i % count] ?? 1;
  const b = blot.radii[(i + 1) % count] ?? 1;
  return a + (b - a) * frac;
}

/**
 * A per-stamp ragged edge: three harmonics with random amplitudes and phases,
 * evaluated against the angle.
 *
 * The authored profiles carry the *shape language*, but they are 16 samples
 * smoothly interpolated, and at a 6-pixel radius that is a slightly squashed
 * circle -- which is exactly what the first contact sheet showed: thirty
 * jellybeans. The harmonics put irregularity back at the scale the pixels can
 * actually hold, and being harmonics rather than per-pixel noise they stay
 * continuous, so the outline is ragged rather than fizzy.
 */
interface EdgeJitter {
  readonly a2: number;
  readonly p2: number;
  readonly a3: number;
  readonly p3: number;
  readonly a5: number;
  readonly p5: number;
}

function drawJitter(rng: VfxRng, amount: number): EdgeJitter {
  return {
    a2: rng.range(0.4, 1) * amount,
    p2: rng.float() * Math.PI * 2,
    a3: rng.range(0.3, 0.9) * amount,
    p3: rng.float() * Math.PI * 2,
    a5: rng.range(0.2, 0.7) * amount,
    p5: rng.float() * Math.PI * 2,
  };
}

function jitterAt(jitter: EdgeJitter, angle: number): number {
  return (
    1 +
    jitter.a2 * Math.sin(angle * 2 + jitter.p2) +
    jitter.a3 * Math.sin(angle * 3 + jitter.p3) +
    jitter.a5 * Math.sin(angle * 5 + jitter.p5)
  );
}

/** Stamp a blot into the coverage field, centred at `(cx, cy)` in pixels. */
function stampBlot(
  coverage: Float32Array,
  size: number,
  blot: BlotProfile,
  cx: number,
  cy: number,
  radius: number,
  rotation: number,
  mirror: boolean,
  /**
   * How much further the blot reaches *forwards* along the throw than across it,
   * and how much backwards. Asymmetric on purpose: real spatter is a comet, fat
   * at the point of impact and drawn out in the direction of travel.
   *
   * Symmetric stretch was the first version, and it is why the mass never moved:
   * elongating equally both ways leaves the centre of mass exactly where it was,
   * so a splat "thrown right" was measurably indistinguishable from one thrown
   * left. It looked plausible in isolation and was wrong.
   */
  stretchForward: number,
  stretchBack: number,
  dirX: number,
  dirY: number,
  jitter: EdgeJitter,
): void {
  if (radius <= 0.5) return;
  // Only the pixels the blot can possibly touch. 1.6 covers the jitter's crest.
  const reach = radius * 1.6 * Math.max(1, stretchForward, stretchBack) + 2;
  const minX = Math.max(0, Math.floor(cx - reach));
  const maxX = Math.min(size - 1, Math.ceil(cx + reach));
  const minY = Math.max(0, Math.floor(cy - reach));
  const maxY = Math.min(size - 1, Math.ceil(cy + reach));

  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let dx = x + 0.5 - cx;
      let dy = y + 0.5 - cy;

      // Undo the throw stretch first, in the *direction's* frame: the blot is
      // authored round and the elongation is a property of the impact, not of
      // the drawing.
      if (stretchForward !== 1 || stretchBack !== 1) {
        const along = dx * dirX + dy * dirY;
        const across = -dx * dirY + dy * dirX;
        const shrunk = along / (along >= 0 ? stretchForward : stretchBack);
        dx = shrunk * dirX - across * dirY;
        dy = shrunk * dirY + across * dirX;
      }

      // Then the blot's own rotation and mirroring.
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      const angle = Math.atan2(ry, mirror ? -rx : rx);
      const distance = Math.sqrt(rx * rx + ry * ry);
      const edge = profileRadius(blot, angle) * radius * jitterAt(jitter, angle);
      if (distance > edge) continue;

      // A soft ramp *inside* the field only, so overlapping droplets merge into
      // one mass instead of showing their seams. The threshold at the end is
      // what makes the edge hard.
      const at = y * size + x;
      const value = 1 - (distance / Math.max(1e-3, edge)) * 0.25;
      if (value > (coverage[at] ?? 0)) coverage[at] = value;
    }
  }
}

/** A short stroke, for a drip running away from the mass. */
function stampStroke(
  coverage: Float32Array,
  size: number,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  length: number,
  width: number,
): void {
  const steps = Math.max(2, Math.ceil(length));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Tapered: a drip is fat where it left the mass and thin where it stopped.
    const radius = Math.max(0.5, width * (1 - t * 0.8));
    const px = x0 + dx * length * t;
    const py = y0 + dy * length * t;
    const minX = Math.max(0, Math.floor(px - radius));
    const maxX = Math.min(size - 1, Math.ceil(px + radius));
    const minY = Math.max(0, Math.floor(py - radius));
    const maxY = Math.min(size - 1, Math.ceil(py + radius));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const ex = x + 0.5 - px;
        const ey = y + 0.5 - py;
        if (ex * ex + ey * ey > radius * radius) continue;
        const at = y * size + x;
        if (0.9 > (coverage[at] ?? 0)) coverage[at] = 0.9;
      }
    }
  }
}

/**
 * Generate one splat mask. Deterministic in `seed`.
 *
 * Returns `size * size` bytes, each exactly 0 or 255.
 */
export function generateSplat(seed: number, params: Partial<SplatParams> = {}): Uint8Array<ArrayBuffer> {
  const p = { ...SPLAT_DEFAULTS, ...params };
  const size = Math.max(4, Math.round(p.size));
  const rng = new VfxRng(seed);

  const length = Math.sqrt(p.dirX * p.dirX + p.dirY * p.dirY);
  const dirX = length > 1e-4 ? p.dirX / length : 1;
  const dirY = length > 1e-4 ? p.dirY / length : 0;

  const coverage = new Float32Array(size * size);
  const centre = size / 2;
  // The impact point IS the tile centre, and the splat grows forward from it.
  //
  // The first version sat the mass *back* along the direction to leave room for
  // the spray, which is a reasonable-sounding idea that quietly destroyed the
  // feature: the backoff was larger than everything the throw contributed, so
  // the measured centre of mass ended up behind the tile centre no matter which
  // way the blow came from. Keeping the impact at the centre also makes decal
  // placement trivial -- the quad's centre is where the blow landed, with no
  // per-splat offset for a caller to get wrong.
  const massX = centre;
  const massY = centre;

  // A smaller core than the first pass used, with more of the tile's ink spent
  // on the spray. The first contact sheet was one big rounded mass per tile with
  // a couple of specks beside it -- a jellybean, not a spatter. What reads as
  // blood is a broken main mass and satellites big enough to be shapes.
  const mainRadius = p.mass * size * 0.34;
  // Forward only. A watery fluid draws out further than a thick one.
  const stretchForward = 1 + p.throwStrength * (1.9 - p.viscosity * 0.8);
  const stretchBack = 1;
  const raggedness = 0.14 + (1 - p.viscosity) * 0.16;

  // The core: three or four overlapping blots rather than one with a lobe, all
  // offset by a real fraction of the radius. The union of several ragged
  // outlines is what gives the mass a torn edge instead of a rim.
  const cores = rng.int(3, 4);
  for (let i = 0; i < cores; i++) {
    const blot = BLOTS[rng.int(0, BLOTS.length - 1)];
    if (!blot) continue;
    const angle = rng.float() * Math.PI * 2;
    const offset = i === 0 ? 0 : mainRadius * rng.range(0.35, 0.95);
    stampBlot(
      coverage,
      size,
      blot,
      massX + Math.cos(angle) * offset,
      massY + Math.sin(angle) * offset,
      mainRadius * (i === 0 ? 1 : rng.range(0.45, 0.85)),
      rng.float() * Math.PI * 2,
      rng.float() < 0.5,
      stretchForward,
      stretchBack,
      dirX,
      dirY,
      drawJitter(rng, raggedness),
    );
  }

  // Satellite droplets: best-of-N candidates, keeping whichever lands furthest
  // from everything placed so far -- `poisson.ts`'s rule, biased along the throw
  // so the scatter is a spray and not a halo.
  const placedX: number[] = [];
  const placedY: number[] = [];
  // 0.42 rather than 0.5 so the furthest droplet plus its own radius still lands
  // inside the tile; a splat clipped by its own texture edge reads as a splat cut
  // off by something invisible.
  const reach = p.spread * size * 0.42;
  const count = Math.max(0, Math.round(p.droplets));
  for (let i = 0; i < count; i++) {
    let bestX = 0;
    let bestY = 0;
    let bestScore = -1;
    for (let candidate = 0; candidate < 6; candidate++) {
      // Along the throw, always forwards; across it, a narrowing cone.
      const along = rng.range(0.25, 1) * reach;
      const spreadAcross = reach * 0.55 * (1 - p.throwStrength * 0.5);
      const across = rng.signed(spreadAcross) * (0.35 + along / Math.max(1e-3, reach));
      const cx = massX + dirX * along - dirY * across;
      const cy = massY + dirY * along + dirX * across;
      let nearest = Number.POSITIVE_INFINITY;
      for (let j = 0; j < placedX.length; j++) {
        const dx = (placedX[j] ?? 0) - cx;
        const dy = (placedY[j] ?? 0) - cy;
        nearest = Math.min(nearest, dx * dx + dy * dy);
      }
      const score = placedX.length === 0 ? candidate : nearest;
      if (score > bestScore) {
        bestScore = score;
        bestX = cx;
        bestY = cy;
      }
    }
    placedX.push(bestX);
    placedY.push(bestY);

    // Big enough to be a shape. The first pass sized these at a tenth of the
    // core, which at a 32-pixel tile is one or two pixels -- present in the
    // mask, invisible on screen, and the reason the sheet had no spray in it.
    const travelled = Math.sqrt((bestX - massX) ** 2 + (bestY - massY) ** 2) / Math.max(1e-3, reach);
    const dropRadius = Math.max(0.9, mainRadius * rng.range(0.3, 0.62) * (1 - travelled * 0.4));
    const blot = BLOTS[rng.int(0, BLOTS.length - 1)];
    if (blot) {
      stampBlot(
        coverage,
        size,
        blot,
        bestX,
        bestY,
        dropRadius,
        rng.float() * Math.PI * 2,
        rng.float() < 0.5,
        // Droplets stretch too, and harder: an airborne drop that lands is a
        // dash, not a dot, and the dashes are most of what says "thrown".
        1 + p.throwStrength * 1.2,
        1,
        dirX,
        dirY,
        drawJitter(rng, raggedness * 1.2),
      );
    }

    // Watery fluids trail a stroke behind the droplet; thick ones do not.
    if (rng.float() > p.viscosity * 0.75) {
      const tail = dropRadius * rng.range(2.2, 5.5) * (1.3 - p.viscosity);
      stampStroke(coverage, size, bestX, bestY, -dirX, -dirY, tail, Math.max(0.8, dropRadius * 0.55));
    }
  }

  // Threshold. Hard edges, because a soft one is something the frame's quantizer
  // turns into a band -- so the decision is made here, where it is authored.
  const mask = new Uint8Array(size * size);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = (coverage[i] ?? 0) >= p.threshold ? 255 : 0;
  }
  return mask;
}

/** What fraction of a mask is covered. Diagnostics, and what the tests assert on. */
export function splatCoverage(mask: Uint8Array): number {
  let covered = 0;
  for (const value of mask) if (value > 0) covered += 1;
  return mask.length > 0 ? covered / mask.length : 0;
}

/** The mask's centre of mass, in pixels. Undefined-ish when nothing is covered. */
export function splatCentroid(mask: Uint8Array, size: number): { x: number; y: number } {
  let sumX = 0;
  let sumY = 0;
  let covered = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((mask[y * size + x] ?? 0) === 0) continue;
      sumX += x;
      sumY += y;
      covered += 1;
    }
  }
  if (covered === 0) return { x: size / 2, y: size / 2 };
  return { x: sumX / covered, y: sumY / covered };
}

/**
 * How different two splats are *as shapes*: symmetric difference over union.
 *
 * The measure that matters, and not the same as {@link splatDifference}. These
 * masks cover about 14% of their tile, so two completely unrelated splats differ
 * on only ~6% of the tile's pixels -- a raw pixel difference makes a healthily
 * varied generator look like a broken one, and would push anyone reading it
 * toward loosening the wrong threshold. Normalizing by the union asks the actual
 * question: of the ink either of them laid down, how much do they share?
 *
 * 0 is identical, 1 is no overlap at all.
 */
export function splatDissimilarity(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < length; i++) {
    const inA = (a[i] ?? 0) > 0;
    const inB = (b[i] ?? 0) > 0;
    if (inA || inB) union += 1;
    if (inA && inB) intersection += 1;
  }
  return union === 0 ? 0 : 1 - intersection / union;
}

/** Fraction of the whole tile where two masks disagree. Raw, for diagnostics. */
export function splatDifference(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let differing = 0;
  for (let i = 0; i < length; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) differing += 1;
  return differing / length;
}
