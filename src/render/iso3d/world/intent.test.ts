import { describe, expect, it } from 'vitest';
import { ARRIVE_EPS, moveIntent, RoutePlanner, steerTo, type IntentInput } from './intent.js';
import { createWorldColliders } from '../../../sim/collision.js';
import { PATH_RETRY_TICKS, WORLD_BOUNDS } from '../../../sim/constants.js';

const ORIGIN = { x: 0, y: 0 };

function intent(over: Partial<IntentInput> = {}): ReturnType<typeof moveIntent> {
  return moveIntent({
    held: new Set(),
    self: ORIGIN,
    destination: null,
    route: null,
    facing: 0,
    castAim: null,
    ...over,
  });
}

describe('moveIntent', () => {
  it('is still when nothing is held and nothing is ordered', () => {
    const result = intent();
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  it('walks the cardinals at unit speed', () => {
    expect(intent({ held: new Set(['KeyW']) }).moveY).toBe(-1);
    expect(intent({ held: new Set(['KeyS']) }).moveY).toBe(1);
    expect(intent({ held: new Set(['KeyA']) }).moveX).toBe(-1);
    expect(intent({ held: new Set(['KeyD']) }).moveX).toBe(1);
  });

  it('normalises the diagonal, so W+D is not a sprint', () => {
    const result = intent({ held: new Set(['KeyW', 'KeyD']) });
    expect(Math.hypot(result.moveX, result.moveY)).toBeCloseTo(1, 9);
    expect(result.moveX).toBeCloseTo(Math.SQRT1_2, 9);
    expect(result.moveY).toBeCloseTo(-Math.SQRT1_2, 9);
  });

  it('cancels opposed keys', () => {
    const result = intent({ held: new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD']) });
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  it('treats the arrows as the same keys', () => {
    expect(intent({ held: new Set(['ArrowUp', 'ArrowRight']) })).toEqual(
      intent({ held: new Set(['KeyW', 'KeyD']) }),
    );
  });

  it('ignores keys that are not movement', () => {
    const result = intent({ held: new Set(['ShiftLeft', 'Digit1', 'KeyD']) });
    expect(result.moveX).toBe(1);
  });

  it('faces where it is going', () => {
    expect(intent({ held: new Set(['KeyA']) }).facing).toBeCloseTo(Math.PI, 9);
    expect(intent({ held: new Set(['KeyS']) }).facing).toBeCloseTo(Math.PI / 2, 9);
  });

  it('keeps its heading when it is standing still', () => {
    expect(intent({ facing: 1.25 }).facing).toBe(1.25);
  });
});

describe('a standing move order', () => {
  it('walks toward the destination', () => {
    const result = intent({ self: ORIGIN, destination: { x: 0, y: 100 } });
    expect(result.moveX).toBeCloseTo(0, 9);
    expect(result.moveY).toBeCloseTo(1, 9);
    expect(result.facing).toBeCloseTo(Math.PI / 2, 9);
    expect(result.arrived).toBe(false);
  });

  it('reports arrival once it is close enough, and asks for nothing', () => {
    const result = intent({ self: ORIGIN, destination: { x: ARRIVE_EPS - 1, y: 0 } });
    expect(result.arrived).toBe(true);
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  it('does not claim arrival when there is no order to arrive at', () => {
    expect(intent({ destination: null }).arrived).toBe(false);
  });

  /**
   * Grabbing the keys is how manual control is taken back. Having to cancel a
   * standing order first reads exactly like a stuck key.
   */
  it('lets held keys override the order', () => {
    const result = intent({ held: new Set(['KeyW']), destination: { x: 0, y: 900 } });
    expect(result.moveY).toBe(-1);
    expect(result.arrived).toBe(false);
  });

  it('does not report arrival while keys are steering', () => {
    const result = intent({
      held: new Set(['KeyW']),
      self: ORIGIN,
      destination: { x: 0, y: 0 },
    });
    expect(result.arrived).toBe(false);
  });
});

describe('while casting', () => {
  /**
   * The server roots a caster outright, so predicting a walk here diverges on
   * every tick of every wind-up -- a correction per tick, on the one action the
   * player is watching most closely.
   */
  it('asks for no movement, whatever is held', () => {
    const result = intent({ held: new Set(['KeyW', 'KeyD']), castAim: { x: 100, y: 0 } });
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  it('asks for no movement toward a standing order either', () => {
    const result = intent({ destination: { x: 500, y: 500 }, castAim: { x: 100, y: 0 } });
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  /**
   * The bug this replaced: holding the old heading meant the client drew a body
   * that never turned, while the server turned it the whole time.
   */
  it('asks to face the aim, so the body visibly comes round', () => {
    expect(intent({ facing: 0, castAim: { x: 0, y: 100 } }).facing).toBeCloseTo(Math.PI / 2, 9);
    expect(intent({ facing: 0, castAim: { x: -100, y: 0 } }).facing).toBeCloseTo(Math.PI, 9);
  });

  it('keeps its heading for an aim sitting on top of it', () => {
    expect(intent({ facing: 1.25, self: { x: 5, y: 5 }, castAim: { x: 5, y: 5 } }).facing).toBe(1.25);
  });
});

describe('steerTo', () => {
  it('is null without a destination', () => {
    expect(steerTo(ORIGIN, null)).toBeNull();
  });

  it('is null once inside the arrival radius', () => {
    expect(steerTo(ORIGIN, { x: 0, y: ARRIVE_EPS })).toBeNull();
    expect(steerTo(ORIGIN, { x: 0, y: ARRIVE_EPS + 1 })).not.toBeNull();
  });

  it('returns a unit vector at any distance', () => {
    for (const far of [10, 100, 10_000]) {
      const direction = steerTo(ORIGIN, { x: far, y: far });
      expect(direction).not.toBeNull();
      if (!direction) return;
      expect(Math.hypot(direction.x, direction.y)).toBeCloseTo(1, 9);
    }
  });
});

/**
 * The route cache (spec 065's follow-up).
 *
 * The first cut re-ran `findPath` on every tick an order stood -- a full A* at
 * 60Hz. The monsters have carried their route on the entity since spec 065;
 * this is the same bookkeeping for the one place a player's order lives.
 */
describe('RoutePlanner', () => {
  /** A wall between (600,450) and (900,450), open above and below. */
  const WALL = { x: 740, y: 250, w: 40, h: 400 };
  const world = { colliders: createWorldColliders([WALL], [], WORLD_BOUNDS), radius: 16 };

  it('plans nothing at all when the way is clear', () => {
    const planner = new RoutePlanner();
    // Straight down an empty lane, nowhere near the wall.
    expect(planner.next({ x: 100, y: 100 }, { x: 100, y: 600 }, world, 0)).toBeNull();
    expect(planner.searches).toBe(0);
    expect(planner.waypoints).toEqual([]);
  });

  it('routes around a wall it cannot walk through', () => {
    const planner = new RoutePlanner();
    const next = planner.next({ x: 600, y: 450 }, { x: 900, y: 450 }, world, 0);

    expect(next).not.toBeNull();
    expect(planner.searches).toBe(1);
    // It aims off the straight line, which is the only way past.
    expect(next?.y).not.toBeCloseTo(450, 0);
  });

  /** The point of the cache: one search, then many ticks of following it. */
  it('searches once and follows the route for many ticks', () => {
    const planner = new RoutePlanner();
    for (let tick = 0; tick < 19; tick++) {
      planner.next({ x: 600, y: 450 }, { x: 900, y: 450 }, world, tick);
    }
    expect(planner.searches).toBe(1);
  });

  it('replans on its cadence rather than never', () => {
    const planner = new RoutePlanner();
    for (let tick = 0; tick < 41; tick++) {
      planner.next({ x: 600, y: 450 }, { x: 900, y: 450 }, world, tick, 20);
    }
    // Ticks 0, 20 and 40: three searches over forty-one ticks, not forty-one.
    expect(planner.searches).toBe(3);
  });

  it('replans at once when the order is re-pointed somewhere else', () => {
    const planner = new RoutePlanner();
    planner.next({ x: 600, y: 450 }, { x: 900, y: 450 }, world, 0);
    expect(planner.searches).toBe(1);
    planner.next({ x: 600, y: 450 }, { x: 900, y: 200 }, world, 1);
    expect(planner.searches).toBe(2);
  });

  it('consumes waypoints as it reaches them', () => {
    const planner = new RoutePlanner();
    const first = planner.next({ x: 600, y: 450 }, { x: 900, y: 450 }, world, 0);
    expect(first).not.toBeNull();
    if (!first) return;
    const before = planner.waypoints.length;

    // Standing on the first waypoint: it is spent, and the next one is offered.
    const second = planner.next(first, { x: 900, y: 450 }, world, 1);
    expect(planner.waypoints.length).toBeLessThan(before);
    expect(second).not.toEqual(first);
  });

  it('forgets everything when the order is dropped', () => {
    const planner = new RoutePlanner();
    planner.next({ x: 600, y: 450 }, { x: 900, y: 450 }, world, 0);
    expect(planner.waypoints.length).toBeGreaterThan(0);

    expect(planner.next({ x: 600, y: 450 }, null, world, 1)).toBeNull();
    expect(planner.waypoints).toEqual([]);
  });

  it('steers straight when it has no world to route through', () => {
    const planner = new RoutePlanner();
    expect(planner.next({ x: 600, y: 450 }, { x: 900, y: 450 }, null, 0)).toBeNull();
    expect(planner.searches).toBe(0);
  });

  /**
   * An order onto ground nothing can reach (spec 073). It leaves the same empty
   * path a finished route does, and reading the two the same way is what had the
   * planner running a full A* every frame for as long as the order stood -- the
   * exact thing it was written to prevent.
   */
  describe('an order onto unreachable ground', () => {
    /** A sealed box with standing room inside and no way in. */
    const BOX = {
      colliders: createWorldColliders(
        [
          { x: 200, y: 200, w: 400, h: 30 },
          { x: 200, y: 500, w: 400, h: 30 },
          { x: 570, y: 200, w: 30, h: 330 },
          { x: 200, y: 200, w: 30, h: 330 },
        ],
        [],
        WORLD_BOUNDS,
      ),
      radius: 16,
    };
    const OUTSIDE = { x: 800, y: 350 };
    const INSIDE = { x: 400, y: 350 };

    it('searches on the retry cadence, not once a tick', () => {
      const planner = new RoutePlanner();
      for (let tick = 0; tick < PATH_RETRY_TICKS * 3; tick++) {
        expect(planner.next(OUTSIDE, INSIDE, BOX, tick)).toBeNull();
      }
      // Ticks 0, 60 and 120 -- three searches over 180 ticks, not 180.
      expect(planner.searches).toBe(3);
    });

    it('does not re-search because the unreachable target shuffled', () => {
      const planner = new RoutePlanner();
      planner.next(OUTSIDE, INSIDE, BOX, 0);
      expect(planner.searches).toBe(1);
      // Well past REPLAN_DISTANCE, and still inside the same sealed box.
      planner.next(OUTSIDE, { x: INSIDE.x, y: INSIDE.y + 100 }, BOX, 1);
      expect(planner.searches).toBe(1);
    });

    it('picks the order back up once it is reachable again', () => {
      const planner = new RoutePlanner();
      planner.next(OUTSIDE, INSIDE, BOX, 0);
      expect(planner.waypoints).toEqual([]);
      // Same tick budget, but now aimed at ground that needs a route round the
      // box rather than one into it.
      const next = planner.next(OUTSIDE, { x: 100, y: 350 }, BOX, PATH_RETRY_TICKS);
      expect(next).not.toBeNull();
      expect(planner.waypoints.length).toBeGreaterThan(0);
    });
  });
});

describe('following a route', () => {
  it('steers at the waypoint but only arrives at the destination', () => {
    // Standing on the waypoint, with the real order still far away.
    const result = intent({
      self: { x: 0, y: 0 },
      destination: { x: 500, y: 0 },
      route: { x: 0, y: 100 },
    });
    expect(result.moveY).toBeCloseTo(1, 9);
    expect(result.arrived).toBe(false);
  });

  it('arrives on the destination even while a waypoint is still offered', () => {
    const result = intent({
      self: { x: 0, y: 0 },
      destination: { x: 1, y: 0 },
      route: { x: 900, y: 900 },
    });
    expect(result.arrived).toBe(true);
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });
});
