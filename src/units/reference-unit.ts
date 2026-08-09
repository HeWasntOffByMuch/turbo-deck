/**
 * The reference unit (spec 110).
 *
 * A complete, real, skinned biped built from arithmetic: the 25-bone mixamo
 * contract, a low-poly body rigidly bound to it, and four clips. It exists
 * because every other part of this pipeline needs something to run against and
 * the alternative -- writing the preview, the deformation checks and the
 * screenshot baselines against an asset nobody has yet -- is writing them blind.
 *
 * Three decisions are load-bearing rather than incidental:
 *
 *  - **It is ~1.7 units tall**, which is the height a mixamo rig actually
 *    arrives at, not the ~56 world units this game's bodies are. So the import
 *    scale is a measured factor of about thirty-two, and the scale
 *    normalisation that would otherwise put the first real unit through the
 *    floor is exercised from the beginning rather than discovered later.
 *  - **Every vertex is bound to exactly one bone.** Rigid rather than smooth,
 *    because a mannequin does not need a good shoulder and a fabricated one
 *    would make the deformation checks pass against a quality nobody authored.
 *    Weights still sum to 1 and no vertex exceeds four bones, which is what the
 *    checklist actually asserts.
 *  - **Every channel is a rotation.** Not one translation channel anywhere, so
 *    the "no root motion" rule has a fixture that genuinely satisfies it.
 *
 * Pure: given the same input it produces the same bytes, which is what lets the
 * result be committed and reviewed as a diff.
 */

import type { GlbAnimation, GlbChannel, GlbDocument, GlbMesh, GlbNode } from './glb.js';
import type { Clip, ClipEvent, Skeleton, SkeletonBone } from './types.js';

/** Up is +Y and forward is +X, matching every other rig in the scene. */
export const REFERENCE_HEIGHT = 1.72;

interface BoneSpec {
  readonly name: string;
  readonly parent: string | null;
  readonly offset: readonly [number, number, number];
}

/**
 * The rig, as local offsets from each parent.
 *
 * A T-pose, deliberately: the bind pose has to be a T or an A, never the
 * generated idle, or every clip retargeted onto it inherits the idle's posture
 * as a permanent lean.
 */
const BONES: readonly BoneSpec[] = [
  { name: 'mixamorig:Hips', parent: null, offset: [0, 0.95, 0] },
  { name: 'mixamorig:Spine', parent: 'mixamorig:Hips', offset: [0, 0.1, 0] },
  { name: 'mixamorig:Spine1', parent: 'mixamorig:Spine', offset: [0, 0.11, 0] },
  { name: 'mixamorig:Spine2', parent: 'mixamorig:Spine1', offset: [0, 0.11, 0] },
  { name: 'mixamorig:Neck', parent: 'mixamorig:Spine2', offset: [0, 0.13, 0] },
  { name: 'mixamorig:Head', parent: 'mixamorig:Neck', offset: [0, 0.09, 0] },
  { name: 'mixamorig:HeadTop_End', parent: 'mixamorig:Head', offset: [0, 0.23, 0] },

  { name: 'mixamorig:LeftShoulder', parent: 'mixamorig:Spine2', offset: [0, 0.1, -0.05] },
  { name: 'mixamorig:LeftArm', parent: 'mixamorig:LeftShoulder', offset: [0, 0, -0.13] },
  { name: 'mixamorig:LeftForeArm', parent: 'mixamorig:LeftArm', offset: [0, 0, -0.26] },
  { name: 'mixamorig:LeftHand', parent: 'mixamorig:LeftForeArm', offset: [0, 0, -0.24] },

  { name: 'mixamorig:RightShoulder', parent: 'mixamorig:Spine2', offset: [0, 0.1, 0.05] },
  { name: 'mixamorig:RightArm', parent: 'mixamorig:RightShoulder', offset: [0, 0, 0.13] },
  { name: 'mixamorig:RightForeArm', parent: 'mixamorig:RightArm', offset: [0, 0, 0.26] },
  { name: 'mixamorig:RightHand', parent: 'mixamorig:RightForeArm', offset: [0, 0, 0.24] },

  { name: 'mixamorig:LeftUpLeg', parent: 'mixamorig:Hips', offset: [0, -0.05, -0.09] },
  { name: 'mixamorig:LeftLeg', parent: 'mixamorig:LeftUpLeg', offset: [0, -0.42, 0] },
  { name: 'mixamorig:LeftFoot', parent: 'mixamorig:LeftLeg', offset: [0, -0.4, 0] },
  { name: 'mixamorig:LeftToeBase', parent: 'mixamorig:LeftFoot', offset: [0.08, -0.07, 0] },
  { name: 'mixamorig:LeftToe_End', parent: 'mixamorig:LeftToeBase', offset: [0.08, 0, 0] },

  { name: 'mixamorig:RightUpLeg', parent: 'mixamorig:Hips', offset: [0, -0.05, 0.09] },
  { name: 'mixamorig:RightLeg', parent: 'mixamorig:RightUpLeg', offset: [0, -0.42, 0] },
  { name: 'mixamorig:RightFoot', parent: 'mixamorig:RightLeg', offset: [0, -0.4, 0] },
  { name: 'mixamorig:RightToeBase', parent: 'mixamorig:RightFoot', offset: [0.08, -0.07, 0] },
  { name: 'mixamorig:RightToe_End', parent: 'mixamorig:RightToeBase', offset: [0.08, 0, 0] },
];

export const BONE_NAMES: readonly string[] = BONES.map((bone) => bone.name);

function boneIndex(name: string): number {
  const index = BONES.findIndex((bone) => bone.name === name);
  if (index < 0) throw new Error(`no bone ${name}`);
  return index;
}

/** World bind positions, one forward pass over a parent-before-child list. */
export function bindPositions(): readonly (readonly [number, number, number])[] {
  const world: [number, number, number][] = [];
  BONES.forEach((bone, index) => {
    if (bone.parent === null) {
      world[index] = [...bone.offset] as [number, number, number];
      return;
    }
    const parent = world[boneIndex(bone.parent)] ?? [0, 0, 0];
    world[index] = [parent[0] + bone.offset[0], parent[1] + bone.offset[1], parent[2] + bone.offset[2]];
  });
  return world;
}

export function referenceNodes(): readonly GlbNode[] {
  return BONES.map((bone) => ({
    name: bone.name,
    parent: bone.parent === null ? null : boneIndex(bone.parent),
    translation: bone.offset,
  }));
}

// --- the body ----------------------------------------------------------------

interface BoxBuilder {
  readonly positions: number[];
  readonly normals: number[];
  readonly joints: number[];
  readonly weights: number[];
  readonly indices: number[];
}

/**
 * A box spanning two world points, rigidly bound to one joint.
 *
 * Vertices are authored in the **bind pose's world space**, which is the space
 * the inverse bind matrices map out of. Authoring them in bone-local space
 * instead is the classic way a skinned mesh loads as an exploded cloud.
 */
function addLimb(
  out: BoxBuilder,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  halfWidth: number,
  halfDepth: number,
  joint: number,
): void {
  const base = out.positions.length / 3;
  /**
   * Axis-aligned, inflated on the two axes that are **not** the limb's length.
   *
   * Which axis that is has to be derived, not assumed. This inflated X and Z and
   * left Y alone, which is right for a leg and wrong for an arm: the arms run
   * along Z at a constant height, so the box came out with zero Y extent -- a
   * flat card whose four side faces were degenerate triangles. That is 32 of the
   * mannequin's 156 triangles drawing nothing, and arms that vanish edge-on. It
   * was invisible until spec 115 gave something the ability to read a vertex.
   */
  const span: [number, number, number] = [
    Math.abs(to[0] - from[0]),
    Math.abs(to[1] - from[1]),
    Math.abs(to[2] - from[2]),
  ];
  const along = span.indexOf(Math.max(...span));
  // First cross axis takes the depth, second takes the width -- which for a
  // vertical limb is X and Z, exactly what this did before.
  const cross = [0, 1, 2].filter((axis) => axis !== along);
  const inflate: [number, number, number] = [0, 0, 0];
  inflate[cross[0] ?? 0] = halfDepth;
  inflate[cross[1] ?? 2] = halfWidth;

  const lo: [number, number, number] = [
    Math.min(from[0], to[0]) - inflate[0],
    Math.min(from[1], to[1]) - inflate[1],
    Math.min(from[2], to[2]) - inflate[2],
  ];
  const hi: [number, number, number] = [
    Math.max(from[0], to[0]) + inflate[0],
    Math.max(from[1], to[1]) + inflate[1],
    Math.max(from[2], to[2]) + inflate[2],
  ];

  const corners: [number, number, number][] = [
    [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
    [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]],
  ];
  const faces: { readonly corner: readonly number[]; readonly normal: readonly [number, number, number] }[] = [
    { corner: [0, 3, 2, 1], normal: [0, 0, -1] },
    { corner: [4, 5, 6, 7], normal: [0, 0, 1] },
    { corner: [0, 4, 7, 3], normal: [-1, 0, 0] },
    { corner: [1, 2, 6, 5], normal: [1, 0, 0] },
    { corner: [3, 7, 6, 2], normal: [0, 1, 0] },
    { corner: [0, 1, 5, 4], normal: [0, -1, 0] },
  ];

  let vertex = base;
  for (const face of faces) {
    // Split per face rather than shared: flat shading is the project's look, and
    // a shared corner would average three normals into a rounded edge.
    for (const cornerIndex of face.corner) {
      const corner = corners[cornerIndex] ?? [0, 0, 0];
      out.positions.push(corner[0], corner[1], corner[2]);
      out.normals.push(face.normal[0], face.normal[1], face.normal[2]);
      out.joints.push(joint, 0, 0, 0);
      out.weights.push(1, 0, 0, 0);
    }
    out.indices.push(vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3);
    vertex += 4;
  }
}

export function referenceMesh(): GlbMesh {
  const world = bindPositions();
  const at = (name: string): readonly [number, number, number] => world[boneIndex(name)] ?? [0, 0, 0];
  const out: BoxBuilder = { positions: [], normals: [], joints: [], weights: [], indices: [] };

  const limb = (a: string, b: string, halfWidth: number, halfDepth: number, joint = a): void =>
    addLimb(out, at(a), at(b), halfWidth, halfDepth, boneIndex(joint));

  limb('mixamorig:Hips', 'mixamorig:Spine', 0.14, 0.09);
  limb('mixamorig:Spine1', 'mixamorig:Neck', 0.16, 0.1, 'mixamorig:Spine1');
  limb('mixamorig:Head', 'mixamorig:HeadTop_End', 0.1, 0.09);

  for (const side of ['Left', 'Right'] as const) {
    limb(`mixamorig:${side}Arm`, `mixamorig:${side}ForeArm`, 0.05, 0.05);
    limb(`mixamorig:${side}ForeArm`, `mixamorig:${side}Hand`, 0.042, 0.042);
    limb(`mixamorig:${side}UpLeg`, `mixamorig:${side}Leg`, 0.07, 0.07);
    limb(`mixamorig:${side}Leg`, `mixamorig:${side}Foot`, 0.055, 0.055);
    limb(`mixamorig:${side}Foot`, `mixamorig:${side}ToeBase`, 0.05, 0.06);
  }

  return {
    positions: new Float32Array(out.positions),
    normals: new Float32Array(out.normals),
    joints: new Uint16Array(out.joints),
    weights: new Float32Array(out.weights),
    indices: new Uint16Array(out.indices),
    color: [0.82, 0.74, 0.6],
  };
}

// --- the clips ---------------------------------------------------------------

/** A quaternion for a rotation about one axis. */
function axisQuat(axis: 0 | 1 | 2, radians: number): [number, number, number, number] {
  const half = radians / 2;
  const s = Math.sin(half);
  const out: [number, number, number, number] = [0, 0, 0, Math.cos(half)];
  out[axis] = s;
  return out;
}

interface ClipSpec {
  readonly id: string;
  readonly durationMs: number;
  readonly loop: boolean;
  readonly events: readonly ClipEvent[];
  /** Samples per second. Low on purpose: these are readable curves, not capture. */
  readonly fps: number;
  /** Bone -> the rotation at a normalised time. */
  readonly pose: (bone: string, t: number) => readonly [number, number, number, number] | null;
}

/** Swings a limb about the Z axis -- the lateral axis for a +X-facing rig. */
function swing(amplitude: number, phase: number, t: number): [number, number, number, number] {
  return axisQuat(2, Math.sin((t + phase) * Math.PI * 2) * amplitude);
}

const CLIP_SPECS: readonly ClipSpec[] = [
  {
    id: 'idle',
    durationMs: 2400,
    loop: true,
    events: [],
    fps: 12,
    pose: (bone, t) => {
      // Breathing, and nothing else: the idle has to read as still.
      if (bone === 'mixamorig:Spine1') return axisQuat(2, Math.sin(t * Math.PI * 2) * 0.018);
      if (bone === 'mixamorig:Head') return axisQuat(1, Math.sin(t * Math.PI * 2 + 1) * 0.05);
      if (bone === 'mixamorig:LeftArm') return axisQuat(0, 0.06);
      if (bone === 'mixamorig:RightArm') return axisQuat(0, -0.06);
      return null;
    },
  },
  {
    id: 'walk',
    durationMs: 1000,
    loop: true,
    events: [
      { name: 'footstep.l', normalizedTime: 0.08 },
      { name: 'footstep.r', normalizedTime: 0.58 },
    ],
    fps: 20,
    pose: (bone, t) => {
      switch (bone) {
        case 'mixamorig:LeftUpLeg':
          return swing(0.42, 0, t);
        case 'mixamorig:RightUpLeg':
          return swing(0.42, 0.5, t);
        case 'mixamorig:LeftLeg':
          return axisQuat(2, Math.max(0, -Math.sin(t * Math.PI * 2)) * 0.6);
        case 'mixamorig:RightLeg':
          return axisQuat(2, Math.max(0, -Math.sin((t + 0.5) * Math.PI * 2)) * 0.6);
        case 'mixamorig:LeftArm':
          return swing(0.3, 0.5, t);
        case 'mixamorig:RightArm':
          return swing(0.3, 0, t);
        case 'mixamorig:Spine':
          return axisQuat(1, Math.sin(t * Math.PI * 2) * 0.06);
        default:
          return null;
      }
    },
  },
  {
    id: 'run',
    durationMs: 640,
    loop: true,
    events: [
      { name: 'footstep.l', normalizedTime: 0.05 },
      { name: 'footstep.r', normalizedTime: 0.55 },
    ],
    fps: 24,
    pose: (bone, t) => {
      switch (bone) {
        case 'mixamorig:LeftUpLeg':
          return swing(0.78, 0, t);
        case 'mixamorig:RightUpLeg':
          return swing(0.78, 0.5, t);
        case 'mixamorig:LeftLeg':
          return axisQuat(2, Math.max(0, -Math.sin(t * Math.PI * 2)) * 1.1);
        case 'mixamorig:RightLeg':
          return axisQuat(2, Math.max(0, -Math.sin((t + 0.5) * Math.PI * 2)) * 1.1);
        case 'mixamorig:LeftArm':
          return swing(0.7, 0.5, t);
        case 'mixamorig:RightArm':
          return swing(0.7, 0, t);
        case 'mixamorig:Spine1':
          return axisQuat(2, -0.14);
        default:
          return null;
      }
    },
  },
  {
    // `slash`, not `attack`: clip ids are the API's own preset vocabulary, so a
    // generated unit's swing arrives called `slash` and `scaffold.ts` looks for
    // that name. A reference unit whose swing was called something else was a
    // worked example of the one thing nothing else does.
    id: 'slash',
    durationMs: 900,
    loop: false,
    // The two markers the action timing maps: the frame it commits, and the
    // frame the blow lands. 0.55 is inside the active window of the timing the
    // reference unitdef ships with, which is what makes it a working example.
    events: [
      { name: 'swing.start', normalizedTime: 0 },
      { name: 'swing.impact', normalizedTime: 0.55 },
    ],
    fps: 24,
    pose: (bone, t) => {
      // Back over the shoulder to 0.45, through to 0.62, then recover.
      const draw = Math.min(1, t / 0.45);
      const strike = t < 0.45 ? 0 : Math.min(1, (t - 0.45) / 0.17);
      const recover = t < 0.62 ? 0 : Math.min(1, (t - 0.62) / 0.38);
      const arm = -1.9 * draw + 3.1 * strike - 1.2 * recover;
      switch (bone) {
        case 'mixamorig:RightArm':
          return axisQuat(2, arm);
        case 'mixamorig:RightForeArm':
          return axisQuat(1, -0.5 * draw + 0.8 * strike);
        case 'mixamorig:Spine1':
          return axisQuat(1, -0.35 * draw + 0.7 * strike - 0.35 * recover);
        case 'mixamorig:LeftArm':
          return axisQuat(2, 0.4 * draw - 0.6 * strike);
        default:
          return null;
      }
    },
  },
];

/** Which bones a clip actually animates, so no channel is written flat. */
function animatedBones(spec: ClipSpec): readonly string[] {
  return BONE_NAMES.filter((bone) => {
    for (let i = 0; i <= 8; i += 1) {
      if (spec.pose(bone, i / 8) !== null) return true;
    }
    return false;
  });
}

export function referenceAnimation(spec: ClipSpec): GlbAnimation {
  const frames = Math.max(2, Math.round((spec.durationMs / 1000) * spec.fps) + 1);
  const channels: GlbChannel[] = [];

  for (const bone of animatedBones(spec)) {
    const times = new Float32Array(frames);
    const rotations = new Float32Array(frames * 4);
    for (let frame = 0; frame < frames; frame += 1) {
      const t = frame / (frames - 1);
      times[frame] = (t * spec.durationMs) / 1000;
      const quat = spec.pose(bone, t) ?? [0, 0, 0, 1];
      rotations.set(quat, frame * 4);
    }
    channels.push({ node: boneIndex(bone), times, rotations });
  }
  return { name: spec.id, channels };
}

export interface ReferenceUnit {
  readonly skeleton: Skeleton;
  readonly clips: readonly Clip[];
  readonly meshGlb: GlbDocument;
  /** Clip id -> an animation-only document. */
  readonly clipGlbs: readonly { readonly id: string; readonly document: GlbDocument }[];
  /** Height of the authored model, before the import scale. */
  readonly authoredHeight: number;
}

/**
 * Everything the reference unit is, as data.
 *
 * `canonicalHeight` matches the canonical biped's: both describe a body in the
 * same world, and the whole point of the number is that a mesh authored at any
 * size lands at the height the game draws a player at.
 */
export function buildReferenceUnit(canonicalHeight: number): ReferenceUnit {
  const nodes = referenceNodes();
  const joints = nodes.map((_, index) => index);
  const world = bindPositions();
  const top = world.reduce((highest, position) => Math.max(highest, position[1]), 0);

  const bones: SkeletonBone[] = BONES.map((bone) => ({ name: bone.name, parent: bone.parent }));

  const skeleton: Skeleton = {
    $comment:
      'The development reference rig (spec 110). Same bone contract as biped.skeleton.json, but with a MEASURED bind pose, because this rig was drawn here rather than generated. The canonical skeleton stays provisional until a real Tripo rig is measured against it -- filling it in from this one would defeat the check it exists to make.',
    formatVersion: 1,
    id: 'biped-dev',
    naming: 'mixamo',
    upAxis: '+Y',
    forwardAxis: '+X',
    canonicalHeight,
    boneBudget: { min: 15, max: 30 },
    bones,
    sockets: [
      { id: 'weapon.main', bone: 'mixamorig:RightHand' },
      { id: 'weapon.off', bone: 'mixamorig:LeftHand' },
      { id: 'fx.cast', bone: 'mixamorig:RightHand' },
      { id: 'fx.body', bone: 'mixamorig:Spine2' },
      { id: 'anchor.head', bone: 'mixamorig:Head' },
    ],
    bindPose: {
      source: 'mannequin.glb',
      bones: BONES.map((bone) => ({
        name: bone.name,
        translation: [bone.offset[0], bone.offset[1], bone.offset[2]] as const,
        rotation: [0, 0, 0, 1] as const,
        scale: [1, 1, 1] as const,
      })),
    },
  };

  const clips: Clip[] = CLIP_SPECS.map((spec) => ({
    id: spec.id,
    source: `clips/${spec.id}.glb`,
    durationMs: spec.durationMs,
    loop: spec.loop,
    events: spec.events,
  }));

  return {
    skeleton,
    clips,
    authoredHeight: top,
    meshGlb: {
      nodes,
      joints,
      mesh: referenceMesh(),
      animations: [],
      generator: 'turbo-deck reference unit (spec 110)',
    },
    clipGlbs: CLIP_SPECS.map((spec) => ({
      id: spec.id,
      document: {
        nodes,
        joints,
        mesh: null,
        animations: [referenceAnimation(spec)],
        generator: 'turbo-deck reference clip (spec 110)',
      },
    })),
  };
}
