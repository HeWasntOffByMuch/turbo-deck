/**
 * A shape laid on the ground rather than over it (spec 153).
 * Pure -- no three.js, no DOM, and the heightfield is an argument.
 *
 * Every ground indicator this renderer draws used to be one flat horizontal
 * mesh placed at `ground(somewhere) + lift`. That is exactly right at the one
 * point it was sampled at and wrong everywhere else the moment the ground is
 * not level: the far half of a range ring sits inside the hillside and the near
 * half hangs over the valley. Raising the lift does not fix it and never could
 * -- a horizontal plane cannot follow a heightfield, only vertices can.
 *
 * So a decal here is two things that are deliberately separate. A **template**
 * is the shape in its own frame, built once per shape and reused: local XZ
 * offsets and the triangles over them, with +X the heading and +Z to its left.
 * A **projection** places that template at a point and a heading and asks the
 * ground where each vertex goes. The template is what costs an allocation, the
 * projection is what happens every frame, and keeping them apart is what lets a
 * cursor move at 60Hz without allocating a `CircleGeometry` per frame for as
 * long as somebody is deciding.
 *
 * The tessellation is derived from the size rather than authored, against one
 * number: {@link SAMPLE_STEP}, half a terrain cell. What is left uncorrected is
 * then whatever the ground does *between* two samples that close together,
 * rather than whatever it does across the whole indicator -- which for a
 * 700-unit range ring was thirty cells of it.
 */

import type { AimShape } from './aim.js';

/**
 * How far apart neighbouring samples are, at the widest.
 *
 * Half a terrain cell (`DEFAULT_CHUNK_OPTIONS.cellSize` is 22), so a sample
 * lands inside every cell an indicator crosses rather than skipping over one.
 * Not imported from `src/terrain/`: this is a statement about how finely the
 * picture is worth sampling, and it would still be about the right number if
 * the world were remeshed at a different resolution tomorrow.
 */
export const SAMPLE_STEP = 11;

/**
 * Caps on the tessellation, so an ability with a large range costs a bounded
 * number of height lookups rather than a proportional one.
 *
 * At the cap a 700-unit ring samples every 17 units instead of every 11, which
 * is the tessellation degrading gracefully -- the alternative is a per-frame
 * cost nobody bounded that only shows up on the map with the longest sightline.
 */
export const MAX_SEGMENTS = 256;
export const MAX_RINGS = 24;

/**
 * The coarsest a *curved* edge may be, as an angle: 15 degrees, which is 24
 * segments around a full circle (spec 164).
 *
 * {@link SAMPLE_STEP} bounds how far apart two samples may be, which is the
 * right question for following the ground and no question at all about whether
 * the shape still looks like the shape. Every indicator spec 153 converted was
 * large enough that the two never disagreed -- a 420-unit range ring gets 240
 * segments out of the ground rule alone. A ring drawn under a *body* is thirty
 * units across and gets eighteen, against the twenty-four the flat
 * `RingGeometry` it replaces was authored with, so conforming to the ground
 * would have quietly cost the picture some roundness.
 *
 * An angle rather than a minimum count, because a count is wrong for a sector:
 * a 90-degree cone floored at 24 segments would pay four times over for
 * curvature it does not have, and the same angular limit gives it six. Below
 * about 44 units of radius this is the binding bound and above it the ground
 * is, so nothing spec 153 measured is tessellated differently.
 */
export const MAX_SEGMENT_ANGLE = Math.PI / 12;

/** A flat shape in its own frame: +X is the heading, +Z is to its left. */
export interface DecalTemplate {
  /** Local XZ pairs, x0,z0,x1,z1,... */
  readonly local: Float32Array;
  /** Triangles over those vertices. */
  readonly index: Uint16Array;
  /** The widest gap between neighbouring samples, in world units. */
  readonly step: number;
}

/** Where a template is laid, and how far above the ground it floats. */
export interface DecalPlacement {
  readonly x: number;
  readonly z: number;
  /** Radians, measured the way the view measures one: `atan2(dz, dx)`. */
  readonly heading: number;
  readonly lift: number;
}

/** The ground, injected -- this module never learns what a heightfield is. */
export type HeightAt = (x: number, z: number) => number;

/**
 * How far a decal is pushed up per unit of ground movement under it.
 *
 * The lift a caller asks for is what a decal needs on level ground, where it is
 * the whole clearance; on a hillside the clearance that matters is against what
 * the ground does *between* two samples, and that is a slope, not a constant.
 * So the lift is measured rather than fixed: the five samples a vertex already
 * takes give the local spread for free, and a fraction of it is added on top.
 * Zero on the flat, so an indicator drawn on level ground is exactly where the
 * old one was.
 */
export const SLOPE_LIFT = 0.3;

/**
 * The ground, memoized on a lattice and read back bilinearly.
 *
 * This exists because of one measurement: `TerrainWorld.heightAt` costs about
 * 5.6us a call on the baked arena -- it jitters four corners, evaluates two
 * triangle planes, and searches the ring of neighbouring cells when the point
 * lands outside its nominal one. That is a fine price for the handful of
 * queries a frame this renderer used to make, and a fatal one for a decal:
 * projecting a single 140-unit disc costs about 1100 vertices, and asking the
 * heightfield directly took 35 milliseconds a frame.
 *
 * A lattice is the right shape for the fix because the thing underneath is a
 * heightfield with 22-unit cells, so sampling at half of that and interpolating
 * loses very little, and because a cursor moving two or three units a frame
 * lands in the same lattice cells it did last frame -- the memo is warm the
 * instant the aim starts moving, and the cost settles at a few dozen fresh
 * samples a frame instead of thousands.
 *
 * Pure: the heightfield is injected, there is no clock in it, and the same
 * queries in the same order always give the same answers. What it is *not* is
 * automatically fresh -- terrain streams in chunk by chunk, and a height
 * sampled over ground that had not arrived yet is a height that has to be
 * thrown away, which is what {@link invalidate} is for.
 */
export class SampledGround {
  private readonly heights = new Map<number, number>();

  constructor(
    private readonly heightAt: HeightAt,
    readonly lattice: number = SAMPLE_STEP,
    /**
     * How many samples to hold before starting over. A player who walks the
     * whole map would otherwise memoize the whole map; starting over costs one
     * warm-up and is two lines, where an eviction policy is a data structure.
     */
    readonly limit: number = 1 << 15,
  ) {}

  /** How many lattice points are held. */
  get size(): number {
    return this.heights.size;
  }

  /** Forget everything, because the ground itself changed. */
  invalidate(): void {
    this.heights.clear();
  }

  /** The ground at a lattice point, sampled once and remembered. */
  private corner(i: number, j: number): number {
    // Two integers into one key. The lattice reaches about +-1500 on this map,
    // so 20 bits of column is room to spare and the product stays exact.
    const key = i * 1_048_576 + j;
    const held = this.heights.get(key);
    if (held !== undefined) return held;
    if (this.heights.size >= this.limit) this.heights.clear();
    const height = this.heightAt(i * this.lattice, j * this.lattice);
    this.heights.set(key, height);
    return height;
  }

  /** The ground under a point: the four lattice corners around it, blended. */
  readonly at: HeightAt = (x, z) => {
    const fx = x / this.lattice;
    const fz = z / this.lattice;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const h00 = this.corner(i, j);
    const h10 = this.corner(i + 1, j);
    const h01 = this.corner(i, j + 1);
    const h11 = this.corner(i + 1, j + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  };
}

/** How many vertices a template has. */
export function vertexCount(template: DecalTemplate): number {
  return template.local.length / 2;
}

/**
 * How many segments an arc of this length wants, and how many rings a radius
 * does. Both are the same question -- how many steps fit -- asked about a
 * curved span and a straight one.
 */
function segmentsFor(arcLength: number): number {
  return Math.min(MAX_SEGMENTS, Math.max(3, Math.ceil(arcLength / SAMPLE_STEP)));
}

function ringsFor(depth: number): number {
  return Math.min(MAX_RINGS, Math.max(1, Math.ceil(depth / SAMPLE_STEP)));
}

/**
 * How many segments an *arc* wants: the finer of what the ground asks for and
 * what {@link MAX_SEGMENT_ANGLE} asks for (spec 164).
 *
 * Only the curved builders go through this. A lane has no curvature to bound,
 * so flooring its columns would buy nothing and cost samples.
 */
function arcSegmentsFor(radius: number, sweep: number): number {
  const span = Math.abs(sweep);
  const forGround = segmentsFor(span * radius);
  const forRoundness = Math.ceil(span / MAX_SEGMENT_ANGLE);
  return Math.min(MAX_SEGMENTS, Math.max(forGround, forRoundness));
}

/**
 * A grid of `(columns + 1) x (rows + 1)` vertices, triangulated.
 *
 * Every template here is one of these bent into a different frame -- a disc is
 * a grid in (angle, radius), a lane is a grid in (forward, sideways) -- so the
 * indexing is written once. `place` fills in a vertex from its column and row
 * fractions, both in 0..1.
 */
function grid(
  columns: number,
  rows: number,
  step: number,
  place: (u: number, v: number, out: Float32Array, at: number) => void,
): DecalTemplate {
  const cols = columns + 1;
  const local = new Float32Array(cols * (rows + 1) * 2);
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col < cols; col++) {
      place(col / columns, row / rows, local, (row * cols + col) * 2);
    }
  }

  const index = new Uint16Array(columns * rows * 6);
  let at = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const a = row * cols + col;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      index[at++] = a;
      index[at++] = c;
      index[at++] = b;
      index[at++] = b;
      index[at++] = c;
      index[at++] = d;
    }
  }

  return { local, index, step };
}

/**
 * A disc, or the sector of one between two angles.
 *
 * The centre is a whole row of coincident vertices rather than one shared apex,
 * which costs a handful of degenerate triangles at the middle and buys the one
 * grid above. They are degenerate in XZ and stay degenerate whatever the ground
 * does to them, so nothing is ever drawn for them.
 */
export function discTemplate(radius: number, from = -Math.PI, to = Math.PI): DecalTemplate {
  const r = Math.max(1, radius);
  const sweep = to - from;
  const segments = arcSegmentsFor(r, sweep);
  const rings = ringsFor(r);
  const step = Math.max((Math.abs(sweep) * r) / segments, r / rings);
  return grid(segments, rings, step, (u, v, out, at) => {
    const angle = from + sweep * u;
    out[at] = Math.cos(angle) * r * v;
    out[at + 1] = Math.sin(angle) * r * v;
  });
}

/**
 * An annulus: the range ring, which is the indicator spec 153 was most about,
 * since it is the largest thing drawn on the ground and therefore the one that
 * crossed the most hillside while pretending to be level -- and, since spec
 * 164, the ring under a body, which is the smallest and was buried by the
 * *gradient* rather than by its own size.
 */
export function ringTemplate(inner: number, outer: number): DecalTemplate {
  const ro = Math.max(1, outer);
  const ri = Math.min(Math.max(0, inner), ro - 0.001);
  const segments = arcSegmentsFor(ro, 2 * Math.PI);
  const step = Math.max((2 * Math.PI * ro) / segments, ro - ri);
  return grid(segments, 1, step, (u, v, out, at) => {
    const angle = -Math.PI + 2 * Math.PI * u;
    const radius = ri + (ro - ri) * v;
    out[at] = Math.cos(angle) * radius;
    out[at + 1] = Math.sin(angle) * radius;
  });
}

/**
 * The ring under a body (spec 164), as the numbers the flat mesh drew.
 *
 * It was one `RingGeometry(22, 27, 24)` scaled by `max(0.6, (radius + margin) /
 * 27)`, so these two are that scale factor read back as the radii it produced:
 * the inner edge is 22/27 of the outer, and the `0.6` floor is a radius of
 * 16.2. Written out rather than left as a scale because a decal is *built* at a
 * radius -- there is no transform on it to scale -- and because a proportion is
 * what keeps the ring as thick as it was whatever body it is under.
 */
export const BODY_RING_INNER = 22 / 27;
export const BODY_RING_MIN_RADIUS = 27 * 0.6;

/**
 * The outer radius of the ring under a body of this size, to the nearest unit.
 *
 * Rounded because a `GroundDecal` holds one template at a time and rebuilds it
 * when the key changes, so a cursor sweeping across bodies would otherwise
 * re-tessellate on any radius that differed at all -- which was spec 153's
 * stated objection to converting these ("sized by scaling one shared geometry
 * rather than built per radius"), and this is the answer to it. Body radii are
 * a handful of authored values and a unit is invisible on a ring thirty across,
 * so rounding bounds the key set whatever the monster table does later.
 */
export function bodyRingRadius(bodyRadius: number, margin: number): number {
  return Math.round(Math.max(BODY_RING_MIN_RADIUS, bodyRadius + margin));
}

/** That ring as a template: the same annulus, at the radius above. */
export function bodyRingTemplate(outer: number): DecalTemplate {
  return ringTemplate(outer * BODY_RING_INNER, outer);
}

/**
 * The lane a shot flies down: from the caster rather than centred on them, as
 * long as the ability reaches and as wide as the projectile is.
 */
export function laneTemplate(length: number, width: number): DecalTemplate {
  const len = Math.max(1, length);
  const wide = Math.max(1, width);
  const columns = segmentsFor(len);
  const rows = ringsFor(wide);
  const step = Math.max(len / columns, wide / rows);
  return grid(columns, rows, step, (u, v, out, at) => {
    out[at] = len * u;
    out[at + 1] = wide * (v - 0.5);
  });
}

/**
 * The template for an aim shape (spec 080), reading the same numbers
 * `buildAimGeometry` read off the ability table before it.
 *
 * A cone is a sector symmetric about forward, with the half-angle the sim will
 * actually test -- `isInCone` measures from the captured aim, and so does this.
 */
export function aimTemplate(shape: AimShape): DecalTemplate {
  switch (shape.kind) {
    case 'circle':
      return discTemplate(shape.radius);
    case 'cone':
      return discTemplate(shape.length, -shape.halfAngle, shape.halfAngle);
    case 'line':
      return laneTemplate(shape.length, shape.width);
    case 'none':
      // Nothing to draw, and said as nothing rather than as a degenerate quad:
      // the caller hides the mesh instead, and this is what it gets if it does
      // not.
      return { local: new Float32Array(0), index: new Uint16Array(0), step: SAMPLE_STEP };
  }
}

/**
 * Place a template on the ground: world XYZ per vertex, written into `out`.
 *
 * The result is world-space on purpose. A mesh drawn from it is never moved,
 * rotated or scaled -- a transform is exactly the thing that cannot express
 * "and follow the hill", so the heading is applied here, per vertex, where the
 * ground can be asked about the answer.
 *
 * A vertex takes the **highest** of five samples half a step around it rather
 * than the ground directly under it, which is the rule this got wrong first and
 * the one thing here that is not obvious. What gets buried is never a vertex --
 * a vertex sat exactly `lift` above the ground and was fine -- it is the
 * straight *edge* between two of them, which cuts under whatever the ground did
 * in between. Half a step is the reach that covers it: two neighbouring vertices
 * are one step apart, so between them the windows overlap, and the ground under
 * an edge is ground one of its ends has already been raised over.
 *
 * Where that is not enough is a **crease**, and it cannot be: a fold in the
 * ground is a line, and five point samples can straddle a line without landing
 * on it. What is bounded instead is the cost of one -- an eighth of what the
 * ground does across the crease over a single step, which depends on the
 * sampling and on the terrain and on *nothing about the indicator*. That is the
 * whole improvement stated exactly: the flat mesh was wrong in proportion to its
 * own size, which is why a 420-unit range ring was two hundred units into a
 * hillside, and this is wrong in proportion to eleven units of ground.
 *
 * The other cost is that on rough ground a decal floats by however much the
 * ground moves over half a step -- and then by {@link SLOPE_LIFT} of that again,
 * deliberately. That trade is the whole judgement in this file: the alternative
 * is an indicator with holes in it on exactly the terrain a player most needs to
 * read one over. On level ground all five samples agree, the spread is zero, and
 * the lift is the lift the caller asked for.
 */
export function projectDecal(
  template: DecalTemplate,
  placement: DecalPlacement,
  heightAt: HeightAt,
  out: Float32Array,
): Float32Array {
  const count = vertexCount(template);
  if (out.length < count * 3) {
    throw new Error(`projectDecal: need ${count * 3} floats, got ${out.length}`);
  }
  const cos = Math.cos(placement.heading);
  const sin = Math.sin(placement.heading);
  const reach = template.step / 2;
  for (let i = 0; i < count; i++) {
    const u = template.local[i * 2] ?? 0;
    const v = template.local[i * 2 + 1] ?? 0;
    out[i * 3] = placement.x + u * cos - v * sin;
    out[i * 3 + 2] = placement.z + u * sin + v * cos;
    // Sampled at the position that was *stored*, not at the one that was
    // computed: the buffer is 32-bit and the vertex the GPU draws is the
    // rounded one, so asking about the unrounded one would hang the decal a
    // rounding error off the ground it is supposed to be lying on.
    const x = out[i * 3] ?? 0;
    const z = out[i * 3 + 2] ?? 0;
    const here = heightAt(x, z);
    const west = heightAt(x - reach, z);
    const east = heightAt(x + reach, z);
    const north = heightAt(x, z - reach);
    const south = heightAt(x, z + reach);
    const high = Math.max(here, west, east, north, south);
    const low = Math.min(here, west, east, north, south);
    out[i * 3 + 1] = high + placement.lift + SLOPE_LIFT * (high - low);
  }
  return out;
}
