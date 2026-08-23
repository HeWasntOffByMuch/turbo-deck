import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHUNK_OPTIONS,
  MAP_VERSION,
  parseMap,
  sampleLayer,
  serializeMap,
  createArenaWorld,
  loadMap,
  type MapDocument,
  type MapMarker,
} from '../../../terrain/index.js';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../../../shared/world.js';
import { loadMapFile } from '../../../server/world/map-file.js';
import { buildTerrainMeshFromChunks } from '../terrain-mesh.js';
import { bakeEditorMap, editorMapChoice, openEditorMap, SHIPPED_MAP_NAME } from './map-source.js';

/**
 * The shipped map off disk (spec 203, a directory since 200).
 *
 * The browser fetches a manifest and its regions; a test reads them. That the
 * two produce the same document is the point of the seam -- and it is what lets
 * this file keep asserting the editor's relationship with the terrain system in
 * Node, which is why `map-source.ts` was split out of the view in the first
 * place.
 */
const readMapDocument = (): Promise<MapDocument> => Promise.resolve(loadMapFile().doc);
import { placeMarker } from './markers.js';

/**
 * Spec 049. The editor's one structural claim is that it renders from a document
 * rather than from the generator, so this asserts the handoff: the bake covers
 * the world, the load returns everything the scene consumes, and the terrain
 * mesh really can be built from `map.chunks` with no world in sight.
 *
 * Spec 176 adds the claim that was missing under it, and the one the marker bug
 * turned out to be: *which* document. The editor used to bake a world from
 * `viewSeed()`, which falls back to the clock, so it opened a different world
 * every session while the game played `maps/arena.json` -- and everything placed
 * in it, markers most visibly, was placed in a world nothing else would ever
 * read. So the shipped map is checked against the file the server boots from,
 * not against a copy of it.
 */

const SEED = 20250804;

/** Every marker in a document, in world space, as the store hands them over. */
function markersOf(doc: ReturnType<typeof parseMap>): readonly MapMarker[] {
  const { store } = loadMap(doc);
  return doc.layers.flatMap((l) => store.markers(l.id));
}

/** A marker, ordered and stripped to what a save has to preserve. */
const asRows = (markers: readonly MapMarker[]): string[] =>
  markers.map((m) => `${m.kind}:${m.id}:${m.x}:${m.z}:${m.label ?? ''}`).sort();

describe('bakeEditorMap', () => {
  const { document: doc, map } = bakeEditorMap(SEED);

  it('produces a current-version document of the whole world', async () => {
    expect(doc.version).toBe(MAP_VERSION);
    expect(doc.seed).toBe(SEED);
    expect(doc.layers).toHaveLength(1);
    const layer = doc.layers[0];
    expect(layer).toBeDefined();
    if (!layer) return;
    // Every chunk the sampler would have produced for the generated world.
    const world = createArenaWorld(SEED);
    const source = world.layers[0];
    expect(source).toBeDefined();
    if (!source) return;
    expect(layer.chunks).toHaveLength(sampleLayer(source, DEFAULT_CHUNK_OPTIONS).length);
  });

  it('records the sim\'s play rectangle as the arena', () => {
    expect(doc.arena).toEqual({ minX: 0, minZ: 0, maxX: PLAY_WIDTH, maxZ: PLAY_HEIGHT });
  });

  it('loads back every prop the document stores', async () => {
    const stored = doc.layers.flatMap((l) => l.chunks.flatMap((c) => c.props));
    expect(stored.length).toBeGreaterThan(500);
    expect(map.props).toHaveLength(stored.length);
  });

  it('hands the scene chunks and mesh layers that match the document', async () => {
    const chunks = doc.layers.reduce((n, l) => n + l.chunks.length, 0);
    expect(map.chunks).toHaveLength(chunks);
    expect(map.meshLayers).toHaveLength(doc.layers.length);
  });

  it('meshes from the document alone', async () => {
    // The property the tab rests on: geometry with no `TerrainWorld` involved.
    const handle = buildTerrainMeshFromChunks(map.meshLayers, map.chunks);
    expect(handle.group.children.length).toBeGreaterThan(0);
    expect(handle.pickTargets.length).toBeGreaterThan(0);
    handle.dispose();
  });

  it('gives the camera solid ground to open over', async () => {
    const y = map.world.heightAt(PLAY_WIDTH / 2, PLAY_HEIGHT / 2);
    expect(Number.isFinite(y)).toBe(true);
    // The play area rides on a raised rise, so the centre is above the water line.
    expect(y).toBeGreaterThan(0);
  });

  it('is deterministic for a seed', async () => {
    const again = bakeEditorMap(SEED);
    expect(again.map.props).toHaveLength(map.props.length);
    expect(again.document.layers[0]?.chunks[0]?.heights).toEqual(doc.layers[0]?.chunks[0]?.heights);
  });
});

describe('which map the editor opens (spec 176)', () => {
  it('opens the shipped map by default', async () => {
    expect(editorMapChoice('')).toBe('shipped');
  });

  it('does not let a seed switch sources', async () => {
    // `?seed=` is session-wide and answers *which* generated world, never
    // *whether* to generate one -- so a harness pinning a seed for the Play tab
    // cannot take the editor off the game's map as a side effect.
    expect(editorMapChoice('?seed=20260806')).toBe('shipped');
    expect(editorMapChoice('?tab=3&seed=7')).toBe('shipped');
  });

  it('generates a world only when asked to', async () => {
    expect(editorMapChoice('?map=generated')).toBe('generated');
    expect(editorMapChoice('?map=generated&seed=7')).toBe('generated');
  });

  it('opens the very document the server boots from', async () => {
    // Against the file on disk, through the server's own reader, rather than
    // against another bake of the same seed: the shipped map has been grown and
    // hand-edited since it was baked, and re-baking its seed reproduces neither.
    const onDisk = loadMapFile().doc;
    const opened = (await openEditorMap('', SEED, readMapDocument)).document;
    expect(serializeMap(opened)).toBe(serializeMap(onDisk));
  });

  it('names a save after what was opened', async () => {
    expect((await openEditorMap('', SEED, readMapDocument)).name).toBe(SHIPPED_MAP_NAME);
    expect((await openEditorMap('?map=generated', SEED, readMapDocument)).name).toBe(`map-${SEED >>> 0}.json`);
  });

  it('still bakes a generated world when asked', async () => {
    const generated = await openEditorMap('?map=generated', SEED, readMapDocument);
    expect(generated.document.seed).toBe(SEED);
    expect(generated.map.chunks.length).toBeGreaterThan(0);
  });
});

describe('the shipped map survives the editor (spec 176)', () => {
  it('has markers to lose in the first place', async () => {
    // Without this the round-trip tests below would pass over an empty list,
    // which is exactly the state the bug produced.
    expect(markersOf((await openEditorMap('', SEED, readMapDocument)).document).length).toBeGreaterThan(0);
  });

  it('keeps every marker through a save', async () => {
    const opened = await openEditorMap('', SEED, readMapDocument);
    const before = markersOf(opened.document);
    // The editor's own save: the live store re-emitted, serialized, read back.
    const after = markersOf(parseMap(serializeMap(opened.map.store.toDocument())));
    expect(asRows(after)).toEqual(asRows(before));
  });

  it('keeps them when one more is placed on top', async () => {
    const opened = await openEditorMap('', SEED, readMapDocument);
    const layerId = opened.document.layers[0]?.id ?? 'ground';
    const before = markersOf(opened.document);
    const bounds = opened.map.store.layerInfo(layerId)?.bounds;
    expect(bounds).toBeDefined();
    if (!bounds) return;

    const placed = placeMarker(
      opened.map.store,
      layerId,
      'spawner',
      (bounds.minX + bounds.maxX) / 2,
      (bounds.minZ + bounds.maxZ) / 2,
      undefined,
      'grazer',
    );
    expect(placed.marker).not.toBeNull();
    if (!placed.marker) return;

    const after = markersOf(parseMap(serializeMap(opened.map.store.toDocument())));
    expect(after).toHaveLength(before.length + 1);
    expect(asRows(after)).toEqual(asRows([...before, placed.marker]));
  });
});
