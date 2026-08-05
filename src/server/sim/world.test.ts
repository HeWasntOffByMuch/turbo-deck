import { describe, expect, it } from 'vitest';
import { circleBlocked, createWorldColliders, DEFAULT_WORLD } from '../../sim/collision.js';
import { ARENA_OBSTACLES, WORLD_BOUNDS } from '../../sim/constants.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE, type LiveConfig } from '../config.js';
import { monsterById } from '../data/monsters.js';
import { CorrectionReason } from '../net/protocol.js';
import { computeEffectiveStats } from '../player/stats.js';
import { EMPTY_EQUIPMENT, type EffectiveStats, type PersistedPlayer } from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN, type TerrainSampler } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import {
  EntityKindValue,
  type ServerInput,
  type ServerWorldState,
} from './types.js';
import { createWorldState, spawnEntity, step, type StepContext } from './world.js';

const RECORD: PersistedPlayer = {
  id: 'p1',
  displayName: 'P1',
  baseStats: { strength: 5, dexterity: 5, intelligence: 5, vitality: 5 },
  skills: [],
  equipment: EMPTY_EQUIPMENT,
  position: { x: 600, y: 450, z: 0 },
  facing: 0,
  currentZone: 'hearth',
  level: 1,
  experience: 0,
  unspentSkillPoints: 0,
  health: 100,
  resource: 20,
};

const PLAYER_STATS: EffectiveStats = computeEffectiveStats(RECORD);
const CHUNK = 100;

/** Everything within a wide radius is active, so nothing is skipped by accident. */
function activeAround(...points: readonly { x: number; y: number }[]): Set<string> {
  const keys = new Set<string>();
  for (const point of points) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        keys.add(chunkKeyOf(point.x + dx * CHUNK, point.y + dy * CHUNK, CHUNK));
      }
    }
  }
  return keys;
}

function context(overrides: Partial<StepContext> = {}): StepContext {
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: DEFAULT_LIVE_CONFIG,
    activeChunks: activeAround({ x: 600, y: 450 }),
    chunkSize: CHUNK,
    ...overrides,
  };
}

function withPlayer(
  state: ServerWorldState,
  x: number,
  y: number,
  stats: EffectiveStats = PLAYER_STATS,
): { state: ServerWorldState; id: number } {
  const result = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x, y, z: 0 },
    stats,
    radius: 16,
    zoneId: 'greenmarch',
  });
  return { state: result.state, id: result.entity.id };
}

function withMonster(
  state: ServerWorldState,
  typeId: string,
  x: number,
  y: number,
): { state: ServerWorldState; id: number } {
  const definition = monsterById(typeId);
  if (!definition) throw new Error(`no monster ${typeId}`);
  const result = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId,
    position: { x, y, z: 0 },
    stats: definition.stats,
    radius: definition.radius,
    zoneId: 'greenmarch',
  });
  return { state: result.state, id: result.entity.id };
}

function input(entityId: number, seq: number, overrides: Partial<ServerInput> = {}): ServerInput {
  return {
    entityId,
    seq,
    moveX: 0,
    moveY: 0,
    facing: 0,
    buttons: 0,
    predictedX: 0,
    predictedY: 0,
    hasPrediction: true,
    castAbilityId: '',
    castTargetX: 0,
    castTargetY: 0,
    cancelCast: false,
    ...overrides,
  };
}

/** Everything that must match between two replays of the same seed and inputs. */
function snapshot(state: ServerWorldState): string {
  return JSON.stringify({
    tick: state.tick,
    nextEntityId: state.nextEntityId,
    rng: state.rng.getState(),
    entities: [...state.entities.values()],
  });
}

describe('determinism', () => {
  /** A scripted, seeded input sequence -- no Math.random anywhere. */
  function script(entityId: number, ticks: number): ServerInput[][] {
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const frames: ServerInput[][] = [];
    for (let tick = 0; tick < ticks; tick++) {
      const angle = next() * Math.PI * 2;
      frames.push([
        input(entityId, tick + 1, {
          moveX: Math.cos(angle),
          moveY: Math.sin(angle),
          facing: angle,
          castAbilityId: next() > 0.7 ? 'melee.slash' : '',
          castTargetX: 660,
          castTargetY: 450,
          predictedX: 600,
          predictedY: 450,
        }),
      ]);
    }
    return frames;
  }

  function run(ticks: number): ServerWorldState {
    let state = createWorldState(99);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const monster = withMonster(state, 'stalker', 660, 450);
    state = monster.state;

    const frames = script(player.id, ticks);
    const ctx = context();
    for (const frame of frames) state = step(state, frame, ctx).state;
    return state;
  }

  it('replays a seed and an input sequence to bit-identical state', () => {
    expect(snapshot(run(120))).toBe(snapshot(run(120)));
  });

  it('diverges when the seed changes, so the test is actually watching something', () => {
    let a = createWorldState(1);
    let b = createWorldState(2);
    const spawnA = withPlayer(a, 600, 450);
    const spawnB = withPlayer(b, 600, 450);
    a = withMonster(spawnA.state, 'stalker', 640, 450).state;
    b = withMonster(spawnB.state, 'stalker', 640, 450).state;
    const ctx = context({ config: { ...DEFAULT_LIVE_CONFIG, spawnIntervalTicks: 5 } });
    for (let tick = 0; tick < 60; tick++) {
      a = step(a, [], ctx).state;
      b = step(b, [], ctx).state;
    }
    expect(snapshot(a)).not.toBe(snapshot(b));
  });

  it('never advances more than one tick per call', () => {
    let state = createWorldState(4);
    state = withPlayer(state, 600, 450).state;
    for (let expected = 1; expected <= 5; expected++) {
      state = step(state, [], context()).state;
      expect(state.tick).toBe(expected);
    }
  });
});

describe('movement validation', () => {
  it('walks exactly one tick of the derived speed, no matter what the client sends', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    // A direction vector a hundred times too long buys nothing.
    const result = step(
      state,
      [input(player.id, 1, { moveX: 100, moveY: 0, predictedX: 600, predictedY: 450 })],
      context(),
    );
    const moved = result.state.entities.get(player.id);
    const perTick = PLAYER_STATS.moveSpeed / SERVER_TICK_RATE;
    expect(moved?.position.x).toBeCloseTo(600 + perTick, 5);
  });

  it('flags a client that claims to have travelled further than a tick allows', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const ctx = context();
    const perTick = PLAYER_STATS.moveSpeed / SERVER_TICK_RATE;

    // An honest first input, which is what gives the next one a claim to be
    // measured against.
    state = step(
      state,
      [input(player.id, 1, { moveX: 1, moveY: 0, predictedX: 600 + perTick, predictedY: 450 })],
      ctx,
    ).state;

    // Then a claim to have crossed the map in one tick.
    const result = step(
      state,
      [input(player.id, 2, { moveX: 1, moveY: 0, predictedX: 5000, predictedY: 450 })],
      ctx,
    );
    expect(result.events.find((event) => event.kind === 'correction')).toMatchObject({
      reason: CorrectionReason.SpeedViolation,
      inputSeq: 2,
    });
  });

  it('does not flag a client that is simply running ahead of the server', () => {
    // The regression this exists for: a client predicts ahead of the server by
    // its one-way latency, so its claim is always a few ticks in front of where
    // the server has it. Measured against the server's position that reads as a
    // speed hack on every input; measured against the client's own previous
    // claim -- which is what the check does -- it reads as walking.
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const ctx = context();
    const perTick = PLAYER_STATS.moveSpeed / SERVER_TICK_RATE;
    const LEAD_TICKS = 6; // ~100ms of one-way latency at 60Hz

    let corrections = 0;
    for (let tick = 1; tick <= 40; tick++) {
      const claimedX = 600 + perTick * (tick + LEAD_TICKS);
      const result = step(
        state,
        [input(player.id, tick, { moveX: 1, moveY: 0, predictedX: claimedX, predictedY: 450 })],
        ctx,
      );
      state = result.state;
      corrections += result.events.filter((event) => event.kind === 'correction').length;
    }
    expect(corrections).toBe(0);
  });

  it('says nothing at all when the prediction is close enough', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const perTick = PLAYER_STATS.moveSpeed / SERVER_TICK_RATE;

    const result = step(
      state,
      [input(player.id, 1, { moveX: 1, moveY: 0, predictedX: 600 + perTick, predictedY: 450 })],
      context(),
    );
    expect(result.events.filter((event) => event.kind === 'correction')).toEqual([]);
  });

  it('corrects a drift past the threshold, and only past it', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Within one tick's travel of the last position, but far from where the
    // server put them: drift, not a speed hack.
    const loose: LiveConfig = { ...DEFAULT_LIVE_CONFIG, correctionThreshold: 1 };
    const perTick = PLAYER_STATS.moveSpeed / SERVER_TICK_RATE;

    const result = step(
      state,
      [input(player.id, 1, { moveX: 1, moveY: 0, predictedX: 600, predictedY: 450 + perTick })],
      context({ config: loose }),
    );
    expect(result.events.find((event) => event.kind === 'correction')).toMatchObject({
      reason: CorrectionReason.Divergence,
    });
  });

  it('refuses to let a body end up inside a wall', () => {
    const wall = ARENA_OBSTACLES[0];
    if (!wall) throw new Error('expected an arena obstacle');
    let state = createWorldState(1);
    // Standing just left of the wall, walking straight into it.
    const player = withPlayer(state, wall.x - 20, wall.y + wall.h / 2);
    state = player.state;

    const ctx = context({
      world: createWorldColliders(ARENA_OBSTACLES, [], WORLD_BOUNDS),
      activeChunks: activeAround({ x: wall.x, y: wall.y }),
    });
    for (let tick = 0; tick < 20; tick++) {
      state = step(state, [input(player.id, tick + 1, { moveX: 1, moveY: 0 })], ctx).state;
    }
    const settled = state.entities.get(player.id);
    expect(settled).toBeDefined();
    // Never crossed into the wall's span.
    expect(settled?.position.x).toBeLessThan(wall.x);
  });

  it('refuses a step up a cliff, and reports it as a collision', () => {
    // Ground is flat until x = 611, then a sheer 200-unit wall of rock -- close
    // enough that one tick of travel (~2.46 units at 60Hz) runs into it.
    const cliff: TerrainSampler = { heightAt: (x) => (x > 611 ? 200 : 0) };
    let state = createWorldState(1);
    const player = withPlayer(state, 610, 450);
    state = player.state;

    // The client predicted the walk succeeded: a legal distance, wrong place.
    // That is a collision correction, not a speed violation.
    const result = step(
      state,
      [input(player.id, 1, { moveX: 1, moveY: 0, predictedX: 612.5, predictedY: 450 })],
      context({ terrain: cliff }),
    );
    expect(result.state.entities.get(player.id)?.position.x).toBe(610);
    expect(result.events.find((event) => event.kind === 'correction')).toMatchObject({
      reason: CorrectionReason.Collision,
    });
  });

  it('refuses to walk into deep water', () => {
    const lake: TerrainSampler = { heightAt: (x) => (x > 616 ? -100 : 0) };
    let state = createWorldState(1);
    const player = withPlayer(state, 615, 450);
    state = player.state;

    const result = step(
      state,
      [input(player.id, 1, { moveX: 1, moveY: 0 })],
      context({ terrain: lake }),
    );
    expect(result.state.entities.get(player.id)?.position.x).toBe(615);
  });

  it('keeps a body inside the world bounds', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, WORLD_BOUNDS.x + 20, 450);
    state = player.state;
    const ctx = context({ activeChunks: activeAround({ x: WORLD_BOUNDS.x, y: 450 }) });
    for (let tick = 0; tick < 30; tick++) {
      state = step(state, [input(player.id, tick + 1, { moveX: -1, moveY: 0 })], ctx).state;
    }
    expect(state.entities.get(player.id)?.position.x).toBeGreaterThanOrEqual(WORLD_BOUNDS.x);
  });
});

describe('chunk activation gates simulation', () => {
  it('leaves a monster in an inactive chunk exactly where it was', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Well outside the active window built around the player.
    const monster = withMonster(state, 'stalker', 9000, 9000);
    state = monster.state;

    const ctx = context({ activeChunks: activeAround({ x: 600, y: 450 }) });
    const before = state.entities.get(monster.id)?.position;
    for (let tick = 0; tick < 40; tick++) state = step(state, [], ctx).state;
    expect(state.entities.get(monster.id)?.position).toEqual(before);
  });

  it('runs the ambient spawner only in active chunks, and stops when told to', () => {
    let state = createWorldState(7);
    state = withPlayer(state, 100, 100).state;
    const active = activeAround({ x: 100, y: 100 });

    const busy = context({
      activeChunks: active,
      config: { ...DEFAULT_LIVE_CONFIG, spawnIntervalTicks: 5, spawnRateMultiplier: 1 },
    });
    for (let tick = 0; tick < 40; tick++) state = step(state, [], busy).state;
    const populated = state.entities.size;
    expect(populated).toBeGreaterThan(1);

    // An admin turning the rate to zero stops it without a restart.
    const stopped = context({
      activeChunks: active,
      config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    });
    for (let tick = 0; tick < 40; tick++) state = step(state, [], stopped).state;
    expect(state.entities.size).toBeLessThanOrEqual(populated);
  });

  it('respects the per-chunk population cap', () => {
    let state = createWorldState(11);
    state = withPlayer(state, 100, 100).state;
    const ctx = context({
      activeChunks: new Set([chunkKeyOf(100, 100, CHUNK)]),
      config: {
        ...DEFAULT_LIVE_CONFIG,
        spawnIntervalTicks: 1,
        maxEntitiesPerChunk: 3,
      },
    });
    for (let tick = 0; tick < 100; tick++) state = step(state, [], ctx).state;
    const inChunk = [...state.entities.values()].filter(
      (entity) => chunkKeyOf(entity.position.x, entity.position.y, CHUNK) === chunkKeyOf(100, 100, CHUNK),
    );
    expect(inChunk.length).toBeLessThanOrEqual(4);
  });
});


/**
 * Spec 065. `src/sim/pathfinding.ts` survived every deletion and nothing in the
 * server had ever imported it, so a monster walked into a wall and slid along it
 * until the player happened to come back into the open.
 */
describe('monsters find their way round', () => {
  /** A long wall between (600,450) and (900,450), with open ground above and below. */
  const WALL = { x: 740, y: 250, w: 40, h: 400 };
  const walled = createWorldColliders([WALL], [], WORLD_BOUNDS);

  function chase(
    ticks: number,
    world = walled,
  ): { distance: number; monsterX: number; monsterY: number; path: number } {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Beyond the wall, and well inside a stalker's aggro range.
    const monster = withMonster(state, 'stalker', 900, 450);
    state = monster.state;

    const ctx = context({ world, activeChunks: activeAround({ x: 750, y: 450 }) });
    for (let i = 0; i < ticks; i++) state = step(state, [], ctx).state;

    const at = state.entities.get(monster.id);
    return {
      distance: Math.hypot((at?.position.x ?? 0) - 600, (at?.position.y ?? 0) - 450),
      monsterX: at?.position.x ?? 0,
      monsterY: at?.position.y ?? 0,
      path: at?.path?.length ?? 0,
    };
  }

  it('gets round a wall that straight-line homing would stall against', () => {
    const start = Math.hypot(900 - 600, 0);
    const after = chase(SERVER_TICK_RATE * 6);

    // It closed most of the gap, which it cannot do by pressing into the wall.
    expect(after.distance).toBeLessThan(start * 0.35);
    // And it went around rather than through: the wall spans y 250..650, so
    // getting past it means having left the straight line at some point.
    expect(after.monsterX).toBeLessThan(WALL.x);
  });

  it('never ends up inside the wall it routed around', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const monster = withMonster(state, 'stalker', 900, 450);
    state = monster.state;

    const ctx = context({ world: walled, activeChunks: activeAround({ x: 750, y: 450 }) });
    const radius = monsterById('stalker')?.radius ?? 20;
    for (let i = 0; i < SERVER_TICK_RATE * 6; i++) {
      state = step(state, [], ctx).state;
      const at = state.entities.get(monster.id)?.position;
      if (!at) continue;
      expect(circleBlocked({ x: at.x, y: at.y }, radius, walled)).toBe(false);
    }
  });

  /**
   * The straight line is the common case and it must stay free -- a monster
   * chasing across open ground should never touch the grid, nor carry a route
   * it is not using.
   */
  it('carries no route at all when the way is clear', () => {
    const after = chase(SERVER_TICK_RATE, DEFAULT_WORLD);
    expect(after.path).toBe(0);
    expect(after.distance).toBeLessThan(300);
  });
});
