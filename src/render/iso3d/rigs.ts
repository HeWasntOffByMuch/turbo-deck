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
  private readonly foot: THREE.Mesh;
  private readonly restAzimuth: THREE.Vector3;

  constructor(
    rest: { x: number; z: number },
    legColor: number,
    private readonly coxaLen: number,
    private readonly femurLen: number,
    private readonly tibiaLen: number,
    group: THREE.Group,
  ) {
    this.coxa = box(6, 1, 6, darken(legColor, 0.85));
    this.femur = box(5.5, 1, 5.5, legColor);
    this.tibia = box(4, 1, 4, legColor);
    this.foot = box(9, 3.5, 12, darken(legColor, 0.7));
    group.add(this.coxa, this.femur, this.tibia, this.foot);
    // Fallback outward direction when the foot sits directly under the hip.
    this.restAzimuth = new THREE.Vector3(rest.x, 0, rest.z).normalize();
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
    orientSegment(this.tibia, _knee, _target);
    this.foot.position.copy(_target);
  }
}

// Body/leg proportions of the mech (world units). A small cube body on four wide
// spider legs; tuned so the resting stance has slack before a leg oversteps.
const HIP_Y = 30; // hip height on the chassis corner (before body offsets)
const HIP_INSET = 11; // corner offset from the body centre
const REST_X = 34; // rest foot fore/aft under the body
const REST_Z = 42; // rest foot lateral under the body
const COXA_LEN = 12;
const FEMUR_LEN = 26;
const TIBIA_LEN = 34;
const BODY_Y = 40;
const BODY_SIZE = 22;

// Gait tuning. A foot may drift `STEP_TRIGGER` from rest before it re-plants; a
// step leads ahead in the travel direction (more when running), arcs up
// (`_HEIGHT`), and lasts `_DUR` seconds (shorter contact when running). At most
// `MAX_STEPPING` legs are airborne, and never two from opposite diagonal pairs,
// so a supporting diagonal always stays planted (alternating-tetrapod gait).
const STEP_TRIGGER = 20;
const STEP_LEAD_WALK = 14;
const STEP_LEAD_RUN = 30;
const STEP_HEIGHT_WALK = 12;
const STEP_HEIGHT_RUN = 22;
const STEP_DUR_WALK = 0.19;
const STEP_DUR_RUN = 0.1;
const MAX_STEPPING = 2;
const COUPLE_SLACK = 8; // a leg pulls its diagonal partner along if it is within this of triggering
const TURN_STEP_BIAS = 0.5; // inside legs shorten / outside lengthen their lead when turning
const PLACE_JITTER = 5; // per-step foot-placement noise (world units)

// Locomotion-state thresholds, all derived from the observed world transform.
const IDLE_SPEED = 5; // below this (units/s) the mech is standing
const WALK_SPEED = 30; // walk baseline where the run blend starts
const RUN_SPEED = 110; // full-run speed
const DECEL_STOP = 160; // decel (units/s^2) sharper than this reads as stopping
const TURN_RATE = 1.3; // yaw rate (rad/s) above which the mech reads as turning

// Body stabilisation tuning (spring targets).
const COM_SHIFT = 0.16; // fraction of the support-centroid offset the body leans toward
const BOB_AMP = 3.5; // vertical bob amplitude at full run
const HEIGHT_RUN_CROUCH = 6; // lower centre of gravity when running
const AIRBORNE_DIP = 1.6; // body dips per airborne leg (weight over fewer feet)
const LAND_IMPULSE = 2.2; // downward settle added when a foot plants
const PITCH_ACCEL = 0.0016; // rad of pitch per unit/s^2 of acceleration
const ROLL_TURN = 0.09; // rad of bank per rad/s of yaw
const BREATH_AMP = 1.3; // idle breathing vertical amplitude
const STRIDE_LEN = 46; // world distance per gait half-cycle (drives bob phase)

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
  /** The corner offset (fore/aft, lateral) of this leg's rest spot in local space. */
  readonly rest: { readonly x: number; readonly z: number };
  /** Lateral side sign (from `rest.z`) for inside/outside turn-step biasing. */
  readonly side: number;
  /** A stable per-leg seed so its noise (timing/placement/knee) differs from the others. */
  readonly seed: number;
  /** Where the foot is currently planted, in world (x, z). */
  world: { x: number; z: number };
  /** Foot height above ground: 0 when planted, arced up mid-step. */
  y: number;
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
export class MechRig {
  readonly group = new THREE.Group();
  private readonly chassis = new THREE.Group();
  private readonly legs: readonly MechLeg[];
  private readonly plants: readonly LegPlant[];
  private prev: { x: number; z: number } | null = null;
  private prevRy = 0;
  private moveDir = { x: 0, z: 0 };

  // Smoothed observed motion and the body-offset springs it drives.
  private speed = 0;
  private accel = 0;
  private yawRate = 0;
  private clock = 0;
  private phase = 0; // gait phase (accumulated stride distance / STRIDE_LEN)
  private landImpulse = 0;
  private state: LocomotionState = 'idle';
  private readonly sHeight = new Spring(0, 3.2);
  private readonly sSwayX = new Spring(0, 3);
  private readonly sSwayZ = new Spring(0, 3);
  private readonly sPitch = new Spring(0, 4.5);
  private readonly sRoll = new Spring(0, 4);
  private readonly sYaw = new Spring(0, 5);

  constructor(type: string, bodyColorOverride?: number) {
    const bodyColor = bodyColorOverride ?? enemyColor(type);
    const legColor = darken(bodyColor, 0.55);

    // The chassis is offset by the body springs; the rig group holds world pose.
    this.group.add(this.chassis);
    const body = box(BODY_SIZE, BODY_SIZE, BODY_SIZE, bodyColor);
    body.position.y = BODY_Y;
    this.chassis.add(body);
    const plate = box(BODY_SIZE - 6, 4, BODY_SIZE - 6, darken(bodyColor, 0.8));
    plate.position.y = BODY_Y + BODY_SIZE / 2 + 1;
    this.chassis.add(plate);
    const head = box(10, 9, 12, bodyColor);
    head.position.set(BODY_SIZE / 2 + 3, BODY_Y - 1, 0);
    this.chassis.add(head);
    const eye = box(3, 5, 10, PALETTE.enemyEye);
    eye.position.set(BODY_SIZE / 2 + 8, BODY_Y, 0);
    this.chassis.add(eye);

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
      world: { x: 0, z: 0 },
      y: 0,
      stepping: false,
      from: { x: 0, z: 0 },
      to: { x: 0, z: 0 },
      t: 0,
      dur: STEP_DUR_WALK,
      arcH: STEP_HEIGHT_WALK,
    }));
  }

  /** The mech's current locomotion state, for HUDs (e.g. the movement sandbox). */
  get locomotionState(): LocomotionState {
    return this.state;
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

    if (this.prev === null) {
      // First frame: drop every foot onto its rest spot so nothing snaps.
      for (const leg of this.plants) {
        const r = localToWorldXZ(leg.rest.x, leg.rest.z, ry);
        leg.world = { x: wx + r.x, z: wz + r.z };
      }
      this.prev = { x: wx, z: wz };
      this.prevRy = ry;
    }

    // Observed motion, smoothed. Travel direction is kept from the last real move.
    const dx = wx - this.prev.x;
    const dz = wz - this.prev.z;
    const moved = Math.hypot(dx, dz);
    if (moved > 0.05) this.moveDir = { x: dx / moved, z: dz / moved };
    this.prev = { x: wx, z: wz };
    const rawSpeed = moved / dt;
    const prevSpeed = this.speed;
    const kSpeed = Math.min(1, dt * 8);
    this.speed += (rawSpeed - this.speed) * kSpeed;
    const rawAccel = (this.speed - prevSpeed) / dt;
    this.accel += (rawAccel - this.accel) * Math.min(1, dt * 6);
    const rawYaw = angleDelta(ry, this.prevRy) / dt;
    this.prevRy = ry;
    this.yawRate += (rawYaw - this.yawRate) * Math.min(1, dt * 6);
    this.phase += (this.speed * dt) / STRIDE_LEN;

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

    this.stepLegs(dt, wx, wz, ry, run01, turnBias);
    this.stabilise(dt, wx, wz, ry, run01);
  }

  /** Decide which legs re-plant this frame and advance any in-progress steps. */
  private stepLegs(dt: number, wx: number, wz: number, ry: number, run01: number, turnBias: number): void {
    // Rest world position and overstretch for every leg (used for triggering + coupling).
    const info = this.plants.map((leg) => {
      const r = localToWorldXZ(leg.rest.x, leg.rest.z, ry);
      const restX = wx + r.x;
      const restZ = wz + r.z;
      // Per-leg timing jitter: a wandering trigger radius so legs never fire in lockstep.
      const jitter = (vnoise(leg.seed, this.clock * 0.6) - 0.5) * 6;
      const over = Math.hypot(leg.world.x - restX, leg.world.z - restZ) - (STEP_TRIGGER + jitter);
      return { restX, restZ, over };
    });

    let stepping = this.plants.reduce((n, l) => n + (l.stepping ? 1 : 0), 0);
    // Only one diagonal pair may be airborne at a time; find it if any.
    let activePair = -1;
    this.plants.forEach((l, i) => {
      if (l.stepping) activePair = PAIR_OF[i] ?? -1;
    });

    const ranked = info
      .map((e, i) => ({ i, ...e }))
      .filter((e) => {
        const leg = this.plants[e.i];
        return leg !== undefined && !leg.stepping && e.over > 0;
      })
      .sort((a, b) => b.over - a.over);

    for (const e of ranked) {
      if (stepping >= MAX_STEPPING) break;
      const pair = PAIR_OF[e.i] ?? 0;
      if (activePair !== -1 && pair !== activePair) continue; // keep the opposite diagonal planted
      const leg = this.plants[e.i];
      if (!leg || leg.stepping) continue;
      this.beginStep(leg, e.restX, e.restZ, run01, turnBias);
      activePair = pair;
      stepping++;
      // Pull the diagonal partner along if it is nearly ready, for a trot-like pair.
      const j = PARTNER_OF[e.i] ?? e.i;
      const partner = this.plants[j];
      const pInfo = info[j];
      if (partner && pInfo && !partner.stepping && stepping < MAX_STEPPING && pInfo.over > -COUPLE_SLACK) {
        this.beginStep(partner, pInfo.restX, pInfo.restZ, run01, turnBias);
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
        this.landImpulse += LAND_IMPULSE; // weight settles onto the fresh plant
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

  /** Start a step for `leg`: pick a lead point ahead of rest, with turn + noise. */
  private beginStep(leg: LegPlant, restX: number, restZ: number, run01: number, turnBias: number): void {
    const lead = lerp(STEP_LEAD_WALK, STEP_LEAD_RUN, run01) * (1 + turnBias * leg.side * TURN_STEP_BIAS);
    // Foot-placement variation: a little along and across the travel direction.
    const along = (vnoise(leg.seed + 7, this.clock) - 0.5) * PLACE_JITTER;
    const across = (vnoise(leg.seed + 31, this.clock) - 0.5) * PLACE_JITTER;
    const px = -this.moveDir.z; // travel-perpendicular (ground plane)
    const pz = this.moveDir.x;
    leg.from = { x: leg.world.x, z: leg.world.z };
    leg.to = {
      x: restX + this.moveDir.x * (lead + along) + px * across,
      z: restZ + this.moveDir.z * (lead + along) + pz * across,
    };
    leg.t = 0;
    leg.stepping = true;
    leg.dur = lerp(STEP_DUR_WALK, STEP_DUR_RUN, run01) * (0.9 + vnoise(leg.seed + 3, this.clock) * 0.2);
    leg.arcH = lerp(STEP_HEIGHT_WALK, STEP_HEIGHT_RUN, run01) * (0.85 + vnoise(leg.seed + 5, this.clock) * 0.3);
  }

  /** Stabilise the chassis with springs off the planted-feet centroid, then pose legs. */
  private stabilise(dt: number, wx: number, wz: number, ry: number, run01: number): void {
    // Center-of-mass estimate: the centroid of the grounded feet, in rig space.
    let cx = 0;
    let cz = 0;
    let grounded = 0;
    let airborne = 0;
    for (const leg of this.plants) {
      if (leg.stepping) {
        airborne++;
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
    const breath = idle01 * BREATH_AMP * Math.sin(this.clock * 1.8);
    const bob = -BOB_AMP * run01 * (0.5 + 0.5 * Math.sin(this.phase * TWO_PI));

    // Stiffen the whole suspension when running (stronger body stabilisation).
    const stiffen = 1 + run01 * 0.8;
    this.sHeight.setFreq(3.2 * stiffen);
    this.sPitch.setFreq(4.5 * stiffen);
    this.sRoll.setFreq(4 * stiffen);

    // Lean the body toward its support, dip over airborne legs / at speed, bob, breathe.
    this.sSwayX.track(cx * COM_SHIFT, dt);
    this.sSwayZ.track(cz * COM_SHIFT, dt);
    this.sHeight.track(bob + breath - HEIGHT_RUN_CROUCH * run01 - AIRBORNE_DIP * airborne - this.landImpulse, dt);
    // Pitch nose-down under acceleration, nose-up when braking; bank into a turn.
    this.sPitch.track(clamp(this.accel * PITCH_ACCEL, -0.22, 0.22), dt);
    this.sRoll.track(clamp(this.yawRate * ROLL_TURN, -0.2, 0.2) + cz * 0.0015, dt);
    this.sYaw.track(clamp(-this.yawRate * 0.03, -0.12, 0.12), dt);

    this.chassis.position.set(this.sSwayX.value, this.sHeight.value, this.sSwayZ.value);
    this.chassis.rotation.set(this.sRoll.value, this.sYaw.value, -this.sPitch.value);
    this.chassis.updateMatrix();

    // Draw each leg between its (chassis-borne) hip and its (world-locked) foot.
    this.legs.forEach((leg, i) => {
      const p = this.plants[i];
      if (!p) return;
      const sx = Math.sign(p.rest.x);
      const sz = p.side;
      _hip.set(sx * HIP_INSET, HIP_Y, sz * HIP_INSET).applyMatrix4(this.chassis.matrix);
      const local = worldToLocalXZ(p.world.x - wx, p.world.z - wz, ry);
      _foot.set(local.x, p.y, local.z);
      const kneeSway = (vnoise(p.seed + 11, this.clock * 0.8) - 0.5) * 0.22;
      leg.pose(_hip, _foot, kneeSway);
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
