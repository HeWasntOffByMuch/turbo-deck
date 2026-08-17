/**
 * What the posture correction has to be, and what the committed clip is in
 * (spec 163).
 *
 * The subject is the real biped rig and the real clips off disk, for the reason
 * `pig-strike.test.ts` gives about the same rig: everything interesting here is
 * a fact about *that* skeleton -- which way its hips face, that its neck is two
 * twist bones, that its head is a leaf. A synthetic biped would pass all of this
 * while the pig ran with its face in the dirt.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clipDurationOf, clipPoseAt } from './clip-sample.js';
import { readGlbJson } from './glb.js';
import { readNodeTree, splitGlb, type GlbBinary, type GlbReadNode } from './glb-read.js';
import { bodyFrame, boneNode, intoBodyFrame, namingOf, type BodyFrame, type Vec3 } from './pose.js';
import { gazeAxis, pitchedPose, postureDelta, readPosture, RUN_POSTURE } from './posture.js';
import { poseWorldMatrices, type PoseRotations } from './skin.js';
import type { BoneRole, NamingSpec } from './naming.js';

const UNITS = join(process.cwd(), 'assets', 'units');
const MESH = join(UNITS, 'pig_a_pose_full', 'pig_a_pose_full.glb');
const CLIPS = join(UNITS, 'clips');

function readRig(path: string): {
  glb: GlbBinary;
  nodes: readonly GlbReadNode[];
  naming: NamingSpec;
  frame: BodyFrame;
} {
  const glb = splitGlb(new Uint8Array(readFileSync(path)));
  const nodes = readNodeTree(glb);
  const naming = namingOf(nodes);
  if (naming === 'unknown') throw new Error(`${path} is in no vocabulary this project reads`);
  const frame = bodyFrame(nodes, naming);
  if (!frame) throw new Error(`${path} has no measurable body frame`);
  return { glb, nodes, naming, frame };
}

const { nodes, naming, frame } = readRig(MESH);
const run = readRig(join(CLIPS, 'run.glb'));
const idle = readRig(join(CLIPS, 'idle.glb'));

/** Sixteen instants across a clip: enough to average a gait, few enough to be quick. */
function samples(clip: { glb: GlbBinary; nodes: readonly GlbReadNode[] }): PoseRotations[] {
  const duration = clipDurationOf(clip.glb);
  return Array.from({ length: 16 }, (_, index) => clipPoseAt(clip.glb, clip.nodes, (duration * index) / 16));
}

function meanPosture(poses: readonly PoseRotations[]): { gaze: number; lean: number } {
  let gaze = 0;
  let lean = 0;
  for (const pose of poses) {
    const reading = readPosture(nodes, naming, frame, pose);
    if (!reading) throw new Error('the pig rig has no head, hips or neck to measure');
    gaze += reading.gaze / poses.length;
    lean += reading.lean / poses.length;
  }
  return { gaze, lean };
}

function need(role: BoneRole): GlbReadNode {
  const node = boneNode(nodes, naming, role);
  if (!node) throw new Error(`the pig rig has no ${role}`);
  return node;
}

function at(world: readonly (readonly number[])[], index: number): Vec3 {
  const m = world[index] ?? [];
  return [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0];
}

/** Where the head is pointing, in the body's own right/up/forward. */
function gazeIn(pose: PoseRotations): { right: number; up: number; forward: number } {
  const axis = gazeAxis(nodes, naming, frame);
  if (!axis) throw new Error('the pig rig has no head to look out of');
  const m = poseWorldMatrices(nodes, pose)[need('head').index] ?? [];
  return intoBodyFrame(frame, [
    (m[0] ?? 0) * axis[0] + (m[4] ?? 0) * axis[1] + (m[8] ?? 0) * axis[2],
    (m[1] ?? 0) * axis[0] + (m[5] ?? 0) * axis[1] + (m[9] ?? 0) * axis[2],
    (m[2] ?? 0) * axis[0] + (m[6] ?? 0) * axis[1] + (m[10] ?? 0) * axis[2],
  ]);
}

/**
 * How far the head turned between two poses, in degrees.
 *
 * The *orientation*, not the rise of the gaze: a direction rotated 12 degrees
 * about a level axis only changes its angle above the horizon by 12 when it
 * lies in the sagittal plane, and this pig's head is turned a little at every
 * frame of the stride. Measuring the rise instead scores a 12-degree correction
 * as 11.4 and invites the number to be tuned until the test agrees.
 */
function headTurnDegrees(before: PoseRotations, after: PoseRotations): number {
  const index = need('head').index;
  const basis = (pose: PoseRotations): number[][] => {
    const m = poseWorldMatrices(nodes, pose)[index] ?? [];
    return [0, 1, 2].map((column) => {
      const v = [m[column * 4] ?? 0, m[column * 4 + 1] ?? 0, m[column * 4 + 2] ?? 0];
      const length = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1;
      return v.map((component) => component / length);
    });
  };
  const a = basis(before);
  const b = basis(after);
  // trace of `after * before^T`, which for two orthonormal bases is the sum of
  // the dot products of their matching columns.
  let trace = 0;
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) trace += (a[column]?.[row] ?? 0) * (b[column]?.[row] ?? 0);
  }
  return (Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180) / Math.PI;
}

const midRun = samples(run)[4] ?? new Map();

describe('a posture correction', () => {
  it('is the pose itself when the table is empty', () => {
    const same = pitchedPose(nodes, naming, frame, midRun, {});
    expect([...same.entries()]).toEqual([...midRun.entries()]);
  });

  it('adds its degrees along the chain, wherever they are spent', () => {
    const turnWith = (table: Parameters<typeof pitchedPose>[4]): number =>
      headTurnDegrees(midRun, pitchedPose(nodes, naming, frame, midRun, table));

    // One bone, or the same total split four ways, or spent entirely on the
    // leaf: the head ends up at the same angle. This is the property that lets
    // each bone's correction be computed against the uncorrected pose, and it
    // holds only because every one of them turns about the same world axis.
    expect(turnWith({ spine: 12 })).toBeCloseTo(12, 6);
    expect(turnWith({ spine: 3, chest: 3, neck: 3, head: 3 })).toBeCloseTo(12, 6);
    expect(turnWith({ head: 12 })).toBeCloseTo(12, 6);
    expect(turnWith(RUN_POSTURE)).toBeCloseTo(5 + 5 + 11 + 11, 6);
  });

  it('is a pitch and not a roll', () => {
    // A correction taken in the bind frame rather than the parent's animated
    // one arrives as a pitch mixed with a roll -- a body straightening up and
    // listing to one side. The head's sideways component is what shows it.
    const before = gazeIn(midRun);
    const after = gazeIn(pitchedPose(nodes, naming, frame, midRun, RUN_POSTURE));
    expect(after.right).toBeCloseTo(before.right, 3);
    expect(after.up).toBeGreaterThan(before.up);
  });

  it('moves nothing below the spine', () => {
    const before = poseWorldMatrices(nodes, midRun);
    const after = poseWorldMatrices(nodes, pitchedPose(nodes, naming, frame, midRun, RUN_POSTURE));
    for (const role of ['hips', 'leftFoot', 'rightFoot', 'leftToe', 'rightToe'] as const) {
      const index = need(role).index;
      expect(at(after, index)).toEqual(at(before, index));
    }
  });

  it('is a delta against what a file already carries, so applying it twice is once', () => {
    expect(postureDelta(RUN_POSTURE, RUN_POSTURE)).toEqual({});
    expect(postureDelta({ neck: 11 }, { neck: 4 })).toEqual({ neck: 7 });
    // A role dropped from the target is undone rather than left where it was.
    expect(postureDelta({}, { head: 11 })).toEqual({ head: -11 });
  });
});

describe('the committed run clip', () => {
  it('records the posture its bytes are in', () => {
    const json = readGlbJson(new Uint8Array(readFileSync(join(CLIPS, 'run.glb')))) as {
      animations?: { extras?: { posture?: Record<string, number> } }[];
    };
    // The clip is bought and there is no source document behind it, so this
    // record is the only thing standing between a re-run of
    // `scripts/straighten-run.ts` and a pig folded twice as far.
    expect(json.animations?.[0]?.extras?.posture).toEqual({ ...RUN_POSTURE });
  });

  it('keeps its face off the floor', () => {
    const running = meanPosture(samples(run));
    const standing = meanPosture(samples(idle));
    // The retarget had this at -54 against the family's own -18, which is a
    // character whose face a player never sees while it is moving. Judged
    // against `idle` rather than against a number, because what the run has to
    // agree with is the rest of the library.
    expect(running.gaze).toBeGreaterThan(-30);
    expect(Math.abs(running.gaze - standing.gaze)).toBeLessThan(12);
  });

  it('is still a run', () => {
    const running = meanPosture(samples(run));
    // Straightened, not stood up: a run that has stopped leaning into itself
    // has stopped reading as a run, and this is the assertion that fails if
    // somebody keeps turning the numbers in RUN_POSTURE up.
    expect(running.lean).toBeGreaterThan(15);
    expect(running.lean).toBeLessThan(28);
  });
});
