import { describe, expect, it } from 'vitest';
import {
  acceptsProjection,
  CHUNK_WORLD_SIZE,
  decalGrid,
  decalGridIndices,
  decalGridNormals,
  decalGridUvs,
  DecalField,
  type Decal,
  type DecalInput,
} from './decals.js';

function input(overrides: Partial<DecalInput> = {}): DecalInput {
  return {
    x: 10,
    y: 0,
    z: 20,
    size: 30,
    rotation: 0,
    nx: 0,
    ny: 1,
    nz: 0,
    seed: 1,
    fluid: 'blood',
    ...overrides,
  };
}

describe('bucketing', () => {
  it('groups by the terrain\'s own chunk size', () => {
    // 28 cells at 22 units. A decal and the ground under it must land in the
    // same chunk, or dropping one frees stains belonging to another.
    expect(CHUNK_WORLD_SIZE).toBe(616);
    const field = new DecalField();
    expect(field.chunkOf(0, 0)).toEqual({ cx: 0, cz: 0 });
    expect(field.chunkOf(615, 615)).toEqual({ cx: 0, cz: 0 });
    expect(field.chunkOf(616, 0)).toEqual({ cx: 1, cz: 0 });
    expect(field.chunkOf(-1, -1)).toEqual({ cx: -1, cz: -1 });
  });

  it('puts a decal in the bucket its position names', () => {
    const field = new DecalField();
    field.add(input({ x: 700, z: 1300 }));
    expect(field.bucket(1, 2)).toHaveLength(1);
    expect(field.bucket(0, 0)).toHaveLength(0);
  });

  it('refuses a decal with a non-finite position or no size', () => {
    const field = new DecalField();
    expect(field.add(input({ x: Number.NaN }))).toBe(false);
    expect(field.add(input({ size: 0 }))).toBe(false);
    expect(field.count).toBe(0);
  });
});

describe('the per-chunk cap', () => {
  it('fades the oldest rather than popping it', () => {
    const field = new DecalField({ perChunk: 4, fadeTicks: 10 });
    for (let i = 0; i < 5; i++) field.add(input({ seed: i }));
    // Five are still present; the first is on its way out, not gone.
    expect(field.bucket(0, 0)).toHaveLength(5);
    expect(field.bucket(0, 0)[0]?.fadeFrom).toBeGreaterThanOrEqual(0);
    expect(field.bucket(0, 0)[1]?.fadeFrom).toBe(-1);

    field.update(5);
    expect(field.bucket(0, 0)[0]?.opacity).toBeLessThan(1);
    expect(field.bucket(0, 0)[0]?.opacity).toBeGreaterThan(0);

    field.update(6);
    expect(field.bucket(0, 0)).toHaveLength(4);
  });

  it('settles back to the cap under sustained fire, with a slow fade', () => {
    // The fade has to be long relative to the fire rate or this proves nothing.
    // Counting decals that are *already fading* toward the cap makes every add
    // mark another survivor, and within a few seconds the whole bucket is on its
    // way out and the ground goes clean in the middle of the fight staining it.
    const field = new DecalField({ perChunk: 8, fadeTicks: 60 });
    for (let round = 0; round < 100; round++) {
      field.add(input({ seed: round }));
      field.update(1);
    }
    const bucket = field.bucket(0, 0);
    const solid = bucket.filter((decal) => decal.fadeFrom < 0).length;
    expect(solid).toBe(8);
    expect(bucket.length).toBeLessThan(8 + 60);
  });

  it('never lets a bucket empty itself while it is being added to', () => {
    const field = new DecalField({ perChunk: 6, fadeTicks: 90 });
    for (let round = 0; round < 300; round++) {
      field.add(input({ seed: round }));
      field.update(2);
      expect(field.bucket(0, 0).filter((decal) => decal.fadeFrom < 0).length).toBeGreaterThan(0);
    }
  });

  it('leaves other chunks alone when one is over its cap', () => {
    const field = new DecalField({ perChunk: 2, fadeTicks: 10 });
    field.add(input({ x: 10, z: 10 }));
    field.add(input({ x: 10, z: 10 }));
    field.add(input({ x: 10, z: 10 }));
    field.add(input({ x: 700, z: 10 }));
    expect(field.bucket(1, 0)[0]?.fadeFrom).toBe(-1);
  });
});

describe('the global cap', () => {
  it('evicts the furthest buckets first, never the nearest', () => {
    const field = new DecalField({ perChunk: 100, total: 20, fadeTicks: 10 });
    field.setViewpoint(0, 0);
    // Ten near the viewpoint, ten far away, then enough to go over.
    for (let i = 0; i < 10; i++) field.add(input({ x: 10, z: 10, seed: i }));
    for (let i = 0; i < 10; i++) field.add(input({ x: 10_000, z: 10_000, seed: 100 + i }));
    expect(field.count).toBe(20);

    for (let i = 0; i < 5; i++) field.add(input({ x: 20, z: 20, seed: 200 + i }));

    expect(field.count).toBeLessThanOrEqual(20);
    // The near bucket survived; the distant one was the one dropped.
    expect(field.bucket(0, 0).length).toBeGreaterThan(0);
    expect(field.bucket(16, 16)).toHaveLength(0);
  });
});

describe('dropChunk', () => {
  it('frees exactly one bucket and leaves its neighbours', () => {
    const field = new DecalField();
    field.add(input({ x: 10, z: 10 }));
    field.add(input({ x: 700, z: 10 }));
    field.add(input({ x: 10, z: 700 }));
    expect(field.count).toBe(3);

    field.dropChunk(0, 0);
    expect(field.count).toBe(2);
    expect(field.bucket(0, 0)).toHaveLength(0);
    expect(field.bucket(1, 0)).toHaveLength(1);
    expect(field.bucket(0, 1)).toHaveLength(1);
  });

  it('is harmless on a chunk that holds nothing', () => {
    const field = new DecalField();
    expect(() => field.dropChunk(9, 9)).not.toThrow();
    expect(field.count).toBe(0);
  });
});

describe('dirty tracking', () => {
  it('marks one bucket per add and reports it once', () => {
    const field = new DecalField();
    field.takeDirty();
    field.add(input({ x: 10, z: 10 }));
    field.add(input({ x: 20, z: 20 }));
    const dirty = field.takeDirty();
    expect(dirty).toEqual([{ cx: 0, cz: 0 }]);
    expect(field.takeDirty()).toEqual([]);
  });

  it('does not mark a settled field dirty', () => {
    // The property that makes a hundred stains sitting there free: nothing
    // rebuilds when nothing changed.
    const field = new DecalField({ fadeTicks: 10 });
    for (let i = 0; i < 10; i++) field.add(input({ seed: i }));
    field.takeDirty();
    field.update(600);
    expect(field.takeDirty()).toEqual([]);
  });

  it('marks a bucket while one of its decals is fading', () => {
    const field = new DecalField({ perChunk: 1, fadeTicks: 20 });
    field.add(input({ seed: 1 }));
    field.add(input({ seed: 2 }));
    field.takeDirty();
    field.update(3);
    expect(field.takeDirty()).toEqual([{ cx: 0, cz: 0 }]);
  });
});

describe('gore', () => {
  it('stores nothing and dirties nothing when off', () => {
    // Off has to remove the *work*, not just the pixels.
    const field = new DecalField();
    field.setGore(0);
    field.takeDirty();
    expect(field.add(input())).toBe(false);
    expect(field.count).toBe(0);
    expect(field.takeDirty()).toEqual([]);
    field.update(100);
    expect(field.count).toBe(0);
  });

  it('clears what was already there when it is switched off', () => {
    const field = new DecalField();
    for (let i = 0; i < 5; i++) field.add(input({ seed: i }));
    expect(field.count).toBe(5);
    field.setGore(0);
    expect(field.count).toBe(0);
    // And the view is told, so it drops the geometry rather than leaving it up.
    expect(field.takeDirty().length).toBeGreaterThan(0);
  });

  it('takes decals again once it is switched back on', () => {
    const field = new DecalField();
    field.setGore(0);
    field.setGore(2);
    expect(field.add(input())).toBe(true);
  });

  /** Fill one chunk past any cap and report what is left standing. */
  const solidAfter = (level: 1 | 2, count = 200): number => {
    const field = new DecalField();
    field.setGore(level);
    for (let i = 0; i < count; i++) field.add(input({ seed: i }));
    // A decal over the cap is *marked* rather than removed (a stain that
    // vanishes on the frame a new one lands is a pop), so what the cap means is
    // how many are not fading.
    return field.bucket(0, 0).filter((decal) => decal.fadeFrom < 0).length;
  };

  it('holds strictly less ground at Less than at Full (spec 182)', () => {
    // The middle button used to be a label with nothing behind it: `add` refused
    // at 0 and accepted otherwise, so Less and Full were the same code.
    expect(solidAfter(1)).toBeLessThan(solidAfter(2));
    expect(solidAfter(1)).toBeGreaterThan(0);
  });

  it('trims what is already on the ground when it is turned down', () => {
    // Waiting for the next add would leave the setting looking broken for
    // exactly as long as nobody was hitting anything, which is when somebody
    // changes it.
    const field = new DecalField();
    for (let i = 0; i < 200; i++) field.add(input({ seed: i }));
    const before = field.bucket(0, 0).filter((decal) => decal.fadeFrom < 0).length;
    field.takeDirty();
    field.setGore(1);
    const after = field.bucket(0, 0).filter((decal) => decal.fadeFrom < 0).length;
    expect(after).toBeLessThan(before);
    expect(field.takeDirty().length).toBeGreaterThan(0);
  });

  it('does not re-trim when the level it is handed is the one it has', () => {
    const field = new DecalField();
    for (let i = 0; i < 200; i++) field.add(input({ seed: i }));
    const before = field.bucket(0, 0).map((decal) => decal.fadeFrom);
    field.setGore(2);
    expect(field.bucket(0, 0).map((decal) => decal.fadeFrom)).toEqual(before);
  });

  it('keeps a global cap that is smaller at Less', () => {
    const spread = (level: 1 | 2): number => {
      const field = new DecalField();
      field.setGore(level);
      // Across many chunks, so the global cap is what bites rather than the
      // per-chunk one.
      for (let i = 0; i < 4000; i++) field.add(input({ x: (i % 200) * 700, z: Math.floor(i / 200) * 700, seed: i }));
      return field.count;
    };
    expect(spread(1)).toBeLessThan(spread(2));
  });
});

describe('determinism', () => {
  it('produces an identical field from the same sequence of adds', () => {
    const build = (): DecalField => {
      const field = new DecalField({ perChunk: 6, fadeTicks: 12 });
      for (let i = 0; i < 40; i++) {
        field.add(input({ x: (i * 37) % 900, z: (i * 53) % 900, seed: i * 7 }));
        field.update(1);
      }
      return field;
    };
    const a = build();
    const b = build();
    expect(a.count).toBe(b.count);
    for (const { cx, cz } of a.chunks()) {
      expect(b.bucket(cx, cz)).toEqual(a.bucket(cx, cz));
    }
  });
});

// --- fitting -----------------------------------------------------------------

function decalAt(x: number, z: number, size = 40, rotation = 0): Decal {
  return { x, y: 0, z, size, rotation, nx: 0, ny: 1, nz: 0, seed: 1, fluid: 'blood', age: 0, fadeFrom: -1, opacity: 1 };
}

describe('decalGrid', () => {
  it('puts every sample on the ground the sampler reports', () => {
    // The property that stops a decal floating at one end of a slope and being
    // buried at the other -- which a single flat quad does on every hillside.
    const slope = (x: number, z: number): number => x * 0.3 + z * 0.1;
    const out = new Float32Array(4 * 4 * 3);
    decalGrid(decalAt(100, 50), 4, slope, 0, out);
    for (let i = 0; i < 16; i++) {
      const x = out[i * 3] ?? 0;
      const y = out[i * 3 + 1] ?? 0;
      const z = out[i * 3 + 2] ?? 0;
      expect(y).toBeCloseTo(slope(x, z), 4);
    }
  });

  it('follows a ridge, where a flat quad both floats and buries', () => {
    const ridge = (x: number): number => -Math.abs(x - 100) * 0.5 + 50;
    const out = new Float32Array(5 * 5 * 3);
    decalGrid(decalAt(100, 0, 60), 5, (x) => ridge(x), 0, out);
    for (let i = 0; i < 25; i++) {
      expect(out[i * 3 + 1] ?? 0).toBeCloseTo(ridge(out[i * 3] ?? 0), 4);
    }
  });

  it('covers the decal\'s footprint and no more', () => {
    const out = new Float32Array(3 * 3 * 3);
    decalGrid(decalAt(0, 0, 40), 3, () => 0, 0, out);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < 9; i++) {
      minX = Math.min(minX, out[i * 3] ?? 0);
      maxX = Math.max(maxX, out[i * 3] ?? 0);
    }
    expect(minX).toBeCloseTo(-20, 5);
    expect(maxX).toBeCloseTo(20, 5);
  });

  it('turns with its rotation', () => {
    const flat = new Float32Array(2 * 2 * 3);
    decalGrid(decalAt(0, 0, 40, Math.PI / 2), 2, () => 0, 0, flat);
    // A quarter turn takes the first corner from (-20, -20) to (-20, +20)-ish.
    expect(flat[0] ?? 0).toBeCloseTo(20, 4);
    expect(flat[2] ?? 0).toBeCloseTo(-20, 4);
  });

  it('lifts off the surface so it does not z-fight', () => {
    const out = new Float32Array(2 * 2 * 3);
    decalGrid(decalAt(0, 0), 2, () => 10, 2, out);
    for (let i = 0; i < 4; i++) expect(out[i * 3 + 1] ?? 0).toBeGreaterThan(10);
  });
});

describe('decalGridNormals', () => {
  it('stands a flat patch straight up', () => {
    const positions = new Float32Array(4 * 4 * 3);
    const normals = new Float32Array(4 * 4 * 3);
    decalGrid(decalAt(0, 0), 4, () => 12, 0, positions);
    decalGridNormals(positions, 4, normals);
    for (let i = 0; i < 16; i++) {
      expect(normals[i * 3] ?? 0).toBeCloseTo(0, 6);
      expect(normals[i * 3 + 1] ?? 0).toBeCloseTo(1, 6);
      expect(normals[i * 3 + 2] ?? 0).toBeCloseTo(0, 6);
    }
  });

  it('tilts into a slope, and away from the way it rises', () => {
    // Ground climbing towards +X, so the surface normal leans towards -X. A
    // normal that came back +Y here is a decal that takes the sun as though it
    // were on the flat, which is the whole complaint.
    const positions = new Float32Array(4 * 4 * 3);
    const normals = new Float32Array(4 * 4 * 3);
    decalGrid(decalAt(0, 0), 4, (x) => x * 0.5, 0, positions);
    decalGridNormals(positions, 4, normals);
    for (let i = 0; i < 16; i++) {
      expect(normals[i * 3] ?? 0).toBeLessThan(-0.4);
      expect(normals[i * 3 + 1] ?? 0).toBeGreaterThan(0.4);
    }
  });

  it('is unit length everywhere, on any ground', () => {
    const positions = new Float32Array(5 * 5 * 3);
    const normals = new Float32Array(5 * 5 * 3);
    decalGrid(decalAt(40, -10, 60, 0.7), 5, (x, z) => Math.sin(x * 0.05) * 14 + Math.cos(z * 0.03) * 9, 0, positions);
    decalGridNormals(positions, 5, normals);
    for (let i = 0; i < 25; i++) {
      const length = Math.hypot(normals[i * 3] ?? 0, normals[i * 3 + 1] ?? 0, normals[i * 3 + 2] ?? 0);
      expect(length).toBeCloseTo(1, 5);
    }
  });

  it('points out of the ground rather than into it, whatever the decal is turned to', () => {
    // The sign of the cross product, which is a coin flip to write and a black
    // decal to get wrong.
    for (const rotation of [0, 1.1, Math.PI, -2.4]) {
      const positions = new Float32Array(4 * 4 * 3);
      const normals = new Float32Array(4 * 4 * 3);
      decalGrid(decalAt(0, 0, 40, rotation), 4, (x, z) => x * 0.2 - z * 0.35, 0, positions);
      decalGridNormals(positions, 4, normals);
      for (let i = 0; i < 16; i++) expect(normals[i * 3 + 1] ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('decalGridUvs and decalGridIndices', () => {
  it('span 0..1 across the grid', () => {
    const uvs = new Float32Array(3 * 3 * 2);
    decalGridUvs(3, uvs);
    expect(uvs[0]).toBe(0);
    expect(uvs[1]).toBe(0);
    expect(uvs[(8 * 2)]).toBe(1);
    expect(uvs[8 * 2 + 1]).toBe(1);
  });

  it('emit two triangles per cell, offset by the base vertex', () => {
    const indices: number[] = [];
    decalGridIndices(3, 0, indices);
    expect(indices).toHaveLength((3 - 1) * (3 - 1) * 6);
    expect(Math.max(...indices)).toBe(8);

    const offset: number[] = [];
    decalGridIndices(3, 100, offset);
    expect(Math.min(...offset)).toBe(100);
  });
});

describe('acceptsProjection', () => {
  const down = { x: 0, y: -1, z: 0 };

  it('accepts a surface facing into the spray', () => {
    expect(acceptsProjection(0, 1, 0, down.x, down.y, down.z, Math.PI / 3)).toBe(true);
  });

  it('rejects the underside of a thing', () => {
    // The rule that stops blood being painted onto a rock from beneath.
    expect(acceptsProjection(0, -1, 0, down.x, down.y, down.z, Math.PI / 3)).toBe(false);
  });

  it('rejects a wall the spray only grazes', () => {
    // Exactly perpendicular: 90 degrees, outside a 60 degree limit.
    expect(acceptsProjection(1, 0, 0, down.x, down.y, down.z, Math.PI / 3)).toBe(false);
    // And inside a generous one.
    expect(acceptsProjection(1, 0, 0, down.x, down.y, down.z, Math.PI / 2 + 0.01)).toBe(true);
  });

  it('takes an unnormalized normal', () => {
    expect(acceptsProjection(0, 17, 0, down.x, down.y, down.z, Math.PI / 3)).toBe(true);
  });

  it('refuses a degenerate normal or direction rather than dividing by zero', () => {
    expect(acceptsProjection(0, 0, 0, down.x, down.y, down.z, Math.PI)).toBe(false);
    expect(acceptsProjection(0, 1, 0, 0, 0, 0, Math.PI)).toBe(false);
  });

  it('follows the direction, not just gravity', () => {
    // Sprayed sideways: the wall now takes it and the floor does not.
    expect(acceptsProjection(-1, 0, 0, 1, 0, 0, Math.PI / 3)).toBe(true);
    expect(acceptsProjection(0, 1, 0, 1, 0, 0, Math.PI / 3)).toBe(false);
  });
});
