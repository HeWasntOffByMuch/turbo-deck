/**
 * The ability system (spec 062), driven through the real `step`.
 *
 * Nothing here calls `startCast` or `advanceCast` directly: an ability is only
 * correct if it behaves correctly *in a tick*, alongside movement, monsters and
 * the spawner. Testing the pieces in isolation would pass while the wiring that
 * actually runs them was wrong.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { abilityById, ALL_ABILITIES, totalCastTicks } from '../data/abilities.js';
import { monsterById } from '../data/monsters.js';
import { computeEffectiveStats } from '../player/stats.js';
import { EMPTY_EQUIPMENT, type EffectiveStats, type PersistedPlayer } from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import {
  CastEndReason,
  CastPhase,
  EntityKindValue,
  type ServerInput,
  type ServerSimEvent,
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
  currentZone: 'greenmarch',
  level: 1,
  experience: 0,
  unspentSkillPoints: 0,
  health: 100,
  resource: 100,
};

// Spell power scales ability damage, so a fixture with a known multiplier keeps
// the arithmetic in these tests readable.
const STATS: EffectiveStats = { ...computeEffectiveStats(RECORD), spellPower: 1, critChance: 0 };
const CHUNK = 100;

function activeAround(x: number, y: number): Set<string> {
  const keys = new Set<string>();
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) keys.add(chunkKeyOf(x + dx * CHUNK, y + dy * CHUNK, CHUNK));
  }
  return keys;
}

function context(overrides: Partial<StepContext> = {}): StepContext {
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    // The spawner off, so a test's population is exactly what it put there.
    config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    activeChunks: activeAround(600, 450),
    chunkSize: CHUNK,
    ...overrides,
  };
}

function withPlayer(
  state: ServerWorldState,
  x: number,
  y: number,
  stats: EffectiveStats = STATS,
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

function withDummy(
  state: ServerWorldState,
  x: number,
  y: number,
): { state: ServerWorldState; id: number } {
  const definition = monsterById('dummy');
  if (!definition) throw new Error('no dummy');
  // A training dummy: it swings at nothing, so every hit in a test is the
  // player's and no retaliation interrupts what is being measured.
  const result = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId: 'dummy',
    position: { x, y, z: 0 },
    stats: definition.stats,
    radius: definition.radius,
    zoneId: 'greenmarch',
  });
  return { state: result.state, id: result.entity.id };
}

function input(entityId: number, overrides: Partial<ServerInput> = {}): ServerInput {
  return {
    entityId,
    seq: 1,
    moveX: 0,
    moveY: 0,
    facing: 0,
    buttons: 0,
    predictedX: 0,
    predictedY: 0,
    hasPrediction: false,
    castAbilityId: '',
    castTargetX: 0,
    castTargetY: 0,
    cancelCast: false,
    ...overrides,
  };
}

interface Run {
  state: ServerWorldState;
  events: ServerSimEvent[];
}

/** Runs `ticks` ticks, feeding `frames[i]` on tick i, collecting every event. */
function run(
  state: ServerWorldState,
  ticks: number,
  frames: Record<number, ServerInput[]> = {},
  ctx: StepContext = context(),
): Run {
  const events: ServerSimEvent[] = [];
  let current = state;
  for (let i = 0; i < ticks; i++) {
    const result = step(current, frames[i] ?? [], ctx);
    current = result.state;
    events.push(...result.events);
  }
  return { state: current, events };
}

const hits = (events: readonly ServerSimEvent[]): Extract<ServerSimEvent, { kind: 'hit' }>[] =>
  events.filter((event): event is Extract<ServerSimEvent, { kind: 'hit' }> => event.kind === 'hit');

describe('the ability table', () => {
  it('gives every ability the parts its kind needs', () => {
    for (const ability of ALL_ABILITIES) {
      expect(ability.windupTicks, ability.id).toBeGreaterThan(0);
      expect(ability.cooldownTicks, ability.id).toBeGreaterThan(0);
      if (ability.kind === 'projectile') expect(ability.projectile, ability.id).toBeDefined();
      if (ability.kind === 'ground') expect(ability.radius, ability.id).toBeGreaterThan(0);
      if (ability.kind === 'channel') {
        expect(ability.channelTicks, ability.id).toBeGreaterThan(0);
        expect(ability.pulseIntervalTicks, ability.id).toBeGreaterThan(0);
      }
      if (ability.kind === 'self') expect(ability.targeting).toBe('self');
    }
  });
});

describe('wind-up', () => {
  it('deals no damage before the release tick, and lands exactly once on it', () => {
    const ability = abilityById('melee.heavy');
    if (!ability) throw new Error('no melee.heavy');

    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withDummy(state, 660, 450).state;

    const commit = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'melee.heavy', castTargetX: 660, castTargetY: 450 })],
    });
    expect(hits(commit.events)).toHaveLength(0);

    // Everything up to but not including the release must be silent.
    const during = run(commit.state, ability.windupTicks - 1);
    expect(hits(during.events)).toHaveLength(0);

    const release = run(during.state, 1);
    expect(hits(release.events)).toHaveLength(1);

    // And it does not land a second time while recovering.
    const after = run(release.state, ability.recoveryTicks + 5);
    expect(hits(after.events)).toHaveLength(0);
  });

  it('roots the caster for the whole cast', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const startX = state.entities.get(player.id)?.position.x ?? 0;

    const frames: Record<number, ServerInput[]> = {
      0: [input(player.id, { castAbilityId: 'melee.heavy', castTargetX: 700, castTargetY: 450 })],
    };
    // Walking hard the whole time it is winding up.
    for (let i = 1; i < 20; i++) frames[i] = [input(player.id, { moveX: 0, moveY: 1 })];

    const result = run(state, 20, frames);
    expect(result.state.entities.get(player.id)?.position.y).toBeCloseTo(450, 3);
    expect(result.state.entities.get(player.id)?.position.x).toBeCloseTo(startX, 3);
  });

  it('captures aim at commit, so turning mid-cast cannot re-point the blow', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Behind the caster relative to the committed aim.
    state = withDummy(state, 540, 450).state;

    const frames: Record<number, ServerInput[]> = {
      0: [input(player.id, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 450 })],
    };
    for (let i = 1; i < 30; i++) frames[i] = [input(player.id, { facing: Math.PI })];

    // Aim was +x at commit; spinning to face the dummy afterwards changes nothing.
    expect(hits(run(state, 30, frames).events)).toHaveLength(0);
  });
});

describe('cancellation', () => {
  it('refunds the cost and the cooldown, and lands nothing', () => {
    const ability = abilityById('ground.quake');
    if (!ability) throw new Error('no ground.quake');

    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withDummy(state, 640, 450).state;
    const beforeResource = state.entities.get(player.id)?.resource ?? 0;

    const started = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'ground.quake', castTargetX: 640, castTargetY: 450 })],
    });
    expect(started.state.entities.get(player.id)?.resource).toBeCloseTo(
      beforeResource - ability.cost,
      6,
    );

    const cancelled = run(started.state, 1, { 0: [input(player.id, { cancelCast: true })] });
    const caster = cancelled.state.entities.get(player.id);
    expect(caster?.cast).toBeNull();
    // At least what was spent is back; regen has also ticked on top of it.
    expect(caster?.resource ?? 0).toBeGreaterThanOrEqual(beforeResource);
    expect(caster?.resource ?? 0).toBeLessThanOrEqual(STATS.maxResource);
    expect(caster?.cooldowns['ground.quake']).toBeUndefined();
    expect(
      cancelled.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Cancelled,
      ),
    ).toBe(true);

    // Nothing ever landed.
    expect(hits(run(cancelled.state, 60).events)).toHaveLength(0);
  });

  it('is immediately castable again, because the cooldown never started', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const started = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'ground.quake', castTargetX: 640, castTargetY: 450 })],
    });
    const cancelled = run(started.state, 1, { 0: [input(player.id, { cancelCast: true })] });
    const again = run(cancelled.state, 1, {
      0: [input(player.id, { castAbilityId: 'ground.quake', castTargetX: 640, castTargetY: 450 })],
    });
    expect(again.state.entities.get(player.id)?.cast?.abilityId).toBe('ground.quake');
  });

  it('cannot call back a cast that has already released', () => {
    const ability = abilityById('melee.slash');
    if (!ability) throw new Error('no melee.slash');

    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withDummy(state, 640, 450).state;

    // Run right through the release, then try to cancel the recovery.
    const released = run(state, ability.windupTicks + 1, {
      0: [input(player.id, { castAbilityId: 'melee.slash', castTargetX: 640, castTargetY: 450 })],
    });
    expect(hits(released.events)).toHaveLength(1);

    const late = run(released.state, 1, { 0: [input(player.id, { cancelCast: true })] });
    expect(
      late.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Cancelled,
      ),
    ).toBe(false);
  });
});

describe('cost and cooldown gate use', () => {
  it('refuses a second cast while the first is winding up', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const first = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'melee.heavy', castTargetX: 700, castTargetY: 450 })],
    });
    const second = run(first.state, 1, {
      0: [input(player.id, { castAbilityId: 'bolt.arcane', castTargetX: 700, castTargetY: 450 })],
    });
    expect(
      second.events.some(
        (event) => event.kind === 'castRejected' && event.reason === 'alreadyCasting',
      ),
    ).toBe(true);
    expect(second.state.entities.get(player.id)?.cast?.abilityId).toBe('melee.heavy');
  });

  it('refuses one that is on cooldown', () => {
    const ability = abilityById('melee.heavy');
    if (!ability) throw new Error('no melee.heavy');

    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const cast = run(state, totalCastTicks(ability) + 1, {
      0: [input(player.id, { castAbilityId: 'melee.heavy', castTargetX: 700, castTargetY: 450 })],
    });
    const again = run(cast.state, 1, {
      0: [input(player.id, { castAbilityId: 'melee.heavy', castTargetX: 700, castTargetY: 450 })],
    });
    expect(
      again.events.some((event) => event.kind === 'castRejected' && event.reason === 'onCooldown'),
    ).toBe(true);
  });

  it('refuses one it cannot pay for, and changes nothing', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450, { ...STATS, maxResource: 1, resourceRegen: 0 });
    state = player.state;

    const result = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'ground.quake', castTargetX: 640, castTargetY: 450 })],
    });
    expect(
      result.events.some(
        (event) => event.kind === 'castRejected' && event.reason === 'notEnoughResource',
      ),
    ).toBe(true);
    expect(result.state.entities.get(player.id)?.cast).toBeNull();
    expect(result.state.entities.get(player.id)?.resource).toBeLessThanOrEqual(1);
  });

  it('refuses a point-targeted cast beyond its range', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const result = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'ground.quake', castTargetX: 6000, castTargetY: 450 })],
    });
    expect(
      result.events.some((event) => event.kind === 'castRejected' && event.reason === 'outOfRange'),
    ).toBe(true);
  });

  it('refuses an ability that is not in the table', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const result = run(state, 1, { 0: [input(player.id, { castAbilityId: 'nope.nope' })] });
    expect(
      result.events.some(
        (event) => event.kind === 'castRejected' && event.reason === 'unknownAbility',
      ),
    ).toBe(true);
  });
});

describe('projectiles', () => {
  it('flies, and damages what it reaches rather than what it was aimed past', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const near = withDummy(state, 800, 450);
    state = near.state;

    const result = run(state, SERVER_TICK_RATE * 2, {
      0: [input(player.id, { castAbilityId: 'bolt.arcane', castTargetX: 1200, castTargetY: 450 })],
    });

    const landed = hits(result.events);
    expect(landed).toHaveLength(1);
    expect(landed[0]?.targetId).toBe(near.id);
    // And it is gone once it has connected.
    expect(
      [...result.state.entities.values()].some(
        (entity) => entity.kind === EntityKindValue.Projectile,
      ),
    ).toBe(false);
  });

  it('exists as a replicable entity while it is in the air', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const ability = abilityById('bolt.lob');
    if (!ability) throw new Error('no bolt.lob');
    const inFlight = run(state, ability.windupTicks + 3, {
      0: [input(player.id, { castAbilityId: 'bolt.lob', castTargetX: 950, castTargetY: 450 })],
    });

    const projectiles = [...inFlight.state.entities.values()].filter(
      (entity) => entity.kind === EntityKindValue.Projectile,
    );
    expect(projectiles).toHaveLength(1);
    expect(projectiles[0]?.typeId).toBe('bolt.lob');
    // A lobbed shot is genuinely off the ground, which is what the client draws.
    expect(projectiles[0]?.position.z).toBeGreaterThan(0);
  });

  it('bursts where it lands, catching everything in the radius', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Three bodies clustered at the landing point.
    const a = withDummy(state, 900, 450);
    state = a.state;
    const b = withDummy(state, 930, 470);
    state = b.state;
    const c = withDummy(state, 880, 420);
    state = c.state;

    const result = run(state, SERVER_TICK_RATE * 4, {
      0: [input(player.id, { castAbilityId: 'bolt.lob', castTargetX: 900, castTargetY: 450 })],
    });
    const struck = new Set(hits(result.events).map((hit) => hit.targetId));
    expect(struck).toEqual(new Set([a.id, b.id, c.id]));
  });

  it('expires instead of flying forever when it hits nothing', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const result = run(state, SERVER_TICK_RATE * 5, {
      0: [input(player.id, { castAbilityId: 'bolt.arcane', castTargetX: 1300, castTargetY: 450 })],
    });
    expect(
      [...result.state.entities.values()].some(
        (entity) => entity.kind === EntityKindValue.Projectile,
      ),
    ).toBe(false);
    expect(hits(result.events)).toHaveLength(0);
  });

  it('draws a flat bolt flat and a lobbed pot in an arc', () => {
    // The arc is a pure function of progress, which is what lets the client
    // interpolate between 20Hz deltas and land on the same curve.
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const flat = abilityById('bolt.arcane');
    const lob = abilityById('bolt.lob');
    if (!flat || !lob) throw new Error('missing projectiles');

    const flatRun = run(state, flat.windupTicks + 4, {
      0: [input(player.id, { castAbilityId: 'bolt.arcane', castTargetX: 1200, castTargetY: 450 })],
    });
    const flatShot = [...flatRun.state.entities.values()].find(
      (entity) => entity.kind === EntityKindValue.Projectile,
    );
    expect(flatShot?.position.z).toBeCloseTo(0, 6);
  });
});

describe('channels', () => {
  it('pulses repeatedly while held, and stops when cancelled', () => {
    const ability = abilityById('channel.drain');
    if (!ability) throw new Error('no channel.drain');

    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withDummy(state, 660, 450).state;

    const full = run(state, ability.windupTicks + (ability.channelTicks ?? 0) + 5, {
      0: [input(player.id, { castAbilityId: 'channel.drain', castTargetX: 700, castTargetY: 450 })],
    });
    const pulses = hits(full.events).length;
    // A two-second channel pulsing four times a second lands several times.
    expect(pulses).toBeGreaterThan(2);

    // Cancelled a few ticks in, it lands far fewer.
    const cutShort = run(state, ability.windupTicks + (ability.channelTicks ?? 0) + 5, {
      0: [input(player.id, { castAbilityId: 'channel.drain', castTargetX: 700, castTargetY: 450 })],
      [ability.windupTicks + 2]: [input(player.id, { cancelCast: true })],
    });
    expect(hits(cutShort.events).length).toBeLessThan(pulses);
  });
});

describe('self abilities', () => {
  it('heals the caster without exceeding their ceiling', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Hurt them first, so the heal has room to work.
    const hurt = new Map(state.entities);
    const before = hurt.get(player.id);
    if (!before) throw new Error('no player');
    hurt.set(player.id, { ...before, health: 20 });
    state = { ...state, entities: hurt };

    const ability = abilityById('self.mend');
    if (!ability) throw new Error('no self.mend');
    const result = run(state, ability.windupTicks + 2, {
      0: [input(player.id, { castAbilityId: 'self.mend' })],
    });

    const healed = result.state.entities.get(player.id);
    expect(healed?.health).toBeGreaterThan(20);
    expect(healed?.health).toBeLessThanOrEqual(STATS.maxHealth);
    expect(result.events.some((event) => event.kind === 'effect')).toBe(true);
  });
});

describe('interruption', () => {
  it('knocks a caster out of a wind-up when something hits them hard', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // A stalker close enough to start swinging immediately.
    const definition = monsterById('stalker');
    if (!definition) throw new Error('no stalker');
    const monster = spawnEntity(state, {
      kind: EntityKindValue.Monster,
      typeId: 'stalker',
      position: { x: 640, y: 450, z: 0 },
      stats: { ...definition.stats, spellPower: 40 },
      radius: definition.radius,
      zoneId: 'greenmarch',
    });
    state = monster.state;

    const result = run(state, SERVER_TICK_RATE * 3, {
      0: [input(player.id, { castAbilityId: 'ground.quake', castTargetX: 640, castTargetY: 450 })],
    });
    // Whatever else happened, the long cast did not quietly survive being hit.
    const struckPlayer = hits(result.events).some((hit) => hit.targetId === player.id);
    expect(struckPlayer).toBe(true);
    expect(result.state.entities.get(player.id)?.cast).toBeNull();
  });
});

describe('determinism holds with abilities in play', () => {
  function scripted(): ServerWorldState {
    let state = createWorldState(42);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withDummy(state, 780, 450).state;

    const frames: Record<number, ServerInput[]> = {
      0: [input(player.id, { castAbilityId: 'bolt.arcane', castTargetX: 900, castTargetY: 450 })],
      40: [input(player.id, { castAbilityId: 'bolt.lob', castTargetX: 800, castTargetY: 460 })],
      90: [input(player.id, { castAbilityId: 'channel.drain', castTargetX: 800, castTargetY: 450 })],
      140: [input(player.id, { cancelCast: true })],
      160: [input(player.id, { castAbilityId: 'ground.quake', castTargetX: 780, castTargetY: 450 })],
    };
    return run(state, 260, frames).state;
  }

  it('replays casts, projectiles and channels to bit-identical state', () => {
    const snapshot = (state: ServerWorldState): string =>
      JSON.stringify({
        tick: state.tick,
        nextEntityId: state.nextEntityId,
        rng: state.rng.getState(),
        entities: [...state.entities.values()],
      });
    expect(snapshot(scripted())).toBe(snapshot(scripted()));
  });
});

describe('cast phases reach the client', () => {
  it('reports a start and an end for every cast', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const ability = abilityById('melee.slash');
    if (!ability) throw new Error('no melee.slash');
    const result = run(state, totalCastTicks(ability) + 2, {
      0: [input(player.id, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 450 })],
    });

    const started = result.events.filter((event) => event.kind === 'castStarted');
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ abilityId: 'melee.slash', phase: CastPhase.Windup });

    expect(
      result.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Released,
      ),
    ).toBe(true);
  });
});
