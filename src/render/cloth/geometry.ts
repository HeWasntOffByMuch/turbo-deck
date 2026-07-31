import { BONE, type FigureMetrics } from './figure.js';
import { MASK } from './colliders.js';

/**
 * The robe's **patterns** (spec 037): each garment piece is cut as a parametric
 * particle grid in the figure's bind pose, together with the constraint graph,
 * skinning bones and triangle list the solver and the renderer need.
 *
 * This is the tailoring layer, and it is deliberately data-only and pure: a
 * piece is built once at startup and never rebuilt, so everything expensive or
 * awkward (finding each particle's anchor, measuring rest lengths, deciding what
 * is pinned) happens here instead of per frame. Adding a new garment -- a
 * tabard, a longer cape, a shoulder mantle -- means adding one `build*` function
 * that describes its surface; nothing in the solver or the rig changes.
 *
 * Every piece is a grid of `rows x cols` particles:
 *  - `rows` runs *away from the attachment*: row 0 is the pinned ring/edge that
 *    the skeleton drives, the last row is the free hem.
 *  - `cols` runs *across* the piece, and wraps when `closed` (a tube: the lower
 *    robe and the sleeves) or stops at the edges when open (a sheet: the cape
 *    and the hood).
 */

/** How a distance constraint behaves; the solver picks its stiffness from this. */
export const LINK_STRUCTURAL = 0;
export const LINK_SHEAR = 1;
export const LINK_BEND = 2;

/** One cut-and-stitched garment piece, ready for the solver. */
export interface ClothGeometry {
  readonly name: string;
  readonly rows: number;
  readonly cols: number;
  /** Whether the `cols` direction wraps (a tube) or has two free edges (a sheet). */
  readonly closed: boolean;
  readonly count: number;
  /** `3 * count` bind-pose positions, in character-local space at bodyScale 1. */
  readonly bind: Float64Array;
  /** `count` bone indices: which bone each particle is skinned to. */
  readonly bone: Int32Array;
  /** `count` flags: 1 = driven by the skeleton, 0 = simulated. */
  readonly pinned: Uint8Array;
  /** `count` weights (0..1) for the pull toward the skinned reference pose. */
  readonly refWeight: Float64Array;
  /** `2 * linkCount` particle-index pairs. */
  readonly link: Int32Array;
  /** `linkCount` rest lengths, measured in the bind pose. */
  readonly linkRest: Float64Array;
  /** `linkCount` of {@link LINK_STRUCTURAL} / {@link LINK_SHEAR} / {@link LINK_BEND}. */
  readonly linkKind: Uint8Array;
  readonly linkCount: number;
  /**
   * `count` indices of the pinned particle each particle is tethered to (itself,
   * for a pinned particle). The long-range attachment that caps stretch.
   */
  readonly anchor: Int32Array;
  /** `count` bind-pose distances to that anchor. */
  readonly anchorRest: Float64Array;
  /** Triangle list for rendering. */
  readonly index: Uint16Array;
  /** `count` stable hash seeds, so per-particle noise differs but is reproducible. */
  readonly seed: Int32Array;
  /** Which body capsules this piece may collide with (see `colliders.ts`). */
  readonly colliderMask: number;
}

/** A mutable 3-vector the surface callbacks write into, so building allocates little. */
export interface Vec3Out {
  x: number;
  y: number;
  z: number;
}

/** The description a `build*` function hands to {@link buildGrid}. */
interface GridSpec {
  readonly name: string;
  readonly rows: number;
  readonly cols: number;
  readonly closed: boolean;
  readonly colliderMask: number;
  /** A distinct seed per piece, so two pieces never share a noise stream. */
  readonly seed: number;
  /**
   * The surface: write the bind position of `(row, col)` into `out`. `u` runs
   * 0..1 down the rows (away from the attachment), `v` runs 0..1 across the
   * cols (0..1 exclusive of the wrap point when `closed`).
   */
  point(u: number, v: number, out: Vec3Out): void;
  /** Which bone drives this particle's reference pose. */
  bone(u: number, v: number): number;
  /** Whether the skeleton drives this particle outright. */
  pinned(u: number, v: number): boolean;
  /** How strongly this particle is held to its reference pose (0..1). */
  refWeight(u: number, v: number): number;
}

/**
 * Cut a grid piece: lay out the particles, stitch the structural / shear / bend
 * constraints, triangulate it, and find every particle's nearest pinned anchor.
 *
 * The three constraint families are what make this behave like woven cloth
 * rather than a net: structural links along the weave resist stretch, shear
 * links across each quad stop it collapsing into a parallelogram, and bend links
 * skipping one particle resist *folding* independently of stretching -- the
 * separation that lets limp silk and stiff felt be the same mesh with two
 * different numbers.
 */
function buildGrid(spec: GridSpec): ClothGeometry {
  const { rows, cols, closed } = spec;
  const count = rows * cols;
  const bind = new Float64Array(count * 3);
  const bone = new Int32Array(count);
  const pinned = new Uint8Array(count);
  const refWeight = new Float64Array(count);
  const seed = new Int32Array(count);
  const out: Vec3Out = { x: 0, y: 0, z: 0 };

  // The wrap point of a closed piece is the col-0 particle itself, so `v` must
  // stop one step short of 1; an open piece spans the full 0..1.
  const vSpan = closed ? cols : cols - 1;

  for (let r = 0; r < rows; r++) {
    const u = rows > 1 ? r / (rows - 1) : 0;
    for (let c = 0; c < cols; c++) {
      const v = vSpan > 0 ? c / vSpan : 0;
      const i = r * cols + c;
      spec.point(u, v, out);
      bind[i * 3] = out.x;
      bind[i * 3 + 1] = out.y;
      bind[i * 3 + 2] = out.z;
      bone[i] = spec.bone(u, v);
      pinned[i] = spec.pinned(u, v) ? 1 : 0;
      refWeight[i] = spec.refWeight(u, v);
      seed[i] = spec.seed * 7919 + i * 131 + 17;
    }
  }

  const dist = (a: number, b: number): number =>
    Math.hypot(
      (bind[a * 3] as number) - (bind[b * 3] as number),
      (bind[a * 3 + 1] as number) - (bind[b * 3 + 1] as number),
      (bind[a * 3 + 2] as number) - (bind[b * 3 + 2] as number),
    );

  const linkA: number[] = [];
  const linkB: number[] = [];
  const linkKindList: number[] = [];
  const addLink = (a: number, b: number, kind: number): void => {
    // A degenerate (zero-length) link carries no information and would divide by
    // a near-zero length in the solve; drop it at build time instead.
    if (a === b || dist(a, b) < 1e-6) return;
    linkA.push(a);
    linkB.push(b);
    linkKindList.push(kind);
  };
  /** Column `c + step`, wrapped for a tube and dropped past the edge for a sheet. */
  const colAt = (c: number, step: number): number => {
    const n = c + step;
    if (closed) return (n + cols) % cols;
    return n >= 0 && n < cols ? n : -1;
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const c1 = colAt(c, 1);
      const c2 = colAt(c, 2);
      // Structural: along the rows and along the cols.
      if (r + 1 < rows) addLink(i, (r + 1) * cols + c, LINK_STRUCTURAL);
      if (c1 >= 0) addLink(i, r * cols + c1, LINK_STRUCTURAL);
      // Shear: both diagonals of each quad.
      if (r + 1 < rows && c1 >= 0) {
        addLink(i, (r + 1) * cols + c1, LINK_SHEAR);
        addLink(r * cols + c1, (r + 1) * cols + c, LINK_SHEAR);
      }
      // Bend: skip one, in both directions.
      if (r + 2 < rows) addLink(i, (r + 2) * cols + c, LINK_BEND);
      if (c2 >= 0) addLink(i, r * cols + c2, LINK_BEND);
    }
  }

  const linkCount = linkA.length;
  const link = new Int32Array(linkCount * 2);
  const linkRest = new Float64Array(linkCount);
  const linkKind = new Uint8Array(linkCount);
  for (let k = 0; k < linkCount; k++) {
    const a = linkA[k] as number;
    const b = linkB[k] as number;
    link[k * 2] = a;
    link[k * 2 + 1] = b;
    linkRest[k] = dist(a, b);
    linkKind[k] = linkKindList[k] as number;
  }

  // Triangles: two per quad, wrapping the last column for a closed piece.
  const tri: number[] = [];
  for (let r = 0; r + 1 < rows; r++) {
    const lastCol = closed ? cols : cols - 1;
    for (let c = 0; c < lastCol; c++) {
      const c1 = closed ? (c + 1) % cols : c + 1;
      const i00 = r * cols + c;
      const i01 = r * cols + c1;
      const i10 = (r + 1) * cols + c;
      const i11 = (r + 1) * cols + c1;
      tri.push(i00, i10, i11, i00, i11, i01);
    }
  }
  const index = new Uint16Array(tri.length);
  for (let k = 0; k < tri.length; k++) index[k] = tri[k] as number;

  // Long-range attachment: each particle tethers to its nearest pinned particle
  // in the bind pose. O(count x pins) once at build time; it is what guarantees
  // the piece can never be stretched or left behind no matter what the solve does.
  const pins: number[] = [];
  for (let i = 0; i < count; i++) if (pinned[i]) pins.push(i);
  if (pins.length === 0) throw new Error(`cloth piece "${spec.name}" has no pinned particles`);
  const anchor = new Int32Array(count);
  const anchorRest = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    if (pinned[i]) {
      anchor[i] = i;
      anchorRest[i] = 0;
      continue;
    }
    let best = pins[0] as number;
    let bestD = dist(i, best);
    for (let k = 1; k < pins.length; k++) {
      const p = pins[k] as number;
      const d = dist(i, p);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    anchor[i] = best;
    anchorRest[i] = bestD;
  }

  return {
    name: spec.name,
    rows,
    cols,
    closed,
    count,
    bind,
    bone,
    pinned,
    refWeight,
    link,
    linkRest,
    linkKind,
    linkCount,
    anchor,
    anchorRest,
    index,
    seed,
    colliderMask: spec.colliderMask,
  };
}

/** Linear blend. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Blend the reference-pose weight from `top` at the attachment down to `hem` at
 * the free edge, easing quickly so only the last rows are truly loose. This
 * gradient is most of why the robe keeps a readable silhouette while its edges
 * still fly: the fabric is "sewn" firmly at the seam and free at the hem, which
 * is exactly how a garment is built.
 */
function hemWeight(u: number, top: number, hem: number): number {
  return lerp(top, hem, u * u);
}

/**
 * The **lower robe**: a closed tube gathered at the waist and flaring to an open
 * hem near the ankles. Every particle skins to the pelvis, so its rest shape is
 * a cone hanging off the hips -- the legs never drive it directly, they *push*
 * it, via their collision capsules. That is what produces the fabric sweeping
 * around a stepping knee instead of a skirt animated to swing.
 */
export function buildSkirt(f: FigureMetrics): ClothGeometry {
  const rows = 8;
  const cols = 12;
  return buildGrid({
    name: 'robe',
    rows,
    cols,
    closed: true,
    colliderMask: MASK.torso | MASK.legs,
    seed: 11,
    point(u, v, out) {
      const a = v * Math.PI * 2;
      // Flare with u^1.4 so the taper stays close to the hips and opens late.
      const t = Math.pow(u, 1.4);
      const rx = lerp(8.5, 15, t);
      const rz = lerp(9.5, 16.5, t);
      out.x = Math.cos(a) * rx;
      out.y = lerp(f.waistY, 2.5, u);
      out.z = Math.sin(a) * rz;
    },
    bone: () => BONE.pelvis,
    pinned: (u) => u === 0,
    refWeight: (u) => hemWeight(u, 1, 0.05),
  });
}

/**
 * The **cape / back drape**: an open sheet pinned across the shoulder blades and
 * hanging to mid-calf, widening as it falls and standing progressively further
 * off the back so it reads as a separate layer from the lower robe (there is no
 * cloth-vs-cloth collision -- see the spec's out-of-scope list).
 */
export function buildCape(f: FigureMetrics): ClothGeometry {
  const rows = 9;
  const cols = 6;
  return buildGrid({
    name: 'cape',
    rows,
    cols,
    closed: false,
    colliderMask: MASK.torso | MASK.legs,
    seed: 23,
    point(u, v, out) {
      const halfWidth = lerp(f.shoulderHalf + 2, f.shoulderHalf + 6, u);
      out.x = lerp(-f.chestDepth - 0.5, -f.chestDepth - 7, u * u);
      out.y = lerp(f.shoulderY + 2, 6, u);
      out.z = lerp(-halfWidth, halfWidth, v);
    },
    bone: () => BONE.chest,
    pinned: (u) => u === 0,
    refWeight: (u) => hemWeight(u, 1, 0.02),
  });
}

/**
 * The **hood**: an open cowl swept along a curved path that starts as a rim in
 * front of the face, arcs back over the crown and trails down the upper back.
 * Only the face rim is pinned (to the head), so the whole cowl is free to lift,
 * fold back off the crown and settle again -- the head capsule is what keeps it
 * from collapsing into the skull.
 *
 * The cross-section is built perpendicular to the sweep path rather than in a
 * fixed plane, so the tail lies *along* the back instead of standing out from it.
 */
export function buildHood(f: FigureMetrics): ClothGeometry {
  const rows = 7;
  const cols = 9;
  // The sweep path: forward of the face, then back and down behind the skull.
  const pathX = (u: number): number => 5 - 19 * u;
  const pathY = (u: number): number => f.headY + 1 + 3 * Math.sin(Math.PI * u) - 20 * u * u;
  return buildGrid({
    name: 'hood',
    rows,
    cols,
    closed: false,
    colliderMask: MASK.head | MASK.torso,
    seed: 37,
    point(u, v, out) {
      // Path tangent, by finite difference; the ring normal is the tangent
      // rotated a quarter turn in the xy plane, so it points up over the crown.
      const e = 1e-3;
      const tx = pathX(Math.min(1, u + e)) - pathX(Math.max(0, u - e));
      const ty = pathY(Math.min(1, u + e)) - pathY(Math.max(0, u - e));
      const tl = Math.hypot(tx, ty) || 1;
      const nx = ty / tl;
      const ny = -tx / tl;

      const radius = 11.5 + 1.5 * Math.sin(Math.PI * u) - 4.5 * u * u;
      const halfArc = 1.85 + 0.35 * u; // radians each side of straight-up
      const phi = lerp(-halfArc, halfArc, v);
      const cp = Math.cos(phi);
      out.x = pathX(u) + nx * radius * cp;
      out.y = pathY(u) + ny * radius * cp;
      out.z = Math.sin(phi) * radius;
    },
    // The rim and the crown ride the skull; the tail rests on the back, so it
    // belongs to the chest -- if the head ever turns independently, the tail stays.
    bone: (u) => (u < 0.4 ? BONE.head : BONE.chest),
    pinned: (u) => u === 0,
    // A hood is a structured garment: held far more firmly than a cape hem.
    refWeight: (u) => hemWeight(u, 1, 0.25),
  });
}

/**
 * A **sleeve**: a closed tube from the shoulder to a bell cuff hanging past the
 * wrist, pinned only at the shoulder ring. Its upper rows skin to the upper arm
 * and its lower rows to the forearm, so the cuff tracks a bent elbow while still
 * swinging freely around it.
 *
 * `side` is -1 for the figure's left (world -z) and +1 for its right.
 */
export function buildSleeve(f: FigureMetrics, side: -1 | 1): ClothGeometry {
  const rows = 6;
  const cols = 8;
  const upper = side < 0 ? BONE.upperArmL : BONE.upperArmR;
  const fore = side < 0 ? BONE.forearmL : BONE.forearmR;
  const wristY = f.shoulderY - f.upperArmLen - f.forearmLen;
  return buildGrid({
    name: side < 0 ? 'sleeveL' : 'sleeveR',
    rows,
    cols,
    closed: true,
    colliderMask: (side < 0 ? MASK.armL : MASK.armR) | MASK.torso,
    seed: side < 0 ? 51 : 67,
    point(u, v, out) {
      const a = v * Math.PI * 2;
      const radius = lerp(6.5, 10, Math.pow(u, 1.3));
      out.x = Math.cos(a) * radius;
      // Hangs a little past the wrist, so the cuff is free fabric, not skin.
      out.y = lerp(f.shoulderY, wristY - 3, u);
      out.z = side * f.shoulderHalf + Math.sin(a) * radius * 0.9;
    },
    bone: (u) => (u < 0.5 ? upper : fore),
    pinned: (u) => u === 0,
    // Sleeves must track the arm closely or they slide off it.
    refWeight: (u) => hemWeight(u, 1, 0.3),
  });
}

/** Every piece of the robe, in draw order. */
export function buildRobePieces(f: FigureMetrics): readonly ClothGeometry[] {
  return [buildSkirt(f), buildCape(f), buildHood(f), buildSleeve(f, -1), buildSleeve(f, 1)];
}
