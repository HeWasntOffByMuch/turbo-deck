import { describe, expect, it } from 'vitest';
import {
  blobMesh,
  chunkMesh,
  diamondMesh,
  ORIENT,
  orientOf,
  particleMesh,
  ringMesh,
  runeRingMesh,
  MARK_REACH,
  needsVelocity,
  shadedShape,
  strokeRootOf,
  shaftMesh,
  shardMesh,
  starburstMesh,
  tongueMesh,
  type MeshData,
  type MeshShape,
} from './meshes.js';
import { BRUSH_SHAPES } from './meshes.js';
import { STROKE_CENTRE_SHIFT, STROKE_UV_STRIDE } from './stroke.js';
import { depthOrder } from './depth-sort.js';
import { REGISTRY } from './registry.js';
import { FAMILY, familyOf, RENDER } from './compile.js';
import { modeCode } from './batches.js';

/** Every triangle, as nine numbers. */
function triangles(mesh: MeshData): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const corner = (n: number): [number, number, number] => {
      const at = (mesh.indices[i + n] ?? 0) * 3;
      return [mesh.positions[at] ?? 0, mesh.positions[at + 1] ?? 0, mesh.positions[at + 2] ?? 0];
    };
    out.push([...corner(0), ...corner(1), ...corner(2)]);
  }
  return out;
}

function area(t: number[]): number {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = t as [
    number, number, number, number, number, number, number, number, number,
  ];
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
}

const SHAPES: [string, () => MeshData][] = [
  ['blob', () => blobMesh()],
  ['tongue', () => tongueMesh()],
  ['rune-ring', () => runeRingMesh()],
  ['diamond', () => diamondMesh()],
  ['shaft', () => shaftMesh()],
  ['shard', () => shardMesh()],
  ['starburst', () => starburstMesh()],
  ['chunk', () => chunkMesh()],
  ['ring', () => ringMesh()],
];

describe('the geometry is closed and sane', () => {
  for (const [name, build] of SHAPES) {
    it(`${name}: every index is in range and the arrays agree`, () => {
      const mesh = build();
      expect(mesh.indices.length % 3).toBe(0);
      expect(mesh.indices.length).toBeGreaterThan(0);
      expect(mesh.positions.length).toBe(mesh.normals.length);
      const vertices = mesh.positions.length / 3;
      for (const index of mesh.indices) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(vertices);
      }
      // Every vertex is drawn. `unshare` splits per triangle, so an unreferenced
      // one means a face went missing on the way out.
      const seen = new Set(mesh.indices);
      expect(seen.size).toBe(vertices);
    });

    it(`${name}: no degenerate triangles`, () => {
      for (const triangle of triangles(build())) {
        expect(area(triangle)).toBeGreaterThan(1e-6);
      }
    });

    it(`${name}: normals are unit length`, () => {
      const mesh = build();
      for (let i = 0; i < mesh.normals.length; i += 3) {
        const x = mesh.normals[i] ?? 0;
        const y = mesh.normals[i + 1] ?? 0;
        const z = mesh.normals[i + 2] ?? 0;
        expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(1, 5);
      }
    });

    it(`${name}: the same seed gives byte-identical geometry`, () => {
      const a = build();
      const b = build();
      expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
      expect(Array.from(a.normals)).toEqual(Array.from(b.normals));
      expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
    });
  }

  it('a face normal points the way the winding says it does', () => {
    // Checked on the blob, where "outward" is unambiguous: a convex-ish hull
    // around the origin, so the normal and the centroid must agree.
    const mesh = blobMesh();
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const t = triangles(mesh)[i / 3] as number[];
      const cx = ((t[0] ?? 0) + (t[3] ?? 0) + (t[6] ?? 0)) / 3;
      const cy = ((t[1] ?? 0) + (t[4] ?? 0) + (t[7] ?? 0)) / 3;
      const cz = ((t[2] ?? 0) + (t[5] ?? 0) + (t[8] ?? 0)) / 3;
      const at = (mesh.indices[i] ?? 0) * 3;
      const dot = cx * (mesh.normals[at] ?? 0) + cy * (mesh.normals[at + 1] ?? 0) + cz * (mesh.normals[at + 2] ?? 0);
      expect(dot).toBeGreaterThan(0);
    }
  });
});

describe('the blob', () => {
  it('stays inside its lumpiness bound', () => {
    const lumpiness = 0.22;
    const mesh = blobMesh(1, lumpiness, 1337);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] ?? 0;
      const y = mesh.positions[i + 1] ?? 0;
      const z = mesh.positions[i + 2] ?? 0;
      const radius = Math.sqrt(x * x + y * y + z * z);
      expect(radius).toBeGreaterThanOrEqual(1 - lumpiness - 1e-6);
      expect(radius).toBeLessThanOrEqual(1 + lumpiness + 1e-6);
    }
  });

  it('is actually lumpy -- a sphere would read as a ball', () => {
    const mesh = blobMesh(1, 0.22, 1337);
    const radii: number[] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] ?? 0;
      const y = mesh.positions[i + 1] ?? 0;
      const z = mesh.positions[i + 2] ?? 0;
      radii.push(Math.sqrt(x * x + y * y + z * z));
    }
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(0.15);
  });

  it('a different seed is a different blob', () => {
    const a = blobMesh(1, 0.22, 1);
    const b = blobMesh(1, 0.22, 2);
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions));
  });

  it('stays inside a Uint16 index and a sane triangle count', () => {
    const mesh = blobMesh();
    expect(mesh.positions.length / 3).toBeLessThan(65536);
    // 20 faces subdivided once. Any more and every smoke puff costs four times
    // what it needs to at 480x270.
    expect(mesh.indices.length / 3).toBe(80);
  });
});

describe('the tongue points up', () => {
  const mesh = tongueMesh();

  it('its highest vertex is on the axis, so a flame has a tip', () => {
    let topY = -Infinity;
    let topR = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const y = mesh.positions[i + 1] ?? 0;
      if (y <= topY) continue;
      topY = y;
      const x = mesh.positions[i] ?? 0;
      const z = mesh.positions[i + 2] ?? 0;
      topR = Math.sqrt(x * x + z * z);
    }
    expect(topY).toBeCloseTo(1, 5);
    // The lean carries the tip sideways; what matters is that it is a point and
    // not a ring, so the radius about its own centre is nil.
    expect(topR).toBeLessThan(0.2);
  });

  it('sits on the ground and is a unit tall, so size means height', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 1; i < mesh.positions.length; i += 3) {
      const y = mesh.positions[i] ?? 0;
      min = Math.min(min, y);
      max = Math.max(max, y);
    }
    expect(min).toBeCloseTo(0, 5);
    expect(max).toBeCloseTo(1, 5);
  });

  it('is widest low down and narrows on the way up', () => {
    // Width per tenth of the height, measured as horizontal *extent* rather than
    // distance from the axis, because the tongue leans and a radius about the
    // origin would read the lean as girth. A flame whose bulge is at the top
    // reads as a balloon on a stick.
    const spans = Array.from({ length: 10 }, () => ({
      minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity,
    }));
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] ?? 0;
      const y = mesh.positions[i + 1] ?? 0;
      const z = mesh.positions[i + 2] ?? 0;
      const span = spans[Math.min(9, Math.max(0, Math.floor(y * 10)))];
      if (!span) continue;
      span.minX = Math.min(span.minX, x);
      span.maxX = Math.max(span.maxX, x);
      span.minZ = Math.min(span.minZ, z);
      span.maxZ = Math.max(span.maxZ, z);
    }
    const bands = spans.map((s) =>
      s.maxX === -Infinity ? 0 : Math.max(s.maxX - s.minX, s.maxZ - s.minZ),
    );
    const widest = bands.indexOf(Math.max(...bands));
    expect(widest).toBeLessThanOrEqual(3);
    expect(bands[9] ?? 0).toBeLessThan((bands[widest] ?? 0) * 0.5);
  });

  it('has a closed base rather than an open tube', () => {
    // The cap: triangles every vertex of which is at y = 0.
    const capped = triangles(mesh).filter(
      (t) => (t[1] ?? 1) < 1e-6 && (t[4] ?? 1) < 1e-6 && (t[7] ?? 1) < 1e-6,
    );
    expect(capped.length).toBeGreaterThan(0);
  });
});

describe('the sigil', () => {
  const mesh = runeRingMesh(12, false);

  it('is flat on the ground, and its normals all point up', () => {
    // Ink on the ground, not an object lying on it. A vertex off the plane
    // catches the key light from the side and the whole thing stops reading as
    // a drawn symbol.
    for (let i = 1; i < mesh.positions.length; i += 3) {
      expect(mesh.positions[i] ?? 1).toBe(0);
    }
    for (let i = 0; i < mesh.normals.length; i += 3) {
      expect(Math.abs(mesh.normals[i + 1] ?? 0)).toBeCloseTo(1, 5);
      expect(mesh.normals[i] ?? 1).toBeCloseTo(0, 5);
      expect(mesh.normals[i + 2] ?? 1).toBeCloseTo(0, 5);
    }
  });

  it('reaches unit radius and no further, so size means diameter', () => {
    let max = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] ?? 0;
      const z = mesh.positions[i + 2] ?? 0;
      max = Math.max(max, Math.sqrt(x * x + z * z));
    }
    expect(max).toBeCloseTo(1, 5);
  });

  it('has an outer band, an inner band, and marks in the gap', () => {
    // The three things that make it a sigil rather than a hoop. Measured as
    // "some geometry lives at this radius", which is what the eye reads.
    const at = (radius: number): boolean => {
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const x = mesh.positions[i] ?? 0;
        const z = mesh.positions[i + 2] ?? 0;
        if (Math.abs(Math.sqrt(x * x + z * z) - radius) < 0.02) return true;
      }
      return false;
    };
    // Vertex radii, not covered radii -- a quad band has no vertices in its own
    // middle, so these are its two edges.
    expect(at(1)).toBe(true);
    expect(at(0.92)).toBe(true);
    expect(at(0.75)).toBe(true);
    expect(at(0.665)).toBe(true);
    expect(at(0.77)).toBe(true);
    expect(at(0.9)).toBe(true);
    // And nothing in the middle: a filled disc would be a puddle, not a sigil.
    expect(at(0.4)).toBe(false);
    expect(at(0.05)).toBe(false);
  });

  it('spaces its marks evenly around the circle', () => {
    const runes = 9;
    const marked = runeRingMesh(runes, false);
    // Angles of everything in the gap between the bands, rounded to a degree.
    const angles = new Set<number>();
    for (let i = 0; i < marked.positions.length; i += 3) {
      const x = marked.positions[i] ?? 0;
      const z = marked.positions[i + 2] ?? 0;
      const radius = Math.sqrt(x * x + z * z);
      // Strictly between the bands, so only the marks are counted.
      if (radius < 0.76 || radius > 0.915) continue;
      angles.add(Math.round((Math.atan2(z, x) * 180) / Math.PI));
    }
    // Cluster into groups separated by more than the widest mark.
    const sorted = [...angles].sort((a, b) => a - b);
    let clusters = 0;
    let previous = -Infinity;
    for (const angle of sorted) {
      if (angle - previous > 12) clusters += 1;
      previous = angle;
    }
    expect(clusters).toBe(runes);
  });

  it('gets thinner bands and fewer marks when asked', () => {
    const thin = runeRingMesh(8, true);
    expect(thin.indices.length).toBeLessThan(mesh.indices.length);
  });
});

describe('the diamond and the shaft', () => {
  it('the diamond is a closed octahedron, taller than it is wide', () => {
    const mesh = diamondMesh();
    expect(mesh.indices.length / 3).toBe(8);
    let maxY = 0;
    let maxX = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      maxX = Math.max(maxX, Math.abs(mesh.positions[i] ?? 0));
      maxY = Math.max(maxY, Math.abs(mesh.positions[i + 1] ?? 0));
    }
    expect(maxY).toBeGreaterThan(maxX);
  });

  it('the shaft stands on the origin and tapers to a point', () => {
    const mesh = shaftMesh();
    let top = -Infinity;
    let topR = Infinity;
    let base = Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] ?? 0;
      const y = mesh.positions[i + 1] ?? 0;
      const z = mesh.positions[i + 2] ?? 0;
      base = Math.min(base, y);
      if (y > top) {
        top = y;
        topR = Math.sqrt(x * x + z * z);
      }
    }
    expect(base).toBe(0);
    expect(top).toBe(1);
    // A flat top would read as a post rather than as light: per-instance alpha
    // is one number for the whole solid, so the silhouette is the only fade.
    expect(topR).toBeCloseTo(0, 6);
  });
});

describe('the burst crystal', () => {
  it('the shard is a spike pointing at +Y, so size is reach', () => {
    const mesh = shardMesh();
    let top = -Infinity;
    let topR = 0;
    let base = Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] ?? 0;
      const y = mesh.positions[i + 1] ?? 0;
      const z = mesh.positions[i + 2] ?? 0;
      base = Math.min(base, y);
      if (y > top) {
        top = y;
        topR = Math.sqrt(x * x + z * z);
      }
    }
    expect(base).toBe(0);
    expect(top).toBe(1);
    expect(topR).toBeCloseTo(0, 6);
  });

  it('the shard is widest near its base, so it tapers rather than swells', () => {
    const mesh = shardMesh(4, 0.2, 0.11);
    let widestAt = 0;
    let widest = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] ?? 0;
      const y = mesh.positions[i + 1] ?? 0;
      const z = mesh.positions[i + 2] ?? 0;
      const radius = Math.sqrt(x * x + z * z);
      if (radius <= widest) continue;
      widest = radius;
      widestAt = y;
    }
    expect(widestAt).toBeLessThan(0.35);
    expect(widest).toBeCloseTo(0.11, 5);
  });

  it('the starburst is spiky rather than round', () => {
    const mesh = starburstMesh();
    let near = Infinity;
    let far = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const radius = Math.hypot(mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0);
      near = Math.min(near, radius);
      far = Math.max(far, radius);
    }
    expect(far / near).toBeGreaterThan(3);
    expect(far).toBeCloseTo(1, 5);
  });

  it('spreads its spikes over the sphere rather than bunching them', () => {
    // A lattice, not random directions. Random ones cluster, and a cluster
    // leaves a bald patch that reads as a mistake at any resolution.
    const mesh = starburstMesh(11);
    const tips: [number, number, number][] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i] ?? 0;
      const y = mesh.positions[i + 1] ?? 0;
      const z = mesh.positions[i + 2] ?? 0;
      const radius = Math.hypot(x, y, z);
      if (radius < 0.5) continue;
      tips.push([x / radius, y / radius, z / radius]);
    }
    expect(tips.length).toBeGreaterThan(0);
    for (let i = 0; i < tips.length; i++) {
      for (let j = i + 1; j < tips.length; j++) {
        const a = tips[i] as [number, number, number];
        const b = tips[j] as [number, number, number];
        const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        // Vertices of the *same* spike share a direction; different spikes must
        // not. 0.999 separates the two without a magic angle.
        if (dot > 0.999) continue;
        expect(dot).toBeLessThan(0.9);
      }
    }
  });

  it('the chunk is an angular rock, not a pebble', () => {
    const mesh = chunkMesh();
    expect(mesh.indices.length / 3).toBe(20);
    const radii: number[] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      radii.push(Math.hypot(mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0));
    }
    // Much rougher than a blob's 0.22 of lumpiness: a smooth rock is a pebble.
    expect(Math.max(...radii) / Math.min(...radii)).toBeGreaterThan(1.5);
  });
});

describe('the wavefront', () => {
  const mesh = ringMesh(0.13, 56);

  it('lies on the ground, like the sigil and unlike everything else', () => {
    for (let i = 1; i < mesh.positions.length; i += 3) {
      expect(mesh.positions[i] ?? 1).toBe(0);
    }
    for (let i = 0; i < mesh.normals.length; i += 3) {
      expect(Math.abs(mesh.normals[i + 1] ?? 0)).toBeCloseTo(1, 5);
    }
    expect(orientOf('ring')).toBe(ORIENT.exact);
  });

  it('is an annulus rather than a disc, at unit outer radius', () => {
    let inner = Infinity;
    let outer = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const radius = Math.hypot(mesh.positions[i] ?? 0, mesh.positions[i + 2] ?? 0);
      inner = Math.min(inner, radius);
      outer = Math.max(outer, radius);
    }
    expect(outer).toBeCloseTo(1, 5);
    expect(inner).toBeCloseTo(0.87, 5);
  });

  it('has no runes on it, so it is a wavefront and not a symbol', () => {
    // Every vertex is on one of two radii. A mark between them would put one
    // somewhere else, which is what makes `rune-ring` a different shape.
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const radius = Math.hypot(mesh.positions[i] ?? 0, mesh.positions[i + 2] ?? 0);
      const onEdge = Math.abs(radius - 1) < 1e-5 || Math.abs(radius - 0.87) < 1e-5;
      expect(onEdge, `radius ${radius}`).toBe(true);
    }
  });

  it('widens with the ring it belongs to', () => {
    const wide = ringMesh(0.4, 16);
    let inner = Infinity;
    for (let i = 0; i < wide.positions.length; i += 3) {
      inner = Math.min(inner, Math.hypot(wide.positions[i] ?? 0, wide.positions[i + 2] ?? 0));
    }
    expect(inner).toBeCloseTo(0.6, 5);
  });
});

describe('orientation is a property of the shape', () => {
  it('a sigil takes exactly the angle it was given', () => {
    // A per-seed jitter would put the runes somewhere different every stamp.
    expect(orientOf('rune-ring')).toBe(ORIENT.exact);
    expect(orientOf('rune-ring-thin')).toBe(ORIENT.exact);
  });

  it('a shard aims down its own velocity, and only a shard pays for that', () => {
    expect(orientOf('shard')).toBe(ORIENT.velocity);
    expect(needsVelocity('shard')).toBe(true);
    for (const shape of ['blob', 'tongue', 'rune-ring', 'diamond', 'shaft', 'starburst', 'chunk', 'ring'] as const) {
      expect(needsVelocity(shape), shape).toBe(false);
    }
  });

  it('flames and shafts stand up; blobs and diamonds tumble', () => {
    expect(orientOf('tongue')).toBe(ORIENT.uprightJittered);
    expect(orientOf('shaft')).toBe(ORIENT.uprightJittered);
    expect(orientOf('blob')).toBe(ORIENT.tumble);
    expect(orientOf('diamond')).toBe(ORIENT.tumble);
  });

  it('a placed mark lies on the floor and asks for no velocity', () => {
    // Spec 175. A mark somebody painted on the ground: it takes the angle it was
    // given, the way a sigil does, and it takes it in the ground plane. Nothing
    // aims it, because nothing threw it.
    expect(orientOf('brush-mark')).toBe(ORIENT.ground);
    expect(needsVelocity('brush-mark')).toBe(false);
    // And it is still paint: flat-ish, not a lit solid.
    expect(shadedShape('brush-mark')).toBe(false);
  });

  it('light is not lit', () => {
    expect(shadedShape('tongue')).toBe(false);
    expect(shadedShape('shaft')).toBe(false);
    expect(shadedShape('rune-ring')).toBe(false);
    expect(shadedShape('blob')).toBe(true);
    expect(shadedShape('diamond')).toBe(true);
    // The burst's crystal is faceted in the reference: one face catches the key
    // and the next does not, and that two-tone is most of what makes it solid.
    expect(shadedShape('shard')).toBe(true);
    expect(shadedShape('starburst')).toBe(true);
    expect(shadedShape('chunk')).toBe(true);
  });
});

describe('mesh is no longer a stub', () => {
  it('a mesh emitter is its own family, not a quad', () => {
    expect(familyOf(RENDER.mesh)).toBe(FAMILY.mesh);
    expect(familyOf(RENDER.billboard)).toBe(FAMILY.quad);
  });

  it('modeCode never has to answer for a mesh', () => {
    // It cannot: a mesh does not reach the quad shader at all. The regression
    // this guards is the old one, where `mesh` fell through to the billboard.
    expect(modeCode(RENDER.stretched)).toBe(1);
    expect(modeCode(RENDER['axis-billboard'])).toBe(2);
    expect(modeCode(RENDER['ground-quad'])).toBe(3);
  });

  it('the shared cache hands back one geometry per shape', () => {
    expect(particleMesh('blob')).toBe(particleMesh('blob'));
    expect(particleMesh('tongue')).toBe(particleMesh('tongue'));
    expect(particleMesh('blob')).not.toBe(particleMesh('tongue'));
    // The thin sigil is its own shape rather than a parameter, because the cache
    // and the batch key are both the shape: sharing 'rune-ring' would give both
    // auras whichever of the two happened to be built first.
    expect(particleMesh('rune-ring-thin')).not.toBe(particleMesh('rune-ring'));
  });
});

describe('the compiled registry', () => {
  const compiled = REGISTRY;

  it('every mesh emitter names a shape', () => {
    let meshEmitters = 0;
    for (const effect of compiled.effects) {
      for (const emitter of effect.emitters) {
        if (emitter.family !== FAMILY.mesh) continue;
        meshEmitters += 1;
        expect(emitter.meshShape).not.toBe('');
      }
    }
    // The whole point of spec 123 is that fire and smoke are solids, so an empty
    // count means the library quietly went back to quads.
    expect(meshEmitters).toBeGreaterThan(5);
  });

  it('blobs and tongues never share a draw call', () => {
    const meshBatches = compiled.batches.filter((batch) => batch.family === FAMILY.mesh);
    expect(meshBatches.length).toBeGreaterThan(1);
    const keys = meshBatches.map((batch) => `${batch.meshShape}:${batch.blend}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const batch of meshBatches) expect(batch.meshShape).not.toBe('');
    for (const batch of compiled.batches) {
      if (batch.family !== FAMILY.mesh) expect(batch.meshShape).toBe('');
    }
  });

  it('still compiles to a handful of draw calls', () => {
    // A ceiling on the *possible* calls; the layer only issues one per batch
    // that has anything in it, and a frame with one aura up draws three.
    // Every solid shape costs a batch per blend it is used with, so this moves
    // when a shape is added and must be moved deliberately. Spec 158 moved it
    // from 20 to 25 for the four brush marks, one of which is used with two
    // blends.
    expect(compiled.batches.length).toBeLessThanOrEqual(25);
  });
});

describe('the transparency sort', () => {
  const positions = (xs: number[]): [Float32Array, Float32Array, Float32Array] => [
    new Float32Array(xs),
    new Float32Array(xs.length),
    new Float32Array(xs.length),
  ];

  it('is a permutation: every particle appears exactly once', () => {
    const count = 64;
    const xs: number[] = [];
    for (let i = 0; i < count; i++) xs.push(((i * 37) % 64) - 32);
    const [x, y, z] = positions(xs);
    const order = new Int32Array(count);
    const depth = new Float32Array(count);
    depthOrder(count, x, y, z, 1, 0, 0, order, depth);
    expect(Array.from(order).slice().sort((a, b) => a - b)).toEqual(
      Array.from({ length: count }, (_, i) => i),
    );
  });

  it('draws the furthest first', () => {
    // Camera looking down +x: larger x is nearer, so it must come last.
    const [x, y, z] = positions([5, -3, 11, 0]);
    const order = new Int32Array(4);
    const depth = new Float32Array(4);
    depthOrder(4, x, y, z, 1, 0, 0, order, depth);
    expect(Array.from(order)).toEqual([2, 0, 3, 1]);
  });

  it('follows the view direction rather than a fixed axis', () => {
    const [x, y, z] = positions([5, -3, 11, 0]);
    const order = new Int32Array(4);
    const depth = new Float32Array(4);
    depthOrder(4, x, y, z, -1, 0, 0, order, depth);
    expect(Array.from(order)).toEqual([1, 3, 0, 2]);
  });

  it('sorts a shorter prefix without touching the rest', () => {
    const [x, y, z] = positions([9, 1, 7, 3]);
    const order = new Int32Array(4).fill(-1);
    const depth = new Float32Array(4);
    depthOrder(2, x, y, z, 1, 0, 0, order, depth);
    expect(Array.from(order)).toEqual([0, 1, -1, -1]);
  });

  it('allocates nothing on a second pass', () => {
    const count = 512;
    const xs: number[] = [];
    for (let i = 0; i < count; i++) xs.push(Math.sin(i) * 40);
    const [x, y, z] = positions(xs);
    const order = new Int32Array(count);
    const depth = new Float32Array(count);
    const run = (): void => {
      depthOrder(count, x, y, z, -0.577, -0.577, -0.577, order, depth);
    };
    for (let i = 0; i < 200; i++) run();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 500; i++) run();
    const after = process.memoryUsage().heapUsed;
    // 500 sorts of 512 particles. Anything that allocated per particle would be
    // megabytes; the slack is for whatever else the runtime did meanwhile.
    expect(after - before).toBeLessThan(256 * 1024);
  });
});

describe('the placed mark (spec 175)', () => {
  const mesh = particleMesh('brush-mark');

  it('is the only shape whose spine does not start at its own root', () => {
    for (const shape of BRUSH_SHAPES) {
      expect(strokeRootOf(shape), shape).toBe(shape === 'brush-mark' ? -STROKE_CENTRE_SHIFT : 0);
    }
    // Every solid too, so the shader expression the retract is written as stays
    // exactly the one it has always been for all of them.
    for (const [name] of SHAPES) expect(strokeRootOf(name as MeshShape), name).toBe(0);
  });

  it('straddles its own origin, where a thrown mark stands on it', () => {
    const ys: number[] = [];
    for (let v = 1; v < mesh.positions.length; v += 3) ys.push(mesh.positions[v] ?? 0);
    expect(Math.min(...ys)).toBeLessThan(-0.4);
    expect(Math.max(...ys)).toBeGreaterThan(0.4);
    const thrown = particleMesh('brush-slash');
    const theirs: number[] = [];
    for (let v = 1; v < thrown.positions.length; v += 3) theirs.push(thrown.positions[v] ?? 0);
    expect(Math.min(...theirs)).toBeGreaterThanOrEqual(0);
  });

  it('throws no flecks, so an arm is the same length at both ends', () => {
    // A fleck is paint that left the brush, which is a fact about a mark that
    // was *thrown*; and a fleck is the one part of a gesture that sits past the
    // tip, so an arm carrying them is longer at one end than the other -- on a
    // cross, the one asymmetry that reads as a fault rather than as a hand.
    // Nothing past the tip is exactly the assertion, and it is the only one that
    // finds them: a fleck keeps its gesture's `along`, so the outline coordinate
    // cannot see it.
    for (let v = 1; v < mesh.positions.length; v += 3) {
      expect(mesh.positions[v] ?? 0).toBeLessThanOrEqual(STROKE_CENTRE_SHIFT + 1e-6);
    }
  });

  it('reaches no further from its origin than MARK_REACH says it does', () => {
    // The bound the ground clearance's footprint rests on, so it is checked
    // against what the SHADER can do to the geometry rather than against the
    // geometry alone: the spine is stretched by up to 1.34 per instance, the
    // width is swelled by up to 1.22 and rippled by another 1.2, and the outline
    // is bent by up to 0.16 of its own length at the tip (`batches.ts`).
    const STRETCH = 1.34;
    const GAIN = 1.22 * 1.2;
    let worst = 0;
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const u = v * STROKE_UV_STRIDE;
      const along = mesh.strokeUv?.[u] ?? 0;
      const half = mesh.strokeUv?.[u + 1] ?? 0;
      const sideX = mesh.strokeUv?.[u + 2] ?? 0;
      const sideY = mesh.strokeUv?.[u + 3] ?? 0;
      for (const sign of [-1, 1]) {
        const lateral = sign * 0.16 * along * along + half * GAIN;
        worst = Math.max(
          worst,
          Math.hypot(
            (mesh.positions[v * 3] ?? 0) + sideX * lateral,
            (mesh.positions[v * 3 + 1] ?? 0) * STRETCH + sideY * lateral,
            (mesh.positions[v * 3 + 2] ?? 0) * GAIN,
          ),
        );
      }
    }
    expect(worst).toBeLessThanOrEqual(MARK_REACH);
    // And not far under it either: a bound that drifted well above the truth is
    // a mark held further off the ground than it needs to be, which is the same
    // fault as clipping, seen from the other side.
    expect(worst).toBeGreaterThan(MARK_REACH * 0.85);
  });
});
