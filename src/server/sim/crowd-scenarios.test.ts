/**
 * What a crowd actually does, driven through the real `step` (spec 184).
 *
 * Every scenario in here is a whole tick: the real movement pass, the real
 * router, the real blocking rule, the real cast pass. Calling `steer` directly
 * would prove that the arithmetic is the arithmetic; what these are for is the
 * behaviour it adds up to, which lives entirely in the interaction between
 * steering, blocking and the route underneath them.
 *
 * The governing assertion, and the one every scenario re-checks: **nothing here
 * displaces anything.** A body's position changes because that body decided to
 * walk, or it does not change. There is no separation pass to fall back on, so
 * every case has to be prevented rather than repaired -- which is why "no pair
 * overlaps" is asserted per tick rather than at the end.
 */

import { describe, expect, it } from 'vitest';

import { createWorldColliders } from '../../sim/collision.js';
import type { Rect, Vec2 } from '../../sim/types.js';
import { DEFAULT_LIVE_CONFIG } from '../config.js';
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
import { EntityKindValue, type ServerEntity, type ServerWorldState } from './types.js';
import { createWorldState, spawnEntity, step, type StepContext } from './world.js';

const CHUNK = 100;
const ORIGIN = { x: 2000, y: 2000 };

const RECORD: PersistedPlayer = {
  id: 'p1',
  displayName: 'P1',
  baseStats: { strength: 5, agility: 5, intelligence: 5, constitution: 5, perception: 5, wisdom: 5 },
  skills: [],
  equipment: EMPTY_EQUIPMENT,
  inventory: emptyInventory(),
  coins: 0,
  position: { x: ORIGIN.x, y: ORIGIN.y, z: 0 },
  facing: 0,
  currentZone: 'greenmarch',
  level: 1,
  experience: 0,
  unspentSkillPoints: 0,
  unspentAttributePoints: 0,
  health: 100,
  resource: 100,
};
const PLAYER_STATS: EffectiveStats = computeEffectiveStats(RECORD);

/** A wide empty world, so nothing in these scenarios meets a wall by accident. */
const OPEN_BOUNDS: Rect = { x: 0, y: 0, w: 4000, h: 4000 };

function context(walls: readonly Rect[] = []): StepContext {
  const keys = new Set<string>();
  for (let cy = 0; cy <= 4000; cy += CHUNK) {
    for (let cx = 0; cx <= 4000; cx += CHUNK) keys.add(chunkKeyOf(cx, cy, CHUNK));
  }
  return {
    world: createWorldColliders(walls, [], OPEN_BOUNDS),
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: { ...DEFAULT_LIVE_CONFIG, spawnRateMultiplier: 0 },
    activeChunks: keys,
    chunkSize: CHUNK,
    spawnPoints: [],
  };
}

/**
 * A monster of `typeId` at a point, already committed to `targetId`.
 *
 * Handed a target at spawn, which `spawnEntity` reads as already engaged -- so
 * these scenarios are about walking rather than about noticing, and the aggro
 * rules are somebody else's tests.
 */
function addMonster(
  state: ServerWorldState,
  typeId: string,
  at: Vec2,
  options: { targetId?: number; moveSpeed?: number } = {},
): { state: ServerWorldState; id: number } {
  const definition = monsterById(typeId);
  if (!definition) throw new Error(`no ${typeId}`);
  const stats: EffectiveStats = options.moveSpeed
    ? { ...definition.stats, moveSpeed: options.moveSpeed }
    : definition.stats;
  const spawned = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId,
    position: { x: at.x, y: at.y, z: 0 },
    stats,
    radius: definition.radius,
    zoneId: 'greenmarch',
    ...(options.targetId === undefined ? {} : { targetId: options.targetId }),
  });
  return { state: spawned.state, id: spawned.entity.id };
}

/**
 * The thing the pack is walking at.
 *
 * Given far more health than the scenario can chew through, because these are
 * movement tests and a target that dies half way turns them into something
 * else: the pack goes calm, has no anchor to walk home to, and stands exactly
 * where it was -- which reads as a body wedged against a wall when what
 * actually happened is that it won.
 */
function addPlayer(state: ServerWorldState, at: Vec2): { state: ServerWorldState; id: number } {
  const spawned = spawnEntity(state, {
    kind: EntityKindValue.Player,
    typeId: 'player',
    ownerPlayerId: 'p1',
    position: { x: at.x, y: at.y, z: 0 },
    stats: { ...PLAYER_STATS, maxHealth: 1e9 },
    radius: 16,
    health: 1e9,
    zoneId: 'greenmarch',
  });
  return { state: spawned.state, id: spawned.entity.id };
}

const living = (state: ServerWorldState): ServerEntity[] =>
  [...state.entities.values()].filter(
    (one) =>
      one.health > 0 &&
      (one.kind === EntityKindValue.Monster || one.kind === EntityKindValue.Player),
  );

/** The deepest any two bodies are inside each other, in world units. */
function worstOverlap(state: ServerWorldState): number {
  const bodies = living(state);
  let worst = 0;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i];
      const b = bodies[j];
      if (!a || !b) continue;
      const gap = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
      worst = Math.max(worst, a.radius + b.radius - gap);
    }
  }
  return worst;
}

interface RunResult {
  readonly state: ServerWorldState;
  /** The worst overlap seen on any tick, not just the last one. */
  readonly worstOverlap: number;
  /** Every body's position, per tick, keyed by entity id. */
  readonly trails: ReadonlyMap<number, Vec2[]>;
}

function run(state: ServerWorldState, ticks: number, ctx: StepContext): RunResult {
  const trails = new Map<number, Vec2[]>();
  let worst = 0;
  let current = state;
  for (let tick = 0; tick < ticks; tick++) {
    current = step(current, [], ctx).state;
    worst = Math.max(worst, worstOverlap(current));
    for (const body of living(current)) {
      const trail = trails.get(body.id) ?? [];
      trail.push({ x: body.position.x, y: body.position.y });
      trails.set(body.id, trail);
    }
  }
  return { state: current, worstOverlap: worst, trails };
}

/**
 * How many times a body changes which way it is turning, counting only turns
 * big enough to see.
 *
 * The oscillation measure: a body that cannot decide which side of its
 * neighbour to pass swings one way and then the other, so the sign of the turn
 * keeps flipping. What matters is the **threshold**. Measured on the raw cross
 * product, a turn of a single degree counts, and every body scores in the
 * dozens simply from steering continuously along a curve -- so the number said
 * nothing about dithering and everything about arithmetic. Measured as an
 * angle, with a floor at a few degrees, only a real change of mind is counted.
 */
const REVERSAL_DEGREES = 5;

/**
 * How far a body has to actually travel in a step for its direction to count.
 *
 * A quarter of a full stride. Without it the measure is dominated by the
 * settling at the end of a scenario: a body parked in the ring making
 * hundredth-of-a-unit adjustments turns through big angles doing it, and those
 * are neither visible nor what dithering means. Dithering is a body *travelling*
 * first one way and then the other.
 */
const REVERSAL_MIN_STEP = 0.25;

/** One tick of a stalker's walk, which is what every scenario here is made of. */
const STALKER_STRIDE = 105 / 60;

/**
 * How many changes of mind a body is allowed over a whole scenario.
 *
 * Set from measurement rather than from taste: the worst body in any scenario
 * here turns back on itself a handful of times, and a body that was genuinely
 * dithering would do it once every few ticks and score in the hundreds. The
 * bound is a long way above what is observed and a long way below what a
 * failure looks like, which is the only useful place for it.
 */
const REVERSAL_BOUND = 25;

/**
 * The same bound for the single worst body rather than the typical one.
 *
 * Two statistics rather than one, because they answer different questions and
 * the max on its own is misleading. Threading a column of ten oncoming bodies
 * genuinely involves turning: the typical body in the crossing scenario changes
 * its mind fourteen times over six hundred ticks and the unluckiest does it
 * thirty-nine times, which is a body weaving past ten others rather than a body
 * dithering. Real dithering is an alternation every two or three ticks, which
 * over these runs is in the hundreds -- so the bound sits far above what is
 * measured and far below what a failure would score.
 */
const WORST_REVERSAL_BOUND = 90;

/** The middle value of a list, for asserting about the typical body. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function reversals(trail: readonly Vec2[], stride: number): number {
  let flips = 0;
  let previousTurn = 0;
  const least = stride * REVERSAL_MIN_STEP;
  for (let i = 2; i < trail.length; i++) {
    const a = trail[i - 2];
    const b = trail[i - 1];
    const c = trail[i];
    if (!a || !b || !c) continue;
    const inX = b.x - a.x;
    const inY = b.y - a.y;
    const outX = c.x - b.x;
    const outY = c.y - b.y;
    if (Math.hypot(inX, inY) < least || Math.hypot(outX, outY) < least) continue;
    const cross = inX * outY - inY * outX;
    const dot = inX * outX + inY * outY;
    const degrees = Math.abs(Math.atan2(cross, dot)) * (180 / Math.PI);
    if (degrees < REVERSAL_DEGREES) continue;
    const turn = Math.sign(cross);
    if (previousTurn !== 0 && turn !== previousTurn) flips += 1;
    previousTurn = turn;
  }
  return flips;
}

/**
 * How wide the pack is, measured across its direction of travel.
 *
 * The queue measure, and it has to be taken *while they are travelling* rather
 * than at the end: by the time a pack has arrived it is standing in a ring
 * around its target, which is wide for reasons that have nothing to do with
 * whether it crossed the ground as a crowd or as a conga line.
 */
function widthAcross(positions: readonly Vec2[], heading: Vec2): number {
  if (positions.length === 0) return 0;
  const length = Math.hypot(heading.x, heading.y) || 1;
  const acrossX = -heading.y / length;
  const acrossY = heading.x / length;
  let low = Infinity;
  let high = -Infinity;
  for (const point of positions) {
    const along = point.x * acrossX + point.y * acrossY;
    low = Math.min(low, along);
    high = Math.max(high, along);
  }
  return high - low;
}

function distanceOf(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe('a herd crossing open ground', () => {
  /** 40 grazers behind a player they are all committed to, across open ground. */
  function herd(count: number): { state: ServerWorldState; ctx: StepContext; playerId: number } {
    const ctx = context();
    let state = createWorldState(7);
    const player = addPlayer(state, { x: ORIGIN.x + 900, y: ORIGIN.y });
    state = player.state;
    for (let i = 0; i < count; i++) {
      const added = addMonster(
        state,
        'stalker',
        { x: ORIGIN.x - (i % 8) * 55, y: ORIGIN.y - 200 + Math.floor(i / 8) * 55 },
        { targetId: player.id },
      );
      state = added.state;
    }
    return { state, ctx, playerId: player.id };
  }

  it('keeps 40 bodies out of each other the whole way', () => {
    const { state, ctx } = herd(40);
    const result = run(state, 400, ctx);
    // Bodies are prevented from overlapping rather than pulled apart
    // afterwards, so this is a per-tick claim. A unit of slack absorbs two
    // bodies stepping into the same gap on the same tick, which the next tick's
    // block refuses and no push is needed to repair.
    expect(result.worstOverlap).toBeLessThan(1);
  });

  it('crosses the ground as a crowd rather than as a queue', () => {
    // The failure this rules out is single file: everybody funnelling onto one
    // line behind the leader, which is what avoidance that slowed a body down
    // instead of turning it would produce.
    //
    // Sampled mid-crossing, because a pack that has arrived is standing in a
    // ring and every arrangement looks wide from there.
    const { state, ctx } = herd(40);
    const result = run(state, 400, ctx);
    const mid = 150;
    const positions: Vec2[] = [];
    for (const [id, trail] of result.trails) {
      if (result.state.entities.get(id)?.kind !== EntityKindValue.Monster) continue;
      const point = trail[mid];
      if (point) positions.push(point);
    }
    expect(positions.length).toBe(40);
    // They are walking east. Forty bodies of radius 20 in a single file are
    // one body wide; anything past a few body widths across is a crowd.
    expect(widthAcross(positions, { x: 1, y: 0 })).toBeGreaterThan(200);
  });

  it('does not dither: bodies commit to a side rather than swinging back and forth', () => {
    const { state, ctx } = herd(40);
    const result = run(state, 400, ctx);
    const worst = Math.max(...[...result.trails.values()].map((trail) => reversals(trail, STALKER_STRIDE)));
    expect(worst).toBeLessThan(REVERSAL_BOUND);
  });
});

describe('mixed speeds', () => {
  it('lets a fast body finish ahead of a slow one it started behind', () => {
    // The queue test. A crowd that matched the pace of whatever was in front
    // would deliver these two in the order they set off in.
    const ctx = context();
    let state = createWorldState(3);
    const player = addPlayer(state, { x: ORIGIN.x + 1200, y: ORIGIN.y });
    state = player.state;
    const slow = addMonster(state, 'stalker', { x: ORIGIN.x + 80, y: ORIGIN.y }, {
      targetId: player.id,
      moveSpeed: 60,
    });
    state = slow.state;
    const fast = addMonster(state, 'stalker', { x: ORIGIN.x, y: ORIGIN.y }, {
      targetId: player.id,
      moveSpeed: 160,
    });
    state = fast.state;

    const result = run(state, 500, ctx);
    const target = result.state.entities.get(player.id);
    const fastBody = result.state.entities.get(fast.id);
    const slowBody = result.state.entities.get(slow.id);
    if (!target || !fastBody || !slowBody) throw new Error('missing body');

    expect(distanceOf(fastBody.position, target.position)).toBeLessThan(
      distanceOf(slowBody.position, target.position),
    );
    expect(result.worstOverlap).toBeLessThan(1);
  });

  it('never slows a body below its own speed to stay behind another', () => {
    // Avoidance is lateral and never a brake, so a body's travel per tick is
    // its own move speed whenever it is going anywhere at all.
    const ctx = context();
    let state = createWorldState(11);
    const player = addPlayer(state, { x: ORIGIN.x + 1200, y: ORIGIN.y });
    state = player.state;
    for (let i = 0; i < 6; i++) {
      const added = addMonster(state, 'stalker', { x: ORIGIN.x + i * 45, y: ORIGIN.y }, {
        targetId: player.id,
        moveSpeed: 60 + i * 20,
      });
      state = added.state;
    }
    const result = run(state, 200, ctx);

    for (const [id, trail] of result.trails) {
      const body = result.state.entities.get(id);
      if (!body || body.kind !== EntityKindValue.Monster) continue;
      const perTick = body.stats.moveSpeed / 60;
      for (let i = 1; i < trail.length; i++) {
        const a = trail[i - 1];
        const b = trail[i];
        if (!a || !b) continue;
        const travelled = distanceOf(a, b);
        // Either it stood still (arrived, blocked, or swinging) or it moved a
        // full step. What must never happen is a body creeping along at
        // somebody else's pace.
        if (travelled > 1e-6) expect(travelled).toBeGreaterThan(perTick - 1e-6);
      }
    }
  });
});

describe('a narrow opening', () => {
  /**
   * Two walls with a gap between them, and a pack that has to get through it.
   *
   * The gap is 96 units against 20-unit bodies, so a little over two abreast --
   * wide enough that the side-step has somewhere to put people, which is the
   * case the design claims to handle. Narrower than two bodies it does not, and
   * that limit is written down in the spec rather than tested for here.
   */
  function throughGap(gap: number): { state: ServerWorldState; ctx: StepContext; playerId: number } {
    const wallY = ORIGIN.y;
    const walls: Rect[] = [
      { x: ORIGIN.x + 300, y: wallY - 600, w: 40, h: 600 - gap / 2 },
      { x: ORIGIN.x + 300, y: wallY + gap / 2, w: 40, h: 600 },
    ];
    const ctx = context(walls);
    let state = createWorldState(21);
    const player = addPlayer(state, { x: ORIGIN.x + 700, y: ORIGIN.y });
    state = player.state;
    for (let i = 0; i < 16; i++) {
      const added = addMonster(
        state,
        'stalker',
        { x: ORIGIN.x - (i % 4) * 60, y: ORIGIN.y - 90 + Math.floor(i / 4) * 60 },
        { targetId: player.id },
      );
      state = added.state;
    }
    return { state, ctx, playerId: player.id };
  }

  it('gets a pack of 16 through a gap two bodies wide', () => {
    const { state, ctx } = throughGap(96);
    const result = run(state, 900, ctx);
    const through = living(result.state).filter(
      (one) => one.kind === EntityKindValue.Monster && one.position.x > ORIGIN.x + 340,
    );
    expect(through.length).toBe(16);
    expect(result.worstOverlap).toBeLessThan(1);
  });

  it('leaves nobody stuck against the wall', () => {
    // The thing with no push solver to fall back on: a body that cannot get
    // through has nothing to grind it past. Asserted as motion over the last
    // stretch rather than as arrival, so a body still queueing counts as fine
    // and a body wedged does not.
    const { state, ctx } = throughGap(96);
    const result = run(state, 900, ctx);
    for (const [id, trail] of result.trails) {
      const body = result.state.entities.get(id);
      if (!body || body.kind !== EntityKindValue.Monster) continue;
      // Everybody should be past the wall by now; if one is not, it has to at
      // least still be trying.
      if (body.position.x > ORIGIN.x + 340) continue;
      const recent = trail.slice(-120);
      const moved = recent.reduce(
        (most, point) => Math.max(most, distanceOf(point, recent[0] ?? point)),
        0,
      );
      expect(moved, `body ${id} is wedged at ${body.position.x.toFixed(0)}`).toBeGreaterThan(10);
    }
  });
});

describe('a pack converging on one target', () => {
  function pack(count: number): { state: ServerWorldState; ctx: StepContext; playerId: number } {
    const ctx = context();
    let state = createWorldState(5);
    const player = addPlayer(state, { x: ORIGIN.x, y: ORIGIN.y });
    state = player.state;
    for (let i = 0; i < count; i++) {
      // All of them from roughly the same side, which is the case that used to
      // put every body on one point.
      const angle = (-25 + i * 5) * (Math.PI / 180);
      const added = addMonster(
        state,
        'stalker',
        { x: ORIGIN.x + Math.cos(angle) * 500, y: ORIGIN.y + Math.sin(angle) * 500 },
        { targetId: player.id },
      );
      state = added.state;
    }
    return { state, ctx, playerId: player.id };
  }

  it('surrounds rather than stacking', () => {
    const { state, ctx, playerId } = pack(10);
    const result = run(state, 600, ctx);
    const target = result.state.entities.get(playerId);
    if (!target) throw new Error('no player');
    const attackers = living(result.state).filter((one) => one.kind === EntityKindValue.Monster);
    expect(attackers.length).toBe(10);

    const bearings = attackers
      .map((one) =>
        Math.atan2(one.position.y - target.position.y, one.position.x - target.position.x),
      )
      .sort((a, b) => a - b);
    // No two on the same bearing. Two 20-unit bodies at the standoff subtend
    // about 25 degrees, so anything above ten is comfortably distinct.
    for (let i = 1; i < bearings.length; i++) {
      const gap = Math.abs((bearings[i] ?? 0) - (bearings[i - 1] ?? 0)) * (180 / Math.PI);
      expect(gap).toBeGreaterThan(10);
    }
    expect(result.worstOverlap).toBeLessThan(1);
  });

  it('settles instead of jostling once everybody has arrived', () => {
    // No push means nothing to push back against, and the idle threshold means
    // bodies parked shoulder to shoulder are not each other's problem. Over the
    // last two seconds the ring should be effectively still.
    const { state, ctx } = pack(8);
    const result = run(state, 700, ctx);
    for (const [id, trail] of result.trails) {
      const body = result.state.entities.get(id);
      if (!body || body.kind !== EntityKindValue.Monster) continue;
      const settled = trail.slice(-120);
      const first = settled[0];
      if (!first) continue;
      const drift = settled.reduce((most, point) => Math.max(most, distanceOf(point, first)), 0);
      expect(drift, `body ${id} is still shuffling`).toBeLessThan(30);
    }
  });

  it('gets every attacker into range of what it is attacking', () => {
    const { state, ctx, playerId } = pack(6);
    const result = run(state, 600, ctx);
    const target = result.state.entities.get(playerId);
    if (!target) throw new Error('no player');
    for (const body of living(result.state)) {
      if (body.kind !== EntityKindValue.Monster) continue;
      // `melee.slash` reaches 70 from the body's edge; the ring is inside that.
      expect(distanceOf(body.position, target.position)).toBeLessThan(70 + target.radius);
    }
  });
});

describe('two groups moving through each other', () => {
  function crossing(): { state: ServerWorldState; ctx: StepContext } {
    const ctx = context();
    let state = createWorldState(13);
    // Each group chases a player standing behind the other group, so the two
    // columns have to pass through one another to get anywhere.
    const east = addPlayer(state, { x: ORIGIN.x + 700, y: ORIGIN.y });
    state = east.state;
    const west = addPlayer(state, { x: ORIGIN.x - 700, y: ORIGIN.y });
    state = west.state;
    for (let i = 0; i < 10; i++) {
      const goingEast = addMonster(
        state,
        'stalker',
        { x: ORIGIN.x - 400 - (i % 2) * 55, y: ORIGIN.y - 130 + Math.floor(i / 2) * 55 },
        { targetId: east.id },
      );
      state = goingEast.state;
      const goingWest = addMonster(
        state,
        'stalker',
        { x: ORIGIN.x + 400 + (i % 2) * 55, y: ORIGIN.y - 130 + Math.floor(i / 2) * 55 },
        { targetId: west.id },
      );
      state = goingWest.state;
    }
    return { state, ctx };
  }

  it('lets both columns through without a pile-up', () => {
    // Long enough for both columns to finish. They are still crossing at 700
    // ticks -- the furthest body is a third of the way home -- and everything
    // has settled by a thousand, so a shorter run measures the crossing rather
    // than its outcome.
    const { state, ctx } = crossing();
    const result = run(state, 1100, ctx);
    expect(result.worstOverlap).toBeLessThan(1);

    // Everybody got to the other side of where they started.
    for (const body of living(result.state)) {
      if (body.kind !== EntityKindValue.Monster) continue;
      const target = result.state.entities.get(body.targetId ?? 0);
      if (!target) continue;
      expect(distanceOf(body.position, target.position)).toBeLessThan(200);
    }
  });

  it('does not turn the crossing into a dance', () => {
    const { state, ctx } = crossing();
    const result = run(state, 1100, ctx);
    const counts = [...result.trails.values()].map((trail) => reversals(trail, STALKER_STRIDE));
    expect(median(counts)).toBeLessThan(REVERSAL_BOUND);
    expect(Math.max(...counts)).toBeLessThan(WORST_REVERSAL_BOUND);
  });
});

describe('the sim itself', () => {
  it('replays identically from the same seed and the same inputs', () => {
    // The property everything else rests on. A crowd sums forces over its
    // neighbours, and float addition is not associative, so an index that
    // reported them in a different order would produce a different world from
    // the same start.
    const play = (): readonly (readonly [number, number, number])[] => {
      const ctx = context();
      let state = createWorldState(29);
      const player = addPlayer(state, { x: ORIGIN.x + 600, y: ORIGIN.y });
      state = player.state;
      for (let i = 0; i < 24; i++) {
        const added = addMonster(
          state,
          i % 3 === 0 ? 'small_spider' : 'stalker',
          { x: ORIGIN.x - (i % 6) * 50, y: ORIGIN.y - 125 + Math.floor(i / 6) * 50 },
          { targetId: player.id },
        );
        state = added.state;
      }
      const result = run(state, 300, ctx);
      return living(result.state)
        .sort((a, b) => a.id - b.id)
        .map((one) => [one.id, one.position.x, one.position.y] as const);
    };
    expect(play()).toEqual(play());
  });

  it('leaves a lone monster’s approach exactly as it was', () => {
    // With one attacker there is no slot, and with nobody nearby there is no
    // steering -- so the whole of spec 184 is inert and the body walks the line
    // it always walked. Asserted against the geometry rather than against a
    // recorded baseline: a straight run at the target, to the standoff, and no
    // lateral drift at all.
    const ctx = context();
    let state = createWorldState(2);
    const player = addPlayer(state, { x: ORIGIN.x + 600, y: ORIGIN.y });
    state = player.state;
    const monster = addMonster(state, 'stalker', { x: ORIGIN.x, y: ORIGIN.y }, {
      targetId: player.id,
    });
    state = monster.state;

    const result = run(state, 400, ctx);
    const trail = result.trails.get(monster.id) ?? [];
    for (const point of trail) expect(point.y).toBeCloseTo(ORIGIN.y, 9);

    const body = result.state.entities.get(monster.id);
    const target = result.state.entities.get(player.id);
    if (!body || !target) throw new Error('missing body');
    // Stopped at its standoff, 0.8 * (70 + 16) = 68.8 -- reached from outside,
    // so it lands on the first step inside rather than exactly on it. Asserted
    // as the band a body walking in whole steps can actually stop in, which is
    // the honest claim: one step is 105/60.
    const stride = 105 / 60;
    const distance = distanceOf(body.position, target.position);
    expect(distance).toBeLessThanOrEqual(68.8);
    expect(distance).toBeGreaterThan(68.8 - stride);
  });
});
