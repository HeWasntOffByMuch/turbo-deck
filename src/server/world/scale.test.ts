/**
 * What costs more when the world gets bigger (spec 197).
 *
 * `scripts/bench-map.ts` times it; this asserts the half that is countable,
 * because a wall-clock assertion in the suite is a flake. Two claims are pinned
 * here and they point in opposite directions:
 *
 * - **What the tick simulates is bounded by where the players are.** Specs
 *   056/192/193 built `isSimulated` to make that true and no test has ever said
 *   so.
 * - **What the world *holds* is not bounded by anything.** `isSimulated` gates
 *   stepping rather than existing, and `runSpawners` walks every spawn point in
 *   the world every tick with no residency gate at all -- so the first tick
 *   populates the whole map and entity memory grows with it wherever the
 *   players are. That is the hole spec 202 closes, and it is asserted here as
 *   the *current* behaviour so that closing it is a visible diff rather than a
 *   claim.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { MAP_VERSION, parseMap, serializeMap, type MapDocument } from '../../terrain/map.js';
import { loadMap } from '../../terrain/map-world.js';
import { encodeMapInfo } from '../net/map-messages.js';
import { buildWorldFromMap } from './build.js';
import { infoFromIndex, tiledMap } from './tiled-map.js';
import { ChunkManager } from './chunk-manager.js';
import { chunkKeyOf } from './chunks.js';
import { ZoneManager } from './zone-manager.js';
import { FLAT_TERRAIN } from './terrain.js';
import { CHUNK_SIZE, DEFAULT_LIVE_CONFIG, INTEREST_CHUNK_RADIUS } from '../config.js';
import { createWorldState, spawnEntity, step, type StepContext } from '../sim/world.js';
import { EntityKindValue } from '../sim/types.js';
import { createWorldColliders } from '../../sim/collision.js';
import { monsterById } from '../data/monsters.js';
import { spawnPointsFrom } from './spawners.js';
import { computeEffectiveStats } from '../player/stats.js';
import { EMPTY_EQUIPMENT, emptyInventory, type PersistedPlayer } from '../state/types.js';

const SOURCE = parseMap(readFileSync('maps/arena.json', 'utf8'));

/** Small enough that the suite stays fast, far enough apart that a slope shows. */
const SMALL = 64;
const BIG = 256;

const RECORD: PersistedPlayer = {
  id: 'p1',
  displayName: 'P1',
  baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
  skills: [],
  equipment: EMPTY_EQUIPMENT,
  inventory: emptyInventory(),
  coins: 0,
  position: { x: 600, y: 450, z: 0 },
  facing: 0,
  currentZone: 'hearth',
  level: 1,
  experience: 0,
  unspentSkillPoints: 0,
  unspentAttributePoints: 0,
  health: 100,
  resource: 20,
};
const PLAYER_STATS = computeEffectiveStats(RECORD);

function activeAround(x: number, y: number, radius = 3): Set<string> {
  const keys = new Set<string>();
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      keys.add(chunkKeyOf(x + dx * CHUNK_SIZE, y + dy * CHUNK_SIZE, CHUNK_SIZE));
    }
  }
  return keys;
}

describe('tiledMap', () => {
  it('is deterministic', () => {
    expect(tiledMap(SOURCE, 40)).toEqual(tiledMap(SOURCE, 40));
  });

  it('produces exactly the chunk count asked for', () => {
    for (const n of [1, 7, 40, 100]) {
      expect(tiledMap(SOURCE, n).layers[0]?.chunks).toHaveLength(n);
    }
  });

  it('refuses a count that is not a positive whole number', () => {
    expect(() => tiledMap(SOURCE, 0)).toThrow(/positive integer/);
    expect(() => tiledMap(SOURCE, -3)).toThrow(/positive integer/);
    expect(() => tiledMap(SOURCE, 2.5)).toThrow(/positive integer/);
  });

  it('tiles only full-size chunks, so the grid has no holes in it', () => {
    const cells = SOURCE.grid.chunkCells;
    for (const chunk of tiledMap(SOURCE, 60).layers[0]?.chunks ?? []) {
      expect(chunk.cols).toBe(cells);
      expect(chunk.rows).toBe(cells);
    }
  });

  it('round-trips through the document format and samples its ground', () => {
    const doc = tiledMap(SOURCE, 25);
    const reparsed = parseMap(serializeMap(doc));
    expect(reparsed.layers[0]?.chunks).toHaveLength(25);

    const loaded = loadMap(reparsed);
    const layer = reparsed.layers[0];
    if (!layer) throw new Error('no layer');
    const extent = reparsed.grid.cellSize * reparsed.grid.chunkCells;
    // The middle of every tile answers with a real height rather than a
    // fallback, which is what says the chunks actually landed where their
    // indices claim.
    for (const chunk of layer.chunks) {
      const x = layer.origin.x + (chunk.cx + 0.5) * extent;
      const z = layer.origin.z + (chunk.cz + 0.5) * extent;
      expect(Number.isFinite(loaded.world.heightAt(x, z))).toBe(true);
    }
  });

  it('keeps marker ids unique across tiles', () => {
    const doc = tiledMap(SOURCE, 200);
    const ids = new Set<string>();
    let total = 0;
    for (const chunk of doc.layers[0]?.chunks ?? []) {
      for (const marker of chunk.markers) {
        ids.add(marker.id);
        total += 1;
      }
    }
    // Deduped by id, `spawnPointsFrom` would otherwise see one spawner however
    // many tiles carried a copy of it.
    expect(ids.size).toBe(total);
  });

  it('keeps the source marker density rather than its marker count', () => {
    const sourceChunks = SOURCE.layers[0]?.chunks ?? [];
    const sourceBearing = sourceChunks.filter((c) => c.markers.length > 0).length;
    const bearingIn = (chunks: number): number =>
      (tiledMap(SOURCE, chunks).layers[0]?.chunks ?? []).filter((c) => c.markers.length > 0).length;

    // Density, not count: a world the size of the source carries what the source
    // carries, and one twice the size carries twice as much. Only 4 of the
    // shipped map's 810 chunks hold a marker, so this is the cheapest place to
    // check the ratio -- a world small enough to build in a test rounds to one
    // either way.
    expect(bearingIn(sourceChunks.length)).toBe(sourceBearing);
    expect(bearingIn(sourceChunks.length * 2)).toBe(sourceBearing * 2);
  });
});

describe('what the tick simulates is bounded by where the players are', () => {
  /**
   * The claim specs 056/192/193 make. A body outside every player's window is
   * not decided for and not moved, so its position after a step is the position
   * it had before -- while a body inside one, wanting the same thing, moves.
   */
  it('steps a body inside the window and leaves one outside it alone', () => {
    // Modest bounds on purpose. A nav grid is built over `world.bounds` at
    // `NAV_CELL_SIZE`, so the 200,000-unit box this first used made a 400M-cell
    // grid the moment anything asked for a route -- which a ferocious body does
    // on its first tick.
    const world = createWorldColliders([], [], { x: -2000, y: -2000, w: 8000, h: 5000 });
    const context: StepContext = {
      world,
      terrain: FLAT_TERRAIN,
      zones: new ZoneManager(),
      config: DEFAULT_LIVE_CONFIG,
      // One chunk wide, so "outside the window" is a few hundred units away
      // rather than a hundred chunks -- which is what keeps the world small.
      activeChunks: activeAround(600, 450, 0),
      chunkSize: CHUNK_SIZE,
      spawnPoints: [],
    };

    let state = createWorldState(1);
    const addPlayer = (x: number, id: string) => {
      const result = spawnEntity(state, {
        kind: EntityKindValue.Player,
        typeId: 'player',
        ownerPlayerId: id,
        position: { x, y: 450, z: 0 },
        stats: PLAYER_STATS,
        radius: 16,
        zoneId: 'greenmarch',
      });
      state = result.state;
      return result.entity;
    };
    // Ferocious, so it commits on sight rather than needing to be hit first --
    // a grazer is skittish and would stand still in both windows, which passes
    // the "far one did not move" half for entirely the wrong reason.
    const hunter = monsterById('small_spider');
    if (!hunter) throw new Error('no small_spider');
    const addHunter = (x: number, targetId: number) => {
      const result = spawnEntity(state, {
        kind: EntityKindValue.Monster,
        typeId: 'small_spider',
        position: { x, y: 450, z: 0 },
        stats: hunter.stats,
        radius: hunter.radius,
        zoneId: 'greenmarch',
        anchor: { x, y: 450 },
        targetId,
      });
      state = result.state;
      return result.entity;
    };

    // Two identical pairs. One pair stands in the active chunk, the other five
    // chunks away; each hunter is inside its own notice range of its own
    // player, so residency is the *only* difference between them.
    const inside = addPlayer(600, 'p-in');
    const outside = addPlayer(600 + 5 * CHUNK_SIZE, 'p-out');
    const near = addHunter(750, inside.id);
    const far = addHunter(600 + 5 * CHUNK_SIZE + 150, outside.id);

    const before = {
      near: { ...state.entities.get(near.id)?.position },
      far: { ...state.entities.get(far.id)?.position },
    };
    for (let i = 0; i < 20; i++) state = step(state, [], context).state;

    expect(state.entities.get(near.id)?.position).not.toEqual(before.near);
    expect(state.entities.get(far.id)?.position).toEqual(before.far);
  });

  it('gives a player the same interest window whatever size the world is', () => {
    const small = new ChunkManager(CHUNK_SIZE);
    const big = new ChunkManager(CHUNK_SIZE);
    small.place(1, 600, 450, true);
    big.place(1, 600, 450, true);
    // The big world also holds bodies far away; the window must not notice.
    // Past the interest radius, which is 8 chunks: at 5 chunks apart the first
    // few of these were legitimately inside the window and the test was wrong
    // rather than the manager.
    const clear = (INTEREST_CHUNK_RADIUS + 2) * CHUNK_SIZE;
    for (let i = 1; i <= 50; i++) big.place(100 + i, 600 + i * clear, 450, false);
    small.refreshActive();
    big.refreshActive();

    expect([...big.activeChunks()].sort()).toEqual([...small.activeChunks()].sort());
    expect(big.interestSet(1)).toEqual(small.interestSet(1));
  });
});

describe('what the world holds is not bounded by anything', () => {
  /**
   * A document with `count` spawner-bearing chunks and nothing else in it.
   * Terrain is not what this is about, and a real bake would bury it -- the
   * same reason `spawners.test.ts` builds its own.
   */
  function docWithSpawners(count: number): MapDocument {
    const cellSize = 10;
    const chunkCells = 10;
    const chunks = [];
    for (let i = 0; i < count; i++) {
      chunks.push({
        cx: i,
        cz: 0,
        cols: chunkCells,
        rows: chunkCells,
        heights: new Array((chunkCells + 1) * (chunkCells + 1)).fill(0) as number[],
        solid: [0, chunkCells * chunkCells],
        materials: [0, chunkCells * chunkCells],
        tones: [0, chunkCells * chunkCells],
        props: [],
        markers: [{ kind: 'spawner' as const, id: `spawner-${String(i)}`, x: 50, z: 50, label: 'grazer' }],
      });
    }
    return {
      version: MAP_VERSION,
      seed: 1,
      grid: { cellSize, chunkCells },
      arena: { minX: 0, minZ: 0, maxX: count * 100, maxZ: 100 },
      layers: [
        {
          id: 'ground',
          seed: 1,
          origin: { x: 0, z: 0 },
          bounds: { minX: 0, minZ: 0, maxX: count * 100, maxZ: 100 },
          baseY: 0,
          waterLevel: null,
          chunks,
        },
      ],
    };
  }

  function populate(count: number): number {
    const context: StepContext = {
      world: createWorldColliders([], [], { x: -100000, y: -100000, w: 200000, h: 200000 }),
      terrain: FLAT_TERRAIN,
      zones: new ZoneManager(),
      config: DEFAULT_LIVE_CONFIG,
      // Deliberately nowhere near the spawners, which all sit within 100 units
      // of the origin.
      activeChunks: activeAround(50000, 50000),
      chunkSize: CHUNK_SIZE,
      spawnPoints: spawnPointsFrom(docWithSpawners(count)),
    };
    return step(createWorldState(1), [], context).state.entities.size;
  }

  /**
   * The hole spec 202 closes, asserted as it stands. `runSpawners` walks every
   * spawn point in the world with no residency gate, so a spawner nobody is
   * near still fills on the first tick -- and a bigger map is a bigger
   * population from tick one however small the window the player is in.
   *
   * When 202 lands these assertions invert, and that is why they are written
   * down now: the fix has to come here and say so rather than quietly changing
   * a number nobody was watching.
   */
  it('fills a spawner that no player is anywhere near', () => {
    expect(populate(1)).toBe(1);
  });

  it('holds more the bigger the map is, whatever the window', () => {
    expect(populate(8)).toBeGreaterThan(populate(2));
  });
});

describe('MapInfo is the size of the world', () => {
  it('grows with the chunk count, and is recorded so the phase that changes it says so', () => {
    const bytes = (chunks: number): number =>
      encodeMapInfo(infoFromIndex(buildWorldFromMap(tiledMap(SOURCE, chunks), 'x').index)).byteLength;

    const small = bytes(SMALL);
    const big = bytes(BIG);
    expect(big).toBeGreaterThan(small);
    // Roughly one coordinate pair per chunk, so four times the world is about
    // four times the message. Loose bounds: this is a baseline to notice moving,
    // not a budget.
    expect(big / small).toBeGreaterThan(2);
    expect(big / small).toBeLessThan(6);
  });
});
