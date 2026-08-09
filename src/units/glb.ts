/**
 * Writing a `.glb` (spec 110).
 *
 * glTF 2.0 is a JSON document and a binary blob in a three-chunk container, and
 * a writer for the subset this project emits -- one skin, one mesh, rotation-only
 * animations -- is smaller than the argument for taking on a dependency to do
 * it. Nothing here reads a `.glb`; three's own `GLTFLoader` does that, and it
 * does it in the browser where the mesh is going anyway.
 *
 * What this exists for is the reference unit: a real skinned model on the real
 * bone contract, so the preview, the deformation checks and the screenshot
 * baselines all have something to run against before a single credit is spent.
 *
 * Pure, and part of the deterministic core, because the file it writes is
 * committed: the same input has to produce the same bytes or the asset shows up
 * as a diff every time somebody regenerates it.
 */

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_BYTE = 5121;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export interface GlbNode {
  readonly name: string;
  /** Index into the node array, or null for a root. */
  readonly parent: number | null;
  readonly translation: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number, number];
  readonly scale?: readonly [number, number, number];
}

export interface GlbMesh {
  /** xyz triples. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** Four joint indices per vertex, into the skin's joint list. */
  readonly joints: Uint16Array;
  /** Four weights per vertex, summing to 1. */
  readonly weights: Float32Array;
  readonly indices: Uint16Array;
  readonly color?: readonly [number, number, number] | undefined;
}

export interface GlbChannel {
  /** Index into the node array. */
  readonly node: number;
  /** Seconds, ascending. */
  readonly times: Float32Array;
  /** Quaternions, xyzw, one per time. */
  readonly rotations: Float32Array;
}

export interface GlbAnimation {
  readonly name: string;
  readonly channels: readonly GlbChannel[];
}

export interface GlbDocument {
  readonly nodes: readonly GlbNode[];
  /** Node indices that are the skin's joints, in the skeleton's canonical order. */
  readonly joints: readonly number[];
  /** Null for an animation-only file, which is what a clip is once baked. */
  readonly mesh: GlbMesh | null;
  readonly animations: readonly GlbAnimation[];
  readonly generator: string;
}

/** Grows a byte buffer, keeping every view four-byte aligned as glTF requires. */
class BinWriter {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  /** Returns the byte offset the data landed at. */
  push(data: ArrayBufferView): number {
    // Every accessor's offset must be a multiple of its component size, and
    // four covers every type here. Misaligned views are the classic way a glb
    // loads everywhere except the one renderer that reads them strictly.
    const padding = (4 - (this.length % 4)) % 4;
    if (padding > 0) {
      this.parts.push(new Uint8Array(padding));
      this.length += padding;
    }
    const offset = this.length;
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.parts.push(bytes);
    this.length += bytes.byteLength;
    return offset;
  }

  finish(): Uint8Array {
    const padding = (4 - (this.length % 4)) % 4;
    const out = new Uint8Array(this.length + padding);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  }
}

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  normalized?: boolean;
}

/** Per-component bounds, which glTF requires on POSITION and on animation inputs. */
function bounds(data: Float32Array, stride: number): { min: number[]; max: number[] } {
  const min = new Array<number>(stride).fill(Number.POSITIVE_INFINITY);
  const max = new Array<number>(stride).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < data.length; i += stride) {
    for (let c = 0; c < stride; c += 1) {
      const value = data[i + c] ?? 0;
      min[c] = Math.min(min[c] ?? value, value);
      max[c] = Math.max(max[c] ?? value, value);
    }
  }
  return { min, max };
}

/**
 * The inverse of each joint's world matrix in the bind pose.
 *
 * Computed here rather than taken as input because it is derived from the node
 * hierarchy and getting the two out of step is the single most common way a
 * skinned mesh loads as an exploded cloud of triangles. Translation-and-rotation
 * only, which is all the rigs here use.
 */
function inverseBindMatrices(nodes: readonly GlbNode[], joints: readonly number[]): Float32Array {
  const world: number[][] = nodes.map(() => identity());
  // Nodes are parent-before-child by contract, so one forward pass suffices.
  nodes.forEach((node, index) => {
    const local = compose(node.translation, node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1]);
    world[index] = node.parent === null ? local : multiply(world[node.parent] ?? identity(), local);
  });

  const out = new Float32Array(joints.length * 16);
  joints.forEach((joint, index) => {
    out.set(invertRigid(world[joint] ?? identity()), index * 16);
  });
  return out;
}

function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Column-major, matching glTF and three. */
function compose(
  t: readonly [number, number, number],
  r: readonly [number, number, number, number],
  s: readonly [number, number, number],
): number[] {
  const [x, y, z, w] = r;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** Inverse of a rotation-and-translation matrix: transpose the basis, re-point it. */
function invertRigid(m: readonly number[]): number[] {
  const out = identity();
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) out[col * 4 + row] = m[row * 4 + col] ?? 0;
  }
  const tx = m[12] ?? 0;
  const ty = m[13] ?? 0;
  const tz = m[14] ?? 0;
  out[12] = -((out[0] ?? 0) * tx + (out[4] ?? 0) * ty + (out[8] ?? 0) * tz);
  out[13] = -((out[1] ?? 0) * tx + (out[5] ?? 0) * ty + (out[9] ?? 0) * tz);
  out[14] = -((out[2] ?? 0) * tx + (out[6] ?? 0) * ty + (out[10] ?? 0) * tz);
  return out;
}

/** Assembles the container: header, JSON chunk, binary chunk. */
export function writeGlb(document: GlbDocument): Uint8Array {
  const bin = new BinWriter();
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number; target?: number }[] = [];
  const accessors: Accessor[] = [];

  const addView = (data: ArrayBufferView, target?: number): number => {
    const byteOffset = bin.push(data);
    bufferViews.push(target === undefined ? { buffer: 0, byteOffset, byteLength: data.byteLength } : { buffer: 0, byteOffset, byteLength: data.byteLength, target });
    return bufferViews.length - 1;
  };
  const addAccessor = (accessor: Accessor): number => {
    accessors.push(accessor);
    return accessors.length - 1;
  };

  const gltf: Record<string, unknown> = {
    asset: { version: '2.0', generator: document.generator },
    scene: 0,
  };

  // --- nodes and the skin ---------------------------------------------------
  const children = new Map<number, number[]>();
  document.nodes.forEach((node, index) => {
    if (node.parent === null) return;
    const list = children.get(node.parent) ?? [];
    list.push(index);
    children.set(node.parent, list);
  });

  const nodes: Record<string, unknown>[] = document.nodes.map((node, index) => {
    const entry: Record<string, unknown> = { name: node.name, translation: [...node.translation] };
    if (node.rotation) entry['rotation'] = [...node.rotation];
    if (node.scale) entry['scale'] = [...node.scale];
    const kids = children.get(index);
    if (kids && kids.length > 0) entry['children'] = kids;
    return entry;
  });

  // A skin only when there is a mesh to deform. A clip file is animation-only --
  // stripped of mesh data at bake time and bound to the skeleton by bone name --
  // so it carries the named nodes and the channels and nothing else.
  if (document.mesh) {
    const ibm = inverseBindMatrices(document.nodes, document.joints);
    const ibmAccessor = addAccessor({
      bufferView: addView(ibm),
      componentType: FLOAT,
      count: document.joints.length,
      type: 'MAT4',
    });
    gltf['skins'] = [{ name: 'skin', joints: [...document.joints], inverseBindMatrices: ibmAccessor }];
  }

  const roots = document.nodes.map((node, index) => (node.parent === null ? index : -1)).filter((i) => i >= 0);

  // --- the mesh -------------------------------------------------------------
  if (document.mesh) {
    const mesh = document.mesh;
    const vertexCount = mesh.positions.length / 3;
    const positionBounds = bounds(mesh.positions, 3);

    const attributes: Record<string, number> = {
      POSITION: addAccessor({
        bufferView: addView(mesh.positions, ARRAY_BUFFER),
        componentType: FLOAT,
        count: vertexCount,
        type: 'VEC3',
        min: positionBounds.min,
        max: positionBounds.max,
      }),
      NORMAL: addAccessor({
        bufferView: addView(mesh.normals, ARRAY_BUFFER),
        componentType: FLOAT,
        count: vertexCount,
        type: 'VEC3',
      }),
      JOINTS_0: addAccessor({
        bufferView: addView(mesh.joints, ARRAY_BUFFER),
        componentType: UNSIGNED_SHORT,
        count: vertexCount,
        type: 'VEC4',
      }),
      WEIGHTS_0: addAccessor({
        bufferView: addView(mesh.weights, ARRAY_BUFFER),
        componentType: FLOAT,
        count: vertexCount,
        type: 'VEC4',
      }),
    };

    const indexAccessor = addAccessor({
      bufferView: addView(mesh.indices, ELEMENT_ARRAY_BUFFER),
      componentType: UNSIGNED_SHORT,
      count: mesh.indices.length,
      type: 'SCALAR',
    });

    const color = mesh.color ?? [0.78, 0.72, 0.62];
    gltf['materials'] = [
      {
        name: 'unit',
        pbrMetallicRoughness: {
          baseColorFactor: [color[0], color[1], color[2], 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ];
    gltf['meshes'] = [{ name: 'body', primitives: [{ attributes, indices: indexAccessor, material: 0 }] }];

    nodes.push({ name: 'body', mesh: 0, skin: 0 });
    roots.push(nodes.length - 1);
  }

  // --- animations -----------------------------------------------------------
  if (document.animations.length > 0) {
    gltf['animations'] = document.animations.map((animation) => {
      const samplers: Record<string, unknown>[] = [];
      const channels: Record<string, unknown>[] = [];
      for (const channel of animation.channels) {
        const timeBounds = bounds(channel.times, 1);
        const input = addAccessor({
          bufferView: addView(channel.times),
          componentType: FLOAT,
          count: channel.times.length,
          type: 'SCALAR',
          min: timeBounds.min,
          max: timeBounds.max,
        });
        const output = addAccessor({
          bufferView: addView(channel.rotations),
          componentType: FLOAT,
          count: channel.rotations.length / 4,
          type: 'VEC4',
        });
        samplers.push({ input, output, interpolation: 'LINEAR' });
        // Rotation only, always. A translation channel on a root is root motion,
        // which this project strips at import and asserts loudly about -- so
        // nothing here is allowed to author one in the first place.
        channels.push({ sampler: samplers.length - 1, target: { node: channel.node, path: 'rotation' } });
      }
      return { name: animation.name, samplers, channels };
    });
  }

  gltf['nodes'] = nodes;
  gltf['scenes'] = [{ nodes: roots }];
  gltf['accessors'] = accessors;
  gltf['bufferViews'] = bufferViews;

  const binary = bin.finish();
  gltf['buffers'] = [{ byteLength: binary.byteLength }];

  // --- the container --------------------------------------------------------
  const jsonText = JSON.stringify(gltf);
  const jsonBytes = new TextEncoder().encode(jsonText);
  // Chunks are padded to four bytes: JSON with spaces so it still parses, and
  // the binary chunk with zeroes.
  const jsonPadding = (4 - (jsonBytes.byteLength % 4)) % 4;
  const jsonChunk = new Uint8Array(jsonBytes.byteLength + jsonPadding);
  jsonChunk.set(jsonBytes);
  jsonChunk.fill(0x20, jsonBytes.byteLength);

  const total = 12 + 8 + jsonChunk.byteLength + 8 + binary.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonChunk.byteLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.set(jsonChunk, 20);
  const binHeader = 20 + jsonChunk.byteLength;
  view.setUint32(binHeader, binary.byteLength, true);
  view.setUint32(binHeader + 4, BIN_CHUNK, true);
  out.set(binary, binHeader + 8);
  return out;
}

/**
 * Reads a `.glb`'s JSON chunk back.
 *
 * Only the JSON: enough for a test to assert about nodes, skins and animation
 * channels without a WebGL context, and not a step toward a second loader.
 * three's `GLTFLoader` is what actually loads a model.
 */
export function readGlbJson(bytes: Uint8Array): Record<string, unknown> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('not a glb');
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== JSON_CHUNK) throw new Error('first chunk is not JSON');
  const text = new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength));
  return JSON.parse(text) as Record<string, unknown>;
}

export { UNSIGNED_BYTE };
