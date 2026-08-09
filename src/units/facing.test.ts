/**
 * The probe, checked against a unit whose facing is known.
 *
 * A measurement that reports "everything agrees" is worthless until something
 * has been made to disagree with it. So each estimator is run twice: once over
 * the reference unit, which is authored facing +X on purpose, and once over the
 * same unit with one specific fault introduced -- the mesh turned around inside
 * its rig, the clip played backwards, the clip's rest pose yawed, the legs
 * swapped. Those four are the four causes of a backwards walk, and each has a
 * different fix, so the probe earns its keep only if it tells them apart.
 */

import { describe, expect, it } from 'vitest';
import {
  angleBetween,
  clipFacing,
  meshFacing,
  meshPoints,
  openGlb,
  restPoseDeltas,
  restSkeleton,
  rigFacing,
  type Model,
  type Vec3,
} from './facing.js';
import { writeGlb, type GlbAnimation, type GlbDocument, type GlbMesh } from './glb.js';
import { buildReferenceUnit } from './reference-unit.js';

const FORWARD: Vec3 = [1, 0, 0];

const unit = buildReferenceUnit(55.65);

function model(document: GlbDocument): Model {
  return openGlb(writeGlb(document));
}

function clipDocument(id: string): GlbDocument {
  const found = unit.clipGlbs.find((clip) => clip.id === id);
  if (!found) throw new Error(`the reference unit has no ${id} clip`);
  return found.document;
}

/** The mesh turned 180° about the up axis, with the skeleton left where it was. */
function turnedAround(mesh: GlbMesh): GlbMesh {
  const positions = Float32Array.from(mesh.positions);
  const normals = Float32Array.from(mesh.normals);
  for (const data of [positions, normals]) {
    for (let i = 0; i + 2 < data.length; i += 3) {
      data[i] = -(data[i] ?? 0);
      data[i + 2] = -(data[i + 2] ?? 0);
    }
  }
  return { ...mesh, positions, normals };
}

/**
 * The same clip mirrored front to back: the gait, walking the other way.
 *
 * Mirroring in the plane whose normal is the rig's forward maps a rotation
 * `(x, y, z, w)` to `(x, -y, -z, w)`, which negates every fore-aft swing and
 * leaves every lateral one alone. That is the fault being modelled -- an
 * animation whose forward is the rig's backward -- and it is a real one rather
 * than the obvious-looking playing it in reverse: this walk is a pure sinusoid,
 * so running it backwards is the identical walk with the legs relabelled, and a
 * test built on that would pass while measuring nothing.
 */
function mirroredFrontBack(animation: GlbAnimation): GlbAnimation {
  return {
    ...animation,
    channels: animation.channels.map((channel) => {
      const rotations = Float32Array.from(channel.rotations);
      for (let i = 0; i + 3 < rotations.length; i += 4) {
        rotations[i + 1] = -(rotations[i + 1] ?? 0);
        rotations[i + 2] = -(rotations[i + 2] ?? 0);
      }
      return { ...channel, rotations };
    }),
  };
}

describe('the reference unit, which faces +X on purpose', () => {
  const mesh = model(unit.meshGlb);
  const skeleton = restSkeleton(mesh);

  it('has a rig whose toes point the way the project draws', () => {
    const rig = rigFacing(skeleton);
    expect(angleBetween(rig.forward, FORWARD)).toBeLessThan(5);
    expect(rig.handednessOk).toBe(true);
  });

  it('has geometry that agrees with its rig', () => {
    const geometry = meshFacing(meshPoints(mesh));
    expect(angleBetween(geometry.fromFeet, rigFacing(skeleton).forward)).toBeLessThan(5);
  });

  it('walks and runs forwards', () => {
    for (const id of ['walk', 'run']) {
      const clip = clipFacing(model(clipDocument(id)));
      expect(clip?.strideLength ?? 0).toBeGreaterThan(0.1);
      expect(angleBetween(clip?.strideForward ?? null, FORWARD)).toBeLessThan(10);
    }
  });

  it('says nothing about which way an idle goes, because an idle does not go', () => {
    const clip = clipFacing(model(clipDocument('idle')));
    expect(clip?.strideLength ?? 1).toBeLessThan(0.02);
  });

  it('has a clip rest pose identical to its mesh, so binding by name is safe', () => {
    const drift = restPoseDeltas(mesh, model(clipDocument('walk')));
    expect(Math.max(...drift.map((delta) => delta.degrees))).toBeLessThan(1);
  });
});

describe('a fault introduced on purpose', () => {
  it('catches a rig fitted into the mesh backwards', () => {
    const broken = model({ ...unit.meshGlb, mesh: turnedAround(unit.meshGlb.mesh ?? ({} as GlbMesh)) });
    const geometry = meshFacing(meshPoints(broken));
    const rig = rigFacing(restSkeleton(broken));
    // The symptom exactly: nothing fails to load, the rig still points the way
    // the project expects, and the body it is inside points the other way.
    expect(angleBetween(rig.forward, FORWARD)).toBeLessThan(5);
    expect(angleBetween(geometry.fromFeet, rig.forward)).toBeGreaterThan(170);
  });

  it('catches a clip that strides the wrong way', () => {
    const walk = clipDocument('walk');
    const backwards = model({ ...walk, animations: walk.animations.map(mirroredFrontBack) });
    const clip = clipFacing(backwards);
    expect(angleBetween(clip?.strideForward ?? null, FORWARD)).toBeGreaterThan(170);
  });

  it('catches a clip whose rest pose is yawed away from the mesh it will bind to', () => {
    const walk = clipDocument('walk');
    // A half-turn on the root, which is what a retarget against a different
    // rest basis leaves behind. Every rotation in the clip is then read in a
    // frame half a turn from the one it was authored in.
    const nodes = walk.nodes.map((node, index) =>
      index === 0 ? { ...node, rotation: [0, 1, 0, 0] as const } : node,
    );
    const drift = restPoseDeltas(model(unit.meshGlb), model({ ...walk, nodes }));
    expect(drift[0]?.degrees ?? 0).toBeGreaterThan(170);
  });

  it('catches legs whose names are swapped', () => {
    const nodes = unit.meshGlb.nodes.map((node) => {
      if (node.name === 'mixamorig:LeftUpLeg') return { ...node, name: 'mixamorig:RightUpLeg' };
      if (node.name === 'mixamorig:RightUpLeg') return { ...node, name: 'mixamorig:LeftUpLeg' };
      return node;
    });
    const rig = rigFacing(restSkeleton(model({ ...unit.meshGlb, nodes })));
    expect(rig.handednessOk).toBe(false);
  });
});
