/**
 * Measuring which way a unit actually points.
 *
 * A generated unit arrives with three different opinions about where its front
 * is, and nothing in this repository used to read any of them:
 *
 *  - **the mesh's** front, which is whatever the generator decided when it
 *    turned a photograph into geometry;
 *  - **the rig's** front, which is where the auto-rig thought the mesh's front
 *    was when it fitted a skeleton to it;
 *  - **the clip's** front, which is the direction the retargeted animation
 *    strides in.
 *
 * When all three agree, a walk looks like a walk. When the rig disagrees with
 * the mesh by 180°, you get the thing this module was written for: a body that
 * faces the camera and walks backwards, with no error anywhere and every file
 * loading cleanly. `forwardAxis` in a skeleton document is an *assertion* about
 * these, not a measurement of them, and until now nothing checked it -- so the
 * only way to tell the three cases apart was to generate another unit and look
 * at it, at 25 credits a go.
 *
 * So: numbers, off the committed bytes, with no browser and no GL context.
 * Everything here is pure and works on any `.glb` -- ours or a generator's.
 *
 * ## What can be measured, and what each measurement can be wrong about
 *
 * Nothing here recognises a face. Each estimator is a heuristic with a named
 * failure mode, which is why the report carries all of them rather than one
 * verdict:
 *
 *  - **rig forward** is the ankle-to-toe vector, averaged over both feet. Solid
 *    for anything with feet on the mixamo contract; silent when a rig has no
 *    toe bones.
 *  - **mesh forward** is geometry only, from two independent slices: the feet
 *    (toes reach further forward than heels reach back) and the head (a face or
 *    a snout protrudes). They are reported separately *because* they disagree
 *    on a subject where one of them is wrong -- a long tail, a hood, a beak.
 *  - **clip forward** is where the body would travel. Root translation when the
 *    clip has it; otherwise the stance foot, which slides backwards under a
 *    body that is moving forwards. That is the one measurement that reads a
 *    gait rather than a pose, and it is what tells a backwards walk from a
 *    model facing the other way.
 *
 * Read them together. Two that agree and one that does not is a diagnosis; all
 * three disagreeing means the subject is not a biped and the estimators have
 * nothing to stand on.
 */

import { readGlbChunks } from './glb.js';

export type Vec3 = readonly [number, number, number];

/** Up is +Y throughout, matching every skeleton document in the project. */
const UP: Vec3 = [0, 1, 0];

// --- the glTF subset this needs ---------------------------------------------

interface GltfNode {
  readonly name?: string;
  readonly children?: readonly number[];
  readonly translation?: readonly number[];
  readonly rotation?: readonly number[];
  readonly scale?: readonly number[];
  readonly matrix?: readonly number[];
  readonly mesh?: number;
  readonly skin?: number;
}

interface GltfAccessor {
  readonly bufferView?: number;
  readonly byteOffset?: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: string;
}

interface GltfBufferView {
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride?: number;
}

interface GltfChannel {
  readonly sampler: number;
  readonly target?: { readonly node?: number; readonly path?: string };
}

interface GltfSampler {
  readonly input: number;
  readonly output: number;
  readonly interpolation?: string;
}

interface GltfAnimation {
  readonly name?: string;
  readonly channels?: readonly GltfChannel[];
  readonly samplers?: readonly GltfSampler[];
}

interface GltfPrimitive {
  readonly attributes?: Record<string, number>;
}

interface GltfMesh {
  readonly primitives?: readonly GltfPrimitive[];
}

interface Gltf {
  readonly nodes?: readonly GltfNode[];
  readonly meshes?: readonly GltfMesh[];
  readonly accessors?: readonly GltfAccessor[];
  readonly bufferViews?: readonly GltfBufferView[];
  readonly animations?: readonly GltfAnimation[];
}

/** A `.glb` opened far enough to measure: the document and its buffer. */
export interface Model {
  readonly gltf: Gltf;
  readonly bin: Uint8Array;
}

export function openGlb(bytes: Uint8Array): Model {
  const chunks = readGlbChunks(bytes);
  return { gltf: chunks.json as Gltf, bin: chunks.bin };
}

const COMPONENT_BYTES: Readonly<Record<number, number>> = {
  5120: 1, // byte
  5121: 1, // unsigned byte
  5122: 2, // short
  5123: 2, // unsigned short
  5125: 4, // unsigned int
  5126: 4, // float
};

const TYPE_COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

/**
 * An accessor's numbers, one flat array.
 *
 * `byteStride` is honoured because a real exporter interleaves: position and
 * normal in one view, read with a stride. Ignoring it reads normals as
 * positions and produces a body-shaped answer that is entirely wrong.
 */
export function readAccessor(model: Model, index: number): Float64Array {
  const accessor = model.gltf.accessors?.[index];
  if (!accessor) throw new Error(`no accessor ${index}`);
  const components = TYPE_COMPONENTS[accessor.type];
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  if (components === undefined || componentBytes === undefined) {
    throw new Error(`accessor ${index}: unsupported ${accessor.type}/${accessor.componentType}`);
  }

  const out = new Float64Array(accessor.count * components);
  if (accessor.bufferView === undefined) return out; // legal, and means zeroes

  const view = model.gltf.bufferViews?.[accessor.bufferView];
  if (!view) throw new Error(`accessor ${index}: no bufferView ${accessor.bufferView}`);
  const stride = view.byteStride === undefined || view.byteStride === 0 ? components * componentBytes : view.byteStride;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const data = new DataView(model.bin.buffer, model.bin.byteOffset, model.bin.byteLength);

  for (let i = 0; i < accessor.count; i += 1) {
    for (let c = 0; c < components; c += 1) {
      const at = base + i * stride + c * componentBytes;
      if (at + componentBytes > model.bin.byteLength) throw new Error(`accessor ${index}: runs past the buffer`);
      out[i * components + c] = readComponent(data, at, accessor.componentType);
    }
  }
  return out;
}

function readComponent(data: DataView, at: number, componentType: number): number {
  switch (componentType) {
    case 5120:
      return data.getInt8(at);
    case 5121:
      return data.getUint8(at);
    case 5122:
      return data.getInt16(at, true);
    case 5123:
      return data.getUint16(at, true);
    case 5125:
      return data.getUint32(at, true);
    default:
      return data.getFloat32(at, true);
  }
}

// --- transforms --------------------------------------------------------------

/** Column-major, like glTF's own and three's. */
export type Mat4 = Float64Array;

function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function fromTrs(translation: Vec3, rotation: readonly number[], scale: Vec3): Mat4 {
  const [x, y, z, w] = [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1];
  const [sx, sy, sz] = scale;
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * sx;
  m[1] = 2 * (x * y + z * w) * sx;
  m[2] = 2 * (x * z - y * w) * sx;
  m[4] = 2 * (x * y - z * w) * sy;
  m[5] = (1 - 2 * (x * x + z * z)) * sy;
  m[6] = 2 * (y * z + x * w) * sy;
  m[8] = 2 * (x * z + y * w) * sz;
  m[9] = 2 * (y * z - x * w) * sz;
  m[10] = (1 - 2 * (x * x + y * y)) * sz;
  m[12] = translation[0];
  m[13] = translation[1];
  m[14] = translation[2];
  m[15] = 1;
  return m;
}

function originOf(m: Mat4): Vec3 {
  return [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0];
}

function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    (m[0] ?? 0) * p[0] + (m[4] ?? 0) * p[1] + (m[8] ?? 0) * p[2] + (m[12] ?? 0),
    (m[1] ?? 0) * p[0] + (m[5] ?? 0) * p[1] + (m[9] ?? 0) * p[2] + (m[13] ?? 0),
    (m[2] ?? 0) * p[0] + (m[6] ?? 0) * p[1] + (m[10] ?? 0) * p[2] + (m[14] ?? 0),
  ];
}

// --- vectors -----------------------------------------------------------------

/** Flattened onto the ground plane. Every question here is a compass question. */
export function horizontal(v: Vec3): Vec3 {
  return [v[0], 0, v[2]];
}

export function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function normalize(v: Vec3): Vec3 | null {
  const len = length(v);
  if (!(len > 1e-9)) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(v: Vec3, k: number): Vec3 {
  return [v[0] * k, v[1] * k, v[2] * k];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Degrees between two directions, 0..180. Null when either has no direction. */
export function angleBetween(a: Vec3 | null, b: Vec3 | null): number | null {
  const na = a === null ? null : normalize(a);
  const nb = b === null ? null : normalize(b);
  if (na === null || nb === null) return null;
  return (Math.acos(Math.max(-1, Math.min(1, dot(na, nb)))) * 180) / Math.PI;
}

// --- the skeleton ------------------------------------------------------------

/**
 * A bone name reduced to what two files can be expected to agree on.
 *
 * `mixamorig:LeftFoot`, `mixamorigLeftFoot` and `mixamorig1:LeftFoot` are the
 * same bone said three ways -- three.js sanitises the colon out of its track
 * names, and exporters number the prefix when a scene has carried two rigs.
 * Comparing raw names across two files is how a check silently matches nothing
 * and reports a clean result, which has already happened once here.
 */
export function boneKey(name: string): string {
  return name.replace(/^mixamorig\d*[:_]?/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export interface Skeleton {
  /** World matrices at rest, by {@link boneKey}. */
  readonly world: ReadonlyMap<string, Mat4>;
  /** Node index by bone key, for reading animation channels back. */
  readonly index: ReadonlyMap<string, number>;
  /** Every node's parent, or -1. */
  readonly parents: readonly number[];
  readonly names: readonly string[];
}

function localMatrix(node: GltfNode): Mat4 {
  if (node.matrix && node.matrix.length === 16) {
    const m = new Float64Array(16);
    for (let i = 0; i < 16; i += 1) m[i] = node.matrix[i] ?? 0;
    return m;
  }
  return fromTrs(
    [node.translation?.[0] ?? 0, node.translation?.[1] ?? 0, node.translation?.[2] ?? 0],
    node.rotation ?? [0, 0, 0, 1],
    [node.scale?.[0] ?? 1, node.scale?.[1] ?? 1, node.scale?.[2] ?? 1],
  );
}

function parentTable(nodes: readonly GltfNode[]): number[] {
  const parents = nodes.map(() => -1);
  nodes.forEach((node, index) => {
    for (const child of node.children ?? []) parents[child] = index;
  });
  return parents;
}

/** World matrices for every node, with each node's local override applied. */
function worldMatrices(nodes: readonly GltfNode[], parents: readonly number[], locals: readonly Mat4[]): Mat4[] {
  const world: Mat4[] = nodes.map(() => identity());
  const resolve = (index: number): Mat4 => {
    const parent = parents[index] ?? -1;
    const local = locals[index] ?? identity();
    return parent < 0 ? local : multiply(resolve(parent), local);
  };
  nodes.forEach((_, index) => {
    world[index] = resolve(index);
  });
  return world;
}

/** The rest skeleton: every node's world transform with no animation applied. */
export function restSkeleton(model: Model): Skeleton {
  const nodes = model.gltf.nodes ?? [];
  const parents = parentTable(nodes);
  const world = worldMatrices(nodes, parents, nodes.map(localMatrix));

  const byKey = new Map<string, Mat4>();
  const index = new Map<string, number>();
  nodes.forEach((node, at) => {
    const name = node.name;
    if (name === undefined) return;
    const key = boneKey(name);
    // First wins: a scene with a duplicated rig would otherwise report the
    // second one's pose against the first one's name.
    if (byKey.has(key)) return;
    byKey.set(key, world[at] ?? identity());
    index.set(key, at);
  });
  return { world: byKey, index, parents, names: nodes.map((node) => node.name ?? '') };
}

function boneOrigin(skeleton: Skeleton, key: string): Vec3 | null {
  const m = skeleton.world.get(key);
  return m === undefined ? null : originOf(m);
}

// --- what the rig thinks --------------------------------------------------

export interface RigFacing {
  /** Ankle to toe, averaged over both feet. Null when the rig has no toes. */
  readonly forward: Vec3 | null;
  /** Right hip to left hip: where the bones *named* left actually are. */
  readonly left: Vec3 | null;
  /**
   * Whether `left` sits where a right-handed basis says it should.
   *
   * `up × forward` is the left side. When the bones named `Left*` are on the
   * other one, either the rig was fitted mirrored or the whole thing is 180°
   * around -- and those two look identical in a single frame of a walk.
   */
  readonly handednessOk: boolean | null;
}

/** Which way the skeleton points, from the bones themselves. */
export function rigFacing(skeleton: Skeleton): RigFacing {
  const toeVectors: Vec3[] = [];
  for (const side of ['left', 'right']) {
    const ankle = boneOrigin(skeleton, `${side}foot`);
    // `Toe_End` is the tip and the better lever arm; `ToeBase` is the fallback
    // for a rig that stops at the ball of the foot.
    const toe = boneOrigin(skeleton, `${side}toeend`) ?? boneOrigin(skeleton, `${side}toebase`);
    if (ankle === null || toe === null) continue;
    const v = normalize(horizontal(subtract(toe, ankle)));
    if (v !== null) toeVectors.push(v);
  }
  const forward =
    toeVectors.length === 0
      ? null
      : normalize(toeVectors.reduce((acc, v) => add(acc, v), [0, 0, 0] as Vec3));

  const leftHip = boneOrigin(skeleton, 'leftupleg');
  const rightHip = boneOrigin(skeleton, 'rightupleg');
  const left =
    leftHip === null || rightHip === null ? null : normalize(horizontal(subtract(leftHip, rightHip)));

  const handednessOk = forward === null || left === null ? null : dot(cross(UP, forward), left) > 0;
  return { forward, left, handednessOk };
}

// --- what the mesh thinks ----------------------------------------------------

export interface MeshFacing {
  /** Toes reach further forward than heels reach back. */
  readonly fromFeet: Vec3 | null;
  /** A face, a snout or a beak protrudes; the back of a skull does not. */
  readonly fromHead: Vec3 | null;
  /**
   * How far each slice actually leans, as a fraction of the body's height.
   *
   * The reason the two directions above can be null. A slice with no asymmetry
   * -- a featureless box of a head, which is what the reference mannequin has
   * -- still produces a unit vector once it is normalized, pointing wherever
   * the rounding went. That vector looks exactly like a measurement and is
   * worth nothing, and it is how a probe reports a 180° fault in a model that
   * is fine.
   */
  readonly lean: { readonly feet: number; readonly head: number };
  readonly vertexCount: number;
}

/**
 * How far a slice must lean before it is treated as pointing anywhere.
 *
 * A fraction of body height. One percent is under two centimetres on a human:
 * below the reference mannequin's blocky feet, which are the smallest real
 * signal there is, and well above the ~0% a symmetric shape drifts by.
 */
const LEAN_FLOOR = 0.01;

interface Slice {
  readonly centroid: Vec3;
  readonly count: number;
}

function sliceCentroid(points: readonly Vec3[], from: number, to: number): Slice | null {
  if (points.length === 0) return null;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const height = maxY - minY;
  if (!(height > 0)) return null;
  const lo = minY + height * from;
  const hi = minY + height * to;

  let sum: Vec3 = [0, 0, 0];
  let count = 0;
  for (const p of points) {
    if (p[1] < lo || p[1] > hi) continue;
    sum = add(sum, p);
    count += 1;
  }
  if (count === 0) return null;
  return { centroid: scale(sum, 1 / count), count };
}

/**
 * Every vertex of every mesh, in the space the skin binds in.
 *
 * A skinned primitive's positions are already in the skeleton's bind space, so
 * the mesh node's own transform is not applied to them -- glTF says the node
 * transform of a skinned mesh is ignored, and applying it would move the body
 * away from the rig that is supposed to be inside it.
 */
export function meshPoints(model: Model): Vec3[] {
  const nodes = model.gltf.nodes ?? [];
  const parents = parentTable(nodes);
  const world = worldMatrices(nodes, parents, nodes.map(localMatrix));
  const points: Vec3[] = [];

  nodes.forEach((node, at) => {
    if (node.mesh === undefined) return;
    const mesh = model.gltf.meshes?.[node.mesh];
    for (const primitive of mesh?.primitives ?? []) {
      const position = primitive.attributes?.['POSITION'];
      if (position === undefined) continue;
      const skinned = node.skin !== undefined && primitive.attributes?.['JOINTS_0'] !== undefined;
      const matrix = skinned ? identity() : (world[at] ?? identity());
      const data = readAccessor(model, position);
      for (let i = 0; i + 2 < data.length; i += 3) {
        points.push(transformPoint(matrix, [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0]));
      }
    }
  });
  return points;
}

/**
 * Which way the geometry points, with no reference to the rig inside it.
 *
 * This is the measurement the rig cannot fake. Both slices are taken against
 * the body's own horizontal centre, so a model standing off the origin is
 * measured the same as one standing on it.
 */
export function meshFacing(points: readonly Vec3[]): MeshFacing {
  const none = { fromFeet: null, fromHead: null, lean: { feet: 0, head: 0 }, vertexCount: points.length };
  if (points.length === 0) return none;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const height = maxY - minY;
  if (!(height > 0)) return none;

  // The bottom twelfth is feet, the top eighth is head, and both are measured
  // against the *torso* rather than against the whole body's mean. Against the
  // mean, feet that reach forward drag the mean forward with them and the head
  // then reads as leaning back by however much the feet lean forward -- an
  // artefact that is largest on exactly the symmetric models where there is
  // nothing else to report.
  const feet = sliceCentroid(points, 0, 0.08);
  const head = sliceCentroid(points, 0.88, 1);
  const torso = sliceCentroid(points, 0.4, 0.65);
  if (torso === null) return none;

  const offset = (slice: Slice | null): { readonly direction: Vec3 | null; readonly lean: number } => {
    if (slice === null) return { direction: null, lean: 0 };
    const delta = horizontal(subtract(slice.centroid, torso.centroid));
    const lean = length(delta) / height;
    return { direction: lean < LEAN_FLOOR ? null : normalize(delta), lean };
  };

  const fromFeet = offset(feet);
  const fromHead = offset(head);
  return {
    fromFeet: fromFeet.direction,
    fromHead: fromHead.direction,
    lean: { feet: fromFeet.lean, head: fromHead.lean },
    vertexCount: points.length,
  };
}

// --- what the clip thinks ----------------------------------------------------

export interface ClipFacing {
  readonly animation: string;
  /** Net horizontal travel of the root, when the clip carries root motion. */
  readonly rootTravel: Vec3 | null;
  /**
   * Where the gait says the body is going.
   *
   * From the stance foot: while a foot is on the ground it slides backwards
   * relative to the hips at exactly the speed the body moves forwards. It is
   * the one estimator that survives root motion having been stripped, which is
   * the state every clip in this project is in by the time it is drawn.
   */
  readonly strideForward: Vec3 | null;
  /** How far the feet actually travel, in model units. A still clip says ~0. */
  readonly strideLength: number;
  readonly frames: number;
}

interface Sampled {
  readonly times: Float64Array;
  readonly values: Float64Array;
  readonly components: number;
  readonly step: boolean;
  readonly cubic: boolean;
}

function samplerOf(model: Model, animation: GltfAnimation, channel: GltfChannel, components: number): Sampled | null {
  const sampler = animation.samplers?.[channel.sampler];
  if (!sampler) return null;
  return {
    times: readAccessor(model, sampler.input),
    values: readAccessor(model, sampler.output),
    components,
    step: sampler.interpolation === 'STEP',
    cubic: sampler.interpolation === 'CUBICSPLINE',
  };
}

/**
 * A sampler's value at a time.
 *
 * Cubic splines are read at their keyframe value and interpolated linearly
 * between: this measures a direction over a whole cycle, and the tangents move
 * that answer by far less than the estimator's own error bars.
 */
function sampleAt(sampled: Sampled, t: number): number[] {
  const { times, values, components, cubic } = sampled;
  const stride = cubic ? components * 3 : components;
  const at = (frame: number): number[] => {
    const base = frame * stride + (cubic ? components : 0);
    const out: number[] = [];
    for (let c = 0; c < components; c += 1) out.push(values[base + c] ?? 0);
    return out;
  };
  if (times.length === 0) return new Array<number>(components).fill(0);
  if (t <= (times[0] ?? 0)) return at(0);
  if (t >= (times[times.length - 1] ?? 0)) return at(times.length - 1);

  let i = 0;
  while (i + 1 < times.length && (times[i + 1] ?? 0) < t) i += 1;
  const t0 = times[i] ?? 0;
  const t1 = times[i + 1] ?? t0;
  const span = t1 - t0;
  const alpha = sampled.step || !(span > 0) ? 0 : (t - t0) / span;
  const a = at(i);
  const b = at(i + 1);

  if (components === 4) {
    // Quaternions: nlerp, and the shorter arc. Lerping through the long way
    // round would put a spurious half-turn in the middle of every step.
    const sign = a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0) < 0 ? -1 : 1;
    const out = a.map((value, index) => value + ((b[index] ?? 0) * sign - value) * alpha);
    const len = Math.hypot(...out);
    return len > 0 ? out.map((value) => value / len) : [0, 0, 0, 1];
  }
  return a.map((value, index) => value + ((b[index] ?? 0) - value) * alpha);
}

/** Straight-line fit of a series against time, returning the slope. */
function slope(times: readonly number[], values: readonly number[]): number {
  const n = times.length;
  if (n < 2) return 0;
  const meanT = times.reduce((sum, t) => sum + t, 0) / n;
  const meanV = values.reduce((sum, v) => sum + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dt = (times[i] ?? 0) - meanT;
    num += dt * ((values[i] ?? 0) - meanV);
    den += dt * dt;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Reads one animation's direction of travel.
 *
 * `restModel` is the file whose skeleton the clip will actually be played on.
 * It defaults to the clip's own, and passing a different one is the check for
 * the case where a clip is bound by bone name onto a rig it was not exported
 * with -- which is exactly what the renderer does.
 */
export function clipFacing(model: Model, animationIndex = 0, frames = 48): ClipFacing | null {
  const animation = model.gltf.animations?.[animationIndex];
  if (!animation) return null;
  const nodes = model.gltf.nodes ?? [];
  const parents = parentTable(nodes);
  const rest = nodes.map(localMatrix);

  const translations = new Map<number, Sampled>();
  const rotations = new Map<number, Sampled>();
  const scales = new Map<number, Sampled>();
  let start = Infinity;
  let end = -Infinity;

  for (const channel of animation.channels ?? []) {
    const node = channel.target?.node;
    const path = channel.target?.path;
    if (node === undefined || path === undefined) continue;
    const components = path === 'rotation' ? 4 : 3;
    if (path === 'weights') continue;
    const sampled = samplerOf(model, animation, channel, components);
    if (sampled === null) continue;
    start = Math.min(start, sampled.times[0] ?? 0);
    end = Math.max(end, sampled.times[sampled.times.length - 1] ?? 0);
    if (path === 'translation') translations.set(node, sampled);
    else if (path === 'rotation') rotations.set(node, sampled);
    else if (path === 'scale') scales.set(node, sampled);
  }
  if (!(end > start)) return null;

  const skeleton = restSkeleton(model);
  const footKeys = ['leftfoot', 'rightfoot'] as const;
  const hips = skeleton.index.get('hips');

  const times: number[] = [];
  const hipsPath: Vec3[] = [];
  const feetPaths = new Map<string, Vec3[]>(footKeys.map((key) => [key, []]));
  const rootNode = hips ?? 0;

  for (let frame = 0; frame < frames; frame += 1) {
    const t = start + ((end - start) * frame) / (frames - 1);
    const locals = nodes.map((node, index) => {
      const base = rest[index] ?? identity();
      const translation = translations.get(index);
      const rotation = rotations.get(index);
      const scaling = scales.get(index);
      if (!translation && !rotation && !scaling) return base;
      const trs = {
        translation: translation
          ? (sampleAt(translation, t) as number[])
          : [node.translation?.[0] ?? 0, node.translation?.[1] ?? 0, node.translation?.[2] ?? 0],
        rotation: rotation ? sampleAt(rotation, t) : (node.rotation ?? [0, 0, 0, 1]),
        scale: scaling ? sampleAt(scaling, t) : [node.scale?.[0] ?? 1, node.scale?.[1] ?? 1, node.scale?.[2] ?? 1],
      };
      return fromTrs(
        [trs.translation[0] ?? 0, trs.translation[1] ?? 0, trs.translation[2] ?? 0],
        trs.rotation,
        [trs.scale[0] ?? 1, trs.scale[1] ?? 1, trs.scale[2] ?? 1],
      );
    });
    const world = worldMatrices(nodes, parents, locals);
    times.push(t);
    hipsPath.push(originOf(world[rootNode] ?? identity()));
    for (const key of footKeys) {
      const index = skeleton.index.get(key);
      if (index === undefined) continue;
      feetPaths.get(key)?.push(originOf(world[index] ?? identity()));
    }
  }

  const rootSampled = translations.get(rootNode);
  const rootTravel =
    rootSampled === undefined
      ? null
      : normalize(horizontal(subtract(hipsPath[hipsPath.length - 1] ?? [0, 0, 0], hipsPath[0] ?? [0, 0, 0])));

  // The stance foot: the frames where a foot is in the lowest third of its own
  // vertical range are the frames it is carrying weight. Its horizontal drift
  // relative to the hips over those frames is the body's motion, reversed.
  let travel: Vec3 = [0, 0, 0];
  let strideLength = 0;
  for (const key of footKeys) {
    const path = feetPaths.get(key) ?? [];
    if (path.length < 4) continue;
    const ys = path.map((p) => p[1]);
    const low = Math.min(...ys);
    const high = Math.max(...ys);
    const threshold = low + (high - low) * 0.34;

    const stanceTimes: number[] = [];
    const relX: number[] = [];
    const relZ: number[] = [];
    path.forEach((p, index) => {
      if ((ys[index] ?? 0) > threshold) return;
      const hip = hipsPath[index] ?? [0, 0, 0];
      stanceTimes.push(times[index] ?? 0);
      relX.push(p[0] - hip[0]);
      relZ.push(p[2] - hip[2]);
    });
    if (stanceTimes.length < 3) continue;
    // Reversed: the planted foot goes backwards under a body going forwards.
    travel = add(travel, [-slope(stanceTimes, relX), 0, -slope(stanceTimes, relZ)]);

    const xs = path.map((p) => p[0]);
    const zs = path.map((p) => p[2]);
    strideLength = Math.max(strideLength, Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)));
  }

  return {
    animation: animation.name ?? '',
    rootTravel,
    strideForward: normalize(travel),
    strideLength,
    frames,
  };
}

// --- two files that have to agree --------------------------------------------

export interface RestDelta {
  readonly bone: string;
  /** Degrees between the two files' rest orientation for this bone. */
  readonly degrees: number;
}

/**
 * How far apart two files' rest skeletons are, bone by bone.
 *
 * The renderer binds a clip onto the *mesh's* skeleton by bone name, so the
 * clip's own rest pose is never loaded -- every rotation it carries is read as
 * if it had been authored against the mesh's rest. When the two rest poses
 * differ, that reading is wrong by exactly the difference, and a 180° yaw at
 * the hips is a body that plays every clip facing backwards while every file in
 * the chain loads without an error.
 */
export function restPoseDeltas(a: Model, b: Model): readonly RestDelta[] {
  const left = restSkeleton(a);
  const right = restSkeleton(b);
  const found: RestDelta[] = [];

  for (const [key, matrixA] of left.world) {
    const matrixB = right.world.get(key);
    if (matrixB === undefined) continue;
    // Compared as the rotation each rest matrix applies to the three axes,
    // which is scale-independent -- the two files may well be exported at
    // different sizes and that is not what this is asking about.
    let worst = 0;
    for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]) {
      const va = normalize(subtract(transformPoint(matrixA, axis), originOf(matrixA)));
      const vb = normalize(subtract(transformPoint(matrixB, axis), originOf(matrixB)));
      worst = Math.max(worst, angleBetween(va, vb) ?? 0);
    }
    found.push({ bone: key, degrees: worst });
  }
  return found.sort((x, y) => y.degrees - x.degrees);
}
