/**
 * Prediction fails safe on ground it does not have (spec 144).
 *
 * The property that matters is not "it does something sensible" -- it is that
 * the two branches are *exactly* the two predictors that already exist and
 * already have tests. An empty ground must be `createFlatPredictor` to the last
 * bit, and a filled one must be `createWorldPredictor` to the last bit, because
 * anything in between would be a third behaviour nobody has characterised.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createFlatPredictor,
  createWorldPredictor,
  type PredictStep,
} from '../../../server/client/prediction.js';
import { buildWorldFromMap } from '../../../server/world/build.js';
import { parseMap } from '../../../terrain/map.js';
import { SERVER_PLAYER_RADIUS, SERVER_TICK_RATE } from '../../../server/config.js';
import { createGroundPredictor, emptyGround, fillGround, hasGround } from './prediction-ground.js';

const mapText = readFileSync(new URL('../../../../maps/arena.json', import.meta.url), 'utf8');
const world = buildWorldFromMap(parseMap(mapText), mapText);

const SPEED = 220;

/** A spiral, so the walk crosses open ground, trees and the shoreline alike. */
function walk(step: PredictStep): { x: number; y: number }[] {
  let at = { x: 600, y: 450 };
  const path: { x: number; y: number }[] = [];
  for (let i = 0; i < 600; i++) {
    const angle = i * 0.05;
    at = step(at, { seq: i, moveX: Math.cos(angle), moveY: Math.sin(angle), facing: angle, buttons: 0 });
    path.push(at);
  }
  return path;
}

describe('createGroundPredictor', () => {
  it('is the flat predictor exactly, while the ground is unknown', () => {
    const ground = emptyGround();
    expect(hasGround(ground)).toBe(false);
    const mine = createGroundPredictor({ ground, radius: SERVER_PLAYER_RADIUS, speed: SPEED, tickRate: SERVER_TICK_RATE });
    const flat = createFlatPredictor(SPEED, SERVER_TICK_RATE);
    expect(walk(mine)).toEqual(walk(flat));
  });

  it('is the world predictor exactly, once the ground is known', () => {
    const ground = emptyGround();
    fillGround(ground, world.colliders, world.sampler);
    expect(hasGround(ground)).toBe(true);
    const mine = createGroundPredictor({ ground, radius: SERVER_PLAYER_RADIUS, speed: SPEED, tickRate: SERVER_TICK_RATE });
    const real = createWorldPredictor({
      world: world.colliders,
      terrain: world.sampler,
      radius: SERVER_PLAYER_RADIUS,
      speed: SPEED,
      tickRate: SERVER_TICK_RATE,
    });
    expect(walk(mine)).toEqual(walk(real));
  });

  it('switches the instant the ground arrives, without being rebuilt', () => {
    const ground = emptyGround();
    const step = createGroundPredictor({ ground, radius: SERVER_PLAYER_RADIUS, speed: SPEED, tickRate: SERVER_TICK_RATE });
    const input = { seq: 1, moveX: 1, moveY: 0, facing: 0, buttons: 0 };
    // A point a tree stands on: flat walks through it, the world predictor does not.
    const from = { x: 600, y: 450 };
    const before = step(from, input);
    fillGround(ground, world.colliders, world.sampler);
    const after = step(from, input);
    // The same closure, two different behaviours -- which is the whole reason
    // the ground is a holder rather than a value.
    expect(before).toEqual(createFlatPredictor(SPEED, SERVER_TICK_RATE)(from, input));
    expect(after).toEqual(
      createWorldPredictor({
        world: world.colliders,
        terrain: world.sampler,
        radius: SERVER_PLAYER_RADIUS,
        speed: SPEED,
        tickRate: SERVER_TICK_RATE,
      })(from, input),
    );
  });

  it('stands still for a zero input either way', () => {
    const ground = emptyGround();
    const step = createGroundPredictor({ ground, radius: SERVER_PLAYER_RADIUS, speed: SPEED, tickRate: SERVER_TICK_RATE });
    const from = { x: 600, y: 450 };
    const zero = { seq: 1, moveX: 0, moveY: 0, facing: 0, buttons: 0 };
    expect(step(from, zero)).toBe(from);
    fillGround(ground, world.colliders, world.sampler);
    expect(step(from, zero)).toBe(from);
  });
});
