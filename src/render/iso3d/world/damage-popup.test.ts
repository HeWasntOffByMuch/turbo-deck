import { describe, expect, it } from 'vitest';
import {
  DamagePopups,
  NUMBER_LANES,
  NUMBER_LIFE,
  NUMBER_RISE,
  XP_GAP,
  XP_LIFE,
  XP_RISE,
  XP_STACK,
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
 * it sits against the thing it was earned by.
 */
describe('the experience trail', () => {
  const at = { x: 0, y: 0, lift: 0 };

  it('sits directly under the blow’s number and holds station there', () => {
    const popups = new DamagePopups();
    const view = camera();
    const blow = popups.add(7, at).id;
    const reward = popups.add(7, at, 'xp').id;

    // For every frame the blow is alive, the reward is in its column, a fixed
    // gap below. A rate that differed would have the two converge or separate,
    // which is the diagonal's problem in another direction.
    for (let frame = 0; frame < NUMBER_LIFE - 1; frame++) {
      const live = popups.step(view.project).live;
      const damage = live.find((placement) => placement.id === blow);
      const xp = live.find((placement) => placement.id === reward);
      if (!damage || !xp) throw new Error('a number went missing mid-life');
      expect(xp.left).toBeCloseTo(damage.left);
      expect(xp.top - damage.top).toBeCloseTo(XP_GAP);
    }
  });

  it('takes the lane the body’s last blow took, not a lane of its own', () => {
    const view = camera();
    for (const lane of [1, 2, 3]) {
      const popups = new DamagePopups();
      for (let hit = 0; hit <= lane; hit++) popups.add(7, at);
      const reward = popups.add(7, at, 'xp').id;
      const placement = popups.step(view.project).live.find((p) => p.id === reward);
      expect(placement?.left).toBeCloseTo(NUMBER_LANES[lane]?.x ?? 0);
    }
  });

  it('takes the centre lane when nothing hit the body first', () => {
    const popups = new DamagePopups();
    const view = camera();
    popups.add(7, at, 'xp');
    expect(only(popups.step(view.project)).left).toBeCloseTo(NUMBER_LANES[0]?.x ?? 0);
  });

  it('outlives the blow above it by half a second, still climbing', () => {
    const popups = new DamagePopups();
    const view = camera();
    const blow = popups.add(7, at).id;
    const reward = popups.add(7, at, 'xp').id;

    // A blow's number is gone on its own schedule; nothing about the reward
    // moved with it.
    for (let frame = 0; frame < NUMBER_LIFE; frame++) popups.step(view.project);
    expect(popups.count).toBe(1);

    let last = Number.POSITIVE_INFINITY;
    let alive = 0;
    for (let frame = 0; frame < XP_LIFE; frame++) {
      const placement = popups.step(view.project).live[0];
      if (!placement) break;
      expect(placement.id).toBe(reward);
      expect(placement.top).toBeLessThan(last);
      last = placement.top;
      alive += 1;
    }
    // Half a second at 60fps, and it spends all of it rising.
    expect(alive).toBe(XP_LIFE - NUMBER_LIFE - 1);
    expect(blow).toBeLessThan(reward);
    expect(popups.count).toBe(0);
  });

  it('rises at the blow’s own rate, for longer', () => {
    const popups = new DamagePopups();
    const view = camera();
    popups.add(7, at, 'xp');
    let top = 0;
    for (let frame = 0; frame < NUMBER_LIFE; frame++) {
      top = only(popups.step(view.project)).top;
    }
    // A whole damage-number's life spent, so a whole damage-number's rise --
    // measured from the gap it started at.
    expect(XP_GAP - top).toBeCloseTo(NUMBER_RISE);
  });

  it('stacks two rewards on one body rather than piling them up', () => {
    const popups = new DamagePopups();
    const view = camera();
    popups.add(7, at, 'xp');
    popups.add(7, at, 'xp');
    const tops = popups
      .step(view.project)
      .live.map((placement) => placement.top)
      .sort((a, b) => a - b);
    expect((tops[1] ?? 0) - (tops[0] ?? 0)).toBeCloseTo(XP_GAP);
    // And the stack starts over rather than walking off the bottom of the world.
    const deep = new DamagePopups();
    for (let reward = 0; reward < XP_STACK + 1; reward++) deep.add(9, at, 'xp');
    const lows = deep.step(view.project).live.map((placement) => placement.top);
    expect(Math.max(...lows) - Math.min(...lows)).toBeCloseTo(XP_GAP * (XP_STACK - 1));
  });

  it('does not consume a damage lane, so the next blow lands where it would have', () => {
    const popups = new DamagePopups();
    const view = camera();
    popups.add(7, at); // lane 0
    popups.add(7, at, 'xp');
    const second = popups.add(7, at).id; // must still be lane 1

    const placement = popups.step(view.project).live.find((p) => p.id === second);
    expect(placement?.left).toBeCloseTo(NUMBER_LANES[1]?.x ?? 0);
  });

  it('counts against the one capacity and expires through the one path', () => {
    const popups = new DamagePopups();
    const view = camera();
    for (let hit = 0; hit < 20; hit++) {
      popups.add(hit, at);
      popups.add(hit, at, 'xp');
    }
    expect(popups.count).toBe(40);
    // One more of either kind evicts the oldest, whichever kind that was.
    expect(popups.add(99, at, 'xp').expired).toHaveLength(1);
    expect(popups.count).toBe(40);

    for (let frame = 0; frame <= XP_LIFE; frame++) popups.step(view.project);
    expect(popups.count).toBe(0);
  });

  it('leaves a blow’s own numbers exactly as spec 096 had them', () => {
    const popups = new DamagePopups();
    const view = camera();
    popups.add(7, at, 'xp');
    popups.add(7, at);
    let top = 0;
    for (let frame = 0; frame < NUMBER_LIFE / 2; frame++) {
      top = popups.step(view.project).live.find((p) => p.id === 2)?.top ?? 0;
    }
    expect(top).toBeCloseTo(-NUMBER_RISE / 2);
    expect(XP_RISE).toBeGreaterThan(NUMBER_RISE);
  });
});
