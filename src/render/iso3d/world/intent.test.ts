import { describe, expect, it } from 'vitest';
import { MOVE_EAST, MOVE_NORTH, MOVE_SOUTH, MOVE_WEST } from '../../../ui/input/actions.js';
import { aligned, ARRIVE_EPS, moveIntent, RoutePlanner, steerTo, type IntentInput } from './intent.js';
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
    expect(intent({ held: new Set([MOVE_NORTH]) }).moveY).toBe(-1);
    expect(intent({ held: new Set([MOVE_SOUTH]) }).moveY).toBe(1);
    expect(intent({ held: new Set([MOVE_WEST]) }).moveX).toBe(-1);
    expect(intent({ held: new Set([MOVE_EAST]) }).moveX).toBe(1);
  });

  it('normalises the diagonal, so W+D is not a sprint', () => {
    const result = intent({ held: new Set([MOVE_NORTH, MOVE_EAST]) });
    expect(Math.hypot(result.moveX, result.moveY)).toBeCloseTo(1, 9);
    expect(result.moveX).toBeCloseTo(Math.SQRT1_2, 9);
    expect(result.moveY).toBeCloseTo(-Math.SQRT1_2, 9);
  });

  it('cancels opposed keys', () => {
    const result = intent({ held: new Set([MOVE_NORTH, MOVE_SOUTH, MOVE_WEST, MOVE_EAST]) });
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  // "The arrows walk too" used to be a second set of entries in this module's
  // table. It is now the secondary binding of these four actions, asserted in
  // `src/ui/input/input-map.test.ts` where a player can actually change it.

  it('ignores held actions that are not movement', () => {
    const result = intent({ held: new Set(['skillbar.1', 'ui.character', MOVE_EAST]) });
    expect(result.moveX).toBe(1);
  });

  it('faces where it is going', () => {
    expect(intent({ held: new Set([MOVE_WEST]) }).facing).toBeCloseTo(Math.PI, 9);
    expect(intent({ held: new Set([MOVE_SOUTH]) }).facing).toBeCloseTo(Math.PI / 2, 9);
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
    const result = intent({ held: new Set([MOVE_NORTH]), destination: { x: 0, y: 900 } });
    expect(result.moveY).toBe(-1);
    expect(result.arrived).toBe(false);
  });

  it('does not report arrival while keys are steering', () => {
    const result = intent({
      held: new Set([MOVE_NORTH]),
      self: ORIGIN,
      destination: { x: 0, y: 0 },
    });
    expect(result.arrived).toBe(false);
  });
});

describe('while casting', () => {
  /**
   * The server roots a caster that asks for nothing, so predicting a walk here
   * would diverge on every tick of every wind-up -- a correction per tick, on
   * the one action the player is watching most closely.
   */
  it('asks for no movement when nothing is held and nothing is ordered', () => {
    const result = intent({ castAim: { x: 100, y: 0 } });
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  /**
   * And the other half, since spec 079: asking to move *withdraws* from the
   * cast on the server, so predicting a stand would be predicting the opposite
   * of what the very same input frame is about to cause.
   */
  it('walks anyway when a key is held, because that withdraws from the cast', () => {
    const result = intent({ held: new Set([MOVE_SOUTH]), castAim: { x: 100, y: 0 } });
    expect(result.moveY).toBeCloseTo(1, 6);
    expect(result.facing).toBeCloseTo(Math.PI / 2, 6);
  });

  it('walks anyway toward a standing order', () => {
    const result = intent({ destination: { x: 500, y: 0 }, castAim: { x: 100, y: 0 } });
    expect(result.moveX).toBeCloseTo(1, 6);
    expect(result.moveY).toBeCloseTo(0, 6);
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

  /**
   * Spec 130. The same wall made of rock rather than of collider -- which is
   * what a tier drawn in the map editor is. Nothing is in the way, so the
   * planner used to hand back null and let the player march at the cliff.
   */
  it('routes around a ridge, which is not a collider at all', () => {
    const ridge = {
      colliders: createWorldColliders([], [], WORLD_BOUNDS),
      radius: 16,
      ground: { heightAt: (x: number, y: number) => (x >= 740 && x <= 780 && y >= 250 && y <= 650 ? 200 : 0) },
    };
    const planner = new RoutePlanner();
    const next = planner.next({ x: 600, y: 450 }, { x: 900, y: 450 }, ridge, 0);

    expect(next).not.toBeNull();
    expect(planner.searches).toBe(1);
    expect(next?.y).not.toBeCloseTo(450, 0);
  });

  it('still plans nothing when the ground between is walkable', () => {
    const rolling = {
      colliders: createWorldColliders([], [], WORLD_BOUNDS),
      radius: 16,
      // A gentle rise: 20 units over 300, nothing a body notices.
      ground: { heightAt: (x: number) => x / 15 },
    };
    const planner = new RoutePlanner();
    expect(planner.next({ x: 600, y: 450 }, { x: 900, y: 450 }, rolling, 0)).toBeNull();
    expect(planner.searches).toBe(0);
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

/**
 * A click that produces no movement vector withdraws from nothing (spec 090).
 *
 * The reported bug, and the player's own diagnosis of it: click to the side
 * mid-wind-up, watch the body turn, and the blow lands anyway. Spec 079's rule
 * is that *asking to move* withdraws -- and `asksToMove` on the server is
 * `hypot(moveX, moveY) > 1e-6`, so a turn is not asking. `steerTo` returns null
 * inside `ARRIVE_EPS`, so a click close to the body produces no vector at all,
 * and what the player sees turning is the body coming round into its own aim
 * (the `castAim` branch below), not a response to the click.
 *
 * The order was unmistakable; whether it happened to yield a vector this tick is
 * an implementation detail no player can see.
 */
describe('a move order that yields no vector (spec 090)', () => {
  const self = { x: 600, y: 450 };
  const castAim = { x: 900, y: 450 };

  it('asks for nothing when the click lands inside the arrival radius', () => {
    const near = moveIntent({
      held: new Set(),
      self,
      destination: { x: self.x + ARRIVE_EPS * 0.5, y: self.y },
      route: null,
      facing: 0,
      castAim,
    });
    // Nothing to withdraw with: the server's `asksToMove` reads exactly this.
    expect(Math.hypot(near.moveX, near.moveY)).toBe(0);
    // And the heading asked for is the *aim*, not the click -- which is the turn
    // the player sees and reads as the click being obeyed.
    expect(near.facing).toBeCloseTo(Math.atan2(castAim.y - self.y, castAim.x - self.x), 9);
  });

  it('does ask to move when the click is far enough to steer to', () => {
    const far = moveIntent({
      held: new Set(),
      self,
      destination: { x: self.x, y: self.y + ARRIVE_EPS * 8 },
      route: null,
      facing: 0,
      castAim,
    });
    expect(Math.hypot(far.moveX, far.moveY)).toBeGreaterThan(1e-6);
    // Which is what makes the walk, and the withdrawal, happen at all.
    expect(far.facing).toBeCloseTo(Math.PI / 2, 9);
  });
});

/**
 * Facing the mark while waiting to swing at it (spec 090).
 *
 * `autoAttack` asks for nothing while the swing is on cooldown and the target is
 * in reach -- no cast, no chase -- so without this the body kept whatever
 * heading it had until the blow committed, and paid for the turn *after* the
 * wait instead of during it. At spec 088's 1.2s delay that was most of two
 * seconds from the click to the shot, nearly all of it dead.
 */
describe('a body faces what it was told to attack (spec 090)', () => {
  const self = { x: 600, y: 450 };
  /** Directly behind: the worst case, and the one that was reported. */
  const behind = { x: self.x - 300, y: self.y };

  function intentWith(over: Partial<IntentInput>): ReturnType<typeof moveIntent> {
    return moveIntent({
      held: new Set(),
      self,
      destination: null,
      route: null,
      facing: 0,
      castAim: null,
      targetAim: null,
      ...over,
    });
  }

  it('turns toward a mark it is waiting to hit, rather than holding its heading', () => {
    const waiting = intentWith({ targetAim: behind });
    // Still asking for nothing -- a wait is not a walk, and asking to move here
    // would withdraw from the very blow being queued up (spec 079).
    expect(Math.hypot(waiting.moveX, waiting.moveY)).toBe(0);
    // But pointing at the mark, so the wind-up starts already aligned.
    expect(waiting.facing).toBeCloseTo(Math.PI, 9);
    // Which is the whole change: without a mark it keeps facing where it was.
    expect(intentWith({}).facing).toBe(0);
  });

  it('lets a committed blow outrank the mark', () => {
    // A cast's aim was captured at the commit and is the authority on where the
    // body points -- a mark that has since walked must not drag the blow round.
    const aim = { x: self.x, y: self.y + 300 };
    const casting = intentWith({ castAim: aim, targetAim: behind });
    expect(casting.facing).toBeCloseTo(Math.PI / 2, 9);
  });

  it('lets a walk outrank the mark, so withdrawing still works', () => {
    const walking = intentWith({
      held: new Set([MOVE_EAST]),
      targetAim: behind,
    });
    // Asking to move is how a blow is withdrawn from; a mark cannot veto it.
    expect(walking.moveX).toBeCloseTo(1, 9);
    expect(walking.facing).toBeCloseTo(0, 9);
  });

  it('keeps its heading when it is standing on top of the mark', () => {
    const onTop = intentWith({ facing: 1.25, targetAim: { x: self.x, y: self.y } });
    expect(onTop.facing).toBe(1.25);
  });
});

/**
 * Spec 244. Turning to face somebody you have just started talking to.
 *
 * The same slot the mark above sits in, and for the same reason -- a walk
 * outranks it -- with one difference that is the whole of what makes it a
 * *greeting* rather than a lock: the caller drops it the instant the body has
 * come round. That half lives in `view.ts`, since this function is pure and
 * holds nothing between calls; what is asserted here is that the aim does what
 * it says while it is set.
 */
describe('a body faces whoever it has just spoken to (spec 244)', () => {
  const self = { x: 600, y: 450 };
  const merchant = { x: self.x - 300, y: self.y };

  function intentWith(over: Partial<IntentInput>): ReturnType<typeof moveIntent> {
    return moveIntent({
      held: new Set(),
      self,
      destination: null,
      route: null,
      facing: 0,
      castAim: null,
      targetAim: null,
      talkAim: null,
      ...over,
    });
  }

  it('turns toward them, standing still', () => {
    const greeting = intentWith({ talkAim: merchant });
    expect(Math.hypot(greeting.moveX, greeting.moveY)).toBe(0);
    expect(greeting.facing).toBeCloseTo(Math.PI, 9);
    // Without one it keeps whatever heading it had, which is the control.
    expect(intentWith({}).facing).toBe(0);
  });

  it('lets a walk outrank it, because the player is free to leave', () => {
    const walking = intentWith({ held: new Set([MOVE_EAST]), talkAim: merchant });
    expect(walking.moveX).toBeCloseTo(1, 9);
    expect(walking.facing).toBeCloseTo(0, 9);
  });

  it('is outranked by a committed blow, like every other standing aim', () => {
    const aim = { x: self.x, y: self.y + 300 };
    expect(intentWith({ castAim: aim, talkAim: merchant }).facing).toBeCloseTo(Math.PI / 2, 9);
  });

  it('keeps its heading when it is standing on top of them', () => {
    expect(intentWith({ facing: 1.25, talkAim: { x: self.x, y: self.y } }).facing).toBe(1.25);
  });

  it('is held still by a stagger and refused by death, like every other aim', () => {
    expect(intentWith({ talkAim: merchant, staggered: true, facing: 1.25 }).facing).toBe(1.25);
    expect(intentWith({ talkAim: merchant, dead: true, facing: 1.25 }).facing).toBe(1.25);
  });
});

describe('aligned', () => {
  it('is true for a heading that has arrived, and false for one still turning', () => {
    expect(aligned(1.2, 1.2)).toBe(true);
    expect(aligned(1.2, 1.2 + 0.01)).toBe(true);
    expect(aligned(0, Math.PI / 2)).toBe(false);
  });

  it('does not treat the wrap at pi as a large difference', () => {
    // Two headings either side of pi are a hair apart; the *numbers* are 2pi
    // apart, which is what a plain subtraction would report.
    expect(aligned(Math.PI - 0.01, -Math.PI + 0.01)).toBe(true);
  });
});

describe('a poise break holds the legs and the heading (spec 173)', () => {
  const HELD_FACING = 1.2;

  it('asks for no movement, whatever is held', () => {
    const result = intent({
      staggered: true,
      held: new Set([MOVE_NORTH, MOVE_EAST]),
      facing: HELD_FACING,
    });
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  it('asks for the heading it already has, whatever is held', () => {
    // The half a correction can never fix. A `Correction` carries a position,
    // so a predicted step is pulled back inside a round trip; it carries no
    // facing at all, so a body that kept turning through its own stagger is an
    // error nothing corrects.
    expect(
      intent({ staggered: true, held: new Set([MOVE_NORTH]), facing: HELD_FACING }).facing,
    ).toBe(HELD_FACING);
  });

  it('outranks a wind-up aim', () => {
    // A break clears the cast, so this should not arise from the sim -- but the
    // two fields are set from different places on the client and the ordering
    // has to be stated rather than left to whichever branch is written first.
    const result = intent({
      staggered: true,
      castAim: { x: 500, y: 500 },
      facing: HELD_FACING,
    });
    expect(result.facing).toBe(HELD_FACING);
    expect(result.moveX).toBe(0);
  });

  it('outranks the mark of a standing attack order', () => {
    // `autoAttack` already refuses to chase or swing while staggered, but it
    // still hands back a mark, and facing one is a turn the server will not
    // make.
    const result = intent({
      staggered: true,
      targetAim: { x: 500, y: 0 },
      facing: HELD_FACING,
    });
    expect(result.facing).toBe(HELD_FACING);
  });

  it('outranks a standing move order', () => {
    const result = intent({
      staggered: true,
      destination: { x: 900, y: 0 },
      facing: HELD_FACING,
    });
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
    expect(result.facing).toBe(HELD_FACING);
  });

  it('outranks the aim of something being put down (spec 172)', () => {
    // The two features met in this function on the same day. A drop's aim
    // deliberately turns the body *while it walks*, which is the one branch
    // here that returns a live direction -- so it is the one most able to
    // smuggle a turn through a stagger. The server pins `steered.facing`
    // regardless, so the client must not ask for one.
    const result = intent({
      staggered: true,
      dropAim: { x: 500, y: 500 },
      held: new Set([MOVE_EAST]),
      facing: HELD_FACING,
    });
    expect(result.facing).toBe(HELD_FACING);
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  it('walks again the moment the window ends', () => {
    const result = intent({ staggered: false, held: new Set([MOVE_EAST]) });
    expect(result.moveX).toBe(1);
  });
});

/**
 * Turning to put something down (spec 172).
 *
 * The ranking is what these are about, and it is not the same as the cast's:
 * walking withdraws from a cast and does not withdraw from a drop, so a drop's
 * aim outranks a direction where a cast's aim is outranked by one.
 */
describe('a body turns to what it is putting down (spec 172)', () => {
  const AIM = { x: 0, y: -100 };

  it('faces the aim while standing still', () => {
    expect(intent({ dropAim: AIM }).facing).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('keeps walking while it comes round', () => {
    const result = intent({ dropAim: AIM, held: new Set([MOVE_EAST]) });
    // The legs are the key's...
    expect(result.moveX).toBe(1);
    expect(result.moveY).toBe(0);
    // ...and the head is the drop's.
    expect(result.facing).toBeCloseTo(-Math.PI / 2, 9);
  });

  /** A committed blow still owns the body: its aim was captured at the commit. */
  it('yields to a cast', () => {
    const result = intent({ dropAim: AIM, castAim: { x: 100, y: 0 } });
    expect(result.facing).toBeCloseTo(0, 9);
  });

  it('outranks a standing attack order, which is only a place to look', () => {
    const result = intent({ dropAim: AIM, targetAim: { x: 100, y: 0 } });
    expect(result.facing).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('keeps the heading it had when the aim is where the body stands', () => {
    expect(intent({ dropAim: { ...ORIGIN }, facing: 1.25 }).facing).toBeCloseTo(1.25, 9);
  });
});

/**
 * A corpse does not walk (spec 229).
 *
 * The bug this closes is not a mispredicted step, it is a mispredicted step
 * that is never corrected: `stepWorld`'s movement pass steps past a body at zero
 * health *before* it reads an intent, so the server neither moves the body nor
 * says anything about it, and a `Correction` is the only thing that pulls a
 * predicted position back. Measured before this branch existed, a standing move
 * order carried a corpse 155 units in one second across its own screen -- a full
 * second at `MOVE_SPEED` -- while every other client watched it lie where it
 * fell, and it stayed wrong until the respawn teleport.
 *
 * So the ranking is the whole of it, and it is the strongest one in the
 * function: every branch below can smuggle a step or a turn through, and the
 * five doors into a destination are not a list anybody should have to keep.
 */
describe('a corpse asks for nothing (spec 229)', () => {
  const HELD_FACING = -0.7;

  it('asks for no movement, whatever is held', () => {
    const result = intent({
      dead: true,
      held: new Set([MOVE_NORTH, MOVE_EAST]),
      facing: HELD_FACING,
    });
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  it('asks for the heading it already has', () => {
    // The half nothing reconciles, and more starkly than a stagger's: a
    // `Correction` carries no facing, and for a dead body the server does not
    // send one at all.
    expect(intent({ dead: true, held: new Set([MOVE_SOUTH]), facing: HELD_FACING }).facing).toBe(
      HELD_FACING,
    );
  });

  it('outranks a standing move order and its route', () => {
    // The reported bug, exactly: a right-click before dying, and a body that
    // gets up and walks to it.
    const result = intent({
      dead: true,
      destination: { x: 900, y: 0 },
      route: { x: 400, y: 0 },
      facing: HELD_FACING,
    });
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
    expect(result.facing).toBe(HELD_FACING);
  });

  it('outranks a wind-up aim, a drop aim and a standing mark', () => {
    // Each of the three turns the body, and one of them (`dropAim`) walks it
    // too. None should arise from a live sim on a corpse; all three are set
    // from different places on the client, so the ordering is stated rather
    // than left to whichever branch happens to be written first.
    for (const over of [
      { castAim: { x: 500, y: 500 } },
      { dropAim: { x: 500, y: 500 } },
      { targetAim: { x: 500, y: 500 } },
    ]) {
      const result = intent({ dead: true, facing: HELD_FACING, ...over });
      expect(result.moveX).toBe(0);
      expect(result.moveY).toBe(0);
      expect(result.facing).toBe(HELD_FACING);
    }
  });

  it('outranks a stagger, which it can arrive on top of', () => {
    // A body broken and then killed carries both. They agree about the legs, so
    // what this pins is that the order between them is decided rather than
    // incidental -- the two are set from different fields and either could be
    // written first.
    const result = intent({
      dead: true,
      staggered: true,
      held: new Set([MOVE_WEST]),
      facing: HELD_FACING,
    });
    expect(result.moveX).toBe(0);
    expect(result.facing).toBe(HELD_FACING);
  });

  it('still reports an order it is standing on as spent', () => {
    // Being dead is not being somewhere. `arrived` answers the destination and
    // nothing else, so a caller that clears the order on it is right either way.
    const spent = intent({ dead: true, self: ORIGIN, destination: { x: 0, y: 0 } });
    expect(spent.arrived).toBe(true);
    const standing = intent({ dead: true, self: ORIGIN, destination: { x: 900, y: 0 } });
    expect(standing.arrived).toBe(false);
  });

  it('changes nothing for a living body', () => {
    // The field is optional and every call site that has not been told about it
    // has to behave exactly as it did.
    const asked = { held: new Set([MOVE_EAST]), destination: { x: 900, y: 0 } };
    expect(intent({ ...asked, dead: false })).toEqual(intent(asked));
  });
});
