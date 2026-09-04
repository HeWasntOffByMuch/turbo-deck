/**
 * What the radish raccoon's rig, skin and two clips have to be (spec 277).
 *
 * The subject is the committed `.glb` off disk rather than a fixture, for
 * `pig-strike.test.ts`'s reason one family over: everything interesting here is
 * a fact about *that* file -- where its feet are, which vocabulary its bones
 * answer to, that its limbs are straight at bind. A synthetic rig would pass
 * every assertion below while the animal on disk had a knee outside its own
 * body, which is exactly the state this spec found it in.
 *
 * The clips are measured through `poseAt`, the function the bytes were sampled
 * from, so an assertion here is an assertion about the file.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authorClipDocument, poseAt, quatAngle, type AuthoredClip, type PosedRig, type Quat } from './clip-author.js';
import { readNodeTree, splitGlb, readAccessor, type GlbReadNode } from './glb-read.js';
import { classifyBindPose, checkBindPose } from './mesh-check.js';
import { detectNaming, findRole, type BoneRole } from './naming.js';
import { namingOf, worldPosition } from './pose.js';
import { poseWorldMatrices } from './skin.js';
import { validateClipLib, validateSkeleton } from './validate.js';
import {
  BONE_INDEX,
  CHAIN_TIPS,
  MESH_OFFSET,
  RADISH_RACCOON_BONES,
  RADISH_RACCOON_FAMILY,
} from './radish-raccoon-rig.js';
import { INFLUENCES, labelOf, PART_CHAINS } from './radish-raccoon-skin.js';
import {
  EAR_FLICK_AT,
  EAR_FLICK_SPAN,
  RADISH_RACCOON_CLIPS,
  RADISH_RACCOON_IDLE,
  RADISH_RACCOON_RUN,
} from './radish-raccoon-clips.js';

const UNITS = join(process.cwd(), 'assets', 'units');
const MESH = join(UNITS, 'radish_raccoon_2', 'radish_raccoon_2.glb');
const SKELETON_DOC = join(UNITS, `${RADISH_RACCOON_FAMILY}.skeleton.json`);
const CLIP_LIB_DOC = join(UNITS, `${RADISH_RACCOON_FAMILY}.core.cliplib.json`);
const CLIP_DIR = join(UNITS, `${RADISH_RACCOON_FAMILY}_clips`);

const glb = splitGlb(new Uint8Array(readFileSync(MESH)));
interface TestGltf {
  readonly meshes: readonly { readonly primitives: readonly { readonly attributes: Readonly<Record<string, number>>; readonly indices: number }[] }[];
}
const json = glb.json as unknown as TestGltf;
const primitive = json.meshes[0]?.primitives[0] as { attributes: Record<string, number>; indices: number };
const nodes = readNodeTree(glb);
const names = nodes.map((node) => node.name);
const positions = readAccessor(glb, primitive.attributes['POSITION'] as number) as Float32Array;
const jointsAttr = readAccessor(glb, primitive.attributes['JOINTS_0'] as number) as Uint32Array;
const weightsAttr = readAccessor(glb, primitive.attributes['WEIGHTS_0'] as number) as Float32Array;
const vertices = positions.length / 3;

const naming = namingOf(nodes);
const rig: PosedRig = { nodes, naming: naming === 'unknown' ? 'tripo' : naming };

/** A vertex in the frame the rig table's thresholds were measured in. */
const unshifted = (v: number): readonly [number, number, number] => [
  (positions[v * 3] as number) - (MESH_OFFSET[0] as number),
  (positions[v * 3 + 1] as number) - (MESH_OFFSET[1] as number),
  (positions[v * 3 + 2] as number) - (MESH_OFFSET[2] as number),
];

describe('the rig', () => {
  it('is a tree: one root, and every parent before its child', () => {
    const seen = new Set<string>();
    let roots = 0;
    for (const bone of RADISH_RACCOON_BONES) {
      if (bone.parent === null) roots += 1;
      else expect(seen, `${bone.name}'s parent ${bone.parent} comes after it`).toContain(bone.parent);
      expect(seen, `${bone.name} is named twice`).not.toContain(bone.name);
      seen.add(bone.name);
    }
    expect(roots).toBe(1);
  });

  it('mirrors every sided bone, which is what the skeleton validator requires', () => {
    for (const bone of RADISH_RACCOON_BONES) {
      const mirror = bone.name.startsWith('L_') ? `R_${bone.name.slice(2)}` : bone.name.startsWith('R_') ? `L_${bone.name.slice(2)}` : null;
      if (mirror === null) continue;
      expect(BONE_INDEX.has(mirror), `${bone.name} has no ${mirror}`).toBe(true);
    }
  });

  it('answers to the tripo vocabulary, so nothing downstream falls back to a guess', () => {
    // Not a preference. A rig on neither contract loses every weapon socket
    // (silently), its facing measurement, and its bind-pose check -- all three
    // of which resolve bones through this table rather than through the
    // document's own claim.
    expect(detectNaming(names)).toBe('tripo');
    const required: readonly BoneRole[] = ['hips', 'spine', 'head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot'];
    for (const role of required) expect(findRole(names, 'tripo', role), `no bone for ${role}`).not.toBeNull();
  });

  it('has every bone the rig table names, at the position it names', () => {
    for (const bone of RADISH_RACCOON_BONES) {
      const node = nodes.find((entry) => entry.name === bone.name);
      expect(node, `${bone.name} is not in the .glb`).toBeDefined();
      const at = worldPosition(node as GlbReadNode);
      for (let k = 0; k < 3; k += 1) expect(at[k]).toBeCloseTo(bone.rest[k] as number, 5);
    }
  });

  it('stands on the ground with its feet either side of the origin', () => {
    // The whole reason `MESH_OFFSET` exists: the renderer places a unit at its
    // own mesh origin and never re-centres, so a body centred on its bounding
    // box is drawn in front of the entity it is.
    const left = worldPosition(nodes.find((n) => n.name === 'L_Foot') as GlbReadNode);
    const right = worldPosition(nodes.find((n) => n.name === 'R_Foot') as GlbReadNode);
    expect(left[2]).toBeLessThan(0);
    expect(right[2]).toBeGreaterThan(0);
    expect(Math.abs((left[0] + right[0]) / 2)).toBeLessThan(0.06);
    expect(Math.abs((left[2] + right[2]) / 2)).toBeLessThan(0.06);
    const lowest = Math.min(...Array.from({ length: vertices }, (_, i) => positions[i * 3 + 1] as number));
    expect(lowest).toBeCloseTo(0, 3);
  });

  it('binds with identity rotations, so a bone\'s local frame is the world frame', () => {
    for (const node of nodes) {
      if (!BONE_INDEX.has(node.name)) continue;
      expect(node.rotation[0]).toBeCloseTo(0, 6);
      expect(node.rotation[1]).toBeCloseTo(0, 6);
      expect(node.rotation[2]).toBeCloseTo(0, 6);
      expect(Math.abs(node.rotation[3])).toBeCloseTo(1, 6);
    }
  });

  it('passes the bind-pose gate the bake refuses a unit on', () => {
    const verdict = classifyBindPose(nodes);
    expect(verdict.shape, verdict.reason).toMatch(/^[TA]$/);
    expect(verdict.elbowDegrees).toBeGreaterThan(179);
    expect(verdict.kneeDegrees).toBeGreaterThan(179);
    expect(verdict.asymmetryDegrees).toBeLessThan(4);
    expect(checkBindPose(verdict, 'radish_raccoon_2.glb')).toEqual([]);
  });

  it('gives every open chain a measured tip to be posed about', () => {
    // `flexAxis` falls back to the body's lateral axis for a bone with no
    // child, which hinges a leaf tip sideways where a leaf nods.
    const hasChild = new Set(RADISH_RACCOON_BONES.map((bone) => bone.parent).filter((p): p is string => p !== null));
    for (const bone of RADISH_RACCOON_BONES) {
      if (hasChild.has(bone.name)) continue;
      const isLimbEnd = /Hand$|ToeBase$/.test(bone.name);
      expect(isLimbEnd || CHAIN_TIPS[bone.name] !== undefined, `${bone.name} ends a chain with no tip`).toBe(true);
    }
  });
});

describe('the documents', () => {
  it('validate, and the library binds to this family', () => {
    const skeleton = validateSkeleton(JSON.parse(readFileSync(SKELETON_DOC, 'utf8')));
    expect(skeleton.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const library = validateClipLib(JSON.parse(readFileSync(CLIP_LIB_DOC, 'utf8')));
    expect(library.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(skeleton.value).not.toBeNull();
    expect(library.value).not.toBeNull();
    if (!skeleton.value || !library.value) return;
    expect(skeleton.value.id).toBe(RADISH_RACCOON_FAMILY);
    expect(skeleton.value.bones).toHaveLength(RADISH_RACCOON_BONES.length);
    expect(skeleton.value.bindPose).not.toBeNull();
    // `unit-assets.ts` derives the render-side family id by stripping `.core`,
    // so a library named anything else is a family nothing can look up.
    expect(library.value.id).toBe(`${RADISH_RACCOON_FAMILY}.core`);
    expect(library.value.clips.map((clip) => clip.id).sort()).toEqual(['idle', 'run']);
    for (const clip of library.value.clips) {
      const authored = RADISH_RACCOON_CLIPS.find((entry) => entry.id === clip.id);
      expect(clip.durationMs, `${clip.id} duration drifted from its source`).toBe(authored?.durationMs);
    }
  });
});

describe('the skin', () => {
  it('weights every vertex fully, and only onto bones that exist', () => {
    let unbound = 0;
    for (let v = 0; v < vertices; v += 1) {
      let sum = 0;
      for (let k = 0; k < INFLUENCES; k += 1) {
        const w = weightsAttr[v * INFLUENCES + k] as number;
        const j = jointsAttr[v * INFLUENCES + k] as number;
        expect(j).toBeLessThan(RADISH_RACCOON_BONES.length);
        if (w > 0) sum += w;
      }
      if (sum === 0) unbound += 1;
      else expect(sum).toBeCloseTo(1, 4);
    }
    // A vertex bound to nothing is drawn at the origin, which is the loudest
    // possible version of this bug and is worth its own assertion.
    expect(unbound).toBe(0);
  });

  it('is soft at the seams and hard inside a part', () => {
    // Both extremes are failures: everything shared is mush, nothing shared is
    // a tear at every boundary the moment the body bends.
    let solo = 0;
    let shared = 0;
    for (let v = 0; v < vertices; v += 1) {
      const top = weightsAttr[v * INFLUENCES] as number;
      if (top > 0.98) solo += 1;
      else if (top < 0.75) shared += 1;
    }
    expect(solo / vertices).toBeGreaterThan(0.35);
    expect(shared / vertices).toBeGreaterThan(0.08);
    expect(shared / vertices).toBeLessThan(0.5);
  });

  it('keeps a leaf out of the head and the tail out of the limbs', () => {
    // The failure a distance-based skin would produce, stated as a test: the
    // leaves fold back over the head and the tail sweeps across the body, so
    // the *nearest* bone to a great many of their vertices belongs to neither.
    //
    // What is asserted is the group rather than the exact chain. A leaf vertex
    // driven by the crown is correct -- that is the stalk -- and one near the
    // boundary between two blades may end up on the neighbouring blade, which
    // is the relaxation pass doing its job at a seam. A leaf vertex driven by
    // `Head` is the bug.
    const greens = new Set(['Crown', ...PART_CHAINS.leafA, ...PART_CHAINS.leafB, ...PART_CHAINS.leafC]);
    const tailChain = new Set([...PART_CHAINS.tail, 'Hip']);
    const heaviest = (v: number): string => {
      let best = 0;
      let at = 0;
      for (let k = 0; k < INFLUENCES; k += 1) {
        const w = weightsAttr[v * INFLUENCES + k] as number;
        if (w > best) {
          best = w;
          at = jointsAttr[v * INFLUENCES + k] as number;
        }
      }
      return RADISH_RACCOON_BONES[at]?.name ?? '';
    };
    let leafVertices = 0;
    let strays = 0;
    let highestStray = 0;
    for (let v = 0; v < vertices; v += 1) {
      const label = labelOf(unshifted(v));
      const owner = heaviest(v);
      if (label === 'leafA' || label === 'leafB' || label === 'leafC') {
        leafVertices += 1;
        if (greens.has(owner)) continue;
        strays += 1;
        highestStray = Math.max(highestStray, unshifted(v)[1]);
      } else if (label === 'tail') {
        expect(tailChain.has(owner), `a tail vertex is driven by ${owner}`).toBe(true);
      }
    }
    // Measured: 8 of 11,254, all between y 0.613 and 0.639 -- the last few
    // millimetres of stalk where the three blades disappear into the crown,
    // beside the left ear's own root. The relaxation is what put them there and
    // taking them back would mean a labelling rule shaped around eight buried
    // vertices. What the numbers below actually forbid is the failure that
    // matters: a blade whose *tip* has been handed to the body, which is what a
    // distance-based skin produces and what would show the instant it nodded.
    expect(strays / leafVertices).toBeLessThan(0.02);
    expect(highestStray, 'a leaf vertex out on the blade is driven by the body').toBeLessThan(0.66);
  });

  it('labels the parts the animal actually has', () => {
    const tally = new Map<string, number>();
    for (let v = 0; v < vertices; v += 1) {
      const label = labelOf(unshifted(v));
      tally.set(label, (tally.get(label) ?? 0) + 1);
    }
    // Every part carries geometry. A part with none is a bone driving nothing,
    // which is invisible at bind and is the whole class of bug this spec is
    // about -- the ears were a helmet over the entire skull on the first pass
    // and looked perfect until something twitched.
    for (const part of Object.keys(PART_CHAINS)) {
      expect(tally.get(part) ?? 0, `nothing is labelled ${part}`).toBeGreaterThan(50);
    }
  });
});

/** The rotation offsets a clip holds at a fraction of its cycle. */
function poseFor(clip: AuthoredClip, phase: number): ReadonlyMap<string, Quat> {
  return poseAt(clip, rig, phase * clip.durationMs);
}

/** Where a bone sits, in world space, at a fraction of a clip's cycle. */
function boneAt(clip: AuthoredClip, phase: number, bone: string): readonly [number, number, number] {
  const world = poseWorldMatrices(nodes, poseFor(clip, phase));
  const m = world[nodes.findIndex((n) => n.name === bone)] as readonly number[];
  return [m[12] as number, m[13] as number, m[14] as number];
}

describe('the clips', () => {
  it.each(RADISH_RACCOON_CLIPS.map((clip): readonly [string, AuthoredClip] => [clip.id, clip]))('%s closes its loop exactly', (_id, clip) => {
    // The one property a hand-authored cycle does not get for free, and the one
    // whose failure lands on the single frame nobody scrubs to.
    const start = poseFor(clip, 0);
    const end = poseFor(clip, 1);
    expect([...end.keys()].sort()).toEqual([...start.keys()].sort());
    for (const [bone, quat] of start) {
      expect(quatAngle(quat, end.get(bone) as Quat), `${bone} does not return`).toBeLessThan(0.02);
    }
  });

  it.each(RADISH_RACCOON_CLIPS.map((clip): readonly [string, AuthoredClip] => [clip.id, clip]))('%s writes no translation channel', (_id, clip) => {
    // The server owns where a body is. `authorClipDocument` writes rotations
    // only, and this is the assertion that keeps that true of the committed
    // bytes rather than of the function that made them.
    const bytes = readFileSync(join(CLIP_DIR, `${clip.id}.glb`));
    const document = splitGlb(new Uint8Array(bytes)).json as unknown as {
      readonly animations?: readonly { readonly channels: readonly { readonly target: { readonly path: string } }[] }[];
    };
    for (const animation of document.animations ?? []) {
      for (const channel of animation.channels) expect(channel.target.path).toBe('rotation');
    }
  });

  it.each(RADISH_RACCOON_CLIPS.map((clip): readonly [string, AuthoredClip] => [clip.id, clip]))('%s moves the bones it names', (_id, clip) => {
    const moved = new Set<string>();
    for (let step = 0; step <= 16; step += 1) {
      for (const [bone, quat] of poseFor(clip, step / 16)) {
        if (quatAngle(quat, [0, 0, 0, 1]) > 0.5) moved.add(bone);
      }
    }
    // Legs, arms, body, head, both ears, the tail and all three leaves.
    for (const bone of ['Hip', 'Spine01', 'Head', 'L_Ear', 'R_Ear', 'Tail01', 'Tail04', 'Leaf_A_01', 'Leaf_B_01', 'Leaf_C_01', 'L_Thigh', 'R_Thigh']) {
      expect(moved, `${bone} never moves in ${clip.id}`).toContain(bone);
    }
    expect(moved.has('Root'), 'Root is animated, which is root motion by another name').toBe(false);
  });

  it('run alternates its feet', () => {
    const lift = (bone: string): number[] => Array.from({ length: 24 }, (_, i) => boneAt(RADISH_RACCOON_RUN, i / 24, bone)[1]);
    const left = lift('L_ToeBase');
    const right = lift('R_ToeBase');
    const peak = (track: number[]): number => track.indexOf(Math.max(...track));
    // Half a cycle apart, give or take a frame: this is a run and not a hop.
    const apart = Math.abs(peak(left) - peak(right));
    expect(Math.min(apart, 24 - apart)).toBeGreaterThan(8);
    // And each foot genuinely leaves the ground.
    for (const track of [left, right]) expect(Math.max(...track) - Math.min(...track)).toBeGreaterThan(0.03);
  });

  it('idle steps from one foot to the other', () => {
    const lift = (bone: string): number[] => Array.from({ length: 96 }, (_, i) => boneAt(RADISH_RACCOON_IDLE, i / 96, bone)[1]);
    const left = lift('L_ToeBase');
    const right = lift('R_ToeBase');
    for (const track of [left, right]) expect(Math.max(...track) - Math.min(...track)).toBeGreaterThan(0.02);
    const peak = (track: number[]): number => track.indexOf(Math.max(...track));
    expect(peak(left), 'both feet peak together, which is a hop rather than a shift').not.toBe(peak(right));
  });

  it('the ear flick is a flick: short, twice, and on different ears', () => {
    const angle = (phase: number, bone: string): number => {
      const quat = poseFor(RADISH_RACCOON_IDLE, phase).get(bone);
      return quat ? quatAngle(quat, [0, 0, 0, 1]) : 0;
    };
    const samples = 240;
    const left = Array.from({ length: samples }, (_, i) => angle(i / samples, 'L_Ear'));
    const right = Array.from({ length: samples }, (_, i) => angle(i / samples, 'R_Ear'));
    // Big enough to read across a room.
    expect(Math.max(...left)).toBeGreaterThan(25);
    expect(Math.max(...right)).toBeGreaterThan(25);
    // And rare: an ear that is agitated for most of the clip is a tic.
    const busy = (track: number[]): number => track.filter((v) => v > 12).length / track.length;
    expect(busy(left)).toBeLessThan(0.12);
    expect(busy(right)).toBeLessThan(0.12);
    // The two are not simultaneous -- one animal, two ears, two moments.
    const at = (track: number[]): number => track.indexOf(Math.max(...track)) / samples;
    expect(Math.abs(at(left) - at(right))).toBeGreaterThan(0.2);
    // And the left one lands where the constant says it does, since the preview
    // sheet is aimed off that constant and would photograph nothing if it drifted.
    expect(at(left)).toBeGreaterThan(EAR_FLICK_AT);
    expect(at(left)).toBeLessThan(EAR_FLICK_AT + EAR_FLICK_SPAN);
  });

  it('leaves the greens never still and never in step', () => {
    const tips = ['Leaf_A_02', 'Leaf_B_02', 'Leaf_C_02'] as const;
    const tracks = tips.map((bone) => Array.from({ length: 48 }, (_, i) => boneAt(RADISH_RACCOON_IDLE, i / 48, bone)));
    for (const [index, track] of tracks.entries()) {
      const spread = Math.max(...track.map((p) => p[2])) - Math.min(...track.map((p) => p[2]));
      expect(spread, `${tips[index]} does not move`).toBeGreaterThan(0.004);
    }
    // Three leaves swinging together read as one fan. Each pair peaks at a
    // different moment, which is what the per-blade lag in `appendages` buys.
    const peak = (track: readonly (readonly [number, number, number])[]): number =>
      track.map((p) => p[2]).indexOf(Math.max(...track.map((p) => p[2])));
    const peaks = tracks.map(peak);
    expect(new Set(peaks).size, 'the three blades peak together').toBeGreaterThan(1);
  });
});

describe('PoseKey.bones', () => {
  it('reaches bones the vocabulary has no role for', () => {
    const clip: AuthoredClip = {
      id: 'probe',
      durationMs: 100,
      fps: 30,
      keys: [
        { label: 'a', atMs: 0, ease: 'linear', turns: {}, bones: { Tail02: { up: 0 } } },
        { label: 'b', atMs: 100, ease: 'linear', turns: {}, bones: { Tail02: { up: 30 } } },
      ],
    };
    const turned = poseAt(clip, rig, 100).get('Tail02');
    expect(turned).toBeDefined();
    expect(quatAngle(turned as Quat, [0, 0, 0, 1])).toBeCloseTo(30, 0);
  });

  it('changes nothing for a clip that does not use it', () => {
    // The widening has to be free for every clip authored before it, and the
    // cheapest proof is the same clip authored twice: once as it is written,
    // once with an empty named table added to every key.
    const plain: AuthoredClip = {
      id: 'probe',
      durationMs: 200,
      fps: 30,
      keys: [
        { label: 'a', atMs: 0, ease: 'linear', turns: { head: { up: 0 } } },
        { label: 'b', atMs: 200, ease: 'inOut', turns: { head: { up: 25 } } },
      ],
    };
    const withEmpty: AuthoredClip = { ...plain, keys: plain.keys.map((key) => ({ ...key, bones: {} })) };
    const a = authorClipDocument(plain, rig, 'test');
    const b = authorClipDocument(withEmpty, rig, 'test');
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
