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
const UP = new THREE.Vector3(0, 1, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

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
 * One two-bone spider leg: a thigh from the hip up-and-out to a raised knee, and
 * a shin dropping from the knee down to a planted foot. It is posed each frame by
 * a 2-bone IK solve toward a foot point (in the body's local space) with an
 * up-pointing pole, so the knee always bends upward like a spider's. The bones
 * are unit-height boxes scaled to the solved segment; the rig owns where the foot
 * is planted -- this class only draws the leg reaching it.
 */
class MechLeg {
  private readonly thigh: THREE.Mesh;
  private readonly shin: THREE.Mesh;
  private readonly foot: THREE.Mesh;

  constructor(
    private readonly hip: THREE.Vector3,
    legColor: number,
    private readonly thighLen: number,
    private readonly shinLen: number,
    group: THREE.Group,
  ) {
    this.thigh = box(5.5, 1, 5.5, legColor);
    this.shin = box(4, 1, 4, legColor);
    this.foot = box(9, 3.5, 12, darken(legColor, 0.7));
    group.add(this.thigh, this.shin, this.foot);
  }

  /** Bend the leg so its foot sits at `foot` (local space), knee bowed upward. */
  pose(foot: THREE.Vector3): void {
    _target.copy(foot);
    _dir.copy(_target).sub(this.hip);
    let d = _dir.length() || 1e-4;
    // Beyond the leg's reach the two bones straighten; pull the target in so the
    // solve stays valid (the rig re-plants before it gets this far in practice).
    const maxReach = this.thighLen + this.shinLen - 1e-3;
    if (d > maxReach) {
      _dir.multiplyScalar(maxReach / d);
      _target.copy(this.hip).add(_dir);
      d = maxReach;
    }
    _dir.multiplyScalar(1 / d); // hip -> foot unit direction
    // Knee lies `a` along the chord, `h` off it, on the up-pole side.
    const a = (this.thighLen * this.thighLen - this.shinLen * this.shinLen + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, this.thighLen * this.thighLen - a * a));
    _pole.copy(UP).addScaledVector(_dir, -UP.dot(_dir)); // up, made perpendicular to the chord
    if (_pole.lengthSq() < 1e-6) _pole.set(0, 0, 1); // chord is vertical: pick any perpendicular
    _pole.normalize();
    _knee.copy(this.hip).addScaledVector(_dir, a).addScaledVector(_pole, h);

    orientSegment(this.thigh, this.hip, _knee);
    orientSegment(this.shin, _knee, _target);
    this.foot.position.copy(_target);
  }
}

// Body/leg proportions of the mech (world units). A small cube body on four wide
// spider legs; tuned so the resting stance has slack before a leg oversteps.
const HIP_Y = 34;
const HIP_INSET = 10;
const REST_X = 32;
const REST_Z = 38;
const THIGH_LEN = 28;
const SHIN_LEN = 34;
const BODY_Y = 40;
const BODY_SIZE = 22;
// Gait tuning: how far a foot may drift from its rest spot before the leg
// re-plants, how far ahead of rest it plants in the travel direction, the arc
// and duration of a step, and how many legs may be mid-step at once.
const STEP_TRIGGER = 18;
const STEP_LEAD = 16;
const STEP_HEIGHT = 15;
const STEP_DURATION = 0.16;
const MAX_STEPPING = 2;

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

/** Per-leg ground-lock bookkeeping: the planted foot and any step in progress. */
interface LegPlant {
  /** The corner offset (fore/aft, lateral) of this leg's rest spot in local space. */
  readonly rest: { readonly x: number; readonly z: number };
  /** Where the foot is currently planted, in world (x, z). */
  world: { x: number; z: number };
  /** Foot height above ground: 0 when planted, arced up mid-step. */
  y: number;
  stepping: boolean;
  from: { x: number; z: number };
  to: { x: number; z: number };
  /** Step progress 0..1. */
  t: number;
}

/**
 * A four-legged mech: a small cube body carried on four two-jointed spider legs
 * whose feet lock to the ground. Each foot stays put in the world while the body
 * moves over it; when a foot is stretched too far from its rest spot under the
 * body, that leg detaches and steps to a fresh plant point led in the travel
 * direction, arcing up and back down -- a diagonal-pair gait, capped so the body
 * stays supported. All cosmetic: driven purely by the observed world transform
 * (position + yaw), never by reading or writing sim state. Body colour keys off
 * the enemy type unless an explicit colour is given (e.g. the movement sandbox).
 */
export class MechRig {
  readonly group = new THREE.Group();
  private readonly legs: readonly MechLeg[];
  private readonly plants: readonly LegPlant[];
  private prev: { x: number; z: number } | null = null;
  private moveDir = { x: 0, z: 0 };

  constructor(type: string, bodyColorOverride?: number) {
    const bodyColor = bodyColorOverride ?? enemyColor(type);
    const legColor = darken(bodyColor, 0.55);

    const body = box(BODY_SIZE, BODY_SIZE, BODY_SIZE, bodyColor);
    body.position.y = BODY_Y;
    this.group.add(body);
    const plate = box(BODY_SIZE - 6, 4, BODY_SIZE - 6, darken(bodyColor, 0.8));
    plate.position.y = BODY_Y + BODY_SIZE / 2 + 1;
    this.group.add(plate);
    const head = box(10, 9, 12, bodyColor);
    head.position.set(BODY_SIZE / 2 + 3, BODY_Y - 1, 0);
    this.group.add(head);
    const eye = box(3, 5, 10, PALETTE.enemyEye);
    eye.position.set(BODY_SIZE / 2 + 8, BODY_Y, 0);
    this.group.add(eye);

    // Four corner legs: sx picks front/back, sz picks left/right.
    const corners: readonly [number, number][] = [
      [1, -1], // front-left
      [1, 1], // front-right
      [-1, -1], // back-left
      [-1, 1], // back-right
    ];
    this.legs = corners.map(
      ([sx, sz]) =>
        new MechLeg(new THREE.Vector3(sx * HIP_INSET, HIP_Y, sz * HIP_INSET), legColor, THIGH_LEN, SHIN_LEN, this.group),
    );
    this.plants = corners.map(([sx, sz]) => ({
      rest: { x: sx * REST_X, z: sz * REST_Z },
      world: { x: 0, z: 0 },
      y: 0,
      stepping: false,
      from: { x: 0, z: 0 },
      to: { x: 0, z: 0 },
      t: 0,
    }));
  }

  /**
   * Pose the legs from the body's world position and yaw (`ry` = the group's
   * `rotation.y`, the same value the scene sets to face the unit). Feet stay
   * planted in the world; overstretched legs step to a fresh plant ahead.
   */
  update(dt: number, worldPos: Vec2, ry: number): void {
    const wx = worldPos.x;
    const wz = worldPos.y; // sim's (x, y) plane maps to the world floor (x, z)

    if (this.prev === null) {
      // First frame: drop every foot onto its rest spot so nothing snaps.
      for (const leg of this.plants) {
        const r = localToWorldXZ(leg.rest.x, leg.rest.z, ry);
        leg.world = { x: wx + r.x, z: wz + r.z };
      }
      this.prev = { x: wx, z: wz };
    }

    // Travel direction this frame (kept from the last real move while standing).
    const dx = wx - this.prev.x;
    const dz = wz - this.prev.z;
    const moved = Math.hypot(dx, dz);
    if (moved > 0.05) this.moveDir = { x: dx / moved, z: dz / moved };
    this.prev = { x: wx, z: wz };

    // Start steps for the most-overstretched grounded legs, up to the cap.
    let stepping = this.plants.reduce((n, l) => n + (l.stepping ? 1 : 0), 0);
    const ranked = this.plants
      .map((leg) => {
        const r = localToWorldXZ(leg.rest.x, leg.rest.z, ry);
        const restX = wx + r.x;
        const restZ = wz + r.z;
        const over = Math.hypot(leg.world.x - restX, leg.world.z - restZ) - STEP_TRIGGER;
        return { leg, restX, restZ, over };
      })
      .filter((e) => !e.leg.stepping && e.over > 0)
      .sort((a, b) => b.over - a.over);
    for (const e of ranked) {
      if (stepping >= MAX_STEPPING) break;
      e.leg.from = { x: e.leg.world.x, z: e.leg.world.z };
      e.leg.to = { x: e.restX + this.moveDir.x * STEP_LEAD, z: e.restZ + this.moveDir.z * STEP_LEAD };
      e.leg.t = 0;
      e.leg.stepping = true;
      stepping++;
    }

    // Advance in-progress steps: arc the foot up and forward, then plant it.
    for (const leg of this.plants) {
      if (!leg.stepping) continue;
      leg.t += dt / STEP_DURATION;
      if (leg.t >= 1) {
        leg.world = { x: leg.to.x, z: leg.to.z };
        leg.y = 0;
        leg.stepping = false;
      } else {
        const e = leg.t * leg.t * (3 - 2 * leg.t); // smoothstep along the ground
        leg.world = { x: leg.from.x + (leg.to.x - leg.from.x) * e, z: leg.from.z + (leg.to.z - leg.from.z) * e };
        leg.y = Math.sin(Math.PI * leg.t) * STEP_HEIGHT;
      }
    }

    // Draw each leg reaching its (world-locked) foot, expressed in local space.
    this.legs.forEach((leg, i) => {
      const p = this.plants[i];
      if (!p) return;
      const local = worldToLocalXZ(p.world.x - wx, p.world.z - wz, ry);
      _foot.set(local.x, p.y, local.z);
      leg.pose(_foot);
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
