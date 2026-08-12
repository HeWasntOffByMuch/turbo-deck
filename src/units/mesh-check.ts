/**
 * The checks that need the vertices (spec 115).
 *
 * Everything else in this directory validates a *document*. These read the mesh,
 * and they exist because the ways a generated rig actually goes wrong are all
 * invisible to a schema: weights that do not sum, a vertex bound to nothing, a
 * bind pose that is really the idle, an elbow that folds inside out at the end
 * of a swing. Each of those looks perfect standing still, which is how each of
 * them ships.
 *
 * Findings come back as the same {@link Issue} shape everything else uses, so
 * they print through `formatIssue` and are asserted on by `code` rather than by
 * wording.
 *
 * ## Error or warning
 *
 * An **error** is a fact about the file: the weights do not sum, a joint index
 * points at nothing, there is a second influence set the runtime will drop. A
 * **warning** is a judgement about how the result looks -- a lumpy elbow, a
 * pose that is nearly a T. A build may fail on the first kind. Deciding the
 * second is a person's job, which is what `scripts/preview-deform.ts` is for.
 *
 * Pure, and part of the deterministic core.
 */

import { error, pointer, warning, type Issue } from './issues.js';
import { nodePosition, type GlbReadNode, type SkinnedMeshData } from './glb-read.js';
import { detectNaming, findRole, type BoneRole, type NamingSpec } from './naming.js';
import {
  axisQuat,
  meshVolume,
  poseWorldMatrices,
  skinPositions,
  triangleNormal,
  type PoseRotations,
  type SkinInput,
} from './skin.js';

/**
 * How far a vertex's weights may sum from 1.
 *
 * Loose enough for normalized-byte weights, which quantize to 1/255 and are what
 * most exporters emit: four of those can miss by ~0.008 before anything is
 * wrong. Tight enough that the failure this is looking for -- a weight set that
 * sums to 0.8 and shrinks the body toward the origin as it poses -- is nowhere
 * near it.
 */
export const WEIGHT_SUM_TOLERANCE = 0.01;

// ---------------------------------------------------------------------------
// skinning
// ---------------------------------------------------------------------------

/**
 * Everything the vertex data itself can be wrong about.
 *
 * Reports the *worst* offender with its numbers plus a count, rather than one
 * issue per vertex: a mesh with a systematic weighting fault has thousands of
 * bad vertices and a list of thousands is unreadable, while "3184 of 8000, worst
 * is vertex 91 at 0.62" is actionable in one line.
 */
export function checkSkinning(mesh: SkinnedMeshData, meshRef = 'the mesh'): readonly Issue[] {
  const issues: Issue[] = [];
  const at = (...segments: readonly (string | number)[]): string => pointer(meshRef, ...segments);

  if (mesh.hasSecondInfluenceSet) {
    // glTF's VEC4 makes four influences structural, so a fifth can only arrive
    // as JOINTS_1/WEIGHTS_1 -- which three reads and the runtime here does not.
    // Silently dropped, so the mesh deforms subtly differently in the game than
    // in whatever produced it.
    issues.push(
      error(
        'mesh.influences.second-set',
        at('JOINTS_1'),
        'the mesh has a second influence set (JOINTS_1/WEIGHTS_1), so some vertices are bound to more than four ' +
          'bones. Nothing here reads the second set and the deformation will differ from the source. Re-export ' +
          'with a four-bone limit.',
      ),
    );
  }

  let badSums = 0;
  let worstVertex = -1;
  let worstSum = 1;
  let unbound = 0;
  let firstUnbound = -1;
  let outOfRange = 0;
  let firstOutOfRange = -1;
  let negative = 0;

  for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
    let sum = 0;
    for (let slot = 0; slot < 4; slot += 1) {
      const weight = mesh.weights[vertex * 4 + slot] ?? 0;
      const joint = mesh.joints[vertex * 4 + slot] ?? 0;
      sum += weight;
      if (weight < 0) negative += 1;
      // A zero weight may name any joint -- exporters leave the slot's index at
      // whatever it was -- so an index is only wrong when it is actually used.
      if (weight > 0 && joint >= mesh.jointNodes.length) {
        outOfRange += 1;
        if (firstOutOfRange < 0) firstOutOfRange = vertex;
      }
    }
    if (sum === 0) {
      unbound += 1;
      if (firstUnbound < 0) firstUnbound = vertex;
      continue;
    }
    if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
      badSums += 1;
      if (Math.abs(sum - 1) > Math.abs(worstSum - 1)) {
        worstSum = sum;
        worstVertex = vertex;
      }
    }
  }

  if (badSums > 0) {
    issues.push(
      error(
        'mesh.weights.sum',
        at('WEIGHTS_0'),
        `${badSums} of ${mesh.vertexCount} vertices have weights that do not sum to 1 (worst: vertex ` +
          `${worstVertex} at ${worstSum.toFixed(4)}). A vertex weighted below 1 is pulled toward the origin as ` +
          'the body poses, and above 1 is thrown away from it.',
      ),
    );
  }
  if (unbound > 0) {
    issues.push(
      error(
        'mesh.weights.unbound',
        at('WEIGHTS_0'),
        `${unbound} of ${mesh.vertexCount} vertices are bound to no bone at all (first: vertex ${firstUnbound}). ` +
          'Those stay exactly where they are while the rest of the body walks away from them.',
      ),
    );
  }
  if (outOfRange > 0) {
    issues.push(
      error(
        'mesh.joints.range',
        at('JOINTS_0'),
        `${outOfRange} weighted influences name a joint outside the skin's ${mesh.jointNodes.length} joints ` +
          `(first: vertex ${firstOutOfRange}). Refused rather than clamped -- clamping picks a bone, and a body ` +
          'part following the wrong bone looks like a rigging choice.',
      ),
    );
  }
  if (negative > 0) {
    issues.push(error('mesh.weights.negative', at('WEIGHTS_0'), `${negative} influences have a negative weight.`));
  }

  issues.push(...checkOrphanVertices(mesh, at));
  issues.push(...checkDegenerateTriangles(mesh, at));
  return issues;
}

/**
 * Triangles with no area.
 *
 * Two of the three corners are the same point, so the triangle draws nothing and
 * has no normal to shade with. They arrive from a box whose extent on one axis
 * is zero -- which is precisely how the reference mannequin's arms were built
 * before this check existed: flat cards that vanished edge-on, 32 of its 156
 * triangles drawing nothing, and no document anywhere able to say so.
 *
 * A warning rather than an error. A degenerate triangle is waste, not a failure:
 * it renders as nothing on every renderer, which is exactly why it survives.
 */
function checkDegenerateTriangles(
  mesh: SkinnedMeshData,
  at: (...segments: readonly (string | number)[]) => string,
): readonly Issue[] {
  let degenerate = 0;
  let total = 0;
  for (let index = 0; index + 2 < mesh.indices.length; index += 3) {
    total += 1;
    const normal = triangleNormal(
      mesh.positions,
      mesh.indices[index] ?? 0,
      mesh.indices[index + 1] ?? 0,
      mesh.indices[index + 2] ?? 0,
    );
    if (magnitude(normal) < NEGLIGIBLE_AREA) degenerate += 1;
  }
  if (degenerate === 0) return [];
  return [
    warning(
      'mesh.triangles.degenerate',
      at('indices'),
      `${degenerate} of ${total} triangles have no area, so they draw nothing and shade from a normal that does ` +
        'not exist. Usually a box with zero extent on one axis, or a quad with two corners at the same point.',
    ),
  ];
}

function magnitude(v: readonly [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/**
 * Vertices no triangle references.
 *
 * Not drawn, so they cost nothing to look at -- but they are in the POSITION
 * accessor, which is what a bounding box is computed from, and a stray vertex at
 * the origin makes a unit's box twice the size of the unit. That is a frustum
 * cull that never happens and a ground-plane offset that is silently wrong.
 */
function checkOrphanVertices(
  mesh: SkinnedMeshData,
  at: (...segments: readonly (string | number)[]) => string,
): readonly Issue[] {
  const referenced = new Uint8Array(mesh.vertexCount);
  for (const index of mesh.indices) {
    if (index < mesh.vertexCount) referenced[index] = 1;
  }
  let orphans = 0;
  let first = -1;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
    if (referenced[vertex] === 1) continue;
    orphans += 1;
    if (first < 0) first = vertex;
  }
  if (orphans === 0) return [];
  return [
    warning(
      'mesh.vertices.orphan',
      at('POSITION'),
      `${orphans} of ${mesh.vertexCount} vertices are referenced by no triangle (first: vertex ${first}). They are ` +
        'not drawn, but they are in the bounding box, which is what culling and the ground plane are computed from.',
    ),
  ];
}

// ---------------------------------------------------------------------------
// the bind pose
// ---------------------------------------------------------------------------

export type BindPoseShape = 'T' | 'A' | 'posed' | 'unmeasured';

export interface BindPoseVerdict {
  readonly shape: BindPoseShape;
  /** Degrees below horizontal, averaged over both arms. Negative is raised. */
  readonly armDropDegrees: number;
  /** Straightest-to-most-bent elbow angle, in degrees. 180 is straight. */
  readonly elbowDegrees: number;
  readonly kneeDegrees: number;
  /** How far the two sides disagree, in degrees. */
  readonly asymmetryDegrees: number;
  readonly reason: string;
}

/** Arms this far from horizontal or closer is a T. */
const T_POSE_DROP = 25;
/** Between {@link T_POSE_DROP} and this, an A. Below it, the arms are at the sides. */
const A_POSE_DROP = 60;
/** A limb straighter than this counts as extended. */
const STRAIGHT_ENOUGH = 150;
/** Sides may disagree by this much before it is worth saying. */
const SYMMETRY_TOLERANCE = 4;

interface ArmMeasure {
  readonly dropDegrees: number;
  readonly elbowDegrees: number;
}

/**
 * Whether a rig's rest pose is a bind pose or somebody's idle.
 *
 * This is the check that matters most, and it is the hardest one to make from a
 * picture: a generated model whose rest pose is its idle looks *better* in the
 * viewport than a correct T, and every clip retargeted onto it inherits the
 * idle's offsets. Arms end up crossing the body, knees stay bent through a
 * stride, and the result is described as "the animations twist the legs into odd
 * shapes" -- which is exactly what it is, and is nothing to do with the clips.
 *
 * Measured off the node tree in world space, so a rig with unusual local axes
 * measures the same as a conventional one. Nothing here reads a bone's rotation.
 */
export function classifyBindPose(nodes: readonly GlbReadNode[]): BindPoseVerdict {
  const naming = detectNaming(nodes.map((node) => node.name));
  const left = naming === 'unknown' ? null : measureArm(nodes, naming, 'left');
  const right = naming === 'unknown' ? null : measureArm(nodes, naming, 'right');
  const leftKnee = naming === 'unknown' ? null : measureChain(nodes, naming, 'leftUpLeg', 'leftLeg', 'leftFoot');
  const rightKnee = naming === 'unknown' ? null : measureChain(nodes, naming, 'rightUpLeg', 'rightLeg', 'rightFoot');

  if (!left || !right) {
    // *Unmeasured*, not posed. These two are wildly different findings and the
    // second one ends with "regenerate" -- so reporting a rig this cannot read
    // as a bad bind pose spends money to fix a model that may be perfect.
    //
    // This used to fire on every generated unit: the arm chain was looked up by
    // mixamo name and the rigs are on the tripo vocabulary, where the same three
    // bones are `L_Upperarm`, `L_Forearm`, `L_Hand`. Since spec 120 the lookup
    // goes through the naming table, so reaching here means a rig on neither
    // contract -- which is a real finding rather than a spelling difference.
    return {
      shape: 'unmeasured',
      armDropDegrees: Number.NaN,
      elbowDegrees: Number.NaN,
      kneeDegrees: Number.NaN,
      asymmetryDegrees: Number.NaN,
      reason:
        naming === 'unknown'
          ? 'the rig answers to neither naming contract, so no arm chain could be found to measure'
          : `the rig has no arm chain this could measure (looked for the ${naming} upper-arm, forearm and hand)`,
    };
  }

  const armDrop = (left.dropDegrees + right.dropDegrees) / 2;
  const elbow = Math.min(left.elbowDegrees, right.elbowDegrees);
  const knee = Math.min(leftKnee ?? 180, rightKnee ?? 180);
  const asymmetry = Math.max(
    Math.abs(left.dropDegrees - right.dropDegrees),
    Math.abs(left.elbowDegrees - right.elbowDegrees),
    Math.abs((leftKnee ?? 180) - (rightKnee ?? 180)),
  );

  const shape = ((): BindPoseShape => {
    if (elbow < STRAIGHT_ENOUGH) return 'posed';
    if (knee < STRAIGHT_ENOUGH) return 'posed';
    if (Math.abs(armDrop) <= T_POSE_DROP) return 'T';
    if (armDrop > T_POSE_DROP && armDrop <= A_POSE_DROP) return 'A';
    return 'posed';
  })();

  return {
    shape,
    armDropDegrees: armDrop,
    elbowDegrees: elbow,
    kneeDegrees: knee,
    asymmetryDegrees: asymmetry,
    reason: reasonFor(shape, armDrop, elbow, knee),
  };
}

function reasonFor(shape: BindPoseShape, armDrop: number, elbow: number, knee: number): string {
  if (shape === 'T') return `arms ${armDrop.toFixed(0)}° from horizontal, limbs extended`;
  if (shape === 'A') return `arms ${armDrop.toFixed(0)}° below horizontal, limbs extended`;
  if (elbow < STRAIGHT_ENOUGH) return `the elbows are bent (${elbow.toFixed(0)}°, straight is 180°)`;
  if (knee < STRAIGHT_ENOUGH) return `the knees are bent (${knee.toFixed(0)}°, straight is 180°)`;
  if (armDrop > A_POSE_DROP) return `the arms hang at the sides (${armDrop.toFixed(0)}° below horizontal)`;
  return `the arms are raised (${(-armDrop).toFixed(0)}° above horizontal)`;
}

/**
 * The pose findings, as issues.
 *
 * A pose that is neither T nor A is an **error**: it is not a matter of taste,
 * it is the input contract every retarget in the pipeline assumes. Asymmetry is
 * a warning, because a couple of degrees is a modelling artefact and only a
 * person can say whether more than that matters on this particular body.
 */
export function checkBindPose(verdict: BindPoseVerdict, meshRef = 'the mesh'): readonly Issue[] {
  const issues: Issue[] = [];
  if (verdict.shape === 'unmeasured') {
    // A warning, and it names what is missing rather than what is wrong. The
    // bind pose may well be a perfect T; nothing here can see it.
    issues.push(
      warning(
        'mesh.bindpose.unmeasured',
        pointer(meshRef, 'bindPose'),
        `the bind pose could not be classified: ${verdict.reason}. Nothing is claimed about it -- this is the ` +
          'check being unable to read the rig, not a finding about the rig.',
      ),
    );
  }
  if (verdict.shape === 'posed') {
    issues.push(
      error(
        'mesh.bindpose.posed',
        pointer(meshRef, 'bindPose'),
        `the rest pose is not a T or an A: ${verdict.reason}. Every clip retargeted onto this rig inherits those ` +
          'offsets, which is what "the animations twist the body into odd shapes" looks like. Regenerate from a ' +
          'reference image of the subject standing square with its limbs extended.',
      ),
    );
  }
  if (Number.isFinite(verdict.asymmetryDegrees) && verdict.asymmetryDegrees > SYMMETRY_TOLERANCE) {
    issues.push(
      warning(
        'mesh.bindpose.asymmetric',
        pointer(meshRef, 'bindPose'),
        `the two sides of the rig disagree by ${verdict.asymmetryDegrees.toFixed(0)}°. A mirrored clip will lean, ` +
          'and it will lean by more than this once the retarget scales it.',
      ),
    );
  }
  return issues;
}

/** World position of the first bone whose name ends in `suffix`, or null. */
function boneAt(nodes: readonly GlbReadNode[], naming: NamingSpec, role: BoneRole): [number, number, number] | null {
  const name = findRole(nodes.map((node) => node.name), naming, role);
  const found = name === null ? undefined : nodes.find((node) => node.name === name);
  return found ? nodePosition(found) : null;
}

function measureArm(nodes: readonly GlbReadNode[], naming: NamingSpec, side: 'left' | 'right'): ArmMeasure | null {
  const shoulder = boneAt(nodes, naming, `${side}Arm`);
  const hand = boneAt(nodes, naming, `${side}Hand`);
  const elbow = measureChain(nodes, naming, `${side}Arm`, `${side}ForeArm`, `${side}Hand`);
  if (!shoulder || !hand || elbow === null) return null;

  // Drop is measured against the horizontal *plane*, not against a chosen axis:
  // the horizontal reach is the length of the xz component, so it is the same
  // number whether the rig faces +X or +Z.
  const dy = hand[1] - shoulder[1];
  const horizontal = Math.hypot(hand[0] - shoulder[0], hand[2] - shoulder[2]);
  return { dropDegrees: (Math.atan2(-dy, horizontal) * 180) / Math.PI, elbowDegrees: elbow };
}

/** The interior angle at `middle`, in degrees. 180 is a straight limb. */
function measureChain(
  nodes: readonly GlbReadNode[],
  naming: NamingSpec,
  root: BoneRole,
  middle: BoneRole,
  tip: BoneRole,
): number | null {
  const a = boneAt(nodes, naming, root);
  const b = boneAt(nodes, naming, middle);
  const c = boneAt(nodes, naming, tip);
  if (!a || !b || !c) return null;
  const u = [a[0] - b[0], a[1] - b[1], a[2] - b[2]] as const;
  const v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]] as const;
  const lu = Math.hypot(u[0], u[1], u[2]);
  const lv = Math.hypot(v[0], v[1], v[2]);
  if (lu === 0 || lv === 0) return null;
  const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// deformation
// ---------------------------------------------------------------------------

export interface ExtremePose {
  readonly id: string;
  /** What in the clip vocabulary actually reaches this far. */
  readonly why: string;
  readonly rotations: PoseRotations;
}

/**
 * Which way a bone is being turned, in the *body's* axes rather than the file's.
 *
 * Turning about `lateral` moves a bone forward and back in the sagittal plane --
 * a knee bending, a hip swinging through a stride. About `forward` it rises and
 * falls sideways -- an arm lifting from an A to a T and on over the head. About
 * `up` it sweeps horizontally -- a spine twisting, an arm coming across the
 * chest.
 */
type PoseAxis = 'lateral' | 'forward' | 'up';

interface PoseTurn {
  /** The bone by role, resolved through the rig's own vocabulary (spec 120). */
  readonly bone: BoneRole;
  readonly axis: PoseAxis;
  readonly degrees: number;
}

/** Every rig in this project is +Y up, and the skeleton documents say so. */
const UP: readonly [number, number, number] = [0, 1, 0];

/**
 * The body's three axes, measured off the rig.
 *
 * `lateral` comes from the hips, which are two bones a biped is guaranteed to
 * have and which cannot be confused for anything else; the shoulders are the
 * fallback. `forward` follows from it. Nothing here reads the skeleton document,
 * so this works on a `.glb` that arrived without one.
 */
interface BodyFrame {
  readonly lateral: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
  readonly up: readonly [number, number, number];
}

function bodyFrame(nodes: readonly GlbReadNode[], naming: NamingSpec): BodyFrame | null {
  const across = (left: BoneRole, right: BoneRole): [number, number, number] | null => {
    const a = boneAt(nodes, naming, left);
    const b = boneAt(nodes, naming, right);
    if (!a || !b) return null;
    const out: [number, number, number] = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    return magnitude(out) < 1e-9 ? null : out;
  };
  const lateral = across('leftUpLeg', 'rightUpLeg') ?? across('leftArm', 'rightArm');
  if (!lateral) return null;
  const forward = cross(lateral, UP);
  if (magnitude(forward) < 1e-9) return null;
  return { lateral, forward, up: UP };
}

/**
 * The poses a unit is checked at, resolved against the rig's own geometry.
 *
 * Not arbitrary extremes. Each is the end of a range the retarget presets
 * actually drive -- a slash takes the shoulder back past vertical and through
 * past the chest, a run bends the knee to a right angle, a turn twists the
 * spine. A check at a pose nothing reaches would fail units that are fine, and a
 * check at a pose short of what the clips use would pass units that break in
 * play.
 *
 * The axes are the **body's**, measured off the rig, not axis letters written
 * down here. `rotate the shoulder about Z` assumes the arms extend along X,
 * which is the mixamo convention and is not what the reference rig does -- its
 * arms run along Z, so a Z rotation rolled each arm about its own length and
 * moved nothing at all. The check scored a flawless zero on a pose it had not
 * applied, which is the worst thing a check can do.
 */
export function extremePoses(nodes: readonly GlbReadNode[]): readonly ExtremePose[] {
  const naming = detectNaming(nodes.map((node) => node.name));
  if (naming === 'unknown') return [];
  const frame = bodyFrame(nodes, naming);
  if (!frame) return [];

  const poses: readonly { id: string; why: string; turns: readonly PoseTurn[] }[] = [
    {
      id: 'slash.windup',
      why: 'the shoulder at the back of a slash, past vertical',
      turns: [
        { bone: 'rightArm', axis: 'forward', degrees: 150 },
        { bone: 'rightForeArm', axis: 'up', degrees: -90 },
        { bone: 'chest', axis: 'up', degrees: -35 },
      ],
    },
    {
      id: 'slash.follow-through',
      why: 'the same shoulder at the end of the swing, across the chest',
      turns: [
        { bone: 'rightArm', axis: 'up', degrees: 110 },
        { bone: 'rightForeArm', axis: 'forward', degrees: 60 },
        { bone: 'chest', axis: 'up', degrees: 40 },
      ],
    },
    {
      id: 'run.knee',
      why: 'the knee at the top of a run cycle, folded to a right angle',
      turns: [
        { bone: 'leftUpLeg', axis: 'lateral', degrees: 70 },
        { bone: 'leftLeg', axis: 'lateral', degrees: -120 },
        { bone: 'rightUpLeg', axis: 'lateral', degrees: -45 },
      ],
    },
    {
      id: 'turn.spine',
      why: 'the spine at the end of a turn',
      turns: [
        { bone: 'spine', axis: 'up', degrees: 35 },
        { bone: 'chest', axis: 'up', degrees: 35 },
        { bone: 'neck', axis: 'up', degrees: 30 },
      ],
    },
  ];

  const built: ExtremePose[] = [];
  for (const pose of poses) {
    const rotations = new Map<string, readonly [number, number, number, number]>();
    for (const turn of pose.turns) {
      const resolved = resolveTurn(turn, frame, nodes, naming);
      if (resolved) rotations.set(resolved.bone, resolved.rotation);
    }
    if (rotations.size > 0) built.push({ id: pose.id, why: pose.why, rotations });
  }
  return built;
}

/**
 * One turn, as a quaternion in the bone's own local frame.
 *
 * The axis is chosen in world space -- where "lateral" and "up" mean something
 * about the body -- and then carried back into the bone's frame, because
 * `poseWorldMatrices` composes the extra rotation after the bone's own. Skipping
 * that step is the subtle version of the axis-letter mistake: it works on a rig
 * whose bind rotations are all identity and quietly does something else on every
 * rig that is not, which is every rig that came out of a generator.
 */
function resolveTurn(
  turn: PoseTurn,
  frame: BodyFrame,
  nodes: readonly GlbReadNode[],
  naming: NamingSpec,
): { bone: string; rotation: [number, number, number, number] } | null {
  const name = findRole(nodes.map((entry) => entry.name), naming, turn.bone);
  const node = name === null ? undefined : nodes.find((entry) => entry.name === name);
  if (!node) return null;
  const local = intoLocalFrame(frame[turn.axis], node.world);
  if (magnitude(local) < 1e-6) return null;
  return { bone: node.name, rotation: axisQuat(local, (turn.degrees * Math.PI) / 180) };
}

/** A world-space direction expressed in the frame the node's own matrix sets up. */
function intoLocalFrame(axis: readonly [number, number, number], world: readonly number[]): [number, number, number] {
  // The transpose of the basis, which inverts a rotation. Scale falls out in the
  // normalisation `axisQuat` does anyway.
  return [
    (world[0] ?? 0) * axis[0] + (world[1] ?? 0) * axis[1] + (world[2] ?? 0) * axis[2],
    (world[4] ?? 0) * axis[0] + (world[5] ?? 0) * axis[1] + (world[6] ?? 0) * axis[2],
    (world[8] ?? 0) * axis[0] + (world[9] ?? 0) * axis[1] + (world[10] ?? 0) * axis[2],
  ];
}

function cross(a: readonly [number, number, number], b: readonly [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Below this fraction of its bind volume, the mesh has collapsed. */
const VOLUME_FLOOR = 0.5;
/** A vertex further than this many rig-heights from the body has been flung. */
const FLING_LIMIT = 1.5;
/** A triangle keeping less than this share of its bind area has folded shut. */
const PINCH_FLOOR = 0.1;
/** Above this fraction of triangles pinched, the surface has folded. */
const PINCH_LIMIT = 0.02;
/** A bind triangle smaller than this share of the mean has no area to compare. */
const NEGLIGIBLE_AREA = 1e-6;

export interface DeformationReport {
  readonly poseId: string;
  readonly volumeRatio: number;
  /** Triangles that lost almost all their area, which is what a fold looks like. */
  readonly pinchedTriangles: number;
  readonly triangles: number;
  readonly worstDisplacement: number;
}

/**
 * What each extreme pose does to the mesh, measured.
 *
 * Three numbers, and each catches a different real failure. **Volume** is signed
 * and rotation-invariant, so it catches both the candy-wrapper pinch -- a
 * twisted joint whose vertices collapse onto the bone's axis -- and a mesh that
 * has turned inside out, which shows up as a negative ratio. **Pinched
 * triangles** catch a surface folding through itself locally, at a crease the
 * whole-mesh volume barely notices. **Worst displacement** catches a single
 * vertex weighted to the wrong joint, which draws as a spike off the body and is
 * invisible in any average.
 *
 * The obvious fourth measure -- comparing each triangle's posed normal against
 * its bind normal and counting the flips -- is deliberately absent, because it
 * does not measure what it looks like it measures. A triangle rigidly carried
 * around by a bone that rotates 100° has a normal that turned 100°, and nothing
 * about it inverted. That check was written, and it reported every triangle on
 * the mannequin's head as inside out during a spine turn. Area is frame-free;
 * direction is not.
 *
 * All warnings. A build should not be the thing that decides an elbow is too
 * lumpy -- but it should be the thing that noticed.
 */
export function checkDeformation(
  mesh: SkinnedMeshData,
  nodes: readonly GlbReadNode[],
  inverseBind: readonly (readonly number[])[],
  poses: readonly ExtremePose[] = extremePoses(nodes),
  meshRef = 'the mesh',
): { readonly issues: readonly Issue[]; readonly reports: readonly DeformationReport[] } {
  const input: SkinInput = {
    positions: mesh.positions,
    joints: mesh.joints,
    weights: mesh.weights,
    jointNodes: mesh.jointNodes,
    inverseBind,
  };

  const bindVolume = meshVolume(mesh.positions, mesh.indices);
  const height = rigHeight(mesh.positions);
  const issues: Issue[] = [];
  const reports: DeformationReport[] = [];

  for (const pose of poses) {
    // A pose whose turns all failed to resolve would measure a perfect score for
    // a check that never happened, which is worse than not running it.
    // `extremePoses` drops those; a caller passing its own may not have.
    if (pose.rotations.size === 0) continue;

    const posed = skinPositions(input, poseWorldMatrices(nodes, pose.rotations));
    const volume = meshVolume(posed, mesh.indices);
    const volumeRatio = bindVolume === 0 ? 1 : volume / bindVolume;

    let pinched = 0;
    let triangles = 0;
    for (let at = 0; at + 2 < mesh.indices.length; at += 3) {
      const a = mesh.indices[at] ?? 0;
      const b = mesh.indices[at + 1] ?? 0;
      const c = mesh.indices[at + 2] ?? 0;
      const before = magnitude(triangleNormal(mesh.positions, a, b, c));
      // A triangle with no area at bind has no ratio to compare. Skipped here
      // and reported once, by name, in `checkMeshQuality` -- silently counting
      // them as pinched would blame every pose for the mesh.
      if (before < NEGLIGIBLE_AREA) continue;
      triangles += 1;
      const after = magnitude(triangleNormal(posed, a, b, c));
      if (after < before * PINCH_FLOOR) pinched += 1;
    }

    let worst = 0;
    for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
      const dx = (posed[vertex * 3] ?? 0) - (mesh.positions[vertex * 3] ?? 0);
      const dy = (posed[vertex * 3 + 1] ?? 0) - (mesh.positions[vertex * 3 + 1] ?? 0);
      const dz = (posed[vertex * 3 + 2] ?? 0) - (mesh.positions[vertex * 3 + 2] ?? 0);
      worst = Math.max(worst, Math.hypot(dx, dy, dz));
    }

    const report: DeformationReport = {
      poseId: pose.id,
      volumeRatio,
      pinchedTriangles: pinched,
      triangles,
      worstDisplacement: height === 0 ? 0 : worst / height,
    };
    reports.push(report);

    const where = pointer(meshRef, 'poses', pose.id);
    if (volumeRatio < VOLUME_FLOOR) {
      issues.push(
        warning(
          'mesh.deform.collapse',
          where,
          `at "${pose.id}" (${pose.why}) the mesh holds ${(volumeRatio * 100).toFixed(0)}% of its bind volume` +
            (volumeRatio < 0 ? ', and the sign says it has turned inside out' : '') +
            '. That is a joint pinching shut -- weights spread over too few bones at the crease.',
        ),
      );
    }
    if (pinched > triangles * PINCH_LIMIT) {
      issues.push(
        warning(
          'mesh.deform.pinch',
          where,
          `at "${pose.id}" (${pose.why}) ${pinched} of ${triangles} triangles fold to almost no area. Back faces ` +
            'are culled, so a fold reads as a hole in the body rather than as a crease.',
        ),
      );
    }
    if (report.worstDisplacement > FLING_LIMIT) {
      issues.push(
        warning(
          'mesh.deform.fling',
          where,
          `at "${pose.id}" (${pose.why}) a vertex moves ${report.worstDisplacement.toFixed(1)}x the rig's height. ` +
            'That is one vertex weighted to a joint on the other side of the body, and it draws as a spike.',
        ),
      );
    }
  }

  return { issues, reports };
}

/** The bind mesh's vertical extent, as the yardstick displacement is measured in. */
function rigHeight(positions: Float32Array): number {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let vertex = 0; vertex * 3 + 1 < positions.length; vertex += 1) {
    const y = positions[vertex * 3 + 1] ?? 0;
    min = Math.min(min, y);
    max = Math.max(max, y);
  }
  return Number.isFinite(min) && Number.isFinite(max) ? max - min : 0;
}
