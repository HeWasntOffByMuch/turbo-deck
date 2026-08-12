import { describe, expect, it } from 'vitest';
import type { MapDocument, MapMarker } from '../../terrain/index.js';
import { monsterById } from '../data/monsters.js';
import { loadMapFile } from './map-file.js';
import { spawnPointsFrom, SpawnerError } from './spawners.js';

/**
 * A two-chunk document with nothing in it but markers. Terrain is not what this
 * file is about, and a real bake would bury the thing being tested.
 */
function doc(markers: Record<string, readonly MapMarker[]>): MapDocument {
  const cellSize = 10;
  const chunkCells = 10;
  const chunk = (cx: number, cz: number) => ({
    cx,
    cz,
    cols: chunkCells,
    rows: chunkCells,
    heights: new Array((chunkCells + 1) * (chunkCells + 1)).fill(0),
    solid: [0, chunkCells * chunkCells],
    materials: [0, chunkCells * chunkCells],
    tones: [0, chunkCells * chunkCells],
    props: [],
    markers: markers[`${cx},${cz}`] ?? [],
    nav: null,
  });
  return {
    version: 1,
    seed: 1,
    grid: { cellSize, chunkCells },
    arena: { minX: 0, minZ: 0, maxX: 200, maxZ: 100 },
    layers: [
      {
        id: 'ground',
        seed: 1,
        origin: { x: -100, z: -100 },
        bounds: { minX: -100, minZ: -100, maxX: 100, maxZ: 0 },
        baseY: 0,
        waterLevel: null,
        chunks: [chunk(0, 0), chunk(1, 0)],
      },
    ],
  };
}

const spawner = (id: string, label: string, x: number, z: number): MapMarker => ({
  kind: 'spawner',
  id,
  x,
  z,
  label,
});

describe('reading spawners out of a map', () => {
  it('takes only spawner markers, and reads the monster from the label', () => {
    const points = spawnPointsFrom(
      doc({
        '0,0': [
          spawner('spawner-1', 'grazer', 10, 20),
          { kind: 'spawn', id: 'spawn-1', x: 30, z: 30 },
          { kind: 'campfire', id: 'campfire-1', x: 40, z: 40, label: 'stalker' },
        ],
      }),
    );
    expect(points).toEqual([{ id: 'spawner-1', monsterId: 'grazer', x: -90, y: -80 }]);
  });

  it('converts chunk-local coordinates to world space', () => {
    // Chunk (1,0) starts one chunk extent (100 units) along the layer bounds.
    const points = spawnPointsFrom(doc({ '1,0': [spawner('spawner-1', 'grazer', 5, 5)] }));
    expect(points[0]?.x).toBe(5);
    expect(points[0]?.y).toBe(-95);
  });

  it('sorts by id, so the order does not depend on which chunk was clicked first', () => {
    const points = spawnPointsFrom(
      doc({
        '1,0': [spawner('spawner-1', 'grazer', 5, 5), spawner('spawner-3', 'stalker', 6, 6)],
        '0,0': [spawner('spawner-2', 'ravager', 7, 7)],
      }),
    );
    expect(points.map((p) => p.id)).toEqual(['spawner-1', 'spawner-2', 'spawner-3']);
  });

  it('refuses a spawner naming a monster nobody has heard of', () => {
    expect(() => spawnPointsFrom(doc({ '0,0': [spawner('spawner-1', 'wyvern', 5, 5)] }))).toThrow(
      SpawnerError,
    );
    // The marker is named, because "somewhere in the map" is not a bug report.
    expect(() => spawnPointsFrom(doc({ '0,0': [spawner('spawner-1', 'wyvern', 5, 5)] }))).toThrow(
      /spawner-1/,
    );
  });

  it('refuses a spawner with no monster at all', () => {
    const bare: MapMarker = { kind: 'spawner', id: 'spawner-1', x: 5, z: 5 };
    expect(() => spawnPointsFrom(doc({ '0,0': [bare] }))).toThrow(SpawnerError);
  });

  it('refuses two spawners sharing an id', () => {
    expect(() =>
      spawnPointsFrom(
        doc({
          '0,0': [spawner('spawner-1', 'grazer', 5, 5)],
          '1,0': [spawner('spawner-1', 'grazer', 6, 6)],
        }),
      ),
    ).toThrow(/share the id/);
  });

  it('finds nothing in a document with no markers', () => {
    expect(spawnPointsFrom(doc({}))).toEqual([]);
  });
});

describe('the shipped map', () => {
  const shipped = loadMapFile().doc;

  it('places spawners, and every one names a monster in the table', () => {
    const points = spawnPointsFrom(shipped);
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(monsterById(point.monsterId), point.id).toBeDefined();
    }
  });

  it('puts them inside the arena, where a player will actually meet them', () => {
    const { arena } = shipped;
    for (const point of spawnPointsFrom(shipped)) {
      expect(point.x, point.id).toBeGreaterThanOrEqual(arena.minX);
      expect(point.x, point.id).toBeLessThanOrEqual(arena.maxX);
      expect(point.y, point.id).toBeGreaterThanOrEqual(arena.minZ);
      expect(point.y, point.id).toBeLessThanOrEqual(arena.maxZ);
    }
  });

  it('survives a round trip through the map serializer', () => {
    const before = spawnPointsFrom(shipped);
    expect(spawnPointsFrom(loadMapFile().doc)).toEqual(before);
  });
});
