import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK_OPTIONS, MAP_VERSION, sampleLayer, createArenaWorld } from '../../../terrain/index.js';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../../../shared/world.js';
import { buildTerrainMeshFromChunks } from '../terrain-mesh.js';
import { bakeEditorMap } from './map-source.js';

/**
 * Spec 049. The editor's one structural claim is that it renders from a document
 * rather than from the generator, so this asserts the handoff: the bake covers
 * the world, the load returns everything the scene consumes, and the terrain
 * mesh really can be built from `map.chunks` with no world in sight.
 */

const SEED = 20250804;

describe('bakeEditorMap', () => {
  const { document: doc, map } = bakeEditorMap(SEED);

  it('produces a current-version document of the whole world', () => {
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

  it('loads back every prop the document stores', () => {
    const stored = doc.layers.flatMap((l) => l.chunks.flatMap((c) => c.props));
    expect(stored.length).toBeGreaterThan(500);
    expect(map.props).toHaveLength(stored.length);
  });

  it('hands the scene chunks and mesh layers that match the document', () => {
    const chunks = doc.layers.reduce((n, l) => n + l.chunks.length, 0);
    expect(map.chunks).toHaveLength(chunks);
    expect(map.meshLayers).toHaveLength(doc.layers.length);
  });

  it('meshes from the document alone', () => {
    // The property the tab rests on: geometry with no `TerrainWorld` involved.
    const handle = buildTerrainMeshFromChunks(map.meshLayers, map.chunks);
    expect(handle.group.children.length).toBeGreaterThan(0);
    expect(handle.pickTargets.length).toBeGreaterThan(0);
    handle.dispose();
  });

  it('gives the camera solid ground to open over', () => {
    const y = map.world.heightAt(PLAY_WIDTH / 2, PLAY_HEIGHT / 2);
    expect(Number.isFinite(y)).toBe(true);
    // The play area rides on a raised rise, so the centre is above the water line.
    expect(y).toBeGreaterThan(0);
  });

  it('is deterministic for a seed', () => {
    const again = bakeEditorMap(SEED);
    expect(again.map.props).toHaveLength(map.props.length);
    expect(again.document.layers[0]?.chunks[0]?.heights).toEqual(doc.layers[0]?.chunks[0]?.heights);
  });
});
