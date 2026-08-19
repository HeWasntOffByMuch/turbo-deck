import { describe, expect, it } from 'vitest';
import { buildWorld } from '../world/build.js';
import { circleBlocked } from '../../sim/collision.js';
import { SERVER_TICK_RATE } from '../config.js';
import {
  createFlatPredictor,
  createWorldPredictor,
  PredictionBuffer,
  type PredictedInput,
} from './prediction.js';

const SPEED = 200;
const PER_TICK = SPEED / SERVER_TICK_RATE;

function input(seq: number, moveX = 1, moveY = 0): PredictedInput {
  return { seq, moveX, moveY, facing: 0, buttons: 0 };
}

function buffer(x = 0, y = 0): PredictionBuffer {
  return new PredictionBuffer({ x, y }, createFlatPredictor(SPEED, SERVER_TICK_RATE));
}

describe('local prediction', () => {
  it('moves one tick of speed per input', () => {
    const local = buffer();
    expect(local.apply(input(1)).x).toBeCloseTo(PER_TICK, 9);
    expect(local.apply(input(2)).x).toBeCloseTo(PER_TICK * 2, 9);
  });

  it('normalises an over-long direction, exactly as the server does', () => {
    const local = buffer();
    local.apply(input(1, 100, 0));
    expect(local.position.x).toBeCloseTo(PER_TICK, 9);
  });

  it('stands still for a zero input', () => {
    const local = buffer(5, 5);
    expect(local.apply(input(1, 0, 0))).toEqual({ x: 5, y: 5 });
  });
});

describe('acknowledgement', () => {
  it('keeps only the inputs the server has not accounted for', () => {
    const local = buffer();
    for (let seq = 1; seq <= 5; seq++) local.apply(input(seq));
    expect(local.pending).toHaveLength(5);

    local.acknowledge(3);
    expect(local.pending.map((i) => i.seq)).toEqual([4, 5]);

    local.acknowledge(5);
    expect(local.pending).toEqual([]);
  });

  it('does not move the local position -- an ack is not a correction', () => {
    const local = buffer();
    for (let seq = 1; seq <= 5; seq++) local.apply(input(seq));
    const before = local.position;
    local.acknowledge(5);
    expect(local.position).toEqual(before);
    expect(local.correctionCount).toBe(0);
  });
});

describe('reconciliation', () => {
  it('snaps to the server position and replays what came after it', () => {
    const local = buffer();
    for (let seq = 1; seq <= 5; seq++) local.apply(input(seq));

    // The server says that as of input 2 we were actually at x = 1000.
    // Inputs 3, 4 and 5 have not been accounted for and must survive.
    const settled = local.reconcile(2, { x: 1000, y: 0 });
    expect(settled.x).toBeCloseTo(1000 + PER_TICK * 3, 9);
    expect(local.pending.map((i) => i.seq)).toEqual([3, 4, 5]);
  });

  it('does not lose the player their last few inputs', () => {
    // The failure this exists to prevent: snapping to a correction that
    // describes the world several ticks ago, and dropping everything since.
    const local = buffer();
    for (let seq = 1; seq <= 10; seq++) local.apply(input(seq, 0, 1));
    const naiveSnap = { x: 0, y: 3 * PER_TICK };
    const settled = local.reconcile(3, naiveSnap);
    expect(settled.y).toBeCloseTo(PER_TICK * 10, 9);
  });

  it('can be corrected twice over the same unacknowledged inputs', () => {
    const local = buffer();
    for (let seq = 1; seq <= 4; seq++) local.apply(input(seq));

    local.reconcile(1, { x: 500, y: 0 });
    expect(local.position.x).toBeCloseTo(500 + PER_TICK * 3, 9);

    // A second correction for the same tick arrives; the replay must still work.
    local.reconcile(1, { x: 700, y: 0 });
    expect(local.position.x).toBeCloseTo(700 + PER_TICK * 3, 9);
    expect(local.correctionCount).toBe(2);
  });

  it('lands exactly on the server position when nothing is outstanding', () => {
    const local = buffer();
    for (let seq = 1; seq <= 3; seq++) local.apply(input(seq));
    local.acknowledge(3);
    expect(local.reconcile(3, { x: 42, y: -7 })).toEqual({ x: 42, y: -7 });
  });

  it('measures divergence, which is what decides whether any of this is needed', () => {
    const local = buffer();
    local.apply(input(1));
    expect(local.divergenceFrom({ x: PER_TICK, y: 0 })).toBeCloseTo(0, 9);
    expect(local.divergenceFrom({ x: PER_TICK + 3, y: 4 })).toBeCloseTo(5, 9);
  });
});

/**
 * Spec 063. The flat predictor walks through walls and lets the server put it
 * back, which is invisible on empty ground and unacceptable once the renderer
 * draws the forest the server is colliding against.
 */
describe('predicting against the real world', () => {
  const world = buildWorld(9);
  const RADIUS = 16;

  const aware = createWorldPredictor({
    world: world.colliders,
    terrain: world.sampler,
    radius: RADIUS,
    speed: SPEED,
    tickRate: SERVER_TICK_RATE,
  });
  const flat = createFlatPredictor(SPEED, SERVER_TICK_RATE);

  /** How far the open-ground walks below travel, and the clearance they need. */
  const WALK_TICKS = 20;
  const WALK_LENGTH = (WALK_TICKS * SPEED) / SERVER_TICK_RATE;

  /** A spot with room to walk `WALK_LENGTH` in any direction and hit nothing. */
  function openGround(): { x: number; y: number } {
    for (let x = -1200; x < 2400; x += 20) {
      for (let y = -1200; y < 2100; y += 20) {
        const at = { x, y };
        if (circleBlocked(at, RADIUS + WALK_LENGTH + 8, world.colliders)) continue;
        // Flat enough that the heightfield half never refuses a step either.
        let walkable = true;
        for (let d = 0; d <= WALK_LENGTH + 8 && walkable; d += 8) {
          walkable =
            Math.abs(world.sampler.heightAt(x + d, y) - world.sampler.heightAt(x, y)) < 4 &&
            Math.abs(world.sampler.heightAt(x, y + d) - world.sampler.heightAt(x, y)) < 4;
        }
        if (walkable) return at;
      }
    }
    throw new Error('the world has nowhere open to walk');
  }

  it('agrees with the flat predictor step for step on open ground', () => {
    const open = openGround();
    let flatAt = open;
    let awareAt = open;
    for (let seq = 1; seq <= WALK_TICKS; seq++) {
      flatAt = flat(flatAt, input(seq, 1, 0));
      awareAt = aware(awareAt, input(seq, 1, 0));
      // Silence is the whole point: where nothing is in the way, the extra
      // knowledge must change nothing at all.
      expect(awareAt.x).toBeCloseTo(flatAt.x, 9);
      expect(awareAt.y).toBeCloseTo(flatAt.y, 9);
    }
  });

  it('refuses to walk into a tree the server would stop it at', () => {
    const tree = world.props[0];
    expect(tree).toBeDefined();
    if (!tree) return;

    // Start clear of the trunk and walk straight at it, stopping when a flat
    // guess would be standing in its centre.
    const distance = 120;
    const start = { x: tree.x - distance, y: tree.y };
    const ticks = Math.round(distance / (SPEED / SERVER_TICK_RATE));

    let flatAt = start;
    let awareAt = start;
    for (let seq = 1; seq <= ticks; seq++) {
      flatAt = flat(flatAt, input(seq, 1, 0));
      awareAt = aware(awareAt, input(seq, 1, 0));
    }

    expect(circleBlocked(flatAt, RADIUS, world.colliders)).toBe(true);
    expect(circleBlocked(awareAt, RADIUS, world.colliders)).toBe(false);
    // It got somewhere -- stopping at the trunk, not refusing to set off.
    expect(awareAt.x).toBeGreaterThan(start.x);
    expect(awareAt.x).toBeLessThan(flatAt.x);
  });

  it('never predicts a position the colliders forbid', () => {
    let at = openGround();
    for (let seq = 1; seq <= 600; seq++) {
      const angle = seq * 0.11;
      at = aware(at, { seq, moveX: Math.cos(angle), moveY: Math.sin(angle), facing: 0, buttons: 0 });
      expect(circleBlocked(at, RADIUS, world.colliders)).toBe(false);
    }
  });
});

describe('easing a drift correction (spec 067)', () => {
  it('adopts the server\'s answer exactly, and only the drawing lags', () => {
    const local = buffer();
    for (let seq = 1; seq <= 4; seq++) local.apply(input(seq));

    // The server says input 2 ended a whole step short of where we had it.
    local.reconcile(2, { x: PER_TICK, y: 0 }, { eased: true });

    // State: authoritative, plus the two inputs it has not acknowledged.
    expect(local.position.x).toBeCloseTo(PER_TICK * 3, 9);
    // Picture: still where the body was, so nothing jumps.
    expect(local.drawn.x).toBeCloseTo(PER_TICK * 4, 9);
  });

  it('converges the drawn position onto the predicted one', () => {
    const local = buffer();
    for (let seq = 1; seq <= 4; seq++) local.apply(input(seq));
    local.reconcile(2, { x: PER_TICK, y: 0 }, { eased: true });

    let previous = local.easing;
    expect(previous).toBeGreaterThan(0);
    for (let tick = 0; tick < 40; tick++) {
      local.decay();
      expect(local.easing).toBeLessThanOrEqual(previous);
      previous = local.easing;
    }
    expect(local.easing).toBe(0);
    expect(local.drawn).toEqual(local.position);
  });

  it('snaps rather than eases when the correction is a hard one', () => {
    const local = buffer();
    for (let seq = 1; seq <= 4; seq++) local.apply(input(seq));
    local.reconcile(2, { x: PER_TICK, y: 0 });
    expect(local.easing).toBe(0);
    expect(local.drawn).toEqual(local.position);
  });

  it('refuses to ease a correction too large to be drift', () => {
    const local = buffer();
    for (let seq = 1; seq <= 4; seq++) local.apply(input(seq));
    // Somewhere else entirely: a teleport should look like one.
    local.reconcile(2, { x: 5000, y: 5000 }, { eased: true });
    expect(local.easing).toBe(0);
  });

  it('keeps a second correction from restarting the glide', () => {
    const local = buffer();
    for (let seq = 1; seq <= 4; seq++) local.apply(input(seq));
    local.reconcile(2, { x: PER_TICK, y: 0 }, { eased: true });
    const drawnBefore = local.drawn;
    local.decay();
    // A second correction for the same disagreement, describing the same place.
    local.reconcile(3, { x: PER_TICK * 2, y: 0 }, { eased: true });
    // The picture carries on from where it was rather than jumping back.
    expect(local.drawn.x).toBeLessThanOrEqual(drawnBefore.x + 1e-9);
    expect(local.position.x).toBeCloseTo(PER_TICK * 3, 9);
  });
});

describe('a slow the client has been told about (spec 188)', () => {
  /**
   * The one thing that keeps a two-and-a-half-second slow from being a
   * correction every tick for its whole duration: the scale rides the *input*,
   * so the client walks at the speed the server is walking it at.
   */
  it('shortens the step by the scale the input carries', () => {
    const step = createFlatPredictor(60, 60);
    const from = { x: 0, y: 0 };
    const full = step(from, { seq: 1, moveX: 1, moveY: 0, facing: 0, buttons: 0 });
    const slowed = step(from, { seq: 1, moveX: 1, moveY: 0, facing: 0, buttons: 0, moveScale: 0.6 });
    expect(full.x).toBeCloseTo(1, 6);
    expect(slowed.x).toBeCloseTo(0.6, 6);
  });

  /**
   * A replay after a correction walks each buffered input at the speed that
   * applied when it was *made*, which is why the scale is on the input rather
   * than baked into the predictor when it is built.
   */
  it('replays each input at its own scale rather than at the latest one', () => {
    const buffer = new PredictionBuffer({ x: 0, y: 0 }, createFlatPredictor(60, 60));
    buffer.apply({ seq: 1, moveX: 1, moveY: 0, facing: 0, buttons: 0, moveScale: 0.5 });
    buffer.apply({ seq: 2, moveX: 1, moveY: 0, facing: 0, buttons: 0, moveScale: 1 });
    expect(buffer.position.x).toBeCloseTo(1.5, 6);
    // Corrected as of input 1, then input 2 replayed -- at *its* scale.
    buffer.reconcile(1, { x: 10, y: 0 });
    expect(buffer.position.x).toBeCloseTo(11, 6);
  });
});
