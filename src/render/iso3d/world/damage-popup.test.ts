import { describe, expect, it } from 'vitest';
import {
  DamagePopups,
  NUMBER_LANES,
  NUMBER_LIFE,
  NUMBER_RISE,
  XP_DRIFT,
  XP_LEAD,
  XP_RISE,
  type PopupPlacement,
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

/**
 * The experience number's path (spec 183).
 *
 * Every one of these is about the *pair*: the reward is spawned on the same
 * tick, on the same body, from the same anchor as the killing blow's number, so
 * what is being asserted is never where the reward is on its own -- it is how
 * far it is from the thing it must not be mistaken for.
 */
describe('the experience trail', () => {
  /** Every frame of one popup's life, keyed so a pair can be walked together. */
  function fly(popups: DamagePopups, project: Projector): PopupPlacement[][] {
    const frames: PopupPlacement[][] = [];
    for (let frame = 0; frame < NUMBER_LIFE - 1; frame++) {
      frames.push([...popups.step(project).live]);
    }
    return frames;
  }

  it('never shares a place with the damage number it was earned by', () => {
    const popups = new DamagePopups();
    const view = camera();
    const at = { x: 0, y: 0, lift: 0 };
    const blow = popups.add(7, at).id;
    const reward = popups.add(7, at, 'xp').id;

    let previousGap = -1;
    for (const frame of fly(popups, view.project)) {
      const damage = frame.find((placement) => placement.id === blow);
      const xp = frame.find((placement) => placement.id === reward);
      if (!damage || !xp) throw new Error('a number went missing mid-life');
      expect(Math.hypot(xp.left - damage.left, xp.top - damage.top)).toBeGreaterThan(1);
      // And the horizontal gap only ever grows: two numbers that separate and
      // then converge are two numbers that cross.
      const gap = Math.abs(xp.left - damage.left);
      expect(gap).toBeGreaterThan(previousGap);
      previousGap = gap;
    }
    expect(previousGap).toBeGreaterThan(XP_LEAD + XP_DRIFT / 2);
  });

  it('sweeps away from the side the body’s last damage lane took', () => {
    const view = camera();
    const at = { x: 0, y: 0, lift: 0 };

    /** Where the popup `id` is a few frames into its sweep. */
    const swept = (popups: DamagePopups, id: number): number => {
      let where = 0;
      for (let frame = 0; frame < 8; frame++) {
        where = popups.step(view.project).live.find((p) => p.id === id)?.left ?? 0;
      }
      return where;
    };

    // Lane 1 is the left one, so the reward goes right.
    const left = new DamagePopups();
    left.add(7, at);
    left.add(7, at); // lane 1: x < 0
    const rightward = left.add(7, at, 'xp').id;
    expect(NUMBER_LANES[1]?.x).toBeLessThan(0);
    expect(swept(left, rightward)).toBeGreaterThan(0);

    // Lane 2 is the right one, so the reward goes left.
    const right = new DamagePopups();
    right.add(9, at);
    right.add(9, at);
    right.add(9, at); // lane 2: x > 0
    const leftward = right.add(9, at, 'xp').id;
    expect(NUMBER_LANES[2]?.x).toBeGreaterThan(0);
    expect(swept(right, leftward)).toBeLessThan(0);
  });

  it('picks a side with no damage before it, and leaves the centre lane free', () => {
    const popups = new DamagePopups();
    const view = camera();
    popups.add(7, { x: 0, y: 0, lift: 0 }, 'xp');
    // Clear of the centre lane on the very first frame, which is the frame the
    // blow that earned it is at its most legible.
    expect(Math.abs(only(popups.step(view.project)).left)).toBeGreaterThanOrEqual(XP_LEAD);
  });

  it('does not consume a damage lane, so the next blow lands where it would have', () => {
    const popups = new DamagePopups();
    const view = camera();
    const at = { x: 0, y: 0, lift: 0 };
    popups.add(7, at); // lane 0
    popups.add(7, at, 'xp');
    popups.add(7, at); // must still be lane 1

    const step = popups.step(view.project);
    const second = step.live.find((placement) => placement.id === 3);
    expect(second?.left).toBeCloseTo(NUMBER_LANES[1]?.x ?? 0);
  });

  it('alternates the side for two rewards on one body', () => {
    const popups = new DamagePopups();
    const view = camera();
    const at = { x: 0, y: 0, lift: 0 };
    popups.add(7, at, 'xp');
    popups.add(7, at, 'xp');
    for (let frame = 0; frame < 8; frame++) popups.step(view.project);
    const step = popups.step(view.project);
    const [first, second] = step.live.map((placement) => placement.left).sort((a, b) => a - b);
    expect(first ?? 0).toBeLessThan(0);
    expect(second ?? 0).toBeGreaterThan(0);
  });

  it('rises on an ease-out where a blow’s number rises linearly', () => {
    const popups = new DamagePopups();
    const view = camera();
    popups.add(7, { x: 0, y: 0, lift: 0 }, 'xp');

    let top = 0;
    for (let frame = 0; frame < NUMBER_LIFE / 2; frame++) {
      top = only(popups.step(view.project)).top;
    }
    // Half the life spent, and well past half the climb -- which is the whole
    // difference from `NUMBER_RISE`'s straight line, asserted at exactly the
    // frame the damage test asserts its own midpoint.
    expect(-top).toBeGreaterThan(XP_RISE * 0.6);
    expect(-top).toBeLessThan(XP_RISE);
  });

  it('counts against the one capacity and expires through the one path', () => {
    const popups = new DamagePopups();
    const view = camera();
    const at = { x: 0, y: 0, lift: 0 };
    for (let hit = 0; hit < 20; hit++) {
      popups.add(hit, at);
      popups.add(hit, at, 'xp');
    }
    expect(popups.count).toBe(40);
    // One more of either kind evicts the oldest, whichever kind that was.
    expect(popups.add(99, at, 'xp').expired).toHaveLength(1);
    expect(popups.count).toBe(40);

    for (let frame = 0; frame <= NUMBER_LIFE; frame++) popups.step(view.project);
    expect(popups.count).toBe(0);
  });
});
