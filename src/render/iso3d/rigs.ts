import * as THREE from 'three';
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

/** One articulated two-bone leg: a hip that swings and a knee that bends to lift. */
class MechLeg {
  readonly hip = new THREE.Group();
  private readonly knee = new THREE.Group();

  constructor(hipPos: THREE.Vector3, legColor: number) {
    this.hip.position.copy(hipPos);
    const thighLen = 16;
    const shinLen = 16;
    const thigh = box(6, thighLen, 6, legColor);
    thigh.position.y = -thighLen / 2;
    this.hip.add(thigh);

    this.knee.position.y = -thighLen;
    const shin = box(5, shinLen, 5, legColor);
    shin.position.y = -shinLen / 2;
    this.knee.add(shin);
    const foot = box(9, 4, 11, darken(legColor, 0.7));
    foot.position.y = -shinLen;
    this.knee.add(foot);
    this.hip.add(this.knee);
  }

  /** `phase` cycles the gait; `amp` scales the whole motion (0 = planted rest). */
  pose(phase: number, amp: number): void {
    // Swing the leg fore/aft around the lateral axis; the foot reaches to the
    // front on the forward half of the stride to plant and carry the body.
    this.hip.rotation.z = Math.sin(phase) * 0.5 * amp;
    // Bend the knee to lift the foot clear while it swings forward.
    this.knee.rotation.z = -0.25 - Math.max(0, Math.cos(phase)) * 0.7 * amp;
  }
}

/**
 * A four-legged mech enemy: a rigid chassis carried on four articulated legs
 * that trot (diagonal pairs), stepping to the front to support the body as it
 * advances. Body colour comes from the enemy type so the types read apart.
 */
export class MechRig {
  readonly group = new THREE.Group();
  private readonly legs: readonly MechLeg[];
  private readonly phaseOffsets: readonly number[];
  private stride = 0;
  private amp = 0;
  private static readonly STRIDE = 44;

  constructor(type: string) {
    const bodyColor = enemyColor(type);
    const legColor = darken(bodyColor, 0.55);

    const chassis = box(46, 18, 32, bodyColor);
    chassis.position.y = 34;
    this.group.add(chassis);
    const plate = box(38, 5, 26, darken(bodyColor, 0.8));
    plate.position.y = 45;
    this.group.add(plate);
    const head = box(16, 12, 20, bodyColor);
    head.position.set(28, 34, 0);
    this.group.add(head);
    const eye = box(4, 6, 14, PALETTE.enemyEye);
    eye.position.set(37, 35, 0);
    this.group.add(eye);

    // Hips at the four chassis corners; trot pairs (FL+BR, FR+BL) share a phase.
    const hips: readonly [number, number, number, number][] = [
      [16, 30, -14, 0], // front-left
      [16, 30, 14, Math.PI], // front-right
      [-16, 30, -14, Math.PI], // back-left
      [-16, 30, 14, 0], // back-right
    ];
    this.legs = hips.map(([x, y, z]) => {
      const leg = new MechLeg(new THREE.Vector3(x, y, z), legColor);
      this.group.add(leg.hip);
      return leg;
    });
    this.phaseOffsets = hips.map(([, , , off]) => off);
  }

  update(dt: number, distanceMoved: number): void {
    this.stride += distanceMoved;
    this.amp = approach(this.amp, distanceMoved > 0.03 ? 1 : 0, dt, 8);
    const base = (this.stride / MechRig.STRIDE) * TWO_PI;
    this.legs.forEach((leg, i) => leg.pose(base + (this.phaseOffsets[i] ?? 0), this.amp));
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
