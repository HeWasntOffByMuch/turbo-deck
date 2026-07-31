import * as THREE from 'three';
import {
  DEFAULT_CHUNK_OPTIONS,
  layerCellSolid,
  sampleLayer,
  TERRAIN_MATERIALS,
  rectDepth,
  rectWidth,
  type ChunkOptions,
  type TerrainChunk,
  type TerrainLayer,
  type TerrainWorld,
} from '../../terrain/index.js';
import { TERRAIN_CLIFF_COLORS, TERRAIN_COLORS } from './palette.js';

/**
 * The only thing that turns terrain data into geometry (spec 043). Everything
 * above it in `src/terrain/` is pure and headless; everything here is meshes.
 * There are no terrain *rules* in this file -- it never decides what the ground
 * is, only how to draw what it was told.
 *
 * Per chunk it emits two flat-shaded, vertex-coloured geometries:
 *
 * - the **surface**, one quad per solid cell, all six vertices sharing that
 *   cell's single colour. Corner heights are shared between neighbouring cells,
 *   so the surface is continuous while the colours stay hard-edged -- which is
 *   the whole art direction: readable bands, not blended texture.
 * - the **walls**, a vertical skirt dropped from every edge where a solid cell
 *   meets open air or the layer's boundary. This is what gives a coastline, a
 *   cliff, or (later) a floating island a solid side instead of a paper edge.
 *
 * Plus one translucent plane per layer that declares a water level. It sits at
 * that height across the whole layer and is simply hidden by any ground above
 * it, so a lake, a sea and a flooded crater all come out of the same quad.
 */

const surfaceMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
// Walls are double-sided so a skirt reads correctly whichever way its edge runs;
// with `flatShading` the shader flips the normal for back faces, so lighting holds.
const wallMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
  side: THREE.DoubleSide,
});

export interface TerrainMeshHandle {
  /** Add this to the scene. Positioned in world space; do not move it. */
  readonly group: THREE.Group;
  /** The land surfaces, for raycasting the cursor onto the ground. */
  readonly pickTargets: THREE.Object3D[];
  dispose(): void;
}

/** Linear RGB for a palette hex, matching what a plain flat material would show. */
const colorCache = new Map<number, THREE.Color>();
function linearColor(hex: number): THREE.Color {
  let c = colorCache.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    colorCache.set(hex, c);
  }
  return c;
}

/** Accumulates triangles for one geometry. */
class MeshBuffer {
  readonly positions: number[] = [];
  readonly colors: number[] = [];

  vertex(x: number, y: number, z: number, c: THREE.Color): void {
    this.positions.push(x, y, z);
    this.colors.push(c.r, c.g, c.b);
  }

  /** A quad as two triangles, wound a-b-c / a-c-d. */
  quad(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    color: THREE.Color,
  ): void {
    this.vertex(a[0], a[1], a[2], color);
    this.vertex(b[0], b[1], b[2], color);
    this.vertex(c[0], c[1], c[2], color);
    this.vertex(a[0], a[1], a[2], color);
    this.vertex(c[0], c[1], c[2], color);
    this.vertex(d[0], d[1], d[2], color);
  }

  build(): THREE.BufferGeometry | null {
    if (this.positions.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geo.computeVertexNormals();
    return geo;
  }
}

/**
 * Mesh one chunk. Neighbour solidity is asked of the *layer*, not the chunk, so
 * a chunk seam is not mistaken for a coastline -- otherwise every chunk boundary
 * would grow a wall down the middle of open ground.
 */
function buildChunk(
  layer: TerrainLayer,
  chunk: TerrainChunk,
  opt: ChunkOptions,
): { surface: THREE.BufferGeometry | null; walls: THREE.BufferGeometry | null } {
  const surface = new MeshBuffer();
  const walls = new MeshBuffer();
  const { cols, rows, cellSize: size, heights, solid, materials, tones, originX, originZ, baseY } = chunk;
  const stride = cols + 1;

  const solidAt = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < cols && j < rows
      ? solid[j * cols + i] === 1
      : layerCellSolid(layer, chunk.startCol + i, chunk.startRow + j, opt);

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (solid[k] !== 1) continue;

      const material = TERRAIN_MATERIALS[materials[k] ?? 0] ?? 'grass';
      const pair = TERRAIN_COLORS[material];
      const tone = tones[k] === 1 ? 1 : 0;
      const color = linearColor(pair[tone] ?? pair[0]);

      const x0 = originX + i * size;
      const x1 = x0 + size;
      const z0 = originZ + j * size;
      const z1 = z0 + size;
      const h00 = heights[j * stride + i] ?? 0;
      const h10 = heights[j * stride + i + 1] ?? 0;
      const h01 = heights[(j + 1) * stride + i] ?? 0;
      const h11 = heights[(j + 1) * stride + i + 1] ?? 0;

      // Wound so the face normal points +Y (up) for the flat case.
      surface.quad([x0, h00, z0], [x0, h01, z1], [x1, h11, z1], [x1, h10, z0], color);

      // Skirt every edge that faces open air, dropped to the layer's underside.
      const cliff = linearColor(TERRAIN_CLIFF_COLORS[tone] ?? TERRAIN_CLIFF_COLORS[0]);
      const wall = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => {
        walls.quad([ax, ay, az], [bx, by, bz], [bx, baseY, bz], [ax, baseY, az], cliff);
      };
      if (!solidAt(i - 1, j)) wall(x0, h00, z0, x0, h01, z1);
      if (!solidAt(i + 1, j)) wall(x1, h10, z0, x1, h11, z1);
      if (!solidAt(i, j - 1)) wall(x0, h00, z0, x1, h10, z0);
      if (!solidAt(i, j + 1)) wall(x0, h01, z1, x1, h11, z1);
    }
  }

  return { surface: surface.build(), walls: walls.build() };
}

/** The layer's water surface: one flat translucent quad at its flood level. */
function buildWater(layer: TerrainLayer): THREE.Mesh | null {
  if (layer.waterLevel === null) return null;
  const geo = new THREE.PlaneGeometry(rectWidth(layer.bounds), rectDepth(layer.bounds));
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({
      color: TERRAIN_COLORS.water[0],
      flatShading: true,
      transparent: true,
      opacity: 0.82,
    }),
  );
  mesh.position.set(
    (layer.bounds.minX + layer.bounds.maxX) / 2,
    layer.waterLevel,
    (layer.bounds.minZ + layer.bounds.maxZ) / 2,
  );
  return mesh;
}

/**
 * Sample and mesh every layer of a world. One-shot: the world is meshed at
 * startup and never edited, so there is no streaming or rebuild path yet --
 * chunks exist so that adding one later is a change of *when* `buildChunk` is
 * called, not of what it produces.
 */
export function buildTerrainMesh(
  world: TerrainWorld,
  opt: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): TerrainMeshHandle {
  const group = new THREE.Group();
  const pickTargets: THREE.Object3D[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  for (const layer of world.layers) {
    for (const chunk of sampleLayer(layer, opt)) {
      const { surface, walls } = buildChunk(layer, chunk, opt);
      if (surface) {
        const mesh = new THREE.Mesh(surface, surfaceMaterial);
        group.add(mesh);
        pickTargets.push(mesh);
        geometries.push(surface);
      }
      if (walls) {
        group.add(new THREE.Mesh(walls, wallMaterial));
        geometries.push(walls);
      }
    }
    const water = buildWater(layer);
    if (water) {
      group.add(water);
      geometries.push(water.geometry);
      materials.push(water.material as THREE.Material);
    }
  }

  return {
    group,
    pickTargets,
    dispose(): void {
      for (const geo of geometries) geo.dispose();
      for (const mat of materials) mat.dispose();
      group.clear();
    },
  };
}
