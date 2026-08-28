/**
 * When a body takes a step (spec 229).
 *
 * The whole design is one accumulator, and everything worth asserting about it
 * is a property rather than an example: **the cadence over a walk is the ground
 * covered divided by a stride, and it is that whatever the frame rate is.** That
 * is precisely what an animation-event footstep could not promise -- locomotion
 * clips do not scale their rate with speed -- and it is what a naive "step every
 * N frames" gets wrong the moment the tab is throttled.
 *
 * Around it are the three refusals, each of which is a machine-gun of footsteps
 * if it is missing. A respawn arrives as a snap and would otherwise bank thirty
 * strides in one frame. A frame that drained three ticks holds three strides,
 * and firing three times at one instant is one step with a comb filter on it
 * rather than three footfalls. And a staggered body is being *shoved* by
 * `resolveCrowding` while its legs are rooted, so it must bank nothing at all --
 * and must not then pay for the shove the moment it can walk again.
 *
 * The sweep is the smaller half and the one nothing else would ever notice: a
 * map keyed on entity id and never pruned grows by one entry per monster that
 * has ever spawned, for the life of the session.
 */

import { describe, expect, it } from 'vitest';
import { Footsteps, MAX_FRAME_UNITS, STRIDE_UNITS, type WalkingBody } from './footsteps.js';

function body(entityId: number, x: number, z: number, walks = true): WalkingBody {
  return { entityId, x, z, walks };
}

/** One body walked along a fixed heading, a frame at a time. */
class Walker {
  x = 0;
  z = 0;
  steps = 0;

  constructor(
    private readonly footsteps: Footsteps,
    readonly entityId = 1,
    private readonly dx = 1,
    private readonly dz = 0,
  ) {
    // First sight, which never steps: the frame a body is first offered has no
    // previous position and so no ground covered.
    this.offer(true);
  }

  private offer(walks: boolean): boolean {
    const stepped = this.footsteps.step(body(this.entityId, this.x, this.z, walks));
    if (stepped) this.steps++;
    return stepped;
  }

  /** One frame covering `units` of ground along the heading. */
  frame(units: number, walks = true): boolean {
    this.x += this.dx * units;
    this.z += this.dz * units;
    return this.offer(walks);
  }

  /** `frames` frames of `units` each. Returns how many of them stepped. */
  walk(frames: number, units: number, walks = true): number {
    let stepped = 0;
    for (let i = 0; i < frames; i++) if (this.frame(units, walks)) stepped++;
    return stepped;
  }

  /** Somewhere else in one frame: a correction snap, not a walk. */
  jumpTo(x: number, z: number, walks = true): boolean {
    this.x = x;
    this.z = z;
    return this.offer(walks);
  }

  /** How many one-unit frames until the next footfall. The stride's phase, measured. */
  framesToNextStep(limit = 500): number {
    for (let i = 1; i <= limit; i++) if (this.frame(1)) return i;
    return -1;
  }
}

describe('the cadence', () => {
  it('is the ground covered divided by a stride, whatever the frame size', () => {
    // The property the whole distance-accumulator design exists for. Every
    // frame here is shorter than a stride, which is what the accumulator can
    // honestly carry; a frame long enough to hold two is a frame at 8fps and is
    // the case below.
    const distance = 2400;
    const exact = distance / STRIDE_UNITS;
    for (const perFrame of [1, 3, 6, 12]) {
      const walker = new Walker(new Footsteps());
      walker.walk(distance / perFrame, perFrame);
      expect(Math.abs(walker.steps - exact), `${perFrame} units a frame`).toBeLessThanOrEqual(1);
    }
  });

  it('is the same over ten big frames as over four hundred small ones', () => {
    // The frame rate is not a game input, and a sound that thinned out when the
    // tab was busy would be the most obvious tell there is that it is not one.
    const big = new Walker(new Footsteps());
    big.walk(20, 40);
    const small = new Walker(new Footsteps());
    small.walk(400, 2);
    expect(big.steps).toBe(small.steps);
    expect(Math.abs(big.steps - 800 / STRIDE_UNITS)).toBeLessThanOrEqual(1);
  });

  it('measures the ground covered rather than one axis of it', () => {
    // A body walking a diagonal covers the same ground as one walking east, and
    // takes the same number of steps doing it.
    const east = new Walker(new Footsteps());
    east.walk(160, 5);
    const diagonal = new Walker(new Footsteps(), 1, Math.SQRT1_2, Math.SQRT1_2);
    diagonal.walk(160, 5);
    expect(diagonal.steps).toBe(east.steps);
  });

  it('never steps a body that is standing still', () => {
    // Standing still covers no ground, so it needs no check of its own -- which
    // is what makes this immune to the replicated `activity` being a round trip
    // behind the legs the player is watching.
    const walker = new Walker(new Footsteps());
    walker.walk(500, 0);
    expect(walker.steps).toBe(0);
  });

  it('never steps on first sight of a body', () => {
    // A monster that streams in mid-stride has no previous position, and a
    // delta measured from nothing is the whole arena.
    const footsteps = new Footsteps();
    for (let id = 1; id <= 20; id++) {
      expect(footsteps.step(body(id, id * 137, id * -91)), `entity ${id}`).toBe(false);
    }
  });
});

describe('one step per frame', () => {
  it('fires once for a frame that covered three strides', () => {
    // The anti-comb-filter rule: a body that banked three strides in one frame
    // took three steps *at the same instant*, which is one step with a comb
    // filter on it rather than three footfalls.
    const walker = new Walker(new Footsteps());
    expect(walker.frame(STRIDE_UNITS * 3)).toBe(true);
    expect(walker.steps).toBe(1);
  });

  it('does not pay out the leftover on the frames after it', () => {
    // The other half: banking the remainder and firing it off over the next
    // three still frames is the same burst, arriving late.
    const walker = new Walker(new Footsteps());
    walker.frame(STRIDE_UNITS * 3);
    expect(walker.walk(20, 0)).toBe(0);
    expect(walker.steps).toBe(1);
  });

  it('holds to one a frame however long the frames are', () => {
    const walker = new Walker(new Footsteps());
    // Ten frames each holding three strides, which at 8fps is a real frame.
    for (let i = 0; i < 10; i++) walker.frame(STRIDE_UNITS * 3);
    expect(walker.steps).toBe(10);
  });
});

describe('a snap is not a walk', () => {
  it('does not step for a jump further than a frame can hold', () => {
    // A respawn arrives as a `Teleport` correction which spec 067 snaps, and a
    // body crossing the arena in one frame would bank thirty strides.
    const walker = new Walker(new Footsteps());
    expect(walker.jumpTo(5000, -5000)).toBe(false);
    expect(walker.steps).toBe(0);
  });

  it('resets the stride rather than carrying the old phase across', () => {
    // A body that arrived somewhere else is a body whose stride phase means
    // nothing: measured against a body just seen, it needs exactly the same
    // ground to take its next step.
    const fresh = new Walker(new Footsteps());
    const teleported = new Walker(new Footsteps());
    // Bank a remainder that is nothing like the starting one, then snap.
    teleported.frame(20);
    expect(teleported.steps).toBe(1);
    expect(teleported.jumpTo(9000, 9000)).toBe(false);

    expect(teleported.framesToNextStep()).toBe(fresh.framesToNextStep());
  });

  it('takes the smallest snap worth refusing and still walks at a sprint', () => {
    // `MOVE_SPEED_HARD_MAX` is 550 units a second, so a badly hitching 4Hz frame
    // is about 138 units and must still be a walk.
    const sprinting = new Walker(new Footsteps());
    expect(sprinting.frame(MAX_FRAME_UNITS)).toBe(true);
    const snapped = new Walker(new Footsteps());
    expect(snapped.frame(MAX_FRAME_UNITS + 1)).toBe(false);
  });
});

describe('being shoved is not walking', () => {
  it('banks nothing at all while a body may not walk', () => {
    // `resolveCrowding` displaces bodies that are not moving under their own
    // power, and a stagger roots the legs while the body is still being pushed
    // around. A thousand units of that is twenty footsteps out of a corpse.
    const walker = new Walker(new Footsteps());
    expect(walker.walk(100, 10, false)).toBe(0);
    expect(walker.steps).toBe(0);
  });

  it('leaves the stride exactly where it was, so walking on resumes mid-stride', () => {
    // Both halves at once. If the drag banked, the first walking frame steps
    // early; if the drag did not track the body's *position*, the first walking
    // frame is a thousand-unit delta and resets the phase instead. Either way
    // the count against the control moves.
    const control = new Walker(new Footsteps());
    control.frame(20);

    const shoved = new Walker(new Footsteps());
    shoved.frame(20);
    shoved.walk(100, 10, false);

    expect(shoved.steps).toBe(control.steps);
    expect(shoved.framesToNextStep()).toBe(control.framesToNextStep());
  });

  it('still resets the stride for a snap that happened while it could not walk', () => {
    // A respawn is both at once: the body is dead when the `Teleport` lands. If
    // the walk check came first the snap would be skipped rather than refused,
    // and the corpse would get up carrying the stride phase it fell with.
    const snapped = new Walker(new Footsteps());
    snapped.frame(20);
    expect(snapped.jumpTo(4000, 0, false)).toBe(false);

    const fresh = new Walker(new Footsteps());
    expect(snapped.framesToNextStep()).toBe(fresh.framesToNextStep());
  });
});

describe('the sweep', () => {
  it('drops a body that was not offered this frame', () => {
    const footsteps = new Footsteps();
    footsteps.step(body(1, 0, 0));
    footsteps.step(body(2, 100, 0));
    expect(footsteps.size).toBe(2);

    // Both were offered, so the sweep after them keeps both.
    footsteps.sweep();
    expect(footsteps.size).toBe(2);

    // Only one is offered now: the other is a monster that died or walked out
    // of interest range.
    footsteps.step(body(1, 10, 0));
    footsteps.sweep();
    expect(footsteps.size).toBe(1);

    footsteps.sweep();
    expect(footsteps.size).toBe(0);
  });

  it('does not grow by one entry per monster that has ever spawned', () => {
    // The leak, stated as the thing it would cost.
    const footsteps = new Footsteps();
    for (let id = 0; id < 200; id++) footsteps.step(body(id, id, id));
    expect(footsteps.size).toBe(200);
    footsteps.sweep();
    footsteps.sweep();
    expect(footsteps.size).toBe(0);
  });

  it('treats a body that came back as one seen for the first time', () => {
    // It walked out of range mid-stride; the phase it had is not something the
    // sound should resume from a minute later.
    const footsteps = new Footsteps();
    const walker = new Walker(footsteps);
    walker.frame(40);
    footsteps.sweep();
    footsteps.sweep();
    expect(footsteps.size).toBe(0);

    expect(footsteps.step(body(walker.entityId, walker.x, walker.z))).toBe(false);
  });

  it('forgets one body without touching the others', () => {
    const footsteps = new Footsteps();
    footsteps.step(body(1, 0, 0));
    footsteps.step(body(2, 100, 0));
    footsteps.forget(1);
    expect(footsteps.size).toBe(1);
    // ...and forgetting one twice is not an error and not a second removal.
    footsteps.forget(1);
    footsteps.forget(99);
    expect(footsteps.size).toBe(1);

    footsteps.clear();
    expect(footsteps.size).toBe(0);
  });
});
