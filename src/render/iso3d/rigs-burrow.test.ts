import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MechRig, defaultMechTuning } from './rigs.js';
import { monsterLookFor } from './world/monster-look.js';

/**
 * The one thing the mech rig can do that no other rig here can (spec 263):
 * drop its body without moving its feet.
 *
 * `stabilise` draws each leg from a hip carried through `carriage.matrix` to a
 * foot that is world-locked and **independent of it**, so pushing the carriage
 * down re-solves the legs rather than translating the model. That decoupling is
 * what an emergence is made of, and it is the claim these pin -- because
 * "looks like it is being pushed up" is not something a screenshot can settle
 * and "the feet did not move" is.
 *
 * Headless like every other rig test: three.js scene-graph objects and pure
 * maths, no canvas and no GL context.
 */

/** How `scene.ts` builds a monster's rig, so this drives the real path. */
function rigFor(typeId: string): MechRig {
  const look = monsterLookFor(typeId);
  return new MechRig(typeId, undefined, {
    tuning: { ...defaultMechTuning(), ...look?.tuning },
    ...(look === null ? {} : { appearance: look.appearance }),
  });
}

/** Stand still for `frames`, so the springs settle before anything is measured. */
function settle(rig: MechRig, frames = 90): void {
  for (let i = 0; i < frames; i += 1) rig.update(1 / 60, { x: 0, y: 0 }, 0);
}

/**
 * Two identical rigs driven in lockstep, so the burrow term can be measured on
 * its own.
 *
 * Needed rather than tidy: this chassis never comes to rest. It breathes, and
 * `sHeight` is a spring, so the body's height differs between any two moments
 * of one rig's life by a unit or so -- which is nothing to look at and swamps
 * the thing being asserted. Two rigs stepped together are in identical states
 * by construction (nothing in here reads a clock or draws), so the *difference*
 * between them is exactly what one of them was told to do and nothing else.
 */
function pair(typeId = 'small_spider'): { subject: MechRig; control: MechRig } {
  return { subject: rigFor(typeId), control: rigFor(typeId) };
}

/** Advance both, with the subject's burrow set for this frame. */
function step(subject: MechRig, control: MechRig, burrow: number, frames = 1): void {
  for (let i = 0; i < frames; i += 1) {
    subject.burrow = burrow;
    subject.update(1 / 60, { x: 0, y: 0 }, 0);
    control.update(1 / 60, { x: 0, y: 0 }, 0);
  }
}

/** Every foot, in the rig's own frame. */
function feet(rig: MechRig): THREE.Vector3[] {
  return rig.debugSnapshot().legs.map((leg) => leg.foot.clone());
}

/** Every hip, in the rig's own frame. */
function hips(rig: MechRig): THREE.Vector3[] {
  return rig.debugSnapshot().legs.map((leg) => leg.hip.clone());
}

/** The lowest point of the drawn body, in the rig's own frame. */
function bodyFloor(rig: MechRig): number {
  const box = new THREE.Box3();
  // The carriage is the one child of the group that is not a leg bone; the body
  // meshes hang off the turret under it.
  const carriage = rig.group.children.find((child) => child instanceof THREE.Group);
  expect(carriage).toBeDefined();
  rig.group.updateMatrixWorld(true);
  box.setFromObject(carriage as THREE.Object3D);
  return box.min.y;
}

/** The highest point of the drawn body, in the rig's own frame. */
function bodyCeiling(rig: MechRig): number {
  const box = new THREE.Box3();
  const carriage = rig.group.children.find((child) => child instanceof THREE.Group);
  rig.group.updateMatrixWorld(true);
  box.setFromObject(carriage as THREE.Object3D);
  return box.max.y;
}

describe('MechRig.burrow', () => {
  it('draws exactly what it drew before at 0', () => {
    // The whole safety argument for adding a field to a rig every monster in
    // the game is drawn with: at rest it contributes a term that is zero, so
    // nothing that does not ask for an emergence can be changed by one.
    //
    // Two rigs driven identically, one of them written to explicitly, compared
    // joint for joint -- rather than trusting that `0 * x` is 0, which is what
    // a reader would have to take on faith otherwise.
    const control = rigFor('small_spider');
    const written = rigFor('small_spider');
    settle(control);
    for (let i = 0; i < 90; i += 1) {
      written.burrow = 0;
      written.update(1 / 60, { x: 0, y: 0 }, 0);
    }
    const a = control.debugSnapshot().legs;
    const b = written.debugSnapshot().legs;
    expect(b).toHaveLength(a.length);
    for (let i = 0; i < a.length; i += 1) {
      expect(b[i]?.foot.toArray()).toEqual(a[i]?.foot.toArray());
      expect(b[i]?.hip.toArray()).toEqual(a[i]?.hip.toArray());
      expect(b[i]?.knee.toArray()).toEqual(a[i]?.knee.toArray());
    }
    expect(bodyFloor(written)).toBeCloseTo(bodyFloor(control), 10);
  });

  it('drops the body without moving a single foot', () => {
    // The claim the emergence rests on. If the feet came down with the body
    // this would be a translation wearing an animation's name.
    const { subject, control } = pair();
    step(subject, control, 0, 90);
    step(subject, control, 1);

    const planted = feet(subject);
    const reference = feet(control);
    const dropped = hips(subject);
    const standing = hips(control);

    expect(planted).toHaveLength(reference.length);
    for (let i = 0; i < reference.length; i += 1) {
      // Exactly, not approximately: the foot is world-locked and the carriage
      // is not in the path that places it.
      expect(planted[i]?.toArray(), `foot ${i}`).toEqual(reference[i]?.toArray());
      // And the hip came down by the full depth, which is what makes the leg
      // re-solve rather than the model move.
      expect(dropped[i]?.y ?? 0, `hip ${i}`).toBeCloseTo(
        (standing[i]?.y ?? 0) - subject.hiddenDepth,
        6,
      );
      // The knee is what a viewer actually sees of a buried spider, and it is
      // the half a hip-and-foot check cannot speak for: the solve has to bow it
      // *up* out of the hole rather than fold the leg down under the body.
      const knee = subject.debugSnapshot().legs[i]?.knee.y ?? 0;
      expect(knee, `knee ${i}`).toBeGreaterThan(dropped[i]?.y ?? 0);
    }
  });

  it('puts the whole body under the ground at 1', () => {
    // What "hidden" has to mean: no part of it showing. Measured to the drawn
    // meshes rather than to the constant they were built from.
    const rig = rigFor('small_spider');
    settle(rig);
    expect(bodyCeiling(rig)).toBeGreaterThan(0);
    rig.burrow = 1;
    rig.update(1 / 60, { x: 0, y: 0 }, 0);
    expect(bodyCeiling(rig)).toBeLessThanOrEqual(0);
  });

  it('puts the Warden under too, at its own size', () => {
    // The second body on this rig, and the reason `hiddenDepth` is a getter:
    // it is 1.1 `sizeScale` against the spider's 0.6, so a shared constant
    // would bury one and leave the other's turret in the grass.
    const warden = rigFor('warden');
    const spider = rigFor('small_spider');
    settle(warden);
    expect(warden.hiddenDepth).toBeGreaterThan(spider.hiddenDepth);
    warden.burrow = 1;
    warden.update(1 / 60, { x: 0, y: 0 }, 0);
    expect(bodyCeiling(warden)).toBeLessThanOrEqual(0);
  });

  it('accumulates nothing over repeated emergences', () => {
    // The accumulation check, against a control that never burrowed at all --
    // ten full emergences, and the body has to be drawn in exactly the place a
    // rig that had never done one is drawn in. A rig that drifted by a unit a
    // spawn is a monster standing in the ground after a long session.
    const { subject, control } = pair();
    step(subject, control, 0, 90);

    for (let round = 0; round < 10; round += 1) {
      for (let i = 0; i < 45; i += 1) step(subject, control, 1 - i / 45);
      step(subject, control, 0, 30);
      // Exactly. There is no state to unwind -- the term is recomputed from the
      // value it is handed every frame -- and this is what says so.
      expect(bodyFloor(subject), `round ${round}`).toBe(bodyFloor(control));
    }
  });

  it('is bounded rather than trusted', () => {
    // It is written by the scene every frame from a pure function, so a
    // nonsense value is not expected -- and this rig finite-guards every value
    // that feeds the body transform, because a stray one launches the body and
    // takes the hip matrix with it.
    const { subject, control } = pair();
    step(subject, control, 0, 90);

    // Far past the end of its range clamps to the end of its range.
    step(subject, control, 900);
    expect(bodyFloor(subject)).toBeCloseTo(bodyFloor(control) - subject.hiddenDepth, 6);

    // Negative is standing, not floating.
    step(subject, control, -900);
    expect(bodyFloor(subject)).toBe(bodyFloor(control));

    // And a value that is not a number leaves the body somewhere rather than
    // taking the hip matrix with it.
    step(subject, control, Number.NaN);
    expect(bodyFloor(subject)).toBe(bodyFloor(control));
  });

  it('scales its hidden depth with how big the body is drawn', () => {
    const small = new MechRig('x', 0x808080, {
      tuning: { ...defaultMechTuning(), sizeScale: 0.5 },
    });
    const large = new MechRig('x', 0x808080, {
      tuning: { ...defaultMechTuning(), sizeScale: 2 },
    });
    expect(large.hiddenDepth).toBeCloseTo(small.hiddenDepth * 4, 6);

    // And with the body's proportion against its own legs, which `sizeScale`
    // cannot say -- the spider's row sets exactly that.
    const fat = new MechRig('x', 0x808080, {
      tuning: { ...defaultMechTuning(), bodySize: 3 },
    });
    const thin = new MechRig('x', 0x808080, { tuning: defaultMechTuning() });
    expect(fat.hiddenDepth).toBeGreaterThan(thin.hiddenDepth);
  });
});
