/**
 * A mark somebody made with a brush, as geometry (spec 158).
 *
 * Pure -- numbers in, typed arrays out, no three.js -- like `meshes.ts` beside
 * it, and for the same reasons: nothing may be fetched, and a shape described by
 * a dozen numbers is a shape a test can hold to account.
 *
 * ## Why this is not another entry in `meshes.ts`
 *
 * Every solid in that file is a lump, and the note at the top of it is the
 * reason there is only ever one of each: "a hundred distinct lumpy spheres would
 * be a hundred draw calls, and at this resolution nobody can tell them from one
 * sphere seen from a hundred angles." That is true of a blob and false of a
 * brush stroke. A stroke's whole identity is its *outline* -- where it is fat,
 * where it thins, which way it bends, where the bristles ran dry -- so a fan of
 * eight identical ones is the failure, not the saving.
 *
 * The way out is to split the shape in two. A stroke is a **spine** with a
 * **width sampled along it**; this file bakes one of each into the vertex
 * buffer, and the vertex shader recombines them with a second, per-instance
 * layer of variation hashed out of `iSeed` (`batches.ts`). One geometry, one
 * draw call, and no two instances with the same silhouette.
 *
 * So `position` here holds the **spine point**, not the finished vertex, and
 * `strokeUv` carries what the shader needs to put the edge back:
 *
 * ```
 * strokeUv = vec4(along, signedHalfOffset, sideX, sideY)
 * vertex   = position.xy + side * signedHalfOffset   // what a CPU would draw
 * ```
 *
 * {@link strokeOutline} is that last line, and exists so a headless test can
 * measure the silhouette the GPU will actually produce.
 *
 * ## The frame
 *
 * Authored along **+Y** in the local XY plane, one unit long, origin at the butt
 * of the stroke. +Y because that is the convention `shard` set and what
 * `ORIENT.velocity` and `ORIENT.cardVelocity` both mean by "point the way you
 * went"; origin at the butt because a mark thrown out of an explosion starts at
 * the centre and reaches outward, and a centred one would put half of every
 * stroke inside the fireball.
 *
 * ## What makes it read as paint rather than as a tapered quad
 *
 * Six things, each of which was added because the version without it looked
 * mechanical:
 *
 *  - the two edges get **independent** noise, so the silhouette is asymmetric --
 *    mirror-imaged edges read as a machined part however wavy they are;
 *  - the spine gets a smooth bend *and* a per-node kink, so the curvature is
 *    segmented rather than a perfect arc;
 *  - the width has a **shoulder**: a brush loaded with paint is thin where it
 *    touched down, fattest just after, and tapering from there;
 *  - a quantized high-frequency term, so the edge has steps in it rather than a
 *    smooth wobble -- at this resolution a smooth wobble is a straight line;
 *  - the tip **frays**: past a per-stroke break point the width collapses
 *    unevenly rather than converging on a point;
 *  - optional **skips**, the dry-brush gaps that split one mark into two.
 */

import type { MeshData } from './meshes.js';

/** A `MeshData` that also carries the per-vertex data the stroke shader reads. */
export interface StrokeMeshData extends MeshData {
  /** vec4 per vertex: `(along, signedHalfOffset, sideX, sideY)`. */
  readonly strokeUv: Float32Array;
}

export interface StrokeSpec {
  /** Everything below is a pure function of this. */
  readonly seed: number;
  /** Spans along the spine. Vertices are `(segments + 1) * 2`. */
  readonly segments: number;
  /** Peak half-width, as a fraction of the unit length. */
  readonly width: number;
  /**
   * `taper` is a flick: fat near the butt, thin at the tip. `lens` is a dab or a
   * blot: fat in the middle and blunt at both ends.
   */
  readonly profile: 'taper' | 'lens';
  /** Where along the stroke the peak sits, 0..1. Ignored by `lens`. */
  readonly shoulder: number;
  /** How hard `taper` runs out. Above 1 is a long thin point. */
  readonly tipPower: number;
  /** Lateral bend over the whole length, in local units. */
  readonly curve: number;
  /** Per-node lateral jitter, in local units: a bend with corners in it. */
  readonly kink: number;
  /** Low-frequency width wobble, per edge, as a fraction of the width. */
  readonly edgeNoise: number;
  /** High-frequency quantized width steps, as a fraction of the width. */
  readonly jagged: number;
  /** Dry-brush gaps that pinch the mark nearly shut. 0 disables. */
  readonly skips: number;
  /** How abruptly the butt starts, 0..1. 0 is a squared-off end. */
  readonly rootCut: number;
}

export const STROKE_DEFAULTS: StrokeSpec = {
  seed: 1,
  segments: 10,
  width: 0.16,
  profile: 'taper',
  shoulder: 0.16,
  tipPower: 1.5,
  curve: 0.12,
  kink: 0.012,
  edgeNoise: 0.32,
  jagged: 0.12,
  skips: 0,
  rootCut: 0.5,
};

/** Floats per vertex in `strokeUv`. */
export const STROKE_UV_STRIDE = 4;

/**
 * A deterministic hash in [0, 1).
 *
 * The same construction `meshes.ts` uses, kept local rather than exported from
 * there: two files sharing a private hash is a coupling that buys nothing, and a
 * change to one for its own reasons would silently reshape every stroke.
 */
function hash(index: number, seed: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x27d4eb2d)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) & 0xffff) / 0xffff;
}

/** The same, signed into [-1, 1). */
function signed(index: number, seed: number): number {
  return hash(index, seed) * 2 - 1;
}

/**
 * Smooth value noise along one axis, from the integer hash.
 *
 * Cubic (smoothstep) interpolation rather than linear: a linear ramp between
 * lattice points puts a visible corner at every integer, and those corners land
 * at the same place on every stroke that shares a frequency -- which reads as a
 * repeated pattern, the exact thing the noise is here to avoid.
 */
function valueNoise(t: number, seed: number): number {
  const cell = Math.floor(t);
  const frac = t - cell;
  const a = signed(cell, seed);
  const b = signed(cell + 1, seed);
  const smooth = frac * frac * (3 - 2 * frac);
  return a + (b - a) * smooth;
}

/**
 * The baked half-width of one edge at `t`, before the shader's own per-instance
 * gain.
 *
 * `edge` is 0 or 1 and picks a *different noise stream*, which is the single
 * most important line in this file: mirrored edges are what make a hand-drawn
 * shape look machined, however much noise is on them.
 */
function edgeWidth(t: number, spec: StrokeSpec, edge: number): number {
  const seed = spec.seed + edge * 0x51ed270b;

  // The base profile. `taper` rises off the butt over `shoulder` and then runs
  // out; `lens` is a blunt-ended sausage. Both peak at 1.
  let base: number;
  if (spec.profile === 'lens') {
    // A raised half-sine, floored well above zero so a dab has ends rather than
    // points -- a lens that closes to nothing is a leaf, and a leaf reads as a
    // petal rather than as a lump of paint.
    base = 0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
  } else {
    const rise = spec.shoulder > 0 ? Math.min(1, t / spec.shoulder) : 1;
    // Eased on the way up so the butt is a shoulder and not a step.
    const shoulder = rise * rise * (3 - 2 * rise);
    const run = Math.pow(Math.max(0, 1 - t), spec.tipPower);
    base = (1 - spec.rootCut + spec.rootCut * shoulder) * run;
    // `run` peaks at t = 0, so a pure taper is fattest at the very butt. The
    // shoulder is what moves the fat part off the end; normalise by the value at
    // the peak so `width` still means the peak.
    const peak = Math.pow(Math.max(0, 1 - spec.shoulder), spec.tipPower);
    if (peak > 1e-3) base /= peak;
  }

  // Two octaves of low-frequency wobble. Frequencies deliberately not in a 2:1
  // ratio -- harmonics line up and produce a repeating scallop.
  const wobble =
    valueNoise(t * 3.1 + 1.7, seed) * 0.68 + valueNoise(t * 7.3 + 11.1, seed ^ 0x2545f491) * 0.32;

  // The ragged edge: high frequency, and *quantized* to five levels. A smooth
  // high-frequency wobble on a mark forty pixels long is a straight line; a
  // staircase is what survives the quantizer and reads as bristles.
  const steps = 5;
  const raw = valueNoise(t * 19.7 + 5.3, seed ^ 0x9e3779b9);
  const jagged = Math.round(raw * steps) / steps;

  let width = spec.width * base * (1 + wobble * spec.edgeNoise + jagged * spec.jagged);

  // The frayed tip. Past the break point the width is driven down by a curve
  // that is itself noisy, so the end comes apart rather than converging.
  //
  // A `taper` only. A dab and a blot are blobs of paint with torn edges all
  // round, and running the collapse on one gave it a *pointed far end* -- which
  // made every droplet a little comet and quietly reintroduced a direction to
  // the one shape in the vocabulary that is supposed to have none. The lens
  // profile's own floor is what keeps its ends blunt, and the jagged term is
  // what tears them.
  if (spec.profile === 'taper') {
    const breakAt = 0.72 + hash(97 + edge, spec.seed) * 0.2;
    if (t > breakAt) {
      const into = (t - breakAt) / Math.max(1e-3, 1 - breakAt);
      const ragged = 0.5 + 0.5 * valueNoise(t * 13.9, seed ^ 0x85ebca6b);
      width *= Math.max(0, 1 - into * (0.65 + 0.6 * ragged));
    }
  }

  // Dry-brush skips: narrow bands where the bristles lifted. Multiplicative and
  // applied to both edges from *one* stream, because a skip is a gap in the mark
  // rather than a notch in one of its sides.
  for (let s = 0; s < spec.skips; s++) {
    const at = 0.18 + hash(200 + s, spec.seed) * 0.62;
    const half = 0.018 + hash(300 + s, spec.seed) * 0.045;
    const d = Math.abs(t - at) / half;
    if (d < 1) {
      // A cosine notch, so the mark necks down and opens back up rather than
      // being chopped: a hard cut looks like two strokes, a neck looks like one
      // stroke that ran dry.
      width *= 0.06 + 0.94 * (0.5 - 0.5 * Math.cos(Math.PI * d));
    }
  }

  return Math.max(0, width);
}

/** The spine's lateral offset at `t`: a smooth bend plus per-node corners. */
function spineX(t: number, spec: StrokeSpec): number {
  // Quadratic rather than linear so the stroke leaves the butt straight and
  // curls away -- a constant-curvature arc reads as a segment of a circle,
  // which is what a swept quad already looks like.
  const bend = spec.curve * t * t;
  const kink = spec.kink * valueNoise(t * 4.7 + 3.3, spec.seed ^ 0x27d4eb2f);
  return bend + kink;
}

/**
 * Build one stroke.
 *
 * `(segments + 1)` spine nodes, two vertices each, and `segments * 2` triangles.
 * Everything is bounded by `segments` and nothing is grown, so a caller can size
 * a buffer from the spec alone.
 */
export function brushStrokeMesh(input: Partial<StrokeSpec> = {}): StrokeMeshData {
  const spec: StrokeSpec = { ...STROKE_DEFAULTS, ...input };
  const spans = Math.max(2, Math.round(spec.segments));
  const nodes = spans + 1;

  const positions = new Float32Array(nodes * 2 * 3);
  const normals = new Float32Array(nodes * 2 * 3);
  const strokeUv = new Float32Array(nodes * 2 * STROKE_UV_STRIDE);
  const indices = new Uint16Array(spans * 6);

  for (let n = 0; n < nodes; n++) {
    const t = n / spans;
    const x = spineX(t, spec);
    const y = t;

    // The side direction: the spine tangent turned a quarter turn. Taken from a
    // central difference so a node's normal answers to the curve on both sides
    // of it -- a forward difference leaves the last node's normal built from a
    // span it is the end of, which visibly shears the tip.
    const back = spineX(Math.max(0, t - 0.5 / spans), spec);
    const ahead = spineX(Math.min(1, t + 0.5 / spans), spec);
    const dx = ahead - back;
    const dy = Math.min(1, t + 0.5 / spans) - Math.max(0, t - 0.5 / spans);
    const length = Math.hypot(dx, dy) || 1;
    // perp of (dx, dy) is (dy, -dx), normalised.
    const sideX = dy / length;
    const sideY = -dx / length;

    for (let edge = 0; edge < 2; edge++) {
      const sign = edge === 0 ? -1 : 1;
      const half = edgeWidth(t, spec, edge) * sign;
      const v = n * 2 + edge;
      positions[v * 3] = x;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = 0;
      // A card is flat and unlit (`shadedShape` is false for every brush shape),
      // so this is here to satisfy the attribute rather than to be shaded by.
      normals[v * 3 + 2] = 1;
      const u = v * STROKE_UV_STRIDE;
      strokeUv[u] = t;
      strokeUv[u + 1] = half;
      strokeUv[u + 2] = sideX;
      strokeUv[u + 3] = sideY;
    }
  }

  for (let s = 0; s < spans; s++) {
    const a = s * 2;
    const at = s * 6;
    // Wound so the face normal is +Z. The material is `DoubleSide` regardless --
    // a card seen from behind must still draw -- but a consistent winding is
    // what lets anything downstream reason about the shape at all.
    indices[at] = a;
    indices[at + 1] = a + 1;
    indices[at + 2] = a + 3;
    indices[at + 3] = a;
    indices[at + 4] = a + 3;
    indices[at + 5] = a + 2;
  }

  return { positions, normals, indices, strokeUv };
}

/**
 * The silhouette the GPU will draw, as flat `x, y` pairs.
 *
 * `position` alone is the spine, so a test that measured it would be measuring a
 * line. This is the one place the recombination is written in TypeScript, and it
 * is the same expression the shader's un-deformed path computes -- which is what
 * lets "a stroke is not a rectangle" be an assertion in Node rather than a
 * screenshot somebody looks at.
 */
export function strokeOutline(mesh: StrokeMeshData, out?: Float32Array): Float32Array {
  const count = mesh.positions.length / 3;
  const result = out ?? new Float32Array(count * 2);
  for (let v = 0; v < count; v++) {
    const u = v * STROKE_UV_STRIDE;
    const half = mesh.strokeUv[u + 1] ?? 0;
    result[v * 2] = (mesh.positions[v * 3] ?? 0) + (mesh.strokeUv[u + 2] ?? 0) * half;
    result[v * 2 + 1] = (mesh.positions[v * 3 + 1] ?? 0) + (mesh.strokeUv[u + 3] ?? 0) * half;
  }
  return result;
}

/** Total width across the stroke at spine node `n`. */
export function strokeWidthAt(mesh: StrokeMeshData, node: number): number {
  const left = mesh.strokeUv[(node * 2) * STROKE_UV_STRIDE + 1] ?? 0;
  const right = mesh.strokeUv[(node * 2 + 1) * STROKE_UV_STRIDE + 1] ?? 0;
  return Math.abs(right - left);
}

/** Spine nodes in a built stroke. */
export function strokeNodes(mesh: StrokeMeshData): number {
  return mesh.positions.length / 6;
}
