import { describe, expect, it } from 'vitest';

import { TouchGestures, type TouchGesture } from './touch.js';

/** A tap: down and straight back up in the same place. */
function tap(gestures: TouchGestures, x: number, y: number, id = 1): TouchGesture | null {
  gestures.down({ id, x, y });
  return gestures.up({ id, x, y });
}

describe('TouchGestures — taps', () => {
  it('reports a tap for a down/up pair that stayed put', () => {
    const gestures = new TouchGestures();
    expect(tap(gestures, 120, 80)).toEqual({ kind: 'tap', x: 120, y: 80 });
    expect(gestures.active).toBe(0);
  });

  it('reports the position the finger went down at, not where it came up', () => {
    // Inside the slop, so it is still a tap -- but the point the player aimed at
    // is where they put the finger, and an order is placed on a world position.
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 200, y: 200 });
    expect(gestures.up({ id: 1, x: 208, y: 205 })).toEqual({ kind: 'tap', x: 200, y: 200 });
  });

  it('drops a tap that wandered past the slop, even if it comes back', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    gestures.move({ id: 1, x: 90, y: 0 });
    expect(gestures.up({ id: 1, x: 0, y: 0 })).toBeNull();
  });

  it('drops a tap that came up beyond the slop without a move in between', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    expect(gestures.up({ id: 1, x: 60, y: 60 })).toBeNull();
  });

  it('is bounded by distance and not by time, however long the finger was down', () => {
    // The regression this replaced a millisecond budget with. Driving the real
    // page (`scripts/preview-touch.ts`), a 60ms tap arrived with 735ms between
    // its pointerdown and its pointerup, because events are stamped when they
    // are created and a busy renderer creates them late. Under a budget those
    // orders were silently dropped -- on exactly the slow devices this is for.
    // There is no gesture here that a long press disambiguates against, so the
    // recogniser has no business guessing at a duration it cannot measure.
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 10, y: 10 });
    expect(gestures.up({ id: 1, x: 10, y: 10 })).toEqual({ kind: 'tap', x: 10, y: 10 });
  });

  it('ignores a lift for a pointer it never saw go down', () => {
    const gestures = new TouchGestures();
    expect(gestures.up({ id: 7, x: 1, y: 1 })).toBeNull();
  });
});

describe('TouchGestures — a second finger is not a tap', () => {
  it('suppresses the tap for both fingers, including the one already down', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 100, y: 100 });
    gestures.down({ id: 2, x: 200, y: 100 });
    expect(gestures.up({ id: 1, x: 100, y: 100 })).toBeNull();
    expect(gestures.up({ id: 2, x: 200, y: 100 })).toBeNull();
  });

  it('does not re-arm a tap when a pinch drops back to one finger', () => {
    // The finger still down was disqualified when the second landed, and it has
    // not lifted since -- releasing its partner must not hand it a tap.
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 100, y: 100 });
    gestures.down({ id: 2, x: 200, y: 100 });
    gestures.up({ id: 2, x: 200, y: 100 });
    expect(gestures.active).toBe(1);
    expect(gestures.up({ id: 1, x: 100, y: 100 })).toBeNull();
  });

  it('lets the next single finger tap normally once the pinch is over', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 100, y: 100 });
    gestures.down({ id: 2, x: 200, y: 100 });
    gestures.up({ id: 1, x: 100, y: 100 });
    gestures.up({ id: 2, x: 200, y: 100 });
    expect(tap(gestures, 50, 50, 3)).toEqual({ kind: 'tap', x: 50, y: 50 });
  });
});

describe('TouchGestures — pinch', () => {
  it('reports the ratio of the spread since the last report', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    gestures.down({ id: 2, x: 100, y: 0 });
    expect(gestures.move({ id: 2, x: 200, y: 0 })).toEqual({ kind: 'pinch', ratio: 2 });
  });

  it('composes successive moves multiplicatively into the total spread', () => {
    // Each report is against the previous one, so the product is the whole
    // gesture. Reporting against the gesture's start instead would re-apply the
    // spread already applied on every move -- 100->200->400 would zoom by 8.
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    gestures.down({ id: 2, x: 100, y: 0 });
    const first = gestures.move({ id: 2, x: 200, y: 0 });
    const second = gestures.move({ id: 2, x: 400, y: 0 });
    const product = ratioOf(first) * ratioOf(second);
    expect(product).toBeCloseTo(4, 10);
  });

  it('reports a ratio below 1 when the fingers close', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    gestures.down({ id: 2, x: 400, y: 0 });
    expect(gestures.move({ id: 2, x: 100, y: 0 })).toEqual({ kind: 'pinch', ratio: 0.25 });
  });

  it('measures the spread in both axes', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    gestures.down({ id: 2, x: 30, y: 40 });
    // 3-4-5: the separation is 50, and doubling each leg doubles it.
    expect(gestures.move({ id: 2, x: 60, y: 80 })).toEqual({ kind: 'pinch', ratio: 2 });
  });

  it('emits nothing rather than a non-finite ratio from a zero separation', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 50, y: 50 });
    gestures.down({ id: 2, x: 50, y: 50 });
    // Both fingers on the same point: there is no separation to take a ratio
    // against, and 100/0 would send the zoom to a bound in one frame.
    const first = gestures.move({ id: 2, x: 150, y: 50 });
    expect(first).toBeNull();
    // ...and once they have parted, the next move measures against that.
    expect(gestures.move({ id: 2, x: 300, y: 50 })).toEqual({ kind: 'pinch', ratio: 2.5 });
  });

  it('reports no pinch with one finger down', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    expect(gestures.move({ id: 1, x: 80, y: 0 })).toBeNull();
  });

  it('measures a resumed pinch from where the fingers are, not where they were', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    gestures.down({ id: 2, x: 100, y: 0 });
    gestures.move({ id: 2, x: 200, y: 0 });
    gestures.up({ id: 2, x: 200, y: 0 });
    // A second finger lands somewhere new; the first move after it must not read
    // the stale 200 as its baseline and lurch.
    gestures.down({ id: 3, x: 50, y: 0 });
    expect(gestures.move({ id: 3, x: 100, y: 0 })).toEqual({ kind: 'pinch', ratio: 2 });
  });
});

describe('TouchGestures — cancel and clear', () => {
  it('cancel drops a pointer that can no longer produce a tap', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 10, y: 10 });
    gestures.cancel(1);
    expect(gestures.active).toBe(0);
    expect(gestures.up({ id: 1, x: 10, y: 10 })).toBeNull();
  });

  it('clear drops every pointer mid-pinch and emits nothing', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    gestures.down({ id: 2, x: 100, y: 0 });
    gestures.clear();
    expect(gestures.active).toBe(0);
    expect(gestures.move({ id: 1, x: 40, y: 0 })).toBeNull();
    expect(gestures.up({ id: 2, x: 100, y: 0 })).toBeNull();
  });

  it('a tap works again after a clear', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    gestures.clear();
    expect(tap(gestures, 70, 70, 2)).toEqual({ kind: 'tap', x: 70, y: 70 });
  });
});

/** The ratio of a gesture that must be a pinch, so the assertions stay readable. */
function ratioOf(gesture: TouchGesture | null): number {
  if (!gesture || gesture.kind !== 'pinch') throw new Error('expected a pinch');
  return gesture.ratio;
}
