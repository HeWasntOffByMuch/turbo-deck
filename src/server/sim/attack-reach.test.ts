/**
 * A swing that was in range lands (spec 219).
 *
 * Driven through the real `step` rather than by calling the landers directly,
 * for the reason `attack-cancel.test.ts` gives: two of the three rules here
 * live entirely in the interaction between the movement pass and the cast pass,
 * and a direct call would prove almost nothing about either.
 *
 * The three, and each is a way the old behaviour failed:
 *
 *   1. A monster finishes the swing it started. It used to read its own chase
 *      as a withdrawal and cancel a wind-up 12 ticks into 30, producing neither
 *      a hit nor a miss.
 *   2. A monster holds still for its whole backswing, where it used to break
 *      out of one the tick its target crossed standoff.
 *   3. Reach is measured when the wind-up *begins* and never again, so a target
 *      that walked away mid-swing is hit -- and one that was never in reach to
 *      begin with is still missed.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG } from '../config.js';
import { abilityById } from '../data/abilities.js';
import { monsterById } from '../data/monsters.js';
import { computeEffectiveStats } from '../player/stats.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type EffectiveStats,
  type PersistedPlayer,
} from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import { attackTimingFor } from './abilities.js';
import {
  CastEndReason,
  CastPhase,
  EntityKindValue,
  type ServerEntity,
  type ServerInput,
  type ServerSimEvent,
  type ServerWorldState,
} from './types.js';
import { createWorldState, replaceEntity, spawnEntity, step, type StepContext } from './world.js';

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
  currentZone: 'greenmarch',
  level: 1,
  experience: 0,
  unspentSkillPoints: 0,
  unspentAttributePoints: 0,
  health: 100,
  resource: 100,
};

const STATS: EffectiveStats = { ...computeEffectiveStats(RECORD), spellPower: 1, critChance: 0 };
const CHUNK = 100;

function activeAround(x: number, y: number): Set<string> {
  const keys = new Set<string>();
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) keys.add(chunkKeyOf(x + dx * CHUNK, y + dy * CHUNK, CHUNK));
  }
  return keys;
}

function context(): StepContext {
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    activeChunks: activeAround(600, 450),
    chunkSize: CHUNK,
    spawnPoints: [],
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

function withMonster(
  state: ServerWorldState,
  typeId: string,
  x: number,
  y: number,
): { state: ServerWorldState; id: number } {
  const definition = monsterById(typeId);
  if (!definition) throw new Error(`no ${typeId}`);
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

const hits = (events: readonly ServerSimEvent[]): readonly ServerSimEvent[] =>
  events.filter((event) => event.kind === 'hit');
const misses = (events: readonly ServerSimEvent[]): readonly ServerSimEvent[] =>
  events.filter((event) => event.kind === 'attackMissed');
const endedWith = (events: readonly ServerSimEvent[], reason: number): readonly ServerSimEvent[] =>
  events.filter((event) => event.kind === 'castEnded' && event.reason === reason);

const SLASH = abilityById('melee.slash');
if (!SLASH) throw new Error('no melee.slash');

// ---------------------------------------------------------------------------

describe('a player swing measured at the wind-up', () => {
  it('lands on a target that walked out of reach during the wind-up', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const dummy = withMonster(state, 'dummy', 650, 450);
    state = dummy.state;
    const before = state.entities.get(dummy.id)?.health ?? 0;
    const timing = attackTimingFor(SLASH, { stats: STATS });
    const ctx = context();
    const events: ServerSimEvent[] = [];

    let current = step(
      state,
      [
        input(player.id, {
          castAbilityId: 'melee.slash',
          castTargetX: 650,
          castTargetY: 450,
          castTargetEntityId: dummy.id,
        }),
      ],
      ctx,
    );
    state = current.state;
    events.push(...current.events);

    // Shoved far out of reach halfway through, and never withdrawn from.
    for (let i = 1; i < timing.attackPointTicks + 4; i++) {
      if (i === Math.floor(timing.attackPointTicks / 2)) {
        const target = state.entities.get(dummy.id);
        if (!target) throw new Error('no target');
        state = replaceEntity(state, { ...target, position: { x: 1400, y: 450, z: 0 } });
      }
      current = step(state, [], ctx);
      state = current.state;
      events.push(...current.events);
    }

    expect(hits(events)).toHaveLength(1);
    expect(misses(events)).toHaveLength(0);
    expect(state.entities.get(dummy.id)?.health ?? 0).toBeLessThan(before);
  });

  /**
   * The other half, and the reason the reach is remembered rather than simply
   * dropped: `melee.slash` is direction-targeted, so `startCast`'s range gate
   * never runs on it and a body three times its reach away can legally be
   * named. Without the stamp this would be a hit at any distance.
   */
  it('misses a target that was never in reach when the wind-up began', () => {
    let state = createWorldState(5);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const far = withMonster(state, 'dummy', 600 + SLASH.range * 3, 450);
    state = far.state;
    const ctx = context();
    const events: ServerSimEvent[] = [];

    let current = state;
    for (let i = 0; i < SLASH.windupTicks + 12; i++) {
      const result = step(
        current,
        i === 0
          ? [
              input(player.id, {
                castAbilityId: 'melee.slash',
                castTargetX: 600 + SLASH.range * 3,
                castTargetY: 450,
                castTargetEntityId: far.id,
              }),
            ]
          : [],
        ctx,
      );
      current = result.state;
      events.push(...result.events);
    }

    expect(hits(events)).toHaveLength(0);
    expect(misses(events)).toHaveLength(1);
    expect(current.entities.get(far.id)?.health).toBe(monsterById('dummy')?.stats.maxHealth);
  });

  /**
   * The turn is not the swing (spec 065), so the reach is taken at alignment
   * and not at the commit. A body that has to come round finds what is there
   * when it has come round.
   */
  it('measures the reach at alignment, not at the commit, when the body must turn', () => {
    const slow: EffectiveStats = { ...STATS, turnRate: 30 };
    let state = createWorldState(3);
    const player = withPlayer(state, 600, 450, slow);
    state = player.state;
    // Behind the caster, who is facing +x: the whole 180 has to be turned
    // through at 30 deg/s, which is six seconds of turning.
    const behind = withMonster(state, 'dummy', 550, 450);
    state = behind.state;
    const ctx = context();
    const events: ServerSimEvent[] = [];

    let current = step(
      state,
      [
        input(player.id, {
          castAbilityId: 'melee.slash',
          castTargetX: 550,
          castTargetY: 450,
          castTargetEntityId: behind.id,
          facing: 0,
        }),
      ],
      ctx,
    );
    state = current.state;
    events.push(...current.events);
    expect(state.entities.get(player.id)?.cast?.phase).toBe(CastPhase.Turning);

    // It leaves while the caster is still coming round, so the swing never
    // begins in reach.
    const target = state.entities.get(behind.id);
    if (!target) throw new Error('no target');
    state = replaceEntity(state, { ...target, position: { x: 1400, y: 450, z: 0 } });

    for (let i = 0; i < 600; i++) {
      current = step(state, [input(player.id, { facing: Math.PI })], ctx);
      state = current.state;
      events.push(...current.events);
      if (state.entities.get(player.id)?.cast === null) break;
    }

    expect(hits(events)).toHaveLength(0);
    expect(misses(events)).toHaveLength(1);
  });

  /**
   * The positive half of the one above, and the half that actually pins the
   * re-stamp: `startCast` leaves the flag false, so a turning cast that never
   * had its reach taken again at alignment would miss a body standing still in
   * front of it. Asserting only the miss above would pass on the default.
   */
  it('lands after a long turn on a target that stayed in reach', () => {
    const slow: EffectiveStats = { ...STATS, turnRate: 30 };
    let state = createWorldState(3);
    const player = withPlayer(state, 600, 450, slow);
    state = player.state;
    const behind = withMonster(state, 'dummy', 550, 450);
    state = behind.state;
    const before = state.entities.get(behind.id)?.health ?? 0;
    const ctx = context();
    const events: ServerSimEvent[] = [];

    let current = step(
      state,
      [
        input(player.id, {
          castAbilityId: 'melee.slash',
          castTargetX: 550,
          castTargetY: 450,
          castTargetEntityId: behind.id,
          facing: 0,
        }),
      ],
      ctx,
    );
    state = current.state;
    events.push(...current.events);
    expect(state.entities.get(player.id)?.cast?.phase).toBe(CastPhase.Turning);

    for (let i = 0; i < 600; i++) {
      current = step(state, [input(player.id, { facing: Math.PI })], ctx);
      state = current.state;
      events.push(...current.events);
      if (state.entities.get(player.id)?.cast === null) break;
    }

    expect(hits(events)).toHaveLength(1);
    expect(misses(events)).toHaveLength(0);
    expect(state.entities.get(behind.id)?.health ?? 0).toBeLessThan(before);
  });

  it('still misses a target that died before the release', () => {
    let state = createWorldState(7);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const dummy = withMonster(state, 'dummy', 650, 450);
    state = dummy.state;
    const timing = attackTimingFor(SLASH, { stats: STATS });
    const ctx = context();
    const events: ServerSimEvent[] = [];

    let current = step(
      state,
      [
        input(player.id, {
          castAbilityId: 'melee.slash',
          castTargetX: 650,
          castTargetY: 450,
          castTargetEntityId: dummy.id,
        }),
      ],
      ctx,
    );
    state = current.state;
    events.push(...current.events);

    for (let i = 1; i < timing.attackPointTicks + 4; i++) {
      if (i === Math.floor(timing.attackPointTicks / 2)) {
        const target = state.entities.get(dummy.id);
        if (!target) throw new Error('no target');
        state = replaceEntity(state, { ...target, health: 0 });
      }
      current = step(state, [], ctx);
      state = current.state;
      events.push(...current.events);
    }

    expect(hits(events)).toHaveLength(0);
    expect(misses(events)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

/**
 * A pack member's own chase used to be read as a withdrawal, so these two are
 * about a body that is never given an input at all: everything it asks for
 * comes from `monsterIntent`.
 */
describe('a monster finishes what it started', () => {
  interface Fight {
    state: ServerWorldState;
    readonly playerId: number;
    readonly spiderId: number;
    readonly ctx: StepContext;
  }

  function nest(): Fight {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const spider = withMonster(state, 'small_spider', 640, 450);
    state = spider.state;
    return { state, playerId: player.id, spiderId: spider.id, ctx: context() };
  }

  const spiderOf = (fight: Fight): ServerEntity => {
    const found = fight.state.entities.get(fight.spiderId);
    if (!found) throw new Error('no spider');
    return found;
  };

  it('completes a wind-up its target ran out of reach of', () => {
    const fight = nest();
    const events: ServerSimEvent[] = [];
    let windupTick = -1;
    let committed = false;

    for (let i = 0; i < 200; i++) {
      const before = spiderOf(fight);
      if (windupTick < 0 && before.cast?.phase === CastPhase.Windup) windupTick = i;
      if (before.cast?.committed) committed = true;
      // The player sprints the moment the swing starts, and keeps going.
      const result = step(
        fight.state,
        [input(fight.playerId, windupTick >= 0 ? { moveX: -1, moveY: 0 } : {})],
        fight.ctx,
      );
      fight.state = result.state;
      events.push(...result.events);
    }

    expect(windupTick).toBeGreaterThanOrEqual(0);
    expect(committed).toBe(true);
    expect(hits(events)).toHaveLength(1);
    // The failure this test exists for produced neither a hit nor a miss.
    expect(endedWith(events, CastEndReason.Cancelled)).toHaveLength(0);
  });

  it('does not move for the whole of its backswing', () => {
    const fight = nest();
    const events: ServerSimEvent[] = [];
    let commitTick = -1;
    let movedWhileCommitted = 0;

    for (let i = 0; i < 200; i++) {
      const before = spiderOf(fight);
      if (commitTick < 0 && before.cast?.committed) commitTick = i;
      const result = step(
        fight.state,
        [input(fight.playerId, commitTick >= 0 ? { moveX: -1, moveY: 0 } : {})],
        fight.ctx,
      );
      fight.state = result.state;
      events.push(...result.events);
      const after = spiderOf(fight);
      if (after.cast?.committed) {
        movedWhileCommitted += Math.hypot(
          after.position.x - before.position.x,
          after.position.y - before.position.y,
        );
      }
    }

    expect(commitTick).toBeGreaterThanOrEqual(0);
    expect(movedWhileCommitted).toBe(0);
    expect(endedWith(events, CastEndReason.BackswingCancelled)).toHaveLength(0);
    // And it did end -- rooted is not stuck.
    expect(endedWith(events, CastEndReason.Released).length).toBeGreaterThan(0);
  });

  it('walks again once the backswing is over', () => {
    const fight = nest();
    let commitTick = -1;
    let freeTick = -1;
    let movedAfter = 0;

    for (let i = 0; i < 260; i++) {
      const before = spiderOf(fight);
      if (commitTick < 0 && before.cast?.committed) commitTick = i;
      if (commitTick >= 0 && freeTick < 0 && before.cast === null) freeTick = i;
      fight.state = step(
        fight.state,
        [input(fight.playerId, commitTick >= 0 ? { moveX: -1, moveY: 0 } : {})],
        fight.ctx,
      ).state;
      const after = spiderOf(fight);
      if (freeTick >= 0) {
        movedAfter += Math.hypot(
          after.position.x - before.position.x,
          after.position.y - before.position.y,
        );
      }
    }

    expect(freeTick).toBeGreaterThan(commitTick);
    expect(movedAfter).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('none of it costs determinism', () => {
  it('replays a fight to bit-identical state', () => {
    const play = (): ServerWorldState => {
      let state = createWorldState(11);
      const player = withPlayer(state, 600, 450);
      state = player.state;
      const spider = withMonster(state, 'small_spider', 640, 450);
      state = spider.state;
      const ctx = context();
      for (let i = 0; i < 220; i++) {
        state = step(
          state,
          [input(player.id, i > 40 ? { moveX: -1, moveY: 0 } : {})],
          ctx,
        ).state;
      }
      return state;
    };

    const first = play();
    const second = play();
    expect(second.tick).toBe(first.tick);
    expect(JSON.stringify([...second.entities])).toBe(JSON.stringify([...first.entities]));
    expect(second.rng).toEqual(first.rng);
  });
});
