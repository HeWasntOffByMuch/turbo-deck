/**
 * That the stance reading can tell a knee from a knee folded backwards
 * (spec 244).
 *
 * `pig-strike.test.ts` drives this module against the real rig, which is the
 * assertion that matters about the pig -- and it cannot make this one, because
 * the pig's stance has no backwards knee in it and the whole point of the rule
 * is to refuse one. A detector that never fires is indistinguishable from a
 * detector that cannot.
 *
 * So the legs here are built by hand, out of nothing: three points and a body
 * frame, which is all {@link legStanceOf} reads.
 */

import { describe, expect, it } from 'vitest';
import { legStanceOf, stanceOf, type Leg } from './stance.js';
import type { BodyFrame, Vec3 } from './pose.js';

/** +X forward, +Y up, +Z the body's own left -- so `right` comes back as -Z. */
const FRAME: BodyFrame = { lateral: [0, 0, 1], forward: [1, 0, 0], up: [0, 1, 0] };

/** A world matrix that is a translation and nothing else. */
function at(point: Vec3): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, point[0], point[1], point[2], 1];
}

const LEG: Leg = { hip: 0, knee: 1, ankle: 2, toe: 3 };

/** One leg, as four points: hip, knee, ankle, toe. */
function leg(hip: Vec3, knee: Vec3, ankle: Vec3, toe: Vec3): number[][] {
  return [at(hip), at(knee), at(ankle), at(toe)];
}

describe('reading one leg', () => {
  it('calls a straight leg straight, and points its non-existent bend forward', () => {
    const read = legStanceOf(FRAME, LEG, leg([0, 2, 0], [0, 1, 0], [0, 0, 0], [0.2, 0, 0]));
    expect(read.bend).toBeCloseTo(0, 6);
    expect(read.offset).toBeCloseTo(0, 6);
    // A straight leg has no offset and therefore no direction. Reported as
    // forward rather than as zero, because zero is the reading for a knee out
    // sideways and "there is nothing to point" is a different fact.
    expect(read.lead).toBe(1);
  });

  it('calls a knee that leads forward a knee', () => {
    // Hip above ankle, knee pushed out in front of the line between them: what a
    // bent leg standing on something looks like.
    const read = legStanceOf(FRAME, LEG, leg([0, 2, 0], [0.5, 1, 0], [0, 0, 0], [0.2, 0, 0]));
    expect(read.bend).toBeGreaterThan(50);
    expect(read.lead).toBeCloseTo(1, 6);
  });

  it('calls the same bend folded the other way a knee bending backwards', () => {
    // The mirror image, and the reason this file exists: the angle at the joint
    // is identical, so `bend` alone cannot tell these two apart and reports the
    // same number for both.
    const forwards = legStanceOf(FRAME, LEG, leg([0, 2, 0], [0.5, 1, 0], [0, 0, 0], [0.2, 0, 0]));
    const backwards = legStanceOf(FRAME, LEG, leg([0, 2, 0], [-0.5, 1, 0], [0, 0, 0], [0.2, 0, 0]));
    expect(backwards.bend).toBeCloseTo(forwards.bend, 6);
    expect(backwards.lead).toBeCloseTo(-1, 6);
  });

  it('calls a knee swung out sideways neither', () => {
    // The third thing two pinned points leave free, and the one a sign test
    // would miss: the leg swivelled about the line from hip to ankle until the
    // knee is out to the side. Bent, not backwards, and not a leg.
    const read = legStanceOf(FRAME, LEG, leg([0, 2, 0], [0, 1, 0.5], [0, 0, 0], [0.2, 0, 0]));
    expect(read.bend).toBeGreaterThan(50);
    expect(read.lead).toBeCloseTo(0, 6);
  });
});

describe('reading the balance', () => {
  const stand = (leftAnkle: number, rightAnkle: number): number[][] => [
    ...leg([0, 2, -0.3], [0, 1, -0.3], [leftAnkle, 0, -0.3], [leftAnkle + 0.2, 0, -0.3]),
    ...leg([0, 2, 0.3], [0, 1, 0.3], [rightAnkle, 0, 0.3], [rightAnkle + 0.2, 0, 0.3]),
  ];
  const LEGS = {
    left: LEG,
    right: { hip: 4, knee: 5, ankle: 6, toe: 7 } satisfies Leg,
  };
  const over = (leftAnkle: number, rightAnkle: number, pelvis: number): number =>
    stanceOf([], FRAME, LEGS, stand(leftAnkle, rightAnkle), pelvis).over;

  it('puts a pelvis halfway between the rear heel and the leading toe at a half', () => {
    // Rear ankle at -0.2, leading toe at 0.4: the middle is 0.1.
    expect(over(0.2, -0.2, 0.1)).toBeCloseTo(0.5, 6);
  });

  it('reads past the leading toe as past the leading toe', () => {
    // The failure this exists to name. Not clamped, because "157%" is the
    // measurement and "100%" would be the reading a clamp invented.
    expect(over(0.2, -0.2, 0.4)).toBeCloseTo(1, 6);
    expect(over(0.2, -0.2, 0.7)).toBeGreaterThan(1.4);
  });

  it('takes the span from whichever foot is furthest each way, not from a named one', () => {
    // The wielding foot passes the support foot during a step, so which one is
    // "rear" changes inside a single clip.
    expect(over(-0.2, 0.2, 0.1)).toBeCloseTo(0.5, 6);
  });
});
