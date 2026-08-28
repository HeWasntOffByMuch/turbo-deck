/**
 * The ground a prediction is allowed to stand on (spec 144).
 *
 * A client that predicts against colliders the server is not using is worse
 * than a client that does not predict at all: the flat guess is wrong in a way
 * corrections fix quietly, while the *confidently wrong* guess walks into a
 * tree that is not there and gets snapped out of open grass. So prediction
 * needs an answer to "do I actually know this ground", and until spec 144
 * nothing asked -- the Play tab imported `maps/arena.json` and assumed.
 *
 * This is that answer, as one mutable holder read through the predictor's
 * closure. Empty means "predict flat", which is the safe direction to be wrong
 * in. It is a holder rather than a value because the predictor closure is built
 * per stats change and the ground arrives on its own schedule; a value would
 * mean rebuilding the closure from a callback that does not own it.
 *
 * Spec 146 replaces `fill` with growth from `StreamedMap` and nothing else
 * moves -- that is what this file is for.
 *
 * Pure: no DOM, no clock, no socket.
 */

import type { WorldColliders } from '../../../sim/types.js';
import type { TerrainSampler } from '../../../server/world/terrain.js';
import { createFlatPredictor, createWorldPredictor, type PredictStep } from '../../../server/client/prediction.js';

/**
 * What is known about the ground right now. Both fields move together -- there
 * is no useful state where the colliders are known and the heightfield is not.
 */
export interface PredictionGround {
  colliders: WorldColliders | null;
  terrain: TerrainSampler | null;
}

export function emptyGround(): PredictionGround {
  return { colliders: null, terrain: null };
}

export function fillGround(
  ground: PredictionGround,
  colliders: WorldColliders,
  terrain: TerrainSampler,
): void {
  ground.colliders = colliders;
  ground.terrain = terrain;
}

export function hasGround(ground: PredictionGround): boolean {
  return ground.colliders !== null && ground.terrain !== null;
}

/**
 * A predictor that consults the holder on every step.
 *
 * The two branches are the existing predictors unchanged, which is the point:
 * with the ground filled this is exactly `createWorldPredictor` and the spec
 * 063 tests still describe it; empty, it is exactly `createFlatPredictor` and
 * the client behaves as it does with no predictor passed at all. There is no
 * third behaviour to reason about, and no half-known world to get subtly wrong.
 */
export function createGroundPredictor(options: {
  readonly ground: PredictionGround;
  readonly radius: number;
  readonly speed: number;
  readonly tickRate: number;
}): PredictStep {
  const flat = createFlatPredictor(options.speed, options.tickRate);
  // Rebuilt only when the holder's identity changes, so a filled ground costs
  // one construction rather than one per tick. `navGridFor` memoizes on the
  // colliders' object identity too -- see spec 146, where that becomes the
  // hard part.
  let cached: { colliders: WorldColliders; terrain: TerrainSampler; step: PredictStep } | null = null;

  return (from, input) => {
    const { colliders, terrain } = options.ground;
    if (colliders === null || terrain === null) return flat(from, input);
    if (cached === null || cached.colliders !== colliders || cached.terrain !== terrain) {
      cached = {
        colliders,
        terrain,
        step: createWorldPredictor({
          world: colliders,
          terrain,
          radius: options.radius,
          speed: options.speed,
          tickRate: options.tickRate,
        }),
      };
    }
    return cached.step(from, input);
  };
}
