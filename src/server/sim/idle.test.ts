/**
 * Spec 213. What a monster does when nobody is fighting it.
 *
 * Split the way the feature is: the derivation is exercised directly, because
 * where a body is headed is a pure function of `(its id, the tick)` and driving
 * a hundred ticks of `step` to observe one is a slower way of asking a smaller
 * question. What *does* go through the real `step` is everything that could be
 * wired up wrong -- that the goal reaches the movement pass at all, that an
 * amble is slower than a charge, and that none of it touches the `Rng`.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '../../sim/collision.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { ALL_MONSTERS, DEFAULT_IDLE, idlePlanOf, monsterById, noticeRangeOf } from '../data/monsters.js';
import { RESTORATION } from '../data/restoration.js';
import { chunkKeyOf } from '../world/chunks.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import { HOME_MARGIN, IDLE_PACE, RECOVERY_TICKS, idle, restore } from './idle.js';
import { enterCombat, recoveryRemaining } from './restoration.js';
import { NO_STATUSES, StatusId, expireStatuses, hasStatus } from './statuses.js';
import { EntityKindValue, type ServerEntity, type ServerWorldState } from './types.js';
import { createWorldState, spawnEntity, step, type StepContext } from './world.js';

const CHUNK = 100;

/** The chunks around the fixture's own patch of world, as a live set. */
function activeAround(): Set<string> {
  const activeChunks = new Set<string>();
  for (let dy = -20; dy <= 20; dy++) {
    for (let dx = -20; dx <= 20; dx++) {
      activeChunks.add(chunkKeyOf(600 + dx * CHUNK, 450 + dy * CHUNK, CHUNK));
    }
  }
  return activeChunks;
}

/**
 * A context over a **given** active set, so a test can take a body out of the
 * simulated world and put it back (spec 259).
 *
 * The set is handed in live rather than copied, which is what `ChunkManager`
 * does too (spec 193): the server refreshes it between ticks, so a test that
 * edits it between `step` calls is doing what a player walking away does.
 */
function contextWith(activeChunks: Set<string>): StepContext {
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: DEFAULT_LIVE_CONFIG,
    activeChunks,
    chunkSize: CHUNK,
    spawnPoints: [],
  };
}

function context(): StepContext {
  return contextWith(activeAround());
}

function withMonster(
  state: ServerWorldState,
  typeId: string,
  x: number,
  y: number,
  extra: { anchor?: { x: number; y: number }; health?: number } = {},
) {
  const definition = monsterById(typeId);
  if (!definition) throw new Error(`no monster ${typeId}`);
  const result = spawnEntity(state, {
    kind: EntityKindValue.Monster,
    typeId,
    position: { x, y, z: 0 },
    stats: definition.stats,
    radius: definition.radius,
    zoneId: 'greenmarch',
    ...(extra.anchor === undefined ? {} : { anchor: extra.anchor }),
    ...(extra.health === undefined ? {} : { health: extra.health }),
  });
  return { state: result.state, id: result.entity.id };
}

function run(state: ServerWorldState, ticks: number, ctx: StepContext): ServerWorldState {
  let next = state;
  for (let i = 0; i < ticks; i++) next = step(next, [], ctx).state;
  return next;
}

function at(state: ServerWorldState, id: number): ServerEntity {
  const entity = state.entities.get(id);
  if (!entity) throw new Error(`entity ${id} left the world`);
  return entity;
}

function from(state: ServerWorldState, id: number, x: number, y: number): number {
  const entity = at(state, id);
  return Math.hypot(entity.position.x - x, entity.position.y - y);
}

/** A bare body, for asking the derivation a question without a world around it. */
function body(overrides: Partial<ServerEntity> = {}): ServerEntity {
  const definition = monsterById('grazer');
  if (!definition) throw new Error('no grazer');
  return {
    ...(spawnEntity(createWorldState(1), {
      kind: EntityKindValue.Monster,
      typeId: 'grazer',
      position: { x: 600, y: 450, z: 0 },
      stats: definition.stats,
      radius: definition.radius,
      zoneId: 'greenmarch',
      anchor: { x: 600, y: 450 },
    }).entity),
    ...overrides,
  };
}

describe('wander', () => {
  it('leaves its spawn coordinate and stays on its own ground', () => {
    const plan = idlePlanOf('grazer');
    if (plan.kind !== 'wander') throw new Error('the grazer stopped wandering');
    const anchor = { x: 600, y: 450 };
    let state = createWorldState(1);
    const grazer = withMonster(state, 'grazer', anchor.x, anchor.y, { anchor });
    state = grazer.state;
    const ctx = context();

    let moved = false;
    let furthest = 0;
    for (let tick = 0; tick < SERVER_TICK_RATE * 60; tick++) {
      state = step(state, [], ctx).state;
      const away = from(state, grazer.id, anchor.x, anchor.y);
      if (away > at(state, grazer.id).radius) moved = true;
      furthest = Math.max(furthest, away);
    }

    expect(moved).toBe(true);
    // Its own body's worth of slack past the ring, which is what "arrived" means
    // and so the furthest a body can be standing on a spot at the edge of it.
    expect(furthest).toBeLessThanOrEqual(plan.radius + at(state, grazer.id).radius);
  });

  it('picks a new spot when its cycle turns over, and holds one in between', () => {
    const plan = idlePlanOf('grazer');
    if (plan.kind !== 'wander') throw new Error('the grazer stopped wandering');
    const subject = body();

    const spots: string[] = [];
    const changed: number[] = [];
    let previous = '';
    for (let tick = 0; tick < plan.cycleTicks * 6; tick++) {
      const goal = idle(subject, tick).goal;
      if (!goal) throw new Error('a wanderer with nowhere to go');
      const key = `${goal.at.x.toFixed(3)},${goal.at.y.toFixed(3)}`;
      if (key !== previous) {
        spots.push(key);
        changed.push(tick);
        previous = key;
      }
    }

    // Six cycles, so at least six spots -- exactly how many depends on the
    // hashed phase this body's cycle starts on, which is the point of the phase.
    expect(spots.length).toBeGreaterThanOrEqual(6);
    // Every one of them fresh...
    expect(new Set(spots).size).toBe(spots.length);
    // ...and the period between them exactly the authored cycle, which is the
    // sharper half of the claim: the spot is *held* for every tick in between,
    // and that holding is the dwell.
    for (let i = 1; i + 1 < changed.length; i++) {
      expect((changed[i + 1] ?? 0) - (changed[i] ?? 0)).toBe(plan.cycleTicks);
    }
  });

  it('ambles rather than charging', () => {
    // The pace is a magnitude on the intent, so the only way to see it is what
    // the body actually covers. A grazer at 40 walking flat out would cross 40
    // units a second; it must not.
    const anchor = { x: 600, y: 450 };
    let state = createWorldState(1);
    const grazer = withMonster(state, 'grazer', anchor.x, anchor.y, { anchor });
    state = grazer.state;
    const ctx = context();

    let fastest = 0;
    for (let tick = 0; tick < SERVER_TICK_RATE * 30; tick++) {
      const before = at(state, grazer.id).position;
      state = step(state, [], ctx).state;
      const after = at(state, grazer.id).position;
      fastest = Math.max(fastest, Math.hypot(after.x - before.x, after.y - before.y));
    }

    const perTick = (monsterById('grazer')?.stats.moveSpeed ?? 0) / SERVER_TICK_RATE;
    expect(fastest).toBeGreaterThan(0);
    // Within float slack of the ambling pace, and nowhere near a full stride.
    expect(fastest).toBeLessThanOrEqual(perTick * IDLE_PACE + 1e-6);
  });

  it('stands still with no anchor at all', () => {
    // Which is what keeps a conjured or test-seeded monster behaving exactly as
    // it did before this spec: a body with no home has no ground to wander over.
    let state = createWorldState(1);
    const grazer = withMonster(state, 'grazer', 600, 450);
    state = grazer.state;
    const before = at(state, grazer.id).position;
    state = run(state, SERVER_TICK_RATE * 20, context());
    expect(at(state, grazer.id).position).toEqual(before);
  });

  it('is what a row that says nothing gets', () => {
    // The ravager authors no idle at all, so "all units wander" is a property of
    // the default rather than of five rows each remembering to say so.
    expect(monsterById('ravager')?.idle).toEqual(DEFAULT_IDLE);
    expect(idlePlanOf('ravager').kind).toBe('wander');
  });
});

describe('sentinel', () => {
  it('never leaves its anchor', () => {
    expect(idlePlanOf('dummy').kind).toBe('sentinel');
    let state = createWorldState(1);
    const dummy = withMonster(state, 'dummy', 400, 700, { anchor: { x: 400, y: 700 } });
    state = dummy.state;
    state = run(state, SERVER_TICK_RATE * 20, context());
    expect(from(state, dummy.id, 400, 700)).toBe(0);
  });

  it('is what a body with no row at all gets', () => {
    expect(idlePlanOf('there-is-no-such-monster').kind).toBe('sentinel');
  });
});

describe('patrol', () => {
  it('walks a fixed circuit and comes back round to the first post', () => {
    const plan = idlePlanOf('stalker');
    if (plan.kind !== 'patrol') throw new Error('the stalker stopped patrolling');
    const anchor = { x: 900, y: 450 };
    // On its own ground: a body further from its anchor than its ring comes
    // home instead, which is the right answer to a different question.
    const subject = body({ id: 7, typeId: 'stalker', anchor, position: { ...anchor, z: 0 } });

    const posts: { x: number; y: number }[] = [];
    let previous = '';
    for (let tick = 0; tick < plan.legTicks * plan.points * 2; tick++) {
      const goal = idle(subject, tick).goal;
      if (!goal) throw new Error('a sentry with no post');
      const key = `${goal.at.x.toFixed(3)},${goal.at.y.toFixed(3)}`;
      if (key !== previous) {
        posts.push(goal.at);
        previous = key;
      }
    }

    // Every post is on the ring...
    for (const post of posts) {
      expect(Math.hypot(post.x - anchor.x, post.y - anchor.y)).toBeCloseTo(plan.radius, 6);
    }
    // ...there are exactly `points` of them...
    const distinct = new Set(posts.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`));
    expect(distinct.size).toBe(plan.points);
    // ...and the circuit repeats rather than wandering off it.
    expect(posts.length).toBeGreaterThan(plan.points);
    for (let i = 0; i + plan.points < posts.length; i++) {
      expect(posts[i + plan.points]?.x).toBeCloseTo(posts[i]?.x ?? NaN, 6);
      expect(posts[i + plan.points]?.y).toBeCloseTo(posts[i]?.y ?? NaN, 6);
    }
  });

  it('puts two sentries of the same row out of step with each other', () => {
    // Both the phase and the direction are hashed off the body's id, so a pair
    // spawned on the same tick do not orbit as a formation.
    const anchor = { x: 900, y: 450 };
    const post = { position: { ...anchor, z: 0 }, typeId: 'stalker', anchor } as const;
    const one = idle(body({ ...post, id: 11 }), 0).goal;
    const two = idle(body({ ...post, id: 12 }), 0).goal;
    if (!one || !two) throw new Error('a sentry with no post');
    expect(one.at).not.toEqual(two.at);
  });

  it('reaches its posts in the world, not only on paper', () => {
    const plan = idlePlanOf('stalker');
    if (plan.kind !== 'patrol') throw new Error('the stalker stopped patrolling');
    const anchor = { x: 900, y: 450 };
    let state = createWorldState(1);
    const stalker = withMonster(state, 'stalker', anchor.x, anchor.y, { anchor });
    state = stalker.state;
    const ctx = context();

    const seen = new Set<string>();
    for (let tick = 0; tick < plan.legTicks * plan.points * 3; tick++) {
      state = step(state, [], ctx).state;
      const goal = idle(at(state, stalker.id), state.tick).goal;
      if (!goal) continue;
      const here = at(state, stalker.id);
      if (Math.hypot(goal.at.x - here.position.x, goal.at.y - here.position.y) <= here.radius) {
        seen.add(`${goal.at.x.toFixed(1)},${goal.at.y.toFixed(1)}`);
      }
    }
    // Every post on the circuit was stood on at least once.
    expect(seen.size).toBe(plan.points);
  });
});

describe('coming home', () => {
  it('walks back at full speed and recovers on the way', () => {
    // The pull-and-reset case, whole: a body hurt, dragged well past its leash
    // and abandoned must arrive home able to fight.
    const anchor = { x: 600, y: 450 };
    let state = createWorldState(1);
    const ravager = withMonster(state, 'ravager', anchor.x + 900, anchor.y, { anchor, health: 12 });
    state = ravager.state;
    const ctx = context();
    const max = monsterById('ravager')?.stats.maxHealth ?? 0;

    state = run(state, SERVER_TICK_RATE * 40, ctx);
    const home = idlePlanOf('ravager');
    expect(from(state, ravager.id, anchor.x, anchor.y)).toBeLessThanOrEqual(
      (home.kind === 'sentinel' ? 0 : home.radius) + HOME_MARGIN,
    );
    expect(at(state, ravager.id).health).toBe(max);
  });

  it('comes home faster than it ambles', () => {
    const anchor = { x: 600, y: 450 };
    let state = createWorldState(1);
    const ravager = withMonster(state, 'ravager', anchor.x + 600, anchor.y, { anchor });
    state = ravager.state;
    const ctx = context();

    const before = at(state, ravager.id).position;
    state = run(state, SERVER_TICK_RATE, ctx);
    const after = at(state, ravager.id).position;
    const covered = Math.hypot(after.x - before.x, after.y - before.y);
    const speed = monsterById('ravager')?.stats.moveSpeed ?? 0;
    // A full second of walking home is a full second of move speed, not the
    // fraction of it a body about its own business asks for.
    expect(covered).toBeGreaterThan(speed * IDLE_PACE * 1.5);
  });
});

describe('recovery', () => {
  const max = () => monsterById('ravager')?.stats.maxHealth ?? 0;
  const hurt = (health: number, overrides: Partial<ServerEntity> = {}): ServerEntity => {
    const definition = monsterById('ravager');
    if (!definition) throw new Error('no ravager');
    return body({ typeId: 'ravager', stats: definition.stats, health, ...overrides });
  };
  /** A body whose last blow landed on tick 0, which is what both clocks run from. */
  const fought = (health: number): ServerEntity =>
    hurt(health, { statuses: enterCombat(NO_STATUSES, 0) });
  /** The first tick it may start coming back on: the fight window, closed. */
  const opens = RESTORATION.rest.combatTicks;

  it('is linear, and stops at full', () => {
    let subject = fought(1);
    const step = max() / RECOVERY_TICKS;
    for (let k = 1; k <= 10; k++) {
      subject = restore(subject, opens + k - 1);
      expect(subject.health).toBeCloseTo(1 + k * step, 6);
    }
    // All the way, and no further.
    for (let tick = opens; tick < opens + RECOVERY_TICKS * 2; tick++) {
      subject = restore(subject, tick);
    }
    expect(subject.health).toBe(max());
  });

  it('refuses while the body is in combat', () => {
    // Half its pool rather than a literal: spec 217 divided every monster's
    // health, and a hand-written 50 was above a Ravager's whole bar afterwards
    // -- so recovery had nowhere to go and the test failed for a reason that
    // had nothing to do with what it is about.
    const half = max() / 2;
    const subject = fought(half);
    expect(restore(subject, 1).health).toBe(half);
    expect(restore(subject, opens - 1).health).toBe(half);
    // And resumes the tick that window closes rather than needing anything else
    // to notice it has.
    expect(restore(subject, opens).health).toBeGreaterThan(half);
  });

  it('never revives a corpse', () => {
    expect(restore(hurt(0), 1).health).toBe(0);
  });

  it('does not run while the body holds a target', () => {
    // Not a rule inside `restore` -- it is that `idle` is only reached with no
    // target at all, which is the same thing said once instead of twice.
    const anchor = { x: 600, y: 450 };
    let state = createWorldState(1);
    const one = withMonster(state, 'ravager', anchor.x, anchor.y, { anchor, health: 30 });
    state = one.state;
    const two = withMonster(state, 'grazer', anchor.x + 40, anchor.y);
    state = two.state;
    // Handed a target, which `spawnEntity` reads as already committed to it.
    state = {
      ...state,
      entities: new Map(state.entities).set(one.id, {
        ...at(state, one.id),
        targetId: two.id,
        aggro: 2,
      }),
    };
    state = run(state, SERVER_TICK_RATE * 3, context());
    expect(at(state, one.id).health).toBe(30);
  });
});

/**
 * Spec 259. Recovery is measured on the clock, not in ticks somebody was near
 * enough to watch.
 */
describe('recovery is a comparison, not a counter', () => {
  const max = () => monsterById('ravager')?.stats.maxHealth ?? 0;
  const hurt = (health: number, overrides: Partial<ServerEntity> = {}): ServerEntity => {
    const definition = monsterById('ravager');
    if (!definition) throw new Error('no ravager');
    return body({ typeId: 'ravager', stats: definition.stats, health, ...overrides });
  };
  const due = RESTORATION.rest.combatTicks + RECOVERY_TICKS;

  it('starts one clock per question, both from the last blow', () => {
    const statuses = enterCombat(NO_STATUSES, 0);
    // Still fighting, for the window `advanceRest` reads.
    expect(hasStatus(statuses, StatusId.InCombat, RESTORATION.rest.combatTicks - 1)).toBe(true);
    expect(hasStatus(statuses, StatusId.InCombat, RESTORATION.rest.combatTicks)).toBe(false);
    // And owed, for a whole recovery past that.
    expect(recoveryRemaining(statuses, 0)).toBe(due);
    expect(recoveryRemaining(statuses, RESTORATION.rest.combatTicks)).toBe(RECOVERY_TICKS);
    expect(recoveryRemaining(statuses, due)).toBe(0);
  });

  it('owes nothing to a body that has never been in a fight', () => {
    // The clock is the record of a fight, so no clock is no floor -- not a body
    // handed full health for a wound it got some other way, which is what an
    // absent entry read as "long ago" would mean.
    expect(recoveryRemaining(NO_STATUSES, 40)).toBeNull();
    const scratched = hurt(1);
    expect(restore(scratched, 40).health).toBeCloseTo(1 + max() / RECOVERY_TICKS, 6);
  });

  it('reads the clock after it has lapsed, which is what a frozen body keeps', () => {
    const statuses = enterCombat(NO_STATUSES, 0);
    const late = due + 5_000;
    // Dead to `hasStatus`, and still the record of when the body was due back.
    expect(hasStatus(statuses, StatusId.Recovering, late)).toBe(false);
    expect(recoveryRemaining(statuses, late)).toBe(0);
    expect(restore(hurt(1, { statuses }), late).health).toBe(max());
  });

  it('is pruned exactly when there is nothing left to owe', () => {
    // Which is what makes an absent clock and a lapsed one safe to answer the
    // same way. `expireStatuses` drops it on the tick the body is due, and by
    // then the step has already carried a watched body to full.
    let subject = hurt(1, { statuses: enterCombat(NO_STATUSES, 0) });
    for (let tick = 0; tick <= due; tick++) subject = restore(subject, tick);
    expect(subject.health).toBe(max());
    expect(expireStatuses(subject.statuses, due)).toEqual(NO_STATUSES);
  });

  it('leaves the ramp exactly what it was for a body that was watched throughout', () => {
    // Both answers reach full on the due tick and the step runs from the body's
    // own health where the floor runs from empty, so the step is the greater at
    // every tick a body was actually stepped for. The floor is pure catch-up
    // and can never reshape a watched recovery.
    const step = max() / RECOVERY_TICKS;
    for (const start of [1, max() * 0.25, max() * 0.5, max() * 0.9]) {
      let subject = hurt(start, { statuses: enterCombat(NO_STATUSES, 0) });
      for (let k = 1; k <= RECOVERY_TICKS; k++) {
        subject = restore(subject, RESTORATION.rest.combatTicks + k - 1);
        expect(subject.health).toBeCloseTo(Math.min(max(), start + k * step), 6);
      }
    }
  });

  it('credits a gap it spent frozen part way through the ramp', () => {
    // The half a watched body and an unwatched one can disagree about: the
    // clock had already started when the body stopped being stepped.
    const statuses = enterCombat(NO_STATUSES, 0);
    const half = RESTORATION.rest.combatTicks + RECOVERY_TICKS / 2;
    expect(restore(hurt(1, { statuses }), half).health).toBeCloseTo(max() / 2, 6);
  });

  it('brings a monster nobody was near back whole on the tick it is stepped again', () => {
    const anchor = { x: 600, y: 450 };
    let state = createWorldState(1);
    const ravager = withMonster(state, 'ravager', anchor.x, anchor.y, { anchor, health: 1 });
    state = ravager.state;
    // On a sliver, with the fight it lost ending right now.
    state = {
      ...state,
      entities: new Map(state.entities).set(ravager.id, {
        ...at(state, ravager.id),
        statuses: enterCombat(NO_STATUSES, state.tick),
      }),
    };

    // The player died and respawned across the map, so nothing is near it.
    const active = activeAround();
    active.delete(chunkKeyOf(anchor.x, anchor.y, CHUNK));
    const ctx = contextWith(active);
    state = run(state, due + SERVER_TICK_RATE, ctx);
    // Frozen, which is the bug this closes: `world.ts` steps nothing outside
    // `activeChunks`, so before spec 259 the sliver was still there whenever
    // the player got back.
    expect(at(state, ravager.id).health).toBe(1);

    // And back within interest. One tick, because the ticks it spent unwatched
    // count exactly as the ticks it spent watched would have.
    active.add(chunkKeyOf(anchor.x, anchor.y, CHUNK));
    state = run(state, 1, ctx);
    expect(at(state, ravager.id).health).toBe(max());
  });

  it('does not spend the gap on the Rng', () => {
    // The catch-up is arithmetic on a tick, so a body that was away draws
    // exactly what a body that was never there draws: nothing.
    const anchor = { x: 600, y: 450 };
    const gap = due + SERVER_TICK_RATE;

    const withGap = (() => {
      let state = createWorldState(1);
      const one = withMonster(state, 'ravager', anchor.x, anchor.y, { anchor, health: 1 });
      state = one.state;
      const active = activeAround();
      active.delete(chunkKeyOf(anchor.x, anchor.y, CHUNK));
      const ctx = contextWith(active);
      state = run(state, gap, ctx);
      active.add(chunkKeyOf(anchor.x, anchor.y, CHUNK));
      return run(state, 1, ctx).rng.getState();
    })();

    const empty = run(createWorldState(1), gap + 1, context()).rng.getState();
    expect(withGap).toEqual(empty);
  });
});

describe('what the rows actually produce', () => {
  /**
   * Two guards on the numbers rather than on the code, both of them for the
   * same reason: a roam radius is the one field in this feature somebody will
   * reach for without reading anything, and both ways of getting it wrong are
   * silent.
   */

  /**
   * How far a body that *initiates* may end up able to reach.
   *
   * Spec 163 cut the slinger's notice range from 520 to 380 because the arena is
   * 1200 by 900 with `DEFAULT_SPAWN` at its centre, so 520 was a body watching
   * nearly half the playable world and, in practice, the tile every character
   * respawns on. Roaming re-opens that from the other end: what a territorial
   * body can reach is its notice range *plus how far it has walked from its
   * post*, so raising a patrol radius spends the budget 163 was tuned against
   * without touching the number 163 tuned. This is that budget, stated once.
   */
  const MAX_INITIATOR_REACH = 500;

  it('keeps an initiating body inside the reach spec 163 tuned for', () => {
    for (const row of ALL_MONSTERS) {
      const range = noticeRangeOf(row.temperament);
      if (range === 0) continue;
      const plan = row.idle;
      const roam = plan.kind === 'sentinel' ? 0 : plan.radius;
      expect(
        range + roam,
        `${row.id} can reach ${range + roam}: a ${range} notice range from anywhere on a ${roam} roam`,
      ).toBeLessThanOrEqual(MAX_INITIATOR_REACH);
    }
  });

  it('gives every roaming row both a walk and a rest', () => {
    // Measured off the real tick rather than derived, because what a body
    // actually does is the product of four numbers that live in three files --
    // the radius and the cycle here, `IDLE_PACE` in `idle.ts`, and the body's
    // own `moveSpeed` -- and the arithmetic between them is exactly the sort
    // nobody re-does when they change one. Both failure modes are silent from
    // inside a data table: a cycle too short for the radius is a body
    // permanently in transit, and one too long is the field of statues this
    // spec exists to replace.
    const ctx = context();
    for (const row of ALL_MONSTERS) {
      if (row.idle.kind === 'sentinel') continue;
      const anchor = { x: 600, y: 450 };
      let state = createWorldState(3);
      const spawned = withMonster(state, row.id, anchor.x, anchor.y, { anchor });
      state = spawned.state;

      let moving = 0;
      const ticks = SERVER_TICK_RATE * 120;
      for (let tick = 0; tick < ticks; tick++) {
        const before = at(state, spawned.id).position;
        state = step(state, [], ctx).state;
        const after = at(state, spawned.id).position;
        if (Math.hypot(after.x - before.x, after.y - before.y) > 1e-6) moving += 1;
      }

      const fraction = moving / ticks;
      expect(fraction, `${row.id} never moves`).toBeGreaterThan(0.05);
      expect(fraction, `${row.id} never rests`).toBeLessThan(0.85);
    }
  });
});

describe('determinism', () => {
  const populate = (state: ServerWorldState): ServerWorldState => {
    let next = state;
    for (const [typeId, x, y] of [
      ['grazer', 500, 400],
      ['grazer', 540, 400],
      ['stalker', 700, 500],
      ['slinger', 760, 560],
      ['small_spider', 620, 620],
      ['ravager', 480, 560],
    ] as const) {
      next = withMonster(next, typeId, x, y, { anchor: { x, y }, health: 5 }).state;
    }
    return next;
  };

  it('replays bit for bit', () => {
    const snapshot = (state: ServerWorldState): string =>
      JSON.stringify({
        tick: state.tick,
        rng: state.rng.getState(),
        entities: [...state.entities.values()],
      });
    const once = run(populate(createWorldState(7)), SERVER_TICK_RATE * 20, context());
    const twice = run(populate(createWorldState(7)), SERVER_TICK_RATE * 20, context());
    expect(snapshot(once)).toBe(snapshot(twice));
  });

  it('draws nothing from the Rng', () => {
    // The property the whole module is hashed rather than drawn for: adding a
    // field of monsters going about their business must not move a single
    // combat roll anywhere else in the world.
    const empty = run(createWorldState(7), SERVER_TICK_RATE * 20, context());
    const busy = run(populate(createWorldState(7)), SERVER_TICK_RATE * 20, context());
    expect(busy.rng.getState()).toEqual(empty.rng.getState());
  });
});
