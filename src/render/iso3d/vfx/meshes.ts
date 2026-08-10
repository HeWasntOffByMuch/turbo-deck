/**
 * The solids particles are made of (spec 123).
 *
 * Pure -- arrays in, arrays out, no three.js. Generated rather than authored for
 * the reason every other asset here is: nothing may be fetched, and a shape
 * described by six numbers is a shape a test can hold to account.
 *
 * ## Why particles need geometry at all
 *
 * A billboard cannot intersect anything. Two of them at the same place are two
 * decals stacked up, which is exactly why the first fire and smoke read as
 * "particles" rather than as fire and smoke. Overlapping *solids* interpenetrate,
 * and a dozen semi-transparent ones read as a single churning mass -- that is the
 * whole of what makes smoke look like smoke at this resolution.
 *
 * ## One geometry, many orientations
 *
 * Every blob shares one mesh. The variety comes from a per-instance tumble
 * hashed out of the particle's seed, not from a mesh each -- a hundred distinct
 * lumpy spheres would be a hundred draw calls, and at this resolution nobody can
 * tell them from one sphere seen from a hundred angles.
 */

export interface MeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint16Array;
}

export type MeshShape = 'blob' | 'tongue';

/** A tiny deterministic hash, so a shape is a pure function of its seed. */
function hash(index: number, seed: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x27d4eb2d)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) & 0xffff) / 0xffff;
}

/** The twelve vertices of a unit icosahedron, and its twenty faces. */
function icosahedron(): { positions: number[]; indices: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const positions: number[] = [];
  for (const [x, y, z] of raw) {
    const length = Math.sqrt((x ?? 0) ** 2 + (y ?? 0) ** 2 + (z ?? 0) ** 2);
    positions.push((x ?? 0) / length, (y ?? 0) / length, (z ?? 0) / length);
  }
  const indices = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];
  return { positions, indices };
}

/**
 * A lumpy low-poly sphere: the smoke and dust blob.
 *
 * Subdivided from an icosahedron and then pushed in and out per vertex, so the
 * silhouette has corners in it. A smooth sphere reads as a ball; the lumps are
 * what make a cluster of these read as smoke.
 *
 * Flat-shaded on purpose -- the vertices are not shared between faces, which is
 * what gives the facets the rest of this renderer has (`flatShading` is on every
 * material in the scene) and what lets a blob catch light in planes.
 */
export function blobMesh(subdivisions = 1, lumpiness = 0.22, seed = 1337): MeshData {
  const base = icosahedron();
  let positions = base.positions;
  let indices = base.indices;

  for (let step = 0; step < Math.max(0, Math.min(2, subdivisions)); step++) {
    const next: number[] = [];
    const midpoints = new Map<string, number>();
    const vertex = (index: number): [number, number, number] => [
      positions[index * 3] ?? 0,
      positions[index * 3 + 1] ?? 0,
      positions[index * 3 + 2] ?? 0,
    ];
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const found = midpoints.get(key);
      if (found !== undefined) return found;
      const [ax, ay, az] = vertex(a);
      const [bx, by, bz] = vertex(b);
      let mx = (ax + bx) / 2;
      let my = (ay + by) / 2;
      let mz = (az + bz) / 2;
      const length = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
      mx /= length;
      my /= length;
      mz /= length;
      const index = positions.length / 3;
      positions.push(mx, my, mz);
      midpoints.set(key, index);
      return index;
    };
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] ?? 0;
      const b = indices[i + 1] ?? 0;
      const c = indices[i + 2] ?? 0;
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    indices = next;
  }

  // The lumps, per vertex and deterministic in the seed.
  const radii: number[] = [];
  for (let i = 0; i < positions.length / 3; i++) {
    radii.push(1 + (hash(i, seed) * 2 - 1) * lumpiness);
  }
  positions = positions.map((value, i) => value * (radii[Math.floor(i / 3)] ?? 1));

  return unshare(positions, indices);
}

/**
 * A flame tongue: round and wide at the base, pinched at the waist, tapering to
 * a point, and twisted a little on the way up.
 *
 * A lathe rather than a blob because a flame's silhouette is the whole read --
 * the reference calls it "stacked flame tongues, clear silhouette" -- and a
 * silhouette needs a profile somebody chose rather than noise.
 */
export function tongueMesh(radialSegments = 7, rings = 6, seed = 991): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const segments = Math.max(3, radialSegments);
  const levels = Math.max(3, rings);

  // A lean that grows toward the tip: a flame's point wanders.
  const leanAt = (t: number): number => t * t * 0.16;

  // The rings that have a radius. The tip is a single apex vertex rather than a
  // ring of coincident ones, because a ring of radius zero is `segments`
  // degenerate triangles that shade as black slivers.
  for (let ring = 0; ring < levels - 1; ring++) {
    // 0 at the base, 1 at the tip.
    const t = ring / (levels - 1);
    // Shoulders just above the base -- the widest part of a flame is low, and a
    // shape that bulges near the top reads as a balloon on a stick.
    const shoulder = 0.65 + 0.35 * Math.sqrt(Math.min(1, t / 0.22));
    const taper = (1 - t) ** 0.75;
    const pinch = 1 - 0.3 * Math.exp(-((t - 0.34) ** 2) / 0.016);
    const radius = shoulder * taper * pinch * 0.5;
    // A slow twist, so two tongues side by side do not read as one extrusion.
    const twist = t * 0.55 + hash(ring, seed) * 0.12;
    const lean = leanAt(t);

    for (let segment = 0; segment < segments; segment++) {
      const angle = (segment / segments) * Math.PI * 2 + twist;
      // Per-ring radial wobble, so the outline is not a circle at any height.
      const wobble = 1 + (hash(ring * 31 + segment, seed) * 2 - 1) * 0.16;
      positions.push(Math.cos(angle) * radius * wobble + lean, t, Math.sin(angle) * radius * wobble);
    }
  }

  const apex = positions.length / 3;
  positions.push(leanAt(1), 1, 0);

  for (let ring = 0; ring < levels - 2; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const next = (segment + 1) % segments;
      const a = ring * segments + segment;
      const b = ring * segments + next;
      const c = (ring + 1) * segments + segment;
      const d = (ring + 1) * segments + next;
      indices.push(a, c, b, b, c, d);
    }
  }

  // The fan into the point.
  const last = (levels - 2) * segments;
  for (let segment = 0; segment < segments; segment++) {
    indices.push(last + segment, apex, last + ((segment + 1) % segments));
  }

  // Close the base so a tongue is a solid rather than a tube.
  const centre = positions.length / 3;
  positions.push(0, 0, 0);
  for (let segment = 0; segment < segments; segment++) {
    indices.push(centre, (segment + 1) % segments, segment);
  }

  return unshare(positions, indices);
}

/**
 * Split shared vertices so every triangle has its own, and give each its face
 * normal.
 *
 * Flat shading is the house style (`flatShading` is on every material in this
 * scene), and it is also what makes these read: a smooth-shaded blob is a ball,
 * and a faceted one catches light in planes the way the terrain and the trees do.
 */
function unshare(positions: readonly number[], indices: readonly number[]): MeshData {
  const count = indices.length;
  const outPositions = new Float32Array(count * 3);
  const outNormals = new Float32Array(count * 3);
  const outIndices = new Uint16Array(count);

  for (let i = 0; i < count; i += 3) {
    const ia = (indices[i] ?? 0) * 3;
    const ib = (indices[i + 1] ?? 0) * 3;
    const ic = (indices[i + 2] ?? 0) * 3;
    const ax = positions[ia] ?? 0;
    const ay = positions[ia + 1] ?? 0;
    const az = positions[ia + 2] ?? 0;
    const bx = positions[ib] ?? 0;
    const by = positions[ib + 1] ?? 0;
    const bz = positions[ib + 2] ?? 0;
    const cx = positions[ic] ?? 0;
    const cy = positions[ic + 1] ?? 0;
    const cz = positions[ic + 2] ?? 0;

    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;

    for (let corner = 0; corner < 3; corner++) {
      const at = (i + corner) * 3;
      const from = corner === 0 ? ia : corner === 1 ? ib : ic;
      outPositions[at] = positions[from] ?? 0;
      outPositions[at + 1] = positions[from + 1] ?? 0;
      outPositions[at + 2] = positions[from + 2] ?? 0;
      outNormals[at] = nx;
      outNormals[at + 1] = ny;
      outNormals[at + 2] = nz;
      outIndices[i + corner] = i + corner;
    }
  }

  return { positions: outPositions, normals: outNormals, indices: outIndices };
}

/** Every shape, built once and shared. */
const CACHE = new Map<MeshShape, MeshData>();

export function particleMesh(shape: MeshShape): MeshData {
  const cached = CACHE.get(shape);
  if (cached) return cached;
  const made = shape === 'tongue' ? tongueMesh() : blobMesh();
  CACHE.set(shape, made);
  return made;
}
