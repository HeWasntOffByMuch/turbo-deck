/**
 * Write the radish raccoon's rigged `.glb` (spec 277).
 *
 * The input is the mesh as it was generated -- one primitive, one material, one
 * jpeg -- and the output is that same mesh bound to the authored skeleton in
 * `src/units/radish-raccoon-rig.ts`. What arrives with the mesh is an auto-rig
 * that put the right knee a body's width outside the animal; it is replaced
 * whole rather than corrected.
 *
 * **Container surgery rather than `writeGlb`.** `glb.ts` writes the subset this
 * project *authors* -- one skin, one flat-coloured mesh, rotation channels --
 * and has no UVs, no material and no texture, because the only thing it has
 * ever had to write is the reference mannequin. This model is textured, so its
 * geometry, its material and its 310 KB of jpeg are carried across verbatim and
 * only the parts that describe the rig are rebuilt: the node tree, the skin,
 * the two skinning attributes and the positions.
 *
 * Positions are rewritten because the mesh is re-centred (`MESH_OFFSET`), and
 * that is done to the vertices rather than to a node transform for a reason
 * glTF makes non-negotiable: a skinned mesh's own node transform is ignored, so
 * the offset has nowhere else to live where the renderer would honour it.
 *
 * `npx tsx scripts/make-radish-raccoon.ts`
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { splitGlb, readAccessor } from '../src/units/glb-read.js';
import { skeletonFromRig } from '../src/units/skeleton-from-rig.js';
import { DEFAULT_CANONICAL_HEIGHT } from '../src/units/canonical-height.js';
import { writeGlbContainer } from '../src/units/glb.js';
import { MESH_OFFSET, RADISH_RACCOON_BONES, BONE_INDEX, RADISH_RACCOON_FAMILY } from '../src/units/radish-raccoon-rig.js';
import { buildSkin, INFLUENCES } from '../src/units/radish-raccoon-skin.js';

const SOURCE = 'assets/units/radish_raccoon_2/radish_raccoon_2.unrigged.glb';
const OUT = 'assets/units/radish_raccoon_2/radish_raccoon_2.glb';
const SKELETON = `assets/units/${RADISH_RACCOON_FAMILY}.skeleton.json`;

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const ARRAY_BUFFER = 34962;

/** Grows the binary chunk, keeping every view four-byte aligned as glTF requires. */
class Bin {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  push(data: ArrayBufferView): { byteOffset: number; byteLength: number } {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad > 0) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const byteOffset = this.length;
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.parts.push(bytes);
    this.length += bytes.byteLength;
    return { byteOffset, byteLength: bytes.byteLength };
  }

  finish(): Uint8Array {
    const pad = (4 - (this.length % 4)) % 4;
    const out = new Uint8Array(this.length + pad);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  }
}

/** The slice of a glTF JSON document these scripts read. Narrow on purpose. */
interface GltfJson {
  readonly meshes: readonly { readonly name: string; readonly primitives: readonly GltfPrimitive[] }[];
  readonly accessors: readonly { readonly bufferView: number; readonly componentType: number; readonly count: number }[];
  readonly bufferViews: readonly { readonly byteOffset?: number; readonly byteLength: number }[];
  readonly images: readonly { readonly name: string; readonly mimeType: string; readonly bufferView: number }[];
  readonly materials: readonly unknown[];
  readonly textures: readonly unknown[];
  readonly samplers: readonly unknown[];
  readonly nodes: readonly { readonly name?: string; readonly mesh?: number }[];
  readonly skins?: readonly { readonly joints: readonly number[]; readonly inverseBindMatrices: number }[];
}
interface GltfPrimitive {
  readonly attributes: Readonly<Record<string, number>>;
  readonly indices: number;
  readonly material: number;
}

const source = splitGlb(new Uint8Array(readFileSync(SOURCE)));
const json = source.json as unknown as GltfJson;
const primitive = json.meshes[0]?.primitives[0];
if (!primitive) throw new Error(`${SOURCE} has no mesh primitive to bind`);
const bufferView = (index: number): { byteOffset?: number; byteLength: number } => {
  const accessor = json.accessors[index];
  const view = accessor === undefined ? undefined : json.bufferViews[accessor.bufferView];
  if (!view) throw new Error(`${SOURCE}: accessor ${index} has no buffer view`);
  return view;
};

const raw = readAccessor(source, primitive.attributes['POSITION'] as number) as Float32Array;
const indices = readAccessor(source, primitive.indices) as Uint32Array;
const count = raw.length / 3;

// The mesh is generated centred on its own bounding box in every axis, so it
// arrives half a unit underground. Every measurement the rig is built from was
// taken with the feet on zero, so the first thing that happens to it is being
// stood up -- derived from its own lowest vertex rather than typed, so a
// regenerated mesh is stood up by its own amount.
const lift = -Math.min(...Array.from({ length: count }, (_, i) => raw[i * 3 + 1] as number));
const positions = new Float32Array(raw.length);
for (let i = 0; i < count; i += 1) {
  positions[i * 3] = raw[i * 3] as number;
  positions[i * 3 + 1] = (raw[i * 3 + 1] as number) + lift;
  positions[i * 3 + 2] = raw[i * 3 + 2] as number;
}


const skin = buildSkin({ positions, indices }, MESH_OFFSET);

// --- positions, shifted onto the ground the animal stands on ---
const moved = new Float32Array(positions.length);
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < count; i += 1) {
  for (let k = 0; k < 3; k += 1) {
    const v = (positions[i * 3 + k] as number) + (MESH_OFFSET[k] as number);
    moved[i * 3 + k] = v;
    min[k] = Math.min(min[k] as number, v);
    max[k] = Math.max(max[k] as number, v);
  }
}

// --- the node tree ---
const bones = RADISH_RACCOON_BONES;
const meshNode = bones.length;
const armatureNode = bones.length + 1;
const childrenOf = new Map<number, number[]>();
bones.forEach((bone, index) => {
  if (bone.parent === null) return;
  const parent = BONE_INDEX.get(bone.parent);
  if (parent === undefined) throw new Error(`${bone.name} names a parent that is not in the rig: ${bone.parent}`);
  const kids = childrenOf.get(parent) ?? [];
  kids.push(index);
  childrenOf.set(parent, kids);
});

const nodes: Record<string, unknown>[] = bones.map((bone, index) => {
  const parent = bone.parent === null ? undefined : bones[BONE_INDEX.get(bone.parent) as number];
  const parentRest = parent?.rest ?? [0, 0, 0];
  const node: Record<string, unknown> = {
    name: bone.name,
    // Local translation, and no rotation at all: an authored rig has no reason
    // to inherit a generator's non-identity bind rotations, and identity ones
    // make a bone's local frame the world frame everywhere downstream.
    translation: [bone.rest[0] - (parentRest[0] as number), bone.rest[1] - (parentRest[1] as number), bone.rest[2] - (parentRest[2] as number)],
  };
  const kids = childrenOf.get(index);
  if (kids) node.children = kids;
  return node;
});
nodes.push({ name: json.nodes.find((node) => node.mesh !== undefined)?.name ?? 'radish_raccoon_mesh', mesh: 0, skin: 0 });
nodes.push({ name: 'Armature', children: [meshNode, 0] });

// --- inverse bind matrices: bind rotations are identity, so each is a
//     translation by minus the bone's rest position, column-major ---
const ibm = new Float32Array(bones.length * 16);
bones.forEach((bone, index) => {
  const m = ibm.subarray(index * 16, index * 16 + 16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  m[12] = -bone.rest[0];
  m[13] = -bone.rest[1];
  m[14] = -bone.rest[2];
});

const jointBytes = new Uint8Array(count * INFLUENCES);
for (let i = 0; i < jointBytes.length; i += 1) {
  const j = skin.joints[i] as number;
  if (j > 255) throw new Error(`joint index ${j} does not fit an unsigned byte`);
  jointBytes[i] = j;
}

// --- rebuild the binary chunk: what is kept, then what is new ---
const bin = new Bin();
const keep = (view: { byteOffset?: number; byteLength: number }): { byteOffset: number; byteLength: number } => {
  const start = view.byteOffset ?? 0;
  return bin.push(source.bin.subarray(start, start + view.byteLength));
};
const normals = keep(bufferView(primitive.attributes['NORMAL'] as number));
const texcoords = keep(bufferView(primitive.attributes['TEXCOORD_0'] as number));
const triangles = keep(bufferView(primitive.indices));
const imageSource = json.images[0];
if (!imageSource) throw new Error(`${SOURCE} has no texture to carry across`);
const image = keep(json.bufferViews[imageSource.bufferView] as { byteOffset?: number; byteLength: number });
const posView = bin.push(moved);
const jointView = bin.push(jointBytes);
const weightView = bin.push(skin.weights);
const ibmView = bin.push(ibm);

const binary = bin.finish();

const bufferViews = [
  { buffer: 0, ...normals, target: ARRAY_BUFFER },
  { buffer: 0, ...texcoords, target: ARRAY_BUFFER },
  { buffer: 0, ...triangles, target: 34963 },
  { buffer: 0, ...image },
  { buffer: 0, ...posView, target: ARRAY_BUFFER },
  { buffer: 0, ...jointView, target: ARRAY_BUFFER },
  { buffer: 0, ...weightView, target: ARRAY_BUFFER },
  { buffer: 0, ...ibmView },
];

const indexAccessor = json.accessors[primitive.indices] as { componentType: number; count: number };

const accessors = [
  { bufferView: 0, componentType: FLOAT, count, type: 'VEC3' }, // NORMAL
  { bufferView: 1, componentType: FLOAT, count, type: 'VEC2' }, // TEXCOORD_0
  { bufferView: 2, componentType: indexAccessor.componentType, count: indexAccessor.count, type: 'SCALAR' },
  { bufferView: 4, componentType: FLOAT, count, type: 'VEC3', min, max },
  { bufferView: 5, componentType: UNSIGNED_BYTE, count, type: 'VEC4' },
  { bufferView: 6, componentType: FLOAT, count, type: 'VEC4' },
  { bufferView: 7, componentType: FLOAT, count: bones.length, type: 'MAT4' },
];

const out = {
  asset: { version: '2.0', generator: 'turbo-deck scripts/make-radish-raccoon.ts' },
  scene: 0,
  scenes: [{ name: 'Scene', nodes: [armatureNode] }],
  nodes,
  materials: json.materials,
  // The texture entry is rebuilt rather than copied. Carrying `textures` across
  // while `samplers` may or may not exist on the source is a dangling sampler
  // index waiting to happen: the unrigged generation has no sampler array and
  // the rigged one does, so a copy is correct for whichever file it was last
  // run against. An absent sampler is glTF's own default filtering, which is
  // what this model had and what three would have picked anyway.
  ...(json.samplers === undefined ? {} : { samplers: json.samplers }),
  textures: [json.samplers === undefined ? { source: 0 } : { source: 0, sampler: 0 }],
  images: [{ name: imageSource.name, mimeType: imageSource.mimeType, bufferView: 3 }],
  meshes: [
    {
      name: json.meshes[0]?.name ?? 'radish_raccoon',
      primitives: [
        {
          attributes: { POSITION: 3, NORMAL: 0, TEXCOORD_0: 1, JOINTS_0: 4, WEIGHTS_0: 5 },
          indices: 2,
          material: primitive.material,
        },
      ],
    },
  ],
  skins: [{ name: 'Armature', joints: bones.map((_, index) => index), inverseBindMatrices: 6, skeleton: 0 }],
  accessors,
  bufferViews,
  buffers: [{ byteLength: binary.byteLength }],
};

writeFileSync(OUT, writeGlbContainer(out, binary));

// --- the family document, derived from the file that was just written ---
//
// Derived rather than authored beside the rig table, because the thing a
// consumer resolves a socket or a bind pose against is the `.glb`, and a
// hand-written document is a second description of it that agrees until one of
// them is edited. `skeletonFromRig` is what the authoring server uses for the
// same reason.
const written = splitGlb(new Uint8Array(readFileSync(OUT)));
const derived = skeletonFromRig(written, {
  id: RADISH_RACCOON_FAMILY,
  source: 'radish_raccoon_2/radish_raccoon_2.glb',
  canonicalHeight: DEFAULT_CANONICAL_HEIGHT,
  comment:
    "The radish raccoon's rig family (spec 277), and the first in this project that was authored rather than " +
    'bought. It is not a member of `biped`: that family is 41 bones of humanoid with twist chains, and this ' +
    'animal has no visible legs, two mittens, a root for a tail and three leaves -- so `compareToFamily` would ' +
    'reject it on every count, correctly. Derived from the mesh by `scripts/make-radish-raccoon.ts`, which is ' +
    'also what writes the mesh, so the two cannot drift; the bone table it is derived from is ' +
    '`src/units/radish-raccoon-rig.ts` and the reasoning is in that file. It is tripo-named because ' +
    '`naming.ts` claims a vocabulary only when every signature role resolves, and a rig on neither contract ' +
    'silently loses its sockets, its facing measurement and its bind-pose check.',
});
for (const issue of derived.issues) console.log(`  ${issue.severity} ${issue.code}: ${issue.message}`);
if (!derived.skeleton) throw new Error('no skeleton could be derived from the rig just written');
writeFileSync(SKELETON, `${JSON.stringify(derived.skeleton, null, 2)}\n`);

const tally = new Map<string, number>();
for (const label of skin.labels) tally.set(label, (tally.get(label) ?? 0) + 1);
console.log(`${OUT}: ${bones.length} bones, ${count} vertices, ${indices.length / 3} triangles, ${(binary.byteLength / 1024).toFixed(0)} KB`);
console.log(`stood up by ${lift.toFixed(4)}, re-centred by [${MESH_OFFSET.join(', ')}]`);
console.log(`${SKELETON}: ${derived.skeleton.bones.length} bones, ${derived.skeleton.sockets.length} sockets, rig height ${derived.measuredHeight.toFixed(4)}`);
console.log('vertices per part:', [...tally].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('  '));
