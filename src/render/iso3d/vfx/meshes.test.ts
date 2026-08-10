import { describe, expect, it } from 'vitest';
import { blobMesh, tongueMesh, particleMesh, type MeshData } from './meshes.js';
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
    expect(compiled.batches.length).toBeLessThanOrEqual(12);
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
