import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK_OPTIONS, sampleChunk, sampleLayer, type ChunkOptions } from './chunk.js';
import { createLayer } from './features.js';
import {
  decodeRuns,
  encodeRuns,
  exportMap,
  isKnownPropKind,
  MAP_VERSION,
  parseMap,
  quantize,
  serializeMap,
  type MapDocument,
  type MapLayer,
  type MapMarker,
  type MapProp,
  type MapRect,
  type MapSpawnerSettings,
} from './map.js';
import { loadMap } from './map-world.js';
import { createWorld, rectContains, type Rect, type TerrainWorld } from './types.js';
import { MAX_SIGN_TEXT, scatterInBounds, worldVegetation, type Prop } from './vegetation.js';
import { createArenaWorld, DEFAULT_ARENA_WORLD, arenaBounds } from './world.js';

/**
 * Spec 048. The point of these tests is one property: a world survives being
 * written down. Everything else here is in service of it -- that the arrays come
 * back element for element, that the parts deliberately *not* stored can be
 * rebuilt, that props land in the right chunk and come home to the right place,
 * and that exporting an imported map is a fixed point rather than a slow drift.
 */

const BOUNDS: Rect = { minX: -200, minZ: -200, maxX: 280, maxZ: 200 };
const OPT: ChunkOptions = { cellSize: 20, chunkCells: 8 };
const ARENA: MapRect = { minX: 0, minZ: 0, maxX: 200, maxZ: 160 };

/** Assert-and-narrow, so a test can index without a banned non-null assertion. */
function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to exist`);
  return value;
}

/** These fixtures all have exactly one layer; this is the shorthand for it. */
const soleLayer = (doc: MapDocument): MapLayer => must(doc.layers[0], 'the document to have a layer');

function testWorld(seed = 7): TerrainWorld {
  return createWorld([
    createLayer({
      id: 'ground',
      bounds: BOUNDS,
      baseY: -100,
      waterLevel: -40,
      seed,
      features: [
        { kind: 'rolling', amplitude: 20 },
        { kind: 'hill', x: 0, z: 0, radius: 160, edge: 90, height: 120 },
        { kind: 'basin', x: 200, z: 120, radius: 110, edge: 60, depth: 90 },
        { kind: 'path', points: [[-180, -150], [0, 0], [220, 160]], width: 26, depth: 6 },
      ],
    }),
  ]);
}

/** An archipelago, so solidity is genuinely mixed rather than one long run. */
function islandWorld(): TerrainWorld {
  return createWorld([
    createLayer({
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
    }),
  ]);
}

function testProps(world: TerrainWorld, count = 60): Prop[] {
  return scatterInBounds(
    11,
    BOUNDS.minX,
    BOUNDS.minZ,
    BOUNDS.maxX,
    BOUNDS.maxZ,
    (x, z) => world.heightAt(x, z) > -20,
    { trees: count, bushes: count / 2, clusters: 6, clusterRadius: 90, attempts: 20 },
  );
}

function bake(world: TerrainWorld, props: readonly Prop[] = [], markers?: readonly MapMarker[]): MapDocument {
  return exportMap({ world, props, seed: 7, arena: ARENA, options: OPT, ...(markers ? { markers } : {}) });
}

describe('run-length codec', () => {
  it('round-trips uniform, alternating and single-cell arrays', () => {
    const cases = [
      new Uint8Array(50).fill(2),
      Uint8Array.from({ length: 40 }, (_, i) => i % 2),
      Uint8Array.from([5]),
      Uint8Array.from([0, 0, 0, 1, 1, 4, 4, 4, 4, 0]),
    ];
    for (const values of cases) {
      expect([...decodeRuns(encodeRuns(values), values.length)]).toEqual([...values]);
    }
  });

  it('collapses a uniform run to a single pair', () => {
    expect(encodeRuns(new Uint8Array(784).fill(2))).toEqual([2, 784]);
  });

  it('rejects runs that do not cover the cell count', () => {
    expect(() => decodeRuns([1, 3], 10)).toThrow(/covers 3 of 10/);
    expect(() => decodeRuns([1, 30], 10)).toThrow(/overflows/);
    expect(() => decodeRuns([1, 3, 2], 10)).toThrow(/value\/count pairs/);
  });
});

describe('exportMap', () => {
  it('is deterministic for a seed, and differs between seeds', () => {
    const a = serializeMap(bake(testWorld(7)));
    const b = serializeMap(bake(testWorld(7)));
    const c = serializeMap(bake(testWorld(8)));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('bakes every chunk of every layer', () => {
    const world = testWorld();
    const doc = bake(world);
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0]?.chunks).toHaveLength(sampleLayer(must(world.layers[0], 'the source layer'), OPT).length);
  });

  it('stores each chunk\'s arrays at the declared size', () => {
    for (const chunk of soleLayer(bake(testWorld())).chunks) {
      expect(chunk.heights).toHaveLength((chunk.cols + 1) * (chunk.rows + 1));
      // Runs are pairs that add up to the cell count.
      for (const runs of [chunk.solid, chunk.materials, chunk.tones]) {
        expect(runs.length % 2).toBe(0);
        let total = 0;
        for (let i = 1; i < runs.length; i += 2) total += must(runs[i], 'runs[i]');
        expect(total).toBe(chunk.cols * chunk.rows);
      }
    }
  });

  it('writes no walkability field at all', () => {
    // Spec 204 took it out of the format: 10.5% of every map file, on the wire
    // to every client, for a dev overlay that bakes its own.
    expect(JSON.stringify(soleLayer(bake(testWorld())))).not.toContain('"nav"');
  });

  it('keeps the version and the grid it was baked at', () => {
    const doc = bake(testWorld());
    expect(doc.version).toBe(MAP_VERSION);
    expect(doc.grid).toEqual({ cellSize: OPT.cellSize, chunkCells: OPT.chunkCells });
  });
});

describe('props in the document', () => {
  it('stores every prop exactly once', () => {
    const world = testWorld();
    const props = testProps(world);
    expect(props.length).toBeGreaterThan(20);
    const stored = soleLayer(bake(world, props)).chunks.flatMap((c) => c.props);
    expect(stored).toHaveLength(props.length);
  });

  it('stores positions chunk-local, inside the owning chunk', () => {
    const world = testWorld();
    const doc = bake(world, testProps(world));
    let seen = 0;
    for (const chunk of soleLayer(doc).chunks) {
      const width = chunk.cols * OPT.cellSize;
      const depth = chunk.rows * OPT.cellSize;
      for (const prop of chunk.props) {
        expect(prop.x).toBeGreaterThanOrEqual(0);
        expect(prop.z).toBeGreaterThanOrEqual(0);
        expect(prop.x).toBeLessThanOrEqual(width);
        expect(prop.z).toBeLessThanOrEqual(depth);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(20);
  });

  it('returns props to their world positions on load', () => {
    const world = testWorld();
    const props = testProps(world);
    const loaded = loadMap(bake(world, props));
    expect(loaded.props).toHaveLength(props.length);

    // Order is by chunk, not by the scatter, so match on position.
    const near = (a: Prop, b: Prop): boolean => Math.hypot(a.x - b.x, a.y - b.y) < 1e-3;
    for (const prop of props) {
      const found = loaded.props.find((p) => near(p, prop));
      expect(found, `no loaded prop near (${prop.x}, ${prop.y})`).toBeDefined();
      expect(found?.kind).toBe(prop.kind);
      expect(found?.rotation).toBeCloseTo(prop.rotation, 3);
      expect(found?.scale).toBeCloseTo(prop.scale, 3);
      expect(found?.tint).toBeCloseTo(prop.tint, 3);
    }
  });

  it('keeps a prop sitting exactly on a chunk boundary', () => {
    const world = testWorld();
    // The corner where four chunks meet: local (0, 0) of one of them.
    const seam = BOUNDS.minX + OPT.cellSize * OPT.chunkCells;
    const onSeam: Prop = { kind: 'tree', x: seam, y: seam, scale: 1, rotation: 0, tint: 0 };
    const loaded = loadMap(bake(world, [onSeam]));
    expect(loaded.props).toHaveLength(1);
    expect(loaded.props[0]?.x).toBeCloseTo(seam, 3);
    expect(loaded.props[0]?.y).toBeCloseTo(seam, 3);
  });
});

describe('markers in the document', () => {
  it('stores them chunk-local and returns them in world space', () => {
    const markers: MapMarker[] = [
      { kind: 'spawn', id: 'player', x: 100, z: 80, label: 'start' },
      { kind: 'campfire', id: 'fire-1', x: -150, z: -120 },
    ];
    const doc = bake(testWorld(), [], markers);
    const stored = soleLayer(doc).chunks.flatMap((c) => c.markers);
    expect(stored).toHaveLength(2);
    // Local, so nothing sits at the world coordinate it was given.
    expect(stored.map((m) => m.x)).not.toContain(100);

    const loaded = loadMap(doc);
    for (const marker of markers) {
      const found = loaded.markers.find((m) => m.id === marker.id);
      expect(found?.x).toBeCloseTo(marker.x, 3);
      expect(found?.z).toBeCloseTo(marker.z, 3);
      expect(found?.kind).toBe(marker.kind);
      expect(found?.label).toBe(marker.label);
    }
  });
});

describe('round trip', () => {
  it('is a fixed point: exporting an imported map reproduces the bytes', () => {
    const world = testWorld();
    const text = serializeMap(bake(world, testProps(world)));
    const again = serializeMap(loadMap(parseMap(text)).store.toDocument());
    expect(again).toBe(text);
    // And once more, to catch a drift that only shows on the second pass.
    expect(serializeMap(loadMap(parseMap(again)).store.toDocument())).toBe(text);
  });

  it('restores every chunk array element for element', () => {
    const doc = parseMap(serializeMap(bake(islandWorld())));
    const loaded = loadMap(doc);
    for (const chunk of soleLayer(doc).chunks) {
      const built = must(
        loaded.chunks.find((c) => c.coord.cx === chunk.cx && c.coord.cz === chunk.cz),
        `a rebuilt chunk at ${chunk.cx},${chunk.cz}`,
      );
      const cells = chunk.cols * chunk.rows;
      // Heights live in a Float32Array (which is what the GPU gets anyway), so
      // they recover the document at the document's own precision, not below it.
      expect(Array.from(built.heights, quantize)).toEqual(chunk.heights);
      expect([...built.solid]).toEqual([...decodeRuns(chunk.solid, cells)]);
      expect([...built.materials]).toEqual([...decodeRuns(chunk.materials, cells)]);
      expect([...built.tones]).toEqual([...decodeRuns(chunk.tones, cells)]);
    }
  });

  it('has genuinely mixed solidity to restore', () => {
    // Guards the test above: a world that is solid everywhere would pass it
    // while proving nothing about the solidity mask surviving.
    const runs = soleLayer(bake(islandWorld())).chunks.flatMap((c) => c.solid);
    expect(runs.filter((_, i) => i % 2 === 0)).toContain(0);
    expect(runs.filter((_, i) => i % 2 === 0)).toContain(1);
  });

  it('rebuilds the corner jitter exactly', () => {
    const world = testWorld();
    const loaded = loadMap(bake(world));
    const layer = must(world.layers[0], 'the source layer');
    for (const built of loaded.chunks) {
      const sampled = sampleChunk(layer, built.coord, OPT);
      expect([...built.cornerX]).toEqual([...sampled.cornerX]);
      expect([...built.cornerZ]).toEqual([...sampled.cornerZ]);
    }
  });

  it('rebuilds interior corner normals to within the quantum they are derived from', () => {
    const world = testWorld();
    const loaded = loadMap(bake(world));
    const layer = must(world.layers[0], 'the source layer');
    const totalCols = Math.ceil((BOUNDS.maxX - BOUNDS.minX) / OPT.cellSize);
    const totalRows = Math.ceil((BOUNDS.maxZ - BOUNDS.minZ) / OPT.cellSize);

    let interior = 0;
    for (const built of loaded.chunks) {
      const sampled = sampleChunk(layer, built.coord, OPT);
      for (let j = 0; j <= built.rows; j++) {
        for (let i = 0; i <= built.cols; i++) {
          const col = built.startCol + i;
          const row = built.startRow + j;
          const k = (j * (built.cols + 1) + i) * 3;
          const onRim = col === 0 || row === 0 || col === totalCols || row === totalRows;
          if (onRim) {
            // No apron beyond the layer to rebuild from, so only sanity holds.
            expect(Math.hypot(must(built.normals[k], 'built.normals[k]'), must(built.normals[k + 1], 'built.normals[k + 1]'), must(built.normals[k + 2], 'built.normals[k + 2]'))).toBeCloseTo(1, 6);
            continue;
          }
          // A normal is a height *gradient*, so it inherits the heights' 1e-3
          // quantum spread over the two-cell span it is taken across: the bound
          // is 1e-3 / (2 * cellSize), an order of magnitude under 1e-4.
          for (let c = 0; c < 3; c++) expect(must(built.normals[k + c], 'built.normals[k + c]')).toBeCloseTo(must(sampled.normals[k + c], 'sampled.normals[k + c]'), 4);
          interior++;
        }
      }
    }
    expect(interior).toBeGreaterThan(100);
  });

  it('keeps the layer scalars that the jitter and the skirt depend on', () => {
    const loaded = loadMap(parseMap(serializeMap(bake(testWorld()))));
    const layer = must(loaded.world.layers[0], 'the loaded layer');
    expect(layer.id).toBe('ground');
    expect(layer.seed).toBe(7);
    expect(layer.baseY).toBe(-100);
    expect(layer.waterLevel).toBe(-40);
    expect(layer.bounds).toEqual(BOUNDS);
  });
});

describe('the loaded world', () => {
  it('tracks the field it was baked from, on average', () => {
    const world = testWorld();
    const loaded = loadMap(bake(world));
    // A *mean*, not a worst case, and the distinction is the point. A baked map
    // is a lattice; the field it was sampled from has detail below a cell (a
    // terrace riser is a near-vertical step inside one cell), and no heightfield
    // can carry that. Nor did the old one -- the mesh has always drawn the ramp
    // between two corners, never the step -- so the worst-case gap is against
    // the field, not against anything that was ever on screen. What must hold is
    // that the surface follows the field everywhere it can, which is the mean.
    let worst = 0;
    let total = 0;
    let n = 0;
    let low = Infinity;
    let high = -Infinity;
    for (let x = BOUNDS.minX + 10; x < BOUNDS.maxX - 10; x += 7) {
      for (let z = BOUNDS.minZ + 10; z < BOUNDS.maxZ - 10; z += 7) {
        const field = world.heightAt(x, z);
        worst = Math.max(worst, Math.abs(loaded.world.heightAt(x, z) - field));
        total += Math.abs(loaded.world.heightAt(x, z) - field);
        low = Math.min(low, field);
        high = Math.max(high, field);
        n++;
      }
    }
    // Measured against the relief actually present, so the bound keeps its
    // meaning if the fixture changes: ~0.5% mean, ~8% at the worst riser.
    const relief = high - low;
    expect(relief).toBeGreaterThan(100);
    expect(total / n).toBeLessThan(relief * 0.01);
    expect(worst).toBeLessThan(relief * 0.1);
  });

  it('is exact at every corner of the surface it draws', () => {
    // The property that matters more than tracking the field: sampled at a
    // corner's *jittered* position -- where the mesh actually puts it -- the
    // loaded world returns that corner's stored height, so a prop stands on the
    // triangle the player sees rather than near it.
    const loaded = loadMap(bake(testWorld()));
    let checked = 0;
    for (const chunk of loaded.chunks) {
      for (let j = 1; j < chunk.rows; j++) {
        for (let i = 1; i < chunk.cols; i++) {
          const k = j * (chunk.cols + 1) + i;
          expect(loaded.world.heightAt(must(chunk.cornerX[k], 'chunk.cornerX[k]'), must(chunk.cornerZ[k], 'chunk.cornerZ[k]'))).toBeCloseTo(must(chunk.heights[k], 'chunk.heights[k]'), 3);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('reports no ground outside the layer bounds', () => {
    const loaded = loadMap(bake(islandWorld()));
    const layer = must(loaded.world.layers[0], 'the loaded layer');
    expect(layer.sample(BOUNDS.minX - 50, 0).solid).toBe(false);
    expect(layer.sample(BOUNDS.maxX + 50, 0).solid).toBe(false);
    // ...and does report ground somewhere inside it.
    let anySolid = false;
    for (let x = BOUNDS.minX; x < BOUNDS.maxX; x += 10) {
      for (let z = BOUNDS.minZ; z < BOUNDS.maxZ; z += 10) {
        if (rectContains(BOUNDS, x, z) && layer.sample(x, z).solid) anySolid = true;
      }
    }
    expect(anySolid).toBe(true);
  });
});

describe('seam ownership', () => {
  it('writes a shared corner into every chunk that holds it', () => {
    const loaded = loadMap(bake(testWorld()));
    const store = loaded.store;
    const seamCol = OPT.chunkCells;
    const seamRow = OPT.chunkCells;
    store.setCornerHeight('ground', seamCol, seamRow, 123.5);

    // All four chunks meeting at that corner now agree, and so does a rebuild.
    for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const chunk = must(store.buildChunk('ground', cx, cz), `chunk ${cx},${cz}`);
      const i = seamCol - chunk.startCol;
      const j = seamRow - chunk.startRow;
      expect(chunk.heights[j * (chunk.cols + 1) + i]).toBeCloseTo(123.5, 3);
    }
    expect(store.cornerHeight('ground', seamCol, seamRow)).toBeCloseTo(123.5, 3);
  });

  it('ignores a corner outside the layer grid', () => {
    const store = loadMap(bake(testWorld())).store;
    expect(() => store.setCornerHeight('ground', -1, 0, 5)).not.toThrow();
    expect(() => store.setCornerHeight('ground', 9999, 0, 5)).not.toThrow();
    expect(() => store.setCornerHeight('nope', 0, 0, 5)).not.toThrow();
  });
});

/**
 * Spec 222. A spawner is the one marker kind with numbers of its own, and the
 * whole reason the block is nested is so no other kind can carry them.
 */
describe("a spawner's own settings", () => {
  const roundTrip = (markers: readonly MapMarker[]): MapDocument => parseMap(serializeMap(bake(testWorld(), [], markers)));

  const spawner = (settings?: MapSpawnerSettings): MapMarker => ({
    kind: 'spawner',
    id: 'spawner-1',
    x: 100,
    z: 80,
    label: 'grazer',
    ...(settings === undefined ? {} : { spawner: settings }),
  });

  const sole = (doc: MapDocument): MapMarker => {
    const found = soleLayer(doc).chunks.flatMap((c) => c.markers)[0];
    return must(found, 'a marker');
  };

  it('survives the round trip whole', () => {
    const marker = sole(roundTrip([spawner({ respawnSeconds: 42.5, leashRadius: 250 })]));
    expect(marker.spawner).toEqual({ respawnSeconds: 42.5, leashRadius: 250 });
  });

  it('keeps one member without inventing the other', () => {
    expect(sole(roundTrip([spawner({ respawnSeconds: 12 })])).spawner).toEqual({ respawnSeconds: 12 });
    expect(sole(roundTrip([spawner({ leashRadius: 300 })])).spawner).toEqual({ leashRadius: 300 });
  });

  /**
   * The claim that makes this change free for every map already committed: a
   * marker nobody has overridden is the *same bytes* it was before the field
   * existed, so no map file moves and no `mapId` does either.
   */
  it('writes nothing at all for a marker that has none', () => {
    const before = serializeMap(bake(testWorld(), [], [spawner()]));
    expect(before).not.toContain('spawner":');
    expect(serializeMap(roundTrip([spawner()]))).toBe(before);
  });

  /** An empty block is the same statement as no block, so it normalizes to one. */
  it('normalizes an empty block to absent', () => {
    const doc = JSON.parse(serializeMap(bake(testWorld(), [], [spawner()]))) as Record<string, unknown>;
    const layers = doc['layers'] as Record<string, unknown>[];
    const chunks = must(layers[0], 'a layer')['chunks'] as Record<string, unknown>[];
    for (const chunk of chunks) {
      const markers = chunk['markers'] as Record<string, unknown>[];
      for (const marker of markers) marker['spawner'] = {};
    }
    expect(sole(parseMap(JSON.stringify(doc))).spawner).toBeUndefined();
  });

  it('refuses the block on a kind that cannot read it', () => {
    const doc = JSON.parse(
      serializeMap(bake(testWorld(), [], [{ kind: 'campfire', id: 'fire-1', x: 100, z: 80 }])),
    ) as Record<string, unknown>;
    const layers = doc['layers'] as Record<string, unknown>[];
    const chunks = must(layers[0], 'a layer')['chunks'] as Record<string, unknown>[];
    for (const chunk of chunks) {
      for (const marker of chunk['markers'] as Record<string, unknown>[]) marker['spawner'] = { leashRadius: 300 };
    }
    expect(() => parseMap(JSON.stringify(doc))).toThrow(/only for a spawner marker, not a campfire/);
  });

  it('refuses a member that is not a number', () => {
    const doc = JSON.parse(serializeMap(bake(testWorld(), [], [spawner()]))) as Record<string, unknown>;
    const layers = doc['layers'] as Record<string, unknown>[];
    const chunks = must(layers[0], 'a layer')['chunks'] as Record<string, unknown>[];
    for (const chunk of chunks) {
      for (const marker of chunk['markers'] as Record<string, unknown>[]) marker['spawner'] = { respawnSeconds: 'soon' };
    }
    expect(() => parseMap(JSON.stringify(doc))).toThrow(/respawnSeconds/);
  });
});

/**
 * Spec 259. A sign's message is the first *string* a prop carries and the only
 * field in a prop record a person is expected to edit by hand, so what it owes
 * is the round trip and a parser that says no rather than storing something the
 * wire cannot carry.
 */
describe("a sign's message", () => {
  const signAt = (x: number, z: number, text?: string): Prop => ({
    kind: 'sign',
    x,
    y: z,
    scale: 1,
    rotation: 0,
    tint: 0,
    ...(text === undefined ? {} : { text }),
  });

  const props = (doc: MapDocument): MapProp[] => soleLayer(doc).chunks.flatMap((c) => c.props);

  const roundTrip = (list: readonly Prop[]): MapProp[] =>
    props(parseMap(serializeMap(bake(testWorld(), list))));

  it('survives the round trip whole, including quotes and newlines', () => {
    const said = 'He said "no".\nC:\\road';
    const back = roundTrip([signAt(100, 80, said)]);
    expect(back.map((p) => p.text)).toEqual([said]);
  });

  it('carries the longest message a sign may hold', () => {
    const long = 'x'.repeat(MAX_SIGN_TEXT);
    expect(roundTrip([signAt(100, 80, long)])[0]?.text).toBe(long);
  });

  /**
   * What makes this change free for every map already committed: a prop that is
   * not a sign gains no key, so no region file's bytes move and no `mapId`
   * does either.
   */
  it('writes nothing at all for a prop that has none', () => {
    const before = serializeMap(bake(testWorld(), testProps(testWorld())));
    expect(before).not.toContain('"text"');
  });

  it('drops a blank message rather than storing one', () => {
    // A sign with nothing on it is not a sign, at every layer: the editor
    // refuses to place one, `signMarks` drops it, and the bake writes no key.
    expect(roundTrip([signAt(100, 80, '   ')])[0]?.text).toBeUndefined();
    expect(roundTrip([signAt(100, 80)])[0]?.text).toBeUndefined();
  });

  it('drops a message written onto a kind that cannot read one', () => {
    // Written out and then ignored forever after is the state this avoids: the
    // bake goes through `signText`, which answers null for anything but a sign.
    const well: Prop = { ...signAt(100, 80, 'not a sign'), kind: 'well' };
    expect(roundTrip([well])[0]?.text).toBeUndefined();
  });

  it('refuses a message that is not a string', () => {
    const doc = JSON.parse(serializeMap(bake(testWorld(), [signAt(100, 80, 'hi')]))) as Record<string, unknown>;
    const layers = doc['layers'] as Record<string, unknown>[];
    const chunks = must(layers[0], 'a layer')['chunks'] as Record<string, unknown>[];
    for (const chunk of chunks) {
      for (const prop of chunk['props'] as Record<string, unknown>[]) if (prop['text'] !== undefined) prop['text'] = 12;
    }
    expect(() => parseMap(JSON.stringify(doc))).toThrow(/text must be a string/);
  });

  it('refuses one longer than a sign may carry, rather than truncating it', () => {
    // Refused here and *cut* by the editor, which is the right way round: a
    // document is a file that may already be wrong, and a panel is a person
    // still typing. A document silently losing the second half of a sentence
    // is worse than one that says which prop is too long.
    const doc = JSON.parse(serializeMap(bake(testWorld(), [signAt(100, 80, 'hi')]))) as Record<string, unknown>;
    const layers = doc['layers'] as Record<string, unknown>[];
    const chunks = must(layers[0], 'a layer')['chunks'] as Record<string, unknown>[];
    for (const chunk of chunks) {
      for (const prop of chunk['props'] as Record<string, unknown>[]) {
        if (prop['text'] !== undefined) prop['text'] = 'x'.repeat(MAX_SIGN_TEXT + 1);
      }
    }
    expect(() => parseMap(JSON.stringify(doc))).toThrow(/over the 240 a sign may carry/);
  });

  it('is a known species, so the map validator accepts one', () => {
    expect(isKnownPropKind('sign')).toBe(true);
  });
});

describe('parseMap validation', () => {
  type Json = Record<string, unknown>;
  const text = (markers?: readonly MapMarker[]): string => serializeMap(bake(testWorld(), [], markers));

  /**
   * A document as plain JSON, which is what `parseMap` actually receives -- and
   * the only way to build a *malformed* one, since the typed shape forbids it.
   */
  const raw = (markers?: readonly MapMarker[]): Json => JSON.parse(text(markers)) as Json;
  const firstChunk = (doc: Json): Json => {
    const layers = doc['layers'] as Json[];
    return (must(layers[0], 'a layer')['chunks'] as Json[])[0] as Json;
  };

  it('rejects a document that is not JSON at all', () => {
    expect(() => parseMap('{ not json')).toThrow(/not valid JSON/);
  });

  it('rejects an unknown version', () => {
    const doc = raw();
    doc['version'] = 99;
    expect(() => parseMap(JSON.stringify(doc))).toThrow(/unsupported version 99/);
  });

  it('rejects a missing version', () => {
    const doc = raw();
    delete doc['version'];
    expect(() => parseMap(JSON.stringify(doc))).toThrow(/version must be a finite number/);
  });

  it('rejects a height array that disagrees with the chunk size', () => {
    const doc = raw();
    const chunk = firstChunk(doc);
    chunk['heights'] = (chunk['heights'] as number[]).slice(0, -1);
    expect(() => parseMap(JSON.stringify(doc))).toThrow(/heights has \d+ entries, expected/);
  });

  it('rejects runs that do not cover the chunk', () => {
    const doc = raw();
    firstChunk(doc)['materials'] = [2, 3];
    expect(() => parseMap(JSON.stringify(doc))).toThrow(/covers 3 of/);
  });

  it('rejects an unknown marker kind', () => {
    const doc = raw([{ kind: 'spawn', id: 'p', x: 0, z: 0 }]);
    const chunks = (must((doc['layers'] as Json[])[0], 'a layer')['chunks'] as Json[]).filter(
      (c) => (c['markers'] as unknown[]).length > 0,
    );
    const marker = must((must(chunks[0], 'a chunk with markers')['markers'] as Json[])[0], 'a marker');
    marker['kind'] = 'portal';
    expect(() => parseMap(JSON.stringify(doc))).toThrow(/not a known marker kind: portal/);
  });
});

describe('the shipped arena world', () => {
  // The real thing at its real size -- the only test here that would notice a
  // format that works on a toy layer and falls over on 56 chunks of terrain.
  const seed = 20250804;
  const world = createArenaWorld(seed);

  it('bakes, serialises and reloads at full size', () => {
    const doc = exportMap({
      world,
      props: [],
      seed,
      arena: { minX: 0, minZ: 0, maxX: DEFAULT_ARENA_WORLD.playWidth, maxZ: DEFAULT_ARENA_WORLD.playHeight },
    });
    const text = serializeMap(doc);
    const loaded = loadMap(parseMap(text));

    const layer = soleLayer(doc);
    expect(layer.bounds).toEqual(arenaBounds());
    expect(layer.chunks.length).toBe(sampleLayer(must(world.layers[0], 'the source layer'), DEFAULT_CHUNK_OPTIONS).length);
    expect(loaded.chunks).toHaveLength(layer.chunks.length);
    expect(serializeMap(loaded.store.toDocument())).toBe(text);
  });

  it('never samples a height outside the relief it stores', () => {
    // The regression this guards: corner jitter can leave three corners of a
    // quad nearly collinear, and the plane through that sliver is ill-conditioned
    // -- extrapolating it put the ground 1757 units down on terrain the field has
    // flat, which is a hole a unit would fall through. Nothing sampled anywhere
    // in the world may leave the band the stored corners actually span.
    const doc = exportMap({ world, props: [], seed, arena: { minX: 0, minZ: 0, maxX: 1200, maxZ: 900 } });
    const loaded = loadMap(doc);
    let low = Infinity;
    let high = -Infinity;
    for (const chunk of soleLayer(doc).chunks) {
      for (const h of chunk.heights) {
        low = Math.min(low, h);
        high = Math.max(high, h);
      }
    }
    const bounds = soleLayer(doc).bounds;
    // A stride coprime with the cell size, so the sweep walks across cells
    // rather than landing on the same offset within each one.
    for (let x = bounds.minX; x <= bounds.maxX; x += 23) {
      for (let z = bounds.minZ; z <= bounds.maxZ; z += 23) {
        const h = loaded.world.heightAt(x, z);
        // `heightAt` reports 0 over open air, which is in band here anyway.
        expect(h, `height ${h} at (${x}, ${z}) is outside [${low}, ${high}]`).toBeGreaterThanOrEqual(low - 1);
        expect(h).toBeLessThanOrEqual(high + 1);
      }
    }
  });

  it('follows the field it was baked from across the play area', () => {
    const doc = exportMap({ world, props: [], seed, arena: { minX: 0, minZ: 0, maxX: 1200, maxZ: 900 } });
    const loaded = loadMap(doc);
    let worst = 0;
    let total = 0;
    let n = 0;
    for (let x = 0; x <= 1200; x += 11) {
      for (let z = 0; z <= 900; z += 11) {
        const gap = Math.abs(loaded.world.heightAt(x, z) - world.heightAt(x, z));
        worst = Math.max(worst, gap);
        total += gap;
        n++;
      }
    }
    // The play area is the gentle ground the fight happens on, so here the bake
    // tracks the field closely: well under a unit on average, a few units at the
    // steepest riser. (The mountains in the bleed are a different matter -- a
    // terraced crest has detail inside one cell that no heightfield carries.)
    expect(total / n).toBeLessThan(1);
    expect(worst).toBeLessThan(15);
  });

  it('stays small enough to hand to localStorage, with its full forest on it', () => {
    const props = worldVegetation(seed, world);
    expect(props.length).toBeGreaterThan(500);
    const text = serializeMap(
      exportMap({ world, props, seed, arena: { minX: 0, minZ: 0, maxX: 1200, maxZ: 900 } }),
    );
    // ~0.5MB as it stands. Autosave has a ~5MB budget and has to fit a map plus
    // whatever the browser is already keeping, so the ceiling is set well under
    // it -- this fails long before an autosave starts silently dropping saves.
    expect(text.length).toBeLessThan(2_000_000);
  });
});
