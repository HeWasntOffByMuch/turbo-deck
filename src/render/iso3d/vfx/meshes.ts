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

export type MeshShape =
  | 'blob'
  | 'tongue'
  | 'rune-ring'
  | 'rune-ring-thin'
  | 'diamond'
  | 'shaft'
  | 'shard'
  | 'starburst'
  | 'chunk'
  | 'ring';

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
 * The sigil an aura is drawn as (spec 124): a flat ring in the XZ plane, at unit
 * outer radius, with an outer band, an inner band, and rune marks between them.
 *
 * Flat and unshaded on purpose. This is ink on the ground, not an object lying on
 * it: the moment it catches light from the side it stops reading as a drawn
 * symbol and starts reading as a hoop somebody dropped.
 *
 * The runes are blocks rather than glyphs, and that is a resolution decision
 * rather than a shortcut. A forty-unit ring is about forty pixels across at
 * 480x270, which leaves two or three pixels per mark -- a letterform is mush at
 * that size and a bar with a gap beside it is legible. `pixel-font.ts` reached
 * the same conclusion for text and settled on 5x7.
 */
export function runeRingMesh(runes = 12, thin = false, seed = 7717): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const segments = 40;

  /** One flat quad, wound so its normal is +Y. */
  const quad = (
    ax: number, az: number, bx: number, bz: number,
    cx: number, cz: number, dx: number, dz: number,
  ): void => {
    const at = positions.length / 3;
    positions.push(ax, 0, az, bx, 0, bz, cx, 0, cz, dx, 0, dz);
    indices.push(at, at + 2, at + 1, at, at + 3, at + 2);
  };

  /** An annulus, as `segments` quads. */
  const band = (inner: number, outer: number): void => {
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const b = ((i + 1) / segments) * Math.PI * 2;
      quad(
        Math.cos(a) * inner, Math.sin(a) * inner,
        Math.cos(b) * inner, Math.sin(b) * inner,
        Math.cos(b) * outer, Math.sin(b) * outer,
        Math.cos(a) * outer, Math.sin(a) * outer,
      );
    }
  };

  /** A block spanning `[inner, outer]` radially and `span` radians across. */
  const mark = (angle: number, inner: number, outer: number, span: number): void => {
    const a = angle - span / 2;
    const b = angle + span / 2;
    quad(
      Math.cos(a) * inner, Math.sin(a) * inner,
      Math.cos(b) * inner, Math.sin(b) * inner,
      Math.cos(b) * outer, Math.sin(b) * outer,
      Math.cos(a) * outer, Math.sin(a) * outer,
    );
  };

  // `thin` means *fewer marks and a lighter ring*, not a thinner line. The first
  // cut made the bands half as wide and the smallest aura came out as a dashed
  // ellipse: at radius 34 that band is a world unit and a bit, and the
  // foreshortened near and far edges of the ellipse fall under one pixel.
  band(thin ? 0.945 : 0.92, 1);
  band(thin ? 0.7 : 0.665, 0.75);

  // The marks, deterministic in the seed but not identical to each other -- a
  // ring of twelve identical ticks is a clock face.
  const count = Math.max(1, Math.round(runes));
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const roll = hash(i, seed);
    if (roll < 0.34) {
      // A long bar across the whole gap.
      mark(angle, 0.77, 0.9, 0.055);
    } else if (roll < 0.67) {
      // Two short bars, one against each band.
      mark(angle, 0.77, 0.82, 0.075);
      mark(angle, 0.85, 0.9, 0.075);
    } else {
      // A bar with a pip outside it.
      mark(angle, 0.77, 0.86, 0.05);
      mark(angle + 0.055, 0.875, 0.9, 0.03);
    }
  }

  return unshare(positions, indices);
}

/**
 * The diamonds that float above a sigil: an octahedron, taller than it is wide.
 *
 * Eight triangles, which at this size is as much shape as survives the
 * quantizer, and the four facets a lit octahedron shows are what make it read as
 * a solid turning rather than as a lozenge sliding about.
 */
export function diamondMesh(height = 1.35): MeshData {
  const positions = [
    0, height, 0,
    0, -height, 0,
    1, 0, 0,
    0, 0, 1,
    -1, 0, 0,
    0, 0, -1,
  ];
  const indices: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = 2 + i;
    const b = 2 + ((i + 1) % 4);
    indices.push(0, a, b, 1, b, a);
  }
  return unshare(positions, indices);
}

/**
 * A shaft of light: a spike standing on the origin, one unit tall, tapering to a
 * point.
 *
 * Not a beam with a flat top. A shaft that ends abruptly reads as a post, and
 * per-instance alpha is one number for the whole solid, so the *only* place the
 * fade at the top can come from is the silhouette narrowing.
 */
export function shaftMesh(sides = 5, baseRadius = 0.045): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const count = Math.max(3, sides);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    positions.push(Math.cos(angle) * baseRadius, 0, Math.sin(angle) * baseRadius);
  }
  const apex = count;
  positions.push(0, 1, 0);
  const centre = count + 1;
  positions.push(0, 0, 0);
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    indices.push(i, apex, next);
    indices.push(centre, next, i);
  }
  return unshare(positions, indices);
}

/**
 * A wavefront (spec 126): a plain flat annulus in the XZ plane, unit outer radius.
 *
 * Not `rune-ring`. That one has two bands and a ring of marks between them,
 * which is a *symbol*; this is the edge of something travelling. The width is
 * proportional, so a bigger instance is a thicker ring -- which is what the
 * reference shows, a leading edge that fattens as it spreads.
 */
export function ringMesh(width = 0.07, segments = 56): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const count = Math.max(8, segments);
  const inner = Math.max(0.02, 1 - width);

  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const b = ((i + 1) / count) * Math.PI * 2;
    const at = positions.length / 3;
    positions.push(
      Math.cos(a) * inner, 0, Math.sin(a) * inner,
      Math.cos(b) * inner, 0, Math.sin(b) * inner,
      Math.cos(b), 0, Math.sin(b),
      Math.cos(a), 0, Math.sin(a),
    );
    indices.push(at, at + 2, at + 1, at, at + 3, at + 2);
  }
  return unshare(positions, indices);
}

/**
 * The spike a burst is made of (spec 125): a short back pyramid, a waist, and a
 * long taper to a point at +Y.
 *
 * Authored along +Y and used velocity-aligned, so a shard thrown out of a centre
 * points the way it went and `size` is how far it reaches. The back pyramid is
 * what keeps the inner end from being a flat lid -- in the reference every spike
 * converges on the middle of the star, and a lid there reads as a plate.
 */
export function shardMesh(sides = 4, back = 0.14, waist = 0.06): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const count = Math.max(3, sides);

  const tail = 0;
  positions.push(0, tail, 0);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    positions.push(Math.cos(angle) * waist, back, Math.sin(angle) * waist);
  }
  const tip = count + 1;
  positions.push(0, 1, 0);

  for (let i = 0; i < count; i++) {
    const a = 1 + i;
    const b = 1 + ((i + 1) % count);
    // The back cone, then the long one.
    indices.push(0, b, a);
    indices.push(a, b, tip);
  }
  return unshare(positions, indices);
}

/**
 * The white-hot middle of a burst: spikes fused into a ball.
 *
 * One mesh rather than an emitter of shards, because the core in the reference
 * is a single object whose points all meet -- and because a dozen particles at
 * the same place, each with its own alpha, is a bright smear rather than a star.
 *
 * The directions come off a Fibonacci lattice, which is the cheap way to get
 * points that are actually spread over a sphere. Random ones bunch, and a bunched
 * star has a bald patch that reads as a mistake at any resolution.
 */
export function starburstMesh(spikes = 11, seed = 4093): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const count = Math.max(4, spikes);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const core = 0.22;

  for (let i = 0; i < count; i++) {
    // Even in y, spiralled in longitude: the lattice.
    const y = 1 - (i / (count - 1)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const dx = Math.cos(theta) * ring;
    const dz = Math.sin(theta) * ring;

    // A basis about the spike, so its three base corners sit around it.
    const ax = Math.abs(y) < 0.9 ? 0 : 1;
    let ux = ax === 0 ? -dz : 0;
    let uy = ax === 0 ? 0 : -dz;
    let uz = ax === 0 ? dx : y;
    const ulen = Math.hypot(ux, uy, uz) || 1;
    ux /= ulen;
    uy /= ulen;
    uz /= ulen;
    const vx = y * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - y * ux;

    // Spikes of two lengths, so the silhouette is not a sea urchin.
    const reach = hash(i, seed) < 0.4 ? 0.55 : 1;
    const base = positions.length / 3;
    for (let corner = 0; corner < 3; corner++) {
      const angle = (corner / 3) * Math.PI * 2;
      const cos = Math.cos(angle) * core;
      const sin = Math.sin(angle) * core;
      positions.push(dx * core + ux * cos + vx * sin, y * core + uy * cos + vy * sin, dz * core + uz * cos + vz * sin);
    }
    positions.push(dx * reach, y * reach, dz * reach);
    indices.push(base, base + 1, base + 3, base + 1, base + 2, base + 3, base + 2, base, base + 3);
  }
  return unshare(positions, indices);
}

/**
 * A rock thrown clear of a burst: an icosahedron pushed about hard.
 *
 * The blob's shape with none of its subdivision and three times its jitter --
 * twenty faces, and a radius that varies enough that no two silhouettes of it
 * look alike. A smooth one is a pebble, and pebbles do not read as broken ground.
 */
export function chunkMesh(seed = 5501): MeshData {
  const base = icosahedron();
  const positions = base.positions.map((value, i) => value * (0.55 + hash(Math.floor(i / 3), seed) * 0.75));
  return unshare(positions, base.indices);
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
  const made = build(shape);
  CACHE.set(shape, made);
  return made;
}

function build(shape: MeshShape): MeshData {
  switch (shape) {
    case 'tongue':
      return tongueMesh();
    case 'rune-ring':
      return runeRingMesh(12, false);
    // A separate shape rather than a parameter, because the cache is keyed by
    // shape and the batch key is the shape: a thin ring that shared 'rune-ring'
    // would silently be whichever of the two was built first.
    case 'rune-ring-thin':
      return runeRingMesh(8, true);
    case 'diamond':
      return diamondMesh();
    case 'shaft':
      return shaftMesh();
    case 'shard':
      return shardMesh();
    case 'starburst':
      return starburstMesh();
    case 'chunk':
      return chunkMesh();
    case 'ring':
      return ringMesh();
    default:
      return blobMesh();
  }
}

/**
 * How an instance of a shape is turned (spec 124).
 *
 * A property of the *shape*, because it follows from what the shape is: smoke
 * may lie however it likes, a flame stands up, and a sigil must sit at exactly
 * the angle it was given -- a per-seed jitter on a ring puts its runes somewhere
 * different every time one is stamped.
 */
export const ORIENT = { tumble: 0, uprightJittered: 1, exact: 2, velocity: 3 } as const;

export function orientOf(shape: MeshShape): number {
  switch (shape) {
    case 'tongue':
    case 'shaft':
      return ORIENT.uprightJittered;
    case 'rune-ring':
    case 'rune-ring-thin':
    case 'ring':
      return ORIENT.exact;
    case 'shard':
      return ORIENT.velocity;
    default:
      return ORIENT.tumble;
  }
}

/** Whether a shape is lit, or drawn as its own flat colour. Light is not shaded. */
export function shadedShape(shape: MeshShape): boolean {
  // The burst's crystal *is* faceted in the reference -- one face of a spike
  // catches the light and the next does not, and that two-tone is most of what
  // makes it read as a solid rather than as a painted ray.
  return shape === 'blob' || shape === 'diamond' || shape === 'shard' || shape === 'starburst' || shape === 'chunk';
}

/**
 * Whether a shape is brightest where it meets its own origin (spec 125).
 *
 * The burst's spikes are yellow-white where they converge and red at the tips,
 * and that gradient runs along the *geometry*. A colour curve cannot say it: a
 * ramp over a particle's life makes every spike in a fan the same colour at the
 * same moment, which is a fan of identical darts rather than one crystal.
 */
export function coreGlowShape(shape: MeshShape): boolean {
  return shape === 'shard' || shape === 'starburst';
}

/** Whether a shape's batch needs the particle's velocity uploaded (spec 125). */
export function needsVelocity(shape: MeshShape): boolean {
  return orientOf(shape) === ORIENT.velocity;
}
