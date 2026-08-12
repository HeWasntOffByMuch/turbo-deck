/**
 * The reference unit and the `.glb` it is written into (spec 110).
 *
 * These assert the rig-integrity items from the validation checklist that can be
 * answered without a renderer -- bone contract, weights, root motion -- against
 * the one asset the project actually has. When a real Tripo rig arrives the same
 * assertions are what it has to pass.
 */

import { describe, expect, it } from 'vitest';
import skeletonDoc from '../../assets/units/biped.skeleton.json' with { type: 'json' };
import devSkeletonDoc from '../../assets/units/dev/mannequin-dev.skeleton.json' with { type: 'json' };
import devUnitDef from '../../assets/units/dev/mannequin.unitdef.json' with { type: 'json' };
import { readGlbJson, writeGlb } from './glb.js';
import { BONE_NAMES, bindPositions, buildReferenceUnit, REFERENCE_HEIGHT } from './reference-unit.js';
import { validateSkeleton } from './validate.js';

const unit = buildReferenceUnit(skeletonDoc.canonicalHeight);

interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
}

// --- the rig -----------------------------------------------------------------

describe('the reference rig', () => {
  it('is the same bone contract as its own committed skeleton', () => {
    // The generator and the document it wrote have to agree, or the mannequin
    // is checked against a contract it does not meet. It is held against
    // `mannequin-dev` rather than against the shipped family (spec 139): this
    // rig is mixamo-named and hand-authored, and the family real bodies animate
    // on is tripo-named and measured off a generated rig. Two vocabularies, on
    // purpose, and this is the one that keeps the mixamo half exercised.
    expect(BONE_NAMES).toEqual(devSkeletonDoc.bones.map((bone) => bone.name));
  });

  it('validates, with a measured bind pose rather than a provisional one', () => {
    const result = validateSkeleton(unit.skeleton);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).not.toContain('skeleton.provisional');
    expect(unit.skeleton.bindPose).not.toBeNull();
  });

  it('never becomes the family real bodies are held against', () => {
    // The point this has always been making, now that the shipped family has a
    // bind pose of its own (spec 139): a rig we drew ourselves must not be the
    // contract a generated one is checked against, because then the check is
    // against our own assumptions rather than against a real rig. So the two
    // stay separate families, and the shipped one was measured off a body that
    // actually came back from the auto-rig.
    expect(devSkeletonDoc.id).not.toBe(skeletonDoc.id);
    expect(devSkeletonDoc.naming).not.toBe(skeletonDoc.naming);
    expect(skeletonDoc.bindPose?.source).not.toBe(devUnitDef.meshRef);
  });

  it('stands at the height a real rig arrives at, not at world scale', () => {
    // ~1.7 units, so the import scale is a measured ~32 and the normalisation
    // that would otherwise put the first real unit through the floor is
    // exercised from the start.
    expect(unit.authoredHeight).toBeCloseTo(REFERENCE_HEIGHT, 2);
    expect(skeletonDoc.canonicalHeight / unit.authoredHeight).toBeGreaterThan(20);
  });

  it('is a T-pose: both arms level with the shoulders', () => {
    // A bind pose that is the generated idle instead would give every retargeted
    // clip a permanent lean.
    const world = bindPositions();
    const at = (name: string) => world[BONE_NAMES.indexOf(name)] ?? [0, 0, 0];
    const left = at('mixamorig:LeftHand');
    const right = at('mixamorig:RightHand');
    expect(left[1]).toBeCloseTo(right[1], 6);
    expect(left[1]).toBeCloseTo(at('mixamorig:LeftArm')[1] ?? 0, 6);
    // And laterally opposite.
    expect(left[2]).toBeCloseTo(-(right[2] ?? 0), 6);
  });

  it('is left-right symmetric within tolerance', () => {
    const world = bindPositions();
    for (const [index, name] of BONE_NAMES.entries()) {
      if (!name.includes('Left')) continue;
      const mirrored = BONE_NAMES.indexOf(name.replace('Left', 'Right'));
      const a = world[index] ?? [0, 0, 0];
      const b = world[mirrored] ?? [0, 0, 0];
      expect(a[0], name).toBeCloseTo(b[0] ?? 0, 6);
      expect(a[1], name).toBeCloseTo(b[1] ?? 0, 6);
      expect(a[2], name).toBeCloseTo(-(b[2] ?? 0), 6);
    }
  });

  it('has a bone count inside the budget, with no finger joints', () => {
    expect(BONE_NAMES.length).toBeGreaterThanOrEqual(15);
    expect(BONE_NAMES.length).toBeLessThanOrEqual(30);
    expect(BONE_NAMES.some((name) => /(Thumb|Index|Middle|Ring|Pinky)\d/.test(name))).toBe(false);
  });

  it('has no zero-length bone', () => {
    // A bone at its parent's exact position has no direction, and anything that
    // tries to orient to it gets a degenerate basis.
    const world = bindPositions();
    for (const [index, name] of BONE_NAMES.entries()) {
      if (name === 'mixamorig:Hips') continue;
      const self = world[index] ?? [0, 0, 0];
      const parentName = unit.skeleton.bones[index]?.parent;
      if (!parentName) continue;
      const parent = world[BONE_NAMES.indexOf(parentName)] ?? [0, 0, 0];
      const distance = Math.hypot(
        (self[0] ?? 0) - (parent[0] ?? 0),
        (self[1] ?? 0) - (parent[1] ?? 0),
        (self[2] ?? 0) - (parent[2] ?? 0),
      );
      expect(distance, name).toBeGreaterThan(1e-4);
    }
  });
});

// --- the skin ----------------------------------------------------------------

describe('the skinned mesh', () => {
  const mesh = unit.meshGlb.mesh;

  it('exists and has geometry', () => {
    expect(mesh).not.toBeNull();
    expect((mesh?.positions.length ?? 0) / 3).toBeGreaterThan(100);
  });

  it('has every vertex weighted, summing to one', () => {
    const weights = mesh?.weights ?? new Float32Array();
    for (let i = 0; i < weights.length; i += 4) {
      const sum = (weights[i] ?? 0) + (weights[i + 1] ?? 0) + (weights[i + 2] ?? 0) + (weights[i + 3] ?? 0);
      expect(sum, `vertex ${i / 4}`).toBeCloseTo(1, 5);
    }
  });

  it('has no orphan vertex, weighted to nothing', () => {
    const weights = mesh?.weights ?? new Float32Array();
    for (let i = 0; i < weights.length; i += 4) {
      expect((weights[i] ?? 0) > 0, `vertex ${i / 4}`).toBe(true);
    }
  });

  it('binds no vertex to more than four bones', () => {
    // True by construction here -- glTF's JOINTS_0 holds exactly four -- but it
    // is the checklist item, and a second joint set would break it silently.
    const joints = mesh?.joints ?? new Uint16Array();
    expect(joints.length % 4).toBe(0);
    expect(joints.length / 4).toBe((mesh?.positions.length ?? 0) / 3);
  });

  it('references only bones that exist', () => {
    const joints = mesh?.joints ?? new Uint16Array();
    for (const joint of joints) expect(joint).toBeLessThan(BONE_NAMES.length);
  });

  it('has no degenerate triangle', () => {
    const indices = mesh?.indices ?? new Uint16Array();
    expect(indices.length % 3).toBe(0);
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i];
      const b = indices[i + 1];
      const c = indices[i + 2];
      expect(a === b || b === c || a === c, `triangle ${i / 3}`).toBe(false);
    }
  });

  it('references every vertex it declares', () => {
    const indices = mesh?.indices ?? new Uint16Array();
    const used = new Set<number>(indices);
    expect(used.size).toBe((mesh?.positions.length ?? 0) / 3);
  });
});

// --- the clips ---------------------------------------------------------------

describe('the clips', () => {
  it('carry no root translation channel', () => {
    // Root motion is stripped at import and asserted loudly about, so nothing
    // here is allowed to author one in the first place.
    for (const clip of unit.clipGlbs) {
      const gltf = readGlbJson(writeGlb(clip.document));
      const animations = (gltf['animations'] ?? []) as { channels: { target: { path: string } }[] }[];
      for (const animation of animations) {
        for (const channel of animation.channels) {
          expect(channel.target.path, clip.id).toBe('rotation');
        }
      }
    }
  });

  it('carry no mesh, because a clip is animation-only', () => {
    for (const clip of unit.clipGlbs) {
      expect(clip.document.mesh, clip.id).toBeNull();
      const gltf = readGlbJson(writeGlb(clip.document));
      expect(gltf['meshes'], clip.id).toBeUndefined();
      expect(gltf['skins'], clip.id).toBeUndefined();
    }
  });

  it('target bones by the names the skeleton declares', () => {
    for (const clip of unit.clipGlbs) {
      const gltf = readGlbJson(writeGlb(clip.document));
      const nodes = (gltf['nodes'] ?? []) as GltfNode[];
      const animations = (gltf['animations'] ?? []) as { channels: { target: { node: number } }[] }[];
      for (const animation of animations) {
        for (const channel of animation.channels) {
          const name = nodes[channel.target.node]?.name ?? '';
          expect(BONE_NAMES, clip.id).toContain(name);
        }
      }
    }
  });

  it('have ascending event markers inside 0..1', () => {
    for (const clip of unit.clips) {
      let previous = -1;
      for (const event of clip.events) {
        expect(event.normalizedTime, `${clip.id}/${event.name}`).toBeGreaterThan(previous);
        expect(event.normalizedTime).toBeGreaterThanOrEqual(0);
        expect(event.normalizedTime).toBeLessThanOrEqual(1);
        previous = event.normalizedTime;
      }
    }
  });

  it('animate something', () => {
    for (const clip of unit.clipGlbs) {
      expect(clip.document.animations[0]?.channels.length ?? 0, clip.id).toBeGreaterThan(0);
    }
  });
});

// --- the container -----------------------------------------------------------

describe('the glb container', () => {
  const bytes = writeGlb(unit.meshGlb);

  it('is a valid glb header', () => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    expect(view.getUint32(4, true)).toBe(2);
    expect(view.getUint32(8, true)).toBe(bytes.byteLength);
  });

  it('is a whole number of four-byte words', () => {
    // Misaligned chunks load everywhere except the one reader that is strict,
    // which is the worst possible way for this to be wrong.
    expect(bytes.byteLength % 4).toBe(0);
  });

  it('carries a skin whose joints are the skeleton, in order', () => {
    const gltf = readGlbJson(bytes);
    const nodes = (gltf['nodes'] ?? []) as GltfNode[];
    const skins = (gltf['skins'] ?? []) as { joints: number[] }[];
    expect(skins).toHaveLength(1);
    expect((skins[0]?.joints ?? []).map((index) => nodes[index]?.name)).toEqual(BONE_NAMES);
  });

  it('parents every bone the way the skeleton says', () => {
    const gltf = readGlbJson(bytes);
    const nodes = (gltf['nodes'] ?? []) as GltfNode[];
    const parentOf = new Map<string, string | null>();
    for (const name of BONE_NAMES) parentOf.set(name, null);
    nodes.forEach((node) => {
      for (const child of node.children ?? []) {
        const childName = nodes[child]?.name;
        if (childName !== undefined && parentOf.has(childName)) parentOf.set(childName, node.name ?? null);
      }
    });
    for (const bone of unit.skeleton.bones) {
      expect(parentOf.get(bone.name), bone.name).toBe(bone.parent);
    }
  });

  it('is byte-identical when built twice', () => {
    // It is committed, so a regeneration that changed nothing must produce no
    // diff -- otherwise nobody can tell a real change from a rebuild.
    const again = writeGlb(buildReferenceUnit(skeletonDoc.canonicalHeight).meshGlb);
    expect(Array.from(again)).toEqual(Array.from(bytes));
  });
});
