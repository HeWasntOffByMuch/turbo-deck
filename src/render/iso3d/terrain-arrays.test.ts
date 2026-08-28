import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { buildChunkArrays } from './terrain-arrays.js';
import { TERRAIN_CLIFF_COLORS, TERRAIN_COLORS } from './palette.js';
import { MAP_VERSION, type MapDocument } from '../../terrain/map.js';
import { loadMap, type MeshLayer } from '../../terrain/map-world.js';
import { TERRAIN_MATERIALS, type TerrainChunk } from '../../terrain/index.js';

/**
 * The mesher was moved out of `terrain-mesh.ts` in spec 180 so a worker could
 * run it, and the whole risk of that move is that the arithmetic came with it
 * unchanged. It did: the extraction was checked against the implementation it
 * replaced over the shipped arena, 9.97M floats across 288 meshes, identical
 * element for element.
 *
 * What is pinned here is the part of that which can be re-checked without the
 * old code in the tree -- the colour transfer, which is the one thing that was
 * genuinely *re-derived* rather than moved.
 */
describe('the colours are three.js colours', () => {
  /**
   * `linearColor` was `new THREE.Color(hex)`, which with `ColorManagement` on
   * is an sRGB decode. The replacement is that decode transcribed from three's
   * own `SRGBToLinear`, in three's premultiplied form rather than the
   * algebraically identical one in `hike.ts` -- because `c / 12.92` and
   * `c * 0.0773993808` are the same number in algebra and not always the same
   * float, and this feeds a vertex colour that has to match what shipped.
   *
   * So the assertion is against `THREE.Color` itself and not against the
   * formula: the claim is "the same colour", not "the same algebra".
   */
  it.each(
    [...Object.values(TERRAIN_COLORS), ...Object.values(TERRAIN_CLIFF_COLORS)]
      .flat()
      .map((hex) => [`0x${hex.toString(16)}`, hex] as const),
  )('%s decodes exactly as THREE.Color does', (_label, hex) => {
    const packed = cellOf(hex);
    const { layer, chunk } = onlyChunk(packed);
    const arrays = buildChunkArrays(layer, chunk);
    const want = new THREE.Color(hex);
    // A surface hex is read off the ground, a cliff hex off the skirt -- the
    // chunk is one material throughout, so vertex zero of either carries it.
    const colors = (packed % 2 === 0 ? arrays.surface : arrays.walls)?.colors;
    expect(colors).toBeDefined();
    // Through a Float32Array, because that is the precision the attribute holds
    // and `THREE.Color` keeps its channels as doubles.
    const f32 = new Float32Array([want.r, want.g, want.b]);
    expect(colors?.[0]).toBe(f32[0]);
    expect(colors?.[1]).toBe(f32[1]);
    expect(colors?.[2]).toBe(f32[2]);
  });
});

describe('buildChunkArrays', () => {
  it('emits normals and cavities for the surface and neither for the walls', () => {
    const { layer, chunk } = onlyChunk(0);
    const { surface, walls } = buildChunkArrays(layer, chunk);
    expect(surface?.normals).not.toBeNull();
    expect(surface?.cavities).not.toBeNull();
    // The walls were flat-shaded by three's `computeVertexNormals` and still
    // are, on the geometry -- so nothing here computes one.
    expect(walls?.normals ?? null).toBeNull();
    expect(walls?.cavities ?? null).toBeNull();
  });

  it('sizes every attribute to the vertices it wrote', () => {
    const { layer, chunk } = onlyChunk(0);
    const { surface, walls } = buildChunkArrays(layer, chunk);
    for (const arrays of [surface, walls]) {
      expect(arrays).not.toBeNull();
      if (!arrays) continue;
      const vertices = arrays.positions.length / 3;
      expect(vertices % 3).toBe(0);
      expect(arrays.colors.length).toBe(vertices * 3);
      if (arrays.normals) expect(arrays.normals.length).toBe(vertices * 3);
      if (arrays.cavities) expect(arrays.cavities.length).toBe(vertices);
    }
  });

  it('grows past its initial guess rather than dropping triangles', () => {
    // A chessboard of solid cells maximises walls: every solid cell skirts on
    // all four sides, which is far past the one-row guess the buffer starts at.
    const { layer, chunk } = onlyChunk(0, (solid, cols, rows) => {
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) solid[j * cols + i] = (i + j) % 2 === 0 ? 1 : 0;
      }
    });
    const { surface, walls } = buildChunkArrays(layer, chunk);
    const solidCells = [...chunk.solid].filter((v) => v === 1).length;
    expect(surface?.positions.length).toBe(solidCells * 6 * 3);
    // Four skirts per solid cell, since no solid cell touches another.
    expect(walls?.positions.length).toBe(solidCells * 4 * 6 * 3);
  });
});

/** A one-chunk, one-material map, so a colour can be read off vertex zero. */
function cellOf(hex: number): number {
  for (const [table, index] of [
    [TERRAIN_COLORS, 0],
    [TERRAIN_CLIFF_COLORS, 1],
  ] as const) {
    for (const [material, pair] of Object.entries(table)) {
      const tone = pair.indexOf(hex);
      if (tone >= 0) return (MATERIAL_ORDER.indexOf(material as Material) * 2 + tone) * 2 + index;
    }
  }
  throw new Error(`no material for 0x${hex.toString(16)}`);
}

type Material = (typeof MATERIAL_ORDER)[number];
/** `TERRAIN_MATERIALS`' own order, which is what a cell index means. */
const MATERIAL_ORDER = TERRAIN_MATERIALS;

/**
 * One chunk of one layer, every cell the same material and tone.
 *
 * Built through `loadMap` rather than by hand, so the chunk under test is the
 * shape the real loader produces -- including the jittered corners and the
 * finite-difference normals, which is what a colour assertion would otherwise
 * be reading past.
 */
function onlyChunk(
  packed: number,
  edit?: (solid: Uint8Array, cols: number, rows: number) => void,
): { layer: MeshLayer; chunk: TerrainChunk } {
  const tone = Math.floor(packed / 2) % 2;
  const material = Math.floor(packed / 4);
  const cols = 4;
  const rows = 4;
  const cell = 22;
  const span = cols * cell;
  const doc: MapDocument = {
    version: MAP_VERSION,
    seed: 1,
    grid: { cellSize: cell, chunkCells: cols },
    arena: { minX: 0, minZ: 0, maxX: span, maxZ: span },
    layers: [
      {
        id: 'ground',
        seed: 1,
        origin: { x: 0, z: 0 },
        bounds: { minX: 0, minZ: 0, maxX: span, maxZ: span },
        baseY: -40,
        waterLevel: null,
        chunks: [
          {
            cx: 0,
            cz: 0,
            cols,
            rows,
            heights: Array.from({ length: (cols + 1) * (rows + 1) }, (_, i) => i % 3),
            solid: [1, cols * rows],
            materials: [material, cols * rows],
            tones: [tone, cols * rows],
            props: [],
            markers: [],
          },
        ],
      },
    ],
  };
  const loaded = loadMap(doc);
  const chunk = loaded.chunks[0];
  const layer = loaded.meshLayers[0];
  if (!chunk || !layer) throw new Error('no chunk');
  if (edit) edit(chunk.solid, chunk.cols, chunk.rows);
  return { layer, chunk };
}
