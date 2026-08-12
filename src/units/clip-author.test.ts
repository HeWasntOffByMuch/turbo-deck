/**
 * The rules the authoring layer keeps, on a rig built to make them checkable
 * (spec 139).
 *
 * A synthetic two-bone rig rather than the pig, because these are claims about
 * *the sampler* -- that a key is a whole pose, that easing lands in the samples,
 * that a channel value is the offset composed onto the bind rotation -- and each
 * of them wants a subject whose right answer is arithmetic rather than a
 * measurement. `pig-strike.test.ts` is where the real rig is the subject.
 */

import { describe, expect, it } from 'vitest';
import {
  authorClip,
  authorClipDocument,
  ease,
  finalRotations,
  frameCount,
  keyRotations,
  poseAt,
  quatAngle,
  quatMul,
  quatSlerp,
  type AuthoredClip,
  type Quat,
} from './clip-author.js';
import { readGlbJson, writeGlb } from './glb.js';
import { compose, multiply, type GlbReadNode } from './glb-read.js';

/**
 * A biped with the bones the vocabulary needs, and a deliberately awkward
 * `Hips` rotation.
 *
 * Awkward on purpose: a rig whose bind rotations are identity cannot tell a
 * correct implementation from one that forgot to compose them, and every rig
 * this project generates has bind rotations that are not identity.
 */
const HALF = Math.SQRT1_2;
const SPEC: readonly { name: string; parent: number | null; t: [number, number, number]; r?: Quat }[] = [
  { name: 'Hips', parent: null, t: [0, 1, 0], r: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)] },
  { name: 'Spine', parent: 0, t: [0, 0.2, 0] },
  { name: 'Spine2', parent: 1, t: [0, 0.2, 0] },
  { name: 'Neck', parent: 2, t: [0, 0.15, 0] },
  { name: 'Head', parent: 3, t: [0, 0.1, 0] },
  { name: 'RightArm', parent: 2, t: [0.2, 0, 0], r: [0, 0, -HALF, HALF] },
  { name: 'RightForeArm', parent: 5, t: [0, -0.25, 0] },
  { name: 'RightHand', parent: 6, t: [0, -0.22, 0] },
  { name: 'LeftArm', parent: 2, t: [-0.2, 0, 0], r: [0, 0, HALF, HALF] },
  { name: 'LeftForeArm', parent: 8, t: [0, -0.25, 0] },
  { name: 'LeftHand', parent: 9, t: [0, -0.22, 0] },
  { name: 'RightUpLeg', parent: 0, t: [0.1, -0.05, 0] },
  { name: 'RightLeg', parent: 11, t: [0, -0.4, 0] },
  { name: 'RightFoot', parent: 12, t: [0, -0.4, 0] },
  { name: 'LeftUpLeg', parent: 0, t: [-0.1, -0.05, 0] },
  { name: 'LeftLeg', parent: 14, t: [0, -0.4, 0] },
  { name: 'LeftFoot', parent: 15, t: [0, -0.4, 0] },
];

function buildRig(): { nodes: readonly GlbReadNode[]; naming: 'mixamo' } {
  const world: number[][] = [];
  const nodes = SPEC.map((bone, index): GlbReadNode => {
    const local = compose(bone.t, bone.r ?? [0, 0, 0, 1], [1, 1, 1]);
    world[index] = bone.parent === null ? [...local] : multiply(world[bone.parent] ?? [], local);
    return {
      index,
      name: bone.name,
      parent: bone.parent,
      translation: bone.t,
      rotation: bone.r ?? [0, 0, 0, 1],
      scale: [1, 1, 1],
      world: world[index] ?? [],
    };
  });
  return { nodes, naming: 'mixamo' };
}

const rig = buildRig();

const CLIP: AuthoredClip = {
  id: 'test',
  durationMs: 400,
  fps: 60,
  keys: [
    { label: 'start', atMs: 0, ease: 'linear', turns: { rightArm: { lateral: 0 } } },
    { label: 'middle', atMs: 200, ease: 'linear', turns: { rightArm: { lateral: 90 }, chest: { up: 20 } } },
    { label: 'end', atMs: 400, ease: 'linear', turns: { rightArm: { lateral: 0 } } },
  ],
};

describe('easing', () => {
  it('is pinned at both ends whatever the shape', () => {
    for (const kind of ['linear', 'in', 'out', 'inOut', 'snap'] as const) {
      expect(ease(kind, 0)).toBe(0);
      expect(ease(kind, 1)).toBe(1);
      // Out of range is clamped rather than extrapolated: a pose past its
      // authored extreme is how a leg ends up through a hip.
      expect(ease(kind, -1)).toBe(0);
      expect(ease(kind, 2)).toBe(1);
    }
  });

  it('accelerates for `in` and decelerates for `out`', () => {
    expect(ease('in', 0.5)).toBeLessThan(0.5);
    expect(ease('snap', 0.5)).toBeLessThan(ease('in', 0.5));
    expect(ease('out', 0.5)).toBeGreaterThan(0.5);
    expect(ease('inOut', 0.5)).toBeCloseTo(0.5, 6);
  });
});

describe('quaternions', () => {
  it('slerps the short way round, even near the antipode', () => {
    const a: Quat = [0, 0, 0, 1];
    // 170 degrees about Z, which is close enough to the far side that a sign
    // slip sends the arm through the body rather than round it.
    const far: Quat = [0, 0, Math.sin((170 * Math.PI) / 360), Math.cos((170 * Math.PI) / 360)];
    const mid = quatSlerp(a, far, 0.5);
    expect(quatAngle(a, mid)).toBeCloseTo(85, 4);
    const flipped: Quat = [-far[0], -far[1], -far[2], -far[3]];
    expect(quatSlerp(a, flipped, 0.5)).toEqual(mid);
  });

  it('stays a unit quaternion when the ends nearly coincide', () => {
    const a: Quat = [0, 0, 0, 1];
    const b: Quat = [0.0001, 0, 0, Math.sqrt(1 - 0.0001 ** 2)];
    const mid = quatSlerp(a, b, 0.5);
    expect(Math.hypot(...mid)).toBeCloseTo(1, 9);
  });

  it('composes in the bone’s own frame, not the world’s', () => {
    const turn: Quat = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
    expect(quatMul([0, 0, 0, 1], turn)).toEqual(turn);
  });
});

describe('a key is a whole pose', () => {
  it('puts an axis a key does not name back at rest rather than holding it', () => {
    // The rule the table is meant to be readable under: a row is a pose, not a
    // patch on the row above it. `chest` is named only in the middle key, so it
    // is at rest in the first and the last.
    expect(quatAngle(poseAt(CLIP, rig, 0).get('Spine2') ?? [0, 0, 0, 1], [0, 0, 0, 1])).toBeCloseTo(0, 6);
    expect(quatAngle(poseAt(CLIP, rig, 200).get('Spine2') ?? [0, 0, 0, 1], [0, 0, 0, 1])).toBeCloseTo(20, 4);
    expect(quatAngle(poseAt(CLIP, rig, 400).get('Spine2') ?? [0, 0, 0, 1], [0, 0, 0, 1])).toBeCloseTo(0, 6);
  });

  it('keeps a bone in the cast for the whole clip once any key names it', () => {
    // Otherwise the mixer holds it at *bind* for the frames it is missing from,
    // which is a bone snapping out of whatever the outgoing clip had it doing.
    for (const ms of [0, 100, 200, 300, 400]) {
      expect([...poseAt(CLIP, rig, ms).keys()].sort()).toEqual(['RightArm', 'Spine2']);
    }
  });

  it('holds the ends rather than extrapolating past them', () => {
    expect(poseAt(CLIP, rig, -500)).toEqual(poseAt(CLIP, rig, 0));
    expect(poseAt(CLIP, rig, 5000)).toEqual(poseAt(CLIP, rig, 400));
  });

  it('names a bone with every axis at zero rather than dropping it', () => {
    const held = keyRotations(rig, { rightArm: { lateral: 0 } });
    expect(held.get('RightArm')).toEqual([0, 0, 0, 1]);
  });
});

describe('what lands in the channels', () => {
  it('composes the offset onto the bind rotation', () => {
    // The multiply that, forgotten, plays every bone from a T-pose the rig never
    // had. `RightArm` has a quarter-turn bind rotation precisely to catch it.
    const bind = rig.nodes[5]?.rotation as Quat;
    const offsets = poseAt(CLIP, rig, 200);
    const final = finalRotations(rig, offsets);
    expect(final.get('RightArm')).toEqual(quatMul(bind, offsets.get('RightArm') as Quat));
    expect(quatAngle(final.get('RightArm') as Quat, bind)).toBeCloseTo(90, 4);
  });

  it('samples at the clip’s rate, ending exactly on the last frame', () => {
    const animation = authorClip(CLIP, rig);
    expect(frameCount(CLIP)).toBe(25);
    for (const channel of animation.channels) {
      expect(channel.times.length).toBe(25);
      expect(channel.times[0]).toBe(0);
      expect(channel.times[24]).toBeCloseTo(0.4, 6);
    }
  });

  it('carries the easing in the samples, because the sampler is LINEAR', () => {
    const eased: AuthoredClip = {
      ...CLIP,
      keys: [
        { label: 'start', atMs: 0, ease: 'linear', turns: { rightArm: { lateral: 0 } } },
        { label: 'end', atMs: 400, ease: 'in', turns: { rightArm: { lateral: 90 } } },
      ],
    };
    const half = quatAngle(poseAt(eased, rig, 200).get('RightArm') as Quat, [0, 0, 0, 1]);
    // An `in` ease is a cubic, so halfway through the time is an eighth of the
    // way through the turn. A clip that emitted one key per pose would have this
    // at 45 degrees and the strike would read as a shove.
    expect(half).toBeCloseTo(90 / 8, 3);
  });

  it('writes a mesh-less document with the rig’s own node names', () => {
    // Three binds a clip's tracks to a model by node *name*, so these have to be
    // the same strings the mesh carries -- copied rather than rebuilt.
    const json = readGlbJson(writeGlb(authorClipDocument(CLIP, rig, 'test'))) as {
      nodes: { name: string }[];
      meshes?: unknown[];
      skins?: unknown[];
      animations: { channels: { target: { node: number; path: string } }[] }[];
    };
    expect(json.meshes).toBeUndefined();
    expect(json.skins).toBeUndefined();
    expect(json.nodes.map((node) => node.name)).toEqual(SPEC.map((bone) => bone.name));
    const channels = json.animations[0]?.channels ?? [];
    expect(channels.map((channel) => channel.target.path)).toEqual(channels.map(() => 'rotation'));
    expect(channels.map((channel) => json.nodes[channel.target.node]?.name).sort()).toEqual(['RightArm', 'Spine2']);
  });
});
