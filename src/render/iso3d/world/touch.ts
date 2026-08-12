/**
 * Touch gesture recognition for the play view (spec 093).
 *
 * Pure, and deliberately so: a tap is a fact about a sequence of timed samples,
 * and the only reason it needs a browser is to produce them. Time arrives on the
 * sample as `event.timeStamp` rather than being read from a clock here, so the
 * whole recogniser replays in Node and the rules below are checked rather than
 * eyeballed on a phone.
 *
 * It reports gestures only. What a tap *means* -- an order, an answer to an aim,
 * or a refusal -- is `view.ts`'s to decide, the same way `EditorInputCapture`
 * reports buttons and leaves the camera rules to `camera.ts`.
 */

/** One pointer, sampled: which finger, and where it is. */
export interface TouchSample {
  readonly id: number;
  /** Canvas CSS pixels. */
  readonly x: number;
  readonly y: number;
}

/**
 * Two fingers moving, as one report (spec 139).
 *
 * A real two-finger gesture is a spread and a slide at the same time, and there
 * is no honest way to pick which one it "really" is -- a hand that separates its
 * fingers also drifts, and a hand that swipes also opens a little. So both are
 * measured and reported together, and the view applies both: a pure spread
 * arrives with `dragX` at zero and a pure swipe with `ratio` at one, so neither
 * costs anything when it is not what the player meant.
 *
 * Both are measured against the *previous report* rather than the gesture's
 * start, so successive moves compose -- multiplicatively in `ratio`, additively
 * in `dragX` -- instead of each re-applying the whole gesture.
 */
export type TouchGesture =
  | { readonly kind: 'tap'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'twoFinger';
      /** The finger separation now, over the separation at the last report. */
      readonly ratio: number;
      /** How far the midpoint slid sideways since then, canvas pixels. */
      readonly dragX: number;
    };

/**
 * A tap is bounded by distance and *not* by time, which is worth explaining
 * because every other implementation of this has a millisecond budget in it.
 *
 * The budget was there and it was measured out: driving the real page through
 * `scripts/preview-touch.ts`, a 60ms tap arrived with 735ms between its
 * `pointerdown` and its `pointerup`. The finger was not slow -- the *page* was.
 * Events are stamped when they are created, and a busy main thread creates them
 * late, so under a heavy frame the gap says how loaded the renderer is rather
 * than how long anybody held anything. A recogniser cannot tell those apart, and
 * every wrong guess is an order the player gave and the game silently dropped,
 * on exactly the slow devices this spec exists for.
 *
 * Nothing here is waiting on a long press to disambiguate against, so there is
 * nothing to buy with a budget and a real cost to keeping one. What separates a
 * tap from a drag is how far it went, which is a fact about the finger.
 */

/**
 * How far a finger may wander and still be a tap, canvas pixels.
 *
 * A finger is not a mouse: it rolls a little on the way up, and on a dense
 * display that is several pixels. Sized to swallow that without swallowing a
 * deliberate drag.
 */
const TAP_SLOP_PX = 16;

interface Live {
  readonly startX: number;
  readonly startY: number;
  x: number;
  y: number;
  /** Cleared the moment this pointer stops being able to produce a tap. */
  tapAlive: boolean;
}

export class TouchGestures {
  private readonly live = new Map<number, Live>();
  /**
   * The finger separation the last pinch was reported against, or null when a
   * pinch is not in progress. Reported *against the previous report* rather than
   * against the gesture's start, so successive moves compose into the total
   * spread instead of each re-applying it from the beginning.
   */
  private lastSpread: number | null = null;
  /**
   * The midpoint's x the last report was measured against, or null when two
   * fingers are not down. Kept beside {@link lastSpread} and set and cleared
   * with it, because they are two measurements of one gesture.
   */
  private lastMidX: number | null = null;

  down(sample: TouchSample): void {
    this.live.set(sample.id, {
      startX: sample.x,
      startY: sample.y,
      x: sample.x,
      y: sample.y,
      tapAlive: true,
    });
    // Two fingers are a pinch, and a pinch is not a tap -- including for the
    // finger that was already down and looked like one until now.
    if (this.live.size > 1) {
      for (const pointer of this.live.values()) pointer.tapAlive = false;
      this.lastSpread = this.spread();
      this.lastMidX = this.midX();
    }
  }

  /** Report what two fingers did to the zoom and to the view, if two are down. */
  move(sample: TouchSample): TouchGesture | null {
    const pointer = this.live.get(sample.id);
    if (!pointer) return null;
    pointer.x = sample.x;
    pointer.y = sample.y;
    // Past the slop it is a drag, whatever it does next.
    if (Math.hypot(sample.x - pointer.startX, sample.y - pointer.startY) > TAP_SLOP_PX) {
      pointer.tapAlive = false;
    }

    if (this.live.size !== 2) return null;
    const spread = this.spread();
    const midX = this.midX();
    if (spread === null || midX === null) return null;
    const previousSpread = this.lastSpread;
    const previousMidX = this.lastMidX;
    this.lastSpread = spread;
    this.lastMidX = midX;
    // Fingers exactly on top of each other have no separation to take a ratio
    // against, and 100/0 would send the zoom to a bound in one frame. That costs
    // the zoom for this report and nothing else: the midpoint is measurable
    // whatever the separation is, so the swipe still arrives (spec 139).
    const zoomable = spread > 0 && previousSpread !== null && previousSpread > 0;
    return {
      kind: 'twoFinger',
      ratio: zoomable ? spread / previousSpread : 1,
      dragX: previousMidX === null ? 0 : midX - previousMidX,
    };
  }

  /** Report the tap this lift completed, if it stayed one. */
  up(sample: TouchSample): TouchGesture | null {
    const pointer = this.live.get(sample.id);
    this.live.delete(sample.id);
    // Dropping below two ends the two-finger gesture. The finger still down does
    // not become a tap -- it has already been disqualified, and it never lifted
    // to claim one.
    if (this.live.size < 2) this.endTwoFinger();
    if (!pointer || !pointer.tapAlive) return null;
    if (Math.hypot(sample.x - pointer.startX, sample.y - pointer.startY) > TAP_SLOP_PX) return null;
    // Where it went *down*. That is the point the player aimed at; the drift on
    // the way up is the hand, not the intent.
    return { kind: 'tap', x: pointer.startX, y: pointer.startY };
  }

  /** Drop one pointer without it ever producing a gesture. */
  cancel(id: number): void {
    this.live.delete(id);
    if (this.live.size < 2) this.endTwoFinger();
  }

  /** Drop everything -- the view was hidden, or the window lost focus mid-gesture. */
  clear(): void {
    this.live.clear();
    this.endTwoFinger();
  }

  /** How many fingers are down, for the cursor and for tests. */
  get active(): number {
    return this.live.size;
  }

  /** Forget both baselines together: they describe one gesture that is over. */
  private endTwoFinger(): void {
    this.lastSpread = null;
    this.lastMidX = null;
  }

  /** The distance between the two live pointers, or null unless there are exactly two. */
  private spread(): number | null {
    if (this.live.size !== 2) return null;
    const [a, b] = [...this.live.values()];
    if (!a || !b) return null;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Where the two live pointers are centred horizontally, or null unless there are two. */
  private midX(): number | null {
    if (this.live.size !== 2) return null;
    const [a, b] = [...this.live.values()];
    if (!a || !b) return null;
    return (a.x + b.x) / 2;
  }
}
