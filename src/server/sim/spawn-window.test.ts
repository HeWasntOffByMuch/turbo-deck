/**
 * Spec 268. A spawner that keeps hours.
 *
 * Everything here goes through the real `step`, because the claim is about a
 * pass and not about a predicate -- `spawnWindowOpen` has its own tests in
 * `world/spawners.test.ts`, and what this file is for is that the gate is
 * wired into the tick, and that the *other* half of the decision holds: the sun
 * stops the spawner and never the monster.
 *
 * Worlds are parked at a tick rather than stepped to one. A cycle is 48,600
 * ticks and the interesting hours are tens of thousands apart, so stepping
 * there would be minutes of wall clock to assert something about one tick. The
 * clock is a pure function of the tick (spec 264), so a state handed a tick is
 * a state at that hour -- there is no elapsed time anywhere for it to disagree
 * with.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_WORLD } from '../../sim/collision.js';
import { CHUNK_SIZE, DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { CYCLE_TICKS, tickForHours, worldClockAt } from '../data/day-night.js';
import { idlePlanOf } from '../data/monsters.js';
import { chunkKeyOf } from '../world/chunks.js';
import type { SpawnPoint } from '../world/spawners.js';
import { FLAT_TERRAIN } from '../world/terrain.js';
import { ZoneManager } from '../world/zone-manager.js';
import { EntityKindValue, type ServerEntity, type ServerWorldState } from './types.js';
import { createWorldState, replaceEntity, step, type StepContext } from './world.js';

const AT = { x: 620, y: 470 };
const SEED = 3;

/**
 * The first tick of the cycle at which the sun is down, found rather than
 * typed.
 *
 * `tickForHours(18)` is the *nearest* tick to six o'clock and lands a tick
 * early -- the clock there reads 17.9997 and `sunUp` is still true -- so a test
 * that assumed it would be asserting the boundary is one tick off the boundary
 * the sim uses, which is exactly the bug a boundary test exists to catch.
 */
const DARK_FROM = ((): number => {
  let tick = tickForHours(18);
  while (worldClockAt(tick).sunUp) tick += 1;
  while (tick > 0 && !worldClockAt(tick - 1).sunUp) tick -= 1;
  return tick;
})();

/** The first tick after it at which the sun is back up. Dawn, by the horizon. */
const LIGHT_FROM = ((): number => {
  let tick = DARK_FROM;
  while (!worldClockAt(tick).sunUp) tick += 1;
  return tick;
})();

/** Broad daylight, a long way from either boundary. */
const NOON = tickForHours(12);

function activeAround(): Set<string> {
  const keys = new Set<string>();
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      keys.add(chunkKeyOf(AT.x + dx * CHUNK_SIZE, AT.y + dy * CHUNK_SIZE, CHUNK_SIZE));
    }
  }
  return keys;
}

function context(spawnPoints: readonly SpawnPoint[], interval = 300): StepContext {
  return {
    world: DEFAULT_WORLD,
    terrain: FLAT_TERRAIN,
    zones: new ZoneManager(),
    config: { ...DEFAULT_LIVE_CONFIG, spawnIntervalTicks: interval, spawnRateMultiplier: 1 },
    activeChunks: activeAround(),
    chunkSize: CHUNK_SIZE,
    spawnPoints,
  };
}

function point(when: SpawnPoint['when'], id = 'spawner-1'): SpawnPoint {
  return { id, monsterId: 'grazer', x: AT.x, y: AT.y, respawnTicks: null, leashRadius: null, when };
}

/** A fresh world parked at `tick`, so the next `step` runs on `tick + 1`. */
function parked(tick: number): ServerWorldState {
  return { ...createWorldState(SEED), tick };
}

function monsters(state: ServerWorldState): ServerEntity[] {
  return [...state.entities.values()].filter((e) => e.kind === EntityKindValue.Monster);
}

function run(state: ServerWorldState, ctx: StepContext, ticks: number): ServerWorldState {
  let at = state;
  for (let i = 0; i < ticks; i++) at = step(at, [], ctx).state;
  return at;
}

describe('a spawner with no hours', () => {
  /**
   * The control, and the reason it is first: every other case here asserts a
   * spawner *not* filling at some hour, and a gate that refused everything
   * would pass all of them.
   */
  it.each([
    ['midday', NOON],
    ['midnight', DARK_FROM + 1000],
    ['the first tick of the cycle', 0],
  ])('fills at %s exactly as it always did', (_name, tick) => {
    const state = run(parked(tick), context([point(null)]), 1);
    expect(monsters(state)).toHaveLength(1);
  });
});

describe('a spawner that only fills at night', () => {
  const ctx = context([point('night')]);

  it('stands empty through the day', () => {
    const state = run(parked(NOON), ctx, 120);
    expect(monsters(state)).toHaveLength(0);
    // Empty and *ready*, so what is holding it is the window rather than a
    // timer nobody has started -- which is the state the readout has to name,
    // and the reason `Holding` is its own word rather than a `Waiting` at zero.
    const held = state.spawners.get('spawner-1');
    expect(held?.entityId ?? null).toBeNull();
    expect(held?.readyAtTick ?? 0).toBeLessThanOrEqual(state.tick);
  });

  it('is still empty on the last tick the sun is up', () => {
    expect(monsters(run(parked(DARK_FROM - 2), ctx, 1))).toHaveLength(0);
  });

  it('fills on the first tick the sun is down', () => {
    const state = run(parked(DARK_FROM - 1), ctx, 1);
    expect(state.tick).toBe(DARK_FROM);
    expect(monsters(state)).toHaveLength(1);
    expect(monsters(state)[0]?.position).toMatchObject({ x: AT.x, y: AT.y });
  });
});

describe('a spawner that only fills by day', () => {
  const ctx = context([point('day')]);

  it('stands empty through the night', () => {
    expect(monsters(run(parked(DARK_FROM + 500), ctx, 120))).toHaveLength(0);
  });

  it('fills on the first tick the sun is back up', () => {
    const state = run(parked(LIGHT_FROM - 1), ctx, 1);
    expect(state.tick).toBe(LIGHT_FROM);
    expect(monsters(state)).toHaveLength(1);
  });
});

/**
 * The decision the spec took, and the half that is not a gate: dawn stops the
 * spawner, not the monster.
 *
 * There is deliberately no sweep, no walk home and no retreat, so there is no
 * rule needed for a body somebody is mid-swing against -- and none of this
 * needed a line of code, which is why it is asserted rather than assumed.
 */
describe('a night body at dawn', () => {
  const ctx = context([point('night')]);

  it('is the same body it was before the sun came up', () => {
    let state = run(parked(DARK_FROM - 1), ctx, 1);
    const born = monsters(state)[0];
    expect(born).toBeDefined();
    if (!born) return;

    state = { ...state, tick: LIGHT_FROM - 30 };
    state = run(state, ctx, 300);

    expect(worldClockAt(state.tick).sunUp).toBe(true);
    const alive = monsters(state);
    expect(alive).toHaveLength(1);
    expect(alive[0]?.id).toBe(born.id);
    expect(alive[0]?.spawnerId).toBe('spawner-1');
    expect(alive[0]?.health).toBeGreaterThan(0);
  });

  it('goes on wandering in the daylight', () => {
    // A claim about the body still being *driven*, not just still listed. The
    // grazer's row wanders, which is what makes the distance meaningful.
    expect(idlePlanOf('grazer').kind).toBe('wander');

    let state = run(parked(DARK_FROM - 1), ctx, 1);
    state = { ...state, tick: LIGHT_FROM };
    let travelled = 0;
    for (let i = 0; i < 900; i++) {
      state = step(state, [], ctx).state;
      const body = monsters(state)[0];
      if (body) {
        travelled = Math.max(travelled, Math.hypot(body.position.x - AT.x, body.position.y - AT.y));
      }
    }
    expect(worldClockAt(state.tick).sunUp).toBe(true);
    expect(travelled).toBeGreaterThan(1);
  });
});

describe('a night monster killed in daylight', () => {
  const interval = 60;
  const ctx = context([point('night')], interval);

  /** Spawn one at dusk, then move the world into the day it will die in. */
  function bornThenDaylight(): { state: ServerWorldState; victim: ServerEntity } {
    const born = run(parked(DARK_FROM - 1), ctx, 1);
    const victim = monsters(born)[0];
    if (!victim) throw new Error('nothing spawned');
    return { state: { ...born, tick: NOON }, victim };
  }

  it('is not replaced for the rest of the day', () => {
    const { state, victim } = bornThenDaylight();
    let after = step(replaceEntity(state, { ...victim, health: 0 }), [], ctx).state;
    expect(after.entities.has(victim.id)).toBe(false);
    // Well past its own interval, and still nothing: the timer ran out in the
    // sunshine and the point stayed shut.
    after = run(after, ctx, interval * 4);
    expect(monsters(after)).toHaveLength(0);
  });

  it('comes back on the next tick the sun is down', () => {
    const { state, victim } = bornThenDaylight();
    let after = step(replaceEntity(state, { ...victim, health: 0 }), [], ctx).state;
    after = run(after, ctx, interval * 2);
    expect(monsters(after)).toHaveLength(0);

    after = run({ ...after, tick: DARK_FROM - 1 }, ctx, 1);
    const replacement = monsters(after)[0];
    expect(replacement).toBeDefined();
    expect(replacement?.id).not.toBe(victim.id);
    expect(replacement?.position).toMatchObject({ x: AT.x, y: AT.y });
  });

  /**
   * The other order, and the one that would be easy to get wrong: killed at
   * night with a wait that outlives the darkness, the replacement is due in
   * daylight and has to be refused there too.
   */
  it('waits out a respawn that comes due after sunrise', () => {
    const slow = context([point('night')], 600);
    let state = run(parked(DARK_FROM - 1), slow, 1);
    const victim = monsters(state)[0];
    expect(victim).toBeDefined();
    if (!victim) return;

    // Killed a hundred ticks before the sun comes up, due five hundred after.
    state = { ...state, tick: LIGHT_FROM - 100 };
    state = step(replaceEntity(state, { ...victim, health: 0 }), [], slow).state;
    state = run(state, slow, 900);
    expect(worldClockAt(state.tick).sunUp).toBe(true);
    expect(monsters(state)).toHaveLength(0);
  });
});

/**
 * Determinism. The gate reads a clock, and a clock is the one thing the
 * deterministic core is forbidden to read a *wall* version of -- so what has to
 * be true is that this one is a pure function of the tick and that spawning
 * still draws nothing.
 */
describe('the window and the random stream', () => {
  it('draws nothing from the Rng, spawning or refusing', () => {
    const ticks = 240;
    const bare = run(parked(DARK_FROM - 1), context([]), ticks);
    const filling = run(parked(DARK_FROM - 1), context([point('night'), point('night', 'spawner-2')]), ticks);
    const refusing = run(parked(NOON), context([point('night'), point('night', 'spawner-2')]), ticks);

    expect(monsters(filling).length).toBeGreaterThan(0);
    expect(monsters(refusing)).toHaveLength(0);
    expect(filling.rng.getState()).toEqual(bare.rng.getState());
    expect(refusing.rng.getState()).toEqual(bare.rng.getState());
  });

  it('replays a sunrise to the same state twice', () => {
    const digest = (state: ServerWorldState): string =>
      JSON.stringify({
        tick: state.tick,
        rng: state.rng.getState(),
        spawners: [...state.spawners.entries()].sort(),
        entities: [...state.entities.values()]
          .map((e) => [e.id, e.typeId, e.spawnerId, e.position, e.facing, e.health] as const)
          .sort((a, b) => a[0] - b[0]),
      });

    const once = (): ServerWorldState => {
      const ctx = context([point('night'), point('day', 'spawner-2')]);
      return run(parked(LIGHT_FROM - 60), ctx, 240);
    };

    expect(digest(once())).toBe(digest(once()));
  });

  /** A sanity check on the fixture: these hours really are in one cycle. */
  it('measures its hours inside a single cycle', () => {
    expect(DARK_FROM).toBeGreaterThan(NOON);
    expect(LIGHT_FROM).toBeGreaterThan(DARK_FROM);
    expect(LIGHT_FROM).toBeLessThan(CYCLE_TICKS);
    expect((LIGHT_FROM - DARK_FROM) / SERVER_TICK_RATE).toBeCloseTo(167, 0);
  });
});
