import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createLayer,
  createWorld,
  exportMap,
  loadMap,
  parseMap,
  serializeMap,
  type ChunkOptions,
  type MapRect,
  type Rect,
  type TerrainWorld,
} from '../../terrain/index.js';
import { buildTerrainMesh, buildTerrainMeshFromChunks } from './terrain-mesh.js';

/**
 * The acceptance test for spec 048, and the reason the mesher was split in two:
 * a map that has been written out and read back has to *draw* the same, not just
 * hold the same numbers. So this meshes the generated world and the reloaded
 * document through the same code and compares the geometry vertex for vertex --
 * which is as close to "the render is identical" as anything headless gets, and
 * unlike a screenshot it says which vertex, on which chunk, went wrong.
 *
 * No WebGL involved: `BufferGeometry` is plain typed arrays, so this runs in
 * Node like the rest of the suite.
 */

const BOUNDS: Rect = { minX: -200, minZ: -200, maxX: 280, maxZ: 200 };
const OPT: ChunkOptions = { cellSize: 20, chunkCells: 8 };
const ARENA: MapRect = { minX: 0, minZ: 0, maxX: 200, maxZ: 160 };

function testWorld(): TerrainWorld {
  return createWorld([
    createLayer({
      id: 'ground',
      bounds: BOUNDS,
      baseY: -100,
      waterLevel: -40,
      seed: 7,
      features: [
        { kind: 'rolling', amplitude: 20 },
        { kind: 'hill', x: 0, z: 0, radius: 160, edge: 90, height: 120 },
        // An island mask, so the run carries genuine coastlines -- the skirt
        // walls are where a mismatched neighbour lookup would show up.
        { kind: 'islandMask', x: -60, z: 0, radius: 190, edge: 40 },
      ],
      terrace: { step: 30, strength: 0.5 },
    }),
  ]);
}

/** Every mesh under a group, in scene-graph order. */
function meshes(group: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) out.push(child);
  });
  return out;
}

function attribute(mesh: THREE.Mesh, name: string): Float32Array | null {
  const attr = (mesh.geometry as THREE.BufferGeometry).getAttribute(name);
  return attr ? (attr.array as Float32Array) : null;
}

describe('a reloaded map draws the same scene', () => {
  const world = testWorld();
  const doc = exportMap({ world, props: [], seed: 7, arena: ARENA, options: OPT });
  const loaded = loadMap(parseMap(serializeMap(doc)));

  const generated = buildTerrainMesh(world, OPT);
  const reloaded = buildTerrainMeshFromChunks(loaded.meshLayers, loaded.chunks);

  it('emits the same meshes in the same order', () => {
    const a = meshes(generated.group);
    const b = meshes(reloaded.group);
    expect(b).toHaveLength(a.length);
    expect(a.length).toBeGreaterThan(4);
    // Same triangle counts, mesh for mesh: a lost skirt or an extra quad shows
    // up here before any of the per-vertex comparisons below.
    expect(b.map((m) => attribute(m, 'position')?.length)).toEqual(
      a.map((m) => attribute(m, 'position')?.length),
    );
  });

  it('offers the same surfaces to the cursor raycast', () => {
    expect(reloaded.pickTargets).toHaveLength(generated.pickTargets.length);
    expect(generated.pickTargets.length).toBeGreaterThan(0);
  });

  it('places every vertex within the height quantum', () => {
    const a = meshes(generated.group);
    const b = meshes(reloaded.group);
    let vertices = 0;
    let worstY = 0;
    a.forEach((mesh, i) => {
      const from = attribute(mesh, 'position');
      const to = attribute(b[i] as THREE.Mesh, 'position');
      if (!from || !to) return;
      for (let k = 0; k < from.length; k += 3) {
        // X and Z are rebuilt from the same jitter hash, so they are exact.
        expect(to[k]).toBe(from[k]);
        expect(to[k + 2]).toBe(from[k + 2]);
        worstY = Math.max(worstY, Math.abs((to[k + 1] ?? 0) - (from[k + 1] ?? 0)));
        vertices++;
      }
    });
    expect(vertices).toBeGreaterThan(1000);
    // Heights are stored at 1e-3, so half of that is the whole budget: a
    // sub-millimetre shift on a world measured in hundreds of units.
    expect(worstY).toBeLessThanOrEqual(5e-4);
  });

  it('paints every vertex the same colour', () => {
    const a = meshes(generated.group);
    const b = meshes(reloaded.group);
    a.forEach((mesh, i) => {
      const from = attribute(mesh, 'color');
      const to = attribute(b[i] as THREE.Mesh, 'color');
      if (!from || !to) return;
      // Material index and tone are stored exactly, so the palette lookup on the
      // other side must land on the identical colour -- not merely a close one.
      expect([...to]).toEqual([...from]);
    });
  });

  it('shades every vertex the same way, except on the world\'s outermost ring', () => {
    const a = meshes(generated.group);
    const b = meshes(reloaded.group);
    let worstInside = 0;
    let worstRim = 0;
    let inside = 0;
    let rim = 0;

    a.forEach((mesh, i) => {
      const from = attribute(mesh, 'normal');
      const to = attribute(b[i] as THREE.Mesh, 'normal');
      const at = attribute(mesh, 'position');
      if (!from || !to || !at) return;
      for (let v = 0; v * 3 < from.length; v++) {
        const x = at[v * 3] ?? 0;
        const z = at[v * 3 + 2] ?? 0;
        // A corner within a cell of the bounds is one whose apron falls outside
        // the layer. That apron is the only thing a bake cannot reconstruct: the
        // sampler read the *field* one cell past the edge, and a stored lattice
        // has nothing there but the slope running into it. Everywhere else the
        // apron is real stored data and the normals must agree.
        const onRim =
          x < BOUNDS.minX + OPT.cellSize ||
          x > BOUNDS.maxX - OPT.cellSize ||
          z < BOUNDS.minZ + OPT.cellSize ||
          z > BOUNDS.maxZ - OPT.cellSize;
        let gap = 0;
        for (let c = 0; c < 3; c++) gap = Math.max(gap, Math.abs((to[v * 3 + c] ?? 0) - (from[v * 3 + c] ?? 0)));
        if (onRim) {
          worstRim = Math.max(worstRim, gap);
          rim++;
        } else {
          worstInside = Math.max(worstInside, gap);
          inside++;
        }
      }
    });

    expect(inside).toBeGreaterThan(1000);
    expect(worstInside).toBeLessThan(1e-3);
    // The rim is the far edge of the world's bleed, well over a thousand units
    // past anywhere the player stands and mostly hidden behind its own skirt.
    // It is a bounded shading difference, not a hole: bounded here so a real
    // regression cannot hide inside the exemption.
    expect(rim / (rim + inside)).toBeLessThan(0.25);
    expect(worstRim).toBeLessThan(0.15);
  });

  it('keeps the water plane where it was', () => {
    const water = (group: THREE.Object3D): THREE.Mesh | undefined =>
      meshes(group).find((m) => (m.material as THREE.Material).transparent);
    const from = water(generated.group);
    const to = water(reloaded.group);
    expect(from).toBeDefined();
    expect(to?.position.toArray()).toEqual(from?.position.toArray());
  });
});
