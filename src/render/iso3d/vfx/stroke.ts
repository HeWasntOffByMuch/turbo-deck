/**
 * A mark somebody made with a brush, as geometry (specs 158, 159).
 *
 * Pure -- numbers in, typed arrays out, no three.js -- like `meshes.ts` beside
 * it, and for the same reasons: nothing may be fetched, and a shape described by
 * a dozen numbers is a shape a test can hold to account.
 *
 * ## What a stroke is here
 *
 * One **gesture**, not one ribbon. A loaded brush flicked through the air does
 * not leave a single tapering band; it leaves a broad body, a thinner streak
 * running beside it where the outer bristles dragged, and a few marks thrown off
 * the end that are separate on the surface and obviously part of the same
 * movement. So one mesh carries all of it -- main ribbon, companions, flecks --
 * and one particle is one gesture. Scattering those pieces as separate particles
 * was the first version and it read as confetti, because nothing tied them
 * together.
 *
 * ## The two-part split, and why it survives
 *
 * `position` holds the **spine**, and `strokeUv` carries
 * `(along, signedHalfOffset, sideX, sideY)` so the outline can be rebuilt on the
 * GPU. That is what lets the vertex shader animate the *shape* -- extend the
 * gesture along its own path, retract it from the root as it dies, swell and
 * pinch its width -- instead of scaling one static mesh, which is the thing that
 * makes procedural VFX look cheap.
 *
 * ## Where the variety comes from
 *
 * A **bank**. `meshes.ts` argues that one lump is enough because nobody can tell
 * a hundred lumpy spheres apart, and that is true of a lump and false of a brush
 * mark, whose whole identity is its outline. So a handful of *independently
 * generated* gestures are merged into one geometry, each vertex tagged with
 * which one it belongs to, and an instance draws exactly one of them -- the rest
 * collapse outside the clip volume and cost a vertex each. One draw call, real
 * geometric variety, and no per-spawn allocation. On top of that the shader
 * perturbs the chosen mark per instance, so two instances of one bank entry
 * still differ.
 *
 * ## What the roughness may NOT be
 *
 * Not pixel noise, not a stipple, not an alpha pattern. Every irregularity here
 * is in the *silhouette*: an asymmetric taper, a bulge somewhere in the first
 * third, two edges drawn from different noise, a terminal point that ends on one
 * side before the other. A filled shape with a rough boundary reads as paint at
 * any resolution; a dotted one reads as a rendering fault.
 *
 * ## The frame
 *
 * Authored along **+Y** in local space, one unit long, origin at the butt. `z`
 * is a shallow arch across the width -- paint has body, and more usefully a
 * bowed card still shows a silhouette when it is turned edge-on, which is what
 * lets the smaller pieces be oriented in world space rather than pinned to the
 * camera.
 */

import type { MeshData } from './meshes.js';

/** A `MeshData` that also carries the per-vertex data the stroke shader reads. */
export interface StrokeMeshData extends MeshData {
  /** vec4 per vertex: `(along, signedHalfOffset, sideX, sideY)`. */
  readonly strokeUv: Float32Array;
  /** Which bank entry each vertex belongs to. One per vertex. */
  readonly variant: Float32Array;
  /** How many gestures the bank holds. 1 for a single stroke. */
  readonly variants: number;
  /** Spine nodes in the first gesture's main ribbon, for measurement. */
  readonly mainNodes: number;
}

export interface StrokeSpec {
  /** Everything below is a pure function of this. */
  readonly seed: number;
  /** Spans along the main ribbon. Nodes are `segments + 1`. */
  readonly segments: number;
  /** Peak half-width, as a fraction of the unit length. */
  readonly width: number;
  /**
   * `taper` is a flick: broad root, irregular bulge, tapering to a point.
   * `lens` is a dab or a cloud lobe: blunt at both ends.
   */
  readonly profile: 'taper' | 'lens';
  /** Lateral bend over the whole length, in local units. */
  readonly curve: number;
  /** Per-node lateral jitter: a bend with corners in it. */
  readonly kink: number;
  /** How much the two edges wander, as a fraction of the width. */
  readonly edgeNoise: number;
  /** How pronounced the irregular swelling in the first third is. */
  readonly bulge: number;
  /** Depth of the cross-section arch, as a fraction of the local width. */
  readonly bow: number;
  /** Thinner streaks running beside the main body. 0..2. */
  readonly companions: number;
  /** Detached marks thrown off the tip. 0..3. */
  readonly flecks: number;
  /** How unevenly the terminal point ends, 0..1. At 0 both edges stop together. */
  readonly splitTip: number;
}

export const STROKE_DEFAULTS: StrokeSpec = {
  seed: 1,
  segments: 9,
  width: 0.085,
  profile: 'taper',
  curve: 0.16,
  kink: 0.014,
  edgeNoise: 0.26,
  bulge: 0.3,
  bow: 0.4,
  companions: 1,
  flecks: 2,
  splitTip: 0.55,
};

/** Floats per vertex in `strokeUv`. */
export const STROKE_UV_STRIDE = 4;

/**
 * The width down a flick, as control values.
 *
 * Broad off the root, fattest early, then falling away with a shoulder in it
 * rather than a straight line -- a linear taper is a triangle, and a triangle is
 * the single most recognisable "this was generated" silhouette there is. Each
 * station is perturbed per stroke and *per edge* on the way out, so this is the
 * skeleton of a profile rather than the profile.
 */
const TAPER_PROFILE = [0.6, 1, 0.85, 0.55, 0.25, 0] as const;

/** The same for a dab or a cloud lobe: blunt, fat in the middle, blunt. */
const LENS_PROFILE = [0.45, 0.86, 1, 0.94, 0.7, 0.38] as const;

/** A deterministic hash in [0, 1). */
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
 * Smooth value noise along one axis.
 *
 * Cubic interpolation and a deliberately low frequency. An earlier version added
 * a high-frequency term quantized to five levels, on the theory that a staircase
 * survives a low-resolution frame better than a smooth wobble. It does, and what
 * it survives as is a staircase: the edge came out looking aliased on purpose,
 * which is the one thing this art direction cannot have. Roughness belongs at
 * the scale of the *shape*, where it reads as a brush, not at the scale of a
 * pixel, where it reads as a bug.
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
 * Interpolate a profile's control values at `t`, smoothly.
 *
 * Catmull-Rom rather than linear, so the width curve has no corners in it: a
 * corner in the width is a corner in the silhouette, and it lands at the same
 * place on every stroke that shares a profile.
 */
function alongProfile(profile: readonly number[], t: number): number {
  const last = profile.length - 1;
  const scaled = Math.min(last, Math.max(0, t)) * last;
  const i = Math.min(last - 1, Math.floor(scaled));
  const f = scaled - i;
  const p0 = profile[Math.max(0, i - 1)] ?? 0;
  const p1 = profile[i] ?? 0;
  const p2 = profile[Math.min(last, i + 1)] ?? 0;
  const p3 = profile[Math.min(last, i + 2)] ?? 0;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f)
  );
}

/**
 * The half-width of one edge at `t`.
 *
 * `edge` is 0 or 1 and picks a *different noise stream* and a different set of
 * station perturbations. That single fact is what separates a hand-made mark
 * from a machined one: mirrored edges read as a stamped part however much noise
 * is on them.
 */
function edgeWidth(t: number, spec: StrokeSpec, edge: number): number {
  const seed = spec.seed + edge * 0x51ed270b;
  const lens = spec.profile === 'lens';
  const base = alongProfile(lens ? LENS_PROFILE : TAPER_PROFILE, t);

  // Per-station perturbation: the profile above is a skeleton and this is what
  // makes each stroke's width curve its own. Low frequency by construction --
  // one wobble per two stations.
  const stations = valueNoise(t * 4.3 + 2.1, seed) * 0.62 + valueNoise(t * 9.7 + 17.3, seed ^ 0x2545f491) * 0.38;

  // One irregular swelling, somewhere in the first or middle third. A brush
  // loaded with paint puts down more of it where the bristles bed in, and the
  // bump is what stops the profile reading as a formula.
  const at = 0.16 + hash(41 + edge, spec.seed) * 0.3;
  const spread = 0.1 + hash(43 + edge, spec.seed) * 0.12;
  const swell = spec.bulge * Math.exp(-((t - at) ** 2) / (2 * spread * spread));

  // Where THIS edge runs out. A terminal point where both edges arrive together
  // is a symmetrical spearhead; one that ends on one side first is a brush
  // lifting off the surface at an angle.
  const end = lens ? 1.2 : 1 - hash(61 + edge * 7, spec.seed) * 0.14 * spec.splitTip;
  const cut = t >= end ? 0 : Math.min(1, (end - t) / 0.09);

  const width = spec.width * (base * (1 + stations * spec.edgeNoise) + swell) * cut;
  return Math.max(0, width);
}

/** The spine's lateral offset at `t`: a smooth bend plus per-node corners. */
function spineX(t: number, spec: StrokeSpec): number {
  // Quadratic rather than linear, so the mark leaves the butt straight and curls
  // away. A constant curvature is a segment of a circle, which is what a swept
  // quad already looks like.
  return spec.curve * t * t + spec.kink * valueNoise(t * 4.7 + 3.3, spec.seed ^ 0x27d4eb2f);
}

/** Growable output arrays. Plain arrays: this runs once, at module load. */
interface Sink {
  readonly positions: number[];
  readonly normals: number[];
  readonly uv: number[];
  readonly variant: number[];
  readonly indices: number[];
}

/**
 * One ribbon, appended to `sink`.
 *
 * `halfAt` gives the half-width of an edge at a parameter in [0, 1]; `pathAt`
 * gives the spine point and `alongAt` the gesture coordinate, which is not the
 * same thing -- a companion streak that starts a fifth of the way up the main
 * mark has its own parameter running 0..1 while its `along` runs 0.2..0.8, so
 * the whole gesture extends and erodes together.
 */
function ribbon(
  sink: Sink,
  variant: number,
  spans: number,
  bow: number,
  pathAt: (u: number) => readonly [number, number],
  halfAt: (u: number, edge: number) => number,
  alongAt: (u: number) => number,
): void {
  const first = sink.positions.length / 3;
  const step = 1 / spans;

  for (let n = 0; n <= spans; n++) {
    const u = n / spans;
    const [x, y] = pathAt(u);
    // The side direction is the tangent turned a quarter turn, from a central
    // difference -- a forward difference builds the last node's normal out of a
    // span it is the end of, which visibly shears the tip.
    const [bx, by] = pathAt(Math.max(0, u - step * 0.5));
    const [ax, ay] = pathAt(Math.min(1, u + step * 0.5));
    const dx = ax - bx;
    const dy = ay - by;
    const length = Math.hypot(dx, dy) || 1;
    const sideX = dy / length;
    const sideY = -dx / length;
    const along = alongAt(u);

    // Three vertices per node -- left edge, crest, right edge -- because the
    // arch needs a middle to be an arch. A two-vertex ribbon is a plane, and a
    // plane turned edge-on to the camera is nothing at all; the crest is what
    // lets the smaller pieces be oriented in world space instead of pinned to
    // the view, which is where this vocabulary's sense of depth comes from.
    const left = halfAt(u, 0);
    const right = halfAt(u, 1);
    const crest = bow * (left + right) * 0.5;
    for (const [half, z, slope] of [
      [-left, 0, 2 * bow] as const,
      [0, crest, 0] as const,
      [right, 0, -2 * bow] as const,
    ]) {
      sink.positions.push(x, y, z);
      // Analytic normal of the arch: across the width it is z = crest * (1 - s^2)
      // for s in [-1, 1], whose slope at the edges is -+2 * bow.
      const nLength = Math.hypot(slope, 1);
      sink.normals.push((sideX * slope) / nLength, (sideY * slope) / nLength, 1 / nLength);
      sink.uv.push(along, half, sideX, sideY);
      sink.variant.push(variant);
    }
  }

  for (let s = 0; s < spans; s++) {
    const a = first + s * 3;
    const b = a + 3;
    // Wound so the face normals run +Z. The material is DoubleSide regardless --
    // a mark seen from behind must still draw -- but a consistent winding is
    // what lets anything downstream reason about the shape at all.
    sink.indices.push(a, a + 1, b + 1, a, b + 1, b, a + 1, a + 2, b + 2, a + 1, b + 2, b + 1);
  }
}

/**
 * One whole gesture: the body, the streaks beside it, and the marks thrown off
 * the end.
 */
function gesture(sink: Sink, variant: number, spec: StrokeSpec): number {
  const spans = Math.max(3, Math.round(spec.segments));
  const path = (u: number): readonly [number, number] => [spineX(u, spec), u];

  ribbon(
    sink,
    variant,
    spans,
    spec.bow,
    path,
    (u, edge) => edgeWidth(u, spec, edge),
    (u) => u,
  );

  // (b) The companions: thinner streaks running beside the body, over part of
  // its length. The outer bristles of a loaded brush leave these, and without
  // them a stroke is one clean band -- correct, and lifeless.
  for (let c = 0; c < Math.max(0, Math.min(2, Math.round(spec.companions))); c++) {
    const side = hash(200 + c, spec.seed) < 0.5 ? -1 : 1;
    const from = 0.06 + hash(210 + c, spec.seed) * 0.24;
    const to = Math.min(0.97, from + 0.34 + hash(220 + c, spec.seed) * 0.4);
    const gap = 1.15 + hash(230 + c, spec.seed) * 0.85;
    const thin = 0.22 + hash(240 + c, spec.seed) * 0.2;
    const at = (u: number): number => from + (to - from) * u;
    ribbon(
      sink,
      variant,
      Math.max(3, spans - 3),
      spec.bow * 0.8,
      (u) => {
        const t = at(u);
        // Held off the body by a gap proportional to how wide the body is
        // *there*, so a companion hugs the mark rather than crossing it.
        const offset = (edgeWidth(t, spec, side < 0 ? 0 : 1) + spec.width * 0.06) * gap * side;
        return [spineX(t, spec) + offset, t];
      },
      (u, edge) => edgeWidth(at(u), spec, edge) * thin * Math.sin(Math.PI * Math.min(1, Math.max(0, u))) ** 0.55,
      at,
    );
  }

  // (c) The flecks: small marks that have left the brush, just past the tip and
  // a little to the side. They keep the gesture's `along`, so they are the last
  // thing left when the mark retracts -- which is exactly how a flick reads.
  for (let f = 0; f < Math.max(0, Math.min(3, Math.round(spec.flecks))); f++) {
    const ahead = 1.02 + hash(300 + f, spec.seed) * 0.26;
    const drift = signed(310 + f, spec.seed) * spec.width * 2.6;
    const size = spec.width * (0.4 + hash(320 + f, spec.seed) * 0.55);
    const long = size * (1.4 + hash(330 + f, spec.seed) * 1.8);
    const lean = signed(340 + f, spec.seed) * 0.4;
    ribbon(
      sink,
      variant,
      4,
      spec.bow,
      (u) => [spineX(ahead, spec) + drift + lean * long * u, ahead + long * u],
      (u, edge) => size * alongProfile(LENS_PROFILE, u) * (0.8 + hash(350 + f * 3 + edge, spec.seed) * 0.4),
      () => Math.min(1, ahead),
    );
  }

  return spans + 1;
}

/** Build one gesture on its own. */
export function brushStrokeMesh(input: Partial<StrokeSpec> = {}): StrokeMeshData {
  return brushStrokeBank([input]);
}

/**
 * Merge several independently generated gestures into one geometry.
 *
 * This is the answer to "do not copy one mesh and merely rotate it": every entry
 * is built from its own seed and has its own path, width curve, bulge, tip and
 * flecks. An instance draws one of them and clips the rest, which costs a vertex
 * per unused vertex and no draw call at all.
 */
export function brushStrokeBank(entries: readonly Partial<StrokeSpec>[]): StrokeMeshData {
  const sink: Sink = { positions: [], normals: [], uv: [], variant: [], indices: [] };
  let mainNodes = 0;
  entries.forEach((entry, index) => {
    const spec: StrokeSpec = { ...STROKE_DEFAULTS, ...entry };
    const nodes = gesture(sink, index, spec);
    if (index === 0) mainNodes = nodes;
  });

  return {
    positions: new Float32Array(sink.positions),
    normals: new Float32Array(sink.normals),
    indices: new Uint16Array(sink.indices),
    strokeUv: new Float32Array(sink.uv),
    variant: new Float32Array(sink.variant),
    variants: Math.max(1, entries.length),
    mainNodes,
  };
}

/**
 * A bank of `count` gestures of one kind, varied around a base spec.
 *
 * The variation is deliberately bounded: different paintings by the same artist,
 * not different artists. Length, curvature, width, where the bulge sits, how the
 * tip breaks and how many pieces come off it all move; the profile family and
 * the proportions do not.
 */
export function variedBank(base: Partial<StrokeSpec>, count: number, seed: number): StrokeMeshData {
  const entries: Partial<StrokeSpec>[] = [];
  const spec: StrokeSpec = { ...STROKE_DEFAULTS, ...base };
  for (let i = 0; i < Math.max(1, count); i++) {
    const own = seed + i * 7919;
    entries.push({
      ...base,
      seed: own,
      width: spec.width * (0.78 + hash(1, own) * 0.5),
      curve: spec.curve * (hash(2, own) < 0.5 ? -1 : 1) * (0.45 + hash(3, own) * 1.15),
      kink: spec.kink * (0.5 + hash(4, own) * 1.2),
      edgeNoise: spec.edgeNoise * (0.7 + hash(5, own) * 0.7),
      bulge: spec.bulge * (0.5 + hash(6, own) * 1.1),
      splitTip: spec.splitTip * (0.4 + hash(7, own) * 1.2),
      companions: spec.companions > 0 ? (hash(8, own) < 0.35 ? 0 : spec.companions) : 0,
      flecks: spec.flecks > 0 ? Math.round(hash(9, own) * spec.flecks + 0.2) : 0,
      segments: Math.round(spec.segments * (0.85 + hash(10, own) * 0.4)),
    });
  }
  return brushStrokeBank(entries);
}

// --- measurement, for the tests ---------------------------------------------

/**
 * The silhouette the GPU will draw, as flat `x, y` pairs.
 *
 * `position` alone is the spine, so a test that measured it would be measuring a
 * line. This is the one place the recombination is written in TypeScript, and it
 * is the same expression the shader computes before it adds its own per-instance
 * layer -- which is what lets "a stroke is not a triangle" be an assertion in
 * Node rather than a screenshot somebody looks at.
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

/** Vertices per spine node: left edge, crest, right edge. */
export const NODE_VERTICES = 3;

/** Total width across the first gesture's main ribbon at spine node `n`. */
export function strokeWidthAt(mesh: StrokeMeshData, node: number): number {
  const left = mesh.strokeUv[node * NODE_VERTICES * STROKE_UV_STRIDE + 1] ?? 0;
  const right = mesh.strokeUv[(node * NODE_VERTICES + 2) * STROKE_UV_STRIDE + 1] ?? 0;
  return Math.abs(right - left);
}

/** One edge's half-width at node `n`: 0 is the left edge, 1 the right. */
export function strokeHalfAt(mesh: StrokeMeshData, node: number, edge: number): number {
  return Math.abs(mesh.strokeUv[(node * NODE_VERTICES + edge * 2) * STROKE_UV_STRIDE + 1] ?? 0);
}

/** Spine nodes in the first gesture's main ribbon. */
export function strokeNodes(mesh: StrokeMeshData): number {
  return mesh.mainNodes;
}
