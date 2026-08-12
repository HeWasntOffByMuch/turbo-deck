/**
 * The attack point, from both sides (spec 144).
 *
 * Driven through the real `step` for the reason `abilities.test.ts` gives: an
 * attack is only correct if it behaves correctly *in a tick*, alongside movement
 * and the cooldown table. The distinction being tested here is one that lives
 * entirely in the interaction between the movement pass and the cast pass, so
 * calling `cancelCast` directly would prove almost nothing.
 *
 * Two invariants govern the whole file, and every test below is one of them
 * asked about a specific tick:
 *
 *   1. Cancelling **before** the attack point produces no successful attack.
 *   2. Cancelling **after** it cannot revoke the attack, and can never let a
 *      body attack faster than its interval.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
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
import { attackSpeedFactor } from './attack-timing.js';
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
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) keys.add(chunkKeyOf(x + dx * CHUNK, y + dy * CHUNK, CHUNK));
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

/** A training dummy: scenery with a health bar, so nothing hits back. */
function withDummy(
  state: ServerWorldState,
  x: number,
  y: number,
): { state: ServerWorldState; id: number } {
  const definition = monsterById('dummy');
  if (!definition) throw new Error('no dummy');
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

const hits = (events: readonly ServerSimEvent[]): readonly ServerSimEvent[] =>
  events.filter((event) => event.kind === 'hit');
const misses = (events: readonly ServerSimEvent[]): readonly ServerSimEvent[] =>
  events.filter((event) => event.kind === 'attackMissed');
const projectiles = (state: ServerWorldState): readonly ServerEntity[] =>
  [...state.entities.values()].filter((entity) => entity.projectile !== null);

/** A stat block whose basic attack is the bow, for the ranged cases. */
const ARCHER: EffectiveStats = { ...STATS, basicAttackId: 'ranged.shot' };

/** Walking north, which is the withdrawal every cancellation test uses. */
const WALK = { moveX: 0, moveY: 1 };

// ---------------------------------------------------------------------------

describe('cancelling before the attack point', () => {
  /**
   * The plain case. Half a wind-up in, the player walks: no damage, no hit
   * event, no cooldown, and the resource back.
   */
  it('produces no attack at all', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const dummy = withDummy(state, 650, 450);
    state = dummy.state;
    const before = state.entities.get(dummy.id)?.health ?? 0;

    const slash = abilityById('melee.slash');
    if (!slash) throw new Error('no melee.slash');
    const timing = attackTimingFor(slash, { stats: STATS });
    const half = Math.floor(timing.attackPointTicks / 2);

    const result = run(state, timing.attackPointTicks + timing.backswingTicks + 10, {
      0: [
        input(player.id, {
          castAbilityId: 'melee.slash',
          castTargetX: 650,
          castTargetY: 450,
          castTargetEntityId: dummy.id,
        }),
      ],
      [half]: [input(player.id, WALK)],
    });

    expect(hits(result.events)).toHaveLength(0);
    expect(misses(result.events)).toHaveLength(0);
    expect(state.entities.get(dummy.id)?.health).toBe(before);
    expect(result.state.entities.get(dummy.id)?.health).toBe(before);
    expect(result.state.entities.get(player.id)?.cast).toBeNull();
    // No interval was started, so the next attack is available immediately.
    expect(result.state.entities.get(player.id)?.cooldowns['melee.slash']).toBeUndefined();
    // And it is reported as the withdrawal, not as a skipped follow-through.
    const ended = result.events.filter((event) => event.kind === 'castEnded');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.kind === 'castEnded' && ended[0].reason).toBe(CastEndReason.Cancelled);
  });

  /**
   * **The same-tick ordering rule**, which is the boundary case the whole model
   * is judged on and the one thing about it that has to be picked rather than
   * derived.
   *
   * Within a tick, movement runs before casts, so a withdrawal delivered on
   * tick T is *seen* before the release that tick T is about to process. The
   * sim resolves the ambiguity in `cancelWindup`: **the release tick belongs to
   * the attack**, so the last tick a withdrawal works on is `releaseTick - 1`.
   *
   * Both sides of that line are asserted here, because a rule with only its
   * happy side tested is a rule that can silently move by one tick.
   */
  it('cancels on the tick before the attack point, and not on the tick of it', () => {
    function withdrawAt(offsetFromRelease: number): Run & { playerId: number } {
      let state = createWorldState(2);
      const player = withPlayer(state, 600, 450);
      state = player.state;
      const dummy = withDummy(state, 650, 450);
      state = dummy.state;

      const committed = run(state, 1, {
        0: [
          input(player.id, {
            castAbilityId: 'melee.slash',
            castTargetX: 650,
            castTargetY: 450,
            castTargetEntityId: dummy.id,
          }),
        ],
      });
      const releaseTick = committed.state.entities.get(player.id)?.cast?.releaseTick ?? 0;
      expect(releaseTick).toBeGreaterThan(committed.state.tick);

      let during = committed;
      while (during.state.tick < releaseTick + offsetFromRelease - 1) {
        during = run(during.state, 1);
      }
      expect(during.state.entities.get(player.id)?.cast?.committed).toBe(false);
      return { ...run(during.state, 1, { 0: [input(player.id, WALK)] }), playerId: player.id };
    }

    // One tick early: nothing happened at all.
    const early = withdrawAt(-1);
    expect(hits(early.events)).toHaveLength(0);
    expect(misses(early.events)).toHaveLength(0);
    expect(early.state.entities.get(early.playerId)?.cast).toBeNull();
    expect(early.state.entities.get(early.playerId)?.cooldowns['melee.slash']).toBeUndefined();
    expect(
      early.events.some(
        (event) => event.kind === 'castEnded' && event.reason === CastEndReason.Cancelled,
      ),
    ).toBe(true);

    // On the tick itself: too late, and the blow lands -- with its interval
    // stamped, because it is a real attack in every sense.
    const late = withdrawAt(0);
    expect(hits(late.events).length).toBeGreaterThan(0);
    expect(late.state.entities.get(late.playerId)?.cooldowns['melee.slash']).toBeGreaterThan(0);
  });

  it('looses no arrow when a ranged wind-up is withdrawn from', () => {
    let state = createWorldState(3);
    const player = withPlayer(state, 600, 450, ARCHER);
    state = player.state;
    state = withDummy(state, 900, 450).state;

    const shot = abilityById('ranged.shot');
    if (!shot) throw new Error('no ranged.shot');
    const timing = attackTimingFor(shot, { stats: ARCHER });

    const result = run(state, timing.attackPointTicks + 20, {
      0: [
        input(player.id, {
          castAbilityId: 'ranged.shot',
          castTargetX: 900,
          castTargetY: 450,
        }),
      ],
      [Math.floor(timing.attackPointTicks / 2)]: [input(player.id, WALK)],
    });

    expect(projectiles(result.state)).toHaveLength(0);
    expect(result.events.some((event) => event.kind === 'spawned')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('cancelling after the attack point', () => {
  /**
   * The spec's headline example, in ticks: the blow lands, the player walks one
   * tick later, and the only thing they get back is their legs.
   */
  it('keeps the blow, the cooldown and the arrow, and returns only the legs', () => {
    let state = createWorldState(4);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const dummy = withDummy(state, 650, 450);
    state = dummy.state;
    const before = state.entities.get(dummy.id)?.health ?? 0;

    const committed = run(state, 1, {
      0: [
        input(player.id, {
          castAbilityId: 'melee.slash',
          castTargetX: 650,
          castTargetY: 450,
          castTargetEntityId: dummy.id,
        }),
      ],
    });
    const releaseTick = committed.state.entities.get(player.id)?.cast?.releaseTick ?? 0;

    let during = committed;
    while (during.state.tick < releaseTick) during = run(during.state, 1);

    // Landed, and in the follow-through.
    expect(hits(during.events).length).toBeGreaterThan(0);
    const damaged = during.state.entities.get(dummy.id)?.health ?? 0;
    expect(damaged).toBeLessThan(before);
    const self = during.state.entities.get(player.id);
    expect(self?.cast?.phase).toBe(CastPhase.Backswing);
    expect(self?.cast?.committed).toBe(true);
    const stamped = self?.cooldowns['melee.slash'] ?? 0;
    const wasAt = { x: self?.position.x ?? 0, y: self?.position.y ?? 0 };

    // Walk one tick later.
    const after = run(during.state, 1, { 0: [input(player.id, WALK)] });
    const moved = after.state.entities.get(player.id);

    // The attack is not revoked: the damage stands and the cooldown is the
    // number stamped at the attack point, to the tick.
    expect(after.state.entities.get(dummy.id)?.health).toBe(damaged);
    expect(moved?.cooldowns['melee.slash']).toBe(stamped);
    // The animation is over and the body moved on the very same tick.
    expect(moved?.cast).toBeNull();
    expect(moved?.position.y).toBeGreaterThan(wasAt.y);
    // And it is announced as its own kind of ending.
    expect(
      after.events.some(
        (event) =>
          event.kind === 'castEnded' && event.reason === CastEndReason.BackswingCancelled,
      ),
    ).toBe(true);
  });

  it('leaves a loosed arrow flying, and it still hits', () => {
    let state = createWorldState(5);
    const player = withPlayer(state, 600, 450, ARCHER);
    state = player.state;
    const dummy = withDummy(state, 800, 450);
    state = dummy.state;
    const before = state.entities.get(dummy.id)?.health ?? 0;

    const committed = run(state, 1, {
      0: [
        input(player.id, {
          castAbilityId: 'ranged.shot',
          castTargetX: 800,
          castTargetY: 450,
          castTargetEntityId: dummy.id,
        }),
      ],
    });
    const releaseTick = committed.state.entities.get(player.id)?.cast?.releaseTick ?? 0;

    let during = committed;
    while (during.state.tick < releaseTick) during = run(during.state, 1);
    expect(projectiles(during.state)).toHaveLength(1);

    // Walk out of the backswing the instant the arrow is away, then keep
    // walking. The shot is on its own from here -- its flight is never bound to
    // the attack animation still playing.
    const frames: Record<number, ServerInput[]> = {};
    for (let i = 0; i < 200; i++) frames[i] = [input(player.id, WALK)];
    const after = run(during.state, 200, frames);

    expect(after.state.entities.get(player.id)?.cast).toBeNull();
    expect(after.state.entities.get(dummy.id)?.health).toBeLessThan(before);
    expect(hits(after.events).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('the invariant that makes backswing cancelling worth doing', () => {
  /**
   * How many blows a body lands over `ticks`, attacking as fast as it is
   * allowed to and optionally walking out of every follow-through the instant
   * it may.
   *
   * The request is made every tick on purpose: this is the spam case, and the
   * point is that spamming cannot beat the interval.
   */
  function swingsOver(ticks: number, cancelBackswing: boolean, seed: number): number {
    let state = createWorldState(seed);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const dummy = withDummy(state, 650, 450);
    state = dummy.state;

    let landed = 0;
    let current = state;
    for (let i = 0; i < ticks; i++) {
      const self = current.entities.get(player.id);
      // Walk only while committed; asking to walk during a wind-up would
      // withdraw from it and this measures the *cadence*, not the feint.
      const walking = cancelBackswing && self?.cast?.committed === true;
      const frame = input(player.id, {
        ...(walking ? WALK : {}),
        castAbilityId: 'melee.slash',
        castTargetX: 650,
        castTargetY: 450,
        castTargetEntityId: dummy.id,
      });
      const result = step(current, [frame], context());
      current = result.state;
      landed += hits(result.events).length;
      // The dummy has 100000 health, so nothing dies mid-measurement.
      if (walking) {
        // Walking moves the body; put it back so range never becomes the
        // variable being measured.
        const moved = current.entities.get(player.id);
        if (moved) {
          current = replaceEntity(current, { ...moved, position: { x: 600, y: 450, z: 0 } });
        }
      }
    }
    return landed;
  }

  /**
   * **The invariant.** Cancelling the backswing reduces how long a player is
   * animation-locked and can never raise their attacks per second.
   *
   * Asserted as an equality rather than an inequality, because "no faster" is
   * satisfied by a bug that makes cancelling *slower*, and a player who found
   * that out would stop doing it.
   */
  it('cancelling every backswing lands exactly as many blows as cancelling none', () => {
    const ticks = SERVER_TICK_RATE * 20;
    expect(swingsOver(ticks, true, 11)).toBe(swingsOver(ticks, false, 11));
  });

  it('spamming the attack order cannot beat the interval', () => {
    const ticks = SERVER_TICK_RATE * 20;
    const landed = swingsOver(ticks, false, 12);
    const slash = abilityById('melee.slash');
    if (!slash) throw new Error('no melee.slash');
    const timing = attackTimingFor(slash, { stats: STATS });

    // One extra allowed for the partial cycle at each end of the window.
    expect(landed).toBeLessThanOrEqual(Math.ceil(ticks / timing.intervalTicks) + 1);
    // And it is actually attacking, rather than passing by doing nothing.
    expect(landed).toBeGreaterThanOrEqual(Math.floor(ticks / timing.intervalTicks) - 1);
  });

  /**
   * The other half of the same claim, measured directly: consecutive attack
   * points are never closer together than the interval.
   */
  it('never puts two attack points closer together than the interval', () => {
    let state = createWorldState(13);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const dummy = withDummy(state, 650, 450);
    state = dummy.state;

    const slash = abilityById('melee.slash');
    if (!slash) throw new Error('no melee.slash');
    const interval = attackTimingFor(slash, { stats: STATS }).intervalTicks;

    const commits: number[] = [];
    let current = state;
    for (let i = 0; i < SERVER_TICK_RATE * 20; i++) {
      const self = current.entities.get(player.id);
      const walking = self?.cast?.committed === true;
      const result = step(
        current,
        [
          input(player.id, {
            ...(walking ? WALK : {}),
            castAbilityId: 'melee.slash',
            castTargetX: 650,
            castTargetY: 450,
            castTargetEntityId: dummy.id,
          }),
        ],
        context(),
      );
      current = result.state;
      if (hits(result.events).length > 0) commits.push(current.tick);
      const moved = current.entities.get(player.id);
      if (walking && moved) {
        current = replaceEntity(current, { ...moved, position: { x: 600, y: 450, z: 0 } });
      }
    }

    expect(commits.length).toBeGreaterThan(5);
    for (let i = 1; i < commits.length; i++) {
      expect((commits[i] ?? 0) - (commits[i - 1] ?? 0)).toBeGreaterThanOrEqual(interval);
    }
  });
});

// ---------------------------------------------------------------------------

describe('attack speed reaches the animation as well as the cadence', () => {
  it('shortens the interval, the wind-up and the backswing together', () => {
    const slash = abilityById('melee.slash');
    if (!slash) throw new Error('no melee.slash');
    const base = attackTimingFor(slash, { stats: STATS });
    const fast = attackTimingFor(slash, { stats: { ...STATS, attackSpeed: 100 } });

    expect(attackSpeedFactor({ ...STATS, attackSpeed: 100 })).toBeCloseTo(2, 9);
    expect(fast.intervalTicks).toBeLessThan(base.intervalTicks);
    expect(fast.attackPointTicks).toBeLessThan(base.attackPointTicks);
    expect(fast.backswingTicks).toBeLessThan(base.backswingTicks);
  });

  /**
   * The failure spec 144 exists to prevent: a shorter cooldown with the same
   * wind-up. Measured in the sim rather than in the resolver, because it is the
   * cast's own release tick that has to move.
   */
  it('lands a hasted blow sooner, in the real tick', () => {
    function releaseAt(attackSpeed: number): number {
      let state = createWorldState(14);
      const player = withPlayer(state, 600, 450, { ...STATS, attackSpeed });
      state = player.state;
      state = withDummy(state, 650, 450).state;
      const committed = run(state, 1, {
        0: [
          input(player.id, {
            castAbilityId: 'melee.slash',
            castTargetX: 650,
            castTargetY: 450,
          }),
        ],
      });
      const cast = committed.state.entities.get(player.id)?.cast;
      return (cast?.releaseTick ?? 0) - (cast?.windupStartTick ?? 0);
    }

    expect(releaseAt(100)).toBeLessThan(releaseAt(0));
    expect(releaseAt(100)).toBe(Math.round(releaseAt(0) / 2));
  });

  /**
   * Spec 144 snapshots the timing at the start of the swing, so a buff landing
   * halfway through belongs to the next attack rather than jerking this one
   * forward. Poked in directly, because there is no in-game source of attack
   * speed yet -- which is the point: the *sim* has to hold the line whatever
   * puts the stat there later.
   */
  it('keeps a swing on the timing it started with, and gives the change to the next', () => {
    let state = createWorldState(15);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    state = withDummy(state, 650, 450).state;

    const committed = run(state, 1, {
      0: [
        input(player.id, {
          castAbilityId: 'melee.slash',
          castTargetX: 650,
          castTargetY: 450,
        }),
      ],
    });
    const started = committed.state.entities.get(player.id)?.cast;
    const releaseTick = started?.releaseTick ?? 0;
    const attackPoint = started?.timing.attackPointTicks ?? 0;

    // Two ticks in, double the body's attack speed.
    let during = run(committed.state, 2);
    const mid = during.state.entities.get(player.id);
    if (!mid) throw new Error('no player');
    during = {
      ...during,
      state: replaceEntity(during.state, { ...mid, stats: { ...mid.stats, attackSpeed: 100 } }),
    };

    // This swing is unmoved: same release, same snapshot.
    const live = during.state.entities.get(player.id)?.cast;
    expect(live?.releaseTick).toBe(releaseTick);
    expect(live?.timing.attackPointTicks).toBe(attackPoint);
    expect(live?.timing.factor).toBeCloseTo(1, 9);

    // Run it out, then start the next one: that one is hasted.
    let after = during;
    while (after.state.entities.get(player.id)?.cast !== null) after = run(after.state, 1);
    // Asked for on every tick, because the interval outlasts the animation --
    // the body is free well before it may swing again, and a single request on
    // the first free tick is refused as `onCooldown`.
    const frames: Record<number, ServerInput[]> = {};
    for (let i = 0; i < 200; i++) {
      frames[i] = [
        input(player.id, {
          castAbilityId: 'melee.slash',
          castTargetX: 650,
          castTargetY: 450,
        }),
      ];
    }
    const next = run(after.state, 200, frames);
    const secondStart = next.events.find(
      (event) => event.kind === 'castStarted' && event.phase === CastPhase.Windup,
    );
    expect(secondStart?.kind === 'castStarted' && secondStart.releaseTick - secondStart.startTick).toBe(
      Math.round(attackPoint / 2),
    );
  });
});

// ---------------------------------------------------------------------------

describe('determinism', () => {
  /**
   * The property the whole repo rests on, asked of the new phase: a replay with
   * backswing cancellations in the input sequence has to land on bit-identical
   * state, every run.
   */
  it('replays a fight with cancellations to identical state', () => {
    function play(): string {
      let state = createWorldState(21);
      const player = withPlayer(state, 600, 450);
      state = player.state;
      const dummy = withDummy(state, 650, 450);
      state = dummy.state;

      let current = state;
      for (let i = 0; i < 400; i++) {
        const self = current.entities.get(player.id);
        // A mix on purpose: some wind-ups are withdrawn from, some backswings
        // are walked out of, and some attacks run their course.
        const withdrawing = i % 37 === 0;
        const skipping = self?.cast?.committed === true && i % 3 === 0;
        current = step(
          current,
          [
            input(player.id, {
              ...(withdrawing || skipping ? WALK : {}),
              castAbilityId: 'melee.slash',
              castTargetX: 650,
              castTargetY: 450,
              castTargetEntityId: dummy.id,
            }),
          ],
          context(),
        ).state;
      }

      return JSON.stringify(
        [...current.entities.values()].map((entity) => ({
          id: entity.id,
          health: entity.health,
          position: entity.position,
          cooldowns: entity.cooldowns,
          cast: entity.cast,
        })),
      );
    }

    expect(play()).toBe(play());
  });
});
