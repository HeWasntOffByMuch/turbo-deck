import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CRITTERS, CRITTER_IDS } from '../critters/index.js';
import type { CritterSpecies } from '../critters/types.js';
import { CritterRig, defaultCritterTuning } from './critter.js';
import { BONE, boneRestLayout } from '../cloth/figure.js';

/**
 * The head-down pose (spec 055).
 *
 * A species can declare that it grazes, and what that means is entirely in the
 * numbers: a rotation, a drop and a reach, blended in as the animal comes to
 * rest. Which makes it exactly the kind of thing that looks right in the one
 * screenshot somebody took and is wrong everywhere else -- so the cases here
 * are about the *ends* of the blend rather than the middle.
 *
 * The measurements are taken off the real rig, in world space, after running it
 * the way the scene runs it. What is being asserted is not "the head bone's z
 * rotation is -1.3" -- that is just reading the table back -- but "the mouth
 * ends up in the grass", which is the only form of the claim that can fail for
 * a reason worth knowing about.
 */

const GRAZERS = CRITTER_IDS.map((id) => CRITTERS[id]).filter((s) => s.graze !== undefined);
const STILL = CRITTER_IDS.map((id) => CRITTERS[id]).filter((s) => s.graze === undefined);

/** Walking fast enough that nothing could mistake it for standing. */
const WALKING = 66;

/** Run a fresh rig at `speed` for `frames`, then measure it. */
function run(species: CritterSpecies, speed: number, frames = 300): CritterRig {
  const rig = new CritterRig(species, { tuning: defaultCritterTuning() });
  let x = 0;
  for (let i = 0; i < frames; i++) {
    x += speed / 60;
    rig.update(1 / 60, { x, y: 0 }, 0);
  }
  rig.group.updateMatrixWorld(true);
  return rig;
}

/** Lowest world y of the named mesh: how close that part gets to the ground. */
function lowestOf(rig: CritterRig, name: string): number {
  let low = Infinity;
  const v = new THREE.Vector3();
  rig.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.name !== name) return;
    const pos = (o.geometry as THREE.BufferGeometry).getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      low = Math.min(low, v.y);
    }
  });
  return low;
}

describe.each(GRAZERS.map((s) => [s.name, s] as const))('%s: grazing', (_name, species) => {
  it('puts its mouth in the grass when it stops', () => {
    // The whole feature, stated as the thing a player would see. The threshold
    // is a fraction of the animal's own height rather than a world number, so
    // it still means "at the ground" if the species is ever rescaled.
    const standing = lowestOf(run(species, 0), 'head');
    const shoulder = species.metrics.shoulderY;
    expect(standing).toBeLessThan(shoulder * 0.5);
  });

  it('carries its head clear of the ground when it walks', () => {
    const walking = lowestOf(run(species, WALKING), 'head');
    expect(walking).toBeGreaterThan(species.metrics.shoulderY);
  });

  it('lowers the head rather than snapping it down', () => {
    // A pose that arrives in one frame is a state change, not an animation. A
    // third of a second in, the head should be on its way and not yet there.
    const early = lowestOf(run(species, 0, 20), 'head');
    const settled = lowestOf(run(species, 0), 'head');
    const up = lowestOf(run(species, WALKING), 'head');
    expect(early).toBeLessThan(up);
    expect(early).toBeGreaterThan(settled);
  });

  it('gives the head back exactly when it moves off again', () => {
    // The dip writes the head's *position* as well as its rotation, so it is the
    // one pose here that can drift: a frame subtracting from wherever the head
    // already was would sink it a little further on every stop, and after an
    // afternoon in a field the animal's head would be through the floor.
    //
    // Measured on the bone rather than in world space, deliberately. The head's
    // world height also carries the walk's bob and the idle breath, so two rigs
    // stopped at different points in the stride disagree by most of a unit for
    // reasons that have nothing to do with this pose -- which is exactly the
    // sort of slack that makes a drift test unable to see drift.
    const rest = boneRestLayout(species.metrics).find((b) => b.bone === BONE.head);
    expect(rest, 'no head in the rest layout').toBeDefined();
    /** How far off its rest pose the head is after `cycles` graze-and-walk-off. */
    const offsetAfter = (cycles: number): number => {
      const rig = new CritterRig(species, { tuning: defaultCritterTuning() });
      let x = 0;
      const step = (speed: number, frames: number): void => {
        for (let i = 0; i < frames; i++) {
          x += speed / 60;
          rig.update(1 / 60, { x, y: 0 }, 0);
        }
      };
      for (let i = 0; i < cycles; i++) {
        step(0, 200);
        step(WALKING, 400);
      }
      const head = rig.humanoid.bones[BONE.head];
      return Math.hypot(
        (head?.position.x ?? 0) - (rest?.x ?? 0),
        (head?.position.y ?? 0) - (rest?.y ?? 0),
        head?.rotation.z ?? 0,
      );
    };

    // It never lands exactly on rest and is not meant to: the lift is an
    // exponential chase, so what is left after walking off is the tail of a
    // decay rather than an error. A thousandth of a unit is that tail.
    const four = offsetAfter(4);
    expect(four).toBeLessThan(1e-3);
    // The claim that actually matters, and the one a single cycle cannot make:
    // twice the stopping, no more residue. Drift compounds; a decay does not.
    expect(offsetAfter(8)).toBeLessThanOrEqual(four + 1e-9);
  });
});

describe('a species that does not graze', () => {
  it('never moves its head at all', () => {
    // Standing still and walking are the two poses, and the head sits at the
    // same height in both -- there is nothing for the dip to do to a body that
    // did not ask for one.
    expect(STILL.length).toBeGreaterThan(0);
    for (const species of STILL) {
      const standing = lowestOf(run(species, 0), 'head');
      const walking = lowestOf(run(species, WALKING), 'head');
      // Not exactly equal: idle breathing and the walk's bob both move the whole
      // body, and neither is the head pose. A couple of units is that; sixteen
      // is a dip.
      expect(Math.abs(standing - walking), species.name).toBeLessThan(3);
    }
  });
});
