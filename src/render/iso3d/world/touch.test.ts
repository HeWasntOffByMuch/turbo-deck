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

describe('TouchGestures — two fingers, spreading', () => {
  it('reports the ratio of the spread since the last report', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    gestures.down({ id: 2, x: 100, y: 0 });
    // One finger moved 100 and the other stayed, so the midpoint moved half of
    // that: a spread taken from one end is also a slide, and both are reported.
    expect(gestures.move({ id: 2, x: 200, y: 0 })).toEqual({ kind: 'twoFinger', ratio: 2, dragX: 50 });
  });

  it('reports a spread about a still midpoint as zoom alone', () => {
    // Both fingers moving out equally: this is the gesture the zoom is for, and
    // it must not also turn the camera. The two halves have to be added up to
    // see that -- a browser moves one pointer per event, so the first report of
    // any two-finger gesture has one finger moved and the other not.
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 100, y: 0 });
    gestures.down({ id: 2, x: 200, y: 0 });
    const first = gestures.move({ id: 1, x: 50, y: 0 });
    const second = gestures.move({ id: 2, x: 250, y: 0 });
    expect(ratioOf(first) * ratioOf(second)).toBeCloseTo(2, 10);
    expect(dragOf(first) + dragOf(second)).toBeCloseTo(0, 10);
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
    expect(gestures.move({ id: 2, x: 100, y: 0 })).toEqual({
      kind: 'twoFinger',
      ratio: 0.25,
      dragX: -150,
    });
  });

  it('measures the spread in both axes', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    gestures.down({ id: 2, x: 30, y: 40 });
    // 3-4-5: the separation is 50, and doubling each leg doubles it.
    expect(gestures.move({ id: 2, x: 60, y: 80 })).toEqual({ kind: 'twoFinger', ratio: 2, dragX: 15 });
  });

  it('costs the zoom and not the swipe when the fingers start on top of each other', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 50, y: 50 });
    gestures.down({ id: 2, x: 50, y: 50 });
    // No separation to take a ratio against, and 100/0 would send the zoom to a
    // bound in one frame. The midpoint is measurable either way, so the swipe
    // still arrives -- a ratio of exactly 1 is "no zoom", not "no gesture".
    expect(gestures.move({ id: 2, x: 150, y: 50 })).toEqual({ kind: 'twoFinger', ratio: 1, dragX: 50 });
    // ...and once they have parted, the next move measures against that.
    expect(gestures.move({ id: 2, x: 300, y: 50 })).toEqual({ kind: 'twoFinger', ratio: 2.5, dragX: 75 });
  });

  it('reports nothing with one finger down', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    expect(gestures.move({ id: 1, x: 80, y: 0 })).toBeNull();
  });

  it('measures a resumed gesture from where the fingers are, not where they were', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    gestures.down({ id: 2, x: 100, y: 0 });
    gestures.move({ id: 2, x: 200, y: 0 });
    gestures.up({ id: 2, x: 200, y: 0 });
    // A second finger lands somewhere new; the first move after it must not read
    // the stale 200 as its baseline and lurch -- in the zoom or in the swing.
    gestures.down({ id: 3, x: 50, y: 0 });
    expect(gestures.move({ id: 3, x: 100, y: 0 })).toEqual({ kind: 'twoFinger', ratio: 2, dragX: 25 });
  });
});

describe('TouchGestures — two fingers, swiping', () => {
  /**
   * Move both fingers the same distance and report the whole of it.
   *
   * A browser delivers one pointer per event, so a two-finger slide arrives as
   * two reports: the first has one finger moved and the other not, which is a
   * spread as much as a slide. Only the pair of them is the gesture, so the
   * ratios are composed and the drags added, exactly as the view does per frame.
   */
  function slide(gestures: TouchGestures, from: number, by: number): { ratio: number; dragX: number } {
    const first = gestures.move({ id: 1, x: from + by, y: 0 });
    const second = gestures.move({ id: 2, x: from + 100 + by, y: 0 });
    return {
      ratio: ratioOf(first) * ratioOf(second),
      dragX: dragOf(first) + dragOf(second),
    };
  }

  it('reports a slide with the separation held as swipe alone', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 100, y: 0 });
    gestures.down({ id: 2, x: 200, y: 0 });
    const gesture = slide(gestures, 100, 60);
    // The separation is exactly what it was, so the zoom is untouched -- and the
    // swipe is the whole distance the hand travelled.
    expect(gesture.ratio).toBeCloseTo(1, 10);
    expect(gesture.dragX).toBeCloseTo(60, 10);
  });

  it('adds up successive swipes into the whole slide', () => {
    // The mirror of the ratio composing multiplicatively: a swipe reported
    // against its own start would turn the camera by the whole gesture again on
    // every frame of it.
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    gestures.down({ id: 2, x: 100, y: 0 });
    let total = 0;
    for (let step = 1; step <= 4; step += 1) {
      total += dragOf(gestures.move({ id: 1, x: step * 10, y: 0 }));
      total += dragOf(gestures.move({ id: 2, x: 100 + step * 10, y: 0 }));
    }
    expect(total).toBeCloseTo(40, 10);
  });

  it('swipes the other way for the other direction', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 400, y: 0 });
    gestures.down({ id: 2, x: 500, y: 0 });
    expect(slide(gestures, 400, -80).dragX).toBeCloseTo(-80, 10);
  });

  it('ignores vertical travel: a swipe up and down turns nothing', () => {
    const gestures = new TouchGestures();
    gestures.down({ id: 1, x: 0, y: 0 });
    gestures.down({ id: 2, x: 100, y: 0 });
    gestures.move({ id: 1, x: 0, y: 200 });
    const gesture = gestures.move({ id: 2, x: 100, y: 200 });
    if (gesture?.kind !== 'twoFinger') throw new Error('expected two fingers');
    expect(gesture.dragX).toBe(0);
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

/** The zoom of a gesture that must be two fingers, so the assertions stay readable. */
function ratioOf(gesture: TouchGesture | null): number {
  if (!gesture || gesture.kind !== 'twoFinger') throw new Error('expected two fingers');
  return gesture.ratio;
}

/** The swing of a gesture that must be two fingers. */
function dragOf(gesture: TouchGesture | null): number {
  if (!gesture || gesture.kind !== 'twoFinger') throw new Error('expected two fingers');
  return gesture.dragX;
}
