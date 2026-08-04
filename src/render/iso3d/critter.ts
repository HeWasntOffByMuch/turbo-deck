import * as THREE from 'three';
import type { Vec2 } from '../../sim/types.js';
import type { FigureTuning } from '../cloth/params.js';
import {
  deriveCoat,
  resolveParts,
  resolveSockets,
  type CoatColors,
  type CoatRole,
  type CritterSpecies,
  type HullRing,
  type PaintBlob,
  type ResolvedPart,
  type ResolvedSocket,
} from '../critters/index.js';
import { Humanoid, type BodyDresser, type GaitState } from './humanoid.js';
import { MotionObserver } from './motion.js';
import type { SandboxUnit } from './unit.js';

/**
 * The three.js half of a critter (spec 049): it builds a species' declared
 * blocks, hangs them off the shared skeleton, and drives the bits of it the
 * walk cycle does not know about -- ears, tails, anything on a socket.
 *
 * **There is no per-species code in this file, and that is the point.** Adding a
 * sheep means adding `critters/sheep.ts`; this class already knows how to build
 * it, colour it and animate it. The moment a `if (species.id === ...)` appears
 * here, the data layer has failed and the fix belongs in `critters/`, not here.
 *
 * Colours are the one thing built per rig rather than shared. Every other mesh
 * in the scene draws from `meshes.ts`'s material cache, keyed by colour -- which
 * is right for terrain and props and catastrophic here, because retinting one
 * player's pig would repaint every object that happened to share its hex. So a
 * critter owns its own {@link THREE.MeshLambertMaterial} per colour role, and
 * `setCoat` mutates those.
 *
 * Nothing here reads or writes sim state; the character is entirely cosmetic.
 */

const TWO_PI = Math.PI * 2;

/** Speed at which the idle sway has fully faded out, matching the gait's ramp. */
const IDLE_SPEED = 5;
const WALK_SPEED = 34;

/** The critter's own cosmetic knobs, on top of the shared figure tuning. */
export interface CritterTuning extends FigureTuning {
  /** Multiplier on every socket's stride-driven swing: floppier ears and tails. */
  wobbleScale: number;
  /** Multiplier on how far sockets are thrown outward by a turn. */
  swishScale: number;
}

export function defaultCritterTuning(): CritterTuning {
  return {
    bodyScale: 1,
    strideScale: 1,
    // Lower than the robe's: these are short-armed animals, and a full human
    // arm swing on them reads as marching.
    armSwing: 0.4,
    jumpHeight: 42,
    gravityMultiplier: 1,
    wobbleScale: 1,
    swishScale: 1,
  };
}

/** Bounds for {@link CritterTuning}, in the same spirit as the robe's. */
export const CRITTER_BOUNDS: Record<keyof CritterTuning, readonly [number, number]> = {
  bodyScale: [0.3, 4],
  strideScale: [0.3, 3],
  armSwing: [0, 2],
  jumpHeight: [0, 400],
  gravityMultiplier: [0, 6],
  wobbleScale: [0, 4],
  swishScale: [0, 4],
};

/** A socket node plus everything needed to animate it, resolved once at build. */
interface LiveSocket {
  readonly node: THREE.Object3D;
  readonly spec: ResolvedSocket;
  /** Rest rotation about the wobble axis; the wobble is an offset from this. */
  readonly rest: number;
  /** The eased current offset, so a socket lags rather than snapping. */
  value: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!(edge1 > edge0)) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Default radial segment count for a lofted hull. Low enough to stay faceted. */
const HULL_SIDES = 10;

/** One-dimensional Catmull-Rom through four control values. */
function spline(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Subdivide a profile with a Catmull-Rom through the declared rings.
 *
 * Two things need this, and the second is the surprising one. It rounds the
 * silhouette, so a species can describe a body with eight rings read off a
 * reference instead of thirty tuned by hand. And it gives the surface enough
 * resolution *along* the body for a painted marking to have a curved edge --
 * a patch can only follow the facets it is cut from, so on a coarse loft a
 * round blob comes out as a chevron no matter how round the blob is.
 */
function subdivideRings(rings: readonly HullRing[], steps: number): HullRing[] {
  if (steps <= 1 || rings.length < 2) return [...rings];
  const get = (i: number): HullRing => rings[Math.max(0, Math.min(rings.length - 1, i))] as HullRing;
  const out: HullRing[] = [];
  for (let i = 0; i < rings.length - 1; i++) {
    const a = get(i - 1);
    const b = get(i);
    const c = get(i + 1);
    const d = get(i + 2);
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      out.push({
        along: spline(a.along, b.along, c.along, d.along, t),
        // Radii are clamped at zero: a Catmull-Rom can overshoot below its
        // control points, and a negative radius turns the ring inside out.
        rx: Math.max(0, spline(a.rx, b.rx, c.rx, d.rx, t)),
        rz: Math.max(0, spline(a.rz, b.rz, c.rz, d.rz, t)),
        dx: spline(a.dx ?? 0, b.dx ?? 0, c.dx ?? 0, d.dx ?? 0, t),
        dz: spline(a.dz ?? 0, b.dz ?? 0, c.dz ?? 0, d.dz ?? 0, t),
      });
    }
  }
  out.push(rings[rings.length - 1] as HullRing);
  return out;
}

/**
 * Loft a closed skin through a part's profile rings.
 *
 * This is the shape that makes a critter look like an animal instead of a pile
 * of primitives: one continuous surface whose silhouette tapers where the rings
 * taper, capped at both ends. Built **non-indexed**, one triangle at a time,
 * because flat shading wants unshared vertices anyway and because face painting
 * needs to be able to hand any single triangle to a different material.
 *
 * `axis` picks which local axis the rings stack along -- `y` for a torso, `x`
 * for a muzzle running forward out of the skull.
 */
/**
 * Deterministic value noise in [-1, 1], from an integer index and a channel.
 *
 * Deliberately a hash rather than the shared {@link Rng}: the loft needs the
 * *same* nudge for the same vertex every time it is built, in any order, without
 * threading a generator through the geometry code -- and a critter that rebuilt
 * itself into a slightly different shape between two runs would break every
 * determinism test in the suite.
 */
function noise(index: number, channel: number): number {
  let h = Math.imul(index * 2 + channel + 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x7fffffff - 1;
}

/**
 * Whether splitting a quad leaves its shared edge convex: the other triangle's
 * far corner must sit on or below the plane of `(p, q, r)`, taken with that
 * triangle's outward winding. Above it means the pair folds into a valley.
 */
function foldsConvex(
  p: readonly [number, number, number],
  q: readonly [number, number, number],
  r: readonly [number, number, number],
  apex: readonly [number, number, number],
): boolean {
  const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]] as const;
  const e2 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]] as const;
  const nx = e1[1] * e2[2] - e1[2] * e2[1];
  const ny = e1[2] * e2[0] - e1[0] * e2[2];
  const nz = e1[0] * e2[1] - e1[1] * e2[0];
  const dx = apex[0] - p[0];
  const dy = apex[1] - p[1];
  const dz = apex[2] - p[2];
  return nx * dx + ny * dy + nz * dz <= 0;
}

/** Squared distance, for choosing a quad's shorter diagonal. */
function dist2(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function loftHull(
  declared: readonly HullRing[],
  axis: 'x' | 'y',
  sides: number,
  smooth: number,
  jitter: number,
): THREE.BufferGeometry {
  if (declared.length < 2) throw new Error('a hull needs at least two rings');
  // Normalise to ascending `along` before anything else. A species is free to
  // write a limb's rings from the joint downward (which reads better next to the
  // bone it hangs off) and a torso's from the belly upward, and the two orders
  // wind their triangles opposite ways -- so one of them would come out
  // inside-out and be culled. Ordering here means the winding below is stated
  // once and is always right.
  const ordered =
    (declared[declared.length - 1] as HullRing).along < (declared[0] as HullRing).along
      ? [...declared].reverse()
      : declared;
  const rings = subdivideRings(ordered, smooth);
  const verts: number[] = [];

  // Which way round the ring is swept. `(x, z, y)` and `(y, z, x)` have opposite
  // handedness, so an identical sweep winds a y loft and an x loft opposite ways
  // -- one of the two comes out inside-out. Reversing the sweep for the x loft
  // keeps the single winding rule below correct for both, and an ellipse swept
  // backwards is the same ellipse.
  const spin = axis === 'y' ? 1 : -1;

  /**
   * The profile at an arbitrary position along the axis, interpolated between
   * the subdivided rings. This is what keeps a jittered vertex **on the surface**
   * -- see {@link at}.
   */
  const sampleAt = (along: number): HullRing => {
    if (along <= (rings[0] as HullRing).along) return rings[0] as HullRing;
    const last = rings[rings.length - 1] as HullRing;
    if (along >= last.along) return last;
    for (let i = 0; i < rings.length - 1; i++) {
      const lo = rings[i] as HullRing;
      const hi = rings[i + 1] as HullRing;
      if (along < lo.along || along > hi.along) continue;
      const span = hi.along - lo.along;
      const t = span === 0 ? 0 : (along - lo.along) / span;
      const mix = (a: number, b: number): number => a + (b - a) * t;
      return {
        along,
        rx: mix(lo.rx, hi.rx),
        rz: mix(lo.rz, hi.rz),
        dx: mix(lo.dx ?? 0, hi.dx ?? 0),
        dz: mix(lo.dz ?? 0, hi.dz ?? 0),
      };
    }
    return last;
  };

  /**
   * A vertex: ring `i`, column `s`, in part-local space.
   *
   * `jitter` varies the facet sizes so the surface is not a perfect grid -- a
   * grid reads as a lathe however low-poly it is. Two rules make that safe, and
   * both were arrived at by measuring concave edges rather than by looking:
   *
   * 1. **The nudge is tangential, never radial.** It moves the vertex along the
   *    surface and re-evaluates the profile there, so it still lies exactly on
   *    the smooth body. Displace a vertex radially and it sits proud of or below
   *    its neighbours, the two faces sharing an edge fold into a valley, and
   *    flat shading draws that valley as a hard dark crease.
   *
   * 2. **Each nudge is shared along the axis it must not vary on.** The angular
   *    nudge depends on the *column* alone, so every ring is rotated the same
   *    way and no two rings are offset relative to each other; the axial nudge
   *    depends on the *ring* alone, so a ring stays planar. Vary either
   *    per-vertex and neighbouring rings end up mutually staggered -- a ring's
   *    edges are chords sitting inside the surface its neighbour's vertices sit
   *    on, and the band folds inward where they meet. That is the same defect
   *    the deliberate half-segment stagger had, arrived at by accident.
   *
   * What survives is columns at uneven angles and rings at uneven heights: facet
   * sizes vary, the polyhedron stays inscribed in a convex surface, and a convex
   * surface cannot crease.
   */
  const at = (i: number, s: number): [number, number, number] => {
    const ring = rings[i] as HullRing;
    let along = ring.along;
    if (jitter > 0 && i > 0 && i < rings.length - 1) {
      // Bounded well inside the gap to each neighbour, so two rings can never
      // cross over and fold the surface back through itself.
      const below = ring.along - (rings[i - 1] as HullRing).along;
      const above = (rings[i + 1] as HullRing).along - ring.along;
      along += jitter * noise(i, 2) * Math.min(below, above) * 0.4;
    }
    const p = sampleAt(along);
    // Capped at a fraction of a segment, so columns keep their order and the
    // surface cannot self-intersect.
    const swirl = jitter * noise(s, 1) * (0.45 / sides);
    const a = spin * (s / sides + swirl) * Math.PI * 2;
    const u = (p.dx ?? 0) + Math.cos(a) * p.rx;
    const v = (p.dz ?? 0) + Math.sin(a) * p.rz;
    // For a y loft, the ring lies in the xz plane; for an x loft, in the yz.
    return axis === 'y' ? [u, p.along, v] : [p.along, u, v];
  };

  const centre = (ring: HullRing): [number, number, number] =>
    axis === 'y'
      ? [ring.dx ?? 0, ring.along, ring.dz ?? 0]
      : [ring.along, ring.dx ?? 0, ring.dz ?? 0];

  // Which face each triangle belongs to. A quad's two triangles share an id, so
  // face painting can decide once per *face* rather than once per triangle --
  // otherwise a marking's edge saws along the diagonals and, where a blob
  // straddles a ring, comes out as stripes.
  const faceOf: number[] = [];
  let face = 0;

  const push = (p: readonly [number, number, number]): void => {
    verts.push(p[0], p[1], p[2]);
  };
  const tri = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
  ): void => {
    push(a);
    push(b);
    push(c);
    faceOf.push(face);
  };

  /**
   * Every ring's vertices, computed **once here**; the bands below only index
   * into them. Not an optimisation: with `jitter` on, recomputing a vertex gives
   * it a different nudge, so a vertex shared by two bands would land in two
   * places and tear the surface into ridges along every ring. Likewise the wrap
   * below is `(s + 1) % sides`, or the seam where the ring closes parts the same
   * way.
   *
   * ## Rings are *not* staggered, and that was a deliberate reversal
   *
   * Rotating alternate rings half a segment -- an antiprism strip -- is the
   * obvious way to make a lofted tube read as triangles rather than as a quad
   * grid, and it does. It also puts a **concave crease on every ring**, because
   * a ring's edges are chords that sit inside the surface its neighbours'
   * vertices sit on, so the band folds inward where they meet. Flat-shaded that
   * is a hard dark line at every ring, and a belly wearing a dozen of them looks
   * hammered. Measured: staggering was the sole source of concavity in the
   * whole model -- 8 concave edges on a forearm with it, 0 without.
   *
   * The irregularity comes from the two mechanisms that cost nothing instead:
   * tangential `jitter` (see {@link at}) and the shorter-diagonal split below.
   */
  const ringVerts: [number, number, number][][] = rings.map((_ring, i) =>
    Array.from({ length: sides }, (_, s) => at(i, s)),
  );

  for (let i = 0; i < rings.length - 1; i++) {
    const lo = ringVerts[i] as [number, number, number][];
    const hi = ringVerts[i + 1] as [number, number, number][];
    for (let s = 0; s < sides; s++) {
      const n = (s + 1) % sides;
      const a = lo[s] as [number, number, number];
      const b = lo[n] as [number, number, number];
      const c = hi[n] as [number, number, number];
      const d = hi[s] as [number, number, number];

      // These four corners are **not coplanar** -- uneven column angles and ring
      // heights see to that -- and a non-planar quad folds one of two ways
      // depending on which diagonal it is cut along: over the hump into a convex
      // roof, or under it into a concave valley. Flat-shaded, a valley is a hard
      // dark crease, which is what makes a belly look beaten rather than round.
      // So the diagonal is not a free choice.
      //
      // Tested rather than guessed. "Take the shorter diagonal" is the usual
      // heuristic and it holds for near-square quads, but these are strongly
      // trapezoidal wherever the profile flares -- at the base of the belly the
      // radius half-doubles over four units -- and there it picks wrong. Folding
      // each candidate and asking whether it is convex costs two dot products at
      // build time and is exact.
      //
      // Both windings run the quad's outward cycle a -> d -> c -> b, so the
      // normals point away from the axis whichever split is taken.
      const acConvex = foldsConvex(a, c, b, d);
      const bdConvex = foldsConvex(a, d, b, c);
      const useAC = acConvex === bdConvex ? dist2(a, c) <= dist2(b, d) : acConvex;
      if (useAC) {
        tri(a, c, b);
        tri(a, d, c);
      } else {
        tri(a, d, b);
        tri(b, d, c);
      }
      face += 1;
    }
  }

  // Caps. A fan to the ring's centre, which for a ring that has closed to
  // nothing degenerates harmlessly into zero-area triangles.
  const firstCentre = centre(rings[0] as HullRing);
  const lastCentre = centre(rings[rings.length - 1] as HullRing);
  const firstVerts = ringVerts[0] as [number, number, number][];
  const lastVerts = ringVerts[rings.length - 1] as [number, number, number][];
  for (let s = 0; s < sides; s++) {
    const n = (s + 1) % sides;
    // Caps face outward along the axis: the first away from +along, the last
    // toward it. They reuse the precomputed ring vertices, so a jittered cap
    // cannot part from the surface it closes.
    tri(firstCentre, firstVerts[s] as [number, number, number], firstVerts[n] as [number, number, number]);
    face += 1;
    tri(lastCentre, lastVerts[n] as [number, number, number], lastVerts[s] as [number, number, number]);
    face += 1;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.userData.faceOf = Int32Array.from(faceOf);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Split `geo` into material groups by which {@link PaintBlob} each *face* falls
 * into, and return the role each group draws with.
 *
 * Per face, not per triangle. A quad split down its diagonal has two triangles
 * whose centres sit either side of the split, so testing them independently
 * gives a marking a sawtooth edge -- and where a blob straddles a ring of the
 * loft, alternating stripes. `geo.userData.faceOf` (written by the loft) maps
 * each triangle to the face it came from; a geometry without it degrades to one
 * face per triangle, which is correct for a box or a cone.
 *
 * The mesh is then reordered so every group is one contiguous run, which is what
 * three.js wants and what keeps this to one draw call per colour rather than one
 * per triangle. Faces inside no blob keep the part's own role.
 */
function paintGroups(
  geo: THREE.BufferGeometry,
  baseRole: CoatRole,
  blobs: readonly PaintBlob[],
): CoatRole[] {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const triCount = pos.count / 3;
  const roles: CoatRole[] = [baseRole];
  const roleIndex = new Map<CoatRole, number>([[baseRole, 0]]);
  const assignment = new Int32Array(triCount);

  const faceOf = (geo.userData.faceOf as Int32Array | undefined) ?? null;
  const faceCount = faceOf ? (faceOf[faceOf.length - 1] ?? -1) + 1 : triCount;
  // Accumulate each face's centre from the triangles that make it up.
  const sums = new Float64Array(faceCount * 3);
  const counts = new Int32Array(faceCount);
  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    const f = faceOf ? (faceOf[t] as number) : t;
    sums[f * 3] = (sums[f * 3] as number) + (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    sums[f * 3 + 1] = (sums[f * 3 + 1] as number) + (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    sums[f * 3 + 2] = (sums[f * 3 + 2] as number) + (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    counts[f] = (counts[f] as number) + 1;
  }

  const faceRole = new Int32Array(faceCount);
  for (let f = 0; f < faceCount; f++) {
    const n = counts[f] as number;
    if (n === 0) continue;
    const cx = (sums[f * 3] as number) / n;
    const cy = (sums[f * 3 + 1] as number) / n;
    const cz = (sums[f * 3 + 2] as number) / n;
    for (const blob of blobs) {
      const dx = (cx - blob.at[0]) / blob.r[0];
      const dy = (cy - blob.at[1]) / blob.r[1];
      const dz = (cz - blob.at[2]) / blob.r[2];
      if (dx * dx + dy * dy + dz * dz > 1) continue;
      let index = roleIndex.get(blob.role);
      if (index === undefined) {
        index = roles.length;
        roles.push(blob.role);
        roleIndex.set(blob.role, index);
      }
      faceRole[f] = index;
      break;
    }
  }
  for (let t = 0; t < triCount; t++) {
    assignment[t] = faceRole[faceOf ? (faceOf[t] as number) : t] as number;
  }

  // Reorder the triangles so each material's are contiguous. The face map is
  // permuted with them: leaving it in the pre-sort order would make it silently
  // describe a mesh that no longer exists.
  const src = pos.array as Float32Array;
  const sorted = new Float32Array(src.length);
  const sortedFaces = faceOf ? new Int32Array(triCount) : null;
  let write = 0;
  let writeTri = 0;
  geo.clearGroups();
  for (let r = 0; r < roles.length; r++) {
    const start = write / 3;
    for (let t = 0; t < triCount; t++) {
      if (assignment[t] !== r) continue;
      sorted.set(src.subarray(t * 9, t * 9 + 9), write);
      if (sortedFaces && faceOf) sortedFaces[writeTri] = faceOf[t] as number;
      write += 9;
      writeTri += 1;
    }
    const count = write / 3 - start;
    if (count > 0) geo.addGroup(start, count, r);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(sorted, 3));
  if (sortedFaces) geo.userData.faceOf = sortedFaces;
  geo.computeVertexNormals();
  return roles;
}

/**
 * Geometry for one part. Shared across every rig of the same shape via a cache
 * keyed on the primitive's parameters: two pigs in different colours are two
 * material sets over one set of buffers.
 */
const geometryCache = new Map<string, { geo: THREE.BufferGeometry; roles: CoatRole[] }>();

function partGeometry(part: ResolvedPart): { geo: THREE.BufferGeometry; roles: CoatRole[] } {
  const [w, h, d] = part.size;
  const facets = part.facets;
  const key =
    `${part.shape}|${w},${h},${d}|${part.taper ?? 0}|${facets ?? -1}|${part.axis ?? 'y'}|${part.smooth ?? 1}|${part.jitter ?? 0}` +
    `|${part.role}|${JSON.stringify(part.rings ?? null)}|${JSON.stringify(part.paint ?? null)}`;
  const hit = geometryCache.get(key);
  if (hit) return hit;

  let geo: THREE.BufferGeometry;
  if (part.shape === 'hull') {
    if (!part.rings) throw new Error(`hull ${part.name} has no rings`);
    geo = loftHull(part.rings, part.axis ?? 'y', facets ?? HULL_SIDES, part.smooth ?? 1, part.jitter ?? 0);
  } else if (part.shape === 'box') {
    geo = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  } else if (part.shape === 'ball') {
    // A unit icosahedron scaled to the part's extents: faceted, and elliptical
    // without needing a separate sphere per axis ratio. Already non-indexed, so
    // calling `toNonIndexed` on it would only earn a console warning.
    geo = new THREE.IcosahedronGeometry(0.5, facets ?? 0);
    geo.scale(w, h, d);
  } else {
    // `taper` is the +y radius over the -y base, matching the spec's convention.
    const taper = part.taper ?? 0;
    geo = new THREE.CylinderGeometry(0.5 * taper, 0.5, 1, facets ?? 5, 1, false);
    geo.scale(w, h, d);
    geo = geo.toNonIndexed();
  }

  // `BoxGeometry` ships six per-face groups that survive `toNonIndexed`. They
  // are meaningless here and actively misleading -- an unpainted part draws with
  // one material, so groups pointing at indices 1..5 describe a mesh that does
  // not exist. Clear them, then let the paint pass author the only groups a
  // critter mesh ever has.
  geo.clearGroups();
  const roles = part.paint?.length ? paintGroups(geo, part.role, part.paint) : [part.role];
  const entry = { geo, roles };
  geometryCache.set(key, entry);
  return entry;
}

export class CritterRig implements SandboxUnit {
  /** The unit root the scene positions and yaws. */
  readonly group = new THREE.Group();
  readonly orientsWithGroupYaw = true;
  readonly species: CritterSpecies;
  readonly tuning: CritterTuning;
  readonly humanoid: Humanoid;

  /** One material per colour role, owned by this rig so `setCoat` is local. */
  private readonly materials = new Map<CoatRole, THREE.MeshLambertMaterial>();
  private readonly sockets: LiveSocket[] = [];
  private readonly motion = new MotionObserver();
  private coatHex: number;
  private clock = 0;

  constructor(species: CritterSpecies, opts: { tuning?: CritterTuning; coat?: number } = {}) {
    this.species = species;
    this.tuning = opts.tuning ?? defaultCritterTuning();
    this.coatHex = opts.coat ?? species.defaultCoat;

    const colors = deriveCoat(species, this.coatHex);
    for (const role of Object.keys(colors) as CoatRole[]) {
      this.materials.set(role, new THREE.MeshLambertMaterial({ color: colors[role], flatShading: true }));
    }

    // The sockets have to exist before the dresser runs, because parts name
    // them; they are built into a map the dresser closes over.
    const socketNodes = new Map<string, THREE.Object3D>();
    const dress: BodyDresser = (bones) => {
      for (const spec of resolveSockets(species)) {
        const node = new THREE.Object3D();
        node.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
        node.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
        const parent = bones[spec.parentBone];
        if (!parent) throw new Error(`${species.id}: socket ${spec.name} hangs off bone ${spec.parentBone}`);
        parent.add(node);
        socketNodes.set(spec.name, node);
        this.sockets.push({
          node,
          spec,
          rest: spec.wobble ? node.rotation[spec.wobble.axis] : 0,
          value: 0,
        });
      }
      for (const part of resolveParts(species)) {
        const parent =
          typeof part.attach === 'number' ? bones[part.attach] : socketNodes.get(part.attach);
        if (!parent) throw new Error(`${species.id}: part ${part.name} has no attachment ${String(part.attach)}`);
        const { geo, roles } = partGeometry(part);
        // A painted part draws one material per colour region; an unpainted one
        // is the single-material case of the same thing.
        const material = roles.length === 1 ? this.material(roles[0] as CoatRole) : roles.map((r) => this.material(r));
        const mesh = new THREE.Mesh(geo, material);
        mesh.position.set(part.pos[0], part.pos[1], part.pos[2]);
        mesh.rotation.set(part.rot[0], part.rot[1], part.rot[2]);
        mesh.name = part.name;
        parent.add(mesh);
      }
    };

    this.humanoid = new Humanoid(species.metrics, dress);
    this.group.add(this.humanoid.group);
  }

  /** The species' gait, for the sandbox status line. */
  get locomotionState(): GaitState {
    return this.humanoid.gaitState;
  }

  /** The coat currently applied. */
  get coat(): number {
    return this.coatHex;
  }

  /** Every colour this rig currently draws with, for the panel's swatch state. */
  get colors(): CoatColors {
    return deriveCoat(this.species, this.coatHex);
  }

  /**
   * Recolour in place. Only the rig's own materials change -- no geometry is
   * rebuilt, no other object in the scene is touched -- so this is cheap enough
   * to drive straight off a click in the coat picker.
   */
  setCoat(coat: number): void {
    this.coatHex = coat;
    const colors = deriveCoat(this.species, coat);
    for (const [role, material] of this.materials) material.color.setHex(colors[role]);
  }

  /** Trigger the cosmetic hop. */
  jump(): boolean {
    return this.humanoid.triggerJump(this.tuning);
  }

  /** Drop from `height` so a long fall can be watched in the sandbox. */
  drop(height: number): boolean {
    return this.humanoid.triggerDrop(height);
  }

  /**
   * Pose for this frame. The skeleton does the walk; everything after it is the
   * species' own secondary motion, driven entirely off numbers the walk already
   * produced.
   */
  update(dt: number, worldPos: Vec2, ry: number): void {
    const h = clamp(dt, 0, 0.1);
    this.clock += h;
    const gait = this.motion.observe(h, worldPos, ry);
    this.humanoid.update(h, gait, this.tuning);
    this.poseSockets(h, gait.speed);
    this.group.updateMatrixWorld(true);
  }

  private material(role: CoatRole): THREE.MeshLambertMaterial {
    const m = this.materials.get(role);
    if (!m) throw new Error(`${this.species.id}: no material for role ${role}`);
    return m;
  }

  /**
   * Swing every socket. Three contributions, all from the shared gait:
   *
   *  - the stride cycle, scaled by how fast the character is going, so ears bob
   *    in step with the feet rather than on a timer of their own;
   *  - an idle sway that fades *in* as the character stops, so a standing animal
   *    is never perfectly still;
   *  - a lean out of a turn, which is what throws a tail wide on a hard corner.
   *
   * Each is chased through a per-socket follow rate rather than applied directly,
   * so a heavy tail lags and a light ear does not.
   */
  private poseSockets(h: number, speed: number): void {
    const phase = this.humanoid.stridePhase * TWO_PI;
    const move = smoothstep(IDLE_SPEED, WALK_SPEED, speed);
    const turn = this.motion.turnRate;

    for (const live of this.sockets) {
      const w = live.spec.wobble;
      if (!w) continue;
      const offset = (w.phase ?? 0) * TWO_PI;
      const stride = Math.sin(phase + offset) * w.strideAmp * move;
      const idle = w.idleAmp
        ? Math.sin(this.clock * TWO_PI * (w.idleHz ?? 0.4)) * w.idleAmp * (1 - move)
        : 0;
      // `flip` opposes the pair across the body: both ears swing outward, not
      // both to the left.
      const lean = w.leanAmp ? clamp(-turn * 0.28, -1.6, 1.6) * w.leanAmp : 0;
      const target =
        (stride + idle) * this.tuning.wobbleScale * live.spec.flip +
        lean * this.tuning.swishScale * live.spec.flip;

      const k = Math.min(1, h * (w.follow ?? 8));
      live.value += (target - live.value) * k;
      live.node.rotation[w.axis] = live.rest + live.value;
    }
  }
}
