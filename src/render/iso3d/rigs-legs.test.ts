import { describe, expect, it } from 'vitest';
import { MechRig, defaultMechTuning, type MechTuning } from './rigs.js';

/**
 * Invariants of the variable-leg-count mech rig (spec 036). The rig is cosmetic,
 * but it is still pure math over three.js objects, so it runs headlessly in Node
 * with no canvas or GL context -- which is what lets these run in CI.
 *
 * Each case drives the rig the way the movement sandbox does (fixed 1/60 steps,
 * position + yaw only) and asserts the properties that were broken when the leg
 * count first became tunable: orphaned bones left in the scene, feet stranded far
 * outside their territory, the hip segment flipping across the body, and gaits
 * that lifted legs which needed to be holding the mech up.
 */

const LEG_COUNTS = [3, 4, 5, 6, 7, 8] as const;
/** Meshes parented directly to the rig group: the carriage, plus 3 bones per leg. */
const meshesFor = (n: number): number => 1 + 3 * n;

function rigWith(n: number, opts: { lowerBodyTurns?: boolean } = {}): { rig: MechRig; tuning: MechTuning } {
  const tuning = defaultMechTuning();
  tuning.numLegs = n;
  return { rig: new MechRig('ally', 0x808080, { tuning, ...opts }), tuning };
}

/** Walk straight ahead for `frames`, returning the rig. */
function walk(rig: MechRig, frames: number, speed = 2.5): void {
  let x = 0;
  for (let i = 0; i < frames; i++) {
    x += speed;
    rig.update(1 / 60, { x, y: 0 }, 0);
  }
}

/** Drive a hard continuous turn, calling `onFrame` after each step. */
function hardTurn(rig: MechRig, frames: number, onFrame?: () => void): void {
  let x = 0;
  let z = 0;
  let ry = 0;
  for (let i = 0; i < frames; i++) {
    ry += 3.2 / 60; // ~183 deg/s, faster than the sandbox's default turn rate
    x += Math.cos(ry) * 4;
    z += Math.sin(ry) * 4;
    rig.update(1 / 60, { x, y: z }, -ry);
    onFrame?.();
  }
}

describe('mech rig leg count', () => {
  it.each(LEG_COUNTS)('builds %i legs', (n) => {
    const { rig } = rigWith(n);
    expect(rig.debugSnapshot().legs).toHaveLength(n);
    expect(rig.group.children).toHaveLength(meshesFor(n));
  });

  it('leaves no orphaned bones behind when the leg count changes', () => {
    // The bones are parented to the rig group, so dropping a MechLeg without
    // detaching it leaves it in the scene forever, frozen in its last pose.
    const { rig, tuning } = rigWith(4);
    for (const n of [6, 3, 8, 5, 4, 7]) {
      tuning.numLegs = n;
      walk(rig, 30);
      expect(rig.group.children, `after switching to ${n} legs`).toHaveLength(meshesFor(n));
    }
  });

  it('re-plants the new feet instead of leaving them at the world origin', () => {
    const { rig, tuning } = rigWith(4);
    walk(rig, 120);
    tuning.numLegs = 7;
    walk(rig, 2);
    // Every foot should sit near its own rest spot, not at a stale (0, 0).
    for (const leg of rig.debugSnapshot().legs) {
      expect(Math.hypot(leg.foot.x - leg.rest.x, leg.foot.z - leg.rest.z)).toBeLessThan(40);
    }
  });

  describe.each(LEG_COUNTS)('%i legs', (n) => {
    it('keeps every joint finite through a hard turn, in both body modes', () => {
      for (const lowerBodyTurns of [true, false]) {
        const { rig } = rigWith(n, { lowerBodyTurns });
        hardTurn(rig, 600, () => {
          for (const leg of rig.debugSnapshot().legs) {
            for (const joint of [leg.hip, leg.shoulder, leg.knee, leg.foot]) {
              expect(Number.isFinite(joint.x + joint.y + joint.z)).toBe(true);
            }
          }
        });
      }
    });

    it('never lifts two neighbouring legs at once', () => {
      // The support invariant: a swinging leg's neighbours around the ring hold the
      // mech up. For four legs this is the classic alternating diagonal.
      const { rig } = rigWith(n);
      hardTurn(rig, 600, () => {
        const legs = rig.debugSnapshot().legs;
        const airborne = legs.map((l) => l.stepping || l.held);
        for (let i = 0; i < airborne.length; i++) {
          const j = (i + 1) % airborne.length;
          expect(airborne[i] === true && airborne[j] === true, `legs ${i} and ${j} both airborne`).toBe(false);
        }
      });
    });

    it('keeps at least half its legs planted', () => {
      const { rig } = rigWith(n);
      hardTurn(rig, 600, () => {
        const legs = rig.debugSnapshot().legs;
        const planted = legs.filter((l) => !l.stepping && !l.held).length;
        expect(planted).toBeGreaterThanOrEqual(Math.ceil(n / 2));
      });
    });

    it('re-homes its feet rather than dragging them, walking straight', () => {
      // Feet drifting past the step trigger and never recovering is what the fixed
      // two-leg swing budget caused at high leg counts. A planted foot legitimately
      // sits up to a stride beyond its rest spot, so this bound is a loose sanity
      // check, not a tight one -- the throughput assertion below is the sharp test.
      const { rig, tuning } = rigWith(n);
      walk(rig, 600);
      const trigger = tuning.stepTrigger;
      for (const leg of rig.debugSnapshot().legs) {
        const dev = Math.hypot(leg.foot.x - leg.rest.x, leg.foot.z - leg.rest.z);
        expect(dev, `foot ${dev.toFixed(0)} from rest vs trigger ${trigger}`).toBeLessThan(trigger * 2.5);
      }
    });

    it('is deterministic: identical drives give identical poses', () => {
      const snap = (): string => {
        const { rig } = rigWith(n);
        hardTurn(rig, 240);
        return rig
          .debugSnapshot()
          .legs.map((l) => [l.hip, l.shoulder, l.knee, l.foot].map((v) => `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`).join('|'))
          .join(';');
      };
      expect(snap()).toBe(snap());
    });
  });

  // The swing budget has to grow with the leg count. Held at a flat two legs, each
  // leg waits N/4 as long for its turn: measured over a straight walk, an 8-legged
  // rig managed 1.76 plants/leg/s against a 4-legged rig's 3.0, and its feet dragged.
  // Six legs and up have the support to keep more than two legs moving at once.
  it.each([6, 7, 8])('%i legs keep more than two legs swinging at once', (n) => {
    const { rig } = rigWith(n);
    let airborne = 0;
    let frames = 0;
    let x = 0;
    for (let i = 0; i < 600; i++) {
      x += 2.5;
      rig.update(1 / 60, { x, y: 0 }, 0);
      airborne += rig.debugSnapshot().legs.filter((l) => l.stepping).length;
      frames++;
    }
    expect(airborne / frames).toBeGreaterThan(2);
  });
});
