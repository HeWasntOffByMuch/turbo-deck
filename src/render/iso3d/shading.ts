/**
 * Vertex normals: welding and averaging them across a crease angle, and
 * rotating one to follow the wind's bend (spec 093, step 2).
 *
 * Pure -- no three.js and no DOM -- so both halves run and are tested
 * headlessly, the arrangement `wind.ts` already uses: the arithmetic lives here
 * as TypeScript, the GLSL that has to compute the same thing lives here beside
 * it as a string, and `sway.ts` splices the string into a shader. A shader
 * expression nobody can execute is where a typo lives forever.
 *
 * ## What the crease angle actually does to *this* geometry
 *
 * Averaging normals across a shared position is only a change if the faces
 * meeting there are closer together than the crease angle. That makes the
 * tessellation, not the algorithm, the thing that decides whether smoothing does
 * anything -- and this world is modelled coarse on purpose:
 *
 * | surface | facets meet at | smooths at 30 degrees? |
 * |---|---|---|
 * | lobed trunk, 7 sides | 51.4 degrees | no |
 * | conifer cone, 7 segments | 51.4 degrees | no |
 * | rock, icosahedron | 41.8 degrees | no |
 * | canopy slab, 20-degree arc step | ~20 degrees | **yes**, tangentially |
 *
 * So at the default crease angle the trunks, the cones and the stones keep every
 * facet they were built with, and only the canopy slabs -- the one surface
 * actually tessellated finer than the crease -- gain a smooth sweep, with their
 * rim still split because a slab's top and underside meet there at 180 degrees.
 *
 * That is the intended outcome rather than a limitation, and the reason to leave
 * the crease below the facet angle is worth being precise about, because the
 * obvious guess is wrong. Raising it past 51 degrees does *not* melt a 7-sided
 * trunk's apex into a dome: the clustering below compares each face against its
 * group's running average, and by the time four of a seven-face ring have joined,
 * that average has tilted far enough that the fifth fails and starts a group of
 * its own. So the tip does not round off -- it breaks into two arbitrarily-sized
 * shading regions and reads blotchy, which is worse than either a facet or a
 * dome. If the trunks are ever wanted round, the change is to `trunkSegments`,
 * not to the crease.
 */

/**
 * The crease angle the smooth-shading path opens at, in radians.
 *
 * 30 degrees: comfortably under the 41.8 the coarsest intentionally-faceted
 * surface (the icosahedral rocks) meets at, so nothing built to read as facets
 * loses them, and comfortably over the ~20 the canopy slabs are walked at.
 */
export const DEFAULT_CREASE_ANGLE = (30 * Math.PI) / 180;

/**
 * How far apart the face normals of an `n`-sided prism or cone are, in radians.
 *
 * The number that decides whether a crease angle smooths a surface or leaves it
 * faceted, so it is worth being able to ask rather than work out by hand.
 */
export function facetAngle(segments: number): number {
  return (2 * Math.PI) / Math.max(1, segments);
}

/**
 * The grid coincident positions are snapped onto before being compared.
 *
 * Vertices that ought to be the same point are usually written by the same
 * expression and come out bit-identical, but not always: a ring that closes by
 * wrapping `side + 1` back to zero evaluates `cos(2 pi)` against `cos(0)`, and
 * those are not obliged to agree in the last bit. A grid this fine is far below
 * any distance that means anything in a world measured in tens of units, and far
 * above the last bit.
 */
const WELD_GRID = 1e-4;

function weldKey(x: number, y: number, z: number): string {
  return `${Math.round(x / WELD_GRID)},${Math.round(y / WELD_GRID)},${Math.round(z / WELD_GRID)}`;
}

/**
 * Per-vertex normals for a triangle soup, averaged across every face meeting at
 * a position whose normal is within `creaseCos` of the others, and split where
 * they are not.
 *
 * `positions` is flat xyz and **must be non-indexed** -- consecutive triples,
 * one vertex slot per triangle corner. Sharing is re-derived from position, not
 * from an index buffer, which is the only thing that works here: the prop
 * geometry is non-indexed precisely so its facets stay separate, so an index
 * buffer would claim every vertex is its own island.
 *
 * Indexed input is refused rather than handled, and that is not fussiness. A
 * split is *expressed* by two slots at one position carrying different normals,
 * and an indexed mesh has only one slot there -- so a crease it is asked to keep
 * cannot be written down, and the honest-looking implementation (assign per
 * slot, last group wins) silently smooths every crease it was told to split.
 * That is exactly the bug this signature now prevents: it made three.js's
 * 7-segment cones come out smooth under a 30-degree crease. Callers with indexed
 * geometry expand it first -- see `props.ts`.
 *
 * Faces are accumulated **unnormalized**, so a big triangle counts for more than
 * the sliver next to it -- area weighting, which is what stops a fan of thin
 * triangles from dragging a normal toward itself.
 *
 * Returns one normal per position, in the same order, each unit length.
 *
 * ## On the clustering
 *
 * Faces at a shared position are grouped greedily: each face joins the first
 * group whose running average it is within the crease of, or starts its own. The
 * result therefore depends on the order faces are visited -- which is fixed by
 * the buffer, so it is stable run to run, and that is all determinism needs
 * here. It is not the only defensible grouping, and it is the one every
 * modelling tool uses, for the same reason.
 */
export function weldedNormals(positions: ArrayLike<number>, creaseCos: number): Float32Array {
  const vertexCount = Math.floor(positions.length / 3);
  const normals = new Float32Array(vertexCount * 3);
  const faceCount = Math.floor(vertexCount / 3);

  /** Each face's unnormalized normal (area-weighted) and its unit direction. */
  const faceNormal = new Float64Array(faceCount * 3);
  const faceUnit = new Float64Array(faceCount * 3);
  /** The three vertex slots each face uses. */
  const faceSlots: number[][] = [];

  for (let f = 0; f < faceCount; f++) {
    const a = f * 3;
    const b = f * 3 + 1;
    const c = f * 3 + 2;
    faceSlots.push([a, b, c]);

    const ax = positions[a * 3] ?? 0;
    const ay = positions[a * 3 + 1] ?? 0;
    const az = positions[a * 3 + 2] ?? 0;
    const ux = (positions[b * 3] ?? 0) - ax;
    const uy = (positions[b * 3 + 1] ?? 0) - ay;
    const uz = (positions[b * 3 + 2] ?? 0) - az;
    const vx = (positions[c * 3] ?? 0) - ax;
    const vy = (positions[c * 3 + 1] ?? 0) - ay;
    const vz = (positions[c * 3 + 2] ?? 0) - az;

    // Twice the area, times the unit normal -- exactly what a cross product is,
    // and exactly the weighting wanted, so it is used unmodified.
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    faceNormal[f * 3] = nx;
    faceNormal[f * 3 + 1] = ny;
    faceNormal[f * 3 + 2] = nz;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      faceUnit[f * 3] = nx / len;
      faceUnit[f * 3 + 1] = ny / len;
      faceUnit[f * 3 + 2] = nz / len;
    }
  }

  /** Which faces touch each welded position, and at which of their slots. */
  const atPosition = new Map<string, { face: number; slot: number }[]>();
  for (let f = 0; f < faceCount; f++) {
    for (const slot of faceSlots[f] ?? []) {
      const key = weldKey(
        positions[slot * 3] ?? 0,
        positions[slot * 3 + 1] ?? 0,
        positions[slot * 3 + 2] ?? 0,
      );
      const list = atPosition.get(key);
      if (list) list.push({ face: f, slot });
      else atPosition.set(key, [{ face: f, slot }]);
    }
  }

  for (const incident of atPosition.values()) {
    /** One smoothing group: the faces in it, and their summed normal. */
    const groups: { sum: [number, number, number]; unit: [number, number, number]; slots: number[] }[] = [];

    for (const { face, slot } of incident) {
      const ux = faceUnit[face * 3] ?? 0;
      const uy = faceUnit[face * 3 + 1] ?? 0;
      const uz = faceUnit[face * 3 + 2] ?? 0;
      // A degenerate triangle has no direction to compare, so it contributes
      // nothing rather than dragging a group toward zero.
      const degenerate = ux === 0 && uy === 0 && uz === 0;

      let joined = groups.find((g) => !degenerate && g.unit[0] * ux + g.unit[1] * uy + g.unit[2] * uz >= creaseCos);
      if (!joined) {
        joined = { sum: [0, 0, 0], unit: [ux, uy, uz], slots: [] };
        groups.push(joined);
      }
      joined.sum[0] += faceNormal[face * 3] ?? 0;
      joined.sum[1] += faceNormal[face * 3 + 1] ?? 0;
      joined.sum[2] += faceNormal[face * 3 + 2] ?? 0;
      const len = Math.hypot(joined.sum[0], joined.sum[1], joined.sum[2]);
      if (len > 0) {
        joined.unit = [joined.sum[0] / len, joined.sum[1] / len, joined.sum[2] / len];
      }
      joined.slots.push(slot);
    }

    for (const group of groups) {
      for (const slot of group.slots) {
        normals[slot * 3] = group.unit[0];
        normals[slot * 3 + 1] = group.unit[1];
        normals[slot * 3 + 2] = group.unit[2];
      }
    }
  }

  return normals;
}

// --- the wind's bend, applied to a normal ------------------------------------

/**
 * Rotate a vector by `angle` in the plane spanned by the wind direction and
 * world up, leaving whatever lies across the wind untouched.
 *
 * The reference for the GLSL below, and the same rotation the canopy slab's tilt
 * already performs on positions -- written once here so the two cannot drift.
 * `windX`/`windZ` are the wind's horizontal unit direction.
 */
export function rotateAboutWind(
  v: readonly [number, number, number],
  windX: number,
  windZ: number,
  angle: number,
): readonly [number, number, number] {
  const along = v[0] * windX + v[2] * windZ;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const delta = along * ca + v[1] * sa - along;
  return [v[0] + windX * delta, v[1] * ca - along * sa, v[2] + windZ * delta];
}

/**
 * The normal that goes with the wind's bend: the vertex normal rotated by the
 * same arc the vertex itself took.
 *
 * ## Why this is needed, and why nothing looks wrong without it
 *
 * The sway (spec 074) is a vertex-shader displacement and touches only position.
 * Under `flatShading` that is invisible, because three.js re-derives the face
 * normal per fragment from the derivatives of the *displaced* position -- the
 * lighting follows the bend for free, and `vNormal` is not even written. So this
 * has never been a visible bug, and turning it on alone changes nothing.
 *
 * It matters the moment normals are interpolated instead: then a leaning canopy
 * is lit as though it were still upright, and the tree bends while its shading
 * stands still. It is also what a normal buffer would have to be written from.
 *
 * ## The approximation
 *
 * A rigid rotation carries normals by the same rotation, which is what this
 * does. The trunk's bend is not rigid -- the angle grows with height, so it is a
 * bend rather than a turn, and being exact would mean the inverse transpose of
 * the displacement's Jacobian, including how fast the angle changes with height.
 * Rotating by the local angle and ignoring that term is the standard
 * approximation and is a fraction of a degree off at the strengths the weather
 * panel allows. For a canopy slab it is not an approximation at all: every
 * vertex of a slab carries the same bend weight, so the slab really does rotate
 * rigidly and this is exact.
 */
export function bendNormal(
  normal: readonly [number, number, number],
  windX: number,
  windZ: number,
  angle: number,
): readonly [number, number, number] {
  return rotateAboutWind(normal, windX, windZ, angle);
}

/**
 * The GLSL for the two functions above, for `sway.ts` to splice into a vertex
 * shader. Mirrors {@link rotateAboutWind} term for term; `sway.test.ts` holds
 * the two to the same numbers.
 *
 * `uWindDir` comes from the shared wind uniforms, so this depends on
 * `glslWindChunk()` having been emitted before it.
 */
export function glslBendNormalChunk(): string {
  return /* glsl */ `
// Rotate a vector by an angle in the (downwind, up) plane. Whatever lies across
// the wind is untouched. The same expression the canopy slab's tilt uses on
// positions, and the reference for it is rotateAboutWind in shading.ts.
vec3 rotateAboutWind(vec3 v, float angle) {
  float along = dot(v.xz, uWindDir);
  float ca = cos(angle);
  float sa = sin(angle);
  vec3 r = v;
  r.xz += uWindDir * (along * ca + v.y * sa - along);
  r.y = v.y * ca - along * sa;
  return r;
}
`;
}

// --- octahedral normal encoding (spec 096) -----------------------------------

/**
 * A unit normal packed into two values in [0, 1], for storage in two bytes of an
 * RGBA8 render target.
 *
 * Two channels rather than three, and RGBA8 rather than a float target, because
 * a float colour attachment needs `EXT_color_buffer_float` and a normal does not
 * need one: it has two degrees of freedom, so spending three channels on it is
 * paying for a redundancy. The octahedral mapping is the standard way to use
 * both of them evenly -- it folds the sphere onto an octahedron and unwraps that
 * into the unit square, which distributes the error far better than storing xy
 * and recovering z (that one loses the sign of z entirely, and this world is
 * seen from above at an angle where back-facing normals matter).
 *
 * The remaining two bytes are left alone here; the depth comes from a real depth
 * texture instead, so they are free for whatever step 5 onward wants.
 */
export function encodeOctahedral(
  normal: readonly [number, number, number],
): readonly [number, number] {
  const [x, y, z] = normal;
  const sum = Math.abs(x) + Math.abs(y) + Math.abs(z);
  // A zero normal has no direction to encode; the centre of the square decodes
  // to +z, which is as good an answer as any and better than a NaN.
  if (sum === 0) return [0.5, 0.5];

  let px = x / sum;
  let py = y / sum;
  if (z <= 0) {
    // The lower hemisphere folds outward across the octahedron's equator.
    const fx = (1 - Math.abs(py)) * (px >= 0 ? 1 : -1);
    const fy = (1 - Math.abs(px)) * (py >= 0 ? 1 : -1);
    px = fx;
    py = fy;
  }
  return [px * 0.5 + 0.5, py * 0.5 + 0.5];
}

/** The inverse of {@link encodeOctahedral}, returning a unit normal. */
export function decodeOctahedral(encoded: readonly [number, number]): readonly [number, number, number] {
  const fx = encoded[0] * 2 - 1;
  const fy = encoded[1] * 2 - 1;
  let x = fx;
  let y = fy;
  const z = 1 - Math.abs(fx) - Math.abs(fy);
  // Below the equator, unfold: the same operation as the encode's fold, which is
  // its own inverse.
  const t = Math.max(-z, 0);
  x += x >= 0 ? -t : t;
  y += y >= 0 ? -t : t;
  const len = Math.hypot(x, y, z);
  if (len === 0) return [0, 0, 1];
  return [x / len, y / len, z / len];
}

/**
 * The GLSL for the pair above, for the normal-writing material and for whatever
 * later pass reads the buffer back. Mirrors the TypeScript term for term;
 * `shading.test.ts` holds the two to the same numbers, because a normal that
 * decodes slightly wrong is an edge threshold that means something slightly
 * different everywhere.
 */
export function glslOctahedralChunk(): string {
  return /* glsl */ `
// Unit normal -> two channels in [0, 1]. See encodeOctahedral in shading.ts.
vec2 encodeOctahedral(vec3 n) {
  float sum = abs(n.x) + abs(n.y) + abs(n.z);
  if (sum == 0.0) return vec2(0.5);
  vec2 p = n.xy / sum;
  if (n.z <= 0.0) {
    p = (1.0 - abs(p.yx)) * vec2(p.x >= 0.0 ? 1.0 : -1.0, p.y >= 0.0 ? 1.0 : -1.0);
  }
  return p * 0.5 + 0.5;
}

// Two channels in [0, 1] -> unit normal.
vec3 decodeOctahedral(vec2 e) {
  vec2 f = e * 2.0 - 1.0;
  vec3 n = vec3(f.x, f.y, 1.0 - abs(f.x) - abs(f.y));
  float t = max(-n.z, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.y += n.y >= 0.0 ? -t : t;
  return normalize(n);
}
`;
}
