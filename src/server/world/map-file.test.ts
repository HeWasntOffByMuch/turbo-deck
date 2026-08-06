/**
 * The map on disk (spec 070).
 *
 * Covers the two things that can rot without anyone noticing: the bake stops
 * being reproducible, and the shipped file stops being loadable.
 */

import { describe, expect, it } from 'vitest';

import { serializeMap } from '../../terrain/map.js';
import { loadMap } from '../../terrain/map-world.js';
import { bakeMap, DEFAULT_BAKE_SEED } from '../../../scripts/bake-map.js';
import { buildWorldFromMap } from './build.js';
import { DEFAULT_MAP_PATH, loadMapFile, mapPathFromEnv } from './map-file.js';

describe('the bake', () => {
  it('is deterministic: the same seed twice, the same bytes', () => {
    // Nav is skipped here purely for speed; it is a pure function of the same
    // arrays, and the shipped map is baked with it.
    expect(serializeMap(bakeMap(7, false))).toBe(serializeMap(bakeMap(7, false)));
  });

  it('gives different seeds different worlds', () => {
    expect(serializeMap(bakeMap(7, false))).not.toBe(serializeMap(bakeMap(8, false)));
  });
});

describe('the shipped map', () => {
  const file = loadMapFile(DEFAULT_MAP_PATH);

  it('reads and parses', () => {
    expect(file.doc.version).toBe(1);
    expect(file.doc.seed).toBe(DEFAULT_BAKE_SEED);
    expect(file.text.length).toBeGreaterThan(0);
  });

  it('loads into a world with ground under the arena', () => {
    const loaded = loadMap(file.doc);
    const { arena } = file.doc;
    const midX = (arena.minX + arena.maxX) / 2;
    const midZ = (arena.minZ + arena.maxZ) / 2;
    expect(Number.isFinite(loaded.world.heightAt(midX, midZ))).toBe(true);
  });

  it('builds a server world with colliders for its props', () => {
    const built = buildWorldFromMap(file.doc, file.text);
    expect(built.props.length).toBeGreaterThan(0);
    // The bug spec 063 was written about: terrain built here and an empty
    // vegetation list passed to collision, so the server walked through trees.
    expect(built.colliders.circles.length).toBeGreaterThanOrEqual(built.props.length);
    expect(built.index.mapId).toHaveLength(8);
  });
});

describe('failures are loud', () => {
  it('throws with the path when the file is missing', () => {
    expect(() => loadMapFile('maps/does-not-exist.json')).toThrow(/does-not-exist\.json/);
  });

  it('points at the bake script rather than silently generating', () => {
    expect(() => loadMapFile('maps/does-not-exist.json')).toThrow(/bake-map/);
  });
});

describe('the map path', () => {
  it('defaults to the shipped map', () => {
    expect(mapPathFromEnv({})).toBe(DEFAULT_MAP_PATH);
    expect(mapPathFromEnv({ TURBO_DECK_MAP: '' })).toBe(DEFAULT_MAP_PATH);
  });

  it('is overridden by the environment', () => {
    expect(mapPathFromEnv({ TURBO_DECK_MAP: 'maps/other.json' })).toBe('maps/other.json');
  });
});
