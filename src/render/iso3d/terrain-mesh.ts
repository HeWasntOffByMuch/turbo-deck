import * as THREE from 'three';
import {
  DEFAULT_CHUNK_OPTIONS,
  layerCellSolid,
  sampleLayer,
  TERRAIN_MATERIALS,
  rectDepth,
  rectWidth,
  type ChunkOptions,
  type MeshLayer,
  type TerrainChunk,
  type TerrainWorld,
} from '../../terrain/index.js';
import { TERRAIN_CLIFF_COLORS, TERRAIN_COLORS } from './palette.js';

/**
 * The only thing that turns terrain data into geometry (spec 043). Everything
 * above it in `src/terrain/` is pure and headless; everything here is meshes.
 * There are no terrain *rules* in this file -- it never decides what the ground
 * is, only how to draw what it was told.
 *
 * Per chunk it emits two vertex-coloured geometries:
 *
 * - the **surface**, one quad per solid cell, all six vertices sharing that
 *   cell's single colour. The quads are irregular four-sided patches, because
 *   the sampler jitters every corner off the lattice, and they are shaded from
 *   the corners' *smooth* normals rather than per triangle. Between them those
 *   two things dissolve the grid: the ground reads as one continuous surface
 *   with hard-edged colour bands, instead of a quilt of shaded diamonds.
 * - the **walls**, a vertical skirt dropped from every edge where a solid cell
 *   meets open air or the layer's boundary. This is what gives a coastline, a
 *   cliff, or (later) a floating island a solid side instead of a paper edge.
 *   These *are* flat-shaded: a cliff face should read as stone slabs.
 *
 * Plus one translucent plane per layer that declares a water level. It sits at
 * that height across the whole layer and is simply hidden by any ground above
 * it, so a lake, a sea and a flooded crater all come out of the same quad.
 */

const surfaceMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
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
  /**
   * The land surfaces, for raycasting the cursor onto the ground. A stable array
   * instance: `rebuild` edits it in place, so a caller may capture it once.
   */
  readonly pickTargets: THREE.Object3D[];
  /**
   * Replace one chunk's geometry, disposing what it replaces (spec 050). This is
   * what makes a brush stroke affordable: a drag re-meshes the handful of chunks
   * under it, not all 56.
   */
  rebuild(chunk: TerrainChunk): void;
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

/**
 * A corner of a quad: its world position, plus the smooth normal the surface has
 * there. Walls pass no normal and get flat ones computed for them.
 */
type Corner = readonly [x: number, y: number, z: number, nx?: number, ny?: number, nz?: number];

/** Accumulates triangles for one geometry. */
class MeshBuffer {
  readonly positions: number[] = [];
  readonly colors: number[] = [];
  readonly normals: number[] = [];

  private vertex(v: Corner, c: THREE.Color): void {
    this.positions.push(v[0], v[1], v[2]);
    this.colors.push(c.r, c.g, c.b);
    this.normals.push(v[3] ?? 0, v[4] ?? 0, v[5] ?? 0);
  }

  /** A quad as two triangles, wound a-b-c / a-c-d. */
  quad(a: Corner, b: Corner, c: Corner, d: Corner, color: THREE.Color): void {
    this.vertex(a, color);
    this.vertex(b, color);
    this.vertex(c, color);
    this.vertex(a, color);
    this.vertex(c, color);
    this.vertex(d, color);
  }

  /** `smooth` geometries carry the normals they were given; the rest derive flat ones. */
  build(smooth: boolean): THREE.BufferGeometry | null {
    if (this.positions.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    if (smooth) geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    else geo.computeVertexNormals();
    return geo;
  }
}

/**
 * Mesh one chunk. Neighbour solidity is asked of the *layer*, not the chunk, so
 * a chunk seam is not mistaken for a coastline -- otherwise every chunk boundary
 * would grow a wall down the middle of open ground.
 */
function buildChunk(
  layer: MeshLayer,
  chunk: TerrainChunk,
): { surface: THREE.BufferGeometry | null; walls: THREE.BufferGeometry | null } {
  const surface = new MeshBuffer();
  const walls = new MeshBuffer();
  const { cols, rows, heights, cornerX, cornerZ, normals, solid, materials, tones, baseY } = chunk;
  const stride = cols + 1;

  /** The jittered corner (i, j), carrying the surface normal the field has there. */
  const corner = (i: number, j: number): Corner => {
    const k = j * stride + i;
    return [
      cornerX[k] ?? 0,
      heights[k] ?? 0,
      cornerZ[k] ?? 0,
      normals[k * 3] ?? 0,
      normals[k * 3 + 1] ?? 1,
      normals[k * 3 + 2] ?? 0,
    ];
  };

  const solidAt = (i: number, j: number): boolean =>
    i >= 0 && j >= 0 && i < cols && j < rows
      ? solid[j * cols + i] === 1
      : layer.solidAt(chunk.startCol + i, chunk.startRow + j);

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (solid[k] !== 1) continue;

      const material = TERRAIN_MATERIALS[materials[k] ?? 0] ?? 'grass';
      const pair = TERRAIN_COLORS[material];
      const tone = tones[k] === 1 ? 1 : 0;
      const color = linearColor(pair[tone] ?? pair[0]);

      const c00 = corner(i, j);
      const c10 = corner(i + 1, j);
      const c01 = corner(i, j + 1);
      const c11 = corner(i + 1, j + 1);

      // Wound so the face normal points +Y (up) for the flat case.
      surface.quad(c00, c01, c11, c10, color);

      // Skirt every edge that faces open air, dropped to the layer's underside.
      const cliff = linearColor(TERRAIN_CLIFF_COLORS[tone] ?? TERRAIN_CLIFF_COLORS[0]);
      const wall = (a: Corner, b: Corner): void => {
        walls.quad(a, b, [b[0], baseY, b[2]], [a[0], baseY, a[2]], cliff);
      };
      if (!solidAt(i - 1, j)) wall(c00, c01);
      if (!solidAt(i + 1, j)) wall(c10, c11);
      if (!solidAt(i, j - 1)) wall(c00, c10);
      if (!solidAt(i, j + 1)) wall(c01, c11);
    }
  }

  return { surface: surface.build(true), walls: walls.build(false) };
}

/** The layer's water surface: one flat translucent quad at its flood level. */
function buildWater(layer: MeshLayer): THREE.Mesh | null {
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
 * Mesh a set of already-sampled chunks. This is the seam the map editor enters
 * through (spec 048): the mesher no longer decides *when* chunks are produced,
 * only how to draw the ones it is handed -- so the same code path draws a world
 * sampled from a feature list and one loaded out of a map document, and one day
 * a single chunk rebuilt under a brush.
 *
 * Chunks are matched to their layer by `layerId`; a chunk naming a layer that
 * was not supplied is skipped rather than guessed at.
 */
export function buildTerrainMeshFromChunks(
  layers: readonly MeshLayer[],
  chunks: readonly TerrainChunk[],
): TerrainMeshHandle {
  const group = new THREE.Group();
  // Captured once by callers and then held, so `rebuild` must mutate this exact
  // array rather than replace it -- a swapped array leaves a scene raycasting
  // against geometry that has since been disposed.
  const pickTargets: THREE.Object3D[] = [];
  const materials: THREE.Material[] = [];
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  /** The meshes currently drawn for each chunk, so one can be replaced. */
  const drawn = new Map<string, { surface: THREE.Mesh | null; walls: THREE.Mesh | null }>();
  const slotKey = (chunk: TerrainChunk): string => `${chunk.layerId}:${chunk.coord.cx},${chunk.coord.cz}`;

  /** Build (or rebuild) one chunk's meshes into the group. */
  const draw = (layer: MeshLayer, chunk: TerrainChunk): void => {
    const key = slotKey(chunk);
    const previous = drawn.get(key);
    if (previous) {
      for (const mesh of [previous.surface, previous.walls]) {
        if (!mesh) continue;
        group.remove(mesh);
        mesh.geometry.dispose();
      }
      const stale = previous.surface ? pickTargets.indexOf(previous.surface) : -1;
      if (stale >= 0) pickTargets.splice(stale, 1);
    }

    const { surface, walls } = buildChunk(layer, chunk);
    const slot: { surface: THREE.Mesh | null; walls: THREE.Mesh | null } = { surface: null, walls: null };
    if (surface) {
      // Ground both takes shadows and throws them (spec 045): a cliff casting
      // its own shape onto the shelf below is most of what makes a terrace
      // read as a step rather than a stripe. Water does neither -- a shadow
      // on a translucent plane reads as dirt floating on it.
      slot.surface = new THREE.Mesh(surface, surfaceMaterial);
      slot.surface.castShadow = true;
      slot.surface.receiveShadow = true;
      group.add(slot.surface);
      pickTargets.push(slot.surface);
    }
    if (walls) {
      slot.walls = new THREE.Mesh(walls, wallMaterial);
      slot.walls.castShadow = true;
      slot.walls.receiveShadow = true;
      group.add(slot.walls);
    }
    drawn.set(key, slot);
  };

  for (const layer of layers) {
    for (const chunk of chunks) {
      if (byId.get(chunk.layerId) !== layer) continue;
      draw(layer, chunk);
    }
    const water = buildWater(layer);
    if (water) {
      group.add(water);
      materials.push(water.material as THREE.Material);
    }
  }

  return {
    group,
    pickTargets,
    rebuild(chunk: TerrainChunk): void {
      const layer = byId.get(chunk.layerId);
      if (layer) draw(layer, chunk);
    },
    dispose(): void {
      for (const child of group.children) {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      }
      for (const mat of materials) mat.dispose();
      drawn.clear();
      pickTargets.length = 0;
      group.clear();
    },
  };
}

/**
 * Sample and mesh every layer of a world -- the procedural path, unchanged in
 * what it produces. It now goes through `buildTerrainMeshFromChunks`, so the
 * generated world and a loaded document are drawn by exactly the same code.
 */
export function buildTerrainMesh(
  world: TerrainWorld,
  opt: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): TerrainMeshHandle {
  return buildTerrainMeshFromChunks(
    world.layers.map((layer) => ({
      id: layer.id,
      bounds: layer.bounds,
      waterLevel: layer.waterLevel,
      solidAt: (col: number, row: number): boolean => layerCellSolid(layer, col, row, opt),
    })),
    world.layers.flatMap((layer) => sampleLayer(layer, opt)),
  );
}
