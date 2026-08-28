/**
 * Spec 248. The walk home is not a fight.
 *
 * Everything here goes through the real `step` unless the claim is arithmetic
 * that a whole tick would only obscure. A blow is an actual `melee.slash`
 * through the actual cast pipeline, because "it cannot be hit" is a statement
 * about `isHostile` reaching every damage path and not about one predicate
 * answering false.
 *
 * The one thing every case needs is a body that survives long enough to be
 * dragged anywhere, so the monsters here are given a health pool their rows do
 * not have. That is a fixture, not a balance opinion: at 10 health a stalker
 * dies to the first blow of the pull and there is no walk home to test.
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
import { goHome, isReturning, rally } from './aggro.js';
import { applyDot } from './damage-over-time.js';
import { HOME_MARGIN, homeRadiusOf, idle } from './idle.js';
import { StatusId } from './statuses.js';
import {
  AggroValue,
  EntityKindValue,
  type ServerEntity,
  type ServerInput,
  type ServerWorldState,
} from './types.js';
import {
  createWorldState,
  isHostile,
  LEASH_RADIUS,
  replaceEntity,
  spawnEntity,
  step,
  type StepContext,
} from './world.js';

const RECORD: PersistedPlayer = {
  id: 'p1',
  displayName: 'P1',
  baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
  specializations: [],
  equipment: EMPTY_EQUIPMENT,
  inventory: emptyInventory(),
  coins: 0,
  position: { x: 600, y: 450, z: 0 },
  facing: 0,
  currentZone: 'hearth',
  level: 1,
  experience: 0,
  unspentProgressionPoints: 0,
  health: 100,
  resource: 20,
};

const PLAYER_STATS: EffectiveStats = computeEffectiveStats(RECORD);
const CHUNK = 100;
const ANCHOR = { x: 600, y: 450 };

/** Where the walk home stops, for a body of this type. */
function arrivalRadius(typeId: string): number {
  return homeRadiusOf(idlePlanOf(typeId)) + HOME_MARGIN;
}

function driftOf(body: ServerEntity): number {
  return Math.hypot(body.position.x - ANCHOR.x, body.position.y - ANCHOR.y);
}

/**
 * Every chunk between home and wherever the player is standing.
 *
 * Wide, because a body walks the whole length of its leash and back and a chunk
 * that is not simulated is a body that stops mid-story for a reason that has
 * nothing to do with what is being asserted.
 */
function activeAround(...points: readonly { x: number; y: number }[]): Set<string> {
  const keys = new Set<string>();
  for (const point of points) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        keys.add(chunkKeyOf(point.x + dx * CHUNK, point.y + dy * CHUNK, CHUNK));
      }
    }
  }
  return keys;
}

function corridor(toX: number): Set<string> {
  const along: { x: number; y: number }[] = [];
  for (let x = ANCHOR.x - 300; x <= toX + 300; x += CHUNK) along.push({ x, y: ANCHOR.y });
  return activeAround(...along);
}

function context(overrides: Partial<StepContext> = {}): StepContext {
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: DEFAULT_LIVE_CONFIG,
    activeChunks: activeAround(ANCHOR),
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
  extra: {
    anchor?: { x: number; y: number } | null;
    targetId?: number;
    stats?: Partial<EffectiveStats>;
  } = {},
) {
  const definition = monsterById(typeId);
  if (!definition) throw new Error(`no monster ${typeId}`);
  const anchor = extra.anchor === undefined ? ANCHOR : extra.anchor;
  const result = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId,
    position: { x, y, z: 0 },
    stats: { ...definition.stats, ...extra.stats },
    radius: definition.radius,
    zoneId: 'greenmarch',
    ...(anchor === null ? {} : { anchor }),
    ...(extra.targetId === undefined ? {} : { targetId: extra.targetId }),
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

function at(state: ServerWorldState, id: number): ServerEntity {
  const body = state.entities.get(id);
  if (!body) throw new Error(`entity ${id} is gone`);
  return body;
}

/** Steps until `done`, or throws -- a silent timeout reads as a passing case. */
function until(
  state: ServerWorldState,
  ctx: StepContext,
  seconds: number,
  done: (state: ServerWorldState) => boolean,
  what: string,
): ServerWorldState {
  let next = state;
  for (let tick = 0; tick < SERVER_TICK_RATE * seconds; tick++) {
    if (done(next)) return next;
    next = step(next, [], ctx).state;
  }
  if (!done(next)) throw new Error(`never ${what}`);
  return next;
}

/**
 * A real swing, run to the tick it would land on.
 *
 * Reports whether a `hit` event came back rather than asserting one, because
 * half the cases here are about a swing that resolves against nothing.
 */
function swing(
  state: ServerWorldState,
  attackerId: number,
  victimId: number,
  ctx: StepContext,
): { state: ServerWorldState; landed: boolean } {
  const victim = at(state, victimId);
  const attacker = at(state, attackerId);
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
  for (let tick = 1; !landed && tick < SERVER_TICK_RATE * 1.5; tick++) {
    next = step(next.state, [input(attackerId, { seq: tick + 1, facing })], ctx);
    landed = next.events.some((e) => e.kind === 'hit' && e.targetId === victimId);
  }
  return { state: next.state, landed };
}

/**
 * A body dragged out past its leash and released, by the shortest honest route:
 * a real chase, driven by the real leash, at a player standing out of reach.
 */
function pulled(
  typeId: string,
  options: { hurtTo?: number; playerAt?: number; startAt?: number } = {},
): { state: ServerWorldState; monster: number; player: number; ctx: StepContext } {
  const startAt = options.startAt ?? 0;
  const playerX = ANCHOR.x + (options.playerAt ?? Math.max(startAt, LEASH_RADIUS) + 300);
  const ctx = context({ activeChunks: corridor(playerX) });
  let state = createWorldState(1);
  const player = withPlayer(state, playerX, ANCHOR.y);
  state = player.state;
  // `startAt` drops the body straight out at a distance rather than making it
  // walk there, which is what a flight that ended past the leash leaves behind
  // -- and the only way to get a body far enough out to spend real time outside
  // its own leash on the way back.
  const monster = withMonster(state, typeId, ANCHOR.x + startAt, ANCHOR.y, {
    targetId: player.id,
    stats: { maxHealth: 400 },
  });
  state = monster.state;
  if (options.hurtTo !== undefined) {
    state = replaceEntity(state, { ...at(state, monster.id), health: options.hurtTo });
  }
  state = until(
    state,
    ctx,
    40,
    (s) => isReturning(at(s, monster.id)),
    'broke its leash',
  );
  return { state, monster: monster.id, player: player.id, ctx };
}

describe('breaking the leash starts a walk home', () => {
  it('gives up, on the tick the leash lets go', () => {
    const { state, monster } = pulled('stalker');
    const body = at(state, monster);
    expect(body.aggro).toBe(AggroValue.Returning);
    expect(body.targetId).toBeNull();
    expect(body.returnStart).not.toBeNull();
    // Measured where it gave up, which is the far side of its own leash.
    expect(body.returnStart?.distance).toBeGreaterThan(LEASH_RADIUS);
    expect(body.returnStart?.health).toBe(body.health);
  });

  it('walks home and stops being one, at full health', () => {
    const { state, monster, ctx } = pulled('stalker', { hurtTo: 40 });
    const arrival = arrivalRadius('stalker');
    const home = until(
      state,
      ctx,
      60,
      (s) => !isReturning(at(s, monster)),
      'got home',
    );
    const body = at(home, monster);
    expect(driftOf(body)).toBeLessThanOrEqual(arrival);
    expect(body.health).toBe(body.stats.maxHealth);
    expect(body.aggro).toBe(AggroValue.Calm);
    expect(body.returnStart).toBeNull();
  });

  it('is a legal target again once it is home', () => {
    const { state, monster, player, ctx } = pulled('stalker', { hurtTo: 40 });
    expect(isHostile(at(state, player), at(state, monster), ctx.zones)).toBe(false);
    const home = until(state, ctx, 60, (s) => !isReturning(at(s, monster)), 'got home');
    expect(isHostile(at(home, player), at(home, monster), ctx.zones)).toBe(true);
  });

  it('never returns without an anchor, so a conjured body is untouched', () => {
    const ctx = context({ activeChunks: corridor(ANCHOR.x + 4000) });
    let state = createWorldState(1);
    const player = withPlayer(state, ANCHOR.x + 4000, ANCHOR.y);
    state = player.state;
    const monster = withMonster(state, 'stalker', ANCHOR.x, ANCHOR.y, {
      anchor: null,
      targetId: player.id,
      stats: { maxHealth: 400 },
    });
    state = monster.state;
    for (let tick = 0; tick < SERVER_TICK_RATE * 10; tick++) {
      state = step(state, [], ctx).state;
      expect(isReturning(at(state, monster.id))).toBe(false);
    }
    // The control: it is still chasing, so what was measured was a body with
    // every reason to have gone home and no home to go to.
    expect(at(state, monster.id).targetId).toBe(player.id);
    expect(driftOf(at(state, monster.id))).toBeGreaterThan(LEASH_RADIUS);
  });
});

describe('a walk home is not talked out of', () => {
  /**
   * The regression this spec exists for. Before it the leash dropped the target
   * and `notice` handed it straight back two lines later, so a ferocious body
   * kited past its leash with the player still standing there never took a step
   * homeward at all.
   */
  it('does not re-notice the player who dragged it out', () => {
    const spider = monsterById('small_spider');
    if (!spider) throw new Error('no small_spider');
    const range = noticeRangeOf(spider.temperament);
    expect(range).toBeGreaterThan(0);

    // The player stands just inside the body's own notice range, out past the
    // leash: the exact position that used to make it oscillate forever.
    const { state, monster, ctx } = pulled('small_spider', {
      playerAt: LEASH_RADIUS + range - 40,
    });
    const walked = until(state, ctx, 60, (s) => !isReturning(at(s, monster)), 'got home');
    expect(at(walked, monster).targetId).toBeNull();
    expect(driftOf(at(walked, monster))).toBeLessThanOrEqual(arrivalRadius('small_spider'));
  });

  it('but the same body inside its leash does engage -- the control', () => {
    const ctx = context();
    let state = createWorldState(1);
    const player = withPlayer(state, ANCHOR.x + 200, ANCHOR.y);
    state = player.state;
    const monster = withMonster(state, 'small_spider', ANCHOR.x, ANCHOR.y);
    state = monster.state;
    state = until(
      state,
      ctx,
      5,
      (s) => at(s, monster.id).targetId === player.id,
      'noticed the player',
    );
    expect(at(state, monster.id).aggro).toBe(AggroValue.Engaged);
  });

  /**
   * Asserted against `rally` itself rather than through a `step`, and that is
   * forced rather than a shortcut: `assistRange` is shorter than `noticeRange`
   * for every ferocious row, so anything standing close enough to a victim to be
   * rallied is also standing close enough to the attacker to have noticed them
   * unaided. End to end the two guards cannot be told apart. Here the control is
   * exact -- the same body, in the same place, differing only in whether it is
   * walking home.
   */
  it('is not rallied by a neighbour being hit', () => {
    const { state, monster, player } = pulled('small_spider');
    const returning = at(state, monster);
    expect(isReturning(returning)).toBe(true);

    // A neighbour to be hurt, a body's length away -- well inside the assist
    // range a nest answers over.
    const withVictim = withMonster(
      state,
      'small_spider',
      returning.position.x + 40,
      returning.position.y,
      { anchor: { x: returning.position.x + 40, y: returning.position.y } },
    );
    const victim = at(withVictim.state, withVictim.id);
    const spider = monsterById('small_spider');
    if (spider?.temperament.kind !== 'ferocious') throw new Error('not ferocious any more');
    expect(Math.hypot(victim.position.x - returning.position.x, 0)).toBeLessThan(
      spider.temperament.assistRange,
    );

    const shout = [
      {
        kind: 'hit' as const,
        attackerId: player,
        targetId: withVictim.id,
        damage: 3,
        targetHealth: victim.health - 3,
        killed: false,
        critical: false,
        blocked: false,
        weakPoint: false,
      },
    ];
    expect(rally(shout, withVictim.state.entities).has(monster)).toBe(false);

    // The control. The same spider, in the same place, calm rather than walking
    // home -- and the call reaches it. Without this the case above passes for a
    // `rally` that has stopped working at all.
    const calmed = new Map(withVictim.state.entities);
    calmed.set(monster, { ...returning, aggro: AggroValue.Calm, returnStart: null });
    expect(rally(shout, calmed).get(monster)?.targetId).toBe(player);
  });
});

describe('a walk home cannot be hit', () => {
  it('refuses a swing, at both ends', () => {
    const { state, monster, player, ctx } = pulled('stalker', { hurtTo: 40 });
    expect(isHostile(at(state, player), at(state, monster), ctx.zones)).toBe(false);
    expect(isHostile(at(state, monster), at(state, player), ctx.zones)).toBe(false);

    const before = at(state, monster).health;
    const struck = swing(state, player, monster, ctx);
    expect(struck.landed).toBe(false);
    // Not merely "no worse": it kept healing right through being swung at.
    expect(at(struck.state, monster).health).toBeGreaterThan(before);
  });

  it('refuses an affliction already burning on it when the leash broke', () => {
    const { state, monster, player, ctx } = pulled('stalker', { hurtTo: 40 });
    const burning = replaceEntity(
      state,
      applyDot(at(state, monster), StatusId.Burn, state.tick, at(state, player)),
    );
    let next = burning;
    let health = at(next, monster).health;
    for (let tick = 0; tick < SERVER_TICK_RATE * 3; tick++) {
      next = step(next, [], ctx).state;
      const now = at(next, monster).health;
      // Every tick, not just the last: a pulse that landed and was healed back
      // over would be invisible to an end-to-end comparison.
      expect(now).toBeGreaterThanOrEqual(health);
      health = now;
    }
    // The control -- the affliction really was on it the whole way.
    expect(at(next, monster).statuses[StatusId.Burn]).toBeDefined();
  });
});

describe('the ramp home', () => {
  it('is full on arrival however little it had left', () => {
    const { state, monster, ctx } = pulled('stalker', { hurtTo: 1 });
    expect(at(state, monster).health).toBe(1);
    const home = until(state, ctx, 60, (s) => !isReturning(at(s, monster)), 'got home');
    expect(at(home, monster).health).toBe(at(home, monster).stats.maxHealth);
  });

  it('climbs with the ground it closes, and never faster than the walk', () => {
    const { state, monster, ctx } = pulled('stalker', { hurtTo: 40 });
    const start = at(state, monster).returnStart;
    if (!start) throw new Error('not returning');
    const max = at(state, monster).stats.maxHealth;
    const arrival = arrivalRadius('stalker');

    let next = state;
    let health = at(next, monster).health;
    let sawPartial = false;
    for (let tick = 0; tick < SERVER_TICK_RATE * 60; tick++) {
      // Measured *before* the step: a tick decides what a body is owed from
      // where it is standing and then moves it, so the health that comes out is
      // the ramp read at the drift that went in.
      const decidedAt = driftOf(at(next, monster));
      next = step(next, [], ctx).state;
      const body = at(next, monster);
      if (!isReturning(body)) break;
      expect(body.health).toBeGreaterThanOrEqual(health);
      // The ramp is a floor on health and a line in *ground closed*, so what is
      // owed at any moment is exactly readable off the distance left.
      const span = start.distance - arrival;
      const progress = Math.min(1, Math.max(0, (start.distance - decidedAt) / span));
      expect(body.health).toBeCloseTo(start.health + (max - start.health) * progress, 6);
      if (body.health > start.health && body.health < max) sawPartial = true;
      health = body.health;
    }
    // Without this the case above passes for a body that snapped to full on the
    // first tick and one that healed nothing until it arrived.
    expect(sawPartial).toBe(true);
  });

  /**
   * Straight-line distance is not the route, so a body going round a rock or
   * shoved outward by the crowd closes less ground this tick than last. A bare
   * lerp would take health back off a body that cannot be hurt.
   */
  it('does not run downhill when the body is pushed away from home', () => {
    // Driven through `idle` directly rather than through a tick, because what is
    // being asserted is a position the sim will not produce on demand: a body
    // that closed ground and then lost some of it again.
    let state = createWorldState(1);
    const spawned = withMonster(state, 'stalker', ANCHOR.x + 1000, ANCHOR.y, {
      stats: { maxHealth: 400 },
    });
    state = spawned.state;
    const out = goHome({ ...at(state, spawned.id), health: 40 });
    expect(out.returnStart).toEqual({ distance: 1000, health: 40 });

    const closer = idle({ ...out, position: { x: ANCHOR.x + 500, y: ANCHOR.y, z: 0 } }, 0).entity;
    expect(closer.health).toBeGreaterThan(40);

    const shoved = idle(
      { ...closer, position: { x: ANCHOR.x + 900, y: ANCHOR.y, z: 0 } },
      0,
    ).entity;
    expect(shoved.health).toBe(closer.health);
  });
});

describe('the state and its span are one thing', () => {
  it('are set and cleared together, all the way home', () => {
    const { state, monster, ctx } = pulled('stalker', { hurtTo: 40 });
    let next = state;
    for (let tick = 0; tick < SERVER_TICK_RATE * 60; tick++) {
      const body = at(next, monster);
      expect(isReturning(body)).toBe(body.returnStart !== null);
      if (isReturning(body)) expect(body.targetId).toBeNull();
      if (!isReturning(body) && body.health === body.stats.maxHealth) break;
      next = step(next, [], ctx).state;
    }
    expect(at(next, monster).returnStart).toBeNull();
  });

  /**
   * `monsterIntent` asks `goHome` on **every** tick a body is out past its leash
   * with nobody to fight, and a body flung well past the boundary -- a flight
   * that ended out there, a slow body, one whose way home is blocked -- spends
   * many of them beyond it. A span taken again each time is a ramp that restarts
   * from wherever it has got to, which is a body that walks the whole way home
   * and heals nothing.
   *
   * The unit half first, because the end-to-end half below is only evidence
   * while the fixture keeps the body outside its leash for more than one tick,
   * and that is a property of the fixture rather than of the rule.
   */
  it('does not re-snapshot the span it is already walking', () => {
    let state = createWorldState(1);
    const spawned = withMonster(state, 'stalker', ANCHOR.x + 1000, ANCHOR.y, {
      stats: { maxHealth: 400 },
    });
    state = spawned.state;
    const out = goHome({ ...at(state, spawned.id), health: 40 });
    expect(out.returnStart).toEqual({ distance: 1000, health: 40 });

    // Asked again from further along, on more health: unchanged, and the very
    // same object, which is what makes the per-tick call free as well as safe.
    expect(goHome(out)).toBe(out);
    const later = goHome({
      ...out,
      position: { x: ANCHOR.x + 900, y: ANCHOR.y, z: 0 },
      health: 120,
    });
    expect(later.returnStart).toEqual({ distance: 1000, health: 40 });
  });

  it('holds that span across every tick it is still outside its leash', () => {
    // Dragged to twice its leash, so there are hundreds of ticks of walking
    // before `beyondLeash` stops being true and the per-tick call stops.
    const { state, monster, ctx } = pulled('stalker', {
      hurtTo: 40,
      startAt: LEASH_RADIUS * 2,
    });
    const start = at(state, monster).returnStart;
    expect(start?.distance).toBeGreaterThan(LEASH_RADIUS * 1.9);

    let next = state;
    let outsideTicks = 0;
    let health = at(next, monster).health;
    while (driftOf(at(next, monster)) > LEASH_RADIUS) {
      next = step(next, [], ctx).state;
      expect(at(next, monster).returnStart).toEqual(start);
      expect(at(next, monster).health).toBeGreaterThanOrEqual(health);
      health = at(next, monster).health;
      outsideTicks += 1;
      if (outsideTicks > SERVER_TICK_RATE * 60) throw new Error('never got inside its leash');
    }
    // The control: it really did spend a long time out there, and healed the
    // whole way. Under a span re-snapshotted per tick this is exactly flat.
    expect(outsideTicks).toBeGreaterThan(SERVER_TICK_RATE);
    expect(health).toBeGreaterThan(at(state, monster).health);
  });
});

describe('determinism', () => {
  it('draws nothing from the Rng, however far a body is dragged', () => {
    const ctx = context({ activeChunks: corridor(ANCHOR.x + LEASH_RADIUS + 300) });

    function run(withMonsterOut: boolean): ServerWorldState {
      let state = createWorldState(7);
      const player = withPlayer(state, ANCHOR.x + LEASH_RADIUS + 300, ANCHOR.y);
      state = player.state;
      if (withMonsterOut) {
        state = withMonster(state, 'stalker', ANCHOR.x, ANCHOR.y, {
          targetId: player.id,
          stats: { maxHealth: 400 },
        }).state;
      }
      for (let tick = 0; tick < SERVER_TICK_RATE * 20; tick++) {
        state = step(state, [], ctx).state;
      }
      return state;
    }

    const withOne = run(true);
    // The control: the body really did break its leash and walk home inside the
    // window, so what is compared is a world where all of this happened.
    expect([...withOne.entities.values()].some((e) => e.kind === EntityKindValue.Monster)).toBe(
      true,
    );
    expect(withOne.rng).toEqual(run(false).rng);
  });
});
