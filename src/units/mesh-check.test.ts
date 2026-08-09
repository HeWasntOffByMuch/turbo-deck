/**
 * Spec 115, checked against the real reference unit.
 *
 * The subject is the committed `.glb`, not a fixture. That is the whole reason
 * `reference-unit.ts` exists: it is a real skinned biped authored at a T pose on
 * the mixamo contract, so a check that fails on it is a check that is wrong. A
 * hand-built fixture would agree with whatever these functions happen to do.
 *
 * The failure cases *are* fixtures, built by damaging a copy of the real mesh --
 * because nothing generates a broken unit on demand, and the only honest way to
 * assert a check bites is to break something and watch it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  readInverseBindMatrices,
  readNodeTree,
  readSkinnedMesh,
  skinnedPrimitiveCount,
  splitGlb,
  type SkinnedMeshData,
} from './glb-read.js';
import {
  checkBindPose,
  checkDeformation,
  checkSkinning,
  classifyBindPose,
  extremePoses,
} from './mesh-check.js';
import { axisQuat, meshVolume, poseWorldMatrices, skinPositions } from './skin.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MESH = join(repoRoot, 'assets', 'units', 'dev', 'mannequin.glb');
const IDLE = join(repoRoot, 'assets', 'units', 'dev', 'clips', 'idle.glb');

const glb = splitGlb(new Uint8Array(readFileSync(MESH)));
const nodes = readNodeTree(glb);
const inverseBind = readInverseBindMatrices(glb);
const mesh = readSkinnedMesh(glb);

function requireMesh(): SkinnedMeshData {
  if (!mesh) throw new Error('the reference unit has no skinned mesh');
  return mesh;
}

/** A copy whose vertex data can be damaged without touching the shared read. */
function copyMesh(patch: Partial<SkinnedMeshData> = {}): SkinnedMeshData {
  const base = requireMesh();
  return {
    ...base,
    positions: new Float32Array(base.positions),
    joints: new Uint32Array(base.joints),
    weights: new Float32Array(base.weights),
    indices: new Uint32Array(base.indices),
    ...patch,
  };
}

describe('reading a glb (spec 115)', () => {
  it('finds the one skinned primitive and its joints', () => {
    const found = requireMesh();
    expect(skinnedPrimitiveCount(glb)).toBe(1);
    expect(found.vertexCount).toBe(312);
    expect(found.jointNodes.length).toBe(25);
    expect(found.indices.length % 3).toBe(0);
  });

  it('reads four weights and four joints per vertex', () => {
    const found = requireMesh();
    expect(found.weights.length).toBe(found.vertexCount * 4);
    expect(found.joints.length).toBe(found.vertexCount * 4);
  });

  it('reads a node tree with one root and the mixamo names', () => {
    expect(nodes.filter((node) => node.parent === null).map((node) => node.name)).toContain('mixamorig:Hips');
    expect(nodes.map((node) => node.name)).toContain('mixamorig:LeftHand');
  });

  it('refuses something that is not a glb rather than reading noise', () => {
    expect(() => splitGlb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow(/magic/);
  });

  it('reads an animation-only clip, which has no skinned mesh at all', () => {
    // A baked clip is nodes and channels with the geometry stripped. Returning
    // null rather than throwing is what lets the bake check meshes and clips
    // with the same call.
    const clip = splitGlb(new Uint8Array(readFileSync(IDLE)));
    expect(readSkinnedMesh(clip)).toBeNull();
    expect(readNodeTree(clip).length).toBeGreaterThan(0);
  });
});

describe('skinning (spec 115)', () => {
  it('reproduces the bind mesh exactly when nothing is posed', () => {
    // The property every deformation number below rests on: at bind, each skin
    // matrix is the joint's world matrix times its own inverse, so identity.
    const found = requireMesh();
    const posed = skinPositions(
      { ...found, inverseBind },
      poseWorldMatrices(nodes, new Map()),
    );
    let worst = 0;
    for (let i = 0; i < found.positions.length; i += 1) {
      worst = Math.max(worst, Math.abs((posed[i] ?? 0) - (found.positions[i] ?? 0)));
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it('actually moves the mesh when a bone is rotated', () => {
    // Guards the test above from passing because skinning is a no-op.
    const found = requireMesh();
    const posed = skinPositions(
      { ...found, inverseBind },
      poseWorldMatrices(nodes, new Map([['mixamorig:RightArm', axisQuat([0, 0, 1], -1.2)]])),
    );
    let moved = 0;
    for (let vertex = 0; vertex < found.vertexCount; vertex += 1) {
      if (Math.abs((posed[vertex * 3] ?? 0) - (found.positions[vertex * 3] ?? 0)) > 1e-3) moved += 1;
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('does not renormalize weights, so a shrunken mesh stays shrunken', () => {
    // Renormalizing here would hide the exact defect checkSkinning looks for.
    const found = requireMesh();
    const halved = new Float32Array(found.weights).map((weight) => weight * 0.5);
    const posed = skinPositions(
      { ...found, weights: halved, inverseBind },
      poseWorldMatrices(nodes, new Map()),
    );
    expect(Math.abs(meshVolume(posed, found.indices))).toBeLessThan(
      Math.abs(meshVolume(found.positions, found.indices)),
    );
  });
});

describe('checkSkinning (spec 115)', () => {
  it('passes the reference unit clean', () => {
    expect(checkSkinning(requireMesh())).toEqual([]);
  });

  it('finds weights that do not sum to 1, with the worst offender', () => {
    const broken = copyMesh();
    broken.weights[0] = (broken.weights[0] ?? 0) * 0.5;
    const codes = checkSkinning(broken).map((issue) => issue.code);
    expect(codes).toContain('mesh.weights.sum');
  });

  it('tolerates the rounding a normalized-byte weight set arrives with', () => {
    // Four weights quantized to 1/255 can miss by ~0.008. Failing on that would
    // reject most exporters' output for being an exporter.
    const broken = copyMesh();
    for (let slot = 0; slot < 4; slot += 1) {
      broken.weights[slot] = (broken.weights[slot] ?? 0) + 0.002;
    }
    expect(checkSkinning(broken).map((issue) => issue.code)).not.toContain('mesh.weights.sum');
  });

  it('finds a vertex bound to nothing', () => {
    const broken = copyMesh();
    for (let slot = 0; slot < 4; slot += 1) broken.weights[slot] = 0;
    expect(checkSkinning(broken).map((issue) => issue.code)).toContain('mesh.weights.unbound');
  });

  it('reports an unbound vertex as unbound, not as a bad sum', () => {
    // Both are true of a zero-weight vertex and only one of them says what to
    // do about it.
    const broken = copyMesh();
    for (let slot = 0; slot < 4; slot += 1) broken.weights[slot] = 0;
    expect(checkSkinning(broken).map((issue) => issue.code)).not.toContain('mesh.weights.sum');
  });

  it('refuses a joint index outside the skin rather than clamping it', () => {
    const broken = copyMesh();
    broken.joints[0] = 9999;
    broken.weights[0] = 1;
    for (let slot = 1; slot < 4; slot += 1) broken.weights[slot] = 0;
    expect(checkSkinning(broken).map((issue) => issue.code)).toContain('mesh.joints.range');
  });

  it('ignores a stale joint index in a slot with zero weight', () => {
    // Exporters leave the index at whatever it was when the weight went to zero.
    // Reporting that would be thousands of findings about nothing.
    const broken = copyMesh();
    for (let vertex = 0; vertex < broken.vertexCount; vertex += 1) {
      if ((broken.weights[vertex * 4 + 3] ?? 0) === 0) broken.joints[vertex * 4 + 3] = 9999;
    }
    expect(checkSkinning(broken).map((issue) => issue.code)).not.toContain('mesh.joints.range');
  });

  it('refuses a second influence set, because nothing here reads it', () => {
    expect(checkSkinning(copyMesh({ hasSecondInfluenceSet: true })).map((issue) => issue.code)).toContain(
      'mesh.influences.second-set',
    );
  });

  it('finds a vertex no triangle references', () => {
    const broken = copyMesh({ vertexCount: requireMesh().vertexCount + 1 });
    const codes = checkSkinning({
      ...broken,
      positions: new Float32Array([...broken.positions, 0, 0, 0]),
      weights: new Float32Array([...broken.weights, 1, 0, 0, 0]),
      joints: new Uint32Array([...broken.joints, 0, 0, 0, 0]),
    }).map((issue) => issue.code);
    expect(codes).toContain('mesh.vertices.orphan');
  });
});

describe('classifyBindPose (spec 115)', () => {
  it('calls the reference unit a T pose', () => {
    const verdict = classifyBindPose(nodes);
    expect(verdict.shape).toBe('T');
    expect(Math.abs(verdict.armDropDegrees)).toBeLessThan(25);
    expect(checkBindPose(verdict)).toEqual([]);
  });

  it('measures the reference unit as symmetric', () => {
    expect(classifyBindPose(nodes).asymmetryDegrees).toBeLessThan(4);
  });

  it('calls a rig with its arms down and its elbows bent an idle, not a bind pose', () => {
    // The failure that matters: this is what a generated model's rest pose is
    // when the reference image was of a character standing naturally, and every
    // clip retargeted onto it inherits the offsets.
    const idle = posedTree(new Map([...armDrop(1.35), ...elbowBend(1.0)]));
    const verdict = classifyBindPose(idle);
    expect(verdict.shape).toBe('posed');
    expect(checkBindPose(verdict).map((issue) => issue.code)).toContain('mesh.bindpose.posed');
  });

  it('accepts an A pose, which is as valid a bind pose as a T', () => {
    const verdict = classifyBindPose(posedTree(new Map(armDrop(0.7))));
    expect(verdict.armDropDegrees).toBeGreaterThan(25);
    expect(verdict.shape).toBe('A');
  });

  it('calls bent knees posed even when the arms are right', () => {
    // The legs run along -Y, so a knee bends about the body's lateral axis, +X.
    const bent = posedTree(
      new Map([
        ['mixamorig:LeftLeg', axisQuat([1, 0, 0], 0.9)],
        ['mixamorig:RightLeg', axisQuat([1, 0, 0], 0.9)],
      ]),
    );
    expect(classifyBindPose(bent).shape).toBe('posed');
  });

  it('says so when the two sides disagree', () => {
    const lopsided = posedTree(new Map([['mixamorig:LeftArm', axisQuat([1, 0, 0], -0.3)]]));
    const verdict = classifyBindPose(lopsided);
    expect(verdict.asymmetryDegrees).toBeGreaterThan(4);
    expect(checkBindPose(verdict).map((issue) => issue.code)).toContain('mesh.bindpose.asymmetric');
  });

  it('says what it could not measure rather than guessing', () => {
    expect(classifyBindPose([]).shape).toBe('posed');
    expect(classifyBindPose([]).reason).toContain('no arm chain');
  });
});

describe('checkDeformation (spec 115)', () => {
  it('finds nothing wrong with the reference unit at any extreme', () => {
    const result = checkDeformation(requireMesh(), nodes, inverseBind);
    expect(result.issues).toEqual([]);
    expect(result.reports.map((report) => report.poseId)).toEqual(
      extremePoses(nodes).map((pose) => pose.id),
    );
  });

  it('builds all four poses, including the one that needs a leg', () => {
    // A leg points straight down, so any axis derived as `cross(bone, up)` is
    // zero there and the knee pose silently vanishes. That happened; the body
    // frame is what fixed it.
    expect(extremePoses(nodes).map((pose) => pose.id)).toEqual([
      'slash.windup',
      'slash.follow-through',
      'run.knee',
      'turn.spine',
    ]);
  });

  it('has no poses at all for something that is not a body', () => {
    expect(extremePoses([])).toEqual([]);
  });

  it('actually poses the mesh, rather than reporting on a rig it never moved', () => {
    // A check that silently applies no rotation reports a flawless score. Every
    // pose has to displace something.
    for (const report of checkDeformation(requireMesh(), nodes, inverseBind).reports) {
      expect(report.worstDisplacement, report.poseId).toBeGreaterThan(0.01);
    }
  });

  it('notices a vertex weighted to a joint on the other side of the body', () => {
    // The lowest vertex on the body -- a toe -- bound entirely to the hand that
    // swings furthest. This is what one stray weight looks like, and it draws as
    // a spike that no average over the mesh would show.
    const broken = copyMesh();
    const hand = nodes.findIndex((node) => node.name === 'mixamorig:RightHand');
    const slot = requireMesh().jointNodes.indexOf(hand);
    expect(slot).toBeGreaterThanOrEqual(0);

    let lowest = 0;
    for (let vertex = 1; vertex < broken.vertexCount; vertex += 1) {
      if ((broken.positions[vertex * 3 + 1] ?? 0) < (broken.positions[lowest * 3 + 1] ?? 0)) lowest = vertex;
    }
    for (let s = 0; s < 4; s += 1) {
      broken.joints[lowest * 4 + s] = slot;
      broken.weights[lowest * 4 + s] = s === 0 ? 1 : 0;
    }
    const codes = checkDeformation(broken, nodes, inverseBind).issues.map((issue) => issue.code);
    expect(codes).toContain('mesh.deform.fling');
  });

  it('leaves a healthy rig well clear of the fling threshold', () => {
    // The threshold only means something if a correct rig is not near it. The
    // mannequin's worst is an arm tip swinging 150° over its own head.
    for (const report of checkDeformation(requireMesh(), nodes, inverseBind).reports) {
      expect(report.worstDisplacement, report.poseId).toBeLessThan(0.8);
    }
  });

  it('skips a pose that resolved to nothing instead of scoring it perfect', () => {
    const result = checkDeformation(requireMesh(), nodes, inverseBind, [
      { id: 'nonsense', why: 'a rig that is not this one', rotations: new Map() },
    ]);
    expect(result.reports).toEqual([]);
  });

  it('matches a rig whose bones drop the mixamo prefix', () => {
    // Same rig, conventional naming. Skipping it would score a flawless zero.
    const renamed = nodes.map((node) => ({ ...node, name: node.name.replace('mixamorig:', '') }));
    expect(extremePoses(renamed).length).toBe(extremePoses(nodes).length);
    expect(checkDeformation(requireMesh(), renamed, inverseBind).reports.length).toBe(4);
  });
});

describe('the reference mesh itself (spec 115)', () => {
  it('has no degenerate triangles', () => {
    // It had 32 of 156 until this check existed: the arms were built as boxes
    // with zero extent on Y, so they were flat cards that vanished edge-on and
    // whose side faces drew nothing. No document could have said so.
    expect(checkSkinning(requireMesh()).map((issue) => issue.code)).not.toContain('mesh.triangles.degenerate');
  });

  it('finds them when they are there', () => {
    const broken = copyMesh();
    // Collapse one triangle by pointing two of its corners at the same vertex.
    broken.indices[1] = broken.indices[0] ?? 0;
    expect(checkSkinning(broken).map((issue) => issue.code)).toContain('mesh.triangles.degenerate');
  });
});

/** The reference rig's nodes, re-posed, so a bad pose can be measured. */
function posedTree(rotations: Map<string, readonly [number, number, number, number]>) {
  const world = poseWorldMatrices(nodes, rotations);
  return nodes.map((node, index) => ({ ...node, world: world[index] ?? node.world }));
}

/**
 * Both arms lowered by `radians`, on this rig's actual axes.
 *
 * The reference rig's arms run along ±Z, so lowering one is a rotation about X
 * -- and the two sides take opposite signs, because they point opposite ways.
 * Written out rather than borrowed from `extremePoses`'s body frame on purpose:
 * a fixture derived from the code under test agrees with it by construction.
 */
function armDrop(radians: number): [string, readonly [number, number, number, number]][] {
  return [
    ['mixamorig:LeftArm', axisQuat([1, 0, 0], -radians)],
    ['mixamorig:RightArm', axisQuat([1, 0, 0], radians)],
  ];
}

function elbowBend(radians: number): [string, readonly [number, number, number, number]][] {
  return [
    ['mixamorig:LeftForeArm', axisQuat([0, 1, 0], -radians)],
    ['mixamorig:RightForeArm', axisQuat([0, 1, 0], radians)],
  ];
}
