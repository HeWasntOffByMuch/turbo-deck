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
import { createWorldState, replaceEntity, spawnEntity, step, type StepContext } from './world.js';

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
    spawnPoints: [],
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
    seqSpan: 1,
    castAbilityId: '',
    castTargetX: 0,
    castTargetY: 0,
    castTargetEntityId: 0,
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

    // And it does not land a second time once it is over.
    const after = run(release.state, 5);
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

/**
 * Spec 065. Turning is rate-limited (spec 064), and until now a cast ignored
 * that: commit facing north and the blow resolved south on schedule, from a body
 * still halfway round.
 */
describe('turning before the wind-up', () => {
  function committedFacingAway(abilityId: string): {
    state: ReturnType<typeof createWorldState>;
    playerId: number;
  } {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withDummy(state, 640, 450).state;
    // Face due west, and swing due east: a half turn before anything happens.
    const facing = state.entities.get(player.id);
    if (facing) {
      const entities = state.entities as Map<number, typeof facing>;
      entities.set(player.id, { ...facing, facing: Math.PI });
    }
    const started = run(state, 1, {
      0: [input(player.id, { castAbilityId: abilityId, castTargetX: 640, castTargetY: 450 })],
    });
    return { state: started.state, playerId: player.id };
  }

  it('holds a cast in Turning until the body has come round', () => {
    const { state, playerId } = committedFacingAway('melee.slash');
    expect(state.entities.get(playerId)?.cast?.phase).toBe(CastPhase.Turning);

    // Still turning a few ticks later, and nothing has landed.
    const soon = run(state, 5);
    expect(soon.state.entities.get(playerId)?.cast?.phase).toBe(CastPhase.Turning);
    expect(hits(soon.events)).toHaveLength(0);
  });

  it('starts the wind-up when it arrives, and lands a full wind-up later', () => {
    const ability = abilityById('melee.slash');
    if (!ability) throw new Error('no melee.slash');
    const { state, playerId } = committedFacingAway('melee.slash');
    const turnRate = state.entities.get(playerId)?.stats.turnRate ?? 0;
    expect(turnRate).toBeGreaterThan(0);

    // A half turn, then the ability's own wind-up -- not a tick less.
    const turnTicks = Math.ceil((180 / turnRate) * SERVER_TICK_RATE);
    const beforeRelease = run(state, turnTicks + ability.windupTicks - 2);
    expect(hits(beforeRelease.events)).toHaveLength(0);

    const landed = run(beforeRelease.state, 3);
    expect(hits(landed.events).length).toBeGreaterThan(0);
  });

  it('never enters Turning when the body is already facing the aim', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withDummy(state, 640, 450).state;

    // withPlayer faces east by default, and the aim is due east.
    const started = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'melee.slash', castTargetX: 640, castTargetY: 450 })],
    });
    expect(started.state.entities.get(player.id)?.cast?.phase).toBe(CastPhase.Windup);
  });

  it('re-stamps the release tick, so the client is never told a stale one', () => {
    const ability = abilityById('melee.slash');
    if (!ability) throw new Error('no melee.slash');
    const { state, playerId } = committedFacingAway('melee.slash');
    const provisional = state.entities.get(playerId)?.cast?.releaseTick ?? 0;

    // Run until the wind-up actually begins.
    let current = state;
    let phase: number = CastPhase.Turning;
    for (let i = 0; i < 200 && phase === CastPhase.Turning; i++) {
      const next = run(current, 1);
      current = next.state;
      phase = current.entities.get(playerId)?.cast?.phase ?? CastPhase.Windup;
    }

    const actual = current.entities.get(playerId)?.cast?.releaseTick ?? 0;
    expect(phase).toBe(CastPhase.Windup);
    // The turn took longer than the wind-up, so the provisional tick is long past.
    expect(actual).toBeGreaterThan(provisional);
  });

  /**
   * The turn is part of the commitment, so calling off during it must cost
   * exactly nothing -- the same deal the wind-up offers.
   */
  it('refunds in full when cancelled mid-turn', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const before = state.entities.get(player.id)?.resource ?? 0;

    const facing = state.entities.get(player.id);
    if (facing) {
      const entities = state.entities as Map<number, typeof facing>;
      entities.set(player.id, { ...facing, facing: Math.PI });
    }

    const started = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'melee.heavy', castTargetX: 640, castTargetY: 450 })],
    });
    expect(started.state.entities.get(player.id)?.cast?.phase).toBe(CastPhase.Turning);

    const turning = run(started.state, 4);
    const cancelled = run(turning.state, 1, { 0: [input(player.id, { cancelCast: true })] });

    const caster = cancelled.state.entities.get(player.id);
    expect(caster?.cast).toBeNull();
    expect(caster?.resource ?? 0).toBeGreaterThanOrEqual(before);
    expect(caster?.cooldowns['melee.heavy']).toBeUndefined();
  });

  /**
   * The provisional release tick can be *behind* the current tick by the time a
   * slow body finishes turning. Cancelling then must still work -- comparing
   * against it would report a cast that has not begun as already released.
   */
  it('is still cancellable after turning for longer than the wind-up', () => {
    const ability = abilityById('melee.slash');
    if (!ability) throw new Error('no melee.slash');
    const { state, playerId } = committedFacingAway('melee.slash');

    const wellPast = run(state, ability.windupTicks + 2);
    expect(wellPast.state.entities.get(playerId)?.cast?.phase).toBe(CastPhase.Turning);

    const cancelled = run(wellPast.state, 1, { 0: [input(playerId, { cancelCast: true })] });
    expect(cancelled.state.entities.get(playerId)?.cast).toBeNull();
    expect(
      cancelled.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Cancelled,
      ),
    ).toBe(true);
  });
});

describe('a hit does not interrupt a cast (spec 068)', () => {
  it('leaves the wind-up running, and the blow lands on the tick it would have', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // A stalker close enough to start swinging immediately, and already facing
    // its target -- since spec 065 a body turns before it swings, and a monster
    // spawned looking the other way would spend most of this test rotating.
    // That is the turn phase's own test; this one is about interruption.
    const definition = monsterById('stalker');
    if (!definition) throw new Error('no stalker');
    const monster = spawnEntity(state, {
      kind: EntityKindValue.Monster,
      typeId: 'stalker',
      position: { x: 640, y: 450, z: 0 },
      facing: Math.PI,
      stats: definition.stats,
      radius: definition.radius,
      zoneId: 'greenmarch',
      // Already fighting us: nothing initiates since spec 074.
      targetId: player.id,
    });
    state = monster.state;

    const quake = abilityById('ground.quake');
    if (!quake) throw new Error('no ground.quake');

    // Tick to the last tick of the wind-up, watching for the stalker's blow.
    let current: Run = { state, events: [] };
    let struckWhileWindingUp = false;
    for (let i = 0; i < quake.windupTicks; i++) {
      current = run(current.state, 1, i === 0
        ? { 0: [input(player.id, { castAbilityId: 'ground.quake', castTargetX: 640, castTargetY: 450 })] }
        : {});
      if (hits(current.events).some((hit) => hit.targetId === player.id)) {
        struckWhileWindingUp = true;
        // The blow it committed to is still coming: neither the turn nor the
        // wind-up was thrown away by being hit.
        expect(current.state.entities.get(player.id)?.cast).not.toBeNull();
      }
    }
    expect(struckWhileWindingUp, 'the stalker never landed a blow to test with').toBe(true);

    // And it releases, on its own terms, into the monster that was hitting it.
    const release = run(current.state, 1);
    expect(hits(release.events).some((hit) => hit.targetId === monster.entity.id)).toBe(true);
    expect(
      release.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Released,
      ),
    ).toBe(true);
  });

  it('still drops the cast when the hit is a killing one, and says so', () => {
    let state = createWorldState(1);
    // A caster frail enough that the stalker's first blow finishes it; it spawns
    // on full health, so its maximum is all it has.
    const player = withPlayer(state, 600, 450, { ...STATS, maxHealth: 6, armor: 0 });
    state = player.state;

    const definition = monsterById('stalker');
    if (!definition) throw new Error('no stalker');
    const monster = spawnEntity(state, {
      kind: EntityKindValue.Monster,
      typeId: 'stalker',
      position: { x: 640, y: 450, z: 0 },
      facing: Math.PI,
      stats: definition.stats,
      radius: definition.radius,
      zoneId: 'greenmarch',
      // Already fighting us: nothing initiates since spec 074.
      targetId: player.id,
    });
    state = monster.state;

    const result = run(state, SERVER_TICK_RATE * 3, {
      0: [input(player.id, { castAbilityId: 'ground.quake', castTargetX: 640, castTargetY: 450 })],
    });
    expect(result.events.some((event) => event.kind === 'died')).toBe(true);
    expect(result.state.entities.get(player.id)?.cast ?? null).toBeNull();
    expect(
      result.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Interrupted,
      ),
    ).toBe(true);
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
  it('reports every phase it passes through, and ends once', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const ability = abilityById('melee.slash');
    if (!ability) throw new Error('no melee.slash');
    const result = run(state, totalCastTicks(ability) + 2, {
      0: [input(player.id, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 450 })],
    });

    const phases = result.events
      .filter((event) => event.kind === 'castStarted')
      .map((event) => (event.kind === 'castStarted' ? event.phase : -1));
    // Committed facing the aim, so no turn -- and nothing after the wind-up,
    // because the release is the end of the cast (spec 068).
    expect(phases).toEqual([CastPhase.Windup]);

    const ended = result.events.filter(
      (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Released,
    );
    expect(ended).toHaveLength(1);
  });

  /**
   * Spec 068. The cast used to go on rooting the caster through a recovery phase
   * after the blow had landed; now the release *is* the end, so the body is free
   * on the next tick and the bar is gone.
   */
  it('ends on the release tick, and the caster walks the tick after', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const startY = state.entities.get(player.id)?.position.y ?? 0;

    const ability = abilityById('melee.heavy');
    if (!ability) throw new Error('no melee.heavy');

    const commit = run(state, 1, {
      0: [input(player.id, { castAbilityId: 'melee.heavy', castTargetX: 700, castTargetY: 450 })],
    });
    const releaseTick = commit.state.entities.get(player.id)?.cast?.releaseTick ?? 0;
    expect(releaseTick).toBeGreaterThan(commit.state.tick);

    // Walking hard from the moment it is committed: refused for the whole cast.
    const walk: Record<number, ServerInput[]> = { 0: [input(player.id, { moveX: 0, moveY: 1 })] };

    // Up to the tick before the release: still winding up, still rooted, and
    // nothing has ended.
    let during = commit;
    while (during.state.tick < releaseTick - 1) during = run(during.state, 1, walk);
    expect(during.state.entities.get(player.id)?.cast?.phase).toBe(CastPhase.Windup);
    expect(during.state.entities.get(player.id)?.position.y).toBeCloseTo(startY, 3);
    expect(during.events.some((event) => event.kind === 'castEnded')).toBe(false);

    // The release tick: the blow lands and the cast is over in the same breath.
    const release = run(during.state, 1, walk);
    expect(release.state.entities.get(player.id)?.cast).toBeNull();
    expect(
      release.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Released,
      ),
    ).toBe(true);

    // And the very next tick the body moves again -- no recovery to sit through.
    const after = run(release.state, 1, walk);
    expect(after.state.entities.get(player.id)?.position.y).toBeGreaterThan(startY);
  });

  it('walks a channel through its pulses and then over', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;

    const ability = abilityById('channel.drain');
    if (!ability) throw new Error('no channel.drain');
    const result = run(state, totalCastTicks(ability) + 2, {
      0: [input(player.id, { castAbilityId: 'channel.drain', castTargetX: 700, castTargetY: 450 })],
    });

    const phases = result.events
      .filter((event) => event.kind === 'castStarted')
      .map((event) => (event.kind === 'castStarted' ? event.phase : -1));
    expect(phases).toEqual([CastPhase.Windup, CastPhase.Channel]);
    expect(result.state.entities.get(player.id)?.cast).toBeNull();
    expect(
      result.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Released,
      ),
    ).toBe(true);
  });
});

describe('a named target (spec 070)', () => {
  const slash = abilityById('melee.slash');
  if (!slash) throw new Error('no melee.slash');

  /** A player and two dummies standing side by side, both well inside the arc. */
  function twoInTheArc(): {
    state: ServerWorldState;
    player: number;
    named: number;
    bystander: number;
  } {
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Both due east, a few units apart: whatever cone slash would sweep, it
    // sweeps over the pair of them.
    const named = withDummy(state, 640, 445);
    state = named.state;
    const bystander = withDummy(state, 640, 455);
    return {
      state: bystander.state,
      player: player.id,
      named: named.id,
      bystander: bystander.id,
    };
  }

  it('damages the body it names and nobody standing beside it', () => {
    const field = twoInTheArc();
    // Long enough to turn onto an aim a few degrees off the current heading and
    // then wind up: the turn comes first, and its length is the body's own.
    const result = run(field.state, slash.windupTicks + 12, {
      0: [
        input(field.player, {
          castAbilityId: 'melee.slash',
          castTargetX: 640,
          castTargetY: 445,
          castTargetEntityId: field.named,
        }),
      ],
    });

    const struck = hits(result.events);
    expect(struck).toHaveLength(1);
    expect(struck[0]?.targetId).toBe(field.named);
    expect(result.state.entities.get(field.bystander)?.health).toBe(
      monsterById('dummy')?.stats.maxHealth,
    );
  });

  it('still sweeps the cone when no target is named, which is what the hotbar uses', () => {
    const field = twoInTheArc();
    const result = run(field.state, slash.windupTicks + 12, {
      0: [
        input(field.player, {
          castAbilityId: 'melee.slash',
          castTargetX: 700,
          castTargetY: 450,
        }),
      ],
    });
    expect(new Set(hits(result.events).map((hit) => hit.targetId))).toEqual(
      new Set([field.named, field.bystander]),
    );
  });

  it('misses a target that is out of reach at the release, rather than reaching it', () => {
    let state = createWorldState(5);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Named from well outside slash's reach: the commit is legal (a direction
    // ability may always be started) and the blow simply finds nothing.
    const far = withDummy(state, 600 + slash.range * 3, 450);
    state = far.state;

    const result = run(state, slash.windupTicks + 12, {
      0: [
        input(player.id, {
          castAbilityId: 'melee.slash',
          castTargetX: 600 + slash.range * 3,
          castTargetY: 450,
          castTargetEntityId: far.id,
        }),
      ],
    });

    expect(hits(result.events)).toHaveLength(0);
    expect(result.events.some((event) => event.kind === 'attackMissed')).toBe(true);
    expect(result.state.entities.get(far.id)?.health).toBe(monsterById('dummy')?.stats.maxHealth);
  });

  it('misses a target that died during the wind-up, rather than hitting a corpse', () => {
    const heavy = abilityById('melee.heavy');
    if (!heavy) throw new Error('no melee.heavy');

    let state = createWorldState(8);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const victim = withDummy(state, 660, 450);
    state = victim.state;

    // Committed, and a long way from landing.
    const committed = run(state, 2, {
      0: [
        input(player.id, {
          castAbilityId: 'melee.heavy',
          castTargetX: 660,
          castTargetY: 450,
          castTargetEntityId: victim.id,
        }),
      ],
    });

    // Something else finishes it off mid-wind-up. The blow is already paid for
    // and cannot be called back (spec 068), so what it finds when it lands is
    // the question.
    const corpse = committed.state.entities.get(victim.id);
    if (!corpse) throw new Error('no victim');
    const dead = replaceEntity(committed.state, { ...corpse, health: 0 });

    const result = run(dead, heavy.windupTicks + 2);
    expect(hits(result.events)).toHaveLength(0);
    expect(result.events.some((event) => event.kind === 'attackMissed')).toBe(true);
  });

  it('stamps a basic attack from the caster, and everything else from the table', () => {
    const quick: EffectiveStats = { ...STATS, attackCooldownTicks: 40, attackSpeed: 2 };
    const slow: EffectiveStats = { ...STATS, attackCooldownTicks: 40, attackSpeed: 1 };

    let state = createWorldState(6);
    const fast = withPlayer(state, 600, 450, quick);
    state = fast.state;
    const plodder = withPlayer(state, 600, 470, slow);
    state = plodder.state;

    const commit = run(state, 1, {
      0: [
        input(fast.id, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 450 }),
        input(plodder.id, { castAbilityId: 'melee.slash', castTargetX: 700, castTargetY: 470 }),
      ],
    });

    const at = (id: number): number => commit.state.entities.get(id)?.cooldowns['melee.slash'] ?? 0;
    // Same weapon, same tick, twice the speed: half the wait.
    expect(at(fast.id) - 1).toBe(20);
    expect(at(plodder.id) - 1).toBe(40);
    // Neither of them is the table's number, which is what the swing used to
    // cost everybody.
    expect(slash.cooldownTicks).not.toBe(20);

    // A non-basic ability ignores the stat entirely.
    const heavy = run(state, 1, {
      0: [input(fast.id, { castAbilityId: 'melee.heavy', castTargetX: 700, castTargetY: 450 })],
    });
    expect(heavy.state.entities.get(fast.id)?.cooldowns['melee.heavy']).toBe(
      1 + (abilityById('melee.heavy')?.cooldownTicks ?? 0),
    );
  });

  it('lets a monster swing at the player it is chasing, by id', () => {
    let state = createWorldState(7);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const definition = monsterById('stalker');
    if (!definition) throw new Error('no stalker');
    const spawned = spawnEntity(state, {
      kind: EntityKindValue.Monster,
      typeId: 'stalker',
      position: { x: 640, y: 450, z: 0 },
      stats: definition.stats,
      radius: definition.radius,
      zoneId: 'greenmarch',
      // Already fighting us: nothing initiates since spec 074.
      targetId: player.id,
    });

    const result = run(spawned.state, SERVER_TICK_RATE);
    const struck = hits(result.events).filter((hit) => hit.attackerId === spawned.entity.id);
    expect(struck.length).toBeGreaterThan(0);
    expect(struck.every((hit) => hit.targetId === player.id)).toBe(true);
  });

  it('replays a targeted fight identically from the same seed', () => {
    const frames = (player: number, target: number): Record<number, ServerInput[]> => ({
      0: [
        input(player, {
          castAbilityId: 'melee.slash',
          castTargetX: 640,
          castTargetY: 445,
          castTargetEntityId: target,
        }),
      ],
      30: [
        input(player, {
          castAbilityId: 'melee.slash',
          castTargetX: 640,
          castTargetY: 445,
          castTargetEntityId: target,
        }),
      ],
    });

    const once = twoInTheArc();
    const again = twoInTheArc();
    const a = run(once.state, 60, frames(once.player, once.named));
    const b = run(again.state, 60, frames(again.player, again.named));
    expect(JSON.stringify([...b.state.entities])).toBe(JSON.stringify([...a.state.entities]));
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
  });
});
