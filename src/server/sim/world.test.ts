import { describe, expect, it } from 'vitest';
import { createWorldColliders, DEFAULT_WORLD } from '../../sim/collision.js';
import { ARENA_OBSTACLES, WORLD_BOUNDS } from '../../sim/constants.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE, type LiveConfig } from '../config.js';
import { monsterById } from '../data/monsters.js';
import { CorrectionReason, InputButton } from '../net/protocol.js';
import { computeEffectiveStats } from '../player/stats.js';
import { EMPTY_EQUIPMENT, type EffectiveStats, type PersistedPlayer } from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN, type TerrainSampler } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import {
  ActivityValue,
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
          buttons: next() > 0.7 ? InputButton.Attack : 0,
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

    const result = step(
      state,
      [input(player.id, 1, { moveX: 1, moveY: 0, predictedX: 5000, predictedY: 450 })],
      context(),
    );
    const correction = result.events.find((event) => event.kind === 'correction');
    expect(correction).toMatchObject({ reason: CorrectionReason.SpeedViolation, inputSeq: 1 });
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
    // Ground is flat until x = 612, then a sheer 200-unit wall of rock -- close
    // enough that one tick of travel (7.375 units) runs straight into it.
    const cliff: TerrainSampler = { heightAt: (x) => (x > 612 ? 200 : 0) };
    let state = createWorldState(1);
    const player = withPlayer(state, 610, 450);
    state = player.state;

    // The client predicted the walk succeeded: a legal distance, wrong place.
    // That is a collision correction, not a speed violation.
    const result = step(
      state,
      [input(player.id, 1, { moveX: 1, moveY: 0, predictedX: 617, predictedY: 450 })],
      context({ terrain: cliff }),
    );
    expect(result.state.entities.get(player.id)?.position.x).toBe(610);
    expect(result.events.find((event) => event.kind === 'correction')).toMatchObject({
      reason: CorrectionReason.Collision,
    });
  });

  it('refuses to walk into deep water', () => {
    const lake: TerrainSampler = { heightAt: (x) => (x > 620 ? -100 : 0) };
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

describe('combat resolution', () => {
  it('lands a hit in the arc, with hitstop and knockback pointing away from the attacker', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const monster = withMonster(state, 'grazer', 640, 450);
    state = monster.state;

    const result = step(
      state,
      [input(player.id, 1, { facing: 0, buttons: InputButton.Attack })],
      context(),
    );
    const hit = result.events.find((event) => event.kind === 'hit');
    expect(hit).toBeDefined();
    if (hit?.kind !== 'hit') throw new Error('expected a hit');

    expect(hit.attackerId).toBe(player.id);
    expect(hit.targetId).toBe(monster.id);
    expect(hit.damage).toBeGreaterThan(0);
    expect(hit.hitstopTicks).toBeGreaterThanOrEqual(1);
    // The target is to the attacker's +x, so it is pushed further along +x.
    expect(hit.knockbackX).toBeGreaterThan(0);
    expect(hit.knockbackY).toBeCloseTo(0, 5);
    expect(hit.knockbackTicks).toBeGreaterThan(0);
    expect(hit.targetHealth).toBeLessThan(monsterMaxHealth('grazer'));
  });

  it('misses a target outside the forward wedge', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Directly behind the attacker, who is facing +x.
    state = withMonster(state, 'grazer', 560, 450).state;

    const result = step(
      state,
      [input(player.id, 1, { facing: 0, buttons: InputButton.Attack })],
      context(),
    );
    expect(result.events.some((event) => event.kind === 'hit')).toBe(false);
    expect(result.events.some((event) => event.kind === 'attackMissed')).toBe(true);
  });

  it('holds the attacker to its cooldown', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withMonster(state, 'ravager', 640, 450).state;

    const ctx = context();
    let hits = 0;
    const cooldown = PLAYER_STATS.attackCooldownTicks;
    for (let tick = 0; tick < cooldown; tick++) {
      const result = step(
        state,
        [input(player.id, tick + 1, { facing: 0, buttons: InputButton.Attack })],
        ctx,
      );
      state = result.state;
      // The ravager is swinging back, so count only the player's own hits.
      hits += result.events.filter(
        (event) => event.kind === 'hit' && event.attackerId === player.id,
      ).length;
    }
    // Mashing attack every tick still only lands one swing inside a cooldown.
    expect(hits).toBe(1);
  });

  it('mitigates damage by the target armour, and flags that it did', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // The ravager carries 18% armour; the grazer has none.
    state = withMonster(state, 'ravager', 645, 450).state;

    const result = step(
      state,
      [input(player.id, 1, { facing: 0, buttons: InputButton.Attack })],
      context(),
    );
    const hit = result.events.find((event) => event.kind === 'hit');
    if (hit?.kind !== 'hit') throw new Error('expected a hit');
    expect(hit.damage).toBeLessThan(PLAYER_STATS.attackDamage);
    expect(hit.blocked).toBe(true);
  });

  it('kills, reports the death, and eventually despawns the corpse', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450, { ...PLAYER_STATS, attackDamage: 1000 });
    state = player.state;
    const monster = withMonster(state, 'grazer', 640, 450);
    state = monster.state;

    const ctx = context();
    const first = step(state, [input(player.id, 1, { facing: 0, buttons: InputButton.Attack })], ctx);
    state = first.state;
    expect(first.events.some((event) => event.kind === 'died')).toBe(true);
    expect(state.entities.get(monster.id)?.activity).toBe(ActivityValue.Dead);

    let despawned = false;
    for (let tick = 0; tick < SERVER_TICK_RATE * 6 && !despawned; tick++) {
      const result = step(state, [], ctx);
      state = result.state;
      despawned = result.events.some(
        (event) => event.kind === 'despawned' && event.entityId === monster.id,
      );
    }
    expect(despawned).toBe(true);
    expect(state.entities.has(monster.id)).toBe(false);
  });

  it('leaves players unable to hurt each other outside a pvp zone', () => {
    let state = createWorldState(1);
    // Hearthstead is the safe hub.
    const attacker = withPlayer(state, 600, 450);
    state = attacker.state;
    state = withPlayer(state, 640, 450).state;

    const result = step(
      state,
      [input(attacker.id, 1, { facing: 0, buttons: InputButton.Attack })],
      context(),
    );
    expect(result.events.some((event) => event.kind === 'hit')).toBe(false);
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

function monsterMaxHealth(typeId: string): number {
  return monsterById(typeId)?.stats.maxHealth ?? 0;
}
