import { describe, expect, it } from 'vitest';
import {
  DamagePopups,
  NUMBER_LANES,
  NUMBER_LIFE,
  NUMBER_RISE,
  type Projector,
} from './damage-popup.js';

/**
 * A stand-in camera: world x/z straight through to pixels, offset by wherever
 * the camera currently is. Panning it is one assignment, which is the whole
 * point of the test -- a world-anchored number must move *with* the world.
 */
function camera(): {
  project: Projector;
  pan(dx: number, dy: number): void;
  asked: { x: number; y: number; lift: number }[];
} {
  let offsetX = 0;
  let offsetY = 0;
  const asked: { x: number; y: number; lift: number }[] = [];
  return {
    project: (x, y, lift) => {
      asked.push({ x, y, lift });
      return { x: x - offsetX, y: y - offsetY - lift, onScreen: true };
    },
    pan(dx, dy) {
      offsetX += dx;
      offsetY += dy;
    },
    asked,
  };
}

/** The one placement in a step, for the many tests that only spawn one. */
function only(step: { live: readonly { left: number; top: number }[] }): {
  left: number;
  top: number;
} {
  expect(step.live).toHaveLength(1);
  const placement = step.live[0];
  if (!placement) throw new Error('no placement');
  return placement;
}

describe('DamagePopups', () => {
  it('places a number at the projection of the world point it was given', () => {
    const popups = new DamagePopups();
    const view = camera();
    popups.add(7, { x: 120, y: -40, lift: 46 });

    const placement = only(popups.step(view.project));
    // One frame of life spent, so the rise has begun but nothing else has moved.
    const risen = (1 / NUMBER_LIFE) * NUMBER_RISE;
    expect(placement.left).toBeCloseTo(120);
    expect(placement.top).toBeCloseTo(-40 - 46 - risen);
  });

  it('moves with the world when the camera pans, not with the glass', () => {
    const popups = new DamagePopups();
    const view = camera();
    popups.add(7, { x: 100, y: 100, lift: 40 });

    const before = only(popups.step(view.project));
    view.pan(60, 25);
    const after = only(popups.step(view.project));

    // The camera moved right and down by (60, 25); the mark on the ground did
    // not, so it comes back that much further left and up.
    expect(after.left - before.left).toBeCloseTo(-60);
    const risen = (1 / NUMBER_LIFE) * NUMBER_RISE;
    expect(after.top - before.top).toBeCloseTo(-25 - risen);
  });

  it('never asks about anything but the world point it was handed', () => {
    const popups = new DamagePopups();
    const view = camera();
    popups.add(7, { x: 12, y: 34, lift: 46 });

    // The body dies, despawns, and is never mentioned again -- which is exactly
    // what these ten frames are.
    for (let frame = 0; frame < 10; frame++) popups.step(view.project);

    expect(view.asked).toHaveLength(10);
    for (const ask of view.asked) expect(ask).toEqual({ x: 12, y: 34, lift: 46 });
  });

  it('is unaffected by a later hit on the same body somewhere else', () => {
    const popups = new DamagePopups();
    const view = camera();
    popups.add(7, { x: 0, y: 0, lift: 0 });
    popups.step(view.project);
    popups.add(7, { x: 500, y: 500, lift: 0 });

    const step = popups.step(view.project);
    expect(step.live).toHaveLength(2);
    const first = step.live.find((placement) => placement.left < 100);
    expect(first?.left).toBeCloseTo(0);
  });

  it('rises and fades over its life, then expires exactly once', () => {
    const popups = new DamagePopups();
    const view = camera();
    popups.add(1, { x: 0, y: 0, lift: 0 });

    const first = popups.step(view.project);
    expect(first.live[0]?.opacity).toBeCloseTo(1 - 1 / NUMBER_LIFE);

    let expiredOn = -1;
    for (let frame = 2; frame <= NUMBER_LIFE + 4; frame++) {
      const step = popups.step(view.project);
      if (step.expired.length > 0) {
        expect(expiredOn).toBe(-1);
        expect(step.expired).toEqual([1]);
        expiredOn = frame;
      }
    }
    expect(expiredOn).toBe(NUMBER_LIFE);
    expect(popups.count).toBe(0);

    // Halfway through, halfway up.
    const later = new DamagePopups();
    later.add(1, { x: 0, y: 0, lift: 0 });
    let top = 0;
    for (let frame = 0; frame < NUMBER_LIFE / 2; frame++) {
      top = later.step(view.project).live[0]?.top ?? 0;
    }
    expect(top).toBeCloseTo(-NUMBER_RISE / 2);
  });

  it('fans numbers on one body out through the lanes', () => {
    const popups = new DamagePopups();
    const view = camera();
    // One hit per lane, all on the same body and all in the same spot.
    NUMBER_LANES.forEach(() => popups.add(7, { x: 0, y: 0, lift: 0 }));

    const step = popups.step(view.project);
    const lefts = step.live.map((placement) => placement.left).sort((a, b) => a - b);
    const expected = NUMBER_LANES.map((lane) => lane.x).sort((a, b) => a - b);
    expect(lefts).toEqual(expected);
  });

  it('gives two different bodies their own lane cycle', () => {
    const popups = new DamagePopups();
    const view = camera();
    popups.add(7, { x: 0, y: 0, lift: 0 });
    popups.add(9, { x: 0, y: 0, lift: 0 });

    const step = popups.step(view.project);
    // Both are the first hit on their body, so both take the centre lane.
    expect(step.live.map((placement) => placement.left)).toEqual([0, 0]);
  });

  it('starts a fresh burst centred once the old one has gone', () => {
    const popups = new DamagePopups();
    const view = camera();
    popups.add(7, { x: 0, y: 0, lift: 0 });
    popups.add(7, { x: 0, y: 0, lift: 0 });
    for (let frame = 0; frame <= NUMBER_LIFE; frame++) popups.step(view.project);
    expect(popups.count).toBe(0);

    popups.add(7, { x: 0, y: 0, lift: 0 });
    expect(only(popups.step(view.project)).left).toBeCloseTo(NUMBER_LANES[0]?.x ?? 0);
  });

  it('evicts the oldest past capacity and says which id went', () => {
    const popups = new DamagePopups();
    const ids: number[] = [];
    for (let hit = 0; hit < 41; hit++) {
      const added = popups.add(hit, { x: 0, y: 0, lift: 0 });
      ids.push(added.id);
      if (hit < 40) expect(added.expired).toEqual([]);
      else expect(added.expired).toEqual([ids[0]]);
    }
    expect(popups.count).toBe(40);
  });

  it('reports a number whose world point is off screen', () => {
    const popups = new DamagePopups();
    popups.add(1, { x: 0, y: 0, lift: 0 });
    const step = popups.step(() => ({ x: -9000, y: -9000, onScreen: false }));
    expect(step.live[0]?.onScreen).toBe(false);
  });
});
