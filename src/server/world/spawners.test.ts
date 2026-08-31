import { describe, expect, it } from 'vitest';
import type { MapDocument, MapMarker } from '../../terrain/index.js';
import { monsterById, noticeRangeOf } from '../data/monsters.js';
import { DEFAULT_SPAWN } from '../player/player-manager.js';
import { loadMapFile } from './map-file.js';
import { SERVER_TICK_RATE } from '../config.js';
import { spawnPointsFrom, SpawnerError } from './spawners.js';
import { worldBoundsOf } from './build.js';
import { MOVE_SPEED_HARD_MIN } from '../../sim/constants.js';

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
    expect(points).toEqual([
      { id: 'spawner-1', monsterId: 'grazer', x: -90, y: -80, respawnTicks: null, leashRadius: null },
    ]);
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

  /** How long a walk from the spawn point still counts as content a player meets. */
  const REACH_SECONDS = 45;

  it('places spawners, and every one names a monster in the table', () => {
    const points = spawnPointsFrom(shipped);
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(monsterById(point.monsterId), point.id).toBeDefined();
    }
  });

  /**
   * What this used to assert was containment in `doc.arena`, and that stopped
   * being the right measure the moment a map put a monster past it on purpose.
   *
   * `arena` is the rectangle `bake-map.ts` writes at the first bake --
   * `PLAY_WIDTH` by `PLAY_HEIGHT`, 1200 by 900 -- and it has never tracked the
   * world since. Spec 165 grew the map to 18,480 by 16,632 and spec 210 grew a
   * shore onto it, leaving that rectangle as 0.35% of one corner; `constants.ts`
   * says so in as many words beside `ARENA_WIDTH`, and spec 221 deleted the
   * hand-authored walls that used to make it a boundary. Nothing clamps to it:
   * `worldBoundsOf` is what bounds movement, and it reads `layer.bounds`.
   *
   * So the rectangle is split into the two claims it was standing in for, and
   * both are stronger than it was -- a spawner outside `arena` used to fail and
   * a spawner in the far corner of the real world used to pass.
   *
   * What is deliberately NOT asserted any more: that a spawner sits in a
   * non-pvp zone. `DEFAULT_ZONES` gives `arena`'s exact rectangle the name
   * `greenmarch`, so the old assertion happened to keep every monster out of
   * The Wilds, and a map may now put one there. That is a map author's decision
   * rather than an invariant -- and it is a real one, so it is written down
   * here rather than lost: the shipped map puts all seven of its hostile
   * spawners in pvp ground and leaves only the sheep inside Greenmarch.
   *
   * Reachability is not asserted either, and that is also deliberate. The five
   * sheep stand in a fenced pasture that is a disconnected nav component --
   * `findPath` from the spawn point returns nothing for any of them -- and a
   * pen you attack over the rail is the intended shape of that pasture.
   */
  it('puts them on the map, inside the ground the document declares', () => {
    const bounds = worldBoundsOf(shipped);
    for (const point of spawnPointsFrom(shipped)) {
      expect(point.x, point.id).toBeGreaterThanOrEqual(bounds.x);
      expect(point.x, point.id).toBeLessThanOrEqual(bounds.x + bounds.w);
      expect(point.y, point.id).toBeGreaterThanOrEqual(bounds.y);
      expect(point.y, point.id).toBeLessThanOrEqual(bounds.y + bounds.h);
    }
  });

  /**
   * The other half: on the map is not the same as in the game. The world is
   * 18,480 across and a spawner in the far corner of it is content nobody will
   * ever walk to.
   *
   * The bound is derived rather than picked. `MOVE_SPEED_HARD_MIN` is the
   * slowest anything in this game may ever move, so `MOVE_SPEED_HARD_MIN *
   * REACH_SECONDS` is the distance even the slowest body covers in
   * `REACH_SECONDS` -- which makes it a distance *anybody* is inside that walk
   * of, rather than a number somebody liked. It is not a loose bound: that
   * circle is 19% of the world's area, so the other 81% still fails.
   *
   * `REACH_SECONDS` was twenty, and twenty was a claim about how far out the
   * map had been *built* rather than about how far a player will walk. The
   * spider nest east of the square sits 3,610-4,065 out, which is a place
   * somebody put monsters on purpose; a bound that called it unreachable was
   * describing a smaller world than the one being made. Forty-five is the
   * furthest of those plus about a tenth, so the next marker nudged a few units
   * outward does not re-open this -- and it is still four fifths of the world
   * refused, which is what keeps it a bound rather than a formality.
   *
   * What it is NOT is permission to place content anywhere. Raise it again only
   * for content somebody has actually authored out there, and re-derive the
   * area fraction above when you do, or the sentence stops being true.
   */
  it('puts them within a walk of the spawn point, where a player will actually meet them', () => {
    const reach = MOVE_SPEED_HARD_MIN * REACH_SECONDS;
    for (const point of spawnPointsFrom(shipped)) {
      const away = Math.hypot(point.x - DEFAULT_SPAWN.x, point.y - DEFAULT_SPAWN.y);
      expect(away, `${point.id} (${point.monsterId}) is ${Math.round(away)} out`).toBeLessThanOrEqual(reach);
    }
  });

  it('survives a round trip through the map serializer', () => {
    const before = spawnPointsFrom(shipped);
    expect(spawnPointsFrom(loadMapFile().doc)).toEqual(before);
  });

  /**
   * Spec 163. Nothing on the shipped map can see the tile every character
   * starts and respawns on.
   *
   * Asserted here rather than trusted, because it is a *product* of two numbers
   * that live in different files and neither of them mentions the other: a
   * marker's position in `maps/arena.json` and a row's `noticeRange` in
   * `data/monsters.ts`. It held for free while spec 076 had nothing initiating
   * at all, and the moment proximity came back it stopped holding -- the spider
   * nest sits 222 units north of `DEFAULT_SPAWN` and was authored to see 300.
   *
   * What that costs if it regresses is the worst failure this feature has: a
   * fresh character attacked before it has moved, and a killed one respawning
   * on the same tile into the same enemies. Hearthstead is not protection --
   * its `pvp: false` gates player-versus-player damage, and no zone flag has
   * ever gated a monster.
   *
   * The margin is deliberate and small. This is not asking for the map to be
   * empty near town; it is asking that the first move be the player's.
   */
  it('places nothing that can see the spawn point before the player has moved', () => {
    const MARGIN = 40;
    for (const point of spawnPointsFrom(shipped)) {
      const row = monsterById(point.monsterId);
      if (!row) continue;
      const sight = noticeRangeOf(row.temperament);
      if (sight <= 0) continue;
      const away = Math.hypot(point.x - DEFAULT_SPAWN.x, point.y - DEFAULT_SPAWN.y);
      expect(away, `${point.id} (${point.monsterId}) sees ${sight} and is ${Math.round(away)} out`)
        .toBeGreaterThan(sight + MARGIN);
    }
  });
});

/**
 * Spec 222. The document may now say two things past which monster stands
 * where, and this file is the one boundary that reads them -- so it is also the
 * one place that decides what "the author did not say" means, and what a number
 * that cannot possibly have been meant costs.
 */
describe("a spawner's own numbers", () => {
  const withSettings = (settings: Record<string, unknown>): MapDocument =>
    doc({ '0,0': [{ ...spawner('spawner-1', 'grazer', 10, 20), spawner: settings }] });

  it('says nothing where the document says nothing', () => {
    const point = spawnPointsFrom(doc({ '0,0': [spawner('spawner-1', 'grazer', 10, 20)] }))[0];
    expect(point?.respawnTicks).toBeNull();
    expect(point?.leashRadius).toBeNull();
  });

  /**
   * The conversion is here and nowhere else: the document is authored in
   * seconds because a person reads it, and the sim counts ticks.
   */
  it('converts the authored seconds into ticks', () => {
    expect(spawnPointsFrom(withSettings({ respawnSeconds: 30 }))[0]?.respawnTicks).toBe(30 * SERVER_TICK_RATE);
    expect(spawnPointsFrom(withSettings({ respawnSeconds: 2.5 }))[0]?.respawnTicks).toBe(150);
  });

  /** A sub-tick wait is a wait of zero, and nobody meant that. */
  it('floors a wait too short to count at one tick', () => {
    expect(spawnPointsFrom(withSettings({ respawnSeconds: 0.001 }))[0]?.respawnTicks).toBe(1);
  });

  it('passes the leash through untouched -- the cap is the sim\'s', () => {
    expect(spawnPointsFrom(withSettings({ leashRadius: 240 }))[0]?.leashRadius).toBe(240);
    // Deliberately past `LEASH_RADIUS`: this file reports what the document
    // asked for, and `sim/world.ts` is where the ceiling lives, beside the nav
    // padding derived from it.
    expect(spawnPointsFrom(withSettings({ leashRadius: 99_999 }))[0]?.leashRadius).toBe(99_999);
  });

  it('takes each of the two without inventing the other', () => {
    expect(spawnPointsFrom(withSettings({ respawnSeconds: 30 }))[0]?.leashRadius).toBeNull();
    expect(spawnPointsFrom(withSettings({ leashRadius: 240 }))[0]?.respawnTicks).toBeNull();
  });

  /**
   * Refused at boot, on the same terms as an unknown monster: a spawner with a
   * zero respawn time or a negative leash looks, from inside the game, exactly
   * like a patch of ground behaving strangely.
   */
  it.each([
    ['respawnSeconds', 0],
    ['respawnSeconds', -5],
    ['respawnSeconds', Number.NaN],
    ['leashRadius', 0],
    ['leashRadius', -100],
    ['leashRadius', Number.POSITIVE_INFINITY],
  ])('refuses a %s of %s', (field, value) => {
    expect(() => spawnPointsFrom(withSettings({ [field]: value }))).toThrow(SpawnerError);
    // Named, because "somewhere in the map" is not a bug report.
    expect(() => spawnPointsFrom(withSettings({ [field]: value }))).toThrow(
      new RegExp(`spawner-1.*${field}`),
    );
  });
});
