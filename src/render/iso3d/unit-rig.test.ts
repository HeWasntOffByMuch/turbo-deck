/**
 * Socket resolution (spec 121).
 *
 * The rig is built by hand here rather than loaded, because what is being
 * checked is the *matching* -- a document says `mixamorig:RightHand` and three
 * built a node called `mixamorigRightHand`, and every way of getting that wrong
 * looks identical from the outside: nothing attaches and no error is raised.
 * The real `.glb` through the real loader is `scripts/probe-attach.ts`, which is
 * the only place the import scale is a real number.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { resolveSocketNodes } from './unit-rig.js';

/** A two-bone rig with whatever names the caller wants to test against. */
function rig(...names: readonly string[]): THREE.Object3D {
  const root = new THREE.Object3D();
  root.name = 'Armature';
  let parent: THREE.Object3D = root;
  for (const name of names) {
    const bone = new THREE.Bone();
    bone.name = name;
    parent.add(bone);
    parent = bone;
  }
  return root;
}

describe('resolveSocketNodes', () => {
  it('matches a document name against the name three actually built', () => {
    // The sanitisation case, in both directions. `mixamorig:RightHand` in the
    // file is `mixamorigRightHand` in the scene -- a raw string compare finds
    // nothing here and reports a clean "no sockets".
    const model = rig('mixamorigHips', 'mixamorigRightHand');
    const resolved = resolveSocketNodes(model, { 'weapon.main': 'mixamorig:RightHand' });
    expect(resolved.get('weapon.main')?.name).toBe('mixamorigRightHand');
  });

  it('matches when the document and the rig agree exactly', () => {
    // The generated rigs, which carry no prefix at all.
    const model = rig('Hip', 'R_Hand');
    const resolved = resolveSocketNodes(model, { 'weapon.main': 'R_Hand' });
    expect(resolved.get('weapon.main')?.name).toBe('R_Hand');
  });

  it('leaves out a socket whose bone is not in the rig', () => {
    // Absent rather than faked: `attachable` has to mean "can hang something
    // here", so a socket for a hand this rig does not have is not in it.
    const model = rig('Hip', 'R_Hand');
    const resolved = resolveSocketNodes(model, {
      'weapon.main': 'R_Hand',
      'weapon.off': 'L_Hand',
    });
    expect([...resolved.keys()]).toEqual(['weapon.main']);
  });

  it('resolves nothing from an empty socket table, and does not throw', () => {
    expect(resolveSocketNodes(rig('Hip'), {}).size).toBe(0);
  });

  it('ignores unnamed nodes rather than matching them to each other', () => {
    // Every unnamed node normalises to the same empty key, so without the
    // guard the first anonymous group in the scene would answer to everything.
    const model = new THREE.Object3D();
    const anonymous = new THREE.Object3D();
    model.add(anonymous);
    expect(resolveSocketNodes(model, { 'weapon.main': '' }).size).toBe(0);
  });

  it('takes the node nearest the root when two normalise alike', () => {
    const model = rig('R_Hand', 'tripo::R_Hand');
    const resolved = resolveSocketNodes(model, { 'weapon.main': 'R_Hand' });
    expect(resolved.get('weapon.main')?.name).toBe('R_Hand');
  });
});

describe('attaching to a resolved socket', () => {
  /**
   * The counter-scale rule, checked as arithmetic on a real scene graph.
   *
   * `UnitRig.attach` divides by the bone's world scale so callers can build a
   * weapon in world units. The failure it prevents is not subtle: a rig
   * imported at ~32x makes a 20-unit sword 640 units long.
   */
  function attachInto(importScale: number): number {
    const model = rig('Hip', 'R_Hand');
    model.scale.setScalar(importScale);
    model.updateMatrixWorld(true);

    const hand = resolveSocketNodes(model, { 'weapon.main': 'R_Hand' }).get('weapon.main');
    if (!hand) throw new Error('the hand did not resolve');

    const scale = new THREE.Vector3();
    hand.getWorldScale(scale);

    const sword = new THREE.Object3D();
    sword.scale.set(1 / scale.x, 1 / scale.y, 1 / scale.z);
    hand.add(sword);
    model.updateMatrixWorld(true);

    const world = new THREE.Vector3();
    sword.getWorldScale(world);
    return world.x;
  }

  it('leaves an attached object the same size whatever the rig imported at', () => {
    expect(attachInto(1)).toBeCloseTo(1, 5);
    expect(attachInto(32)).toBeCloseTo(1, 5);
    expect(attachInto(0.05)).toBeCloseTo(1, 5);
  });
});
