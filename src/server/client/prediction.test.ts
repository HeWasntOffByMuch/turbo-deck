import { describe, expect, it } from 'vitest';
import { SERVER_TICK_RATE } from '../config.js';
import { createFlatPredictor, PredictionBuffer, type PredictedInput } from './prediction.js';

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
