/**
 * How steep is too steep (spec 227).
 *
 * The first test `isWalkable` has ever had of its own. Before this the rule was
 * reached incidentally by `rock.test.ts` and `gear-speed.test.ts`, neither of
 * which is about slope, and the thing nobody was asserting is the one that was
 * wrong: the limit was a height per tick, so the *angle* it enforced was that
 * height divided by how fast the body happened to be going.
 *
 * Written against gradients rather than degrees wherever the arithmetic allows,
 * because a gradient is what the code compares and a degree is what a person
 * reads. Both appear where the point is that the two agree.
 */

import { describe, expect, it } from 'vitest';

import { createWorldColliders } from '../../sim/collision.js';
import {
  CLIMB_PACE,
  MAX_CLIMB_ANGLE_DEG,
  MAX_CLIMB_SLOPE,
  MAX_STEP_HEIGHT,
  MAX_WALK_ANGLE_DEG,
  MAX_WALK_SLOPE,
  MOVE_SPEED_HARD_MAX,
  NAV_CELL_SIZE,
  PLAYER_RADIUS,
} from '../../sim/constants.js';
import { createNavGrid, findPath, type NavGround } from '../../sim/pathfinding.js';
import { DEFAULT_BANDS } from '../../terrain/classify.js';
import { DEFAULT_LIVE_CONFIG, SERVER_TICK_RATE } from '../config.js';
import { createWorldPredictor } from '../client/prediction.js';
import { monsterById } from '../data/monsters.js';
import type { Vec2 } from '../../sim/types.js';
import type { TerrainSampler } from '../world/terrain.js';
import { gradeStep, paceFor, resolveMovement, StepGrade } from './movement.js';
import { EntityKindValue, type ServerEntity, type ServerInput } from './types.js';
import { createWorldState, spawnEntity } from './world.js';

const DEG = 180 / Math.PI;
const BOUNDS = { x: 0, y: 0, w: 4000, h: 4000 };
const OPEN = createWorldColliders([], [], BOUNDS);
const FOOT = 1000;

/**
 * Ground rising at a constant gradient everywhere, uphill along `aspect`.
 *
 * Uniform rather than flat-then-sloped, and the difference is the whole reason
 * to say so: a foot is a **crease**, and `slope.ts` reads the gentler side of
 * each axis precisely so a crease is not mistaken for a slope. A body within
 * `SLOPE_BASELINE` of the bottom of a hill correctly sees the flat behind it
 * and walks, so a fixture with a foot in it measures the corner rather than the
 * hill. The base is high enough that nothing here is under water.
 */
function ramp(gradient: number, aspect = 0): NavGround & TerrainSampler {
  const ux = Math.cos(aspect);
  const uy = Math.sin(aspect);
  return {
    heightAt: (x: number, y: number) =>
      200_000 + ((x - FOOT) * ux + (y - FOOT) * uy) * gradient,
  };
}

function input(moveX: number, moveY: number, tick: number, entityId: number): ServerInput {
  return {
    entityId,
    seq: tick,
    moveX,
    moveY,
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
  };
}

function bodyAt(moveSpeed: number, x: number, y: number, terrain: TerrainSampler): ServerEntity {
  const definition = monsterById('grazer');
  if (!definition) throw new Error('no grazer');
  return spawnEntity(createWorldState(1), {
    kind: EntityKindValue.Monster,
    typeId: 'grazer',
    position: { x, y, z: terrain.heightAt(x, y) },
    stats: { ...definition.stats, moveSpeed },
    radius: definition.radius,
    zoneId: 'greenmarch',
  }).entity;
}

/** How far up the hill a body gets in `seconds`, walking at `approachDeg` off the fall line. */
function climbed(
  moveSpeed: number,
  gradient: number,
  approachDeg = 0,
  seconds = 6,
): { gained: number; travelled: number } {
  const terrain = ramp(gradient);
  let entity = bodyAt(moveSpeed, FOOT, 2000, terrain);
  const start = entity.position;
  const a = (approachDeg * Math.PI) / 180;
  for (let tick = 0; tick < SERVER_TICK_RATE * seconds; tick++) {
    const outcome = resolveMovement(entity, input(Math.cos(a), Math.sin(a), tick, entity.id), {
      world: OPEN,
      terrain,
      config: DEFAULT_LIVE_CONFIG,
      tick,
    });
    entity = { ...entity, position: outcome.position, facing: outcome.facing };
  }
  return {
    gained: entity.position.x - start.x,
    travelled: Math.hypot(entity.position.x - start.x, entity.position.y - start.y),
  };
}

/**
 * True when a body of this speed makes real progress up a hill of this gradient.
 *
 * The bar is a body's own width and then some, so "it shuffled a few units
 * before the grade caught up with it" is not read as climbing.
 */
function walksUp(moveSpeed: number, gradient: number, approachDeg = 0): boolean {
  // Distance travelled, not ground gained: the ground rule is
  // direction-independent, so a body on refused ground cannot move at all, and
  // measuring the gain would report the approach angle instead of the slope.
  return climbed(moveSpeed, gradient, approachDeg).travelled > 60;
}

/** The steepest gradient this body still gets up, to a thousandth. */
function steepest(moveSpeed: number, approachDeg = 0): number {
  let lo = 0;
  let hi = 20;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (walksUp(moveSpeed, mid, approachDeg)) lo = mid;
    else hi = mid;
  }
  return lo;
}

describe('the walk limit is an angle', () => {
  /**
   * The property the rule this replaced failed by 19.3 degrees.
   *
   * Every body samples the ground at its own step length, so the answer is
   * exact only in the limit; a hundredth of a gradient is well inside the band
   * that used to separate a grazer from a body at the speed cap.
   */
  it('stops every body at the same gradient, whatever its speed', () => {
    const speeds = [MOVE_SPEED_HARD_MAX, 155, 95, 40];
    const limits = speeds.map((speed) => steepest(speed));
    for (const limit of limits) expect(limit).toBeCloseTo(MAX_CLIMB_SLOPE, 2);
    // And they agree with each other, which is the same claim said the way the
    // failure would actually read: a 19.3-degree spread was what was there.
    expect(Math.max(...limits) - Math.min(...limits)).toBeLessThan(0.01);
  });

  it('never lets a slower body climb what a faster one cannot', () => {
    const gradient = MAX_CLIMB_SLOPE * 1.2;
    for (const speed of [MOVE_SPEED_HARD_MAX, 155, 95, 40]) {
      expect(walksUp(speed, gradient)).toBe(false);
    }
  });

  it('walks up to the walk angle, climbs past it, and refuses past the ceiling', () => {
    const bands: [number, number][] = [
      [MAX_WALK_SLOPE * 0.9, StepGrade.Walk],
      [(MAX_WALK_SLOPE + MAX_CLIMB_SLOPE) / 2, StepGrade.Climb],
      [MAX_CLIMB_SLOPE * 1.2, StepGrade.Refused],
    ];
    for (const [gradient, want] of bands) {
      const terrain = ramp(gradient);
      const here = { x: 2000, y: 2000, z: terrain.heightAt(2000, 2000) };
      expect(gradeStep(here, 2002, 2000, terrain)).toBe(want);
    }
  });

  it('states the two angles it is enforcing', () => {
    expect(Math.atan(MAX_WALK_SLOPE) * DEG).toBeCloseTo(MAX_WALK_ANGLE_DEG, 6);
    expect(Math.atan(MAX_CLIMB_SLOPE) * DEG).toBeCloseTo(MAX_CLIMB_ANGLE_DEG, 6);
    expect(MAX_WALK_ANGLE_DEG).toBeLessThan(MAX_CLIMB_ANGLE_DEG);
  });

  it('takes the walk limit from the classifier, so walkable ground looks walkable', () => {
    expect(MAX_WALK_SLOPE).toBe(DEFAULT_BANDS.rockSlope);
  });
});

describe('a climb costs pace, not permission', () => {
  it('crosses the climb band, slowly', () => {
    const gradient = (MAX_WALK_SLOPE + MAX_CLIMB_SLOPE) / 2;
    const climbing = climbed(155, gradient);
    const walking = climbed(155, 0);
    expect(climbing.gained).toBeGreaterThan(40);
    expect(climbing.gained).toBeLessThan(walking.gained);
  });

  it('slows by exactly CLIMB_PACE', () => {
    const gradient = (MAX_WALK_SLOPE + MAX_CLIMB_SLOPE) / 2;
    const flat = climbed(155, 0).travelled;
    const uphill = climbed(155, gradient).travelled;
    expect(uphill / flat).toBeCloseTo(CLIMB_PACE, 2);
  });

  it('grades a step of no length as a walk rather than dividing by it', () => {
    const flat: TerrainSampler = { heightAt: () => 100 };
    expect(gradeStep({ x: 5, y: 5, z: 100 }, 5, 5, flat)).toBe(StepGrade.Walk);
  });

  it('gives each grade its own pace, and refuses to move on a refusal', () => {
    expect(paceFor(StepGrade.Walk)).toBe(1);
    expect(paceFor(StepGrade.Climb)).toBe(CLIMB_PACE);
    expect(paceFor(StepGrade.Refused)).toBe(0);
  });
});

describe('a wall is not a hillside', () => {
  /**
   * The traverse that gets a body up a smooth slope gets it nowhere against a
   * jump: the rise does not fall with the approach angle, so the run never
   * grows to meet it.
   */
  it('refuses a discontinuity from every approach angle', () => {
    const wall: TerrainSampler = {
      heightAt: (x: number) => (x < FOOT ? 100 : 100 + MAX_STEP_HEIGHT * 4),
    };
    for (const approach of [0, 30, 60, 80, 88]) {
      const a = (approach * Math.PI) / 180;
      let entity = bodyAt(155, FOOT - 60, 2000, wall);
      for (let tick = 0; tick < SERVER_TICK_RATE * 4; tick++) {
        const outcome = resolveMovement(entity, input(Math.cos(a), Math.sin(a), tick, entity.id), {
          world: OPEN,
          terrain: wall,
          config: DEFAULT_LIVE_CONFIG,
          tick,
        });
        entity = { ...entity, position: outcome.position, facing: outcome.facing };
      }
      expect(entity.position.x).toBeLessThan(FOOT);
    }
  });

  it('lets a body step over a riser shorter than MAX_STEP_HEIGHT', () => {
    const kerb: TerrainSampler = {
      heightAt: (x: number) => (x < FOOT ? 100 : 100 + MAX_STEP_HEIGHT - 1),
    };
    let entity = bodyAt(155, FOOT - 20, 2000, kerb);
    for (let tick = 0; tick < SERVER_TICK_RATE; tick++) {
      const outcome = resolveMovement(entity, input(1, 0, tick, entity.id), {
        world: OPEN,
        terrain: kerb,
        config: DEFAULT_LIVE_CONFIG,
        tick,
      });
      entity = { ...entity, position: outcome.position, facing: outcome.facing };
    }
    expect(entity.position.x).toBeGreaterThan(FOOT);
  });

  /**
   * The two rules do not interfere, as arithmetic rather than as luck: binding
   * the jump rule on smooth ground needs a gradient past `MAX_CLIMB_SLOPE`, so
   * on any ground the grade rule permits it never fires.
   */
  it('never binds the jump rule on ground the grade rule allows', () => {
    const perTick = MOVE_SPEED_HARD_MAX / SERVER_TICK_RATE;
    expect(perTick * MAX_CLIMB_SLOPE).toBeLessThan(MAX_STEP_HEIGHT);
  });
});

// --- the router asks the same question -------------------------------------

function routesUp(gradient: number, aspect: number): boolean {
  const grid = createNavGrid(OPEN, PLAYER_RADIUS, NAV_CELL_SIZE, ramp(gradient, aspect));
  const ux = Math.cos(aspect);
  const uy = Math.sin(aspect);
  const to: Vec2 = { x: 2000 + 300 * ux, y: 2000 + 300 * uy };
  const path = findPath(grid, { x: 2000 - 300 * ux, y: 2000 - 300 * uy }, to);
  const end = path[path.length - 1];
  return end !== undefined && Math.hypot(end.x - to.x, end.y - to.y) <= NAV_CELL_SIZE * 2;
}

function steepestRoute(aspect: number): number {
  let lo = 0;
  let hi = 20;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (routesUp(mid, aspect)) lo = mid;
    else hi = mid;
  }
  return lo;
}

describe('the router', () => {
  /**
   * Before spec 227 one `MAX_STEP_HEIGHT` was applied over a 10-unit run and a
   * 14.14-unit one, so this swung 6.2 degrees on where a fixed world-space
   * lattice happened to fall across the hill.
   */
  it('refuses the same hill whichever way it faces', () => {
    const limits = [0, 15, 30, 45, 60, 75, 90].map((a) => steepestRoute((a * Math.PI) / 180));
    for (const limit of limits) expect(limit).toBeCloseTo(MAX_CLIMB_SLOPE, 0);
    // The whole finding, as a number: this used to swing 6.2 degrees on nothing
    // but where the lattice fell across the hill.
    const swing =
      Math.atan(Math.max(...limits)) * DEG - Math.atan(Math.min(...limits)) * DEG;
    expect(swing).toBeLessThan(1);
  });

  it('answers the same limit movement does', () => {
    expect(steepestRoute(0)).toBeCloseTo(steepest(155), 0);
  });

  it('prefers a level way round to a climb, and takes the climb when there is none', () => {
    // A ridge across the middle with one flat notch through it.
    const NOTCH = { from: 2100, to: 2200 };
    const ridged: NavGround = {
      heightAt: (x: number, y: number) => {
        if (y >= NOTCH.from && y <= NOTCH.to) return 100;
        const into = Math.max(0, 200 - Math.abs(x - 2000));
        return 100 + into * ((MAX_WALK_SLOPE + MAX_CLIMB_SLOPE) / 2);
      },
    };
    const grid = createNavGrid(OPEN, PLAYER_RADIUS, NAV_CELL_SIZE, ridged);
    const path = findPath(grid, { x: 1700, y: 2000 }, { x: 2300, y: 2000 });
    expect(path.length).toBeGreaterThan(0);
    // It arrives, and it does so by going through the notch rather than over
    // the ridge: some waypoint has to leave the straight line to do that.
    const detoured = path.some((p) => p.y > NOTCH.from - NAV_CELL_SIZE);
    expect(detoured).toBe(true);
  });

  it('routes straight over the same ridge when the notch is closed', () => {
    const walled: NavGround = {
      heightAt: (x: number) =>
        100 + Math.max(0, 200 - Math.abs(x - 2000)) * ((MAX_WALK_SLOPE + MAX_CLIMB_SLOPE) / 2),
    };
    const grid = createNavGrid(OPEN, PLAYER_RADIUS, NAV_CELL_SIZE, walled);
    const path = findPath(grid, { x: 1700, y: 2000 }, { x: 2300, y: 2000 });
    expect(path.length).toBeGreaterThan(0);
    const end = path[path.length - 1];
    expect(end?.x).toBeCloseTo(2300, 0);
  });
});

describe('prediction', () => {
  /**
   * `gear-speed.test.ts` asserts this on the flat, where the predictor and the
   * server trivially agree. A climb is a *pace*, so ground with a grade in it is
   * where a client that only knew "walkable" would take a correction every tick.
   */
  it('lands where the server does, over a slope', () => {
    const gradient = (MAX_WALK_SLOPE + MAX_CLIMB_SLOPE) / 2;
    const terrain = ramp(gradient);
    let entity = bodyAt(155, FOOT, 2000, terrain);
    const predict = createWorldPredictor({
      world: OPEN,
      terrain,
      radius: entity.radius,
      speed: entity.stats.moveSpeed,
      tickRate: SERVER_TICK_RATE,
    });
    let predicted: Vec2 = { x: entity.position.x, y: entity.position.y };

    for (let tick = 0; tick < SERVER_TICK_RATE * 3; tick++) {
      const outcome = resolveMovement(entity, input(1, 0, tick, entity.id), {
        world: OPEN,
        terrain,
        config: DEFAULT_LIVE_CONFIG,
        tick,
      });
      entity = { ...entity, position: outcome.position, facing: outcome.facing };
      predicted = predict(predicted, { seq: tick, moveX: 1, moveY: 0, facing: 0, buttons: 0 });
      expect(predicted.x).toBeCloseTo(entity.position.x, 6);
      expect(predicted.y).toBeCloseTo(entity.position.y, 6);
    }
    // And it actually went somewhere, or the agreement is about standing still.
    expect(entity.position.x).toBeGreaterThan(FOOT + 60);
  });
});
