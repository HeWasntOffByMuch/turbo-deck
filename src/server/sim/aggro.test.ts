/**
 * Spec 163. Four ways to meet a player.
 *
 * Every case here drives the real `step` with a real seeded world -- a blow is
 * an actual `melee.slash` through the actual cast pipeline, not a hand-written
 * `targetId`, because half of what is being asserted is what a *landed hit*
 * does to a mind and the other half is what proximity alone does without one.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { idlePlanOf, monsterById, noticeRangeOf } from '../data/monsters.js';
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
import { AggroValue, EntityKindValue, type ServerInput, type ServerWorldState } from './types.js';
import { createWorldState, LEASH_RADIUS, spawnEntity, step, type StepContext } from './world.js';

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
  currentZone: 'hearth',
  level: 1,
  experience: 0,
  unspentSkillPoints: 0,
  unspentAttributePoints: 0,
  health: 100,
  resource: 20,
};

const PLAYER_STATS: EffectiveStats = computeEffectiveStats(RECORD);
const CHUNK = 100;

/** Everything within a wide radius is active, so nothing is skipped by accident. */
function activeAround(...points: readonly { x: number; y: number }[]): Set<string> {
  const keys = new Set<string>();
  for (const point of points) {
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
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

function withPlayer(state: ServerWorldState, x: number, y: number) {
  const result = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x, y, z: 0 },
    stats: PLAYER_STATS,
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
  anchor?: { x: number; y: number },
  /** For the one case that needs a body to survive more blows than its row does. */
  stats?: Partial<EffectiveStats>,
) {
  const definition = monsterById(typeId);
  if (!definition) throw new Error(`no monster ${typeId}`);
  const merged = stats ? { ...definition.stats, ...stats } : definition.stats;
  const result = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId,
    position: { x, y, z: 0 },
    stats: merged,
    radius: definition.radius,
    zoneId: 'greenmarch',
    ...(anchor === undefined ? {} : { anchor }),
  });
  return { state: result.state, id: result.entity.id };
}

/**
 * The player walks at whatever is under `toward` for one tick.
 *
 * Separate from `run` because the flight tests are about what happens when the
 * thing chasing is *faster than its quarry*, which is every player: 155 against
 * the grazer's 40. Standing still is the case spec 163 already covers.
 */
function chase(
  state: ServerWorldState,
  playerId: number,
  towardId: number,
  seq: number,
  ctx: StepContext,
): ServerWorldState {
  const player = state.entities.get(playerId);
  const quarry = state.entities.get(towardId);
  if (!player || !quarry) throw new Error('gone');
  const dx = quarry.position.x - player.position.x;
  const dy = quarry.position.y - player.position.y;
  const length = Math.hypot(dx, dy) || 1;
  return step(
    state,
    [input(playerId, { seq, moveX: dx / length, moveY: dy / length, facing: Math.atan2(dy, dx) })],
    ctx,
  ).state;
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

/**
 * A real swing, run to the tick it lands on.
 *
 * The blow is what starts every retaliation rule in this file, so it goes
 * through `startCast`/`advanceCast` like a player's would rather than being
 * simulated by writing to the victim.
 */
function swing(
  state: ServerWorldState,
  attackerId: number,
  victimId: number,
  ctx: StepContext,
): { state: ServerWorldState; landed: boolean; ticks: number } {
  const victim = state.entities.get(victimId);
  const attacker = state.entities.get(attackerId);
  if (!victim || !attacker) throw new Error('nobody to swing at');
  const facing = Math.atan2(
    victim.position.y - attacker.position.y,
    victim.position.x - attacker.position.x,
  );
  let next = step(state, [
    input(attackerId, {
      facing,
      castAbilityId: 'melee.slash',
      castTargetX: victim.position.x,
      castTargetY: victim.position.y,
      castTargetEntityId: victimId,
    }),
  ], ctx);
  let landed = next.events.some((e) => e.kind === 'hit' && e.targetId === victimId);
  let ticks = 1;
  // The wind-up is half a second; give it a second and a half to arrive.
  while (!landed && ticks < SERVER_TICK_RATE * 1.5) {
    next = step(next.state, [input(attackerId, { seq: ticks + 1, facing })], ctx);
    landed = next.events.some((e) => e.kind === 'hit' && e.targetId === victimId);
    ticks += 1;
  }
  return { state: next.state, landed, ticks };
}

function run(state: ServerWorldState, ticks: number, ctx: StepContext): ServerWorldState {
  let next = state;
  for (let i = 0; i < ticks; i++) next = step(next, [], ctx).state;
  return next;
}

function distance(state: ServerWorldState, a: number, b: number): number {
  const one = state.entities.get(a);
  const two = state.entities.get(b);
  if (!one || !two) throw new Error('gone');
  return Math.hypot(one.position.x - two.position.x, one.position.y - two.position.y);
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

describe('skittish: it runs', () => {
  it('answers a blow by leaving, and never swings back', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const grazer = withMonster(state, 'grazer', 640, 450, { x: 640, y: 450 });
    state = grazer.state;
    const ctx = context();

    const hit = swing(state, player.id, grazer.id, ctx);
    expect(hit.landed).toBe(true);
    state = hit.state;
    expect(state.entities.get(grazer.id)?.aggro).toBe(AggroValue.Fleeing);

    // It gets further away every single tick of the flight, and lands nothing
    // however long the player stands there.
    let previous = distance(state, player.id, grazer.id);
    for (let tick = 0; tick < SERVER_TICK_RATE * 2; tick++) {
      const result = step(state, [], ctx);
      state = result.state;
      expect(result.events.some((e) => e.kind === 'hit' && e.attackerId === grazer.id)).toBe(false);
      const now = distance(state, player.id, grazer.id);
      expect(now).toBeGreaterThan(previous);
      previous = now;
    }
  });

  it('keeps its heading while a faster pursuer runs straight through it', () => {
    // The bug spec 213 exists for. The heading used to be re-derived every tick
    // from where the attacker was *now*, which is stable only while the attacker
    // is slower than its quarry -- and no player is. A player at 155 closing on
    // a grazer at 40 overshoots through it every frame, so the away vector
    // flipped sign at 60Hz: the velocity alternated +40, -40, +40, -40 and the
    // body oscillated between two coordinates two thirds of a unit apart for the
    // rest of its flight, holding its target and its `Fleeing` state throughout.
    const anchor = { x: 640, y: 450 };
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const grazer = withMonster(state, 'grazer', anchor.x, anchor.y, anchor);
    state = grazer.state;
    const ctx = context();

    const hit = swing(state, player.id, grazer.id, ctx);
    expect(hit.landed).toBe(true);
    state = hit.state;

    const row = monsterById('grazer');
    if (row?.temperament.kind !== 'skittish') throw new Error('the grazer stopped being skittish');

    let previous: { x: number; y: number } | null = null;
    let seq = 100;
    for (let tick = 0; tick < row.temperament.fleeTicks - 4; tick++) {
      state = chase(state, player.id, grazer.id, seq++, ctx);
      const now = state.entities.get(grazer.id);
      if (!now) throw new Error('the grazer left the world');
      expect(now.aggro).toBe(AggroValue.Fleeing);
      // The measurement that fails on the old code and only on the old code: a
      // body running away does not reverse between one tick and the next.
      if (previous) expect(previous.x * now.velocity.x + previous.y * now.velocity.y).toBeGreaterThan(0);
      previous = { x: now.velocity.x, y: now.velocity.y };
    }

    // And it actually got somewhere. Its own speed over the flight is the bound;
    // half of it is well clear of the 0.67 units the oscillation covered.
    const away = Math.hypot(
      (state.entities.get(grazer.id)?.position.x ?? 0) - anchor.x,
      (state.entities.get(grazer.id)?.position.y ?? 0) - anchor.y,
    );
    const flight = ((row.temperament.fleeTicks - 4) / SERVER_TICK_RATE) * row.stats.moveSpeed;
    expect(away).toBeGreaterThan(flight * 0.5);
  });

  it('commits the goal it bolted for, and a fresh blow re-aims it', () => {
    // Tough enough to take two blows, which no grazer's row is: what is being
    // asserted is that the *second* one moves the goal and that nothing else
    // does.
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const grazer = withMonster(state, 'grazer', 640, 450, { x: 640, y: 450 }, { maxHealth: 400 });
    state = grazer.state;
    const ctx = context();

    state = swing(state, player.id, grazer.id, ctx).state;
    const bolted = state.entities.get(grazer.id)?.fleeGoal;
    if (!bolted) throw new Error('a flight with no goal');
    // Struck from the west, so it is headed east.
    expect(bolted.x).toBeGreaterThan(640);

    // Held, tick after tick, while the player weaves around it.
    let seq = 200;
    for (let tick = 0; tick < 30; tick++) {
      state = chase(state, player.id, grazer.id, seq++, ctx);
      expect(state.entities.get(grazer.id)?.fleeGoal).toEqual(bolted);
    }

    // Now hit it from the east instead. The flight is re-aimed on the blow and
    // on nothing else, so this is the one thing that moves it.
    const grz = state.entities.get(grazer.id);
    if (!grz) throw new Error('gone');
    const ambusher = withPlayer(state, grz.position.x + 40, grz.position.y);
    state = ambusher.state;
    state = swing(state, ambusher.id, grazer.id, ctx).state;
    const reaimed = state.entities.get(grazer.id)?.fleeGoal;
    if (!reaimed) throw new Error('a flight with no goal');
    expect(reaimed).not.toEqual(bolted);
    expect(reaimed.x).toBeLessThan(state.entities.get(grazer.id)?.position.x ?? 0);
  });

  it('carries no flee goal once it is calm again', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const grazer = withMonster(state, 'grazer', 640, 450, { x: 640, y: 450 });
    state = grazer.state;
    const ctx = context();
    expect(state.entities.get(grazer.id)?.fleeGoal).toBeNull();

    state = swing(state, player.id, grazer.id, ctx).state;
    expect(state.entities.get(grazer.id)?.fleeGoal).not.toBeNull();

    const row = monsterById('grazer');
    if (row?.temperament.kind !== 'skittish') throw new Error('the grazer stopped being skittish');
    state = run(state, row.temperament.fleeTicks + 2, ctx);
    expect(state.entities.get(grazer.id)?.aggro).toBe(AggroValue.Calm);
    expect(state.entities.get(grazer.id)?.fleeGoal).toBeNull();
  });

  it('stops running when its clock runs out, and turns for home', () => {
    // Struck a long way from where it lives, which is what makes the homecoming
    // half of this observable at all: since spec 213 widened the roam, a body
    // startled *on its own ground* is still on its own ground when the clock
    // runs out -- its 200-unit ring is twice the ~100 units a 2.5s flight at 40
    // covers -- so there would be nothing to walk back from.
    const anchor = { x: 240, y: 450 };
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const grazer = withMonster(state, 'grazer', 640, 450, anchor);
    state = grazer.state;
    const ctx = context();

    const hit = swing(state, player.id, grazer.id, ctx);
    state = hit.state;
    const row = monsterById('grazer');
    if (row?.temperament.kind !== 'skittish') throw new Error('the grazer stopped being skittish');

    // One tick short of the clock it is still running, and it has not stopped
    // holding the thing it is running from.
    state = run(state, row.temperament.fleeTicks - 2, ctx);
    expect(state.entities.get(grazer.id)?.aggro).toBe(AggroValue.Fleeing);
    expect(state.entities.get(grazer.id)?.targetId).toBe(player.id);

    // Past it, it is calm and holds nobody...
    state = run(state, 4, ctx);
    expect(state.entities.get(grazer.id)?.aggro).toBe(AggroValue.Calm);
    expect(state.entities.get(grazer.id)?.targetId).toBeNull();

    // ...and walks back to where it was grazing.
    const far = Math.hypot(
      (state.entities.get(grazer.id)?.position.x ?? 0) - anchor.x,
      (state.entities.get(grazer.id)?.position.y ?? 0) - anchor.y,
    );
    state = run(state, SERVER_TICK_RATE * 30, ctx);
    const near = Math.hypot(
      (state.entities.get(grazer.id)?.position.x ?? 0) - anchor.x,
      (state.entities.get(grazer.id)?.position.y ?? 0) - anchor.y,
    );
    expect(near).toBeLessThan(far);
    // Back on its own ground rather than back on its exact spawn coordinate:
    // since spec 213 a body that has come home mills about it, so what "home"
    // means is the wander ring plus the body's own reach.
    const plan = idlePlanOf('grazer');
    expect(near).toBeLessThanOrEqual(
      (plan.kind === 'sentinel' ? 0 : plan.radius) + (monsterById('grazer')?.radius ?? 0),
    );
  });

  it('is not dropped by the leash while it is still running', () => {
    // Anchored on the spot and hit, so the flight itself is what carries it out
    // past the leash -- which is the one case the leash must not answer, or the
    // body turns round at the boundary and walks home through its attacker.
    const anchor = { x: 600, y: 450 };
    let state = createWorldState(1);
    const player = withPlayer(state, anchor.x - 40, anchor.y);
    state = player.state;
    const grazer = withMonster(state, 'grazer', anchor.x, anchor.y, anchor);
    state = grazer.state;
    const along: { x: number; y: number }[] = [];
    for (let x = anchor.x - 200; x <= anchor.x + LEASH_RADIUS + 600; x += 100) {
      along.push({ x, y: anchor.y });
    }
    const ctx = context({ activeChunks: activeAround(...along) });

    state = swing(state, player.id, grazer.id, ctx).state;
    // Kept fleeing every tick of the clock, at a move speed that carries it well
    // past 800 units -- so if the leash were consulted it would have fired.
    const row = monsterById('grazer');
    if (row?.temperament.kind !== 'skittish') throw new Error('the grazer stopped being skittish');
    for (let tick = 0; tick < row.temperament.fleeTicks - 2; tick++) {
      state = step(state, [], ctx).state;
      expect(state.entities.get(grazer.id)?.aggro).toBe(AggroValue.Fleeing);
    }
  });
});

describe('defensive: it fights back, and starts nothing', () => {
  it('ignores a player standing on top of it', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const ravager = withMonster(state, 'ravager', 640, 450);
    state = ravager.state;
    const ctx = context();

    for (let tick = 0; tick < SERVER_TICK_RATE * 10; tick++) {
      const result = step(state, [], ctx);
      state = result.state;
      expect(result.events.some((e) => e.kind === 'hit')).toBe(false);
    }
    expect(state.entities.get(ravager.id)?.targetId).toBeNull();
    expect(state.entities.get(ravager.id)?.aggro).toBe(AggroValue.Calm);
    expect(state.entities.get(ravager.id)?.position.x).toBe(640);
  });

  it('is engaged on the tick it is hit', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const ravager = withMonster(state, 'ravager', 640, 450);
    state = ravager.state;
    const ctx = context();

    const hit = swing(state, player.id, ravager.id, ctx);
    expect(hit.landed).toBe(true);
    state = hit.state;
    expect(state.entities.get(ravager.id)?.aggro).toBe(AggroValue.Engaged);
    expect(state.entities.get(ravager.id)?.targetId).toBe(player.id);
  });
});

describe('territorial: it looks first', () => {
  it('holds its alert for exactly the authored length, then commits', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Inside the stalker's notice range and well outside its reach, so the only
    // thing that can be measured is the alert itself.
    const stalker = withMonster(state, 'stalker', 850, 450);
    state = stalker.state;
    const ctx = context({ activeChunks: activeAround({ x: 600, y: 450 }, { x: 850, y: 450 }) });
    const row = monsterById('stalker');
    if (row?.temperament.kind !== 'territorial') throw new Error('the stalker stopped watching');

    // Tick 0 notices, and the alert is stamped from there.
    const first = step(state, [], ctx);
    state = first.state;
    const watching = state.entities.get(stalker.id);
    expect(watching?.aggro).toBe(AggroValue.Alert);
    expect(watching?.targetId).toBe(player.id);

    const stoodAt = watching?.position.x ?? 0;
    // It does not take a step and it does not swing, for the whole alert -- and
    // it turns toward the player and never away, which is the only part of this
    // the client ever sees. The turn is rate-limited like every other (spec
    // 065), so it *arrives* at the player rather than snapping to them: what is
    // asserted per tick is that the gap never grows.
    let gap = Math.PI;
    for (let tick = 0; tick < row.temperament.alertTicks - 1; tick++) {
      state = step(state, [], ctx).state;
      const body = state.entities.get(stalker.id);
      expect(body?.aggro).toBe(AggroValue.Alert);
      expect(body?.position.x).toBe(stoodAt);
      expect(body?.cast).toBeNull();
      // The stalker is east of the player, so it should end up looking west.
      const now = Math.abs(Math.abs(body?.facing ?? 0) - Math.PI);
      expect(now).toBeLessThanOrEqual(gap + 1e-9);
      gap = now;
    }
    // And a second is long enough to have got there, which is what makes the
    // alert readable rather than merely a pause.
    expect(gap).toBeLessThan(1e-6);

    // And then it comes.
    state = step(state, [], ctx).state;
    expect(state.entities.get(stalker.id)?.aggro).toBe(AggroValue.Engaged);
    state = run(state, SERVER_TICK_RATE, ctx);
    expect(state.entities.get(stalker.id)?.position.x).toBeLessThan(stoodAt);
  });

  it('lets a player who backs out of the alert go', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const range = noticeRangeOf(monsterById('stalker')?.temperament ?? { kind: 'defensive' });
    // Just inside the boundary, so one step of walking away crosses it.
    const stalker = withMonster(state, 'stalker', 600 + range - 20, 450);
    state = stalker.state;
    const ctx = context({
      activeChunks: activeAround({ x: 600, y: 450 }, { x: 600 + range, y: 450 }),
    });

    state = step(state, [], ctx).state;
    expect(state.entities.get(stalker.id)?.aggro).toBe(AggroValue.Alert);

    // The player runs west, out of range, well before the alert would expire.
    let seq = 1;
    for (let tick = 0; tick < 20; tick++) {
      seq += 1;
      state = step(state, [input(player.id, { seq, moveX: -1, moveY: 0, facing: Math.PI })], ctx).state;
    }
    expect(distance(state, player.id, stalker.id)).toBeGreaterThan(range);
    const body = state.entities.get(stalker.id);
    expect(body?.aggro).toBe(AggroValue.Calm);
    expect(body?.targetId).toBeNull();
  });

  it('has finished sizing you up the moment you hit it', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    // Close enough to swing at, and still well inside the alert's length.
    const stalker = withMonster(state, 'stalker', 660, 450);
    state = stalker.state;
    const ctx = context();

    state = step(state, [], ctx).state;
    expect(state.entities.get(stalker.id)?.aggro).toBe(AggroValue.Alert);

    const hit = swing(state, player.id, stalker.id, ctx);
    expect(hit.landed).toBe(true);
    const row = monsterById('stalker');
    if (row?.temperament.kind !== 'territorial') throw new Error('the stalker stopped watching');
    // The blow arrived inside the alert window, and ended it anyway.
    expect(hit.ticks).toBeLessThan(row.temperament.alertTicks);
    expect(hit.state.entities.get(stalker.id)?.aggro).toBe(AggroValue.Engaged);
  });
});

describe('ferocious: it needs no invitation', () => {
  it('attacks a player who never touched it', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const spider = withMonster(state, 'small_spider', 850, 450);
    state = spider.state;
    const ctx = context({ activeChunks: activeAround({ x: 600, y: 450 }, { x: 850, y: 450 }) });

    // Engaged on the first tick it can see anybody -- no alert, no provocation.
    state = step(state, [], ctx).state;
    expect(state.entities.get(spider.id)?.aggro).toBe(AggroValue.Engaged);
    expect(state.entities.get(spider.id)?.targetId).toBe(player.id);

    let bit = false;
    for (let tick = 0; tick < SERVER_TICK_RATE * 8 && !bit; tick++) {
      const result = step(state, [], ctx);
      state = result.state;
      bit = result.events.some((e) => e.kind === 'hit' && e.attackerId === spider.id);
    }
    expect(bit).toBe(true);
  });

  it('stays calm with nobody in range', () => {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const spider = withMonster(state, 'small_spider', 1400, 450);
    state = spider.state;
    const ctx = context({ activeChunks: activeAround({ x: 600, y: 450 }, { x: 1400, y: 450 }) });

    state = run(state, SERVER_TICK_RATE * 3, ctx);
    expect(state.entities.get(spider.id)?.aggro).toBe(AggroValue.Calm);
    expect(state.entities.get(spider.id)?.position.x).toBe(1400);
  });
});

describe('the herd answers', () => {
  /**
   * A nest laid out on one axis, with the player far enough west that nothing
   * notices anybody on its own. Every aggro in this block therefore has exactly
   * one cause -- the blow -- and the spiders' own 300-unit sight is not it.
   */
  function nest() {
    let state = createWorldState(1);
    const player = withPlayer(state, 600, 450);
    state = player.state;
    const victim = withMonster(state, 'small_spider', 2000, 450);
    state = victim.state;
    // 200 out: inside the 260 it assists at.
    const near = withMonster(state, 'small_spider', 2200, 450);
    state = near.state;
    // 400 out: past it.
    const far = withMonster(state, 'small_spider', 2400, 450);
    state = far.state;
    // Right beside the victim, and not the sort of body that answers anything.
    const bystander = withMonster(state, 'grazer', 2040, 450);
    state = bystander.state;

    const points = [{ x: 600, y: 450 }];
    for (let x = 1900; x <= 2500; x += 100) points.push({ x, y: 450 });
    return {
      state,
      player: player.id,
      victim: victim.id,
      near: near.id,
      far: far.id,
      bystander: bystander.id,
      ctx: context({ activeChunks: activeAround(...points) }),
    };
  }

  it('brings the neighbours inside the call and nobody outside it', () => {
    const world = nest();
    // The player is teleported in beside the victim rather than walking there,
    // so the only tick anything could have noticed on is the one the blow is on.
    let state = world.state;
    const player = state.entities.get(world.player);
    if (!player) throw new Error('no player');
    state = {
      ...state,
      entities: new Map(state.entities).set(world.player, {
        ...player,
        position: { x: 1950, y: 450, z: 0 },
      }),
    };

    const hit = swing(state, world.player, world.victim, world.ctx);
    expect(hit.landed).toBe(true);
    state = hit.state;

    // The one that was hit, and the one standing next to it, are both on the
    // player. The far one and the grazer are not.
    expect(state.entities.get(world.victim)?.aggro).toBe(AggroValue.Engaged);
    expect(state.entities.get(world.near)?.aggro).toBe(AggroValue.Engaged);
    expect(state.entities.get(world.near)?.targetId).toBe(world.player);
    expect(state.entities.get(world.far)?.aggro).toBe(AggroValue.Calm);
    expect(state.entities.get(world.far)?.targetId).toBeNull();
    // Answering is a temperament, not a proximity: the grazer is 40 units from
    // the body that got hit and does not care.
    expect(state.entities.get(world.bystander)?.aggro).toBe(AggroValue.Calm);
  });

  it('does not carry past one hop', () => {
    // The far spider is 200 units from the near one -- inside *its* assist
    // range. If a rallied body raised a call of its own it would be engaged
    // here, on the tick after the blow, having never been touched.
    const world = nest();
    let state = world.state;
    const player = state.entities.get(world.player);
    if (!player) throw new Error('no player');
    state = {
      ...state,
      entities: new Map(state.entities).set(world.player, {
        ...player,
        position: { x: 1950, y: 450, z: 0 },
      }),
    };
    state = swing(state, world.player, world.victim, world.ctx).state;
    state = step(state, [], world.ctx).state;
    expect(state.entities.get(world.far)?.aggro).toBe(AggroValue.Calm);
  });
});

describe('determinism', () => {
  it('replays a seed and an input sequence to bit-identical state, with all four temperaments', () => {
    const play = (): ServerWorldState => {
      let state = createWorldState(7);
      const player = withPlayer(state, 600, 450);
      state = player.state;
      for (const [typeId, x] of [
        ['grazer', 700],
        ['ravager', 760],
        ['stalker', 820],
        ['small_spider', 880],
      ] as const) {
        state = withMonster(state, typeId, x, 450, { x, y: 450 }).state;
      }
      const ctx = context({
        activeChunks: activeAround({ x: 600, y: 450 }, { x: 900, y: 450 }, { x: 1200, y: 450 }),
      });

      for (let tick = 0; tick < SERVER_TICK_RATE * 6; tick++) {
        // A swing every half second, into the crowd, with a walk in between --
        // enough for every temperament to fire and for the herd to answer.
        const swinging = tick % 30 === 0;
        state = step(
          state,
          [
            input(player.id, {
              seq: tick + 1,
              moveX: swinging ? 0 : 1,
              facing: 0,
              castAbilityId: swinging ? 'melee.slash' : '',
              castTargetX: 900,
              castTargetY: 450,
            }),
          ],
          ctx,
        ).state;
      }
      return state;
    };

    expect(snapshot(play())).toBe(snapshot(play()));
  });
});
