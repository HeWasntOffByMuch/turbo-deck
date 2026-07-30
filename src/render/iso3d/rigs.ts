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

/**
 * Clamp `v` to [lo, hi], but return `fallback` for a non-finite input (NaN/±∞).
 * Plain {@link clamp} passes NaN straight through (NaN comparisons are false),
 * which is exactly how a bad value reaches a mesh transform and flings a leg to
 * the ceiling or off to infinity; this is the sanitising version used at the
 * boundaries so no non-finite number ever survives into a pose.
 */
function sclamp(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return v < lo ? lo : v > hi ? hi : v;
}

/** `v` if finite, else `fallback`. */
function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** Linear blend from `a` to `b` by `t`. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Normalise an angle into (-pi, pi]. */
function angleWrap(a: number): number {
  return angleDelta(a, 0);
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
  // Bail on any non-finite endpoint rather than write NaN into the transform
  // (which would send the segment to the ceiling / infinity); keep the last pose.
  if (
    !Number.isFinite(from.x + from.y + from.z) ||
    !Number.isFinite(to.x + to.y + to.z)
  ) {
    return;
  }
  _seg.copy(to).sub(from);
  const len = _seg.length();
  if (!(len > 1e-4)) return; // zero-length or NaN: leave the mesh as it was
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
  // Last solved joints in the rig-group frame, recorded at the end of `pose` for
  // the debug overlay (spec 035). Not read by the rig's own rendering.
  readonly jHip = new THREE.Vector3();
  readonly jShoulder = new THREE.Vector3();
  readonly jKnee = new THREE.Vector3();
  readonly jFoot = new THREE.Vector3();
  // Segment lengths in effect this frame (base length x the rig's size scale).
  private coxaLen: number;
  private femurLen: number;
  private tibiaLen: number;

  constructor(
    legColor: number,
    private readonly baseCoxa: number,
    private readonly baseFemur: number,
    private readonly baseTibia: number,
    private readonly group: THREE.Group,
    /**
     * A stable, always-nonzero lateral sign for this leg. The coxa reaches out to
     * this side for the leg's whole life. It must be passed in rather than derived
     * from `rest.z`, because a leg resting on the centreline (dead ahead or behind,
     * which happens for odd leg counts) has `rest.z == 0` and would otherwise fall
     * back to `sign(foot.z - hip.z)` -- the flickering term that snapped the coxa
     * ~180 degrees across the body mid-turn (fixed once in ea59a2d).
     */
    private readonly latSign: number,
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
  }

  /**
   * Detach this leg's three bones from the rig group and release their geometries.
   * Required when the leg count changes: the bones are parented to the rig group,
   * so dropping the `MechLeg` reference alone leaves them in the scene forever,
   * frozen in their last pose (orientSegment only ever rewrites a live transform).
   */
  dispose(): void {
    for (const mesh of [this.coxa, this.femur, this.tibia]) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
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
   * joint variation. The coxa reaches out to the foot's side and swings its
   * shoulder fore/aft toward the foot (`coxaSwing`); the IK then solves the
   * femur/tibia from that shoulder, so the hip joint carries the whole leg.
   */
  pose(
    hip: THREE.Vector3,
    foot: THREE.Vector3,
    kneeSway: number,
    coxaScale: number,
    coxaSwing: number,
    femurScale: number,
  ): void {
    // Never solve from a non-finite hip/foot: leave the leg in its last good pose
    // rather than write NaN into the bones (which would fling them off-screen).
    if (
      !Number.isFinite(hip.x + hip.y + hip.z) ||
      !Number.isFinite(foot.x + foot.y + foot.z) ||
      !Number.isFinite(kneeSway)
    ) {
      return;
    }
    // Coxa (hip joint): the segment closest to the body. It reaches OUT to the
    // foot's side by `coxaLen * coxaScale` (the outward reach), and SWINGS
    // fore/aft by carrying its far end -- the "shoulder" the femur hangs from --
    // toward the foot's fore/aft by `coxaSwing`. So moving the hip joint moves the
    // whole leg with it: the femur/tibia keep their shape and the entire limb
    // pivots at the hip, reaching further toward (or back from) the target rather
    // than the knee absorbing the fore/aft. 0 keeps the coxa pointing straight out
    // to the side (all fore/aft motion lives in the knee); 1 carries the shoulder
    // level with the foot so the hip does all the protraction/retraction; >1
    // exaggerates the swing past the foot.
    // The coxa always reaches OUT to the leg's own fixed side (its rest azimuth),
    // never to whichever side the foot momentarily sits on. Feet are clamped to
    // their own quadrant so they never truly cross the centreline; but mid-turn a
    // world-locked foot drifts in toward its (moving, swaying) hip until its
    // lateral offset hovers around zero, and keying the shoulder side off
    // `sign(foot.z - hip.z)` then chatters -- snapping the coxa ~180deg inboard
    // across the body and back on a *planted* leg every time that sign flickers.
    // The leg's side is stable, so the hip segment stays outboard through the turn.
    // The leg's own fixed lateral side, passed in at construction and never derived
    // from the (moving) foot -- see the `latSign` constructor note.
    const latSign = this.latSign;
    // The coxa is a FIXED-LENGTH hip bone that YAWS toward the foot -- it must not
    // telescope. Its length is `coxaLen * coxaScale`; `coxaSwing` sets how far it
    // leans fore/aft toward the foot. Setting the shoulder's fore/aft directly to
    // `foot.x` instead let the bone STRETCH: in a turn the world-locked feet swing
    // wide, so `foot.x - hip.x` grew huge and the coxa ballooned to ~4x its length
    // (a rubber-band hip that flails, worst on the leg reaching furthest fore/aft).
    // Build the horizontal offset (fore/aft lean vs. lateral reach), then renormalise
    // it back to the fixed coxa length so the joint rotates rather than extends.
    const coxaReachLen = this.coxaLen * finiteOr(coxaScale, 1);
    const hasCoxa = coxaReachLen >= 1e-3;
    this.coxa.visible = hasCoxa;
    if (hasCoxa) {
      let ox = (foot.x - hip.x) * finiteOr(coxaSwing, 1); // fore/aft lean toward the foot
      let oz = latSign * coxaReachLen; // lateral, out to the leg's own side
      const olen = Math.hypot(ox, oz);
      if (olen > 1e-4) {
        const k = coxaReachLen / olen;
        ox *= k;
        oz *= k;
      } else {
        ox = 0;
        oz = latSign * coxaReachLen;
      }
      _shoulder.set(hip.x + ox, hip.y, hip.z + oz);
      orientSegment(this.coxa, hip, _shoulder);
    } else {
      _shoulder.set(hip.x, hip.y, hip.z); // no coxa: the femur hangs straight from the hip
    }

    // Femur + tibia: 2-bone IK from the shoulder to the foot, knee on the up side.
    // The thigh (femur) length is live-tunable via `femurScale`; the IK reads the
    // scaled length so the reach and knee bow follow it.
    const femurLen = this.femurLen * finiteOr(femurScale, 1);
    _target.copy(foot);
    _dir.copy(_target).sub(_shoulder);
    let d = _dir.length() || 1e-4;
    const maxReach = femurLen + this.tibiaLen - 1e-3;
    if (d > maxReach) {
      // Beyond reach the bones straighten; pull the target in so the solve holds.
      _dir.multiplyScalar(maxReach / d);
      _target.copy(_shoulder).add(_dir);
      d = maxReach;
    }
    // ...and no closer than the bones can fold (|femur - tibia|): inside that the
    // 2-bone solve has no solution and `a` swings hugely negative, throwing the
    // knee out behind the shoulder and stretching the shin past its length. Natural
    // proportions never hit this, but a short tuned thigh makes the fold limit large
    // and easy to cross, so push the target back out to it. Not folded closer.
    const minReach = Math.abs(femurLen - this.tibiaLen) + 1e-3;
    if (d < minReach) {
      _dir.multiplyScalar(minReach / d);
      _target.copy(_shoulder).add(_dir);
      d = minReach;
    }
    _dir.multiplyScalar(1 / d); // shoulder -> foot unit direction
    // A zero-length thigh has no bone to draw: collapse the knee onto the shoulder
    // and hide the femur, so the shin runs straight from the hip to the foot. Left
    // to the general solve, a ~0 femur yields a degenerate knee (offset by |a|) and
    // orientSegment -- which bails on a zero-length segment -- would freeze the
    // femur mesh at its last pose, leaving a stale bone floating where the thigh
    // was. Hiding it and seating the knee at the shoulder removes that artifact.
    const hasFemur = femurLen >= 1e-3;
    this.femur.visible = hasFemur;
    if (hasFemur) {
      const a = (femurLen * femurLen - this.tibiaLen * this.tibiaLen + d * d) / (2 * d);
      const h = Math.sqrt(Math.max(0, femurLen * femurLen - a * a));
      _pole.copy(UP).addScaledVector(_dir, -UP.dot(_dir)); // up, perpendicular to the chord
      if (_pole.lengthSq() < 1e-6) _pole.set(0, 0, 1); // vertical chord: any perpendicular
      _pole.normalize();
      // Nudge the knee sideways for joint-angle variation (a horizontal side vector).
      _side.crossVectors(_dir, UP);
      if (_side.lengthSq() > 1e-6) _pole.addScaledVector(_side.normalize(), kneeSway).normalize();
      _knee.copy(_shoulder).addScaledVector(_dir, a).addScaledVector(_pole, h);
      orientSegment(this.femur, _shoulder, _knee);
    } else {
      _knee.copy(_shoulder); // no thigh: knee sits at the shoulder, shin does all the reach
    }
    orientSegment(this.tibia, _knee, _target); // cone apex lands on the foot point

    // Record the solved joints (rig-group frame) for the debug overlay (spec 035).
    this.jHip.copy(hip);
    this.jShoulder.copy(_shoulder);
    this.jKnee.copy(_knee);
    this.jFoot.copy(_target);
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
// A foot must stay in its own angular wedge around the body: within
// WEDGE_MARGIN of its leg's own rest azimuth, and at least MIN_RADIUS out from the
// body centre. A planted foot that leaves its wedge (e.g. left stranded behind the
// hip during a turn) is forced to step, and fresh plants are clamped inside it --
// so a leg never reaches across a neighbour or in under the body.
//
// This replaces the original four-quadrant sign test (front/back x left/right).
// That test only described a leg's territory when there were exactly four legs at
// the corners; with N legs spaced around a circle, a leg resting dead ahead has
// `rest.z == 0` and no meaningful "side", so the quadrant clamp shoved its foot
// sideways off its own axis and held it there -- permanently splayed, permanently
// past its step trigger. The wedge is the same idea expressed in polar terms, and
// reduces to roughly the old quadrant for four legs.
const MIN_RADIUS = 13; // min distance of a foot from the body centre (x size)
// Half-width of a leg's wedge is (pi / N) shrunk by this, so adjacent legs always
// keep a gap between their territories and can never plant on top of each other.
const WEDGE_MARGIN = 0.78;
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
  /** Number of legs (3-8). */
  numLegs: number;
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
   * Hip-joint (coxa) reach: a multiplier on how far the segment closest to the
   * body extends the leg outward -- i.e. how much of a leg's reach comes from
   * moving that joint. 0 collapses it (a bare knee leg); higher throws the foot
   * further out from the hip.
   */
  coxaReach: number;
  /**
   * Hip-joint (coxa) fore/aft swing: how much the hip joint carries the whole leg
   * front-to-back (protraction/retraction). The hip swings the shoulder the femur
   * hangs from toward the foot's fore/aft, so the entire leg pivots at the hip and
   * reaches toward the target rather than the knee absorbing the motion. 0 keeps
   * the coxa pointing out to the side so all fore/aft motion lives in the knee; 1
   * (default) carries the shoulder level with the foot so the hip does all the
   * protraction/retraction; higher exaggerates the swing past the foot.
   */
  coxaSwing: number;
  /**
   * Thigh (femur) length: a multiplier on the middle leg segment -- the bone that
   * rises from the shoulder up to the knee. 1 is the natural length; higher gives a
   * longer, higher-kneed thigh; 0 removes the thigh entirely, collapsing the knee
   * onto the shoulder so the shin runs straight from the hip to the foot (no femur
   * drawn, and none left frozen where it used to be).
   */
  femurScale: number;
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
    numLegs: 4,
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
    coxaReach: 1,
    coxaSwing: 1,
    femurScale: 1,
    footSmooth: 26,
  };
}

// Safe [min, max] bounds for every tuning field. Deliberately generous -- they
// only exist to catch NaN / ±∞ / absurd values (from a stray edit) before they
// reach the pose math, not to second-guess ordinary slider use.
const TUNING_BOUNDS: Record<keyof MechTuning, readonly [number, number]> = {
  sizeScale: [0.1, 8],
  moveSpeed: [1, 5000],
  turnRate: [1, 5000],
  numLegs: [3, 8],
  stepTrigger: [1, 500],
  stepLeadWalk: [0, 500],
  stepLeadRun: [0, 500],
  stepHeightWalk: [0, 500],
  stepHeightRun: [0, 500],
  stepDurWalk: [0.03, 5],
  stepDurRun: [0.03, 5],
  maxStepping: [1, 2],
  raisedLegs: [0, 1],
  turnStepBias: [0, 8],
  yawLag: [0, 1],
  stepPredict: [0, 8],
  comShift: [0, 4],
  bobAmp: [0, 500],
  pitchGain: [0, 2],
  rollGain: [0, 4],
  kneeSway: [0, 4],
  coxaReach: [0, 4],
  coxaSwing: [0, 4],
  femurScale: [0, 4],
  footSmooth: [0.5, 1000],
};

/** Clamp every tuning field to its safe range in place, replacing NaN/∞ with the default. */
function sanitizeTuning(t: MechTuning): void {
  const def = defaultMechTuning();
  for (const key of Object.keys(TUNING_BOUNDS) as (keyof MechTuning)[]) {
    const [lo, hi] = TUNING_BOUNDS[key];
    t[key] = sclamp(t[key], lo, hi, def[key]);
  }
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

/**
 * How far a body-local point (`lx`, `lz`) sits outside a leg's territory: the
 * greater of how far it has swung past the edge of the leg's angular wedge (as an
 * arc length, so it is comparable to the radial overstretch in world units) and
 * how far it has crept inside `MIN_RADIUS`. Zero or negative means "inside".
 * The polar replacement for the old `foreViol`/`latViol` quadrant tests.
 */
function wedgeViolation(lx: number, lz: number, leg: LegPlant, S: number): number {
  const radius = Math.hypot(lx, lz);
  const inward = MIN_RADIUS * S - radius;
  // Angular deviation from the leg's own azimuth, as an arc length at this radius.
  const dev = Math.abs(angleDelta(Math.atan2(lz, lx), leg.azimuth));
  const past = (dev - leg.halfWedge) * Math.max(radius, 1);
  return Math.max(inward, past);
}

/**
 * Pull a body-local point back inside a leg's territory: rotate it onto the nearest
 * edge of the leg's wedge if it has swung past, and push it out to `MIN_RADIUS` if
 * it has crept in under the body. Returns the corrected point.
 */
function clampToWedge(lx: number, lz: number, leg: LegPlant, S: number): { x: number; z: number } {
  let radius = Math.hypot(lx, lz);
  let angle = Math.atan2(lz, lx);
  if (!(radius > 1e-4)) {
    // Degenerate: the point is at the body centre and has no direction. Put it on
    // the leg's own axis rather than letting atan2(0, 0) pick one arbitrarily.
    radius = MIN_RADIUS * S;
    angle = leg.azimuth;
  }
  const dev = angleDelta(angle, leg.azimuth);
  if (Math.abs(dev) > leg.halfWedge) {
    // Outside the wedge, ease the held position from the wedge edge back to the
    // leg's own axis as the point swings further off (weight 1 at the edge, 0 at a
    // half turn). This has to be *continuous*, including through the +-180 degree
    // seam where `angleDelta` flips sign: a plain "clamp to the nearer edge" is
    // bistable out there and snaps a stranded foot between the two edges frame to
    // frame, wrenching the hip segment from full-aft to full-fore. Here the weight
    // reaches 0 exactly at the seam, so the sign flip moves the foot not at all.
    const w = (Math.PI - Math.abs(dev)) / (Math.PI - leg.halfWedge);
    angle = leg.azimuth + Math.sign(dev) * leg.halfWedge * w;
  }
  if (radius < MIN_RADIUS * S) radius = MIN_RADIUS * S;
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
}

/** The mech's current gait, chosen from observed speed / accel / turn rate. */
export type LocomotionState = 'idle' | 'walking' | 'running' | 'turning' | 'stopping';

/** Per-leg ground-lock bookkeeping: the planted foot and any step in progress. */
interface LegPlant {
  /** The corner offset (fore/aft, lateral) of this leg's rest spot, at size scale 1. */
  readonly rest: { readonly x: number; readonly z: number };
  /** Lateral weight in -1..1 (the rest azimuth's sine) for inside/outside turn bias. */
  readonly side: number;
  /**
   * The fixed side the coxa reaches out to: always exactly -1 or +1, chosen once.
   * Odd leg counts put one leg on the fore/aft centreline (mirror symmetry with an
   * odd count forces it), where `sin(azimuth)` is a denormal ~1e-16 and its sign is
   * floating-point noise. Deciding the side up front keeps that leg's hip segment
   * from picking a direction out of rounding error.
   */
  readonly latSign: number;
  /**
   * Direction of this leg's rest spot as seen from the body centre: its azimuth,
   * and the matching unit vector. This is the leg's territory -- its hip sits along
   * it, its foot is kept inside a wedge around it, and its steps lead out from it.
   * Replaces reading front/back and left/right off `sign(rest.x)`/`sign(rest.z)`,
   * which only distinguished legs when there were exactly four of them.
   */
  readonly azimuth: number;
  readonly ux: number;
  readonly uz: number;
  /** Half-width of this leg's angular territory, in radians (from the leg count). */
  readonly halfWedge: number;
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

/**
 * The leg on the far side of the ring, pulled along with `legIndex` when it is
 * nearly ready to step so opposite legs tend to swing together. For four legs this
 * is the diagonal partner.
 */
function partnerOf(legIndex: number, numLegs: number): number {
  // The partner in the same pair (same pairOf value).
  // For 4 legs with alternating pairs: partner of 0 is 2, of 1 is 3, of 2 is 0, of 3 is 1.
  // This keeps the diagonal pairs [0,2] and [1,3] stepping together.
  // For N legs: partner is 2 steps away in the pair cycle.
  return (legIndex + 2) % numLegs;
}

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

const RAD2DEG = 180 / Math.PI;

/**
 * One leg's solved state for the debug viewport (spec 035): the four joints in
 * the rig-group frame (so an overlay parented to `rig.group` lines up exactly
 * with the drawn leg), the foot's logical plant vs its drawn position, the rest
 * spot and step-trigger radius, plant flags, and the joint angles worth reading
 * while tuning. All produced by {@link MechRig.debugSnapshot}.
 */
export interface LegDebug {
  /** Solved joints in the rig-group frame: hip -> shoulder (coxa) -> knee -> foot. */
  readonly hip: THREE.Vector3;
  readonly shoulder: THREE.Vector3;
  readonly knee: THREE.Vector3;
  readonly foot: THREE.Vector3;
  /** The logical foot plant (group-local); `y` is its current lift height. */
  readonly target: THREE.Vector3;
  /** The leg's rest spot (group-local, on the ground). */
  readonly rest: THREE.Vector3;
  /** Step-trigger radius around the rest spot (world units, size-scaled). */
  triggerRadius: number;
  stepping: boolean;
  held: boolean;
  /** Coxa fore/aft protraction: 0 = straight out to the side, +90 = full forward. */
  coxaSwingDeg: number;
  /** Femur elevation above horizontal (knee above the shoulder). */
  femurPitchDeg: number;
  /** Interior knee angle between femur and tibia. */
  kneeDeg: number;
  /** Tibia descent below horizontal (foot below the knee). */
  tibiaPitchDeg: number;
}

/** The rig's whole solved state for the debug viewport (spec 035). */
export interface MechDebug {
  readonly legs: readonly LegDebug[];
  state: LocomotionState;
  /** How far the chassis yaw trails its heading, in degrees. */
  bodyYawLagDeg: number;
}

function blankLegDebug(): LegDebug {
  return {
    hip: new THREE.Vector3(),
    shoulder: new THREE.Vector3(),
    knee: new THREE.Vector3(),
    foot: new THREE.Vector3(),
    target: new THREE.Vector3(),
    rest: new THREE.Vector3(),
    triggerRadius: 0,
    stepping: false,
    held: false,
    coxaSwingDeg: 0,
    femurPitchDeg: 0,
    kneeDeg: 0,
    tibiaPitchDeg: 0,
  };
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
  private legs: MechLeg[];
  private plants: LegPlant[];
  private lastNumLegs = -1;
  private legJustRecreated = false;
  private readonly bodyColor: number;
  private readonly legColor: number;
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
  private lastLegRy = 0; // the leg frame's yaw this frame, for debugSnapshot
  // Reused debug snapshot (spec 035): mutated in place so debugSnapshot allocates
  // nothing per call. Legs added in the constructor once the plant count is known.
  private readonly debug: MechDebug = { legs: [], state: 'idle', bodyYawLagDeg: 0 };

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
    this.bodyColor = bodyColorOverride ?? enemyColor(type);
    this.legColor = darken(this.bodyColor, 0.55);
    this.tuning = opts.tuning ?? defaultMechTuning();
    this.lowerBodyTurns = opts.lowerBodyTurns ?? true;
    this.orientsWithGroupYaw = this.lowerBodyTurns;

    // group -> carriage (lower body, leg frame) -> turret (upper body, faces heading).
    this.group.add(this.carriage);
    this.carriage.add(this.turret);
    const body = box(BODY_SIZE, BODY_SIZE, BODY_SIZE, this.bodyColor);
    body.position.y = BODY_Y;
    const plate = box(BODY_SIZE - 6, 4, BODY_SIZE - 6, darken(this.bodyColor, 0.8));
    plate.position.y = BODY_Y + BODY_SIZE / 2 + 1;
    const head = box(10, 9, 12, this.bodyColor);
    head.position.set(BODY_SIZE / 2 + 3, BODY_Y - 1, 0);
    const eye = box(3, 5, 10, PALETTE.enemyEye);
    eye.position.set(BODY_SIZE / 2 + 8, BODY_Y, 0);
    for (const mesh of [body, plate, head, eye]) {
      this.turret.add(mesh);
      this.bodyParts.push({ mesh, base: mesh.position.clone() });
    }

    this.legs = [];
    this.plants = [];
    this.recreateLegs();
  }

  /**
   * Build (or rebuild) the leg set for `tuning.numLegs`, a no-op unless the count
   * actually changed. Legs are spaced evenly around the body on an ellipse of
   * REST_X x REST_Z, each owning an angular wedge of the ground around it. The
   * classic four-leg mech is just the N=4 case of this, with its legs falling at
   * the same corners as before.
   *
   * Old legs are disposed, not dropped: their bones are parented to the rig group,
   * so letting them go without detaching leaves them in the scene forever, frozen
   * in their last pose.
   */
  private recreateLegs(): void {
    const numLegs = Math.round(clamp(this.tuning.numLegs, 3, 8));
    if (numLegs === this.lastNumLegs) return;
    this.lastNumLegs = numLegs;
    this.legJustRecreated = true;

    for (const leg of this.legs) leg.dispose();

    // Rest spots, ordered by azimuth *going around the body*. That ordering is what
    // makes the alternating-pair gait work: `pairOf` is `i % 2`, so consecutive legs
    // land in opposite pairs and each pair is a set of every-other leg around the
    // ring -- the diagonal for four legs, the classic insect tripod for six. (The
    // legacy corner list was ordered FL, FR, BL, BR, which is *not* circular: taking
    // every other one from it would lift both left legs at once and fall over.)
    const rests = Array.from({ length: numLegs }, (_, i) => {
      // Offset by half a step so no leg sits on the centreline at even counts and
      // the set stays mirror-symmetric front-to-back.
      const azimuth = angleWrap(((i + 0.5) / numLegs) * TWO_PI);
      const ux = Math.cos(azimuth);
      const uz = Math.sin(azimuth);
      // Rest on the outline of the REST_X x REST_Z box, in polar form, so the stance
      // keeps the body's oval footprint at any leg count. At N=4 the azimuths are
      // +-45/135 degrees and this puts the feet on the box's corners -- the same
      // four rest spots the mech has always used.
      const r = Math.min(REST_X / Math.max(Math.abs(ux), 1e-6), REST_Z / Math.max(Math.abs(uz), 1e-6));
      // Snap a centreline leg's lateral component to a clean zero so `side` is 0
      // (no inside/outside role in a turn) rather than a denormal, and pick its coxa
      // side from the index so it is stable instead of rounding-dependent.
      const lateral = Math.abs(uz) < 1e-9 ? 0 : uz;
      const latSign = lateral !== 0 ? Math.sign(lateral) : i % 2 === 0 ? 1 : -1;
      return { azimuth, ux, uz: lateral, x: ux * r, z: lateral * r, latSign };
    });
    // Each leg's wedge is half the angular gap to its nearest neighbour, shrunk by
    // WEDGE_MARGIN so adjacent territories never touch. Derived from the actual
    // azimuths rather than assuming even spacing, so it stays correct if the layout
    // is ever changed to an uneven one.
    const halfWedges = rests.map((r, i) => {
      const prev = rests[(i - 1 + numLegs) % numLegs] as (typeof rests)[number];
      const next = rests[(i + 1) % numLegs] as (typeof rests)[number];
      const gap = Math.min(
        Math.abs(angleDelta(r.azimuth, prev.azimuth)),
        Math.abs(angleDelta(next.azimuth, r.azimuth)),
      );
      return (gap / 2) * WEDGE_MARGIN;
    });

    this.legs = rests.map(
      (r) =>
        new MechLeg(
          this.legColor,
          COXA_LEN,
          FEMUR_LEN,
          TIBIA_LEN,
          this.group,
          r.latSign,
        ),
    );
    this.plants = rests.map((r, i) => ({
      rest: { x: r.x, z: r.z },
      azimuth: r.azimuth,
      ux: r.ux,
      uz: r.uz,
      halfWedge: halfWedges[i] as number,
      // Inside/outside turn biasing. A centreline leg gets 0 here, which is right:
      // it has no inside/outside role in a turn.
      side: r.uz,
      latSign: r.latSign,
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
    // Update debug records (spec 035), one per leg.
    (this.debug.legs as LegDebug[]).length = 0;
    (this.debug.legs as LegDebug[]).push(...this.plants.map(() => blankLegDebug()));
  }

  /** The mech's current locomotion state, for HUDs (e.g. the movement sandbox). */
  get locomotionState(): LocomotionState {
    return this.state;
  }

  /**
   * A read-only snapshot of the rig's solved state for the debug viewport (spec
   * 035): every leg's joints (in the rig-group frame), foot targets, rest spots,
   * trigger radii, plant flags, and joint angles. The same object is reused and
   * mutated each call, so this allocates nothing and is safe to call every frame.
   * The rig already computes all of it; this only surfaces it.
   */
  debugSnapshot(): MechDebug {
    const S = this.scale;
    const legRy = this.lastLegRy;
    const wx = this.prev?.x ?? 0;
    const wz = this.prev?.z ?? 0;
    this.debug.state = this.state;
    this.debug.bodyYawLagDeg = angleDelta(this.bodyRy, this.prevRy) * RAD2DEG;
    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i];
      const p = this.plants[i];
      const ld = this.debug.legs[i];
      if (!leg || !p || !ld) continue;
      ld.hip.copy(leg.jHip);
      ld.shoulder.copy(leg.jShoulder);
      ld.knee.copy(leg.jKnee);
      ld.foot.copy(leg.jFoot);
      // The logical foot plant, world -> group-local (matches the drawn frame).
      const tl = worldToLocalXZ(p.world.x - wx, p.world.z - wz, legRy);
      ld.target.set(tl.x, p.y, tl.z);
      ld.rest.set(p.rest.x * S, 0, p.rest.z * S);
      ld.triggerRadius = (this.tuning.stepTrigger + p.triggerOffset) * S;
      ld.stepping = p.stepping;
      ld.held = p.held;

      // Joint angles (all in the group-local frame the joints already live in).
      // Use the leg's fixed coxa side, not one re-derived from `rest.z` -- a
      // centreline leg's `rest.z` is a denormal and would flip the reported angle.
      const side = p.latSign;
      // Coxa protraction: fore/aft component vs the outward (lateral) component.
      ld.coxaSwingDeg = Math.atan2(leg.jShoulder.x - leg.jHip.x, side * (leg.jShoulder.z - leg.jHip.z)) * RAD2DEG;
      // Femur elevation above the horizontal (knee lifted above the shoulder).
      const fdx = leg.jKnee.x - leg.jShoulder.x;
      const fdz = leg.jKnee.z - leg.jShoulder.z;
      ld.femurPitchDeg = Math.atan2(leg.jKnee.y - leg.jShoulder.y, Math.hypot(fdx, fdz)) * RAD2DEG;
      // Interior knee angle between femur (knee->shoulder) and tibia (knee->foot).
      const ax = leg.jShoulder.x - leg.jKnee.x;
      const ay = leg.jShoulder.y - leg.jKnee.y;
      const az = leg.jShoulder.z - leg.jKnee.z;
      const bx = leg.jFoot.x - leg.jKnee.x;
      const by = leg.jFoot.y - leg.jKnee.y;
      const bz = leg.jFoot.z - leg.jKnee.z;
      const la = Math.hypot(ax, ay, az) || 1e-6;
      const lb = Math.hypot(bx, by, bz) || 1e-6;
      ld.kneeDeg = Math.acos(clamp((ax * bx + ay * by + az * bz) / (la * lb), -1, 1)) * RAD2DEG;
      // Tibia descent below the horizontal (foot dropped below the knee).
      const tdx = leg.jFoot.x - leg.jKnee.x;
      const tdz = leg.jFoot.z - leg.jKnee.z;
      ld.tibiaPitchDeg = Math.atan2(leg.jKnee.y - leg.jFoot.y, Math.hypot(tdx, tdz)) * RAD2DEG;
    }
    return this.debug;
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
    // Sanitise everything that enters the pose math: a single NaN/∞ here is what
    // sends a leg to the ceiling or off to infinity, so nothing non-finite passes.
    dt = sclamp(dt, 1e-4, 0.1, 1 / 60);
    sanitizeTuning(this.tuning);
    this.recreateLegs(); // recreate if numLegs changed
    const wx = finiteOr(worldPos.x, this.prev?.x ?? 0);
    const wz = finiteOr(worldPos.y, this.prev?.z ?? 0); // sim (x, y) -> world floor (x, z)
    ry = finiteOr(ry, this.prevRy);
    this.clock += dt;
    this.scale = sclamp(this.tuning.sizeScale, 0.2, 8, 1);
    if (this.scale !== this.appliedScale) this.applyScale(this.scale);
    const S = this.scale;

    // The leg frame follows the heading for a spider, but stays world-fixed for a
    // mech (only its turret turns). `leadDir` is the travel/facing direction
    // expressed in that frame, so steps always lead the way the body is going.
    const legRy = this.lowerBodyTurns ? ry : 0;
    this.lastLegRy = legRy;
    this.leadDir = worldToLocalXZ(Math.cos(ry), -Math.sin(ry), legRy);

    if (this.prev === null || this.legJustRecreated) {
      // First frame or after leg recreation: drop every foot onto its rest spot so nothing snaps.
      for (const leg of this.plants) {
        const r = localToWorldXZ(leg.rest.x * S, leg.rest.z * S, legRy);
        leg.world = { x: wx + r.x, z: wz + r.z };
        leg.disp = { x: leg.world.x, z: leg.world.z };
      }
      this.prev = { x: wx, z: wz };
      this.prevRy = ry;
      this.bodyRy = ry;
      this.legJustRecreated = false;
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
      // Foot in the body's local frame: how far it has left its angular wedge.
      const lf = worldToLocalXZ(leg.world.x - wx, leg.world.z - wz, ry);
      const over = Math.max(radial, wedgeViolation(lf.x, lf.z, leg, S));
      return { restX, restZ, over };
    });

    // Raised-leg recovery: maybe lift one leg and tuck it, or plant a held one.
    this.manageHold(wx, wz, ry, run01, turnBias, info);

    let stepping = this.plants.reduce((n, l) => n + (l.stepping ? 1 : 0), 0);
    const heldCount = this.plants.reduce((n, l) => n + (l.held ? 1 : 0), 0);
    const numLegs = this.plants.length;
    // How many legs may swing at once. `maxStepping` is expressed for a four-legged
    // mech, so scale it with the leg count: the swing budget has to grow with N or
    // each leg waits N/4 as long for its turn and its foot drifts far past the step
    // trigger while queued -- which is exactly what stranded the feet of the 6- and
    // 8-legged rigs (measured: ~1.8 plants/leg/s at N=8 against 3.4 at N=4).
    // Never more than half the legs, so at least ceil(N/2) stay planted.
    const swingBudget = clamp(
      Math.round(clamp(this.tuning.maxStepping, 1, 2) * (numLegs / 4)),
      1,
      Math.floor(numLegs / 2),
    );
    // While a leg is held, give up one slot so the extra support is not spent.
    const cap = heldCount > 0 ? Math.max(1, swingBudget - 1) : swingBudget;
    // A leg may only swing while both of its neighbours around the ring are down.
    // This is the invariant the old "only one diagonal pair may be airborne" rule
    // was standing in for: with four legs, the non-adjacent legs are exactly the
    // diagonal, so this reproduces the alternating tetrapod. Unlike a two-colouring
    // (`i % 2`) it also holds for odd leg counts, where the colours come out unequal
    // *and* legs 0 and N-1 share a colour despite being neighbours -- which left the
    // odd-legged rigs stepping at two thirds the rate of the even ones.
    const neighboursDown = (i: number): boolean => {
      const prev = this.plants[(i - 1 + numLegs) % numLegs];
      const next = this.plants[(i + 1) % numLegs];
      const free = (l: LegPlant | undefined): boolean => l === undefined || (!l.stepping && !l.held);
      return free(prev) && free(next);
    };

    const ranked = info
      .map((e, i) => ({ i, ...e }))
      .filter((e) => {
        const leg = this.plants[e.i];
        return leg !== undefined && !leg.stepping && !leg.held && leg.cooldown <= 0 && e.over > 0;
      })
      .sort((a, b) => b.over - a.over);

    for (const e of ranked) {
      if (stepping >= cap) break;
      const leg = this.plants[e.i];
      if (!leg || leg.stepping || !neighboursDown(e.i)) continue;
      this.beginStep(leg, wx, wz, ry, run01, turnBias);
      stepping++;
      // Pull the opposite leg along if it is nearly ready, for a paired step.
      const j = partnerOf(e.i, numLegs);
      const partner = this.plants[j];
      const pInfo = info[j];
      if (
        partner &&
        pInfo &&
        !partner.stepping &&
        !partner.held &&
        partner.cooldown <= 0 &&
        stepping < cap &&
        neighboursDown(j) &&
        pInfo.over > -COUPLE_SLACK * S
      ) {
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
      // Support floor scales with the leg count: half the legs, never below two.
      const minSupport = Math.max(2, Math.floor(this.plants.length / 2));
      const needed =
        !allowHold || hleg.holdT > hleg.holdMax || maxOver > HOLD_EXIT_OVER * S || planted < minSupport || settling;
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
    // Enter a hold only from a fully-planted stance (every leg down).
    const minPlanted = this.plants.length;
    if (!allowHold || this.holdCooldown > 0 || stepping > 0 || planted < minPlanted || run01 > 0.9 || !moving) return;
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
    const reach = (COXA_LEN * t.coxaReach + FEMUR_LEN * t.femurScale + TIBIA_LEN) * S;
    const turnHaste = 1 - 0.35 * Math.abs(turnBias); // quicker steps mid-turn
    leg.dur = sclamp(lerp(t.stepDurWalk, t.stepDurRun, run01) * turnHaste * (0.92 + vnoise(leg.seed + 3, this.clock) * 0.16), 0.06, 5, 0.2);
    // Forward lead ahead of rest, biased by the turn; never less than the ground
    // the body will cover during the swing, so the foot lands ahead of drift.
    const baseLead = lerp(t.stepLeadWalk, t.stepLeadRun, run01) * S * (1 + turnBias * leg.side * t.turnStepBias);
    const lead = sclamp(Math.max(baseLead, this.speed * leg.dur * 0.75), 0, reach, 0);
    const along = (vnoise(leg.seed + 7, this.clock) - 0.5) * PLACE_JITTER * S;
    const across = (vnoise(leg.seed + 31, this.clock) - 0.5) * PLACE_JITTER * S;
    // Lead along the travel direction expressed in the leg frame (`leadDir`), not
    // a fixed +x: for a spider that is the facing, for a mech it is whatever way it
    // is walking across its un-turning leg base. Jitter runs along/across it.
    const dx = this.leadDir.x;
    const dz = this.leadDir.z;
    let lx = leg.rest.x * S + dx * (lead + along) - dz * across;
    let lz = leg.rest.z * S + dz * (lead + along) + dx * across;
    // Clamp into the leg's own angular wedge so it never plants across a neighbour's
    // territory or in under the body.
    const wedged = clampToWedge(lx, lz, leg, S);
    lx = wedged.x;
    lz = wedged.z;
    // Keep the plant within the leg's reach FROM ITS HIP. `lead` alone is capped at
    // `reach`, but the rest offset (|rest| ~ 34-42) is added on top and turnStepBias
    // lengthens the leading leg's stride, so a turn could plant the foot well past
    // coxa+femur+tibia -- the leg then over-extends and the drawn foot strands at
    // the reach cap (the "outside front leg reaching too far" in a turn). Clamp the
    // target's distance from the hip to just inside that reach so it stays coverable.
    const hipX = leg.ux * HIP_INSET * S;
    const hipZ = leg.uz * HIP_INSET * S;
    const rx = lx - hipX;
    const rz = lz - hipZ;
    const rlen = Math.hypot(rx, rz);
    const maxPlant = reach * 0.9;
    if (rlen > maxPlant) {
      lx = hipX + (rx / rlen) * maxPlant;
      lz = hipZ + (rz / rlen) * maxPlant;
    }
    // Placement prediction: the leg frame rotates at `legYawRate` (0 for a mech
    // whose base doesn't turn), so over the swing it turns by ~legYawRate*dur.
    // Convert the target through that future frame so the foot lands ahead.
    const predictRy = ry + this.legYawRate * leg.dur * t.stepPredict;
    const w = localToWorldXZ(lx, lz, predictRy);
    const restW = localToWorldXZ(leg.rest.x * S, leg.rest.z * S, ry);
    leg.from = Number.isFinite(leg.world.x + leg.world.z) ? { x: leg.world.x, z: leg.world.z } : { x: wx + restW.x, z: wz + restW.z };
    leg.to = { x: finiteOr(wx + w.x, wx + restW.x), z: finiteOr(wz + w.z, wz + restW.z) };
    leg.t = 0;
    leg.stepping = true;
    leg.arcH = sclamp(lerp(t.stepHeightWalk, t.stepHeightRun, run01) * S * (0.85 + vnoise(leg.seed + 5, this.clock) * 0.3), 0, (FEMUR_LEN + TIBIA_LEN) * S, 0);
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
    if (!Number.isFinite(this.bodyRy)) this.bodyRy = ry;
    if (!Number.isFinite(this.bodyAngVel)) this.bodyAngVel = 0;
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
    // Finite-guard every value that feeds the body transform (and thus the hip
    // matrix + body meshes), so a stray spring value can't launch the body.
    const swayCap = 4 * S * REST_Z;
    this.carriage.position.set(
      sclamp(this.sSwayX.value, -swayCap, swayCap, 0),
      sclamp(this.sHeight.value, -swayCap, swayCap, 0),
      sclamp(this.sSwayZ.value, -swayCap, swayCap, 0),
    );
    this.carriage.rotation.set(sclamp(this.sRoll.value, -1.2, 1.2, 0), 0, sclamp(-this.sPitch.value, -1.2, 1.2, 0));
    this.carriage.updateMatrix();
    this.turret.rotation.set(0, finiteOr(turretYaw, 0), 0);

    // Draw each leg between its (chassis-borne) hip and its slew-limited foot. The
    // drawn foot chases the logical plant at a capped rate, so nothing snaps.
    const aFoot = 1 - Math.exp(-t.footSmooth * dt);
    const aFootY = 1 - Math.exp(-t.footSmooth * 1.5 * dt);
    const aKnee = Math.min(1, dt * 6);
    // Bounds for the drawn foot: it can never sit further than the leg can reach,
    // nor above roughly leg height -- a hard cap against "leg to the ceiling / far
    // away" no matter what upstream produced. Includes the tunable coxa reach.
    const reach = (COXA_LEN * t.coxaReach + FEMUR_LEN * t.femurScale + TIBIA_LEN) * S;
    const footYMax = (FEMUR_LEN + TIBIA_LEN) * S;
    this.legs.forEach((leg, i) => {
      const p = this.plants[i];
      if (!p) return;
      // Repair any non-finite per-leg state before it feeds the smoothing/pose.
      if (!Number.isFinite(p.world.x + p.world.z)) {
        const r = localToWorldXZ(p.rest.x * S, p.rest.z * S, ry);
        p.world = { x: wx + r.x, z: wz + r.z };
      }
      if (!Number.isFinite(p.disp.x + p.disp.z)) p.disp = { x: p.world.x, z: p.world.z };
      p.y = finiteOr(p.y, 0);
      p.dispY = finiteOr(p.dispY, 0);
      p.disp.x += (p.world.x - p.disp.x) * aFoot;
      p.disp.z += (p.world.z - p.disp.z) * aFoot;
      p.dispY += (p.y - p.dispY) * aFootY;
      // The hip sits along the leg's own azimuth, so every leg's shoulder is under
      // its own territory. (The original placed all hips on four fixed body corners,
      // which only lined up with the legs when there were exactly four of them.)
      const hx = p.ux * HIP_INSET * S;
      const hz = p.uz * HIP_INSET * S;
      _hip.set(hx, HIP_Y * S, hz).applyMatrix4(this.carriage.matrix);
      // Fall back to the rest hip if the carriage matrix went bad.
      if (!Number.isFinite(_hip.x + _hip.y + _hip.z)) _hip.set(hx, HIP_Y * S, hz);
      const local = worldToLocalXZ(p.disp.x - wx, p.disp.z - wz, ry);
      // Guarantee the *drawn* foot stays in the leg's wedge even when a fast yaw has
      // left the world-locked plant lagging behind or across the body: hold it at the
      // wedge boundary (a tiny slide) rather than render the leg reaching across a
      // neighbour or in under the hip. Normal-gait feet are well inside this.
      const wedged = clampToWedge(local.x, local.z, p, S);
      // Final clamp: finite and within the leg's reach box (no ceiling / infinity).
      const fx = sclamp(wedged.x, -reach, reach, p.rest.x * S);
      const fz = sclamp(wedged.z, -reach, reach, p.rest.z * S);
      _foot.set(fx, sclamp(p.dispY, -4 * S, footYMax, 0), fz);
      const kneeTarget = (vnoise(p.seed + 11, this.clock * 0.5) - 0.5) * t.kneeSway;
      p.kneeCur = sclamp(p.kneeCur + (kneeTarget - p.kneeCur) * aKnee, -2, 2, 0);
      leg.pose(_hip, _foot, p.kneeCur, t.coxaReach, t.coxaSwing, t.femurScale);
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
