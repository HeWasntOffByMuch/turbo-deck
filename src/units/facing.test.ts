/**
 * The probe, checked against a unit whose facing is known (spec 116).
 *
 * A measurement that reports "everything agrees" is worthless until something
 * has been made to disagree with it. So each estimator is run twice: once over
 * the reference unit, which is authored facing +X on purpose, and once over the
 * same unit with one specific fault introduced -- the mesh turned around inside
 * its rig, the pose mirrored front to back, the clip's rest pose yawed, the
 * legs swapped. Those four are the four causes of a backwards walk, and each
 * has a different fix, so the probe earns its keep only if it tells them apart.
 */

import { describe, expect, it } from 'vitest';
import {
  angleBetween,
  clipFacing,
  facingIsClean,
  facingReport,
  meshFacing,
  restPoseDeltas,
  rigFacing,
  type Vec3,
} from './facing.js';
import { readNodeTree, readSkinnedMesh, splitGlb } from './glb-read.js';
import { writeGlb, type GlbAnimation, type GlbDocument, type GlbMesh } from './glb.js';
import { buildReferenceUnit } from './reference-unit.js';

const FORWARD: Vec3 = [1, 0, 0];

const unit = buildReferenceUnit(55.65);

function bytes(document: GlbDocument): Uint8Array {
  return writeGlb(document);
}

function opened(document: GlbDocument): ReturnType<typeof splitGlb> {
  return splitGlb(bytes(document));
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
  const mesh = opened(unit.meshGlb);
  const nodes = readNodeTree(mesh);

  it('has a rig whose toes point the way the project draws', () => {
    const rig = rigFacing(nodes);
    expect(angleBetween(rig.forward, FORWARD)).toBeLessThan(5);
    expect(rig.handednessOk).toBe(true);
  });

  it('has geometry that agrees with its rig', () => {
    const geometry = meshFacing(readSkinnedMesh(mesh));
    expect(angleBetween(geometry.fromFeet, rigFacing(nodes).forward)).toBeLessThan(5);
  });

  it('walks and runs forwards', () => {
    for (const id of ['walk', 'run']) {
      const clip = clipFacing(opened(clipDocument(id)));
      expect(clip?.strideLength ?? 0).toBeGreaterThan(0.1);
      expect(angleBetween(clip?.strideForward ?? null, FORWARD)).toBeLessThan(10);
    }
  });

  it('says nothing about which way an idle goes, because an idle does not go', () => {
    const clip = clipFacing(opened(clipDocument('idle')));
    expect(clip?.strideLength ?? 1).toBeLessThan(0.02);
  });

  it('has a clip rest pose identical to its mesh, so binding by name is safe', () => {
    const drift = restPoseDeltas(nodes, readNodeTree(opened(clipDocument('walk'))));
    expect(Math.max(...drift.map((delta) => delta.degrees))).toBeLessThan(1);
  });

  it('reports clean end to end, which is what makes it the control', () => {
    const report = facingReport(
      { name: 'mannequin.glb', bytes: bytes(unit.meshGlb) },
      ['idle', 'walk', 'run'].map((id) => ({ name: `${id}.glb`, bytes: bytes(clipDocument(id)) })),
    );
    expect(report.error).toBeNull();
    expect(facingIsClean(report)).toBe(true);
    // The idle is in the report but is not asked which way it goes.
    expect(report.clips.find((clip) => clip.source === 'idle.glb')?.moving).toBe(false);
    expect(report.clips.find((clip) => clip.source === 'walk.glb')?.moving).toBe(true);
  });
});

describe('a fault introduced on purpose', () => {
  it('catches a rig fitted into the mesh backwards', () => {
    const broken = opened({ ...unit.meshGlb, mesh: turnedAround(unit.meshGlb.mesh ?? ({} as GlbMesh)) });
    const geometry = meshFacing(readSkinnedMesh(broken));
    const rig = rigFacing(readNodeTree(broken));
    // The symptom exactly: nothing fails to load, the rig still points the way
    // the project expects, and the body it is inside points the other way.
    expect(angleBetween(rig.forward, FORWARD)).toBeLessThan(5);
    expect(angleBetween(geometry.fromFeet, rig.forward)).toBeGreaterThan(170);
  });

  it('catches a clip that strides the wrong way, and says it is the clip', () => {
    const walk = clipDocument('walk');
    const backwards = { ...walk, animations: walk.animations.map(mirroredFrontBack) };
    expect(angleBetween(clipFacing(opened(backwards))?.strideForward ?? null, FORWARD)).toBeGreaterThan(170);

    const report = facingReport({ name: 'mannequin.glb', bytes: bytes(unit.meshGlb) }, [
      { name: 'walk.glb', bytes: bytes(backwards) },
    ]);
    expect(facingIsClean(report)).toBe(false);
    // The mesh and the rig still agree: the finding has to name the clip, or it
    // sends somebody off to regenerate a model that is fine.
    expect(report.findings.find((finding) => finding.title === 'mesh vs rig')?.severity).toBe('ok');
    expect(report.findings.find((finding) => finding.title === 'walk.glb: stride vs rig')?.severity).toBe('error');
  });

  it('catches a clip whose rest pose is yawed away from the mesh it will bind to', () => {
    const walk = clipDocument('walk');
    // A half-turn on the root, which is what a retarget against a different
    // rest basis leaves behind. Every rotation in the clip is then read in a
    // frame half a turn from the one it was authored in.
    const nodes = walk.nodes.map((node, index) =>
      index === 0 ? { ...node, rotation: [0, 1, 0, 0] as const } : node,
    );
    const report = facingReport({ name: 'mannequin.glb', bytes: bytes(unit.meshGlb) }, [
      { name: 'walk.glb', bytes: bytes({ ...walk, nodes }) },
    ]);
    const drift = report.clips[0]?.restDrift ?? [];
    expect(drift[0]?.degrees ?? 0).toBeGreaterThan(170);
    expect(report.findings.some((finding) => finding.title === 'walk.glb: rest pose')).toBe(true);
  });

  it('catches legs whose names are swapped', () => {
    const nodes = unit.meshGlb.nodes.map((node) => {
      if (node.name === 'mixamorig:LeftUpLeg') return { ...node, name: 'mixamorig:RightUpLeg' };
      if (node.name === 'mixamorig:RightUpLeg') return { ...node, name: 'mixamorig:LeftUpLeg' };
      return node;
    });
    const rig = rigFacing(readNodeTree(opened({ ...unit.meshGlb, nodes })));
    expect(rig.handednessOk).toBe(false);
  });

  it('reports a file it cannot read rather than measuring it', () => {
    const report = facingReport({ name: 'mesh.glb', bytes: new Uint8Array([1, 2, 3, 4]) }, []);
    expect(report.error).toContain('mesh.glb');
    expect(facingIsClean(report)).toBe(false);
  });
});

/**
 * The failure the first real generated unit produced, which was the probe's and
 * not the unit's.
 *
 * Its rig answered none of the mixamo bone names, so every estimator that reads
 * a skeleton went quiet, the one that reads geometry agreed with itself, and
 * the report ended "Nothing disagrees" -- a green tick for a question nobody
 * answered. An estimator that cannot run has to say so, and a report containing
 * one is not an all-clear.
 */
describe('a rig off the naming contract', () => {
  /** Every bone renamed to a vocabulary this project does not know. */
  const renamed: GlbDocument = {
    ...unit.meshGlb,
    nodes: unit.meshGlb.nodes.map((node) => ({
      ...node,
      name: node.name.replace('mixamorig:', 'joint_').replace('Left', 'L_').replace('Right', 'R_'),
    })),
  };

  it('is not reported as clean, however well its geometry reads', () => {
    const report = facingReport({ name: 'mesh.glb', bytes: bytes(renamed) }, [
      { name: 'walk.glb', bytes: bytes(clipDocument('walk')) },
    ]);
    // The geometry estimate still works -- it never looks at a bone -- which is
    // exactly what made the old all-clear so convincing.
    expect(report.mesh.fromFeet).not.toBeNull();
    expect(report.rig.forward).toBeNull();
    expect(facingIsClean(report)).toBe(false);
  });

  it('names the bones that are missing and the ones there are', () => {
    const report = facingReport({ name: 'mesh.glb', bytes: bytes(renamed) }, []);
    const finding = report.findings.find((entry) => entry.title === 'rig forward');
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('leftfoot');
    // The vocabulary it does have, because that is what somebody compares
    // against the contract to work out what happened.
    expect(finding?.message).toContain('joint_L_Foot');
  });

  it('tells a clip with no feet to watch from an idle', () => {
    const report = facingReport({ name: 'mesh.glb', bytes: bytes(renamed) }, [
      { name: 'walk.glb', bytes: bytes({ ...clipDocument('walk'), nodes: renamed.nodes }) },
    ]);
    const clip = report.clips[0];
    expect(clip?.measurable).toBe(false);
    expect(clip?.moving).toBe(false);
    expect(report.findings.some((entry) => entry.title === 'walk.glb: stride')).toBe(true);
  });

  it('shouts when a clip shares no bone names with the mesh at all', () => {
    // The quietest catastrophe: three binds by name, so this animates nothing.
    const report = facingReport({ name: 'mesh.glb', bytes: bytes(unit.meshGlb) }, [
      { name: 'walk.glb', bytes: bytes({ ...clipDocument('walk'), nodes: renamed.nodes }) },
    ]);
    expect(report.clips[0]?.matchedBones).toBe(0);
    expect(report.findings.some((entry) => entry.title === 'walk.glb: binds to nothing')).toBe(true);
  });
});
