import * as THREE from 'three';
import {
  DEFAULT_CHUNK_OPTIONS,
  layerCellSolid,
  materialAtPoint,
  materialIndex,
  rectContains,
  sampleLayer,
  type ChunkOptions,
  type MeshLayer,
  type TerrainChunk,
  type TerrainWorld,
} from '../../terrain/index.js';
import { shoreField } from './shore-sdf.js';
import {
  buildChunkArrays,
  type ChunkFootprint,
  type ChunkMeshArrays,
  type MeshArrays,
} from './terrain-arrays.js';
import { WATER } from './wind.js';
import { buildWaterQuad, disposeWaterQuad } from './water-material.js';
import { patchTerrainStreak } from './terrain-streak.js';
import { patchTerrainCurvature } from './terrain-curvature.js';
import { patchTerrainDetail } from './terrain-detail.js';

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
 * - the **water**, one opaque quad at the layer's flood level per chunk that
 *   has any water cell in it (spec 074). It used to be a single translucent
 *   plane spanning the whole layer; it is per chunk now because each one needs
 *   its own shore distance field bound to it, and because a quad that is culled
 *   with its chunk is a quad that is not drawn when its chunk is off screen.
 *   Being opaque is what shapes the coastline: every scrap of land is above the
 *   water line and simply occludes it.
 *
 * Both ground materials carry the wind's streak layer (spec 074), from the same
 * clock and the same direction the trees lean and the water churns to.
 */

const surfaceMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
// Walls are double-sided so a skirt reads correctly whichever way its edge runs;
// with `flatShading` the shader flips the normal for back faces, so lighting holds.
const wallMaterial = new THREE.MeshLambertMaterial({
  vertexColors: true,
  flatShading: true,
  side: THREE.DoubleSide,
});
patchTerrainStreak(surfaceMaterial);
patchTerrainStreak(wallMaterial);
// Only the surface. The walls are flat vertical skirts with no curvature to
// measure, and a material that reads a `cavity` attribute the geometry does not
// carry is a GL error rather than a zero (spec 104).
patchTerrainCurvature(surfaceMaterial);
// Both ground materials (spec 106). The cliff wall is the surface that most
// needs it -- a tall vertical face in a single tone reads as a cut-out -- and it
// is also the one a ground-plane UV would smear, which is why the projection is
// triplanar.
patchTerrainDetail(surfaceMaterial);
patchTerrainDetail(wallMaterial);

/** The material index water cells carry, resolved once. */
const WATER_MATERIAL = materialIndex('water');

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
  /**
   * Draw a chunk whose triangles were built elsewhere (spec 180).
   *
   * The counterpart to `rebuild` for a client whose mesher is on a worker: same
   * drawing, same seam re-bake, without the 3.4ms of arithmetic in front of it.
   * False when the layer is unknown -- a payload for ground this mesher was
   * never told about is dropped rather than guessed at, exactly as `rebuild`
   * silently draws nothing for one.
   */
  adopt(chunk: ChunkFootprint, arrays: ChunkMeshArrays): boolean;
  /**
   * Drop one chunk's geometry, for ground that has stopped existing (spec 085).
   *
   * The counterpart to `rebuild`: removing a map part deletes chunks, and
   * without this the only way to stop drawing them was to rebuild every mesh in
   * the world. Returns false if nothing was drawn there.
   */
  remove(layerId: string, cx: number, cz: number): boolean;
  /**
   * Teach the mesh a layer that was not there when it was built (spec 123).
   *
   * The layer set used to be fixed at construction, which was true for as long
   * as a map's layers were. Drawing a tier adds one to the store mid-session,
   * and `rebuild` silently draws nothing for a chunk whose layer it has never
   * heard of -- so the formation would be walked on and collided with and
   * simply not be visible. Replacing an id already known re-points it, which is
   * what an undo that puts a layer back needs.
   */
  addLayer(layer: MeshLayer): void;
  /** Forget a layer and drop everything drawn for it. Returns false if unknown. */
  removeLayer(layerId: string): boolean;
  /** Which layers are currently drawable, so a caller can reconcile against a store. */
  layerIds(): string[];
  dispose(): void;
}

/**
 * Vertex arrays as a geometry.
 *
 * `THREE.BufferAttribute` rather than `Float32BufferAttribute`, which is not a
 * style choice: the latter's constructor is `new Float32Array( array )`, so it
 * copies every attribute it is handed. These arrays arrive already sized and,
 * off a worker, already transferred -- copying 185KB per chunk to wrap them
 * would put back a good fraction of what moving the build saved.
 *
 * A null `normals` means flat shading, and three computes those here where it
 * always did. See `terrain-arrays.ts` for why that one thing did not move.
 */
function geometryFrom(arrays: MeshArrays | null): THREE.BufferGeometry | null {
  if (!arrays) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(arrays.colors, 3));
  if (arrays.normals) geo.setAttribute('normal', new THREE.BufferAttribute(arrays.normals, 3));
  else geo.computeVertexNormals();
  if (arrays.cavities) geo.setAttribute('cavity', new THREE.BufferAttribute(arrays.cavities, 1));
  return geo;
}

/**
 * One chunk's water surface, or null where the chunk has no water in it (or the
 * layer never floods).
 *
 * The shore field is baked here, from the *layer's* per-cell materials rather
 * than the chunk's own array: a coastline a few cells into the next chunk still
 * colours this one, so the distance transform has to read past the chunk's edge
 * or the boundary becomes a visible seam. Where the neighbour has not streamed
 * in yet, `materialAt` answers null and the transform treats it as water --
 * which can only ever make this chunk's sea look deeper, never invent a shore
 * that disappears when the neighbour lands.
 */
function buildWater(layer: MeshLayer, chunk: ChunkFootprint): THREE.Mesh | null {
  if (layer.waterLevel === null) return null;
  let wet = false;
  for (const material of chunk.materials) {
    if (material === WATER_MATERIAL) {
      wet = true;
      break;
    }
  }
  if (!wet) return null;

  const field = shoreField(
    (col, row) => {
      const material = layer.materialAt(col, row);
      return material === null ? null : material === WATER_MATERIAL;
    },
    {
      startCol: chunk.startCol,
      startRow: chunk.startRow,
      cols: chunk.cols,
      rows: chunk.rows,
      cellSize: chunk.cellSize,
      range: WATER.shoreRange,
    },
  );

  return buildWaterQuad({
    originX: chunk.originX,
    originZ: chunk.originZ,
    width: chunk.cols * chunk.cellSize,
    depth: chunk.rows * chunk.cellSize,
    waterLevel: layer.waterLevel,
    cellSize: chunk.cellSize,
    field,
  });
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
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  /** What is currently drawn for each chunk, so one can be replaced. */
  interface Slot {
    surface: THREE.Mesh | null;
    walls: THREE.Mesh | null;
    water: THREE.Mesh | null;
    /**
     * Kept so a neighbour's arrival can re-bake this chunk's shore field.
     *
     * The footprint rather than the whole chunk (spec 180): once the triangles
     * exist, the only thing still wanted from a chunk is what its water needs,
     * and off a worker the vertex arrays are all that came back.
     */
    readonly chunk: ChunkFootprint;
  }
  const drawn = new Map<string, Slot>();
  const keyOf = (layerId: string, cx: number, cz: number): string => `${layerId}:${cx},${cz}`;
  const slotKey = (chunk: ChunkFootprint): string => keyOf(chunk.layerId, chunk.coord.cx, chunk.coord.cz);

  /** Replace one chunk's water quad, disposing whatever it replaces. */
  const drawWater = (layer: MeshLayer, slot: Slot): void => {
    if (slot.water) {
      group.remove(slot.water);
      disposeWaterQuad(slot.water);
    }
    slot.water = buildWater(layer, slot.chunk);
    if (slot.water) group.add(slot.water);
  };

  /**
   * Draw (or redraw) one chunk's meshes into the group, from vertex arrays
   * somebody else built.
   *
   * Split from the building in spec 180. What is left here is the part that
   * needs the scene graph -- disposing what was there, wrapping the arrays,
   * hanging the meshes on the group, and re-baking the shore fields either side
   * of the seam -- and it is 0.025ms against the 3.4ms the build is.
   */
  const draw = (layer: MeshLayer, chunk: ChunkFootprint, arrays: ChunkMeshArrays): void => {
    const key = slotKey(chunk);
    const previous = drawn.get(key);
    if (previous) {
      for (const mesh of [previous.surface, previous.walls]) {
        if (!mesh) continue;
        group.remove(mesh);
        mesh.geometry.dispose();
      }
      if (previous.water) {
        group.remove(previous.water);
        disposeWaterQuad(previous.water);
      }
      const stale = previous.surface ? pickTargets.indexOf(previous.surface) : -1;
      if (stale >= 0) pickTargets.splice(stale, 1);
    }

    const surface = geometryFrom(arrays.surface);
    const walls = geometryFrom(arrays.walls);
    const slot: Slot = { surface: null, walls: null, water: null, chunk };
    if (surface) {
      // Ground both takes shadows and throws them (spec 045): a cliff casting
      // its own shape onto the shelf below is most of what makes a terrace
      // read as a step rather than a stripe. Water does neither -- a shadow on
      // a flat stylized surface reads as dirt floating on it.
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
    drawWater(layer, slot);

    // A shore three cells over the boundary colours the water on *both* sides
    // of it, so the neighbours' fields were baked against ground that has only
    // now arrived and are wrong until they see it (spec 074). Re-baking eight
    // small distance transforms is what closes the seam a streaming client
    // would otherwise show for as long as its neighbour was missing; nothing is
    // re-meshed, only the water.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const neighbour = drawn.get(keyOf(chunk.layerId, chunk.coord.cx + dx, chunk.coord.cz + dz));
        if (neighbour) drawWater(layer, neighbour);
      }
    }
  };

  for (const layer of layers) {
    for (const chunk of chunks) {
      if (byId.get(chunk.layerId) !== layer) continue;
      draw(layer, chunk, buildChunkArrays(layer, chunk));
    }
  }

  /** Free one chunk's meshes and forget it, the inverse of `draw` (spec 085). */
  const erase = (layerId: string, cx: number, cz: number): boolean => {
    const key = keyOf(layerId, cx, cz);
    const slot = drawn.get(key);
    if (!slot) return false;
    for (const mesh of [slot.surface, slot.walls]) {
      if (!mesh) continue;
      group.remove(mesh);
      mesh.geometry.dispose();
    }
    if (slot.water) {
      group.remove(slot.water);
      disposeWaterQuad(slot.water);
    }
    const stale = slot.surface ? pickTargets.indexOf(slot.surface) : -1;
    if (stale >= 0) pickTargets.splice(stale, 1);
    drawn.delete(key);

    // The neighbours' shore fields were baked against ground that has just
    // gone, exactly as `draw` re-bakes them against ground that has just
    // arrived. Same eight distance transforms, opposite direction.
    const layer = byId.get(layerId);
    if (layer) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const neighbour = drawn.get(keyOf(layerId, cx + dx, cz + dz));
          if (neighbour) drawWater(layer, neighbour);
        }
      }
    }
    return true;
  };

  return {
    group,
    pickTargets,
    rebuild(chunk: TerrainChunk): void {
      const layer = byId.get(chunk.layerId);
      if (layer) draw(layer, chunk, buildChunkArrays(layer, chunk));
    },
    adopt(chunk: ChunkFootprint, arrays: ChunkMeshArrays): boolean {
      const layer = byId.get(chunk.layerId);
      if (!layer) return false;
      draw(layer, chunk, arrays);
      return true;
    },
    remove: erase,
    addLayer(layer: MeshLayer): void {
      byId.set(layer.id, layer);
    },
    removeLayer(layerId: string): boolean {
      if (!byId.delete(layerId)) return false;
      // Everything drawn for it goes with it, or a tier that was carved away
      // keeps its geometry in the scene with nothing behind it.
      for (const key of [...drawn.keys()]) {
        const slot = drawn.get(key);
        if (slot?.chunk.layerId === layerId) erase(layerId, slot.chunk.coord.cx, slot.chunk.coord.cz);
      }
      return true;
    },
    layerIds(): string[] {
      return [...byId.keys()];
    },
    dispose(): void {
      // Water owns a material and a shore texture of its own, so it is freed
      // first and taken out of the group; the surface and wall materials are
      // shared module singletons and are deliberately *not* disposed here.
      for (const slot of drawn.values()) {
        if (!slot.water) continue;
        group.remove(slot.water);
        disposeWaterQuad(slot.water);
      }
      for (const child of group.children) {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      }
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
      // The generated path has no stored cells to look up, so the material is
      // re-derived from the field at the cell's centre -- the same classify()
      // the sampler ran. Past the layer's edge it answers null, matching what a
      // loaded map says about a chunk it does not hold: the shore field then
      // reads open water there rather than a wall of land, so the world's
      // border does not grow a rim of foam.
      materialAt: (col: number, row: number): number | null => {
        const x = layer.bounds.minX + (col + 0.5) * opt.cellSize;
        const z = layer.bounds.minZ + (row + 0.5) * opt.cellSize;
        if (!rectContains(layer.bounds, x, z)) return null;
        return materialIndex(materialAtPoint(layer, x, z, opt.bands));
      },
    })),
    world.layers.flatMap((layer) => sampleLayer(layer, opt)),
  );
}
