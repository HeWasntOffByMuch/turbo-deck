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
  layer: TerrainLayer,
  chunk: TerrainChunk,
  opt: ChunkOptions,
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
      : layerCellSolid(layer, chunk.startCol + i, chunk.startRow + j, opt);

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
        // Ground both takes shadows and throws them (spec 045): a cliff casting
        // its own shape onto the shelf below is most of what makes a terrace
        // read as a step rather than a stripe. Water does neither -- a shadow
        // on a translucent plane reads as dirt floating on it.
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
        pickTargets.push(mesh);
        geometries.push(surface);
      }
      if (walls) {
        const mesh = new THREE.Mesh(walls, wallMaterial);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
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
