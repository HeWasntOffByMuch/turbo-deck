import * as THREE from 'three';
import { CapsuleSet } from '../cloth/colliders.js';
import {
  BONE,
  BONE_COUNT,
  boneRestLayout,
  buildCapsuleDefs,
  FIGURE,
  type CapsuleDef,
  type FigureMetrics,
} from '../cloth/figure.js';
import { GRAVITY, type FigureTuning } from '../cloth/params.js';
import { Spring } from '../spring.js';
import { box, faceted, flatMaterial } from './meshes.js';
import { PALETTE } from './palette.js';
import { JumpMotion } from './jump.js';

/**
 * A biped's skeleton and locomotion (spec 046, generalised by spec 055).
 *
 * This is the *kinematic* half of a character: a bone hierarchy, a
 * distance-driven biped walk/run cycle, the lean and bank that come off
 * acceleration and turning, idle breathing, and a landing crouch. It knows
 * nothing about cloth. What it publishes is exactly what the cloth needs:
 *
 *  - `bones[]` with up-to-date world matrices, and `bindInverse[]` so any point
 *    expressed in the figure's bind pose can be skinned into world space,
 *  - `colliders`, refreshed from those matrices each frame,
 *  - the {@link JumpMotion} events the cloth turns into impulses.
 *
 * Splitting it this way is what makes the garment list independent of the
 * animation: a new cape or a set of armour skirts binds to the same bones and
 * needs no change here, and retuning the walk needs no change in the cloth.
 *
 * **Two things vary between characters, and both are arguments.** The
 * {@link FigureMetrics} set the proportions, and the {@link BodyDresser} hangs
 * the visible solid geometry off the bones. A hooded robe (the default,
 * {@link dressRobe}) and a bipedal pig walk on the same skeleton and differ only
 * in those two — which is what stops each new character from becoming another
 * copy of this walk cycle.
 *
 * Built facing **+x** with up **+y**, matching every other rig in the scene, so
 * the scene can drive it with the same `group.rotation.y = -facing` it uses for
 * the mechs. Nothing here reads or writes sim state.
 */

const TWO_PI = Math.PI * 2;

// --- Gait shaping -------------------------------------------------------
// Speed thresholds, in world units/s, matching the mech rig's so the two units
// read as living in the same world.
const IDLE_SPEED = 5;
const WALK_SPEED = 34;
const RUN_SPEED = 150;
/** World distance covered by one full two-step cycle, walking and running. */
const STRIDE_WALK = 58;
const STRIDE_RUN = 112;
/** Hip swing amplitude (radians) at a walk and at a full run. */
const HIP_SWING_WALK = 0.42;
const HIP_SWING_RUN = 0.78;
/** Peak knee bend (radians) at a walk and at a full run. */
const KNEE_BEND_WALK = 0.75;
const KNEE_BEND_RUN = 1.35;
/** Vertical bob of the pelvis (world units) at a full run. */
const BOB_AMP = 3.4;
/** Pelvis lateral tilt and torso counter-twist, radians at a full run. */
const PELVIS_ROLL = 0.09;
const PELVIS_YAW = 0.13;
/** Radians of forward lean per unit/s^2 of acceleration, and the cap on it. */
const LEAN_PER_ACCEL = 0.0013;
const LEAN_MAX = 0.34;
/** Radians of bank per rad/s of turning, and the cap. */
const BANK_PER_TURN = 0.1;
const BANK_MAX = 0.26;
/** Idle breathing: vertical amplitude in world units and rate in Hz. */
const BREATH_AMP = 0.7;
const BREATH_HZ = 0.22;
/** How far the pelvis drops at a full landing crouch, in world units. */
const CROUCH_DROP = 13;
/**
 * How far the visible solid body is drawn *inside* its collision capsule. The
 * cloth is pushed out to `capsule radius + collisionRadius`, so as long as the
 * mesh stays within the capsule itself it can never poke through its garment.
 */
const SOLID_INSET = 0.6;

export type GaitState = 'idle' | 'walking' | 'running' | 'turning' | 'airborne' | 'landing';

/**
 * Hangs a character's visible geometry off a freshly built skeleton. Called once
 * from the constructor, with the bones in their rest pose and indexed by
 * {@link BONE}; whatever it parents to them is animated for free thereafter.
 *
 * It must not move the bones themselves — the bind pose is captured immediately
 * afterwards, and the cloth is cut against it.
 */
export type BodyDresser = (bones: readonly THREE.Object3D[], f: FigureMetrics) => void;

/** What the rig observed about the character's motion this frame. */
export interface GaitInput {
  /** Ground speed in world units/s. */
  speed: number;
  /** Signed forward acceleration in world units/s^2. */
  accel: number;
  /** Yaw rate in rad/s (positive turns the figure's left). */
  turnRate: number;
  /** Ground distance travelled this frame, which is what advances the stride. */
  distance: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Smooth 0..1 ramp between two thresholds. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (!(edge1 > edge0)) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Reused scratch so refreshing the colliders allocates nothing per frame. */
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class Humanoid {
  /**
   * The figure's root. Carries the uniform body scale and the jump's vertical
   * offset; the *scene* owns world position and facing, on the rig group above.
   */
  readonly group = new THREE.Group();
  /** Bones indexed by {@link BONE}. World matrices are refreshed by `update`. */
  readonly bones: THREE.Object3D[] = [];
  /**
   * Per-bone inverse of the bind-pose world matrix. `bone.matrixWorld *
   * bindInverse[i] * p` skins a bind-pose point `p` into world space -- the one
   * operation the cloth's reference pose needs.
   */
  readonly bindInverse: THREE.Matrix4[] = [];
  readonly colliders: CapsuleSet;
  readonly jump = new JumpMotion();

  private readonly f: FigureMetrics;
  private readonly capsuleDefs: readonly CapsuleDef[];
  /** Body meshes and their bind-pose local positions, for a live size change. */
  private readonly pelvis: THREE.Object3D;
  private readonly chest: THREE.Object3D;
  private readonly chestBaseY: number;

  private phase = 0;
  private clock = 0;
  private scale = 1;
  private air = 0; // eased 0..1 airborne blend
  private state: GaitState = 'idle';
  private readonly sLean = new Spring(0, 2.6);
  private readonly sBank = new Spring(0, 2.4);
  private readonly sMove = new Spring(0, 3.2);
  private readonly sRun = new Spring(0, 2.2);

  constructor(f: FigureMetrics = FIGURE, dress: BodyDresser = dressRobe) {
    this.f = f;
    const { pelvis, chest } = this.buildSkeleton(f);
    this.pelvis = pelvis;
    this.chest = chest;
    this.chestBaseY = chest.position.y;
    dress(this.bones, f);

    // Capture the bind pose *before* anything animates it. Everything the cloth
    // is cut to assumes this exact rest configuration.
    this.group.updateMatrixWorld(true);
    for (const bone of this.bones) this.bindInverse.push(bone.matrixWorld.clone().invert());

    this.capsuleDefs = buildCapsuleDefs(f);
    this.colliders = new CapsuleSet(this.capsuleDefs.length);
  }

  /** The figure's current locomotion state, for the sandbox status line. */
  get gaitState(): GaitState {
    return this.state;
  }

  /** Normalised stride phase (0..1), for the debug readout. */
  get stridePhase(): number {
    return this.phase;
  }

  /** Height above the ground contributed by the hop, in world units. */
  get liftY(): number {
    return this.jump.y * this.scale;
  }

  // --- construction -------------------------------------------------------

  /**
   * Build the bone hierarchy in its rest pose. Bones are plain `Object3D`s
   * rather than a `THREE.Skeleton`: the visible body is a handful of rigid
   * blocks parented to them (no vertex skinning needed), and the cloth does its
   * own skinning from `matrixWorld`, so a skinned-mesh pipeline would be pure
   * overhead.
   */
  private buildSkeleton(f: FigureMetrics): { pelvis: THREE.Object3D; chest: THREE.Object3D } {
    // Parented in layout order, which lists every parent before its children.
    for (const rest of boneRestLayout(f)) {
      const bone = new THREE.Object3D();
      bone.position.set(rest.x, rest.y, rest.z);
      const parent = rest.parent < 0 ? this.group : this.bones[rest.parent];
      if (!parent) throw new Error(`bone ${rest.bone} has no parent ${rest.parent}`);
      parent.add(bone);
      this.bones[rest.bone] = bone;
    }
    if (this.bones.length !== BONE_COUNT) {
      throw new Error(`skeleton built ${this.bones.length} bones, expected ${BONE_COUNT}`);
    }
    return {
      pelvis: this.bones[BONE.pelvis] as THREE.Object3D,
      chest: this.bones[BONE.chest] as THREE.Object3D,
    };
  }


  // --- per-frame ----------------------------------------------------------

  /**
   * Pose the figure for this frame and refresh its world matrices and colliders.
   * `dt` is render time (the debug view slows it down); `gait` is what the rig
   * observed of the character's motion.
   */
  update(dt: number, gait: GaitInput, t: FigureTuning): void {
    const h = clamp(dt, 0, 0.1);
    this.clock += h;
    this.scale = t.bodyScale;
    this.group.scale.setScalar(this.scale);

    this.jump.update(h, GRAVITY * Math.max(0.05, t.gravityMultiplier));

    const speed = Math.max(0, gait.speed);
    // Two independent blends: "is it moving at all" and "how close to a run".
    this.sMove.track(smoothstep(IDLE_SPEED, WALK_SPEED, speed), h);
    this.sRun.track(smoothstep(WALK_SPEED, RUN_SPEED, speed), h);
    const move = clamp(this.sMove.value, 0, 1);
    const run = clamp(this.sRun.value, 0, 1);
    this.air += ((this.jump.airborne ? 1 : 0) - this.air) * Math.min(1, h * 9);

    // Stride phase advances with distance covered, not with time, so the feet
    // stay in step with the ground at any speed and through slow motion.
    const strideCycle = Math.max(1e-3, lerp(STRIDE_WALK, STRIDE_RUN, run) * t.strideScale * this.scale);
    this.phase = (this.phase + Math.max(0, gait.distance) / strideCycle) % 1;
    const p = this.phase * TWO_PI;

    this.sLean.track(clamp(gait.accel * LEAN_PER_ACCEL, -LEAN_MAX, LEAN_MAX) + run * 0.11, h);
    this.sBank.track(clamp(-gait.turnRate * BANK_PER_TURN, -BANK_MAX, BANK_MAX), h);

    this.poseLegs(p, move, run);
    this.poseArms(p, move, run, t);
    this.poseTorso(p, move, run);
    this.state = this.classify(speed, gait.turnRate);

    this.group.updateMatrixWorld(true);
    this.refreshColliders(t);
  }

  /**
   * Legs: a sine hip swing with the knee bending through the swing phase, the
   * ankle counter-rotating to keep the sole roughly flat, all blended toward a
   * tuck while airborne and deepened by the landing crouch.
   */
  private poseLegs(p: number, move: number, run: number): void {
    const hipAmp = lerp(HIP_SWING_WALK, HIP_SWING_RUN, run) * move;
    const kneeAmp = lerp(KNEE_BEND_WALK, KNEE_BEND_RUN, run) * move;
    // A landing crouch bends both knees together; so does standing still, very
    // slightly, so the figure never reads as a mannequin on straight legs.
    const crouch = this.jump.crouch;
    const idleBend = 0.06 * (1 - move);

    const legs: readonly [number, number, number][] = [
      [BONE.thighL, BONE.shinL, 0],
      [BONE.thighR, BONE.shinR, Math.PI],
    ];
    for (const [thighIdx, shinIdx, offset] of legs) {
      const a = p + offset;
      let hip = Math.sin(a) * hipAmp;
      // Knee peaks at mid-swing (cos(a) == 1) and keeps a little bend in stance.
      let knee = kneeAmp * (0.12 + 0.88 * Math.max(0, Math.cos(a))) + idleBend;

      // Airborne: legs gather under the body rather than continuing to stride.
      hip = lerp(hip, 0.34, this.air);
      knee = lerp(knee, 0.95, this.air);
      // Landing: absorb through the knees.
      knee += crouch * 0.85;
      hip += crouch * 0.25;

      const thigh = this.bones[thighIdx] as THREE.Object3D;
      const shin = this.bones[shinIdx] as THREE.Object3D;
      thigh.rotation.z = hip;
      shin.rotation.z = -knee;
    }
  }

  /**
   * Arms: swung opposite the legs, always slightly bent at the elbow and splayed
   * off the ribs so the sleeves have somewhere to hang. These bones are what the
   * sleeves are pinned to, so their swing *is* the sleeve motion.
   */
  private poseArms(p: number, move: number, run: number, t: FigureTuning): void {
    const amp = t.armSwing * lerp(0.55, 1, run) * move;
    const arms: readonly [number, number, number, number][] = [
      [BONE.upperArmL, BONE.forearmL, 0, 1],
      [BONE.upperArmR, BONE.forearmR, Math.PI, -1],
    ];
    for (const [upperIdx, foreIdx, offset, side] of arms) {
      const a = p + offset;
      // Opposite the same-side leg: the left arm goes back as the left leg comes
      // forward, which is what stops a walk looking like a march.
      let swing = -Math.sin(a) * amp;
      let elbow = 0.22 + 0.3 * amp * (0.5 + 0.5 * Math.sin(a));
      // Airborne, the arms come up and in.
      swing = lerp(swing, 0.55, this.air);
      elbow = lerp(elbow, 0.75, this.air);
      elbow += this.jump.crouch * 0.4;

      const upper = this.bones[upperIdx] as THREE.Object3D;
      const fore = this.bones[foreIdx] as THREE.Object3D;
      upper.rotation.z = swing;
      // Splay outward: away from the ribs, so the sleeve is not born inside the
      // torso capsule (which would push it out with a visible pop on frame one).
      upper.rotation.x = side * (0.14 + 0.05 * move);
      fore.rotation.z = -elbow;
    }
  }

  /**
   * Torso: vertical bob, hip roll and the counter-twist between pelvis and
   * chest, plus the lean into acceleration, the bank into a turn, the hop's
   * lift, the landing crouch and idle breathing. Everything the hood and cape
   * hang from moves here, so this is where most of their secondary motion
   * originates.
   */
  private poseTorso(p: number, move: number, run: number): void {
    const bob = BOB_AMP * lerp(0.35, 1, run) * move;
    const crouch = this.jump.crouch;
    // Two dips per stride cycle: the body is lowest at each mid-stance.
    const bobY = -bob * (0.5 - 0.5 * Math.cos(2 * p));
    const breath = Math.sin(this.clock * TWO_PI * BREATH_HZ) * BREATH_AMP * (1 - move);

    this.pelvis.position.y = this.f.hipY + bobY + breath - crouch * CROUCH_DROP;
    this.pelvis.rotation.x = Math.sin(p) * PELVIS_ROLL * move + this.sBank.value * 0.4;
    this.pelvis.rotation.y = Math.sin(p) * PELVIS_YAW * move;
    this.pelvis.rotation.z = -this.sLean.value * 0.45;

    // The chest counter-twists against the pelvis, carries most of the lean, and
    // rises and falls a little with the breath.
    this.chest.position.y = this.chestBaseY + breath * 0.6;
    this.chest.rotation.x = this.sBank.value * 0.6;
    this.chest.rotation.y = -Math.sin(p) * PELVIS_YAW * 1.15 * move;
    this.chest.rotation.z = -this.sLean.value * 0.55 - crouch * 0.18;

    // The hop lifts the whole figure; the scene still owns x/z.
    this.group.position.y = this.jump.y;
  }

  private classify(speed: number, turnRate: number): GaitState {
    if (this.jump.airborne) return 'airborne';
    if (this.jump.crouch > 0.05) return 'landing';
    if (speed < IDLE_SPEED) return Math.abs(turnRate) > 1.2 ? 'turning' : 'idle';
    return speed > WALK_SPEED * 2.2 ? 'running' : 'walking';
  }

  /**
   * Rewrite the collision capsules from the bones' current world matrices. Must
   * run after `updateMatrixWorld`; called from `update`, and exposed only because
   * the debug overlay wants to draw exactly what the solver tested against.
   */
  refreshColliders(t: FigureTuning): void {
    const scale = Math.max(0, t.bodyScale);
    for (let i = 0; i < this.capsuleDefs.length; i++) {
      const d = this.capsuleDefs[i] as CapsuleDef;
      const bone = this.bones[d.bone] as THREE.Object3D;
      _a.set(d.ax, d.ay, d.az).applyMatrix4(bone.matrixWorld);
      _b.set(d.bx, d.by, d.bz).applyMatrix4(bone.matrixWorld);
      this.colliders.set(i, _a.x, _a.y, _a.z, _b.x, _b.y, _b.z, d.radius * scale, d.mask);
    }
  }

  /** Trigger the cosmetic hop. Returns false if it is already off the ground. */
  triggerJump(t: FigureTuning): boolean {
    return this.jump.trigger(t.jumpHeight, GRAVITY * Math.max(0.05, t.gravityMultiplier));
  }

  /** Drop the figure from `height` so a long fall can be watched. */
  triggerDrop(height: number): boolean {
    return this.jump.drop(height);
  }
}

/**
 * The hooded robe's body (spec 046): the parts of the figure that are tight to
 * it and gain nothing from being simulated. Everything that hangs loose -- hood,
 * cape, lower robe, sleeves -- is cloth instead, and is added separately by
 * `RobeRig`. Deliberately minimal and faceless: the brief was a robe simulation,
 * not a character.
 *
 * This is `Humanoid`'s default {@link BodyDresser}, and the reference for what a
 * dresser does: parent meshes to bones, move nothing.
 */
export const dressRobe: BodyDresser = (bones, f) => {
  const at = (index: number): THREE.Object3D => bones[index] as THREE.Object3D;
  // Every solid part has to fit *inside* where the cloth is pushed to
  // (capsule radius + collisionRadius), or it pokes through its own garment.
  // `SOLID_INSET` is the slack that guarantees it.
  const torso = new THREE.Mesh(
    new THREE.CylinderGeometry(f.torsoRadius + SOLID_INSET, f.torsoRadius + SOLID_INSET - 0.4, 22, 8, 1, false),
    flatMaterial(PALETTE.robeCloth),
  );
  torso.position.y = f.waistY + 11 - f.chestY;
  at(BONE.chest).add(torso);

  // A raised collar, not a flared mantle: anything wider than the torso
  // capsule would stand outside the cape and the hood that cover it.
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(f.torsoRadius - 0.8, f.torsoRadius + SOLID_INSET, 10, 8, 1, true),
    flatMaterial(PALETTE.robeDeep),
  );
  collar.position.y = f.shoulderY - 1 - f.chestY;
  at(BONE.chest).add(collar);

  // The head is a dark void: no face, and it reads as shadow inside the hood.
  const head = faceted(f.headRadius - SOLID_INSET, PALETTE.robeVoid);
  head.scale.set(0.95, 1.12, 0.95);
  head.position.y = f.headY - f.neckY;
  at(BONE.head).add(head);

  // Limbs: thin blocks, almost entirely hidden by the sleeves and lower robe,
  // but they stop a gap opening up if the cloth swings wide.
  const limb = (bone: number, len: number, w: number, color: number): void => {
    const m = box(w, len, w, color);
    m.position.y = -len / 2;
    at(bone).add(m);
  };
  for (const [upper, fore] of [
    [BONE.upperArmL, BONE.forearmL],
    [BONE.upperArmR, BONE.forearmR],
  ] as const) {
    limb(upper, f.upperArmLen, f.upperArmRadius * 1.4, PALETTE.robeDeep);
    limb(fore, f.forearmLen, f.forearmRadius * 1.4, PALETTE.robeDeep);
    const hand = box(4.5, 5, 4, PALETTE.robeVoid);
    hand.position.y = -f.forearmLen - 1.5;
    at(fore).add(hand);
  }
  for (const [thigh, shin] of [
    [BONE.thighL, BONE.shinL],
    [BONE.thighR, BONE.shinR],
  ] as const) {
    limb(thigh, f.thighLen, f.thighRadius * 1.4, PALETTE.robeVoid);
    limb(shin, f.shinLen, f.shinRadius * 1.4, PALETTE.robeVoid);
    const boot = box(10, 4.5, 6.5, PALETTE.robeDeep);
    boot.position.set(1.5, -f.shinLen - 1.2, 0);
    at(shin).add(boot);
  }
};
