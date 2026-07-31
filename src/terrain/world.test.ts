import { describe, expect, it } from 'vitest';
import { sampleLayer } from './chunk.js';
import { arenaBounds, createArenaWorld, DEFAULT_ARENA_WORLD, WATER_LEVEL } from './world.js';
import { DEFAULT_BANDS } from './classify.js';
import { rectContains, TERRAIN_MATERIALS, type TerrainMaterial } from './types.js';

const SEED = 20260731;
const { playWidth, playHeight } = DEFAULT_ARENA_WORLD;

function materialsOf(seed: number): Map<TerrainMaterial, number> {
  const counts = new Map<TerrainMaterial, number>();
  for (const layer of createArenaWorld(seed).layers) {
    for (const chunk of sampleLayer(layer)) {
      for (let k = 0; k < chunk.materials.length; k++) {
        if (chunk.solid[k] !== 1) continue;
        const m = TERRAIN_MATERIALS[chunk.materials[k] ?? 0] ?? 'grass';
        counts.set(m, (counts.get(m) ?? 0) + 1);
      }
    }
  }
  return counts;
}

describe('the arena world', () => {
  it('is deterministic: the same seed samples to bit-identical chunks', () => {
    const a = createArenaWorld(SEED).layers.flatMap((l) => sampleLayer(l));
    const b = createArenaWorld(SEED).layers.flatMap((l) => sampleLayer(l));
    expect(a.length).toBe(b.length);
    a.forEach((chunk, i) => {
      const other = b[i];
      expect(Array.from(chunk.heights)).toEqual(Array.from(other?.heights ?? []));
      expect(Array.from(chunk.materials)).toEqual(Array.from(other?.materials ?? []));
      expect(Array.from(chunk.solid)).toEqual(Array.from(other?.solid ?? []));
    });
  });

  it('gives a different seed different terrain', () => {
    const a = createArenaWorld(1);
    const b = createArenaWorld(2);
    let differences = 0;
    for (let z = 0; z <= playHeight; z += 60) {
      for (let x = 0; x <= playWidth; x += 60) {
        if (Math.abs(a.heightAt(x, z) - b.heightAt(x, z)) > 0.5) differences++;
      }
    }
    expect(differences).toBeGreaterThan(0);
  });

  it('bleeds well past the play area, so the widest shot never frames the void', () => {
    const bounds = arenaBounds();
    expect(rectContains(bounds, -1500, -1500)).toBe(true);
    expect(rectContains(bounds, playWidth + 1500, playHeight + 1500)).toBe(true);
  });

  it('keeps the play area gently rolling — no walls, no water, in the fight', () => {
    for (const seed of [SEED, 1, 2, 77, 123456]) {
      const world = createArenaWorld(seed);
      let min = Infinity;
      let max = -Infinity;
      for (let z = 0; z <= playHeight; z += 10) {
        for (let x = 0; x <= playWidth; x += 10) {
          const h = world.heightAt(x, z);
          min = Math.min(min, h);
          max = Math.max(max, h);
        }
      }
      // Low relief: the sim is flat, so the fight must stay readable.
      expect(max - min).toBeLessThan(120);
      // Clear of the water line *and* its shore band, so no seed puts a lake or
      // a beach in the arena.
      expect(min).toBeGreaterThan(WATER_LEVEL + DEFAULT_BANDS.shoreBand);
    }
  });

  it('has ground everywhere in the play area, so nothing can stand on a hole', () => {
    const layer = createArenaWorld(SEED).layers[0];
    expect(layer).toBeDefined();
    for (let z = 0; z <= playHeight; z += 25) {
      for (let x = 0; x <= playWidth; x += 25) {
        expect(layer?.sample(x, z).solid).toBe(true);
      }
    }
  });

  it('runs its dirt paths across the play area', () => {
    const layer = createArenaWorld(SEED).layers[0];
    // A point on the authored main route, and one well away from both.
    expect(layer?.sample(640, 470).region).toBe('path');
    expect(layer?.sample(200, 800).region).toBe('default');
  });

  it('puts every material somewhere in the world', () => {
    const counts = materialsOf(SEED);
    for (const material of TERRAIN_MATERIALS) {
      expect(counts.get(material) ?? 0).toBeGreaterThan(0);
    }
  });

  it('stands islands out of the southern sea', () => {
    const world = createArenaWorld(SEED);
    // The sea floor is well under the flood level...
    expect(world.heightAt(2600, 1900)).toBeLessThan(-60);
    // ...and the two authored island peaks are well above it.
    expect(world.heightAt(2120, 1860)).toBeGreaterThan(0);
    expect(world.heightAt(1720, 2150)).toBeGreaterThan(0);
  });

  it('reads 0 over open air outside the world', () => {
    expect(createArenaWorld(SEED).heightAt(99999, 99999)).toBe(0);
  });
});
