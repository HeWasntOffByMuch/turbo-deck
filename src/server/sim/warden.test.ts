/**
 * The Warden's laser cycle (spec 262).
 *
 * Everything here is driven through the real `step`, never by calling the
 * warden module directly, because the thing being asserted is that the encounter
 * is *wired* -- the failure this repo keeps rediscovering is a complete set of
 * green unit tests beside a system nothing calls. So the fixture is a world, a
 * player and a Warden, and every claim is read off what came out of a tick.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '../../sim/collision.js';
import { CHUNK_SIZE, DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { monsterById } from '../data/monsters.js';
import { WARDEN_LASER, WardenPhase } from '../data/warden.js';
import { computeEffectiveStats } from '../player/stats.js';
import { EMPTY_EQUIPMENT, emptyInventory, type EffectiveStats, type PersistedPlayer } from '../state/types.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import { StatusId, hasStatus, statusOf } from './statuses.js';
import { wardenPhase, wardenReport } from './warden.js';
import {
  ActivityValue,
  EntityKindValue,
  type ServerEntity,
  type ServerInput,
  type ServerSimEvent,
  type ServerWorldState,
} from './types.js';
import { createWorldState, spawnEntity, step, type StepContext } from './world.js';

const RECORD: PersistedPlayer = {
  id: 'p1',
  displayName: 'P1',
  baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
  specializations: [],
  equipment: EMPTY_EQUIPMENT,
  inventory: emptyInventory(),
  coins: 0,
  position: { x: 0, y: 0, z: 0 },
  facing: 0,
  currentZone: 'hearth',
  level: 1,
  experience: 0,
  unspentProgressionPoints: 0,
  health: 100,
  resource: 20,
};

const PLAYER_STATS: EffectiveStats = computeEffectiveStats(RECORD);
const WARDEN_AT = { x: 600, y: 450 };
const WARDEN = monsterById('warden');

function activeAround(x: number, y: number): Set<string> {
  const keys = new Set<string>();
  for (let dy = -8; dy <= 8; dy++) {
    for (let dx = -8; dx <= 8; dx++) keys.add(chunkKeyOf(x + dx * CHUNK_SIZE, y + dy * CHUNK_SIZE, CHUNK_SIZE));
  }
  return keys;
}

function context(): StepContext {
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: DEFAULT_LIVE_CONFIG,
    activeChunks: activeAround(WARDEN_AT.x, WARDEN_AT.y),
    chunkSize: CHUNK_SIZE,
    spawnPoints: [],
  };
}

/** A player at a bearing and a distance from the Warden. */
function playerAt(
  state: ServerWorldState,
  bearingDeg: number,
  distance: number,
  id = 'p1',
): { state: ServerWorldState; id: number } {
  const radians = (bearingDeg * Math.PI) / 180;
  const spawned = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: id,
    position: {
      x: WARDEN_AT.x + Math.cos(radians) * distance,
      y: WARDEN_AT.y + Math.sin(radians) * distance,
      z: 0,
    },
    stats: PLAYER_STATS,
    radius: 16,
    zoneId: 'greenmarch',
  });
  return { state: spawned.state, id: spawned.entity.id };
}

/**
 * A Warden already committed to `targetId`.
 *
 * Handing a bare target is enough: `settle` commits a body handed one with no
 * mood attached, which is the convention `world.test.ts` already documents. What
 * that skips is the alert, which `aggro.test.ts` owns and this file is not about.
 */
function wardenFacing(state: ServerWorldState, targetId: number): { state: ServerWorldState; id: number } {
  if (!WARDEN) throw new Error('no warden row');
  const spawned = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId: 'warden',
    position: { x: WARDEN_AT.x, y: WARDEN_AT.y, z: 0 },
    stats: WARDEN.stats,
    radius: WARDEN.radius,
    zoneId: 'greenmarch',
    anchor: WARDEN_AT,
    targetId,
  });
  return { state: spawned.state, id: spawned.entity.id };
}

interface Move {
  readonly x: number;
  readonly y: number;
}

function input(entity: ServerEntity, seq: number, move: Move = { x: 0, y: 0 }): ServerInput {
  return {
    entityId: entity.id,
    seq,
    moveX: move.x,
    moveY: move.y,
    facing: entity.facing,
    buttons: 0,
    predictedX: entity.position.x,
    predictedY: entity.position.y,
    hasPrediction: false,
    seqSpan: 1,
    castAbilityId: '',
    castTargetX: 0,
    castTargetY: 0,
    castTargetEntityId: 0,
    cancelCast: false,
  };
}

/** One tangential step, anticlockwise about the Warden. */
function orbit(body: ServerEntity): Move {
  const dx = body.position.x - WARDEN_AT.x;
  const dy = body.position.y - WARDEN_AT.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length, y: dx / length };
}

interface Frame {
  readonly tick: number;
  readonly events: readonly ServerSimEvent[];
}

/**
 * Run `ticks` ticks, moving each named player however `steer` says.
 *
 * Returns every frame's events, so a test asserts on what the sim *reported*
 * rather than on a snapshot it took itself.
 */
function run(
  state: ServerWorldState,
  ticks: number,
  playerIds: readonly number[],
  steer: (body: ServerEntity, tick: number) => Move = () => ({ x: 0, y: 0 }),
): { state: ServerWorldState; frames: Frame[] } {
  const ctx = context();
  const frames: Frame[] = [];
  let current = state;
  for (let i = 0; i < ticks; i++) {
    const inputs: ServerInput[] = [];
    for (const id of playerIds) {
      const body = current.entities.get(id);
      if (body) inputs.push(input(body, current.tick + 1, steer(body, current.tick + 1)));
    }
    const result = step(current, inputs, ctx);
    current = result.state;
    frames.push({ tick: current.tick, events: result.events });
  }
  return { state: current, frames };
}

/**
 * Step until the Warden reaches `phase`, and stop on the first tick it does.
 *
 * Counting ticks instead is off by one in both directions -- a cast started on
 * tick 1 releases on `1 + windup`, and a channel ends on the tick after its
 * last -- and every such test would be pinning the arithmetic of `startCast`
 * rather than the encounter. The one test that *does* pin the durations counts
 * them explicitly and is the only one that should.
 */
function advanceTo(
  state: ServerWorldState,
  wardenId: number,
  playerIds: readonly number[],
  phase: number,
  steer: (body: ServerEntity, tick: number) => Move = () => ({ x: 0, y: 0 }),
): { state: ServerWorldState; frames: Frame[] } {
  const frames: Frame[] = [];
  let current = state;
  for (let i = 0; i < 4000; i++) {
    if (wardenPhase(mech(current, wardenId), current.tick) === phase) {
      return { state: current, frames };
    }
    const stepped = run(current, 1, playerIds, steer);
    current = stepped.state;
    frames.push(...stepped.frames);
  }
  throw new Error(`the warden never reached phase ${phase}`);
}

function mech(state: ServerWorldState, id: number): ServerEntity {
  const body = state.entities.get(id);
  if (!body) throw new Error('the warden left the world');
  return body;
}

/** Beam pulses that landed on `targetId`, by the tick they landed on. */
function pulseTicks(frames: readonly Frame[], wardenId: number, targetId: number): number[] {
  const ticks: number[] = [];
  for (const frame of frames) {
    for (const event of frame.events) {
      if (event.kind === 'hit' && event.attackerId === wardenId && event.targetId === targetId) {
        ticks.push(frame.tick);
      }
    }
  }
  return ticks;
}

/** A fresh fight: one player due east, one Warden already engaged on them. */
function fight(distance = 260, bearingDeg = 0): {
  state: ServerWorldState;
  playerId: number;
  wardenId: number;
} {
  const seeded = playerAt(createWorldState(11), bearingDeg, distance);
  const withWarden = wardenFacing(seeded.state, seeded.id);
  return { state: withWarden.state, playerId: seeded.id, wardenId: withWarden.id };
}

const LOCK_ON = WARDEN_LASER.lockOnTicks;
const FIRING = WARDEN_LASER.firingTicks;
const OVERHEAT = WARDEN_LASER.overheatTicks;

describe('the cycle (spec 262)', () => {
  it('walks Normal -> LockOn -> Firing -> Overheated -> Normal, on its own clocks', () => {
    const { state, playerId, wardenId } = fight();
    const seen: { tick: number; phase: number }[] = [];
    let current = state;
    const ctx = context();
    for (let i = 0; i < LOCK_ON + FIRING + OVERHEAT + 8; i++) {
      const body = current.entities.get(playerId);
      current = step(current, body ? [input(body, current.tick + 1)] : [], ctx).state;
      seen.push({ tick: current.tick, phase: wardenPhase(mech(current, wardenId), current.tick) });
    }

    // The first tick of each state, which is what a transition *is*.
    const firstAt = (phase: number): number => seen.find((row) => row.phase === phase)?.tick ?? -1;
    const lockOn = firstAt(WardenPhase.LockOn);
    const firing = firstAt(WardenPhase.Firing);
    const overheated = firstAt(WardenPhase.Overheated);
    const normal = seen.find((row) => row.tick > overheated && row.phase === WardenPhase.Normal)?.tick ?? -1;

    // It opens on the first tick it is engaged: `settle` commits a body handed a
    // target, and the laser starts on nothing else.
    expect(lockOn).toBe(1);
    // Each state hands over exactly when its own number says. The lock-on's
    // length is the ability's wind-up and the beam's is its channel, so these
    // two are the assertion that the encounter is running on `data/warden.ts`
    // rather than on anything this file made up.
    expect(firing - lockOn).toBe(LOCK_ON);
    expect(overheated - firing).toBe(FIRING);
    expect(normal - overheated).toBe(OVERHEAT);

    // And the order is total: no state is ever revisited out of turn, which is
    // what makes this a cycle rather than four things that happened.
    const order = seen
      .map((row) => row.phase)
      .filter((phase, at, all) => phase !== all[at - 1]);
    expect(order).toEqual([
      WardenPhase.LockOn,
      WardenPhase.Firing,
      WardenPhase.Overheated,
      WardenPhase.Normal,
    ]);
  });

  it('cannot aim again until the cooldown is up, overheat or no overheat', () => {
    const { state, playerId, wardenId } = fight();
    // The attack point: the tick the beam became real, and the tick the
    // cooldown is stamped from.
    const firing = advanceTo(state, wardenId, [playerId], WardenPhase.Firing).state;
    const attackPoint = firing.tick;

    // Out the far side of the overheat, and still refused.
    const back = advanceTo(firing, wardenId, [playerId], WardenPhase.Normal).state;
    const body = mech(back, wardenId);
    expect(body.cast).toBeNull();
    expect(wardenReport(body, back.tick).cooldownLeft).toBeGreaterThan(0);

    // And it aims again exactly one cooldown after the attack point, which is
    // the claim the number in `data/warden.ts` is making: `nextReadyTick`
    // stamps a non-basic ability at the tick its blow went off, so the beam and
    // the overheat are spent *inside* the cooldown rather than before it.
    const again = advanceTo(back, wardenId, [playerId], WardenPhase.LockOn).state;
    expect(again.tick - attackPoint).toBe(WARDEN_LASER.cooldownTicks);
  });
});

describe('the commitment (spec 262)', () => {
  it('tracks a moving target while it is aiming', () => {
    const { state, playerId, wardenId } = fight();
    const started = mech(state, wardenId).facing;
    const after = run(state, LOCK_ON - 1, [playerId], (body) => orbit(body)).state;
    const aimed = mech(after, wardenId);
    const player = after.entities.get(playerId);
    expect(player).toBeDefined();
    if (!player) return;

    // Still aiming, and pointed at where the player *is* rather than where they
    // were: a turn rate of 200 deg/s against a player's 34 deg/s at this radius
    // means the lock-on is never behind by more than rounding.
    expect(wardenPhase(aimed, after.tick)).toBe(WardenPhase.LockOn);
    const bearing = Math.atan2(player.position.y - aimed.position.y, player.position.x - aimed.position.x);
    expect(Math.abs(angle(aimed.facing - bearing))).toBeLessThan(0.02);
    // And it genuinely came round rather than the player having stayed put.
    expect(Math.abs(angle(aimed.facing - started))).toBeGreaterThan(0.8);
  });

  it('does not follow a target that runs once it has committed', () => {
    const { state, playerId, wardenId } = fight();
    const aimed = advanceTo(state, wardenId, [playerId], WardenPhase.Firing).state;
    const committedTo = mech(aimed, wardenId).facing;

    const after = run(aimed, FIRING - 1, [playerId], (body) => orbit(body)).state;
    const firing = mech(after, wardenId);
    const player = after.entities.get(playerId);
    expect(player).toBeDefined();
    if (!player) return;

    // The beam turned by no more than its own rate says it may, whatever the
    // player did. One tick of slack, because the sweep is applied per tick.
    const swept = Math.abs(angle(firing.facing - committedTo));
    const allowed = ((WARDEN_LASER.firingTurnRateDeg * Math.PI) / 180 / SERVER_TICK_RATE) * FIRING;
    expect(swept).toBeLessThanOrEqual(allowed + 1e-6);

    // And the player is a long way out of it: the gap between where the lance
    // points and where they are is the whole of what a bait buys.
    const bearing = Math.atan2(player.position.y - firing.position.y, player.position.x - firing.position.x);
    expect(Math.abs(angle(firing.facing - bearing))).toBeGreaterThan(swept * 2);
  });

  it('sweeps far slower than it turns, which is what makes the commitment one', () => {
    // A row assertion rather than a behavioural one, and it is the guard on the
    // whole encounter: these two numbers live in different files, and a Warden
    // whose beam tracked at its own turn rate would be a damage aura.
    expect(WARDEN).not.toBeNull();
    if (!WARDEN) return;
    expect(WARDEN_LASER.firingTurnRateDeg * 4).toBeLessThan(WARDEN.stats.turnRate);
    // The sweep must also be reachable at all: a step wider than the body's own
    // per-tick turn would be clamped by `turnToward` and the aim and the facing
    // would come apart.
    expect(WARDEN_LASER.firingTurnRateDeg).toBeLessThan(WARDEN.stats.turnRate);
  });

  it('lets a player who moves after the commit stop being hit', () => {
    const { state, playerId, wardenId } = fight();
    const aimed = advanceTo(state, wardenId, [playerId], WardenPhase.Firing).state;
    const escaped = run(aimed, FIRING, [playerId], (body) => orbit(body));
    const landed = pulseTicks(escaped.frames, wardenId, playerId);

    // Some pulses land -- the beam starts on top of them and a reaction is not
    // free -- and then they stop, well before the beam does.
    expect(landed.length).toBeGreaterThan(0);
    expect(landed.length).toBeLessThan(FIRING / WARDEN_LASER.pulseIntervalTicks);
    const last = landed[landed.length - 1] ?? 0;
    expect(escaped.state.tick - last).toBeGreaterThan(WARDEN_LASER.pulseIntervalTicks * 3);
  });

  it('keeps the lane the damage is measured in and the facing every client draws equal', () => {
    // The one geometric claim the client's hooks rest on: `beamOf` builds the
    // lane from a replicated *facing*, and the sim picks bodies out of the
    // cast's *aim*. They are the same angle by construction; this is the
    // construction being checked.
    const { state, playerId, wardenId } = fight();
    let current = advanceTo(state, wardenId, [playerId], WardenPhase.Firing).state;
    for (let i = 0; i < FIRING; i++) {
      current = run(current, 1, [playerId], (body) => orbit(body)).state;
      const body = mech(current, wardenId);
      if (!body.cast) continue;
      const aim = Math.atan2(body.cast.targetY - body.position.y, body.cast.targetX - body.position.x);
      expect(Math.abs(angle(aim - body.facing))).toBeLessThan(1e-6);
    }
  });
});

describe('the beam (spec 262)', () => {
  it('hits a body in the lane and misses one beside it at the same distance', () => {
    // Two players the same distance out: one dead ahead, one far enough round
    // that the lane's half-width cannot reach them.
    const first = playerAt(createWorldState(3), 0, 300, 'p1');
    const second = playerAt(first.state, 40, 300, 'p2');
    const withWarden = wardenFacing(second.state, first.id);
    const aimed = advanceTo(withWarden.state, withWarden.id, [first.id, second.id], WardenPhase.Firing).state;
    const fired = run(aimed, FIRING, [first.id, second.id]);

    expect(pulseTicks(fired.frames, withWarden.id, first.id).length).toBeGreaterThan(0);
    expect(pulseTicks(fired.frames, withWarden.id, second.id)).toEqual([]);
  });

  it('does not reach past its own range', () => {
    // Dead ahead, and further out than the lance goes. `startCast` would refuse
    // the cast at that distance, so the aim is a *third* body in range and the
    // far one is standing on the same line behind it.
    const near = playerAt(createWorldState(5), 0, 200, 'p1');
    const far = playerAt(near.state, 0, WARDEN_LASER.range + 120, 'p2');
    const withWarden = wardenFacing(far.state, near.id);
    const aimed = advanceTo(withWarden.state, withWarden.id, [near.id, far.id], WardenPhase.Firing).state;
    const fired = run(aimed, FIRING, [near.id, far.id]);

    expect(pulseTicks(fired.frames, withWarden.id, near.id).length).toBeGreaterThan(0);
    expect(pulseTicks(fired.frames, withWarden.id, far.id)).toEqual([]);
  });

  it('lands one pulse per configured interval and no more', () => {
    const { state, playerId, wardenId } = fight();
    // The arrival's own frames are kept, because the first pulse lands on the
    // tick the channel opens -- `nextPulseTick` is stamped to the attack point
    // itself -- and a count that started after it would be a count of seven.
    const arrival = advanceTo(state, wardenId, [playerId], WardenPhase.Firing);
    const fired = run(arrival.state, FIRING, [playerId]);
    const landed = pulseTicks([...arrival.frames, ...fired.frames], wardenId, playerId);

    expect(landed).toHaveLength(FIRING / WARDEN_LASER.pulseIntervalTicks);
    for (let i = 1; i < landed.length; i++) {
      expect((landed[i] ?? 0) - (landed[i - 1] ?? 0)).toBe(WARDEN_LASER.pulseIntervalTicks);
    }
  });

  it('takes Guard through the game’s own break, not a stagger of its own', () => {
    const { state, playerId, wardenId } = fight();
    let current = advanceTo(state, wardenId, [playerId], WardenPhase.LockOn).state;

    // Walk to the first pulse a tick at a time, so what is measured is the pool
    // either side of *one* landing rather than a difference over a window that
    // Guard regeneration has also been running through.
    let before = current.entities.get(playerId)?.poise ?? 0;
    let drop: number | null = null;
    for (let i = 0; i < LOCK_ON + FIRING; i++) {
      const stepped = run(current, 1, [playerId]);
      current = stepped.state;
      const hit = stepped.frames[0]?.events.some(
        (event) => event.kind === 'hit' && event.attackerId === wardenId && event.targetId === playerId,
      );
      const now = current.entities.get(playerId)?.poise ?? 0;
      if (hit) {
        drop = before - now;
        break;
      }
      before = now;
    }
    // Exactly what the row authors, less whatever hyper-armour the target had,
    // which for a fresh character is none.
    expect(drop).not.toBeNull();
    expect(drop ?? 0).toBeCloseTo(WARDEN_LASER.guardDamage, 5);

    // And staying in it breaks that guard through `applyPoiseDamage`, so the
    // consequences are the ones the game already has rather than a second
    // stagger system: the `poiseBroken` a client flinches and draws its swirl
    // from, the `Stunned` that roots the body *inside the beam*, and the
    // two-second immunity that stops the rest of the pulses breaking it again.
    let broke = 0;
    let rooted = false;
    for (let i = 0; i < FIRING; i++) {
      const stepped = run(current, 1, [playerId]);
      current = stepped.state;
      broke += stepped.frames[0]?.events.filter(
        (event) => event.kind === 'poiseBroken' && event.entityId === playerId,
      ).length ?? 0;
      if (current.entities.get(playerId)?.activity === ActivityValue.Stunned) rooted = true;
    }
    expect(broke).toBeGreaterThan(0);
    expect(rooted).toBe(true);
    // Once, not once per pulse: the window is what keeps a guard break a
    // mechanic rather than a removal, and a beam does not get to walk through it.
    expect(broke).toBe(1);
  });

  it('is dangerous to stand in and survivable to react to', () => {
    // Not a balance pin -- both numbers move with a retune -- but the *shape*
    // the brief asks for: one pulse is a warning and the whole beam is most of
    // a fresh character.
    const { state, playerId, wardenId } = fight();
    const aimed = advanceTo(state, wardenId, [playerId], WardenPhase.Firing).state;
    const start = aimed.entities.get(playerId)?.health ?? 0;
    const onePulse = run(aimed, 1, [playerId]).state.entities.get(playerId)?.health ?? 0;
    const whole = run(aimed, FIRING, [playerId]).state.entities.get(playerId)?.health ?? 0;

    expect(start - onePulse).toBeLessThan(start * 0.15);
    expect(start - whole).toBeGreaterThan(start * 0.4);
    expect(whole).toBeGreaterThan(0);
  });
});

describe('the overheat (spec 262)', () => {
  const overheated = (): { state: ServerWorldState; playerId: number; wardenId: number } => {
    const { state, playerId, wardenId } = fight();
    return {
      state: advanceTo(state, wardenId, [playerId], WardenPhase.Overheated).state,
      playerId,
      wardenId,
    };
  };

  it('roots it, silences it and stops its Guard coming back', () => {
    const { state, playerId, wardenId } = overheated();
    const opened = mech(state, wardenId);
    expect(wardenPhase(opened, state.tick)).toBe(WardenPhase.Overheated);
    expect(opened.activity).toBe(ActivityValue.Stunned);

    // Guard first: dent it, then check none of it comes back over the window.
    const dented = { ...opened, poise: 1 };
    const held = run(
      { ...state, entities: new Map(state.entities).set(dented.id, dented) },
      OVERHEAT - 2,
      [playerId],
    ).state;
    const still = mech(held, wardenId);
    expect(still.poise).toBeCloseTo(1, 5);
    // It did not walk, and it did not swing.
    expect(Math.hypot(still.position.x - opened.position.x, still.position.y - opened.position.y)).toBeLessThan(1e-6);
    expect(still.cast).toBeNull();
  });

  it('cannot fire again inside the window', () => {
    const { state, playerId, wardenId } = overheated();
    const held = run(state, OVERHEAT - 2, [playerId]);
    expect(mech(held.state, wardenId).cast).toBeNull();
    // And it did not even ask: a refusal would show up as a rejection event.
    const asked = held.frames.flatMap((frame) => frame.events).filter(
      (event) => event.kind === 'castRejected' && event.entityId === wardenId,
    );
    expect(asked).toEqual([]);
  });

  it('is the punish window, in the vocabulary the game already has', () => {
    const { state, playerId, wardenId } = overheated();
    const body = mech(state, wardenId);
    const exposed = statusOf(body.statuses, StatusId.Exposed, state.tick);
    expect(exposed?.magnitude).toBeCloseTo(WARDEN_LASER.overheatExposure, 5);
    expect(hasStatus(body.statuses, StatusId.Vulnerable, state.tick)).toBe(true);

    // And the exposure is worth what it says: the same blow lands harder inside
    // the window than outside it. Measured through `resolveBlow` by comparing
    // one damage number against the same one on a body with the window taken
    // off, so what is being asserted is the multiplier the game already applies.
    const clean: ServerEntity = {
      ...body,
      statuses: {},
    };
    const inside = damageTo(state, body, playerId);
    const outside = damageTo({ ...state, entities: new Map(state.entities).set(clean.id, clean) }, clean, playerId);
    expect(inside).toBeGreaterThan(outside);
    expect(inside / outside).toBeCloseTo(1 + WARDEN_LASER.overheatExposure, 1);
  });

  it('ends on its own clock and lets the machine fight again', () => {
    const { state, playerId, wardenId } = overheated();
    const after = run(state, OVERHEAT + 4, [playerId]).state;
    const body = mech(after, wardenId);
    expect(wardenPhase(body, after.tick)).toBe(WardenPhase.Normal);
    expect(hasStatus(body.statuses, StatusId.Overheated, after.tick)).toBe(false);
    expect(body.activity).not.toBe(ActivityValue.Stunned);
    // It walks again: the whole root was the overheat and nothing outlives it.
    const walked = run(after, 30, [playerId]).state;
    const moved = mech(walked, wardenId);
    expect(Math.hypot(moved.position.x - body.position.x, moved.position.y - body.position.y)).toBeGreaterThan(1);
  });

  it('keeps the window whole when a player breaks its Guard inside it', () => {
    // The play this window exists to reward must not shorten it: `stagger`
    // writes its own `activityUntilTick` from the breaker's Strength, which is
    // well short of an overheat.
    const { state, playerId, wardenId } = overheated();
    const body = mech(state, wardenId);
    const broken: ServerEntity = {
      ...body,
      activity: ActivityValue.Stunned,
      activityUntilTick: state.tick + 10,
    };
    const after = run(
      { ...state, entities: new Map(state.entities).set(broken.id, broken) },
      OVERHEAT - 20,
      [playerId],
    ).state;
    const held = mech(after, wardenId);
    expect(wardenPhase(held, after.tick)).toBe(WardenPhase.Overheated);
    expect(held.activity).toBe(ActivityValue.Stunned);
    expect(held.cast).toBeNull();
  });
});

describe('two players (spec 262)', () => {
  it('names one of them and does not swap mid-beam', () => {
    const first = playerAt(createWorldState(9), 0, 260, 'p1');
    const second = playerAt(first.state, 170, 260, 'p2');
    const withWarden = wardenFacing(second.state, first.id);
    const ids = [first.id, second.id];

    const aimed = advanceTo(withWarden.state, withWarden.id, ids, WardenPhase.Firing).state;
    const firing = mech(aimed, withWarden.id);
    expect(firing.cast?.targetEntityId).toBe(first.id);

    // The second player takes the Warden's attention -- `provoke` on a hit is
    // the one thing that could move it -- and the beam does not follow.
    const angered: ServerEntity = { ...firing, targetId: second.id };
    let current: ServerWorldState = {
      ...aimed,
      entities: new Map(aimed.entities).set(angered.id, angered),
    };
    const committedTo = firing.facing;
    const fired = run(current, FIRING - 1, ids);
    current = fired.state;

    const after = mech(current, withWarden.id);
    expect(after.cast?.targetEntityId).toBe(first.id);
    const allowed = ((WARDEN_LASER.firingTurnRateDeg * Math.PI) / 180 / SERVER_TICK_RATE) * FIRING;
    expect(Math.abs(angle(after.facing - committedTo))).toBeLessThanOrEqual(allowed + 1e-6);
    // The player standing behind it was never touched by the beam.
    expect(pulseTicks(fired.frames, withWarden.id, second.id)).toEqual([]);
  });

  it('lets the other player fight it normally throughout', () => {
    const first = playerAt(createWorldState(13), 0, 260, 'p1');
    const second = playerAt(first.state, 180, 70, 'p2');
    const withWarden = wardenFacing(second.state, first.id);
    const ids = [first.id, second.id];
    const aimed = advanceTo(withWarden.state, withWarden.id, ids, WardenPhase.Firing).state;

    // The one behind it swings, mid-beam, and the blow resolves like any other.
    const ctx = context();
    let current = aimed;
    let landed = 0;
    for (let i = 0; i < FIRING - 1; i++) {
      const inputs: ServerInput[] = [];
      for (const id of ids) {
        const body = current.entities.get(id);
        if (!body) continue;
        inputs.push(
          id === second.id
            ? {
                ...input(body, current.tick + 1),
                castAbilityId: 'melee.slash',
                castTargetX: WARDEN_AT.x,
                castTargetY: WARDEN_AT.y,
                castTargetEntityId: withWarden.id,
              }
            : input(body, current.tick + 1),
        );
      }
      const result = step(current, inputs, ctx);
      current = result.state;
      landed += result.events.filter(
        (event) => event.kind === 'hit' && event.attackerId === second.id,
      ).length;
    }
    expect(landed).toBeGreaterThan(0);
    expect(mech(current, withWarden.id).health).toBeLessThan(WARDEN?.stats.maxHealth ?? 0);
  });
});

describe('standing behind it (spec 262)', () => {
  /**
   * Why there is no rear vent.
   *
   * The brief asks for one only if camping behind the machine turns out to be
   * optimal. It is not, and this is the measurement that says so: the lock-on
   * turns at the body's own rate, a player circling turns at `speed / radius`,
   * and the first is larger at every radius a body can stand at. There is no
   * orbit that keeps you behind it when it decides to aim -- so a second attack
   * would be a boss kit rather than an answer to a problem.
   */
  it('out-turns a player circling at full speed, at every distance it can be fought at', () => {
    expect(WARDEN).not.toBeNull();
    if (!WARDEN) return;
    const lockOnRate = (WARDEN.stats.turnRate * Math.PI) / 180;
    // From touching it to the edge of what it notices.
    for (let radius = WARDEN.radius + 16; radius <= 420; radius += 20) {
      const playerRate = PLAYER_STATS.moveSpeed / radius;
      expect(playerRate, `at ${radius} units`).toBeLessThan(lockOnRate);
    }
  });

  it('comes round and fires at somebody who walked behind it', () => {
    // The behavioural half of the same claim, which the arithmetic above cannot
    // make: a player starting directly behind it is aimed at and hit.
    const { state, playerId, wardenId } = fight(260, 180);
    const aimed = advanceTo(state, wardenId, [playerId], WardenPhase.Firing).state;
    const fired = run(aimed, WARDEN_LASER.pulseIntervalTicks + 1, [playerId]);
    expect(pulseTicks(fired.frames, wardenId, playerId).length).toBeGreaterThan(0);
  });
});

/** A heading difference folded into `(-pi, pi]`. */
function angle(radians: number): number {
  let delta = radians % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta <= -Math.PI) delta += Math.PI * 2;
  return delta;
}

/** What one swing from `playerId` does to `victim`, through the real tick. */
function damageTo(state: ServerWorldState, victim: ServerEntity, playerId: number): number {
  const ctx = context();
  let current: ServerWorldState = state;
  const body = current.entities.get(playerId);
  if (!body) return 0;
  // Stood next to it so the swing reaches, and aimed by id like any other.
  const beside: ServerEntity = {
    ...body,
    position: { x: victim.position.x + 40, y: victim.position.y, z: 0 },
    facing: Math.PI,
  };
  current = { ...current, entities: new Map(current.entities).set(beside.id, beside) };
  let total = 0;
  for (let i = 0; i < 40; i++) {
    const now = current.entities.get(playerId);
    if (!now) break;
    const result = step(
      current,
      [
        {
          ...input(now, current.tick + 1),
          facing: Math.PI,
          castAbilityId: 'melee.slash',
          castTargetX: victim.position.x,
          castTargetY: victim.position.y,
          castTargetEntityId: victim.id,
        },
      ],
      ctx,
    );
    current = result.state;
    for (const event of result.events) {
      if (event.kind === 'hit' && event.attackerId === playerId) total += event.damage;
    }
    if (total > 0) break;
  }
  return total;
}
