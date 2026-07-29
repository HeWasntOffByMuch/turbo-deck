import * as THREE from 'three';
import type { Vec2 } from '../../sim/types.js';
import { PALETTE, enemyColor } from './palette.js';
import { box, cone, darken, faceted, flatMaterial, makeHeadingArrow } from './meshes.js';

/**
 * Animated unit rigs for the isometric scene (spec 031). Each rig owns a
 * three.js group built facing +x and an `update` that poses its moving parts
 * from how far the unit travelled this frame -- the scene handles world position
 * and facing. Purely cosmetic: nothing here reads or changes sim state.
 */

const TWO_PI = Math.PI * 2;
/** Ease a value toward a target by a frame-rate-independent factor. */
function approach(current: number, target: number, dt: number, rate: number): number {
  return current + (target - current) * Math.min(1, dt * rate);
}

/**
 * The bird hero: a navy body with a pale beak, two flapping wings, and two feet
 * that step as it walks. Built facing +x; the scene rotates the group to the
 * sim's heading and drives `update` with the frame's travel distance.
 */
export class PlayerRig {
  readonly group = new THREE.Group();
  private readonly leftWing = new THREE.Group();
  private readonly rightWing = new THREE.Group();
  private readonly leftFoot: THREE.Mesh;
  private readonly rightFoot: THREE.Mesh;
  private stride = 0;
  private amp = 0;
  private clock = 0;
  /** Lateral half-spread of the feet, so the scene can place poofs under them. */
  static readonly FOOT_SPREAD = 7;
  /** World distance travelled per full two-step stride cycle. */
  static readonly STRIDE = 40;

  constructor() {
    const body = faceted(16, PALETTE.heroBody);
    body.scale.set(1.05, 0.95, 1.25);
    body.position.y = 20;
    this.group.add(body);

    const beak = cone(4, 10, PALETTE.heroBeak, 5);
    beak.rotation.z = -Math.PI / 2;
    beak.position.set(16, 21, 0);
    this.group.add(beak);
    const eye = faceted(2.4, PALETTE.enemyEye, 0);
    eye.position.set(12, 25, -4);
    this.group.add(eye);

    // Wings pivot at the shoulders so a flap raises the far tip.
    const wingGeo = new THREE.BoxGeometry(12, 3, 16);
    for (const [pivot, side] of [
      [this.leftWing, -1],
      [this.rightWing, 1],
    ] as const) {
      pivot.position.set(0, 21, side * 8);
      const wing = new THREE.Mesh(wingGeo, flatMaterial(PALETTE.heroWing));
      wing.position.set(-1, 0, side * 9); // extends outward from the shoulder
      pivot.add(wing);
      this.group.add(pivot);
    }

    this.leftFoot = box(6, 4, 7, PALETTE.heroBeak);
    this.rightFoot = box(6, 4, 7, PALETTE.heroBeak);
    this.leftFoot.position.set(0, 3, -PlayerRig.FOOT_SPREAD);
    this.rightFoot.position.set(0, 3, PlayerRig.FOOT_SPREAD);
    this.group.add(this.leftFoot, this.rightFoot);

    this.group.add(makeHeadingArrow()); // inherits the unit's facing
  }

  update(dt: number, distanceMoved: number): void {
    this.clock += dt;
    this.stride += distanceMoved;
    this.amp = approach(this.amp, distanceMoved > 0.03 ? 1 : 0, dt, 9);

    // Wings: a gentle idle bob that broadens into a flap while moving.
    const flap = 0.12 + this.amp * (0.35 + 0.35 * Math.sin(this.clock * 14));
    this.leftWing.rotation.x = flap;
    this.rightWing.rotation.x = -flap;

    // Feet: alternate lift + fore/aft swing, easing flat when standing still.
    const phase = (this.stride / PlayerRig.STRIDE) * TWO_PI;
    this.poseFoot(this.leftFoot, phase);
    this.poseFoot(this.rightFoot, phase + Math.PI);
  }

  private poseFoot(foot: THREE.Mesh, phase: number): void {
    foot.position.x = Math.cos(phase) * 5 * this.amp;
    foot.position.y = 3 + Math.max(0, Math.sin(phase)) * 6 * this.amp;
  }
}

// Scratch vectors reused by the IK solve so posing a leg allocates nothing.
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _target = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _foot = new THREE.Vector3();
const _hip = new THREE.Vector3();
const _shoulder = new THREE.Vector3();
const _horiz = new THREE.Vector3();
const _side = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * A critically damped spring, in closed form. Given a target each frame it eases
 * `value` toward it while carrying velocity, so body offsets (bob, sway, pitch,
 * roll, height) settle smoothly and never snap. The analytic solution is
 * unconditionally stable for any `dt` -- no sub-stepping, no blow-up at low
 * frame rates -- which matters because the render loop's `dt` is variable. Pure
 * numeric helper (no three.js, no sim state); unit-tested in `rigs-spring.test.ts`.
 */
export class Spring {
  private vel = 0;
  constructor(
    public value = 0,
    private freq = 4,
  ) {}

  /** Retune stiffness (natural frequency in Hz); higher = snappier settling. */
  setFreq(freq: number): void {
    this.freq = freq;
  }

  /** Advance one step of `dt` seconds toward `target`. */
  track(target: number, dt: number): void {
    const omega = TWO_PI * this.freq;
    const c1 = this.value - target;
    const c2 = this.vel + omega * c1;
    const e = Math.exp(-omega * dt);
    this.value = target + (c1 + c2 * dt) * e;
    this.vel = (c2 - omega * (c1 + c2 * dt)) * e;
  }
}

/** Hash a 32-bit integer to a well-mixed value in [0, 1). Deterministic, no state. */
function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Smooth value noise in [0, 1) along `t`, per `seed`. Hashed lattice points with
 * smoothstep interpolation -- a cheap continuous wiggle used for the mech's
 * per-leg micro-motion (step-timing, foot-placement, joint-angle variation), so
 * no two legs move identically and a standing mech is never perfectly still.
 */
function vnoise(seed: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(seed * 374761393 + i);
  const b = hash01(seed * 374761393 + i + 1);
  return a + (b - a) * u;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear blend from `a` to `b` by `t`. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest signed difference between two angles, in (-pi, pi]. */
function angleDelta(to: number, from: number): number {
  let d = (to - from) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

/** Lay a unit-height box between two points: scale its length, aim its +Y at the segment. */
function orientSegment(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3): void {
  _seg.copy(to).sub(from);
  const len = _seg.length() || 1e-4;
  _mid.copy(from).add(to).multiplyScalar(0.5);
  mesh.position.copy(_mid);
  mesh.scale.y = len;
  mesh.quaternion.setFromUnitVectors(Y_AXIS, _seg.multiplyScalar(1 / len));
}

/**
 * One multi-joint spider leg: a **coxa** (hip) segment that yaws horizontally out
 * of the body corner toward the foot's azimuth, a **femur** rising from that
 * shoulder up-and-out to a raised knee, and a **tibia** dropping from the knee
 * down to the planted foot. The femur/tibia are posed by a 2-bone IK solve with
 * an up-pointing pole, so the knee always bows upward like a spider's. That gives
 * four independently posed parts -- coxa rotation, femur lift, tibia extension,
 * foot placement -- rather than a bare two-bone chain. The rig owns where the
 * foot is planted and where the (moving) hip sits; this class only draws the leg
 * reaching between them, with a small knee sway for joint-angle variation.
 */
class MechLeg {
  private readonly coxa: THREE.Mesh;
  private readonly femur: THREE.Mesh;
  private readonly tibia: THREE.Mesh;
  private readonly restAzimuth: THREE.Vector3;
  // Segment lengths in effect this frame (base length x the rig's size scale).
  private coxaLen: number;
  private femurLen: number;
  private tibiaLen: number;

  constructor(
    rest: { x: number; z: number },
    legColor: number,
    private readonly baseCoxa: number,
    private readonly baseFemur: number,
    private readonly baseTibia: number,
    group: THREE.Group,
  ) {
    this.coxa = box(6, 1, 6, darken(legColor, 0.85));
    this.femur = box(5.5, 1, 5.5, legColor);
    // The shin tapers to a point -- a spider's tarsus tip -- instead of a blocky
    // foot. It is a thin cone whose apex (its +Y) is aimed at the foot target by
    // orientSegment, so the leg ends in a sharp point on the ground.
    this.tibia = cone(2.6, 1, darken(legColor, 0.9), 5);
    group.add(this.coxa, this.femur, this.tibia);
    this.coxaLen = baseCoxa;
    this.femurLen = baseFemur;
    this.tibiaLen = baseTibia;
    // Fallback outward direction when the foot sits directly under the hip.
    this.restAzimuth = new THREE.Vector3(rest.x, 0, rest.z).normalize();
  }

  /**
   * Resize the leg to the rig's size scale: lengthen the bones (the IK reads the
   * new lengths) and thicken their cross-section to match. Called only when the
   * size changes, not every frame.
   */
  setScale(s: number): void {
    this.coxaLen = this.baseCoxa * s;
    this.femurLen = this.baseFemur * s;
    this.tibiaLen = this.baseTibia * s;
    for (const m of [this.coxa, this.femur, this.tibia]) {
      // orientSegment writes scale.y (length) each frame; x/z (thickness) persist.
      m.scale.x = s;
      m.scale.z = s;
    }
  }

  /**
   * Pose the leg so its foot sits at `foot` and its hip at `hip` (both rig-local),
   * knee bowed upward. `kneeSway` tilts the knee a touch sideways for organic
   * joint variation. The coxa aims horizontally toward the foot; the IK solves
   * from the coxa's shoulder, so the body-corner joint visibly rotates.
   */
  pose(hip: THREE.Vector3, foot: THREE.Vector3, kneeSway: number): void {
    // Coxa: a short, level segment aimed out toward the foot's ground azimuth.
    _horiz.set(foot.x - hip.x, 0, foot.z - hip.z);
    if (_horiz.lengthSq() < 1e-6) _horiz.copy(this.restAzimuth);
    else _horiz.normalize();
    _shoulder.copy(hip).addScaledVector(_horiz, this.coxaLen);
    _shoulder.y = hip.y;
    orientSegment(this.coxa, hip, _shoulder);

    // Femur + tibia: 2-bone IK from the shoulder to the foot, knee on the up side.
    _target.copy(foot);
    _dir.copy(_target).sub(_shoulder);
    let d = _dir.length() || 1e-4;
    const maxReach = this.femurLen + this.tibiaLen - 1e-3;
    if (d > maxReach) {
      // Beyond reach the bones straighten; pull the target in so the solve holds.
      _dir.multiplyScalar(maxReach / d);
      _target.copy(_shoulder).add(_dir);
      d = maxReach;
    }
    _dir.multiplyScalar(1 / d); // shoulder -> foot unit direction
    const a = (this.femurLen * this.femurLen - this.tibiaLen * this.tibiaLen + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, this.femurLen * this.femurLen - a * a));
    _pole.copy(UP).addScaledVector(_dir, -UP.dot(_dir)); // up, perpendicular to the chord
    if (_pole.lengthSq() < 1e-6) _pole.set(0, 0, 1); // vertical chord: any perpendicular
    _pole.normalize();
    // Nudge the knee sideways for joint-angle variation (a horizontal side vector).
    _side.crossVectors(_dir, UP);
    if (_side.lengthSq() > 1e-6) _pole.addScaledVector(_side.normalize(), kneeSway).normalize();
    _knee.copy(_shoulder).addScaledVector(_dir, a).addScaledVector(_pole, h);

    orientSegment(this.femur, _shoulder, _knee);
    orientSegment(this.tibia, _knee, _target); // cone apex lands on the foot point
  }
}

// Base body/leg proportions of the mech at size scale 1 (world units). A small
// cube body on four wide spider legs; the resting stance keeps slack before a
// leg oversteps, and `tuning.sizeScale` multiplies all of these live.
const HIP_Y = 30; // hip height on the chassis corner (before body offsets)
const HIP_INSET = 11; // corner offset from the body centre
const REST_X = 34; // rest foot fore/aft under the body
const REST_Z = 42; // rest foot lateral under the body
const COXA_LEN = 12;
const FEMUR_LEN = 27;
const TIBIA_LEN = 36;
const BODY_Y = 40;
const BODY_SIZE = 22;

// Fixed feel constants (not exposed as sliders).
const COUPLE_SLACK = 8; // a leg pulls its diagonal partner along if within this of triggering
const PLACE_JITTER = 4; // per-step foot-placement noise (world units, x size)
const STEP_COOLDOWN = 0.05; // min seconds a foot rests after a plant before it may step again
// A foot must stay in its own quadrant relative to the body: front feet ahead of
// MIN_FORE, back feet behind it, and each on its own side past MIN_LAT. A planted
// foot that crosses these lines (e.g. left stranded behind the hip during a turn)
// is forced to step, and fresh plants are clamped inside them -- so a leg never
// reaches across or behind the body to a stranded foot.
const MIN_FORE = 12; // min |fore/aft| offset of a foot from body centre (x size)
const MIN_LAT = 14; // min |lateral| offset of a foot from body centre (x size)
// A leg may lift into a "recovery" hold (like a spider briefly holding a leg up)
// instead of every leg scrambling to touch down. The held foot stays over its
// rest spot and is only *slightly* raised -- not tucked in toward the body -- and
// the hold ends on a timeout, when a supporting foot is overstretched, when
// support would drop below two feet, or when the mech settles. `tuning.raisedLegs`
// caps how many legs may be held (0 disables it, 1 allows a single raised leg).
const HOLD_TUCK_FORE = 1.0; // keep the held foot at its rest fore/aft (no tuck-in)
const HOLD_TUCK_LAT = 1.0; // keep the held foot at its rest lateral (no tuck-in)
const HOLD_HEIGHT = 9; // held foot height above ground -- only slightly raised (x size)
const HOLD_COOLDOWN = 0.45; // min seconds between holds
const HOLD_SECURE_STRETCH = 1.15; // a plant out of a hold is a touch slower (deliberate)
// A supporting foot this far past its trigger ends the hold so the gait gets its
// swing capacity back. Kept generous so a held leg visibly *stays* raised through
// a turn (support is already guaranteed: only one other leg may swing while held).
const HOLD_EXIT_OVER = 26; // x size
const HEIGHT_RUN_CROUCH = 6; // lower centre of gravity when running
const AIRBORNE_DIP = 1.6; // body dips per airborne leg (weight over fewer feet)
const LAND_IMPULSE = 2.0; // downward settle added when a foot plants
const BREATH_AMP = 1.3; // idle breathing vertical amplitude
const STRIDE_LEN = 48; // world distance per gait half-cycle (drives bob phase)

// Locomotion-state thresholds, derived from the observed world transform.
const IDLE_SPEED = 5; // below this (units/s) the mech is standing
const WALK_SPEED = 30; // walk baseline where the run blend starts
const RUN_SPEED = 110; // full-run speed
const DECEL_STOP = 160; // decel (units/s^2) sharper than this reads as stopping
const TURN_RATE = 1.3; // yaw rate (rad/s) above which the mech reads as turning
// Body-yaw controller: the rendered body yaw is a spring+inertia system pulled
// toward the authoritative heading, nudged by leg step torque. Natural frequency
// and damping interpolate with `yawLag` (softer + more overshoot at higher lag),
// and the trailing angle is hard-capped so the body never falls too far behind.
const YAW_FREQ_MIN = 6.5; // rad/s at yawLag = 1 (soft, laggy)
const YAW_FREQ_MAX = 13; // rad/s at yawLag = 0 (stiff, near-rigid)
const YAW_ZETA_MIN = 0.6; // damping ratio at yawLag = 1 (a little overshoot)
const YAW_ZETA_MAX = 0.9; // damping ratio at yawLag = 0
const YAW_MAX_LAG_MIN = 0.16; // rad cap at yawLag = 0
const YAW_MAX_LAG_MAX = 0.5; // rad cap at yawLag = 1
const YAW_TORQUE_GAIN = 0.9; // how strongly leg steps torque the body yaw

/** 2D cross product (z of a x b) -- signed turning of b about a, in the ground plane. */
function cross2(ax: number, az: number, bx: number, bz: number): number {
  return ax * bz - az * bx;
}

/**
 * Live-editable movement/appearance constants for a mech, tuned in the movement
 * sandbox. Distances are in world units at size scale 1 and scale with
 * `sizeScale`; `moveSpeed`/`turnRate` are sim inputs the sandbox feeds to the
 * combat step (the rig itself never reads them). Mutating a field takes effect on
 * the next frame -- there is one shared object per mech.
 */
export interface MechTuning {
  /** Overall creature size; scales every leg/body dimension and step distance. */
  sizeScale: number;
  /** Sim: base move speed (world units/s, before the engine clamp of 100..550). */
  moveSpeed: number;
  /** Sim: turn rate (degrees/s). */
  turnRate: number;
  /** How far a foot may drift from its rest spot before the leg re-plants. */
  stepTrigger: number;
  /** How far ahead of rest a step plants, walking / running. */
  stepLeadWalk: number;
  stepLeadRun: number;
  /** Peak foot-arc height of a step, walking / running. */
  stepHeightWalk: number;
  stepHeightRun: number;
  /** Swing/contact time of a step in seconds, walking / running (lower = quicker). */
  stepDurWalk: number;
  stepDurRun: number;
  /** Max legs airborne at once (1 = careful, 2 = a diagonal trot). */
  maxStepping: number;
  /** Max legs that may lift into a slightly-raised "recovery" hold (0 or 1). */
  raisedLegs: number;
  /** How hard inside legs shorten / outside legs lengthen their step when turning. */
  turnStepBias: number;
  /**
   * Body-yaw lag (0..1): how much the body *trails* its heading in a turn. The
   * legs re-home to the true heading first; the body yaw is then driven toward it
   * by a spring+inertia controller (plus a nudge from leg step torque), so 0 is
   * near-rigid tracking and 1 leans into the turn and settles afterwards.
   */
  yawLag: number;
  /**
   * Foot-placement prediction (0..1): how far a step anticipates the turn, planting
   * where the body *will* be facing when the foot lands rather than where it is now.
   */
  stepPredict: number;
  /** Fraction of the support centroid the body leans toward (center-of-mass shift). */
  comShift: number;
  /** Vertical body-bob amplitude at full run. */
  bobAmp: number;
  /** Pitch gain: radians of nose-dip per unit/s^2 of acceleration. */
  pitchGain: number;
  /** Roll gain: radians of bank per rad/s of turn. */
  rollGain: number;
  /** Sideways knee-sway amplitude (organic joint variation). */
  kneeSway: number;
  /**
   * Foot-follow rate: how fast the drawn foot may chase its target (1/s). Higher
   * snaps tighter to the gait; lower moves the limbs more slowly and smooths out
   * any twitch. This is the "restrict how fast a limb can move" knob.
   */
  footSmooth: number;
}

/** The default mech tuning; the sandbox clones this and edits the copy. */
export function defaultMechTuning(): MechTuning {
  return {
    sizeScale: 1,
    moveSpeed: 147.5,
    turnRate: 180,
    stepTrigger: 16,
    stepLeadWalk: 14,
    stepLeadRun: 30,
    stepHeightWalk: 12,
    stepHeightRun: 20,
    stepDurWalk: 0.2,
    stepDurRun: 0.13,
    maxStepping: 2,
    raisedLegs: 1,
    turnStepBias: 0.5,
    yawLag: 0.55,
    stepPredict: 0.6,
    comShift: 0.16,
    bobAmp: 3.5,
    pitchGain: 0.0016,
    rollGain: 0.09,
    kneeSway: 0.1,
    footSmooth: 26,
  };
}

/** Rotate a local (x, z) offset by the group's yaw into a world offset. */
function localToWorldXZ(lx: number, lz: number, ry: number): { x: number; z: number } {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  return { x: lx * c + lz * s, z: -lx * s + lz * c };
}

/** Inverse of {@link localToWorldXZ}: a world offset back into the body's local frame. */
function worldToLocalXZ(wx: number, wz: number, ry: number): { x: number; z: number } {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  return { x: wx * c - wz * s, z: wx * s + wz * c };
}

/** The mech's current gait, chosen from observed speed / accel / turn rate. */
export type LocomotionState = 'idle' | 'walking' | 'running' | 'turning' | 'stopping';

/** Per-leg ground-lock bookkeeping: the planted foot and any step in progress. */
interface LegPlant {
  /** The corner offset (fore/aft, lateral) of this leg's rest spot, at size scale 1. */
  readonly rest: { readonly x: number; readonly z: number };
  /** Lateral side sign (from `rest.z`) for inside/outside turn-step biasing. */
  readonly side: number;
  /** A stable per-leg seed so its noise (timing/placement/knee) differs from the others. */
  readonly seed: number;
  /** A fixed per-leg trigger offset (breaks lockstep without per-frame flicker). */
  readonly triggerOffset: number;
  /** The logical foot plant, in world (x, z): where the leg is anchored. */
  world: { x: number; z: number };
  /** Logical foot height above ground: 0 when planted, arced up mid-step. */
  y: number;
  /** The drawn foot, slew-limited toward the logical one so motion never snaps. */
  disp: { x: number; z: number };
  dispY: number;
  /** Smoothed knee-sway angle, eased toward its noise target. */
  kneeCur: number;
  /** Seconds until this foot is allowed to step again (hysteresis after a plant). */
  cooldown: number;
  /** Raised-and-tucked "recovery" leg: lifted close to the body, not a support point. */
  held: boolean;
  /** How long this leg has been held, and the hold's (noised) max duration. */
  holdT: number;
  holdMax: number;
  stepping: boolean;
  from: { x: number; z: number };
  to: { x: number; z: number };
  /** Step progress 0..1, and this step's (noised) duration and arc height. */
  t: number;
  dur: number;
  arcH: number;
}

/** The two diagonal support pairs: FL+BR share pair 0, FR+BL share pair 1. */
const PAIR_OF = [0, 1, 1, 0] as const;
const PARTNER_OF = [3, 2, 1, 0] as const;

/**
 * A four-legged mech that walks like a living alien spider. A small cube body
 * (an inner chassis that bobs, sways, pitches and banks) rides four multi-joint
 * legs whose feet lock to the ground: each foot stays put in the world while the
 * body carries over it, and when a foot stretches too far from its rest spot the
 * leg detaches and steps to a fresh plant led in the travel direction, arcing up
 * and back down. Steps run as an alternating-tetrapod gait -- one supporting
 * diagonal always planted -- with per-leg noise so nothing is symmetric. The
 * chassis is stabilised by critically damped springs off a center-of-mass
 * estimate (the planted-feet centroid), and the whole feel shifts across
 * idle / walking / running / turning / stopping picked from observed motion.
 *
 * All of it is cosmetic: driven purely by the observed world transform (position
 * + yaw), never by reading or writing sim state. Body colour keys off the enemy
 * type unless an explicit colour is given (e.g. the movement sandbox's ally mech).
 */
export interface MechOptions {
  /**
   * When false, the lower body (leg platform) does NOT turn to the heading: the
   * legs plant in a world-fixed frame and only the upper body (turret) rotates to
   * face -- a grey-mech look. When true (default) the whole unit turns like a
   * spider. All the leg mechanics are otherwise identical.
   */
  readonly lowerBodyTurns?: boolean;
  /** Share an external tuning object (so two units can be tuned together). */
  readonly tuning?: MechTuning;
}

export class MechRig {
  readonly group = new THREE.Group();
  /** Live-editable movement/appearance constants (the sandbox mutates this). */
  readonly tuning: MechTuning;
  /** Whether the scene should set group.rotation.y to the heading (spider) or 0 (mech). */
  readonly orientsWithGroupYaw: boolean;
  private readonly lowerBodyTurns: boolean;
  // The lower body (carriage) carries the hips in the leg frame; the upper body
  // (turret) holds the visible body and yaws to face the heading.
  private readonly carriage = new THREE.Group();
  private readonly turret = new THREE.Group();
  private readonly legs: readonly MechLeg[];
  private readonly plants: readonly LegPlant[];
  // Body meshes + their base (scale-1) positions, so a size change can resize them.
  private readonly bodyParts: { readonly mesh: THREE.Mesh; readonly base: THREE.Vector3 }[] = [];
  private appliedScale = -1; // last size applied to the meshes/bones (forces a first pass)
  private scale = 1; // size scale in effect this frame
  private prev: { x: number; z: number } | null = null;
  private prevRy = 0;
  // The leg frame's turn rate this frame (0 for a mech whose base doesn't turn) and
  // the unit-length travel direction expressed in the leg frame (drives step lead).
  private legYawRate = 0;
  private leadDir = { x: 1, z: 0 };

  // Smoothed observed motion and the body-offset springs it drives.
  private speed = 0;
  private accel = 0;
  private yawRate = 0;
  private clock = 0;
  private phase = 0; // gait phase (accumulated stride distance / STRIDE_LEN)
  private landImpulse = 0;
  private holdCooldown = 0; // seconds until another leg may enter a raised hold
  private state: LocomotionState = 'idle';
  // The rendered body yaw (world heading space) and its angular velocity: the body
  // follows its heading through this controller instead of snapping to it.
  private bodyRy = 0;
  private bodyAngVel = 0;
  private readonly sHeight = new Spring(0, 3.2);
  private readonly sSwayX = new Spring(0, 3);
  private readonly sSwayZ = new Spring(0, 3);
  private readonly sPitch = new Spring(0, 4.5);
  private readonly sRoll = new Spring(0, 4);

  constructor(type: string, bodyColorOverride?: number, opts: MechOptions = {}) {
    const bodyColor = bodyColorOverride ?? enemyColor(type);
    const legColor = darken(bodyColor, 0.55);
    this.tuning = opts.tuning ?? defaultMechTuning();
    this.lowerBodyTurns = opts.lowerBodyTurns ?? true;
    this.orientsWithGroupYaw = this.lowerBodyTurns;

    // group -> carriage (lower body, leg frame) -> turret (upper body, faces heading).
    this.group.add(this.carriage);
    this.carriage.add(this.turret);
    const body = box(BODY_SIZE, BODY_SIZE, BODY_SIZE, bodyColor);
    body.position.y = BODY_Y;
    const plate = box(BODY_SIZE - 6, 4, BODY_SIZE - 6, darken(bodyColor, 0.8));
    plate.position.y = BODY_Y + BODY_SIZE / 2 + 1;
    const head = box(10, 9, 12, bodyColor);
    head.position.set(BODY_SIZE / 2 + 3, BODY_Y - 1, 0);
    const eye = box(3, 5, 10, PALETTE.enemyEye);
    eye.position.set(BODY_SIZE / 2 + 8, BODY_Y, 0);
    for (const mesh of [body, plate, head, eye]) {
      this.turret.add(mesh);
      this.bodyParts.push({ mesh, base: mesh.position.clone() });
    }

    // Four corner legs: sx picks front/back, sz picks left/right.
    const corners: readonly [number, number][] = [
      [1, -1], // front-left  (pair 0)
      [1, 1], // front-right (pair 1)
      [-1, -1], // back-left   (pair 1)
      [-1, 1], // back-right  (pair 0)
    ];
    this.legs = corners.map(
      ([sx, sz]) => new MechLeg({ x: sx * REST_X, z: sz * REST_Z }, legColor, COXA_LEN, FEMUR_LEN, TIBIA_LEN, this.group),
    );
    this.plants = corners.map(([sx, sz], i) => ({
      rest: { x: sx * REST_X, z: sz * REST_Z },
      side: Math.sign(sz),
      seed: i * 1013 + 17,
      triggerOffset: (hash01(i * 1013 + 17) - 0.5) * 5,
      world: { x: 0, z: 0 },
      y: 0,
      disp: { x: 0, z: 0 },
      dispY: 0,
      kneeCur: 0,
      cooldown: 0,
      held: false,
      holdT: 0,
      holdMax: 0.7,
      stepping: false,
      from: { x: 0, z: 0 },
      to: { x: 0, z: 0 },
      t: 0,
      dur: this.tuning.stepDurWalk,
      arcH: this.tuning.stepHeightWalk,
    }));
  }

  /** The mech's current locomotion state, for HUDs (e.g. the movement sandbox). */
  get locomotionState(): LocomotionState {
    return this.state;
  }

  /** Resize the body meshes and leg bones to `s` (only when the size actually changes). */
  private applyScale(s: number): void {
    this.appliedScale = s;
    for (const leg of this.legs) leg.setScale(s);
    for (const part of this.bodyParts) {
      part.mesh.position.copy(part.base).multiplyScalar(s);
      part.mesh.scale.setScalar(s);
    }
  }

  /**
   * Pose the mech from the body's world position and yaw (`ry` = the group's
   * `rotation.y`, the same value the scene sets to face the unit). Feet stay
   * planted in the world; overstretched legs step to a fresh plant ahead; the
   * chassis is stabilised by springs off the planted-feet centroid; and the
   * whole feel is chosen from the observed speed, acceleration and turn rate.
   */
  update(dt: number, worldPos: Vec2, ry: number): void {
    const wx = worldPos.x;
    const wz = worldPos.y; // sim's (x, y) plane maps to the world floor (x, z)
    dt = Math.max(1e-4, dt);
    this.clock += dt;
    this.scale = Math.max(0.2, this.tuning.sizeScale);
    if (this.scale !== this.appliedScale) this.applyScale(this.scale);
    const S = this.scale;

    // The leg frame follows the heading for a spider, but stays world-fixed for a
    // mech (only its turret turns). `leadDir` is the travel/facing direction
    // expressed in that frame, so steps always lead the way the body is going.
    const legRy = this.lowerBodyTurns ? ry : 0;
    this.leadDir = worldToLocalXZ(Math.cos(ry), -Math.sin(ry), legRy);

    if (this.prev === null) {
      // First frame: drop every foot onto its rest spot so nothing snaps.
      for (const leg of this.plants) {
        const r = localToWorldXZ(leg.rest.x * S, leg.rest.z * S, legRy);
        leg.world = { x: wx + r.x, z: wz + r.z };
        leg.disp = { x: leg.world.x, z: leg.world.z };
      }
      this.prev = { x: wx, z: wz };
      this.prevRy = ry;
      this.bodyRy = ry;
    }

    // Observed motion, smoothed. Steps lead along the body's facing (below), not
    // the raw travel vector, so a stale direction can't fling a foot in a turn.
    const moved = Math.hypot(wx - this.prev.x, wz - this.prev.z);
    this.prev = { x: wx, z: wz };
    const rawSpeed = moved / dt;
    const prevSpeed = this.speed;
    this.speed += (rawSpeed - this.speed) * Math.min(1, dt * 8);
    const rawAccel = (this.speed - prevSpeed) / dt;
    this.accel += (rawAccel - this.accel) * Math.min(1, dt * 6);
    const rawYaw = angleDelta(ry, this.prevRy) / dt;
    this.prevRy = ry;
    this.yawRate += (rawYaw - this.yawRate) * Math.min(1, dt * 6);
    this.legYawRate = this.lowerBodyTurns ? this.yawRate : 0; // the leg frame's turn rate
    this.phase += (this.speed * dt) / (STRIDE_LEN * S);

    // Speed-derived gait: a continuous walk->run blend + a discrete state label.
    const run01 = clamp((this.speed - WALK_SPEED) / (RUN_SPEED - WALK_SPEED), 0, 1);
    // A hard pivot reads as turning even when barely translating (the MOBA
    // turn-in-place before travel); otherwise the label follows speed/accel.
    const turning = Math.abs(this.yawRate) > TURN_RATE && this.speed < RUN_SPEED;
    if (turning) this.state = 'turning';
    else if (this.speed < IDLE_SPEED) this.state = 'idle';
    else if (this.accel < -DECEL_STOP && this.speed < RUN_SPEED * 0.8) this.state = 'stopping';
    else if (this.speed > RUN_SPEED * 0.82) this.state = 'running';
    else this.state = 'walking';
    const turnBias = clamp(this.yawRate / TURN_RATE, -1, 1);

    this.stepLegs(dt, wx, wz, legRy, run01, turnBias);
    this.stabilise(dt, wx, wz, legRy, ry, run01);
  }

  /** Decide which legs re-plant this frame and advance any in-progress steps. `ry` is the leg frame. */
  private stepLegs(dt: number, wx: number, wz: number, ry: number, run01: number, turnBias: number): void {
    const S = this.scale;
    // During a turn the world-locked feet fall behind the yaw, so step a little
    // more eagerly (a smaller trigger radius) to help them track the body.
    const turnMag = Math.abs(turnBias);
    const trigScale = 1 - 0.25 * turnMag;
    this.holdCooldown = Math.max(0, this.holdCooldown - dt);
    for (const leg of this.plants) {
      leg.cooldown = Math.max(0, leg.cooldown - dt);
      if (leg.held) leg.holdT += dt;
    }

    // Rest world position and overstretch for every planted leg (a held or
    // swinging leg is not a step candidate, so its `over` is -Infinity). The
    // trigger radius carries a fixed per-leg offset (no per-frame flicker) so legs
    // break lockstep without chattering; `over` also spikes when the planted foot
    // leaves its quadrant (crosses behind its hip or over the centreline mid-turn),
    // so the leg re-homes before it can reach across the body.
    const info = this.plants.map((leg) => {
      const r = localToWorldXZ(leg.rest.x * S, leg.rest.z * S, ry);
      const restX = wx + r.x;
      const restZ = wz + r.z;
      if (leg.stepping || leg.held) return { restX, restZ, over: -Infinity };
      // Inside legs (on the side the mech is turning toward) step more often: a
      // smaller trigger radius, so they take shorter, quicker strides while the
      // outside legs take longer ones -- the differential that drives the turn.
      const inside = clamp(-leg.side * turnBias, 0, 1);
      const trig = (this.tuning.stepTrigger + leg.triggerOffset) * S * trigScale * (1 - 0.22 * inside);
      const radial = Math.hypot(leg.world.x - restX, leg.world.z - restZ) - trig;
      // Foot in the body's local frame: how far it has crossed its quadrant lines.
      const lf = worldToLocalXZ(leg.world.x - wx, leg.world.z - wz, ry);
      const fore = Math.sign(leg.rest.x);
      const foreViol = MIN_FORE * S - fore * lf.x; // >0 when the foot is behind its fore line
      const latViol = MIN_LAT * S - leg.side * lf.z; // >0 when the foot crosses the centreline
      const over = Math.max(radial, foreViol, latViol);
      return { restX, restZ, over };
    });

    // Raised-leg recovery: maybe lift one leg and tuck it, or plant a held one.
    this.manageHold(wx, wz, ry, run01, turnBias, info);

    let stepping = this.plants.reduce((n, l) => n + (l.stepping ? 1 : 0), 0);
    const heldCount = this.plants.reduce((n, l) => n + (l.held ? 1 : 0), 0);
    // While a leg is held only one other may swing, so at least two feet stay down.
    const cap = heldCount > 0 ? 1 : Math.round(clamp(this.tuning.maxStepping, 1, 2));
    // Only one diagonal pair may be airborne at a time; find it if any.
    let activePair = -1;
    this.plants.forEach((l, i) => {
      if (l.stepping) activePair = PAIR_OF[i] ?? -1;
    });

    const ranked = info
      .map((e, i) => ({ i, ...e }))
      .filter((e) => {
        const leg = this.plants[e.i];
        return leg !== undefined && !leg.stepping && !leg.held && leg.cooldown <= 0 && e.over > 0;
      })
      .sort((a, b) => b.over - a.over);

    for (const e of ranked) {
      if (stepping >= cap) break;
      const pair = PAIR_OF[e.i] ?? 0;
      if (activePair !== -1 && pair !== activePair) continue; // keep the opposite diagonal planted
      const leg = this.plants[e.i];
      if (!leg || leg.stepping) continue;
      this.beginStep(leg, wx, wz, ry, run01, turnBias);
      activePair = pair;
      stepping++;
      // Pull the diagonal partner along if it is nearly ready, for a trot-like pair.
      const j = PARTNER_OF[e.i] ?? e.i;
      const partner = this.plants[j];
      const pInfo = info[j];
      if (partner && pInfo && !partner.stepping && partner.cooldown <= 0 && stepping < cap && pInfo.over > -COUPLE_SLACK * S) {
        this.beginStep(partner, wx, wz, ry, run01, turnBias);
        stepping++;
      }
    }

    // Advance in-progress steps: anticipate, arc up and forward, decelerate to plant.
    for (const leg of this.plants) {
      if (!leg.stepping) continue;
      leg.t += dt / leg.dur;
      if (leg.t >= 1) {
        leg.world = { x: leg.to.x, z: leg.to.z };
        leg.y = 0;
        leg.stepping = false;
        leg.cooldown = STEP_COOLDOWN; // must rest a beat before stepping again
        this.landImpulse += LAND_IMPULSE * S; // weight settles onto the fresh plant
      } else {
        const t = leg.t;
        // Horizontal: hold briefly (anticipation lift), then smootherstep to the plant,
        // so travel starts after the foot has broken contact and eases in on landing.
        const h = clamp((t - 0.12) / 0.88, 0, 1);
        const e = h * h * h * (h * (h * 6 - 15) + 10);
        leg.world = {
          x: leg.from.x + (leg.to.x - leg.from.x) * e,
          z: leg.from.z + (leg.to.z - leg.from.z) * e,
        };
        // Vertical: a skewed arc that peaks a touch before mid-step (a quick lift).
        leg.y = Math.sin(Math.pow(t, 0.7) * Math.PI) * leg.arcH;
      }
    }
  }

  /**
   * The raised-leg ("recovery") behaviour: at most one leg lifts and tucks close
   * to the body instead of every leg scrambling to touch down. A held leg is not a
   * support point; it rides tucked under the moving body and only plants -- a
   * deliberate, secure step -- when its support is genuinely required: the hold
   * times out, a supporting foot gets badly overstretched (so the gait needs the
   * capacity back), support would otherwise drop below two feet, or the mech
   * settles. A hold is only *started* from a fully-planted, stable stance while the
   * mech is actually moving or turning, lifting whichever leg has the most slack.
   */
  private manageHold(
    wx: number,
    wz: number,
    ry: number,
    run01: number,
    turnBias: number,
    info: readonly { readonly over: number }[],
  ): void {
    const S = this.scale;
    const allowHold = Math.round(clamp(this.tuning.raisedLegs, 0, 1)) >= 1;
    const heldIdx = this.plants.findIndex((l) => l.held);
    const stepping = this.plants.reduce((n, l) => n + (l.stepping ? 1 : 0), 0);
    const planted = this.plants.reduce((n, l) => n + (!l.stepping && !l.held ? 1 : 0), 0);
    const maxOver = info.reduce((m, e) => Math.max(m, e.over), -Infinity);

    if (heldIdx >= 0) {
      const hleg = this.plants[heldIdx];
      if (!hleg) return;
      // Keep the held foot over its rest spot, only slightly raised (no tuck-in).
      const rest = localToWorldXZ(hleg.rest.x * S * HOLD_TUCK_FORE, hleg.rest.z * S * HOLD_TUCK_LAT, ry);
      hleg.world = { x: wx + rest.x, z: wz + rest.z };
      hleg.y = HOLD_HEIGHT * S;
      const settling = this.speed < IDLE_SPEED && Math.abs(this.yawRate) < TURN_RATE * 0.3;
      const needed = !allowHold || hleg.holdT > hleg.holdMax || maxOver > HOLD_EXIT_OVER * S || planted < 2 || settling;
      if (needed) {
        // Secure plant: swing down from the tuck to a fresh, solid foothold ahead.
        hleg.held = false;
        this.beginStep(hleg, wx, wz, ry, run01, turnBias);
        hleg.dur *= HOLD_SECURE_STRETCH;
        this.holdCooldown = HOLD_COOLDOWN;
      }
      return;
    }

    // Enter a hold only from a stable, fully-planted stance while in motion.
    const moving = this.speed > IDLE_SPEED || Math.abs(this.yawRate) > TURN_RATE * 0.25;
    if (!allowHold || this.holdCooldown > 0 || stepping > 0 || planted < 4 || run01 > 0.9 || !moving) return;
    let best = -1;
    let bestOver = Infinity;
    info.forEach((e, i) => {
      if (e.over < bestOver) {
        bestOver = e.over;
        best = i;
      }
    });
    const leg = best >= 0 ? this.plants[best] : undefined;
    if (leg) {
      leg.held = true;
      leg.holdT = 0;
      leg.holdMax = 0.7 + vnoise(leg.seed + 13, this.clock) * 0.7;
    }
  }

  /**
   * Start a step for `leg`. The plant is computed in the body's local frame,
   * around the leg's (rotating) rest point and led *forward along the body's
   * facing* -- not along the last travel direction, which goes stale in a turn
   * and used to fling the foot sideways/backward. The target is then clamped into
   * the leg's own quadrant, so a front leg can never plant behind the body nor a
   * left leg across to the right. Shorter, quicker steps while turning let the
   * feet re-home fast enough to keep up with the yaw.
   */
  private beginStep(leg: LegPlant, wx: number, wz: number, ry: number, run01: number, turnBias: number): void {
    const S = this.scale;
    const t = this.tuning;
    const turnHaste = 1 - 0.35 * Math.abs(turnBias); // quicker steps mid-turn
    leg.dur = Math.max(0.09, lerp(t.stepDurWalk, t.stepDurRun, run01) * turnHaste * (0.92 + vnoise(leg.seed + 3, this.clock) * 0.16));
    // Forward lead ahead of rest, biased by the turn; never less than the ground
    // the body will cover during the swing, so the foot lands ahead of drift.
    const baseLead = lerp(t.stepLeadWalk, t.stepLeadRun, run01) * S * (1 + turnBias * leg.side * t.turnStepBias);
    const lead = Math.max(baseLead, this.speed * leg.dur * 0.75);
    const along = (vnoise(leg.seed + 7, this.clock) - 0.5) * PLACE_JITTER * S;
    const across = (vnoise(leg.seed + 31, this.clock) - 0.5) * PLACE_JITTER * S;
    // Lead along the travel direction expressed in the leg frame (`leadDir`), not
    // a fixed +x: for a spider that is the facing, for a mech it is whatever way it
    // is walking across its un-turning leg base. Jitter runs along/across it.
    const dx = this.leadDir.x;
    const dz = this.leadDir.z;
    let lx = leg.rest.x * S + dx * (lead + along) - dz * across;
    let lz = leg.rest.z * S + dz * (lead + along) + dx * across;
    // Clamp into the leg's quadrant so it stays in front of / behind and to the
    // side of the body it belongs to (never reaching across or behind the hip).
    const fore = Math.sign(leg.rest.x);
    lx = fore > 0 ? Math.max(lx, MIN_FORE * S) : Math.min(lx, -MIN_FORE * S);
    lz = leg.side > 0 ? Math.max(lz, MIN_LAT * S) : Math.min(lz, -MIN_LAT * S);
    // Placement prediction: the leg frame rotates at `legYawRate` (0 for a mech
    // whose base doesn't turn), so over the swing it turns by ~legYawRate*dur.
    // Convert the target through that future frame so the foot lands ahead.
    const predictRy = ry + this.legYawRate * leg.dur * t.stepPredict;
    const w = localToWorldXZ(lx, lz, predictRy);
    leg.from = { x: leg.world.x, z: leg.world.z };
    leg.to = { x: wx + w.x, z: wz + w.z };
    leg.t = 0;
    leg.stepping = true;
    leg.arcH = lerp(t.stepHeightWalk, t.stepHeightRun, run01) * S * (0.85 + vnoise(leg.seed + 5, this.clock) * 0.3);
  }

  /**
   * Advance the rendered body yaw toward the authoritative heading `ry` through a
   * spring+inertia controller nudged by leg step torque, and return the resulting
   * trailing angle (chassis yaw relative to the group). This is the "drive body
   * yaw through accumulated leg forces, not a direct transform" step: the legs
   * (posed in the leg frame) reach the new heading first and the body follows,
   * accelerating into the turn and settling after it -- never a rigid spin about
   * the centre. Returns the turret yaw relative to the leg frame (`legRy`): a small
   * trailing lag for a spider, or the full facing for a mech whose base is fixed.
   */
  private driveBodyYaw(dt: number, wx: number, wz: number, ry: number, legRy: number): number {
    const yawLag = clamp(this.tuning.yawLag, 0, 1);
    const omega = lerp(YAW_FREQ_MAX, YAW_FREQ_MIN, yawLag);
    const zeta = lerp(YAW_ZETA_MAX, YAW_ZETA_MIN, yawLag);
    const maxLag = lerp(YAW_MAX_LAG_MIN, YAW_MAX_LAG_MAX, yawLag);
    const stiff = omega * omega;
    const damp = 2 * zeta * omega;

    // Torque from the legs in motion: each swinging foot's step direction about the
    // body centre sums to a net turning force on the body (normalised per leg, so
    // an asymmetric/pivot step pattern nudges the yaw). The spring keeps it bounded.
    let torque = 0;
    for (const leg of this.plants) {
      if (!leg.stepping) continue;
      const rx = leg.world.x - wx;
      const rz = leg.world.z - wz;
      const rl = Math.hypot(rx, rz);
      const sx = leg.to.x - leg.from.x;
      const sz = leg.to.z - leg.from.z;
      const sl = Math.hypot(sx, sz);
      if (rl < 1e-3 || sl < 1e-3) continue;
      torque += cross2(rx / rl, rz / rl, sx / sl, sz / sl);
    }
    torque *= YAW_TORQUE_GAIN;
    const torqueCap = 0.5 * stiff * maxLag;
    torque = clamp(torque, -torqueCap, torqueCap);

    const err = angleDelta(ry, this.bodyRy); // heading minus current body yaw
    const angAccel = stiff * err - damp * this.bodyAngVel + torque;
    this.bodyAngVel = clamp(this.bodyAngVel + angAccel * dt, -14, 14);
    this.bodyRy += this.bodyAngVel * dt;

    // Hard-cap the trailing angle so the body never falls far behind its heading.
    const lag = angleDelta(this.bodyRy, ry); // body yaw minus heading (shortest)
    if (lag > maxLag) {
      this.bodyRy = ry + maxLag;
      if (this.bodyAngVel > 0) this.bodyAngVel *= 0.4;
    } else if (lag < -maxLag) {
      this.bodyRy = ry - maxLag;
      if (this.bodyAngVel < 0) this.bodyAngVel *= 0.4;
    }
    // Turret yaw relative to the leg frame: for a spider legRy == ry so this is the
    // small lag; for a mech legRy == 0 so this is the full facing (only it turns).
    return angleDelta(this.bodyRy, legRy);
  }

  /** Stabilise the chassis with springs off the planted-feet centroid, then pose legs. `ry` is the leg frame. */
  private stabilise(dt: number, wx: number, wz: number, ry: number, headingRy: number, run01: number): void {
    const S = this.scale;
    const t = this.tuning;
    const turretYaw = this.driveBodyYaw(dt, wx, wz, headingRy, ry);
    // Center-of-mass estimate: the centroid of the grounded feet, in rig space.
    let cx = 0;
    let cz = 0;
    let grounded = 0;
    let airborne = 0;
    for (const leg of this.plants) {
      if (leg.stepping || leg.held) {
        airborne++; // a swinging or tucked leg carries no weight
        continue;
      }
      const l = worldToLocalXZ(leg.world.x - wx, leg.world.z - wz, ry);
      cx += l.x;
      cz += l.z;
      grounded++;
    }
    if (grounded > 0) {
      cx /= grounded;
      cz /= grounded;
    }

    this.landImpulse *= Math.exp(-dt * 9); // settle decays away
    const idle01 = clamp(1 - this.speed / IDLE_SPEED, 0, 1);
    const breath = idle01 * BREATH_AMP * S * Math.sin(this.clock * 1.8);
    const bob = -t.bobAmp * S * run01 * (0.5 + 0.5 * Math.sin(this.phase * TWO_PI));

    // Stiffen the whole suspension when running (stronger body stabilisation).
    const stiffen = 1 + run01 * 0.8;
    this.sHeight.setFreq(3.2 * stiffen);
    this.sPitch.setFreq(4.5 * stiffen);
    this.sRoll.setFreq(4 * stiffen);

    // Lean the body toward its support, dip over airborne legs / at speed, bob, breathe.
    this.sSwayX.track(cx * t.comShift, dt);
    this.sSwayZ.track(cz * t.comShift, dt);
    this.sHeight.track(bob + breath - (HEIGHT_RUN_CROUCH * run01 + AIRBORNE_DIP * airborne) * S - this.landImpulse, dt);
    // Pitch nose-down under acceleration, nose-up when braking; bank into a turn.
    this.sPitch.track(clamp(this.accel * t.pitchGain, -0.22, 0.22), dt);
    this.sRoll.track(clamp(this.yawRate * t.rollGain, -0.2, 0.2) + cz * 0.0015, dt);

    // Lower body (carriage): bob/sway/height + roll/pitch, but NO facing yaw -- it
    // stays in the leg frame and carries the hips, so the legs never spin with the
    // turret. The upper body (turret) yaws to the heading relative to that frame.
    this.carriage.position.set(this.sSwayX.value, this.sHeight.value, this.sSwayZ.value);
    this.carriage.rotation.set(this.sRoll.value, 0, -this.sPitch.value);
    this.carriage.updateMatrix();
    this.turret.rotation.set(0, turretYaw, 0);

    // Draw each leg between its (chassis-borne) hip and its slew-limited foot. The
    // drawn foot chases the logical plant at a capped rate, so nothing snaps.
    const aFoot = 1 - Math.exp(-t.footSmooth * dt);
    const aFootY = 1 - Math.exp(-t.footSmooth * 1.5 * dt);
    const aKnee = Math.min(1, dt * 6);
    this.legs.forEach((leg, i) => {
      const p = this.plants[i];
      if (!p) return;
      p.disp.x += (p.world.x - p.disp.x) * aFoot;
      p.disp.z += (p.world.z - p.disp.z) * aFoot;
      p.dispY += (p.y - p.dispY) * aFootY;
      const sx = Math.sign(p.rest.x);
      const sz = p.side;
      _hip.set(sx * HIP_INSET * S, HIP_Y * S, sz * HIP_INSET * S).applyMatrix4(this.carriage.matrix);
      const local = worldToLocalXZ(p.disp.x - wx, p.disp.z - wz, ry);
      // Guarantee the *drawn* foot stays in the leg's quadrant even when a fast
      // yaw has left the world-locked plant lagging behind or across the body:
      // hold it at the quadrant boundary (a tiny slide) rather than render the leg
      // reaching behind or across the hip. Normal-gait feet are well inside this,
      // so the clamp only bites during the turn transient.
      const fx = sx > 0 ? Math.max(local.x, MIN_FORE * S) : Math.min(local.x, -MIN_FORE * S);
      const fz = sz > 0 ? Math.max(local.z, MIN_LAT * S) : Math.min(local.z, -MIN_LAT * S);
      _foot.set(fx, p.dispY, fz);
      const kneeTarget = (vnoise(p.seed + 11, this.clock * 0.5) - 0.5) * t.kneeSway;
      p.kneeCur += (kneeTarget - p.kneeCur) * aKnee;
      leg.pose(_hip, _foot, p.kneeCur);
    });
  }
}

// One shared puff geometry; only the material (opacity) differs per instance.
const PUFF_GEO = new THREE.IcosahedronGeometry(5, 0);

interface Poof {
  readonly group: THREE.Group;
  readonly mats: THREE.MeshBasicMaterial[];
  age: number;
}

/**
 * Little disappearing dust clouds kicked up where the hero's feet meet the
 * ground as it walks. Each poof is a small cluster of pale puffs that expands
 * and fades over its short life; the scene spawns one per footfall.
 */
export class Poofs {
  private readonly live: Poof[] = [];
  private static readonly LIFE = 0.42;

  constructor(private readonly scene: THREE.Scene) {}

  spawn(x: number, z: number): void {
    const group = new THREE.Group();
    group.position.set(x, 3, z);
    const mats: THREE.MeshBasicMaterial[] = [];
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: PALETTE.poof, transparent: true, opacity: 0.7, depthWrite: false });
      const puff = new THREE.Mesh(PUFF_GEO, mat);
      puff.position.set((i - 1) * 4, 0, (i % 2 === 0 ? 1 : -1) * 3);
      puff.scale.setScalar(0.5 + i * 0.15);
      group.add(puff);
      mats.push(mat);
    }
    this.scene.add(group);
    this.live.push({ group, mats, age: 0 });
  }

  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const poof = this.live[i];
      if (!poof) continue;
      poof.age += dt;
      const t = poof.age / Poofs.LIFE;
      if (t >= 1) {
        this.scene.remove(poof.group);
        for (const m of poof.mats) m.dispose();
        this.live.splice(i, 1);
        continue;
      }
      poof.group.scale.setScalar(1 + t * 1.8);
      poof.group.position.y = 3 + t * 6;
      for (const m of poof.mats) m.opacity = 0.7 * (1 - t);
    }
  }
}
