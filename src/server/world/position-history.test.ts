/**
 * Hitting what you saw (spec 149).
 *
 * Two halves. The history is a ring and is tested as one. The compensation is
 * tested through the real `step`, because the property worth having is not "the
 * lookup returns an old position" -- it is "the swing that visibly connected
 * connects, and the one that was dodged still misses".
 */

import { describe, expect, it } from 'vitest';
import { PositionHistory, type RewindLookup } from './position-history.js';
import { MAX_REWIND_TICKS, SERVER_PLAYER_RADIUS } from '../config.js';
import { createWorldState, spawnEntity, step, type StepContext } from '../sim/world.js';
import { ZoneManager, type ZoneDefinition } from './zone-manager.js';
import { createWorldColliders } from '../../sim/collision.js';
import { FLAT_TERRAIN } from './terrain.js';
import { EntityKindValue, type ServerEntity, type ServerInput, type ServerWorldState } from '../sim/types.js';
import { DEFAULT_LIVE_CONFIG } from '../config.js';
import { abilityById } from '../data/abilities.js';
import type { Vec3 } from '../state/types.js';

function body(id: number, x: number, y: number): ServerEntity {
  return { id, position: { x, y, z: 0 } } as unknown as ServerEntity;
}

describe('the history', () => {
  it('answers where a body was', () => {
    const history = new PositionHistory();
    for (let tick = 0; tick <= 20; tick++) history.record(tick, [body(1, tick * 10, 0)]);
    expect(history.positionAt(1, 1)?.x).toBe(190);
    expect(history.positionAt(1, MAX_REWIND_TICKS)?.x).toBe(200 - MAX_REWIND_TICKS * 10);
  });

  it('stays bounded however long the server has been up', () => {
    const history = new PositionHistory();
    for (let tick = 0; tick < 5000; tick++) history.record(tick, [body(1, tick, 0)]);
    expect(history.depth).toBe(MAX_REWIND_TICKS + 1);
  });

  it('has nothing to say about a body it was not recording', () => {
    const history = new PositionHistory();
    for (let tick = 0; tick <= 20; tick++) history.record(tick, [body(1, 0, 0)]);
    expect(history.positionAt(2, 5)).toBeNull();
    // Nor about now, which is not the past.
    expect(history.positionAt(1, 0)).toBeNull();
  });

  it('clamps a lag a client made up', () => {
    const history = new PositionHistory();
    history.noteLag(1, 10_000);
    expect(history.ticksFor(1)).toBe(MAX_REWIND_TICKS);
    history.noteLag(1, -50);
    expect(history.ticksFor(1)).toBe(0);
    history.noteLag(1, Number.NaN);
    expect(history.ticksFor(1)).toBe(0);
    // And an attacker nobody has heard of is compensated by nothing.
    expect(history.ticksFor(99)).toBe(0);
  });

  it('forgets a connection that has gone', () => {
    const history = new PositionHistory();
    history.noteLag(1, 6);
    history.forget(1);
    expect(history.ticksFor(1)).toBe(0);
  });
});

// --- through the real step ------------------------------------------------

const WILDS: readonly ZoneDefinition[] = [];
const ATTACK = 'melee.slash';

function context(rewind?: RewindLookup): StepContext {
  return {
    world: createWorldColliders([], []),
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(WILDS),
    config: DEFAULT_LIVE_CONFIG,
    activeChunks: new Set(['0,0']),
    chunkSize: 1e9,
    spawnPoints: [],
    ...(rewind ? { rewind } : {}),
  };
}

const STATS = {
  maxHealth: 200,
  moveSpeed: 155,
  turnRate: 3600,
  attackDamage: 10,
  attackRange: 60,
  attackDelayTicks: 8,
  armor: 0,
  spellPower: 1,
  critChance: 0,
  maxResource: 100,
  resourceRegen: 0,
  basicAttackId: ATTACK,
};

interface Fight {
  state: ServerWorldState;
  readonly attackerId: number;
  readonly targetId: number;
  readonly history: PositionHistory;
}

/** Two players facing each other, the target just inside reach. */
function setUp(): Fight {
  let state = createWorldState(5);
  const a = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'ana',
    position: { x: 0, y: 0, z: 0 },
    stats: STATS,
    radius: SERVER_PLAYER_RADIUS,
    zoneId: 'wilds',
  });
  state = a.state;
  const b = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'ben',
    position: { x: 40, y: 0, z: 0 },
    stats: STATS,
    radius: SERVER_PLAYER_RADIUS,
    zoneId: 'wilds',
  });
  state = b.state;
  return { state, attackerId: a.entity.id, targetId: b.entity.id, history: new PositionHistory() };
}

function input(entityId: number, seq: number, extra: Partial<ServerInput> = {}): ServerInput {
  return {
    entityId,
    seq,
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
    ...extra,
  } as ServerInput;
}

/** Put the target at `x`, run one tick, and record the frame. */
function tickWith(fight: Fight, inputs: readonly ServerInput[], targetX: number | null, rewind?: RewindLookup): void {
  if (targetX !== null) {
    const target = fight.state.entities.get(fight.targetId);
    if (target) {
      const moved = new Map(fight.state.entities);
      moved.set(fight.targetId, { ...target, position: { x: targetX, y: 0, z: 0 } as Vec3 });
      fight.state = { ...fight.state, entities: moved };
    }
  }
  fight.state = step(fight.state, inputs, context(rewind)).state;
  fight.history.record(fight.state.tick, fight.state.entities.values());
}

function healthOf(fight: Fight): number {
  return fight.state.entities.get(fight.targetId)?.health ?? -1;
}

/**
 * Swing at the target, walking it out to `awayAt` `movedTicksAgo` ticks before
 * the blow lands. Returns how much damage was dealt.
 */
function swing(options: {
  readonly lag: number;
  readonly awayAt: number;
  readonly movedTicksAgo: number;
  readonly compensate: boolean;
}): number {
  const fight = setUp();
  const ability = abilityById(ATTACK);
  if (!ability) throw new Error('no ability');
  const rewind = options.compensate ? fight.history : undefined;
  fight.history.noteLag(fight.attackerId, options.lag);

  // Warm the ring, so there is a past to reach into.
  for (let i = 0; i < MAX_REWIND_TICKS + 2; i++) tickWith(fight, [], 40, rewind);

  const before = healthOf(fight);
  // Commit, then let the wind-up run. The target steps out `movedTicksAgo`
  // ticks before the release.
  const commit = input(fight.attackerId, 1, {
    castAbilityId: ATTACK,
    castTargetX: 40,
    castTargetY: 0,
    castTargetEntityId: fight.targetId,
  });
  tickWith(fight, [commit], 40, rewind);

  const windup = ability.windupTicks;
  for (let i = 1; i <= windup + 1; i++) {
    const ticksToRelease = windup - i;
    const at = ticksToRelease < options.movedTicksAgo ? options.awayAt : 40;
    tickWith(fight, [], at, rewind);
    if (healthOf(fight) < before) break;
  }
  return before - healthOf(fight);
}

describe('a blow lands on what its attacker saw', () => {
  it('connects on a target that has only just left, and misses without compensation', () => {
    // Out of reach at the release, but where the attacker was looking 6 ticks
    // ago it was still inside it.
    const settings = { lag: 6, awayAt: 200, movedTicksAgo: 4 } as const;
    expect(swing({ ...settings, compensate: false })).toBe(0);
    expect(swing({ ...settings, compensate: true })).toBeGreaterThan(0);
  });

  it('still misses a target that left before the window', () => {
    // Gone for longer than the cap, so there is no past in which it was in
    // reach. This is the dodge the wind-up exists for, and it survives.
    const settings = { awayAt: 200, movedTicksAgo: MAX_REWIND_TICKS + 6 } as const;
    expect(swing({ ...settings, lag: MAX_REWIND_TICKS, compensate: true })).toBe(0);
  });

  it('gives a client that claims a huge lag exactly what an honest one gets', () => {
    const settings = { awayAt: 200, movedTicksAgo: 4, compensate: true } as const;
    const honest = swing({ ...settings, lag: MAX_REWIND_TICKS });
    const liar = swing({ ...settings, lag: 100_000 });
    expect(liar).toBe(honest);
  });

  it('does not teleport the target into its own past', () => {
    const fight = setUp();
    fight.history.noteLag(fight.attackerId, MAX_REWIND_TICKS);
    for (let i = 0; i < MAX_REWIND_TICKS + 2; i++) tickWith(fight, [], 40, fight.history);
    const commit = input(fight.attackerId, 1, {
      castAbilityId: ATTACK,
      castTargetX: 40,
      castTargetY: 0,
      castTargetEntityId: fight.targetId,
    });
    tickWith(fight, [commit], 40, fight.history);
    const ability = abilityById(ATTACK);
    if (!ability) throw new Error('no ability');
    for (let i = 0; i <= ability.windupTicks + 1; i++) tickWith(fight, [], 55, fight.history);
    // Hit or not, the body is where the world last put it -- never where the
    // attacker saw it.
    expect(fight.state.entities.get(fight.targetId)?.position.x).toBe(55);
  });
});
