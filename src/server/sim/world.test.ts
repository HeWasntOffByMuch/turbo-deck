import { describe, expect, it } from 'vitest';
import { circleBlocked, createWorldColliders, DEFAULT_WORLD } from '../../sim/collision.js';
import { ARENA_OBSTACLES, PATH_RETRY_TICKS, WORLD_BOUNDS } from '../../sim/constants.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE, type LiveConfig } from '../config.js';
import { abilityById } from '../data/abilities.js';
import { monsterById } from '../data/monsters.js';
import { CorrectionReason } from '../net/protocol.js';
import {
  computeEffectiveStats,
  projectileLifetimeTicks,
  projectileSpeedFor,
} from '../player/stats.js';
import { EMPTY_EQUIPMENT, type EffectiveStats, type PersistedPlayer } from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN, type TerrainSampler } from '../world/terrain.js';
import { SHOT_LAUNCH_HEIGHT } from './ballistics.js';
import { ZoneManager } from '../world/zone-manager.js';
import {
  EntityKindValue,
  type ServerEntity,
  type ServerInput,
  type ServerWorldState,
} from './types.js';
import {
  createWorldState,
  LEASH_RADIUS,
  mergeInputs,
  replaceEntity,
  spawnEntity,
  step,
  type StepContext,
} from './world.js';

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
    spawnPoints: [],
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
  /**
   * Who it is already fighting, and where it considers home.
   *
   * Nothing initiates since spec 076, so a test that wants a monster to walk
   * anywhere has to hand it the target being hit would have given it.
   */
  extra: { targetId?: number; anchor?: { x: number; y: number } } = {},
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
  const next =
    extra.targetId === undefined && extra.anchor === undefined
      ? result.state
      : replaceEntity(result.state, {
          ...result.entity,
          ...(extra.targetId === undefined ? {} : { targetId: extra.targetId }),
          ...(extra.anchor === undefined ? {} : { anchor: extra.anchor }),
        });
  return { state: next, id: result.entity.id };
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
    seqSpan: 1,
    castAbilityId: '',
    castTargetX: 0,
    castTargetY: 0,
    castTargetEntityId: 0,
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
    // its one-way latency, so at any instant its body is several ticks in front
    // of where the server has it. That lead is in *time*, not in the input
    // stream -- a correctly predicting client's claim for input N is exactly
    // where the server will put it when it gets round to applying input N, and
    // both checks are per input. So a hundred milliseconds of ping is invisible
    // here, which is the whole point: it must cost nothing.
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const ctx = context();
    const perTick = PLAYER_STATS.moveSpeed / SERVER_TICK_RATE;

    let corrections = 0;
    for (let tick = 1; tick <= 40; tick++) {
      const claimedX = 600 + perTick * tick;
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

  it('nudges a client that is drifting, long before it is worth a snap', () => {
    // The gap this closes (spec 067): under the 48-unit threshold, nothing used
    // to be sent and nothing was fixed, so a tick of error was permanent and
    // every swing banked another one.
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const perTick = PLAYER_STATS.moveSpeed / SERVER_TICK_RATE;

    // Claims a legal distance, in the wrong direction: one tick of drift.
    const result = step(
      state,
      [input(player.id, 1, { moveX: 1, moveY: 0, predictedX: 600, predictedY: 450 + perTick })],
      context(),
    );
    expect(result.events.find((event) => event.kind === 'correction')).toMatchObject({
      reason: CorrectionReason.Drift,
      inputSeq: 1,
    });
  });

  it('does not answer a claim that is merely rounded', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const perTick = PLAYER_STATS.moveSpeed / SERVER_TICK_RATE;

    // A hundredth of a unit out -- float noise on the wire, not a disagreement.
    const result = step(
      state,
      [input(player.id, 1, { moveX: 1, moveY: 0, predictedX: 600 + perTick + 0.01, predictedY: 450 })],
      context(),
    );
    expect(result.events.filter((event) => event.kind === 'correction')).toEqual([]);
  });

  it('does not read a client snapping to a correction as a speed hack', () => {
    // The feedback loop this closes: a correction moves the client, and its next
    // claim starts from where it was moved to. Measured against its own previous
    // claim that is a teleport, so the nudge earned a second, larger snap.
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const ctx = context();
    const perTick = PLAYER_STATS.moveSpeed / SERVER_TICK_RATE;

    // Walk off in the wrong direction until the server has had enough.
    let corrected = false;
    for (let seq = 1; seq <= 30 && !corrected; seq++) {
      const result = step(
        state,
        [
          input(player.id, seq, {
            moveX: 0,
            moveY: 0,
            predictedX: 600 + perTick * seq,
            predictedY: 450,
          }),
        ],
        ctx,
      );
      state = result.state;
      corrected = result.events.some(
        (event) => event.kind === 'correction' && event.reason === CorrectionReason.Divergence,
      );
    }
    expect(corrected).toBe(true);

    // Now do what a client does with a correction: snap to it.
    const after = step(
      state,
      [input(player.id, 31, { moveX: 0, moveY: 0, predictedX: 600, predictedY: 450 })],
      ctx,
    );
    const speedViolation = after.events.find(
      (event) => event.kind === 'correction' && event.reason === CorrectionReason.SpeedViolation,
    );
    expect(speedViolation).toBeUndefined();
  });

  it('allows a claim the travel its gap in sequence numbers earned', () => {
    // Inputs 2 to 9 never reached the sim -- dropped from a full queue, or lost
    // with the connection. The claim that arrives has had eight ticks to travel
    // and is not a hack.
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const ctx = context();
    const perTick = PLAYER_STATS.moveSpeed / SERVER_TICK_RATE;

    state = step(
      state,
      [input(player.id, 1, { moveX: 1, moveY: 0, predictedX: 600 + perTick, predictedY: 450 })],
      ctx,
    ).state;

    const result = step(
      state,
      [
        input(player.id, 10, {
          moveX: 1,
          moveY: 0,
          seqSpan: 9,
          predictedX: 600 + perTick * 10,
          predictedY: 450,
        }),
      ],
      ctx,
    );
    const violation = result.events.find(
      (event) => event.kind === 'correction' && event.reason === CorrectionReason.SpeedViolation,
    );
    expect(violation).toBeUndefined();
  });

  it('still flags the same claim when nothing was dropped', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const ctx = context();
    const perTick = PLAYER_STATS.moveSpeed / SERVER_TICK_RATE;

    state = step(
      state,
      [input(player.id, 1, { moveX: 1, moveY: 0, predictedX: 600 + perTick, predictedY: 450 })],
      ctx,
    ).state;

    const result = step(
      state,
      [input(player.id, 2, { moveX: 1, moveY: 0, predictedX: 600 + perTick * 10, predictedY: 450 })],
      ctx,
    );
    expect(result.events.find((event) => event.kind === 'correction')).toMatchObject({
      reason: CorrectionReason.SpeedViolation,
    });
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

  it('spawns nothing at all when the map places no spawners', () => {
    let state = createWorldState(7);
    state = withPlayer(state, 100, 100).state;
    const ctx = context({ activeChunks: activeAround({ x: 100, y: 100 }) });
    for (let tick = 0; tick < 120; tick++) state = step(state, [], ctx).state;
    expect(state.entities.size).toBe(1);
  });
});

/** Spec 073. Every enemy in the world stands where the map document put it. */
describe("the map's spawners", () => {
  const POINTS = [
    { id: 'spawner-1', monsterId: 'grazer', x: 620, y: 470 },
    { id: 'spawner-2', monsterId: 'stalker', x: 660, y: 430 },
  ];

  function spawnerContext(overrides: Partial<StepContext> = {}): StepContext {
    return context({
      spawnPoints: POINTS,
      activeChunks: activeAround({ x: 600, y: 450 }),
      ...overrides,
    });
  }

  function monsters(state: ServerWorldState): ServerEntity[] {
    return [...state.entities.values()].filter((e) => e.kind === EntityKindValue.Monster);
  }

  it('fills every spawn point on the first tick, at the marker', () => {
    const state = step(createWorldState(3), [], spawnerContext()).state;
    const live = monsters(state);
    expect(live).toHaveLength(2);
    expect(live.map((m) => m.typeId).sort()).toEqual(['grazer', 'stalker']);
    for (const point of POINTS) {
      const body = live.find((m) => m.spawnerId === point.id);
      expect(body?.position.x).toBe(point.x);
      expect(body?.position.y).toBe(point.y);
      expect(body?.anchor).toEqual({ x: point.x, y: point.y });
    }
  });

  it('never puts a second body on a spawner that still has one', () => {
    let state = createWorldState(3);
    const ctx = spawnerContext();
    for (let tick = 0; tick < 600; tick++) state = step(state, [], ctx).state;
    expect(monsters(state)).toHaveLength(2);
  });

  it('waits the interval after a death, then refills at the marker', () => {
    const interval = 300;
    const ctx = spawnerContext({
      config: { ...DEFAULT_LIVE_CONFIG, spawnIntervalTicks: interval, spawnRateMultiplier: 1 },
    });
    let state = step(createWorldState(3), [], ctx).state;

    // Kill the grazer where it stands, and walk its body somewhere else first so
    // "refills at the marker" is a claim about the marker and not about luck.
    const victim = monsters(state).find((m) => m.spawnerId === 'spawner-1');
    expect(victim).toBeDefined();
    if (!victim) return;
    state = replaceEntity(state, { ...victim, health: 0, position: { x: 900, y: 900, z: 0 } });

    const died = step(state, [], ctx);
    state = died.state;
    // Gone the same tick: no corpse (spec 076).
    expect(state.entities.has(victim.id)).toBe(false);
    expect(died.events.some((e) => e.kind === 'despawned' && e.entityId === victim.id)).toBe(true);
    const deathTick = state.tick;
    expect(state.spawners.get('spawner-1')).toEqual({
      entityId: null,
      readyAtTick: deathTick + interval,
    });

    for (let tick = 0; tick < interval - 1; tick++) state = step(state, [], ctx).state;
    expect(monsters(state)).toHaveLength(1);

    state = step(state, [], ctx).state;
    const replacement = monsters(state).find((m) => m.spawnerId === 'spawner-1');
    expect(replacement).toBeDefined();
    expect(replacement?.position.x).toBe(POINTS[0]?.x);
    expect(replacement?.position.y).toBe(POINTS[0]?.y);
    expect(replacement?.id).not.toBe(victim.id);
  });

  it('stops dead when an admin turns the rate to zero, and resumes when it comes back', () => {
    const off = spawnerContext({
      config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    });
    let state = createWorldState(3);
    for (let tick = 0; tick < 120; tick++) state = step(state, [], off).state;
    expect(monsters(state)).toHaveLength(0);

    state = step(state, [], spawnerContext()).state;
    expect(monsters(state)).toHaveLength(2);
  });

  it('draws no randomness, so spawning cannot shift a combat roll', () => {
    const ctx = spawnerContext();
    let state = createWorldState(3);
    // `Rng` is immutable and `step` only reassigns it when something draws, so
    // the untouched stream is the very same object it started as.
    const before = state.rng;
    for (let tick = 0; tick < 400; tick++) state = step(state, [], ctx).state;
    expect(state.rng).toBe(before);
  });

  it('replays identically from the same seed and the same map', () => {
    const ctx = spawnerContext();
    const run = (): ServerWorldState => {
      let state = createWorldState(9);
      for (let tick = 0; tick < 400; tick++) state = step(state, [], ctx).state;
      return state;
    };
    const a = run();
    const b = run();
    expect([...b.spawners.entries()]).toEqual([...a.spawners.entries()]);
    expect(monsters(b).map((m) => [m.id, m.spawnerId, m.position.x, m.position.y])).toEqual(
      monsters(a).map((m) => [m.id, m.spawnerId, m.position.x, m.position.y]),
    );
  });
});

/** Spec 073. Nothing initiates, and nothing follows you home. */
describe('aggro and the leash', () => {
  it('ignores a player standing on top of it until it is hit', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Well inside a ravager's old aggro range, and then some.
    const monster = withMonster(state, 'ravager', 640, 450);
    state = monster.state;

    const ctx = context({ activeChunks: activeAround({ x: 600, y: 450 }) });
    for (let tick = 0; tick < SERVER_TICK_RATE * 10; tick++) {
      const result = step(state, [], ctx);
      state = result.state;
      expect(result.events.some((e) => e.kind === 'hit')).toBe(false);
    }
    const at = state.entities.get(monster.id);
    expect(at?.targetId).toBeNull();
    expect(at?.position.x).toBe(640);
  });

  it('drops a target it has been dragged too far from, and walks home', () => {
    const anchor = { x: 600, y: 450 };
    let state = createWorldState(1);
    // The player waits well beyond the leash; the monster starts on its anchor
    // already holding the grudge a hit would have given it.
    const player = withPlayer(state, anchor.x + LEASH_RADIUS + 400, anchor.y);
    state = player.state;
    const monster = withMonster(state, 'stalker', anchor.x, anchor.y, {
      targetId: player.id,
      anchor,
    });
    state = monster.state;

    // Every chunk between home and the player, so nothing is skipped as
    // unloaded while the monster walks the length of its leash and back.
    const along: { x: number; y: number }[] = [];
    for (let x = anchor.x - 200; x <= anchor.x + LEASH_RADIUS + 600; x += 100) {
      along.push({ x, y: anchor.y });
    }
    const ctx = context({ activeChunks: activeAround(...along) });

    // Chases out past the leash...
    let broke = false;
    for (let tick = 0; tick < SERVER_TICK_RATE * 30 && !broke; tick++) {
      state = step(state, [], ctx).state;
      broke = state.entities.get(monster.id)?.targetId === null;
    }
    expect(broke).toBe(true);

    // ...and then comes back, even though the player never stopped hitting it:
    // the leash is read before the target, so the grudge is taken straight off
    // again on the tick after it lands.
    for (let tick = 0; tick < SERVER_TICK_RATE * 40; tick++) {
      const body = state.entities.get(monster.id);
      if (body) state = replaceEntity(state, { ...body, targetId: player.id });
      state = step(state, [], ctx).state;
    }
    const home = state.entities.get(monster.id)?.position;
    expect(Math.hypot((home?.x ?? 0) - anchor.x, (home?.y ?? 0) - anchor.y)).toBeLessThan(
      LEASH_RADIUS,
    );
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
    const monster = withMonster(state, 'stalker', 900, 450, { targetId: player.id });
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
    const monster = withMonster(state, 'stalker', 900, 450, { targetId: player.id });
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

  /**
   * Spec 073. A failed search leaves an empty path, which read as an exhausted
   * one -- so the case that costs the most ran on the cadence that costs the
   * most, sixty times a second, per monster.
   */
  describe('when there is no way through at all', () => {
    /** A palisade around the player, with no gate. */
    const PEN = createWorldColliders(
      [
        { x: 500, y: 350, w: 200, h: 40 },
        { x: 500, y: 510, w: 200, h: 40 },
        { x: 500, y: 350, w: 40, h: 200 },
        { x: 660, y: 350, w: 40, h: 200 },
      ],
      [],
      WORLD_BOUNDS,
    );

    /** A monster outside the pen, a player inside it, run for `ticks`. */
    function siege(ticks: number): { path: number | null; repathAtTick: number; tick: number } {
      let state = createWorldState(1);
      const player = withPlayer(state, 600, 450);
      state = player.state;
      // Already fighting the player it cannot reach: nothing initiates since
      // spec 076, so a siege has to start with the grudge a hit would have given.
      const monster = withMonster(state, 'stalker', 600, 280, { targetId: player.id });
      state = monster.state;
      const ctx = context({
        world: PEN,
        activeChunks: activeAround({ x: 600, y: 450 }),
      });
      for (let i = 0; i < ticks; i++) state = step(state, [], ctx).state;
      const at = state.entities.get(monster.id);
      return {
        path: at?.path === null ? null : (at?.path?.length ?? null),
        repathAtTick: at?.repathAtTick ?? 0,
        tick: state.tick,
      };
    }

    it('books its next attempt a retry out, not a replan out', () => {
      const after = siege(1);
      // The search ran and failed, so the empty path is kept as the record of it.
      expect(after.path).toBe(0);
      expect(after.repathAtTick).toBe(after.tick + PATH_RETRY_TICKS);
    });

    it('re-searches on the retry cadence rather than every tick', () => {
      // Well past the first retry: whatever tick the last search ran on, the next
      // one is still a full PATH_RETRY_TICKS away -- which cannot be true of a
      // monster that searched on the tick just gone.
      const after = siege(PATH_RETRY_TICKS * 2 + 5);
      expect(after.path).toBe(0);
      expect(after.repathAtTick).toBeGreaterThan(after.tick);
      expect(after.repathAtTick - after.tick).toBeLessThanOrEqual(PATH_RETRY_TICKS);
      // Searches land on multiples of the retry cadence, not on every tick.
      expect((after.repathAtTick - 1) % PATH_RETRY_TICKS).toBe(0);
    });

    it('still presses toward the player it cannot reach', () => {
      let state = createWorldState(1);
      const player = withPlayer(state, 600, 450);
      state = player.state;
      const monster = withMonster(state, 'stalker', 600, 280, { targetId: player.id });
      state = monster.state;
      const ctx = context({
        world: PEN,
        activeChunks: activeAround({ x: 600, y: 450 }),
      });
      for (let i = 0; i < SERVER_TICK_RATE * 2; i++) state = step(state, [], ctx).state;
      const at = state.entities.get(monster.id)?.position;
      // Up against the pen's north wall rather than idling where it spawned.
      expect(at?.y ?? 0).toBeGreaterThan(280);
      expect(circleBlocked({ x: at?.x ?? 0, y: at?.y ?? 0 }, monsterById('stalker')?.radius ?? 20, PEN)).toBe(false);
    });
  });
});

/**
 * Spec 079. A shot's flight is what decides when it lands, so everything here
 * is measured in ticks between the release and the hit rather than asserted
 * against a schedule.
 */
describe('two inputs in one tick (spec 090)', () => {
  function quiet(overrides: Partial<StepContext> = {}): StepContext {
    return context({
      config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 } as LiveConfig,
      ...overrides,
    });
  }

  /**
   * A cancel that shares a tick with a later input still calls the blow off.
   *
   * Last-write-wins dropped it: `cancelCast` is an edge, true on exactly the
   * frame the key went down, so the very next frame -- which asks for nothing --
   * used to erase it and the shot flew. The controls either side are what make
   * this test mean something: without a cancel the shot flies, with one alone it
   * does not, and the two-input case has to match the second.
   */
  function fire(frameAtTick2: readonly ServerInput[]): boolean {
    let state = createWorldState(3);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const mark = withMonster(state, 'dummy', 800, 450);
    state = mark.state;
    const ctx = quiet({ activeChunks: activeAround({ x: 600, y: 450 }, { x: 800, y: 450 }) });

    const shot = abilityById('ranged.shot');
    if (!shot) throw new Error('no ranged.shot');

    state = step(
      state,
      [
        input(player.id, 1, {
          castAbilityId: 'ranged.shot',
          castTargetX: 800,
          castTargetY: 450,
          castTargetEntityId: mark.id,
          predictedX: 600,
          predictedY: 450,
        }),
      ],
      ctx,
    ).state;
    expect(state.entities.get(player.id)?.cast).not.toBeNull();

    let flew = false;
    for (let i = 0; i < shot.windupTicks + 40; i++) {
      const frame = i === 2 ? frameAtTick2 : [input(player.id, 10 + i)];
      state = step(state, frame, ctx).state;
      if ([...state.entities.values()].some((entity) => entity.projectile)) flew = true;
    }
    return flew;
  }

  it('keeps a cancel that a later input in the same tick used to erase', () => {
    const id = 1;
    // Controls: the rule works when the cancel is the only input that tick.
    expect(fire([input(id, 2)]), 'no cancel asked for').toBe(true);
    expect(fire([input(id, 2, { cancelCast: true })]), 'cancel alone').toBe(false);
    // The bug: the same cancel, with an ordinary idle frame behind it.
    expect(fire([input(id, 2, { cancelCast: true }), input(id, 3)]), 'cancel then idle').toBe(false);
    // And in either order, since a merge must not depend on arrival order.
    expect(fire([input(id, 2), input(id, 3, { cancelCast: true })]), 'idle then cancel').toBe(false);
  });

  it('merges the continuous fields forward and the edges across', () => {
    const older = input(7, 1, { moveX: 1, facing: 0.5, cancelCast: true, castAbilityId: 'melee.slash', castTargetX: 10 });
    const newer = input(7, 2, { moveX: 0, facing: 1.25 });
    const merged = mergeInputs(older, newer);

    // Where the body is heading is the newest word on it.
    expect(merged.moveX).toBe(0);
    expect(merged.facing).toBe(1.25);
    expect(merged.seq).toBe(2);
    // The edges are not undone by a frame that simply did not repeat them.
    expect(merged.cancelCast).toBe(true);
    expect(merged.castAbilityId).toBe('melee.slash');
    expect(merged.castTargetX).toBe(10);

    // A later request replaces an earlier one outright, aim included.
    const recast = mergeInputs(older, input(7, 3, { castAbilityId: 'melee.heavy', castTargetX: 99 }));
    expect(recast.castAbilityId).toBe('melee.heavy');
    expect(recast.castTargetX).toBe(99);
  });
});

describe('shots that travel', () => {
  /**
   * The ambient spawner off, because these tests count `hit` events and a
   * wandering stalker's blows are indistinguishable from an arrow's.
   */
  function quiet(overrides: Partial<StepContext> = {}): StepContext {
    return context({
      config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 } as LiveConfig,
      ...overrides,
    });
  }

  /** Moves a body by hand between ticks -- a dummy has no legs of its own. */
  function nudge(state: ServerWorldState, id: number, dx: number): ServerWorldState {
    const entity = state.entities.get(id);
    if (!entity) return state;
    const entities = new Map(state.entities);
    entities.set(id, { ...entity, position: { ...entity.position, x: entity.position.x + dx } });
    return { ...state, entities };
  }

  /** A player who shoots `abilityId` at `targetId`, committing on the first tick. */
  function shootAt(abilityId: string, playerId: number, targetId: number, x: number, y: number) {
    return (tick: number): ServerInput[] =>
      tick === 0
        ? [
            input(playerId, 1, {
              castAbilityId: abilityId,
              castTargetX: x,
              castTargetY: y,
              castTargetEntityId: targetId,
              predictedX: 600,
              predictedY: 450,
            }),
          ]
        : [];
  }

  /**
   * How far a shot of `abilityId` covers in one tick, in this player's hands.
   *
   * Asked rather than written down, because since spec 087 a shot's speed is
   * the table's number through a global scale. A test that hard-codes "slower
   * than the arrow" as a number is a test that silently stops meaning that the
   * next time the scale moves.
   */
  function flightPerTick(abilityId: string): number {
    const spec = abilityById(abilityId)?.projectile;
    if (!spec) throw new Error(`no projectile on ${abilityId}`);
    return projectileSpeedFor(spec.speed) / SERVER_TICK_RATE;
  }

  /** Ticks that shot stays in the air before it expires, for the same reason. */
  function flightTicks(abilityId: string): number {
    const spec = abilityById(abilityId)?.projectile;
    if (!spec) throw new Error(`no projectile on ${abilityId}`);
    return projectileLifetimeTicks(spec);
  }

  it('spawns nothing before the release, and a projectile on it', () => {
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const dummy = withMonster(state, 'dummy', 800, 450);
    state = dummy.state;
    const ctx = quiet({ activeChunks: activeAround({ x: 600, y: 450 }, { x: 800, y: 450 }) });

    const shoot = shootAt('ranged.shot', player.id, dummy.id, 800, 450);
    let current = state;
    let releaseTick: number | null = null;
    for (let i = 0; i < 40 && releaseTick === null; i++) {
      const result = step(current, shoot(i), ctx);
      current = result.state;
      const projectiles = [...current.entities.values()].filter((e) => e.projectile !== null);
      if (projectiles.length > 0) releaseTick = current.tick;
      // Nothing lands merely by winding up.
      if (releaseTick === null) expect(result.events.some((e) => e.kind === 'hit')).toBe(false);
    }
    expect(releaseTick).not.toBeNull();

    const shot = [...current.entities.values()].find((e) => e.projectile !== null);
    expect(shot?.projectile?.targetEntityId).toBe(dummy.id);
    expect(shot?.kind).toBe(EntityKindValue.Projectile);
  });

  it('follows a target that moves after the loose, and lands late for it', () => {
    // Two identical fights: one where the mark stands, one where it retreats
    // down the line of flight. The travel is the only difference between them.
    function fight(retreatPerTick: number): number | null {
      let state = createWorldState(4);
      const player = withPlayer(state, 600, 450);
      state = player.state;
      const mark = withMonster(state, 'dummy', 900, 450);
      state = mark.state;
      const ctx = quiet({
        activeChunks: activeAround(
          { x: 600, y: 450 },
          { x: 900, y: 450 },
          { x: 1200, y: 450 },
          { x: 1500, y: 450 },
        ),
      });

      const shoot = shootAt('ranged.shot', player.id, mark.id, 900, 450);
      let current = state;
      for (let i = 0; i < flightTicks('ranged.shot'); i++) {
        const result = step(current, shoot(i), ctx);
        current = result.state;
        if (result.events.some((event) => event.kind === 'hit')) return current.tick;
        if (retreatPerTick !== 0) current = nudge(current, mark.id, retreatPerTick);
      }
      return null;
    }

    const standing = fight(0);
    // Half the arrow's speed, so it is caught -- but not before it has run.
    const running = fight(flightPerTick('ranged.shot') / 2);
    expect(standing).not.toBeNull();
    expect(running).not.toBeNull();
    expect(running ?? 0).toBeGreaterThan(standing ?? 0);
  });

  it('lands on the same tick however fast the weapon attacks (spec 088)', () => {
    /** The tick a shot from a body with this attack delay arrives on. */
    function arrival(attackDelayTicks: number): number | null {
      let state = createWorldState(4);
      const player = withPlayer(state, 600, 450, { ...PLAYER_STATS, attackDelayTicks });
      state = player.state;
      const mark = withMonster(state, 'dummy', 900, 450);
      state = mark.state;
      const ctx = quiet({
        activeChunks: activeAround({ x: 600, y: 450 }, { x: 900, y: 450 }),
      });

      const shoot = shootAt('ranged.shot', player.id, mark.id, 900, 450);
      let current = state;
      for (let i = 0; i < flightTicks('ranged.shot'); i++) {
        const result = step(current, shoot(i), ctx);
        current = result.state;
        if (result.events.some((event) => event.kind === 'hit')) return current.tick;
      }
      return null;
    }

    // A body that may attack every twelve ticks and one that must wait five
    // seconds loose the same arrow: the delay governs when the *next* one may
    // be thrown, and nothing about the one already in the air.
    const quick = arrival(12);
    const slow = arrival(300);
    expect(quick).not.toBeNull();
    expect(quick).toBe(slow);
  });

  it('lets a target outrun a shot entirely, and the shot expires', () => {
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const mark = withMonster(state, 'dummy', 900, 450);
    state = mark.state;
    const ctx = quiet({
      activeChunks: activeAround({ x: 600, y: 450 }, { x: 900, y: 450 }, { x: 1200, y: 450 }),
    });

    const shoot = shootAt('ranged.star', player.id, mark.id, 900, 450);
    let current = state;
    let hits = 0;
    // Long enough for the star to have burned out, whatever its speed is.
    for (let i = 0; i < flightTicks('ranged.star') + SERVER_TICK_RATE; i++) {
      const result = step(current, shoot(i), ctx);
      current = result.state;
      hits += result.events.filter((event) => event.kind === 'hit').length;
      // Twice the star's speed, so it is never caught.
      current = nudge(current, mark.id, flightPerTick('ranged.star') * 2);
    }
    expect(hits).toBe(0);
    expect([...current.entities.values()].some((e) => e.projectile !== null)).toBe(false);
  });

  it('is disjointed by a target that leaves the world, and lands on nobody', () => {
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const mark = withMonster(state, 'dummy', 900, 450);
    state = mark.state;
    const ctx = quiet({
      activeChunks: activeAround({ x: 600, y: 450 }, { x: 900, y: 450 }),
    });

    const shoot = shootAt('ranged.shot', player.id, mark.id, 900, 450);
    let current = state;
    let loosed = false;
    for (let i = 0; i < 40 && !loosed; i++) {
      current = step(current, shoot(i), ctx).state;
      loosed = [...current.entities.values()].some((e) => e.projectile !== null);
    }
    expect(loosed).toBe(true);

    // The mark is removed mid-flight: nothing was scheduled, so there is nothing
    // to un-schedule -- the shot simply finishes its flight at a patch of ground.
    const without = new Map(current.entities);
    without.delete(mark.id);
    current = { ...current, entities: without };

    let hits = 0;
    for (let i = 0; i < 200; i++) {
      const result = step(current, [], ctx);
      current = result.state;
      hits += result.events.filter((event) => event.kind === 'hit').length;
    }
    expect(hits).toBe(0);
    expect([...current.entities.values()].some((e) => e.projectile !== null)).toBe(false);
  });

  it('lands on the body it named, whichever way it flew there', () => {
    /** A shot from 600 at a mark at 850, with a body standing at 750 between. */
    function throughAScreen(abilityId: string): {
      readonly struck: number | null;
      readonly tick: number | null;
    } {
      let state = createWorldState(4);
      const player = withPlayer(state, 600, 450);
      state = player.state;
      const screen = withMonster(state, 'dummy', 750, 450);
      state = screen.state;
      const mark = withMonster(state, 'dummy', 850, 450);
      state = mark.state;
      const ctx = quiet({
        activeChunks: activeAround({ x: 600, y: 450 }, { x: 750, y: 450 }, { x: 850, y: 450 }),
      });

      let current = state;
      const shoot = shootAt(abilityId, player.id, mark.id, 850, 450);
      for (let i = 0; i < 200; i++) {
        const result = step(current, shoot(i), ctx);
        current = result.state;
        const hit = result.events.find((event) => event.kind === 'hit');
        if (hit && hit.kind === 'hit') return { struck: hit.targetId, tick: current.tick };
      }
      return { struck: null, tick: null };
    }

    // The mark is entity 3; the screen it flew past is entity 2. Neither shape
    // of flight is stopped by a bystander, because naming a body is what makes
    // a shot single-target -- the arc is a look and buys nothing.
    const lobbed = throughAScreen('ranged.shot');
    const flat = throughAScreen('ranged.star');
    expect(lobbed.struck).toBe(3);
    expect(flat.struck).toBe(3);
  });

  it('flies the same arc over broken ground as over flat (spec 089)', () => {
    /**
     * Every height a shot passes through, over this terrain.
     *
     * The decisive test for spec 089: before it, height was the heightfield
     * *under the shot* plus a bump, so the two runs below differed wildly and
     * an arrow crossing a dip dived into the dip. Now terrain is read at the
     * launch and at the aim and nowhere between, so the ground the shot passes
     * over cannot reach it.
     */
    function heights(terrain: TerrainSampler): number[] {
      let state = createWorldState(4);
      const player = withPlayer(state, 600, 450);
      state = player.state;
      const mark = withMonster(state, 'dummy', 900, 450);
      state = mark.state;
      const ctx = quiet({
        terrain,
        activeChunks: activeAround({ x: 600, y: 450 }, { x: 900, y: 450 }),
      });

      const shoot = shootAt('ranged.shot', player.id, mark.id, 900, 450);
      let current = state;
      const seen: number[] = [];
      for (let i = 0; i < flightTicks('ranged.shot'); i++) {
        const result = step(current, shoot(i), ctx);
        current = result.state;
        for (const entity of current.entities.values()) {
          if (entity.projectile) seen.push(entity.position.z);
        }
        if (result.events.some((event) => event.kind === 'hit')) break;
      }
      return seen;
    }

    // A ridge and a trench *between* the archer and the mark, violent enough
    // that riding it would be unmistakable -- and flat at both ends, because
    // the endpoints are exactly the two places terrain is still allowed to
    // matter. It is the ground in between that must not be able to reach the
    // shot.
    const broken: TerrainSampler = {
      heightAt: (x) => (x > 660 && x < 840 ? Math.sin((x - 660) / 30) * 160 : 0),
    };
    const flat = heights(FLAT_TERRAIN);
    const rough = heights(broken);

    // The flight happened at all, and it is an arc rather than a flat line.
    expect(flat.length).toBeGreaterThan(4);
    expect(Math.max(...flat)).toBeGreaterThan(Math.min(...flat) + 20);
    // And the ground under it changed nothing whatsoever.
    expect(rough).toEqual(flat);
  });

  it('meets a target standing above it, and one standing below (spec 089)', () => {
    /** The last height the shot was seen at, flying at a mark on this ground. */
    function arrivalHeight(markHeight: number): number {
      // Flat under the archer, `markHeight` from halfway out: the shot has to
      // finish on the mark's ground rather than on its own.
      const terrain: TerrainSampler = { heightAt: (x) => (x > 750 ? markHeight : 0) };
      let state = createWorldState(4);
      const player = withPlayer(state, 600, 450);
      state = player.state;
      const mark = withMonster(state, 'dummy', 900, 450);
      state = mark.state;
      const ctx = quiet({
        terrain,
        activeChunks: activeAround({ x: 600, y: 450 }, { x: 900, y: 450 }),
      });

      const shoot = shootAt('ranged.shot', player.id, mark.id, 900, 450);
      let current = state;
      let last = 0;
      for (let i = 0; i < flightTicks('ranged.shot'); i++) {
        const result = step(current, shoot(i), ctx);
        current = result.state;
        for (const entity of current.entities.values()) {
          if (entity.projectile) last = entity.position.z;
        }
        if (result.events.some((event) => event.kind === 'hit')) break;
      }
      return last;
    }

    // Uphill finishes high and downhill finishes low, tracking the ground the
    // *target* stands on rather than the ground under the flight.
    expect(arrivalHeight(200)).toBeGreaterThan(arrivalHeight(0) + 100);
    expect(arrivalHeight(-200)).toBeLessThan(arrivalHeight(0) - 100);
  });

  it('throws a near shot flat and a far one high (spec 089)', () => {
    /** The highest the shot got, flying at a mark this far away. */
    function apex(distance: number): number {
      let state = createWorldState(4);
      const player = withPlayer(state, 600, 450);
      state = player.state;
      const mark = withMonster(state, 'dummy', 600 + distance, 450);
      state = mark.state;
      const ctx = quiet({
        activeChunks: activeAround(
          { x: 600, y: 450 },
          { x: 600 + distance, y: 450 },
          { x: 600 + distance / 2, y: 450 },
        ),
      });

      const shoot = shootAt('ranged.shot', player.id, mark.id, 600 + distance, 450);
      let current = state;
      let high = 0;
      for (let i = 0; i < flightTicks('ranged.shot'); i++) {
        const result = step(current, shoot(i), ctx);
        current = result.state;
        for (const entity of current.entities.values()) {
          if (entity.projectile) high = Math.max(high, entity.position.z);
        }
        if (result.events.some((event) => event.kind === 'hit')) break;
      }
      return high;
    }

    const shot = abilityById('ranged.shot');
    if (!shot) throw new Error('no ranged.shot');
    const near = apex(60);
    const far = apex(shot.range - 20);

    // The near shot barely rises above the height it was loosed at; the far one
    // goes up like a lob. Before spec 089 both peaked at the same 110.
    expect(near).toBeLessThan(SHOT_LAUNCH_HEIGHT + 10);
    expect(far).toBeGreaterThan(near * 3);
  });

  it('does not care how high a shot flew, only that it arrived', () => {
    // The same shot at the same speed, differing only in how high it flew,
    // reaches the same body on the same tick.
    const flat = { ...(abilityById('ranged.star') ?? { projectile: null }) };
    const lobbed = { ...(abilityById('ranged.shot') ?? { projectile: null }) };
    expect(flat.projectile?.arc).toBe(0);
    expect(lobbed.projectile?.arc ?? 0).toBeGreaterThan(0);

    function arrivalOf(arcHeight: number): number | null {
      let state = createWorldState(4);
      const player = withPlayer(state, 600, 450);
      state = player.state;
      const mark = withMonster(state, 'dummy', 850, 450);
      state = mark.state;
      const ctx = quiet({ activeChunks: activeAround({ x: 600, y: 450 }, { x: 850, y: 450 }) });

      let current = state;
      const shoot = shootAt('ranged.star', player.id, mark.id, 850, 450);
      for (let i = 0; i < 200; i++) {
        const result = step(current, shoot(i), ctx);
        current = result.state;
        // The height is imposed on the live shot rather than on the table, so
        // the two runs are the same flight drawn two ways.
        for (const [id, entity] of current.entities) {
          if (!entity.projectile) continue;
          current = {
            ...current,
            entities: new Map(current.entities).set(id, {
              ...entity,
              projectile: { ...entity.projectile, arcHeight },
            }),
          };
        }
        if (result.events.some((event) => event.kind === 'hit')) return current.tick;
      }
      return null;
    }

    const level = arrivalOf(0);
    expect(level).not.toBeNull();
    expect(arrivalOf(120)).toBe(level);
  });

  it('lets a slinger open at its throw, not at a sword length', () => {
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const slinger = withMonster(state, 'slinger', 900, 450);
    state = slinger.state;
    // Nothing initiates since spec 076: a monster's only route to a target is
    // the grudge `applyDamage` writes when something hits it. Handing it the
    // grudge directly is that, without a swing to muddy what is being measured.
    const provoked = state.entities.get(slinger.id);
    if (!provoked) throw new Error('no slinger');
    state = replaceEntity(state, { ...provoked, targetId: player.id });
    const ctx = quiet({
      activeChunks: activeAround({ x: 600, y: 450 }, { x: 900, y: 450 }),
    });

    let current = state;
    let threw = false;
    for (let i = 0; i < 120 && !threw; i++) {
      current = step(current, [], ctx).state;
      threw = [...current.entities.values()].some(
        (e) => e.projectile?.abilityId === 'ranged.star',
      );
    }
    expect(threw).toBe(true);
    // And it never had to walk into melee to do it.
    const at = current.entities.get(slinger.id)?.position;
    expect(Math.hypot((at?.x ?? 0) - 600, (at?.y ?? 0) - 450)).toBeGreaterThan(150);
  });
});
