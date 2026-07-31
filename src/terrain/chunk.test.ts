import { describe, expect, it } from 'vitest';
import {
  chunkCoords,
  layerCellSolid,
  sampleChunk,
  sampleLayer,
  toneVariant,
  type ChunkOptions,
} from './chunk.js';
import { createLayer } from './features.js';
import { rectDepth, rectWidth, TERRAIN_MATERIALS, type Rect, type TerrainLayer } from './types.js';

const BOUNDS: Rect = { minX: -200, minZ: -200, maxX: 280, maxZ: 200 };
const OPT: ChunkOptions = { cellSize: 20, chunkCells: 8 };

function hillyLayer(seed = 7): TerrainLayer {
  return createLayer({
    id: 'test',
    bounds: BOUNDS,
    baseY: -100,
    waterLevel: null,
    seed,
    features: [
      { kind: 'rolling', amplitude: 20 },
      { kind: 'hill', x: 0, z: 0, radius: 160, edge: 90, height: 120 },
    ],
  });
}

/** Two separated island masks over one field: the disconnected-land-mass case. */
function archipelagoLayer(): TerrainLayer {
  return createLayer({
    id: 'isles',
    bounds: BOUNDS,
    baseY: -100,
    waterLevel: -40,
    seed: 3,
    features: [
      { kind: 'hill', x: -120, z: 0, radius: 120, edge: 60, height: 60 },
      { kind: 'hill', x: 200, z: 0, radius: 100, edge: 50, height: 60 },
      { kind: 'islandMask', x: -120, z: 0, radius: 100, edge: 30 },
      { kind: 'islandMask', x: 200, z: 0, radius: 80, edge: 30 },
    ],
  });
}

describe('chunk grid', () => {
  it('tiles the layer bounds with no gaps and no unused chunks', () => {
    const layer = hillyLayer();
    const coords = chunkCoords(layer, OPT);
    const cellsX = Math.ceil(rectWidth(BOUNDS) / OPT.cellSize); // 24
    const cellsZ = Math.ceil(rectDepth(BOUNDS) / OPT.cellSize); // 20
    expect(coords.length).toBe(Math.ceil(cellsX / 8) * Math.ceil(cellsZ / 8));

    // Summed chunk extents cover exactly the layer's cell grid.
    const chunks = sampleLayer(layer, OPT);
    const covered = new Set<string>();
    for (const c of chunks) {
      for (let j = 0; j < c.rows; j++) {
        for (let i = 0; i < c.cols; i++) covered.add(`${c.startCol + i},${c.startRow + j}`);
      }
    }
    expect(covered.size).toBe(cellsX * cellsZ);
  });

  it('places every corner height where that corner actually sits', () => {
    const layer = hillyLayer();
    for (const chunk of sampleLayer(layer, OPT)) {
      for (let k = 0; k < chunk.heights.length; k++) {
        const x = chunk.cornerX[k] ?? 0;
        const z = chunk.cornerZ[k] ?? 0;
        expect(chunk.heights[k]).toBeCloseTo(layer.sample(x, z).height, 4);
      }
    }
  });

  it('jitters corners off the lattice, but never far enough to fold a quad', () => {
    const layer = hillyLayer();
    let moved = 0;
    for (const chunk of sampleLayer(layer, OPT)) {
      for (let j = 0; j <= chunk.rows; j++) {
        for (let i = 0; i <= chunk.cols; i++) {
          const k = j * (chunk.cols + 1) + i;
          const dx = (chunk.cornerX[k] ?? 0) - (chunk.originX + i * chunk.cellSize);
          const dz = (chunk.cornerZ[k] ?? 0) - (chunk.originZ + j * chunk.cellSize);
          // Under half a cell each way, so corners cannot cross their neighbours.
          expect(Math.abs(dx)).toBeLessThan(chunk.cellSize / 2);
          expect(Math.abs(dz)).toBeLessThan(chunk.cellSize / 2);
          if (Math.abs(dx) > 0.5 || Math.abs(dz) > 0.5) moved++;
        }
      }
    }
    // Nearly every corner should actually have moved -- an unjittered grid is
    // exactly the "made of squares" look this exists to break.
    expect(moved).toBeGreaterThan(100);
  });

  it('shares corners across a chunk seam, so the surface is continuous', () => {
    const layer = hillyLayer();
    const a = sampleChunk(layer, { cx: 0, cz: 0 }, OPT);
    const b = sampleChunk(layer, { cx: 1, cz: 0 }, OPT);
    for (let j = 0; j <= a.rows; j++) {
      const right = j * (a.cols + 1) + a.cols;
      const left = j * (b.cols + 1);
      // Position, height and normal all agree, so neither a gap nor a shading
      // crease can appear along the join.
      expect(a.cornerX[right]).toBe(b.cornerX[left]);
      expect(a.cornerZ[right]).toBe(b.cornerZ[left]);
      expect(a.heights[right]).toBe(b.heights[left]);
      for (let c = 0; c < 3; c++) {
        expect(a.normals[right * 3 + c]).toBeCloseTo(b.normals[left * 3 + c] ?? 0, 6);
      }
    }
  });

  it('gives every corner a unit normal that points out of the ground', () => {
    for (const chunk of sampleLayer(hillyLayer(), OPT)) {
      for (let k = 0; k < chunk.heights.length; k++) {
        const nx = chunk.normals[k * 3] ?? 0;
        const ny = chunk.normals[k * 3 + 1] ?? 0;
        const nz = chunk.normals[k * 3 + 2] ?? 0;
        expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
        expect(ny).toBeGreaterThan(0);
      }
    }
  });

  it('mottles tone in patches rather than per cell, so no checkerboard forms', () => {
    // Walk a straight line and count how often the tone flips. A per-cell coin
    // flip alternates constantly; a noise field holds a value for a while.
    let flips = 0;
    let previous = toneVariant(0, 0, 5);
    const steps = 200;
    for (let i = 1; i <= steps; i++) {
      const t = toneVariant(i * OPT.cellSize, 0, 5);
      if (t !== previous) flips++;
      previous = t;
    }
    expect(flips).toBeLessThan(steps / 8);
  });

  it('classifies every solid cell to a real material', () => {
    for (const chunk of sampleLayer(hillyLayer(), OPT)) {
      for (let k = 0; k < chunk.materials.length; k++) {
        expect(TERRAIN_MATERIALS[chunk.materials[k] ?? -1]).toBeDefined();
        expect(chunk.tones[k] === 0 || chunk.tones[k] === 1).toBe(true);
      }
    }
  });

  it('is deterministic: the same layer samples to identical arrays', () => {
    const a = sampleLayer(hillyLayer(11), OPT);
    const b = sampleLayer(hillyLayer(11), OPT);
    expect(a.length).toBe(b.length);
    a.forEach((chunk, i) => {
      const other = b[i];
      expect(other).toBeDefined();
      expect(Array.from(chunk.heights)).toEqual(Array.from(other?.heights ?? []));
      expect(Array.from(chunk.materials)).toEqual(Array.from(other?.materials ?? []));
      expect(Array.from(chunk.solid)).toEqual(Array.from(other?.solid ?? []));
      expect(Array.from(chunk.tones)).toEqual(Array.from(other?.tones ?? []));
      expect(Array.from(chunk.cornerX)).toEqual(Array.from(other?.cornerX ?? []));
      expect(Array.from(chunk.normals)).toEqual(Array.from(other?.normals ?? []));
    });
  });

  it('gives a different seed different terrain', () => {
    const a = sampleChunk(hillyLayer(1), { cx: 0, cz: 0 }, OPT);
    const b = sampleChunk(hillyLayer(2), { cx: 0, cz: 0 }, OPT);
    expect(Array.from(a.heights)).not.toEqual(Array.from(b.heights));
  });
});

describe('solidity', () => {
  it('fills the whole bounds when the layer declares no masks', () => {
    for (const chunk of sampleLayer(hillyLayer(), OPT)) {
      expect(Array.from(chunk.solid).every((s) => s === 1)).toBe(true);
    }
  });

  it('holds ground inside island masks and nowhere else', () => {
    const layer = archipelagoLayer();
    let solidCells = 0;
    for (const chunk of sampleLayer(layer, OPT)) {
      for (let j = 0; j < chunk.rows; j++) {
        for (let i = 0; i < chunk.cols; i++) {
          const x = chunk.originX + (i + 0.5) * chunk.cellSize;
          const z = chunk.originZ + (j + 0.5) * chunk.cellSize;
          const solid = chunk.solid[j * chunk.cols + i] === 1;
          expect(solid).toBe(layer.sample(x, z).solid);
          if (solid) solidCells++;
        }
      }
    }
    expect(solidCells).toBeGreaterThan(0);

    // The two masses really are separate: nothing is solid on the strip between.
    for (let z = BOUNDS.minZ; z <= BOUNDS.maxZ; z += 10) {
      expect(layer.sample(40, z).solid).toBe(false);
    }
  });

  it('reports no ground outside the layer, so an edge is not a chunk seam', () => {
    const layer = hillyLayer();
    expect(layerCellSolid(layer, 0, 0, OPT)).toBe(true);
    expect(layerCellSolid(layer, -1, 0, OPT)).toBe(false);
    expect(layerCellSolid(layer, 0, -1, OPT)).toBe(false);
    expect(layerCellSolid(layer, 9999, 0, OPT)).toBe(false);
  });
});
