/**
 * A tick that costs what is near you (spec 206).
 *
 * Three things inside a tick used to be sized by what the world contained
 * rather than by what was near anybody. `segment-clear.test.ts` covers the
 * biggest of them against the walk it replaces; this covers the two in the sim,
 * and it asserts them by **counting** rather than by timing -- a clock in the
 * suite is a test about this container.
 */

import { describe, expect, it } from 'vitest';

import { createWorldColliders } from '../../sim/collision.js';
import { CHUNK_SIZE, DEFAULT_LIVE_CONFIG, SERVER_PLAYER_RADIUS } from '../config.js';
import { monsterById } from '../data/monsters.js';
import { chunkKeysInRadius } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import type { SpawnPoint } from '../world/spawners.js';
import { notice, playersOf } from './aggro.js';
import { AggroValue, EntityKindValue, type ServerEntity, type ServerWorldState } from './types.js';
import { createWorldState, spawnEntity, step, type StepContext } from './world.js';

const SPIDER = monsterById('small_spider');
if (!SPIDER) throw new Error('no small_spider in the table');
const SPIDER_STATS = SPIDER.stats;
const SPIDER_RADIUS = SPIDER.radius;

const WORLD = createWorldColliders([], [], { x: -200000, y: -200000, w: 400000, h: 400000 });

function activeAt(x: number, y: number, radius = 2): Set<string> {
  return new Set(
    chunkKeysInRadius({ cx: Math.floor(x / CHUNK_SIZE), cy: Math.floor(y / CHUNK_SIZE) }, radius),
  );
}

function context(active: Set<string>, spawnPoints: readonly SpawnPoint[], overrides = {}): StepContext {
  return {
    world: WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: DEFAULT_LIVE_CONFIG,
    activeChunks: active,
    chunkSize: CHUNK_SIZE,
    spawnPoints,
    ...overrides,
  };
}

function withPlayer(state: ServerWorldState, x: number, y: number) {
  const result = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: `p${String(state.nextEntityId)}`,
    position: { x, y, z: 0 },
    stats: SPIDER_STATS,
    radius: SERVER_PLAYER_RADIUS,
    zoneId: 'greenmarch',
  });
  return { state: result.state, id: result.entity.id };
}

/** `n` spawn points on a line, `gap` apart, starting at the origin. */
function line(n: number, gap: number): SpawnPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${String(i)}`,
    monsterId: 'small_spider',
    x: i * gap,
    y: 0,
    respawnTicks: null,
    leashRadius: null,
    when: null,
  }));
}

describe('spawn points nobody is near', () => {
  it('are not visited at all, counted rather than timed', () => {
    // A spawner is only written into the state's map when it is *looked at*, so
    // the size of that map is exactly how many were considered. It used to be
    // every point the map declared, every tick, however far away.
    const points = line(400, 2000);
    const player = withPlayer(createWorldState(1), 0, 0);
    const result = step(player.state, [], context(activeAt(0, 0), points));
    expect(points).toHaveLength(400);
    expect(result.state.spawners.size).toBeGreaterThan(0);
    expect(result.state.spawners.size).toBeLessThan(10);
  });

  it('are still visited once somebody walks over to them', () => {
    // The control: "nothing is ever considered" would pass the assertion above
    // and be a world with no monsters in it.
    const points = line(400, 2000);
    const far = points[200];
    if (!far) throw new Error('no point');
    const player = withPlayer(createWorldState(1), far.x, far.y);
    const result = step(player.state, [], context(activeAt(far.x, far.y), points));
    const spawned = [...result.state.entities.values()].filter((e) => e.spawnerId === far.id);
    expect(spawned).toHaveLength(1);
  });

  it('holds the same population however many there are elsewhere', () => {
    const populate = (n: number): number => {
      const player = withPlayer(createWorldState(1), 0, 0);
      return step(player.state, [], context(activeAt(0, 0), line(n, 2000))).state.entities.size;
    };
    expect(populate(1000)).toBe(populate(10));
  });
});

describe('the population cap', () => {
  /** One spawner, and `filler` bodies already standing on it. */
  function crowded(filler: number, cap: number) {
    let state = createWorldState(1);
    const player = withPlayer(state, 10, 10);
    state = player.state;
    const bodies: number[] = [];
    for (let i = 0; i < filler; i++) {
      const made = spawnEntity(state, {
        kind: EntityKindValue.Monster,
        typeId: 'small_spider',
        position: { x: 20 + i, y: 20, z: 0 },
        stats: SPIDER_STATS,
        radius: SPIDER_RADIUS,
        zoneId: 'greenmarch',
      });
      state = made.state;
      bodies.push(made.entity.id);
    }
    const points: SpawnPoint[] = [
      { id: 's0', monsterId: 'small_spider', x: 30, y: 30, respawnTicks: null, leashRadius: null, when: null },
    ];
    const ctx = context(activeAt(0, 0), points, {
      config: { ...DEFAULT_LIVE_CONFIG, maxEntitiesPerChunk: cap },
    });
    return { state, ctx, bodies };
  }

  it('still refuses a spawn in a chunk that is full', () => {
    const { state, ctx } = crowded(4, 5);
    const after = step(state, [], ctx).state;
    expect([...after.entities.values()].some((e) => e.spawnerId === 's0')).toBe(false);
  });

  it('counts *this* tick, including a body killed earlier in it', () => {
    // The reason the count is taken from the live entity map rather than from
    // `ChunkManager.populationOf`, which the plan proposed: the manager is
    // updated after `step()` returns, so inside a tick it holds the previous
    // tick's occupancy and would still be counting a body the sweep a few passes
    // above `runSpawners` has already buried.
    const { state, ctx, bodies } = crowded(4, 5);
    const doomed = bodies[0];
    if (doomed === undefined) throw new Error('no body');
    const dying = new Map(state.entities);
    const body = dying.get(doomed);
    if (!body) throw new Error('gone');
    dying.set(doomed, { ...body, health: 0 });

    const after = step({ ...state, entities: dying }, [], ctx).state;
    expect(after.entities.has(doomed)).toBe(false);
    // The chunk had room the instant that body was swept, so the spawn lands on
    // the same tick rather than waiting for the next one.
    expect([...after.entities.values()].some((e) => e.spawnerId === 's0')).toBe(true);
  });
});

describe('noticing costs what is in the world, not what the world holds', () => {
  function monster(x: number, y: number): ServerEntity {
    return {
      ...([...withPlayer(createWorldState(1), 0, 0).state.entities.values()][0] as ServerEntity),
      id: 999,
      kind: EntityKindValue.Monster,
      typeId: 'small_spider',
      position: { x, y, z: 0 },
      aggro: AggroValue.Calm,
      targetId: null,
      aggroUntilTick: 0,
    };
  }

  it('gathers the players and nothing else', () => {
    let state = createWorldState(1);
    const a = withPlayer(state, 0, 0);
    state = a.state;
    const b = withPlayer(state, 40, 0);
    state = b.state;
    const made = spawnEntity(state, {
      kind: EntityKindValue.Monster,
      typeId: 'small_spider',
      position: { x: 500, y: 500, z: 0 },
      stats: SPIDER_STATS,
      radius: SPIDER_RADIUS,
      zoneId: 'greenmarch',
    });
    state = made.state;
    expect(playersOf(state.entities).map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('keeps the insertion-order tie rule', () => {
    // `nearestQuarry` breaks an exact tie with a strict `<`, so the first body
    // in insertion order keeps it. A gathered list that reordered them would be
    // a different answer on a tie -- the sort of divergence that shows up once
    // in a thousand replays.
    let state = createWorldState(1);
    const first = withPlayer(state, -100, 0);
    state = first.state;
    const second = withPlayer(state, 100, 0);
    state = second.state;

    const players = playersOf(state.entities);
    const seen = notice(monster(0, 0), players, 0);
    expect(seen.targetId).toBe(first.id);
    // And reversing the list picks the other one, which is what makes the
    // assertion above about order rather than about geometry.
    expect(notice(monster(0, 0), [...players].reverse(), 0).targetId).toBe(second.id);
  });

  it('picks the nearest when there is no tie', () => {
    let state = createWorldState(1);
    const far = withPlayer(state, -200, 0);
    state = far.state;
    const near = withPlayer(state, 60, 0);
    state = near.state;
    expect(notice(monster(0, 0), playersOf(state.entities), 0).targetId).toBe(near.id);
  });

  it('sees nobody when every player is out of range', () => {
    let state = createWorldState(1);
    state = withPlayer(state, 100000, 0).state;
    const calm = notice(monster(0, 0), playersOf(state.entities), 0);
    expect(calm.targetId).toBeNull();
    expect(calm.aggro).toBe(AggroValue.Calm);
  });
});
