/**
 * Measuring which way a unit actually points (spec 116).
 *
 * A generated unit arrives with three different opinions about where its front
 * is, and until this module nothing in the repository read any of them:
 *
 *  - **the mesh's** front, which is whatever the generator decided when it
 *    turned a photograph into geometry;
 *  - **the rig's** front, which is where the auto-rig thought the mesh's front
 *    was when it fitted a skeleton to it;
 *  - **the clip's** front, which is the direction the retargeted animation
 *    strides in.
 *
 * When all three agree, a walk looks like a walk. When the rig disagrees with
 * the mesh by 180°, you get the thing this was written for: a body that faces
 * the camera and walks backwards, with no error anywhere and every file loading
 * cleanly. `forwardAxis` in a skeleton document is an *assertion* about these,
 * not a measurement of them -- so the only way to tell the cases apart was to
 * generate another unit and look at it, at real credits a go.
 *
 * Built on spec 115's `glb-read.ts`, which is the repository's one binary
 * reader: it refuses a Draco or meshopt file by name rather than reading it as
 * plausible nonsense, and that matters more here than anywhere, because
 * everything below turns bytes into a direction and a direction always looks
 * like an answer.
 *
 * ## What can be measured, and what each measurement is blind to
 *
 * Nothing here recognises a face. Each estimator is a heuristic with a named
 * failure mode, which is why {@link facingReport} carries all of them rather
 * than collapsing them into one verdict:
 *
 *  - **rig forward** is the ankle-to-toe vector, averaged over both feet. Solid
 *    for anything with feet on the mixamo contract; silent when a rig has no
 *    toe bones.
 *  - **mesh forward** is geometry only, from two independent slices: the feet
 *    (toes reach further forward than heels reach back) and the head (a face or
 *    a snout protrudes). Reported separately *because* they disagree on a
 *    subject where one of them is wrong -- a long tail, a hood, a beak.
 *  - **clip forward** is where the body would travel, from the stance foot,
 *    which slides backwards under a body moving forwards. Root motion would be
 *    the easier read and is deliberately not the primary one: it is stripped at
 *    import, so by the time anything is drawn it is gone, and an estimator that
 *    needed it would answer only for files nobody plays.
 *
 * Read them together. Two that agree and one that does not is a diagnosis; all
 * three disagreeing means the subject is not a biped and the estimators have
 * nothing to stand on.
 */

import {
  compose,
  identity,
  multiply,
  nodePosition,
  readAccessor,
  readNodeTree,
  readSkinnedMesh,
  splitGlb,
  type GlbBinary,
  type GlbReadNode,
  type SkinnedMeshData,
} from './glb-read.js';

export type Vec3 = readonly [number, number, number];

/** Up is +Y throughout, matching every skeleton document in the project. */
const UP: Vec3 = [0, 1, 0];

/** The front every rig in `src/render/iso3d/` is built facing. */
export const PROJECT_FORWARD: Vec3 = [1, 0, 0];

/** Past this, two directions are opposite rather than merely different. */
const BACKWARDS_DEGREES = 135;

/** Past this, they are not the same direction either. */
const SIDEWAYS_DEGREES = 45;

/** A rest-pose difference worth reporting, in degrees. */
const REST_DRIFT_DEGREES = 5;

/** Below this much foot travel, a clip is a pose and has no direction. */
const STILL_STRIDE = 0.02;

// --- vectors -----------------------------------------------------------------

/** Flattened onto the ground plane. Every question here is a compass question. */
export function horizontal(v: Vec3): Vec3 {
  return [v[0], 0, v[2]];
}

function length(v: Vec3): number {
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

function scaled(v: Vec3, k: number): Vec3 {
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

/** The nearest named axis, when the direction is within 30° of one. */
export function nearestAxis(v: Vec3 | null): string | null {
  if (v === null) return null;
  const axes: readonly (readonly [string, Vec3])[] = [
    ['+X', [1, 0, 0]],
    ['-X', [-1, 0, 0]],
    ['+Z', [0, 0, 1]],
    ['-Z', [0, 0, -1]],
  ];
  for (const [name, axis] of axes) {
    const angle = angleBetween(v, axis);
    if (angle !== null && angle <= 30) return name;
  }
  return null;
}

// --- the skeleton ------------------------------------------------------------

/**
 * A bone name reduced to what two files can be expected to agree on.
 *
 * `mixamorig:LeftFoot`, `mixamorigLeftFoot` and `mixamorig1:LeftFoot` are the
 * same bone said three ways -- three.js sanitises the colon out of its track
 * names, and exporters number the prefix when a scene has carried two rigs.
 * Comparing raw names across two files is how a check silently matches nothing
 * and reports a clean result, which has already happened once in this codebase.
 */
export function boneKey(name: string): string {
  return name.replace(/^mixamorig\d*[:_]?/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/** Bones by {@link boneKey}. First wins, so a duplicated rig cannot shadow one. */
export function boneMap(nodes: readonly GlbReadNode[]): ReadonlyMap<string, GlbReadNode> {
  const found = new Map<string, GlbReadNode>();
  for (const node of nodes) {
    if (node.name === '') continue;
    const key = boneKey(node.name);
    if (!found.has(key)) found.set(key, node);
  }
  return found;
}

// --- what the rig thinks -----------------------------------------------------

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
   * around -- and those two look identical in a single frame of a walk, which
   * is why this is reported next to the other measurements and not on its own.
   */
  readonly handednessOk: boolean | null;
}

/** Which way the skeleton points, from the bones themselves. */
export function rigFacing(nodes: readonly GlbReadNode[]): RigFacing {
  const bones = boneMap(nodes);
  const at = (key: string): Vec3 | null => {
    const node = bones.get(key);
    return node === undefined ? null : nodePosition(node);
  };

  const toeVectors: Vec3[] = [];
  for (const side of ['left', 'right']) {
    const ankle = at(`${side}foot`);
    // `Toe_End` is the tip and the better lever arm; `ToeBase` is the fallback
    // for a rig that stops at the ball of the foot.
    const toe = at(`${side}toeend`) ?? at(`${side}toebase`);
    if (ankle === null || toe === null) continue;
    const v = normalize(horizontal(subtract(toe, ankle)));
    if (v !== null) toeVectors.push(v);
  }
  const forward =
    toeVectors.length === 0 ? null : normalize(toeVectors.reduce((acc, v) => add(acc, v), [0, 0, 0] as Vec3));

  const leftHip = at('leftupleg');
  const rightHip = at('rightupleg');
  const left = leftHip === null || rightHip === null ? null : normalize(horizontal(subtract(leftHip, rightHip)));
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

function sliceCentroid(points: readonly Vec3[], minY: number, height: number, from: number, to: number): Slice | null {
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
  return { centroid: scaled(sum, 1 / count), count };
}

/**
 * Which way the geometry points, with no reference to the rig inside it.
 *
 * This is the measurement the rig cannot fake. A skinned primitive's positions
 * are already in the skeleton's bind space, so they are read as they are: glTF
 * ignores the node transform of a skinned mesh, and applying one would move the
 * body away from the rig that is supposed to be inside it.
 */
export function meshFacing(mesh: SkinnedMeshData | null): MeshFacing {
  const none = { fromFeet: null, fromHead: null, lean: { feet: 0, head: 0 }, vertexCount: 0 };
  if (mesh === null || mesh.vertexCount === 0) return none;

  const points: Vec3[] = [];
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    points.push([mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0]);
  }

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  const height = maxY - minY;
  if (!(height > 0)) return { ...none, vertexCount: points.length };

  // The bottom twelfth is feet, the top eighth is head, and both are measured
  // against the *torso* rather than against the whole body's mean. Against the
  // mean, feet that reach forward drag the mean forward with them and the head
  // then reads as leaning back by however much the feet lean forward -- an
  // artefact that is largest on exactly the symmetric models where there is
  // nothing else to report.
  const torso = sliceCentroid(points, minY, height, 0.4, 0.65);
  if (torso === null) return { ...none, vertexCount: points.length };

  const offset = (slice: Slice | null): { readonly direction: Vec3 | null; readonly lean: number } => {
    if (slice === null) return { direction: null, lean: 0 };
    const delta = horizontal(subtract(slice.centroid, torso.centroid));
    const lean = length(delta) / height;
    return { direction: lean < LEAN_FLOOR ? null : normalize(delta), lean };
  };

  const feet = offset(sliceCentroid(points, minY, height, 0, 0.08));
  const head = offset(sliceCentroid(points, minY, height, 0.88, 1));
  return {
    fromFeet: feet.direction,
    fromHead: head.direction,
    lean: { feet: feet.lean, head: head.lean },
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
   * relative to the hips at exactly the speed the body moves forwards.
   */
  readonly strideForward: Vec3 | null;
  /** How far the feet actually travel, in model units. A still clip says ~0. */
  readonly strideLength: number;
  readonly frames: number;
}

interface Sampled {
  readonly times: Float32Array | Uint32Array;
  readonly values: Float32Array | Uint32Array;
  readonly components: number;
  readonly step: boolean;
  readonly cubic: boolean;
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

/** World matrices with a per-node local override, walked down from the roots. */
function posedWorld(nodes: readonly GlbReadNode[], locals: readonly (readonly number[])[]): (readonly number[])[] {
  const world = new Array<readonly number[] | null>(nodes.length).fill(null);
  const resolve = (index: number, guard: number): readonly number[] => {
    const already = world[index];
    if (already) return already;
    if (guard <= 0) throw new Error('node hierarchy has a cycle');
    const node = nodes[index];
    const own = locals[index] ?? identity();
    const parent = node?.parent ?? null;
    const composed = parent === null ? own : multiply(resolve(parent, guard - 1), own);
    world[index] = composed;
    return composed;
  };
  return nodes.map((_, index) => resolve(index, nodes.length + 1));
}

/** Reads one animation's direction of travel. */
export function clipFacing(glb: GlbBinary, animationIndex = 0, frames = 48): ClipFacing | null {
  const animations = Array.isArray(glb.json['animations']) ? (glb.json['animations'] as unknown[]) : [];
  const animation = animations[animationIndex] as
    | { name?: unknown; channels?: unknown[]; samplers?: unknown[] }
    | undefined;
  if (!animation) return null;

  const nodes = readNodeTree(glb);
  const translations = new Map<number, Sampled>();
  const rotations = new Map<number, Sampled>();
  const scales = new Map<number, Sampled>();
  let start = Infinity;
  let end = -Infinity;

  for (const raw of animation.channels ?? []) {
    const channel = raw as { sampler?: number; target?: { node?: number; path?: string } };
    const node = channel.target?.node;
    const path = channel.target?.path;
    const sampler = (animation.samplers ?? [])[channel.sampler ?? -1] as
      | { input?: number; output?: number; interpolation?: string }
      | undefined;
    if (node === undefined || path === undefined || sampler === undefined) continue;
    if (path === 'weights') continue;
    if (typeof sampler.input !== 'number' || typeof sampler.output !== 'number') continue;

    const sampled: Sampled = {
      times: readAccessor(glb, sampler.input),
      values: readAccessor(glb, sampler.output),
      components: path === 'rotation' ? 4 : 3,
      step: sampler.interpolation === 'STEP',
      cubic: sampler.interpolation === 'CUBICSPLINE',
    };
    start = Math.min(start, sampled.times[0] ?? 0);
    end = Math.max(end, sampled.times[sampled.times.length - 1] ?? 0);
    if (path === 'translation') translations.set(node, sampled);
    else if (path === 'rotation') rotations.set(node, sampled);
    else if (path === 'scale') scales.set(node, sampled);
  }
  if (!(end > start)) return null;

  const bones = boneMap(nodes);
  const rootNode = bones.get('hips')?.index ?? 0;
  const footKeys = ['leftfoot', 'rightfoot'] as const;

  const times: number[] = [];
  const hipsPath: Vec3[] = [];
  const feetPaths = new Map<string, Vec3[]>(footKeys.map((key) => [key, []]));

  for (let frame = 0; frame < frames; frame += 1) {
    const t = start + ((end - start) * frame) / (frames - 1);
    const locals = nodes.map((node) => {
      const translation = translations.get(node.index);
      const rotation = rotations.get(node.index);
      const scaling = scales.get(node.index);
      if (!translation && !rotation && !scaling) return compose(node.translation, node.rotation, node.scale);
      const t3 = translation ? sampleAt(translation, t) : [...node.translation];
      const r4 = rotation ? sampleAt(rotation, t) : [...node.rotation];
      const s3 = scaling ? sampleAt(scaling, t) : [...node.scale];
      return compose(
        [t3[0] ?? 0, t3[1] ?? 0, t3[2] ?? 0],
        [r4[0] ?? 0, r4[1] ?? 0, r4[2] ?? 0, r4[3] ?? 1],
        [s3[0] ?? 1, s3[1] ?? 1, s3[2] ?? 1],
      );
    });
    const world = posedWorld(nodes, locals);
    const originOf = (index: number): Vec3 => {
      const m = world[index] ?? identity();
      return [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0];
    };
    times.push(t);
    hipsPath.push(originOf(rootNode));
    for (const key of footKeys) {
      const node = bones.get(key);
      if (node === undefined) continue;
      feetPaths.get(key)?.push(originOf(node.index));
    }
  }

  const rootTravel =
    translations.get(rootNode) === undefined
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
    strideLength = Math.max(
      strideLength,
      Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)),
    );
  }

  return {
    animation: typeof animation.name === 'string' ? animation.name : '',
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
export function restPoseDeltas(a: readonly GlbReadNode[], b: readonly GlbReadNode[]): readonly RestDelta[] {
  const left = boneMap(a);
  const right = boneMap(b);
  const found: RestDelta[] = [];

  for (const [key, nodeA] of left) {
    const nodeB = right.get(key);
    if (nodeB === undefined) continue;
    // Compared as the rotation each rest matrix applies to the three axes,
    // which is scale-independent -- the two files may well be exported at
    // different sizes, and that is not what this is asking about.
    let worst = 0;
    for (const axis of [0, 1, 2]) {
      const va = normalize([nodeA.world[axis] ?? 0, nodeA.world[axis + 4] ?? 0, nodeA.world[axis + 8] ?? 0]);
      const vb = normalize([nodeB.world[axis] ?? 0, nodeB.world[axis + 4] ?? 0, nodeB.world[axis + 8] ?? 0]);
      worst = Math.max(worst, angleBetween(va, vb) ?? 0);
    }
    found.push({ bone: key, degrees: worst });
  }
  return found.sort((x, y) => y.degrees - x.degrees);
}

// --- one report, three callers -----------------------------------------------

export type FacingSeverity = 'ok' | 'warning' | 'error';

export interface FacingFinding {
  readonly severity: FacingSeverity;
  /** What was compared, e.g. `mesh vs rig`. */
  readonly title: string;
  readonly degrees: number | null;
  /** What it means and what to do about it. */
  readonly message: string;
}

export interface ClipReport {
  /** The file this clip came from, as the caller named it. */
  readonly source: string;
  readonly animation: string;
  readonly strideForward: Vec3 | null;
  readonly rootTravel: Vec3 | null;
  readonly strideLength: number;
  /** False for an idle or a pose, which is not asked which way it goes. */
  readonly moving: boolean;
  readonly degreesFromRig: number | null;
  /** Bones whose rest pose differs from the mesh's by more than a few degrees. */
  readonly restDrift: readonly RestDelta[];
  readonly error: string | null;
}

export interface FacingReport {
  readonly mesh: MeshFacing;
  readonly rig: RigFacing;
  readonly clips: readonly ClipReport[];
  readonly findings: readonly FacingFinding[];
  /** Set when the mesh could not be read at all; everything else is then empty. */
  readonly error: string | null;
}

/** A `.glb` and whatever the caller wants it called in the report. */
export interface FacingSource {
  readonly name: string;
  readonly bytes: Uint8Array;
}

function compare(
  title: string,
  a: Vec3 | null,
  b: Vec3 | null,
  backwards: string,
  sideways: string,
): FacingFinding | null {
  const degrees = angleBetween(a, b);
  if (degrees === null) return null;
  if (degrees > BACKWARDS_DEGREES) return { severity: 'error', title, degrees, message: backwards };
  if (degrees > SIDEWAYS_DEGREES) return { severity: 'error', title, degrees, message: sideways };
  return { severity: 'ok', title, degrees, message: 'these agree' };
}

/**
 * The four measurements, turned into findings that each name a cause.
 *
 * One function so the terminal, the route and the button cannot disagree about
 * what a unit is doing -- the same argument spec 111 makes about the state
 * machine, for the same reason.
 */
export function facingReport(mesh: FacingSource, clips: readonly FacingSource[]): FacingReport {
  let meshGlb: GlbBinary;
  let meshNodes: readonly GlbReadNode[];
  try {
    meshGlb = splitGlb(mesh.bytes);
    meshNodes = readNodeTree(meshGlb);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      mesh: { fromFeet: null, fromHead: null, lean: { feet: 0, head: 0 }, vertexCount: 0 },
      rig: { forward: null, left: null, handednessOk: null },
      clips: [],
      findings: [],
      error: `${mesh.name}: ${message}`,
    };
  }

  const geometry = meshFacing(readSkinnedMesh(meshGlb));
  const rig = rigFacing(meshNodes);
  const findings: FacingFinding[] = [];
  const push = (finding: FacingFinding | null): void => {
    if (finding !== null) findings.push(finding);
  };

  push(
    compare(
      'mesh vs rig',
      geometry.fromFeet,
      rig.forward,
      'the skeleton was fitted into the mesh BACKWARDS. Every clip will play backwards and no clip is at fault: this is the generation to redo, with the other orientation.',
      'the skeleton is yawed inside the mesh, so the body will walk across its own facing.',
    ),
  );
  push(
    compare(
      'mesh feet vs mesh head',
      geometry.fromFeet,
      geometry.fromHead,
      'the two geometry estimates disagree, so one of them is wrong. Read the rest of this against the rig rather than against the mesh.',
      'the two geometry estimates disagree, so neither is worth much on this subject.',
    ),
  );
  push(
    compare(
      'rig vs the +X the scene draws',
      rig.forward,
      PROJECT_FORWARD,
      'the rig faces the way the scene will draw its back. Nothing applies `forwardAxis` at import, so this has to be corrected in the asset.',
      'the rig does not face +X, and the scene yaws every body assuming it does.',
    ),
  );
  if (rig.handednessOk === false) {
    findings.push({
      severity: 'error',
      title: 'handedness',
      degrees: null,
      message:
        'the bones named Left* are on the rig\'s right, given where the toes point. Not independent of the above: a rig fitted 180° around implies it.',
    });
  }

  const clipReports: ClipReport[] = [];
  for (const clip of clips) {
    clipReports.push(readClip(clip, meshNodes, rig, findings));
  }

  return { mesh: geometry, rig, clips: clipReports, findings, error: null };
}

function readClip(
  clip: FacingSource,
  meshNodes: readonly GlbReadNode[],
  rig: RigFacing,
  findings: FacingFinding[],
): ClipReport {
  const empty = {
    source: clip.name,
    animation: '',
    strideForward: null,
    rootTravel: null,
    strideLength: 0,
    moving: false,
    degreesFromRig: null,
    restDrift: [],
  };
  let glb: GlbBinary;
  try {
    glb = splitGlb(clip.bytes);
  } catch (cause) {
    return { ...empty, error: cause instanceof Error ? cause.message : String(cause) };
  }

  const facing = clipFacing(glb);
  if (facing === null) return { ...empty, error: 'no animation in this file' };

  const drift = restPoseDeltas(meshNodes, readNodeTree(glb)).filter((delta) => delta.degrees > REST_DRIFT_DEGREES);
  if (drift.length > 0) {
    const worst = drift.slice(0, 4).map((delta) => `${delta.bone} ${Math.round(delta.degrees)}°`).join(', ');
    findings.push({
      severity: 'error',
      title: `${clip.name}: rest pose`,
      degrees: drift[0]?.degrees ?? null,
      message:
        `its rest pose differs from the mesh's on ${drift.length} bone(s) -- ${worst}. ` +
        'Clips bind by bone name onto the mesh\'s rig, so that difference is applied to every frame.',
    });
  }

  // A clip with no travel is an idle, and an idle has no opinion about forward.
  // Reporting one would be noise at best and a wrong diagnosis at worst: the
  // estimator fits a slope through a foot that never moves.
  const moving = facing.strideLength >= STILL_STRIDE;
  if (moving) {
    const finding = compare(
      `${clip.name}: stride vs rig`,
      facing.strideForward,
      rig.forward,
      'the clip strides towards the rig\'s BACK. This is the walk-backwards symptom in the clip rather than in the rig.',
      'the clip strides across the rig rather than along it.',
    );
    if (finding !== null) findings.push(finding);
  }

  return {
    source: clip.name,
    animation: facing.animation,
    strideForward: facing.strideForward,
    rootTravel: facing.rootTravel,
    strideLength: facing.strideLength,
    moving,
    degreesFromRig: moving ? angleBetween(facing.strideForward, rig.forward) : null,
    restDrift: drift,
    error: null,
  };
}

/** Whether anything in a report is actually wrong. */
export function facingIsClean(report: FacingReport): boolean {
  return report.error === null && report.findings.every((finding) => finding.severity === 'ok');
}
