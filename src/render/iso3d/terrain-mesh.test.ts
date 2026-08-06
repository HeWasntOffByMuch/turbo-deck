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
import type { MapInfoMessage } from '../../server/net/map-messages.js';
import { ServerMessageType } from '../../server/net/protocol.js';
import type { HeldChunk } from '../../server/client/map-cache.js';
import { StreamedMap } from '../../server/client/streamed-map.js';
import { buildTerrainMesh, buildTerrainMeshFromChunks, type TerrainMeshHandle } from './terrain-mesh.js';

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

/**
 * The water quads under a group (spec 074). They are the only meshes here
 * carrying a `ShaderMaterial`; the ground and its skirts are Lambert.
 */
function waterQuads(group: THREE.Object3D): THREE.Mesh[] {
  return meshes(group).filter((m) => m.material instanceof THREE.ShaderMaterial);
}

/** One water quad's packed shore distance field. */
function shoreBytes(mesh: THREE.Mesh): number[] {
  const material = mesh.material as THREE.ShaderMaterial;
  const texture = material.uniforms['uShoreField']?.value as THREE.DataTexture;
  return [...(texture.image.data as unknown as Uint8Array)];
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

});

/**
 * The same round trip, over a world with a lake in it (spec 074).
 *
 * Its own world rather than the one above, because water needs ground that
 * actually falls below the flood line and the spec 048 fixture deliberately
 * does not have any -- and widening that fixture would quietly change what
 * every assertion in it is measuring.
 */
describe('a reloaded map draws the same water', () => {
  const world = createWorld([
    createLayer({
      id: 'ground',
      bounds: BOUNDS,
      baseY: -100,
      waterLevel: -40,
      seed: 11,
      features: [
        { kind: 'rolling', amplitude: 14 },
        // A bowl deep enough to flood, with a shore that crosses chunk seams.
        { kind: 'basin', x: 40, z: 0, radius: 170, edge: 70, depth: 90 },
      ],
    }),
  ]);
  const doc = exportMap({ world, props: [], seed: 11, arena: ARENA, options: OPT });
  const loaded = loadMap(parseMap(serializeMap(doc)));
  const generated = buildTerrainMesh(world, OPT);
  const reloaded = buildTerrainMeshFromChunks(loaded.meshLayers, loaded.chunks);

  it('puts the same quads over the same coastlines', () => {
    // One opaque quad per chunk that has any water in it, each carrying its own
    // shore distance field. Both halves have to match, or a reloaded map draws
    // its sea in different places -- or, worse, in the same places with the
    // shallows somewhere else.
    const from = waterQuads(generated.group);
    const to = waterQuads(reloaded.group);
    expect(from.length).toBeGreaterThan(0);
    expect(to.map((m) => m.position.toArray())).toEqual(from.map((m) => m.position.toArray()));
    expect(to.map(shoreBytes)).toEqual(from.map(shoreBytes));
  });

  it('skips the chunks that have no water in them', () => {
    // A quad per chunk regardless would be a full-screen overdraw of ocean
    // hidden behind hillsides, on a world that is mostly dry.
    const quads = waterQuads(generated.group);
    expect(quads.length).toBeLessThan(loaded.chunks.length);
  });

  it('stands every quad at the layer flood level, opaque', () => {
    for (const quad of waterQuads(generated.group)) {
      expect(quad.position.y).toBe(-40);
      const material = quad.material as THREE.Material;
      expect(material.transparent).toBe(false);
      expect(material.depthWrite).toBe(true);
      // A shadow on a flat stylized surface reads as dirt floating on it.
      expect(quad.castShadow).toBe(false);
      expect(quad.receiveShadow).toBe(false);
    }
  });

  it('reads one shared clock and one shared palette', () => {
    // Every chunk needs its own shore texture, so every chunk needs its own
    // material. What must *not* be per chunk is the weather or the palette:
    // those are shared uniform objects, so a second source of truth cannot be
    // introduced by writing to the wrong one.
    const quads = waterQuads(generated.group).map((q) => q.material as THREE.ShaderMaterial);
    expect(quads.length).toBeGreaterThan(1);
    const first = quads[0] as THREE.ShaderMaterial;
    for (const material of quads) {
      for (const shared of ['uWindTime', 'uDeep', 'uMid', 'uShallow', 'uFoam']) {
        expect(material.uniforms[shared]).toBe(first.uniforms[shared]);
      }
      // ...and one compiled program behind all of them, so the per-chunk
      // material costs a texture bind rather than a shader switch.
      expect(material.fragmentShader).toBe(first.fragmentShader);
    }
    // The shore field is the one thing that genuinely is per chunk.
    const fields = new Set(quads.map((m) => m.uniforms['uShoreField']));
    expect(fields.size).toBe(quads.length);
  });

  it('ends up where a whole-map bake would, however the chunks arrive', () => {
    // Acceptance criterion 5, the half a screenshot cannot answer: a streaming
    // client meshes chunks one at a time, and a chunk baked before its
    // neighbours landed saw open water where there is really a coast. The
    // mesher re-bakes a chunk's shore field when a neighbour arrives; this is
    // what says the re-bake is complete rather than merely present.
    //
    // Reversed arrival order, because a forward order accidentally satisfies
    // "re-bake the west and north neighbours" and hides a missing direction.
    const streamed = buildTerrainMeshFromChunks(loaded.meshLayers, []);
    for (const chunk of [...loaded.chunks].reverse()) streamed.rebuild(chunk);

    const key = (mesh: THREE.Mesh): string => mesh.position.toArray().join(',');
    const settled = new Map(waterQuads(streamed.group).map((q) => [key(q), shoreBytes(q)]));
    const wanted = new Map(waterQuads(reloaded.group).map((q) => [key(q), shoreBytes(q)]));
    expect(settled.size).toBe(wanted.size);
    for (const [where, bytes] of wanted) expect(settled.get(where)).toEqual(bytes);
    streamed.dispose();
  });

  it('never draws a shore further out than the settled one while streaming', () => {
    // The property that makes the re-bake safe to watch happen: an incomplete
    // neighbourhood reads as open water, so the sea can only ever *shallow* as
    // chunks land. A player watching the world stream in sees the shallows
    // arrive, never a beach that turns back into deep water.
    const streamed = buildTerrainMeshFromChunks(loaded.meshLayers, []);
    const settled = new Map(
      waterQuads(reloaded.group).map((q) => [q.position.toArray().join(','), shoreBytes(q)]),
    );
    for (const chunk of loaded.chunks) {
      streamed.rebuild(chunk);
      for (const quad of waterQuads(streamed.group)) {
        const target = settled.get(quad.position.toArray().join(','));
        if (!target) continue;
        shoreBytes(quad).forEach((byte, i) => {
          expect(byte).toBeGreaterThanOrEqual(target[i] ?? 0);
        });
      }
    }
    streamed.dispose();
  });

  it('shows shallows near the shore and deep water away from it', () => {
    // The field is the whole shape of the effect, so it is worth one assertion
    // that it is not simply saturated everywhere -- which is what a distance
    // transform that never found the coast would produce, and which draws as a
    // flat slab of the deep colour with no band at all.
    const bytes = waterQuads(generated.group).flatMap(shoreBytes);
    expect(Math.min(...bytes)).toBe(0);
    expect(Math.max(...bytes)).toBeGreaterThan(64);
  });
});

/**
 * The land half of the same question the water tests above ask (spec 078).
 *
 * A chunk's walls come from asking the layer about the cell across each edge,
 * and its corner normals from an apron one corner past it -- both of which read
 * the *neighbour's* arrays. Meshed while a neighbour was missing, a chunk grew a
 * full-height curtain along the seam and kept it, because nothing redrew it.
 *
 * Driven through the real `StreamedMap`, not by handing the mesher chunks built
 * from a complete store: the store's answers while it is still filling are half
 * of what went wrong, so a test that skips it would only cover the walls.
 */
describe('a map that streams in draws the same land', () => {
  const world = testWorld();
  const doc = parseMap(serializeMap(exportMap({ world, props: [], seed: 7, arena: ARENA, options: OPT })));
  const loaded = loadMap(doc);
  const settled = buildTerrainMeshFromChunks(loaded.meshLayers, loaded.chunks);

  const info: MapInfoMessage = {
    type: ServerMessageType.MapInfo,
    mapId: 'stream00',
    seed: doc.seed,
    cellSize: doc.grid.cellSize,
    chunkCells: doc.grid.chunkCells,
    arena: doc.arena,
    species: [],
    layers: doc.layers.map((l) => ({
      id: l.id,
      seed: l.seed,
      bounds: l.bounds,
      baseY: l.baseY,
      waterLevel: l.waterLevel,
      coords: l.chunks.map((c) => ({ cx: c.cx, cz: c.cz })),
    })),
  };
  const arrivals = (): HeldChunk[] =>
    doc.layers.flatMap((l, layer) => l.chunks.map((chunk) => ({ layer, cx: chunk.cx, cz: chunk.cz, chunk })));

  /** The ground and its skirts. Water is the other tests' subject. */
  const land = (group: THREE.Object3D): THREE.Mesh[] =>
    meshes(group).filter((m) => !(m.material instanceof THREE.ShaderMaterial));

  /** Skirt triangles only: the walls are the meshes with no supplied normal. */
  const wallTriangles = (group: THREE.Object3D): number =>
    land(group)
      .filter((m) => (m.material as THREE.Material & { flatShading?: boolean }).flatShading === true)
      .reduce((n, m) => n + (attribute(m, 'position')?.length ?? 0) / 9, 0);

  /** Every land vertex as position+normal, order-independent. */
  const vertices = (group: THREE.Object3D): string[] => {
    const out: string[] = [];
    for (const mesh of land(group)) {
      const p = attribute(mesh, 'position');
      const n = attribute(mesh, 'normal');
      if (!p) continue;
      for (let v = 0; v * 3 < p.length; v++) {
        out.push(
          `${p[v * 3]},${p[v * 3 + 1]},${p[v * 3 + 2]}|` +
            `${n?.[v * 3] ?? ''},${n?.[v * 3 + 1] ?? ''},${n?.[v * 3 + 2] ?? ''}`,
        );
      }
    }
    return out.sort();
  };

  /** Mesh a whole map through the streaming path, in the given arrival order. */
  const stream = (order: HeldChunk[]): { map: StreamedMap; handle: TerrainMeshHandle } => {
    const map = new StreamedMap(info);
    const handle = buildTerrainMeshFromChunks(map.meshLayers, []);
    for (const held of order) for (const chunk of map.add(held)) handle.rebuild(chunk);
    return { map, handle };
  };

  it('has seam coastlines to get wrong in the first place', () => {
    // The guard on every equality below: if this fixture had no open air across
    // a chunk boundary, "the walls match" would hold for a mesher that never
    // built a seam wall at all, and the deferral would look like a fix.
    const g = loaded.store.layerInfo('ground');
    if (!g) throw new Error('no ground layer');
    let seams = 0;
    for (let row = 0; row < g.grid.totalRows; row++) {
      for (let col = 0; col < g.grid.totalCols; col++) {
        if (!loaded.store.cellSolid('ground', col, row)) continue;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const crosses =
            Math.floor((col + dc) / OPT.chunkCells) !== Math.floor(col / OPT.chunkCells) ||
            Math.floor((row + dr) / OPT.chunkCells) !== Math.floor(row / OPT.chunkCells);
          if (crosses && !loaded.store.cellSolid('ground', col + dc, row + dr)) seams++;
        }
      }
    }
    expect(seams).toBeGreaterThan(0);
  });

  it('ends up vertex for vertex where a whole-map bake does', () => {
    const forwards = stream(arrivals());
    expect(vertices(forwards.handle.group)).toEqual(vertices(settled.group));
    forwards.handle.dispose();
  });

  it('does not care what order the chunks arrive in', () => {
    // Reversed, because a forward order re-meshes only the west and north
    // neighbours and would hide a direction that was never re-meshed at all.
    const backwards = stream([...arrivals()].reverse());
    expect(vertices(backwards.handle.group)).toEqual(vertices(settled.group));
    backwards.handle.dispose();
  });

  it('never walls a seam whose far side has not arrived', () => {
    // The property that makes the stream safe to watch: a chunk skirts an edge
    // only where the layer says outright that there is no ground, so the world
    // can only ever gain walls as chunks land -- never carry one that a settled
    // map does not have. Without it this map ends the stream with four times
    // the skirt it should have, dropped the full depth of the layer.
    const target = wallTriangles(settled.group);
    expect(target).toBeGreaterThan(0);
    const map = new StreamedMap(info);
    const handle = buildTerrainMeshFromChunks(map.meshLayers, []);
    let first = 0;
    for (const held of arrivals()) {
      for (const chunk of map.add(held)) handle.rebuild(chunk);
      if (first === 0) first = wallTriangles(handle.group);
      expect(wallTriangles(handle.group)).toBeLessThanOrEqual(target);
    }
    // ...and the world's own outer edge is not deferred with them: it is off the
    // layer's grid, which is a definite no rather than an unknown, so the very
    // first chunk to land already has its rim.
    expect(first).toBeGreaterThan(0);
    expect(wallTriangles(handle.group)).toBe(target);
    handle.dispose();
  });
});

describe('rebuilding one chunk', () => {
  const world = testWorld();
  const doc = exportMap({ world, props: [], seed: 7, arena: ARENA, options: OPT });

  /** Vertex positions of every mesh under a group, in order. */
  const shape = (group: THREE.Object3D): number[][] =>
    meshes(group).map((m) => [...(attribute(m, 'position') ?? new Float32Array())]);

  it('leaves every other chunk\'s mesh untouched', () => {
    const map = loadMap(doc);
    const handle = buildTerrainMeshFromChunks(map.meshLayers, map.chunks);
    const target = map.chunks[0] as (typeof map.chunks)[number];
    // The meshes that belong to the *target* are the only ones allowed to be
    // replaced; every other mesh must come through as the same object, not as an
    // equal copy -- a rebuild that quietly re-created the world would pass a
    // value comparison and still leak 55 chunks of geometry per stroke.
    const survivors = new Set(meshes(handle.group));
    const before = shape(handle.group).map((v) => v.join(',')).sort();

    handle.rebuild(target);

    const after = meshes(handle.group);
    const replaced = after.filter((m) => !survivors.has(m));
    // A chunk is at most a surface and a skirt.
    const ground = replaced.filter((m) => !(m.material instanceof THREE.ShaderMaterial));
    expect(ground.length).toBeGreaterThan(0);
    expect(ground.length).toBeLessThanOrEqual(2);
    // Water is allowed to go further (spec 074): a shoreline a few cells over a
    // chunk boundary colours the water on both sides of it, so this chunk's own
    // quad and its eight neighbours' are re-baked. Nine is the ceiling, and the
    // point of pinning it is that a rebuild must not re-bake the whole map.
    expect(replaced.length - ground.length).toBeLessThanOrEqual(9);
    // Rebuilt from an unedited store, so the geometry itself is unchanged --
    // compared as a multiset, since a rebuild appends rather than splicing.
    expect(shape(handle.group).map((v) => v.join(',')).sort()).toEqual(before);
    handle.dispose();
  });

  it('picks up an edit to that chunk and nothing else', () => {
    const map = loadMap(doc);
    const handle = buildTerrainMeshFromChunks(map.meshLayers, map.chunks);
    const target = map.chunks[0] as (typeof map.chunks)[number];
    const meshCount = meshes(handle.group).length;

    map.store.setCornerHeight(target.layerId, target.startCol + 3, target.startRow + 3, 555);
    const rebuilt = map.store.buildChunk(target.layerId, target.coord.cx, target.coord.cz);
    expect(rebuilt).not.toBeNull();
    if (!rebuilt) return;
    handle.rebuild(rebuilt);

    // The raised corner is in the buffer now...
    const heights = shape(handle.group).flat().filter((_, i) => i % 3 === 1);
    expect(heights.some((y) => Math.abs(y - 555) < 1e-3)).toBe(true);
    // ...and no mesh was leaked or lost doing it.
    expect(meshes(handle.group)).toHaveLength(meshCount);
    handle.dispose();
  });

  it('keeps pickTargets the same array instance, with the stale mesh gone', () => {
    // Callers capture this array once at construction; swapping it would leave
    // them raycasting against geometry that has been disposed.
    const map = loadMap(doc);
    const handle = buildTerrainMeshFromChunks(map.meshLayers, map.chunks);
    const targets = handle.pickTargets;
    const target = map.chunks[0] as (typeof map.chunks)[number];
    const stale = targets.find((o) => o instanceof THREE.Mesh);
    const count = targets.length;

    const rebuilt = map.store.buildChunk(target.layerId, target.coord.cx, target.coord.cz);
    if (!rebuilt) return;
    handle.rebuild(rebuilt);

    expect(handle.pickTargets).toBe(targets);
    expect(targets).toHaveLength(count);
    expect(targets).not.toContain(stale);
    for (const t of targets) expect(handle.group.children).toContain(t);
    handle.dispose();
  });

  it('matches what a full rebuild would have produced', () => {
    const map = loadMap(doc);
    const handle = buildTerrainMeshFromChunks(map.meshLayers, map.chunks);
    const target = map.chunks[0] as (typeof map.chunks)[number];
    map.store.setCornerHeight(target.layerId, target.startCol + 2, target.startRow + 4, 77);

    const patched = map.store.buildChunk(target.layerId, target.coord.cx, target.coord.cz);
    if (!patched) return;
    handle.rebuild(patched);

    // The same store, meshed from scratch.
    const fresh = buildTerrainMeshFromChunks(map.meshLayers, map.store.buildChunks());
    const sortRows = (g: THREE.Object3D): string[] => shape(g).map((v) => v.join(',')).sort();
    expect(sortRows(handle.group)).toEqual(sortRows(fresh.group));
    handle.dispose();
    fresh.dispose();
  });

  it('ignores a chunk naming a layer it does not have', () => {
    const map = loadMap(doc);
    const handle = buildTerrainMeshFromChunks(map.meshLayers, map.chunks);
    const before = meshes(handle.group).length;
    const target = map.chunks[0] as (typeof map.chunks)[number];
    expect(() => handle.rebuild({ ...target, layerId: 'nope' })).not.toThrow();
    expect(meshes(handle.group)).toHaveLength(before);
    handle.dispose();
  });
});
