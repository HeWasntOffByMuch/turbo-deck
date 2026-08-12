/**
 * The body's axes, checked against a rig that is nobody's convention (spec 139).
 *
 * Half of this is a synthetic rig, because a claim like "positive `up` sweeps
 * toward the left" needs a subject whose answer is known by construction. The
 * other half is the pig off disk, because the two faults this module exists to
 * prevent are both properties of a *generated* rig -- bind rotations that are
 * not identity, and a chain whose first child is a zero-length twist bone -- and
 * a synthetic rig has neither.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readNodeTree, splitGlb, type GlbReadNode } from './glb-read.js';
import {
  bodyFrame,
  boneNode,
  dot,
  flexAxis,
  intoBodyFrame,
  namingOf,
  turnQuat,
  worldPosition,
  boneDirection,
  twistAxis,
  type BodyFrame,
  type Vec3,
} from './pose.js';
import type { NamingSpec } from './naming.js';
import { poseWorldMatrices } from './skin.js';

const MESH = join(process.cwd(), 'assets', 'units', 'pig_a_pose_full', 'pig_a_pose_full.glb');

/**
 * The rig, its vocabulary and its measured frame, resolved together.
 *
 * One function returning all three so the narrowing survives into the closures
 * below -- a module-level `if (!frame) throw` narrows the statement after it and
 * not the body of a hoisted function.
 */
function readRig(path: string): { nodes: readonly GlbReadNode[]; naming: NamingSpec; frame: BodyFrame } {
  const found = readNodeTree(splitGlb(new Uint8Array(readFileSync(path))));
  const spec = namingOf(found);
  if (spec === 'unknown') throw new Error('the pig rig is in no vocabulary this project reads');
  const measured = bodyFrame(found, spec);
  if (!measured) throw new Error('the pig rig has no measurable body frame');
  return { nodes: found, naming: spec, frame: measured };
}

const { nodes: pig, naming, frame } = readRig(MESH);

/** Resolved once, so no assertion below has to insist a bone is there. */
function need(role: Parameters<typeof boneNode>[2]): GlbReadNode {
  const node = boneNode(pig, naming, role);
  if (!node) throw new Error(`the pig rig has no ${role}`);
  return node;
}

const HIPS = need('hips');
const RIGHT_HAND = need('rightHand');
const RIGHT_FOREARM = need('rightForeArm');
const ORIGIN = worldPosition(HIPS);

/** A bone's place in the body's axes, relative to the hips. */
function relativeTo(node: GlbReadNode): ReturnType<typeof intoBodyFrame> {
  const at = worldPosition(node);
  return intoBodyFrame(frame, [at[0] - ORIGIN[0], at[1] - ORIGIN[1], at[2] - ORIGIN[2]]);
}

/** Where a bone ends up once `turns` are applied, in the body's axes. */
function place(bone: string, turns: readonly { bone: Parameters<typeof turnQuat>[0]['bone']; axis: Parameters<typeof turnQuat>[0]['axis']; degrees: number }[]): Vec3 {
  const pose = new Map<string, readonly [number, number, number, number]>();
  for (const turn of turns) {
    const resolved = turnQuat(turn, frame, pig, naming);
    if (resolved) pose.set(resolved.bone, resolved.rotation);
  }
  const node = pig.find((entry) => entry.name === bone);
  const world = poseWorldMatrices(pig, pose)[node?.index ?? 0] ?? [];
  return [world[12] ?? 0, world[13] ?? 0, world[14] ?? 0];
}

describe('the body frame', () => {
  it('is orthonormal, whatever the hips were doing', () => {
    // The pig's hips are not level -- one sits 0.04 units above the other -- so
    // the raw hip-to-hip vector leans nine degrees out of horizontal. That costs
    // an extreme-pose check nothing and costs a swing a blade that rolls as it
    // falls.
    for (const axis of [frame.lateral, frame.forward, frame.up]) {
      expect(Math.hypot(axis[0], axis[1], axis[2])).toBeCloseTo(1, 9);
    }
    expect(dot(frame.lateral, frame.forward)).toBeCloseTo(0, 9);
    expect(dot(frame.lateral, frame.up)).toBeCloseTo(0, 9);
    expect(dot(frame.forward, frame.up)).toBeCloseTo(0, 9);
  });

  it('agrees with the direction the skeleton document claims the pig faces', () => {
    // `forwardAxis` in a skeleton document is an assertion and this is the
    // measurement. They have disagreed before, on a different rig, and the
    // symptom was a unit that faced the camera and walked backwards.
    const skeleton = JSON.parse(
      readFileSync(join(process.cwd(), 'assets', 'units', 'pig.skeleton.json'), 'utf8'),
    ) as { forwardAxis: string; upAxis: string };
    expect(skeleton.forwardAxis).toBe('+X');
    expect(frame.forward[0]).toBeGreaterThan(0.99);
    expect(skeleton.upAxis).toBe('+Y');
    expect(frame.up).toEqual([0, 1, 0]);
  });

  it('puts the left hand to the left and the snout in front', () => {
    expect(relativeTo(need('rightHand')).right).toBeGreaterThan(0.1);
    expect(relativeTo(need('leftHand')).right).toBeLessThan(-0.1);
    expect(relativeTo(need('head')).up).toBeGreaterThan(0.2);
  });
});

describe('flex, the hinge a bone actually has', () => {
  it('is measured from the child that gives a direction, not the first one', () => {
    // The regression. `R_Forearm`'s children are `R_ForearmTwist01`,
    // `R_ForearmTwist02` and `R_Hand`, and the array order puts a twist first --
    // a bone that shares its parent's origin by construction, 0.00006 units
    // away. The hinge came out of floating-point noise and every elbow folded
    // backwards, which looked merely wrong rather than inverted until the blade
    // was drawn and turned out to be behind the pig.
    const forearm = RIGHT_FOREARM;
    const children = pig.filter((node) => node.parent === forearm.index);
    expect(children.length).toBeGreaterThan(1);
    expect(children[0]?.name).toMatch(/Twist/);

    const from = worldPosition(forearm);
    const to = worldPosition(RIGHT_HAND);
    const along: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const axis = flexAxis(pig, forearm, frame);
    // Perpendicular to the bone, which the noisy twist offset was not.
    expect(Math.abs(dot(axis, along) / Math.hypot(...along))).toBeLessThan(0.02);
  });

  it('carries the hand forward when it is positive', () => {
    const at = (degrees: number): number => {
      const world = place('R_Hand', [{ bone: 'rightForeArm', axis: 'flex', degrees }]);
      return intoBodyFrame(frame, [world[0] - ORIGIN[0], world[1] - ORIGIN[1], world[2] - ORIGIN[2]]).forward;
    };
    // Flexion is forward for an elbow and a knee both, which is what the axis is
    // named for. The sign being wrong is not a subtle bug: it is a sword swung
    // over the shoulder in the wrong direction.
    // The lever is the forearm, about 0.11 of a body height, so 60 degrees of
    // it is worth roughly a tenth of a body and the threshold is half of that.
    expect(at(60)).toBeGreaterThan(at(0) + 0.05);
    expect(at(-30)).toBeLessThan(at(0));
  });

  it('falls back to the body\'s pitch axis for a bone with no child', () => {
    expect(pig.some((node) => node.parent === RIGHT_HAND.index)).toBe(false);
    expect(flexAxis(pig, RIGHT_HAND, frame)).toEqual(frame.lateral);
  });
});

describe('a turn is applied in the bone’s own frame', () => {
  it('lifts the right arm outward for a negative forward turn', () => {
    const height = (degrees: number): number => {
      const world = place('R_Hand', [{ bone: 'rightArm', axis: 'forward', degrees }]);
      return intoBodyFrame(frame, [world[0] - ORIGIN[0], world[1] - ORIGIN[1], world[2] - ORIGIN[2]]).up;
    };
    // A to T to overhead. The pig's arms hang along a diagonal and its `Root`
    // carries a quarter-turn, so an axis letter written down here would roll
    // each arm about its own length and move the hand nowhere at all.
    expect(height(-90)).toBeGreaterThan(height(0) + 0.3);
    expect(height(-140)).toBeGreaterThan(height(-90));
  });

  it('sweeps the chest toward the left for a positive up turn', () => {
    // Measured *forward* and not sideways. The right hand hangs at the body's
    // lateral extreme, so a yaw in either direction brings it inboard and its
    // `right` falls both ways -- an assertion on that axis passes for a rotation
    // that went the wrong way, which is the one thing it was written to catch.
    const ahead = (degrees: number): number => {
      const world = place('R_Hand', [{ bone: 'chest', axis: 'up', degrees }]);
      return intoBodyFrame(frame, [world[0] - ORIGIN[0], world[1] - ORIGIN[1], world[2] - ORIGIN[2]]).forward;
    };
    expect(ahead(40)).toBeGreaterThan(ahead(0) + 0.1);
    expect(ahead(-40)).toBeLessThan(ahead(0) - 0.1);
  });

  it('returns nothing for a bone the rig does not have', () => {
    const synthetic: readonly GlbReadNode[] = [];
    expect(turnQuat({ bone: 'rightArm', axis: 'up', degrees: 30 }, frame, synthetic, naming)).toBeNull();
  });
});

describe('twist, the roll a bone has about its own length', () => {
  it('turns the hand about the forearm, since a hand has no child to point along', () => {
    // A wrist rolls about the bone above it. Without the parent fallback there
    // is no axis at all for a leaf bone, and the roll that makes a blade cut
    // edge-first would have nowhere to live.
    const forearm = worldPosition(RIGHT_FOREARM);
    const hand = worldPosition(RIGHT_HAND);
    const along: Vec3 = [hand[0] - forearm[0], hand[1] - forearm[1], hand[2] - forearm[2]];
    const axis = twistAxis(pig, RIGHT_HAND, frame);
    const length = Math.hypot(...along);
    expect(Math.abs(dot(axis, [along[0] / length, along[1] / length, along[2] / length]))).toBeGreaterThan(0.99);
  });

  it('runs a bone along its own furthest child, never a twist stub', () => {
    const direction = boneDirection(pig, RIGHT_FOREARM);
    const from = worldPosition(RIGHT_FOREARM);
    const to = worldPosition(RIGHT_HAND);
    const along: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const length = Math.hypot(...along);
    expect(direction).not.toBeNull();
    expect(dot(direction ?? [0, 0, 0], [along[0] / length, along[1] / length, along[2] / length])).toBeGreaterThan(0.99);
  });

  it('leaves the bone pointing where it was, which is what a roll means', () => {
    // The distinguishing property: a twist moves the hand nowhere, because the
    // hand is *on* the axis. Every other pose axis moves it.
    const before = place('R_Hand', []);
    const twisted = place('R_Hand', [{ bone: 'rightHand', axis: 'twist', degrees: 70 }]);
    const bent = place('R_Hand', [{ bone: 'rightHand', axis: 'lateral', degrees: 70 }]);
    const moved = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(moved(before, twisted)).toBeLessThan(1e-6);
    expect(moved(before, bent)).toBeLessThan(1e-6);

    // ...but it does turn what the hand *carries*, which a rotation of the
    // hand's own frame is the only way to see.
    const forearmTwist = place('R_Hand', [{ bone: 'rightForeArm', axis: 'twist', degrees: 70 }]);
    expect(moved(before, forearmTwist)).toBeLessThan(0.01);
  });
});
