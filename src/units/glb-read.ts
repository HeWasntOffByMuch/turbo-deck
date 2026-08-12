/**
 * Reading a `.glb`'s vertex data (spec 115).
 *
 * `glb.ts` writes one and reads its JSON chunk back; this reads the *binary*
 * chunk, which is what every check in `mesh-check.ts` needs and what nothing in
 * this repo could do before. It is not a second loader: three's `GLTFLoader`
 * still loads every model that reaches a screen. This runs at build time and in
 * tests, where there is no WebGL context and no three.
 *
 * Deliberately narrow. It reads the accessors a skinned unit is made of and the
 * node tree it is posed by, and it refuses anything outside that rather than
 * growing to cover the format:
 *
 *  - no sparse accessors (nothing generates them for skinned geometry),
 *  - no external buffers (a `.glb` has one, embedded, by definition),
 *  - no Draco or meshopt (they are extensions, and a file carrying one is
 *    refused by name rather than silently read as garbage).
 *
 * Pure, and part of the deterministic core.
 */

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const BYTE = 5120;
const UNSIGNED_BYTE = 5121;
const SHORT = 5122;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const FLOAT = 5126;

/** Components per element, by accessor type. */
const COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

const COMPONENT_BYTES: Readonly<Record<number, number>> = {
  [BYTE]: 1,
  [UNSIGNED_BYTE]: 1,
  [SHORT]: 2,
  [UNSIGNED_SHORT]: 2,
  [UNSIGNED_INT]: 4,
  [FLOAT]: 4,
};

/**
 * Extensions that change what the bytes mean.
 *
 * Listed so a compressed file is refused by name. Reading a Draco-compressed
 * primitive's accessors without decoding it does not fail -- it produces
 * plausible nonsense, which would be measured, reported and believed.
 */
const OPAQUE_EXTENSIONS = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'];

export interface GlbBinary {
  readonly json: Record<string, unknown>;
  readonly bin: Uint8Array;
}

/** A node with its local transform and the world matrix implied by the tree. */
export interface GlbReadNode {
  readonly index: number;
  readonly name: string;
  readonly parent: number | null;
  readonly translation: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
  /** Column-major, matching glTF and three. */
  readonly world: readonly number[];
}

export interface SkinnedMeshData {
  /** xyz triples, in bind position. */
  readonly positions: Float32Array;
  readonly normals: Float32Array | null;
  /** Four joint slots per vertex, indices into {@link jointNodes}. */
  readonly joints: Uint32Array;
  /** Four weights per vertex, de-normalized to float. */
  readonly weights: Float32Array;
  readonly indices: Uint32Array;
  /** Node indices the skin's joints are, in skin order. */
  readonly jointNodes: readonly number[];
  /** True when the primitive carries a `JOINTS_1`/`WEIGHTS_1` set. */
  readonly hasSecondInfluenceSet: boolean;
  readonly vertexCount: number;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Splits the container into its JSON and binary chunks.
 *
 * Chunks are walked rather than assumed to be at fixed offsets: the spec allows
 * chunks this reader does not care about, and a writer that emits one would
 * otherwise shift the BIN chunk out from under a hardcoded offset.
 */
export function splitGlb(bytes: Uint8Array): GlbBinary {
  if (bytes.byteLength < 12) throw new Error('not a glb: shorter than a header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error('not a glb: bad magic');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`glb version ${version}, and only 2 is glTF 2.0`);

  let json: Record<string, unknown> | null = null;
  // Widened deliberately: `subarray` of a caller's buffer keeps that buffer's
  // type, and a freshly constructed `Uint8Array` narrows to `ArrayBuffer`.
  let bin: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const length = view.getUint32(at, true);
    const kind = view.getUint32(at + 4, true);
    const start = at + 8;
    const end = start + length;
    if (end > bytes.byteLength) throw new Error('glb chunk runs past the end of the file');
    if (kind === JSON_CHUNK && json === null) {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, end))) as Record<string, unknown>;
    } else if (kind === BIN_CHUNK && bin.byteLength === 0) {
      bin = bytes.subarray(start, end);
    }
    at = end;
  }
  if (json === null) throw new Error('glb has no JSON chunk');

  const used = asArray(json['extensionsRequired']).filter(
    (name): name is string => typeof name === 'string' && OPAQUE_EXTENSIONS.includes(name),
  );
  if (used.length > 0) {
    // Refused by name rather than read anyway: the accessors of a compressed
    // primitive are not the geometry, and measuring them would produce numbers
    // that look like findings.
    throw new Error(`glb needs ${used.join(', ')}, which this reader does not decode`);
  }
  return { json, bin };
}

/**
 * One accessor's data, de-interleaved and, for float targets, de-normalized.
 *
 * Integer component types come back as `Uint32Array` when the accessor is not
 * normalized -- joint indices are indices and rounding them through a float is
 * how a rig quietly re-binds itself at 2^24 bones. Everything else is float.
 */
export function readAccessor(glb: GlbBinary, index: number): Float32Array | Uint32Array {
  const accessor = asRecord(asArray(glb.json['accessors'])[index]);
  if (Object.keys(accessor).length === 0) throw new Error(`no accessor ${index}`);
  if (accessor['sparse'] !== undefined) throw new Error(`accessor ${index} is sparse, which this reader does not read`);

  const type = String(accessor['type'] ?? '');
  const stride = COMPONENTS[type];
  if (stride === undefined) throw new Error(`accessor ${index} has unknown type ${type}`);
  const componentType = Number(accessor['componentType']);
  const componentBytes = COMPONENT_BYTES[componentType];
  if (componentBytes === undefined) throw new Error(`accessor ${index} has unknown componentType ${componentType}`);
  const count = Number(accessor['count'] ?? 0);
  const normalized = accessor['normalized'] === true;

  const viewIndex = accessor['bufferView'];
  const total = count * stride;
  // An accessor with no bufferView is defined to be all zeroes. Rare, legal, and
  // exactly what a check for "a vertex bound to nothing" needs to see honestly.
  if (typeof viewIndex !== 'number') {
    return componentType === FLOAT || normalized ? new Float32Array(total) : new Uint32Array(total);
  }

  const bufferView = asRecord(asArray(glb.json['bufferViews'])[viewIndex]);
  const viewOffset = Number(bufferView['byteOffset'] ?? 0);
  const accessorOffset = Number(accessor['byteOffset'] ?? 0);
  // Interleaved attributes share a bufferView and are told apart by byteStride.
  // Zero or absent means tightly packed, which is what this project writes.
  const declaredStride = Number(bufferView['byteStride'] ?? 0);
  const elementBytes = componentBytes * stride;
  const step = declaredStride > 0 ? declaredStride : elementBytes;
  const base = glb.bin.byteOffset + viewOffset + accessorOffset;
  const end = viewOffset + accessorOffset + (count === 0 ? 0 : (count - 1) * step + elementBytes);
  if (end > glb.bin.byteLength) {
    throw new Error(`accessor ${index} reads past the end of the binary chunk`);
  }
  const view = new DataView(glb.bin.buffer, base, glb.bin.byteLength - viewOffset - accessorOffset);

  const asFloat = componentType === FLOAT || normalized;
  const out = asFloat ? new Float32Array(total) : new Uint32Array(total);
  for (let element = 0; element < count; element += 1) {
    for (let component = 0; component < stride; component += 1) {
      const at = element * step + component * componentBytes;
      out[element * stride + component] = readComponent(view, at, componentType, normalized);
    }
  }
  return out;
}

/**
 * One component, with the normalized-integer rules glTF specifies.
 *
 * The divisors are the type's maximum, and the signed ones clamp at -1 rather
 * than dividing by 2^n: -128/127 is the spec's rule and it is what makes a
 * normalized byte weight of 127 come back as exactly 1.0 rather than 0.992.
 */
function readComponent(view: DataView, at: number, componentType: number, normalized: boolean): number {
  switch (componentType) {
    case FLOAT:
      return view.getFloat32(at, true);
    case UNSIGNED_BYTE: {
      const raw = view.getUint8(at);
      return normalized ? raw / 255 : raw;
    }
    case UNSIGNED_SHORT: {
      const raw = view.getUint16(at, true);
      return normalized ? raw / 65535 : raw;
    }
    case UNSIGNED_INT:
      return view.getUint32(at, true);
    case BYTE: {
      const raw = view.getInt8(at);
      return normalized ? Math.max(raw / 127, -1) : raw;
    }
    case SHORT: {
      const raw = view.getInt16(at, true);
      return normalized ? Math.max(raw / 32767, -1) : raw;
    }
    default:
      throw new Error(`unknown componentType ${componentType}`);
  }
}

/**
 * Every node, with the world matrix its place in the tree implies.
 *
 * Parents are resolved from `children`, which is the only direction glTF stores
 * it. World matrices are composed by walking down from the roots rather than by
 * assuming parents come first in the array -- that is a contract `glb.ts` keeps
 * for its own files and nothing a generated one has to.
 */
export function readNodeTree(glb: GlbBinary): readonly GlbReadNode[] {
  const raw = asArray(glb.json['nodes']).map(asRecord);
  const parents = new Array<number | null>(raw.length).fill(null);
  raw.forEach((node, index) => {
    for (const child of asArray(node['children'])) {
      if (typeof child === 'number' && child >= 0 && child < raw.length) parents[child] = index;
    }
  });

  const local = raw.map((node) => localMatrix(node));
  const world = new Array<readonly number[] | null>(raw.length).fill(null);

  const resolve = (index: number, guard: number): readonly number[] => {
    const already = world[index];
    if (already) return already;
    // A cycle cannot happen in a valid glTF, but a malformed file is exactly
    // what this reader exists to look at, and a stack overflow is a worse
    // diagnosis than a matrix.
    if (guard <= 0) throw new Error('node hierarchy has a cycle');
    const parent = parents[index] ?? null;
    const own = local[index] ?? identity();
    const composed = parent === null ? own : multiply(resolve(parent, guard - 1), own);
    world[index] = composed;
    return composed;
  };

  return raw.map((node, index): GlbReadNode => {
    const trs = decompose(node);
    return {
      index,
      name: typeof node['name'] === 'string' ? node['name'] : '',
      parent: parents[index] ?? null,
      translation: trs.translation,
      rotation: trs.rotation,
      scale: trs.scale,
      world: resolve(index, raw.length + 1),
    };
  });
}

function decompose(node: Record<string, unknown>): {
  translation: readonly [number, number, number];
  rotation: readonly [number, number, number, number];
  scale: readonly [number, number, number];
} {
  const triple = (key: string, fallback: readonly [number, number, number]): [number, number, number] => {
    const value = node[key];
    if (!Array.isArray(value) || value.length < 3) return [...fallback];
    return [Number(value[0]), Number(value[1]), Number(value[2])];
  };
  const quat = (): [number, number, number, number] => {
    const value = node['rotation'];
    if (!Array.isArray(value) || value.length < 4) return [0, 0, 0, 1];
    return [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])];
  };
  return { translation: triple('translation', [0, 0, 0]), rotation: quat(), scale: triple('scale', [1, 1, 1]) };
}

/** A node's local matrix: its own `matrix` when it has one, else its TRS. */
function localMatrix(node: Record<string, unknown>): readonly number[] {
  const matrix = node['matrix'];
  if (Array.isArray(matrix) && matrix.length === 16) return matrix.map(Number);
  const { translation, rotation, scale } = decompose(node);
  return compose(translation, rotation, scale);
}

export function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Column-major, matching glTF and three. Duplicated from `glb.ts`'s writer half. */
export function compose(
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

export function multiply(a: readonly number[], b: readonly number[]): number[] {
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

/** A point through a column-major matrix. */
export function transformPoint(m: readonly number[], x: number, y: number, z: number): [number, number, number] {
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
  ];
}

/** A node's world-space origin, which is where a bone *is*. */
export function nodePosition(node: GlbReadNode): [number, number, number] {
  return [node.world[12] ?? 0, node.world[13] ?? 0, node.world[14] ?? 0];
}

/**
 * The first skinned primitive in the file, or null when there is none.
 *
 * First rather than all: a generated unit is one body, and a file with several
 * skinned primitives is a case nothing here has seen. Reporting on one of
 * several would be worse than the loud absence of support, so
 * {@link skinnedPrimitiveCount} exists for a caller that wants to say so.
 */
export function readSkinnedMesh(glb: GlbBinary): SkinnedMeshData | null {
  for (const mesh of asArray(glb.json['meshes']).map(asRecord)) {
    for (const primitive of asArray(mesh['primitives']).map(asRecord)) {
      const attributes = asRecord(primitive['attributes']);
      const position = attributes['POSITION'];
      const joints = attributes['JOINTS_0'];
      const weights = attributes['WEIGHTS_0'];
      if (typeof position !== 'number' || typeof joints !== 'number' || typeof weights !== 'number') continue;

      const positions = new Float32Array(readAccessor(glb, position));
      const vertexCount = Math.floor(positions.length / 3);
      const normalIndex = attributes['NORMAL'];
      const indexAccessor = primitive['indices'];

      return {
        positions,
        normals: typeof normalIndex === 'number' ? new Float32Array(readAccessor(glb, normalIndex)) : null,
        joints: new Uint32Array(readAccessor(glb, joints)),
        weights: new Float32Array(readAccessor(glb, weights)),
        // An unindexed primitive is three consecutive vertices per triangle;
        // synthesised here so every check downstream has one shape to read.
        indices:
          typeof indexAccessor === 'number'
            ? new Uint32Array(readAccessor(glb, indexAccessor))
            : Uint32Array.from({ length: vertexCount }, (_, i) => i),
        jointNodes: skinJoints(glb),
        hasSecondInfluenceSet: attributes['JOINTS_1'] !== undefined || attributes['WEIGHTS_1'] !== undefined,
        vertexCount,
      };
    }
  }
  return null;
}

/**
 * The mesh's own height, which is what the import scale is measured against.
 *
 * The *mesh*, deliberately, not the topmost joint: a rig's head bone sits inside
 * the skull, so scaling by the skeleton's extent leaves every unit a few percent
 * short. This is the same quantity `UnitRig.fitToHeight` gets from a `Box3` in
 * the browser, which is what makes the number the export writes agree with the
 * one the preview shows.
 *
 * Zero when there is no mesh, so a caller can tell "flat" from "unknown".
 */
export function meshHeight(glb: GlbBinary): number {
  const mesh = readSkinnedMesh(glb);
  if (mesh === null) return 0;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
    const y = mesh.positions[vertex * 3 + 1] ?? 0;
    low = Math.min(low, y);
    high = Math.max(high, y);
  }
  return Number.isFinite(low) && Number.isFinite(high) ? high - low : 0;
}

/** How many skinned primitives the file has, so a caller can refuse the plural. */
export function skinnedPrimitiveCount(glb: GlbBinary): number {
  let found = 0;
  for (const mesh of asArray(glb.json['meshes']).map(asRecord)) {
    for (const primitive of asArray(mesh['primitives']).map(asRecord)) {
      const attributes = asRecord(primitive['attributes']);
      if (typeof attributes['JOINTS_0'] === 'number' && typeof attributes['WEIGHTS_0'] === 'number') found += 1;
    }
  }
  return found;
}

function skinJoints(glb: GlbBinary): readonly number[] {
  const skin = asRecord(asArray(glb.json['skins'])[0]);
  return asArray(skin['joints']).filter((entry): entry is number => typeof entry === 'number');
}

/**
 * The skin's inverse bind matrices, or identity per joint when absent.
 *
 * Absent is legal and means "the joints are already in bind space". Filling in
 * identity rather than refusing keeps the skinning path in `skin.ts` free of a
 * branch that would only ever be exercised by a file nobody has.
 */
export function readInverseBindMatrices(glb: GlbBinary): readonly (readonly number[])[] {
  const skin = asRecord(asArray(glb.json['skins'])[0]);
  const joints = skinJoints(glb);
  const accessor = skin['inverseBindMatrices'];
  if (typeof accessor !== 'number') return joints.map(() => identity());
  const data = readAccessor(glb, accessor);
  return joints.map((_, index) => Array.from(data.subarray(index * 16, index * 16 + 16)));
}
