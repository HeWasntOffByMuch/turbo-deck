/**
 * The grip arithmetic, against both real meshes and a made-up one (spec 140).
 *
 * The made-up one is where the *rules* are checked, because a synthetic weapon
 * has known answers by construction. The two real ones are where the claim that
 * matters is checked: that the documents committed beside them describe them
 * correctly, which is a fact about files and cannot be established from a
 * fixture.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readGlbJson } from '../units/glb.js';
import { weaponDefFixture } from './fixtures.js';
import {
  alignRotation,
  axesArePerpendicular,
  axisVector,
  cross,
  dot,
  edgeAxis,
  gripTransform,
  measuredLength,
  type MeshBounds,
  type Quat,
} from './grip.js';
import { quatFromEulerXyz, rotateByQuat } from './grip.js';
import { checkWeaponSockets, validateWeaponDef } from './validate.js';
import { validateSkeleton } from '../units/validate.js';
import { readNodeTree, splitGlb } from '../units/glb-read.js';
import { bodyFrame, boneNode, namingOf, worldPosition } from '../units/pose.js';
import { poseWorldMatrices, type PoseRotations } from '../units/skin.js';
import { clipPoseAt } from '../units/clip-sample.js';
import { poseAt } from '../units/clip-author.js';
import { PIG_STRIKE, STRIKE_CONTACT_MS, STRIKE_KEY_MS } from '../units/pig-strike.js';
import { DEFAULT_CANONICAL_HEIGHT } from '../units/canonical-height.js';
import type { NamingSpec } from '../units/naming.js';
import type { Vec3 } from './types.js';

const ITEMS = join(process.cwd(), 'assets', 'items');
const UNIT_DIR = join(process.cwd(), 'assets', 'units', 'pig_a_pose_full');
/** The family's clips, which moved out of the unit folder when the fox joined. */
const CLIP_DIR = join(process.cwd(), 'assets', 'units', 'clips');

/** The bounds of a `.glb`, off the POSITION accessors the spec guarantees. */
function boundsOf(path: string): MeshBounds {
  const json = readGlbJson(new Uint8Array(readFileSync(path))) as {
    accessors?: { min?: number[]; max?: number[] }[];
    meshes?: { primitives?: { attributes?: Record<string, number> }[] }[];
  };
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const index = primitive.attributes?.['POSITION'];
      const accessor = index === undefined ? undefined : json.accessors?.[index];
      if (!accessor?.min || !accessor.max) continue;
      for (let axis = 0; axis < 3; axis += 1) {
        lo[axis] = Math.min(lo[axis] ?? Infinity, accessor.min[axis] ?? 0);
        hi[axis] = Math.max(hi[axis] ?? -Infinity, accessor.max[axis] ?? 0);
      }
    }
  }
  return { min: lo, max: hi };
}

/**
 * Rounds a basis vector to the integers it should be, without negative zero.
 *
 * `Math.round(-1e-17)` is `-0`, and `-0` is not `0` to a deep equality check --
 * so a correct axis fails on a sign that does not exist. Adding zero collapses
 * it, which is the one arithmetic identity that does.
 */
function axisOf(v: Vec3): number[] {
  return [...v].map((component) => Math.round(component) + 0);
}

/** Rotates a vector by a quaternion: `q * v * q'`. */
function rotate(q: Quat, v: Vec3): Vec3 {
  const t: Vec3 = [2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])];
  return [
    v[0] + q[3] * t[0] + (q[1] * t[2] - q[2] * t[1]),
    v[1] + q[3] * t[1] + (q[2] * t[0] - q[0] * t[2]),
    v[2] + q[3] * t[2] + (q[0] * t[1] - q[1] * t[0]),
  ];
}

const CANONICAL_POINT: Vec3 = [0, 1, 0];
const CANONICAL_FLAT: Vec3 = [0, 0, 1];
const CANONICAL_EDGE: Vec3 = [1, 0, 0];

describe('canonical weapon space', () => {
  it('takes every legal axis pair onto the same three axes', () => {
    // The whole contract, over every pair the schema allows: point goes to +Y,
    // flat to +Z, edge to +X. Downstream only has to agree with that.
    const axes = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const;
    let checked = 0;
    for (const point of axes) {
      for (const flat of axes) {
        if (!axesArePerpendicular(point, flat)) continue;
        checked += 1;
        const rotation = alignRotation({ point, flat });
        expect(axisOf(rotate(rotation, axisVector(point)))).toEqual([...CANONICAL_POINT]);
        expect(axisOf(rotate(rotation, axisVector(flat)))).toEqual([...CANONICAL_FLAT]);
        expect(axisOf(rotate(rotation, edgeAxis({ point, flat })))).toEqual([...CANONICAL_EDGE]);
      }
    }
    // Six axes, four perpendicular partners each.
    expect(checked).toBe(24);
  });

  it('is right-handed, so nothing is drawn mirrored', () => {
    // `edge x point = flat` is what makes (X, Y, Z) a rotation rather than a
    // reflection. A mirrored sword looks fine until it is beside another one.
    const axes = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'] as const;
    for (const point of axes) {
      for (const flat of axes) {
        if (!axesArePerpendicular(point, flat)) continue;
        const edge = edgeAxis({ point, flat });
        const handed = cross(edge, axisVector(point));
        expect(axisOf(handed)).toEqual([...axisVector(flat)]);
      }
    }
  });

  it('refuses to be built from two axes on one line', () => {
    expect(axesArePerpendicular('+Z', '-Z')).toBe(false);
    expect(axesArePerpendicular('+Z', '+Z')).toBe(false);
    expect(axesArePerpendicular('+Z', '+Y')).toBe(true);
    const issues = validateWeaponDef(weaponDefFixture({ grip: { at: [0, 0, 1], point: '-Z', flat: '+Z' } })).issues;
    expect(issues.map((issue) => issue.code)).toContain('weapon.grip.degenerate');
  });
});

describe('the transform a weapon is drawn with', () => {
  const bounds: MeshBounds = { min: [-0.1, -0.05, -1.5], max: [0.1, 0.05, 1.5] };

  it('scales by the length asked for over the length measured', () => {
    const weapon = weaponDefFixture({ lengthWorld: 30, grip: { at: [0, 0, 1], point: '-Z', flat: '+Y' } });
    expect(measuredLength(bounds, '-Z')).toBeCloseTo(3, 9);
    expect(gripTransform(weapon, bounds).scale).toBeCloseTo(10, 9);
  });

  it('puts the grip on the origin, whatever the exporter chose', () => {
    const weapon = weaponDefFixture({ grip: { at: [0.2, -0.1, 1], point: '-Z', flat: '+Y' } });
    expect(gripTransform(weapon, bounds).meshOffset).toEqual([-0.2, 0.1, -1]);
  });

  it('measures the tip and the butt from the grip, in world units', () => {
    // Grip at z=+1 on a mesh running -1.5..+1.5 with the tip at -Z: the tip is
    // 2.5 mesh units away and the butt is 0.5, times the scale.
    const weapon = weaponDefFixture({ lengthWorld: 30, grip: { at: [0, 0, 1], point: '-Z', flat: '+Y' } });
    const grip = gripTransform(weapon, bounds);
    expect(grip.tipDistance).toBeCloseTo(25, 6);
    expect(grip.buttDistance).toBeCloseTo(5, 6);
    // The two together are the whole thing, which is what `lengthWorld` means.
    expect(grip.tipDistance + grip.buttDistance).toBeCloseTo(weapon.lengthWorld, 6);
  });

  it('measures along the point axis rather than the longest side', () => {
    // A bent stick is wider across than a straight one and no longer for it.
    const bent: MeshBounds = { min: [-4, -0.05, -1.5], max: [4, 0.05, 1.5] };
    expect(measuredLength(bent, '-Z')).toBeCloseTo(3, 9);
  });

  it('draws a broken asset at the wrong size rather than not at all', () => {
    // A zero-length mesh gets a scale of 1, not an infinity: the difference
    // between a bug somebody reports and a bug somebody shrugs at.
    const flat: MeshBounds = { min: [0, 0, 0], max: [0, 0, 0] };
    expect(gripTransform(weaponDefFixture(), flat).scale).toBe(1);
  });
});

describe('the weapons that actually ship', () => {
  const ids = ['sword_jian', 'stick_knot'] as const;

  it.each(ids)('%s validates and describes its own mesh', (id) => {
    const result = validateWeaponDef(JSON.parse(readFileSync(join(ITEMS, id, `${id}.weapondef.json`), 'utf8')));
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const weapon = result.value;
    expect(weapon).not.toBeNull();
    if (!weapon) return;

    const bounds = boundsOf(join(ITEMS, id, weapon.meshRef));
    // The grip has to be on the thing, or the hand has missed it.
    for (let axis = 0; axis < 3; axis += 1) {
      expect(weapon.grip.at[axis]).toBeGreaterThanOrEqual((bounds.min[axis] ?? 0) - 1e-6);
      expect(weapon.grip.at[axis]).toBeLessThanOrEqual((bounds.max[axis] ?? 0) + 1e-6);
    }
    // And nearer the butt than the tip, or `point` is the wrong way round.
    const grip = gripTransform(weapon, bounds);
    expect(grip.tipDistance).toBeGreaterThan(grip.buttDistance);
    expect(grip.tipDistance + grip.buttDistance).toBeCloseTo(weapon.lengthWorld, 4);
  });

  it.each(ids)('%s names sockets the pig actually has', (id) => {
    const weapon = validateWeaponDef(
      JSON.parse(readFileSync(join(ITEMS, id, `${id}.weapondef.json`), 'utf8')),
    ).value;
    const skeleton = validateSkeleton(
      JSON.parse(readFileSync(join(process.cwd(), 'assets', 'units', 'biped.skeleton.json'), 'utf8')),
    ).value;
    expect(weapon).not.toBeNull();
    expect(skeleton).not.toBeNull();
    if (!weapon || !skeleton) return;
    expect(checkWeaponSockets(weapon, skeleton.sockets.map((socket) => socket.id))).toEqual([]);
  });

  it('carries no skin and no animation, because a weapon is rigid', () => {
    for (const id of ids) {
      const json = readGlbJson(new Uint8Array(readFileSync(join(ITEMS, id, `${id}.glb`)))) as {
        skins?: unknown[];
        animations?: unknown[];
      };
      expect(json.skins ?? []).toEqual([]);
      expect(json.animations ?? []).toEqual([]);
    }
  });

  it('draws both at a size a pig could hold', () => {
    // Between a third of a body and a whole one. Not a taste: `lengthWorld` is
    // in the units a body is 55.65 tall, and the mesh it scales was authored at
    // about 3 -- so typing the mesh's own length into the field is the easy slip
    // and it draws a sword the size of a coin.
    for (const id of ids) {
      const weapon = validateWeaponDef(
        JSON.parse(readFileSync(join(ITEMS, id, `${id}.weapondef.json`), 'utf8')),
      ).value;
      expect(weapon?.lengthWorld ?? 0).toBeGreaterThan(55.65 / 3);
      expect(weapon?.lengthWorld ?? 0).toBeLessThan(55.65);
    }
  });
});

describe('vector helpers', () => {
  it('cross and dot agree with the right-hand rule', () => {
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });
});

/**
 * The pig's own calibration, against the four things it was asked to be.
 *
 * Pure, and no three: a bone's world matrix comes from `poseWorldMatrices`, the
 * socket's rotation from the document, and canonical weapon space from
 * `grip.ts`. So "the blade points forward and the flats face sideways" is an
 * arithmetic claim about committed files rather than something read off a
 * screenshot -- which matters, because it is the requirement that was got wrong
 * the first time and looked *almost* right in a picture.
 */
describe('how the pig holds a sword', () => {
  const nodes = readNodeTree(
    splitGlb(new Uint8Array(readFileSync(join(UNIT_DIR, 'pig_a_pose_full.glb')))),
  );
  const detected = namingOf(nodes);
  if (detected === 'unknown') throw new Error('the pig rig is in no vocabulary this project reads');
  const naming: NamingSpec = detected;
  const frame = bodyFrame(nodes, naming);
  if (!frame) throw new Error('the pig rig has no measurable body frame');
  const skeleton = validateSkeleton(
    JSON.parse(readFileSync(join(process.cwd(), 'assets', 'units', 'biped.skeleton.json'), 'utf8')),
  ).value;
  if (!skeleton) throw new Error('biped.skeleton.json does not validate');

  const FORWARD = frame.forward;
  const UP = frame.up;
  const hipsBone = boneNode(nodes, naming, 'hips');
  const handBone = boneNode(nodes, naming, 'rightHand');
  const headBone = boneNode(nodes, naming, 'head');
  if (!hipsBone || !handBone || !headBone) throw new Error('the pig rig is missing a bone this file measures from');
  /** How tall the rig stands in its own units, so thresholds are scale-free. */
  const RIG_HEIGHT = 0.998;
  const swordDef = validateWeaponDef(
    JSON.parse(readFileSync(join(ITEMS, 'sword_jian', 'sword_jian.weapondef.json'), 'utf8')),
  ).value;
  if (!swordDef) throw new Error('sword_jian.weapondef.json does not validate');
  /** `lateral` points to the pig's left, so the right is its negation. */
  const RIGHT: Vec3 = [-frame.lateral[0], -frame.lateral[1], -frame.lateral[2]];

  /** Canonical weapon axes in world space, for a socket in a given pose. */
  function axesIn(socketId: string, pose: PoseRotations): { blade: Vec3; flat: Vec3 } {
    const socket = skeleton?.sockets.find((entry) => entry.id === socketId);
    const bone = nodes.find((node) => node.name === socket?.bone);
    if (!socket || !bone) throw new Error(`no socket ${socketId}`);
    const world = poseWorldMatrices(nodes, pose)[bone.index] ?? [];
    // The bone's rotation with its scale divided out, as three basis vectors.
    const basis = [0, 1, 2].map((column) => {
      const raw: Vec3 = [world[column * 4] ?? 0, world[column * 4 + 1] ?? 0, world[column * 4 + 2] ?? 0];
      const length = Math.hypot(...raw) || 1;
      return [raw[0] / length, raw[1] / length, raw[2] / length] as Vec3;
    });
    const pivot = quatFromEulerXyz((socket.rotationDeg ?? [0, 0, 0]) as Vec3);
    const intoWorld = (local: Vec3): Vec3 => {
      const turned = rotateByQuat(pivot, local);
      const out: [number, number, number] = [0, 0, 0];
      basis.forEach((axis, index) => {
        const k = turned[index] ?? 0;
        out[0] += axis[0] * k;
        out[1] += axis[1] * k;
        out[2] += axis[2] * k;
      });
      return out;
    };
    // Canonical weapon space: blade +Y, flat +Z.
    return { blade: intoWorld([0, 1, 0]), flat: intoWorld([0, 0, 1]) };
  }

  const axesAt = (socketId: string, ms: number): { blade: Vec3; flat: Vec3 } =>
    axesIn(socketId, poseAt(PIG_STRIKE, { nodes, naming }, ms));

  /**
   * How far the jian's tip reaches from the grip, in the *rig's* own units.
   *
   * The document says 38 world units on a body drawn at 55.65, and the rig
   * stands 0.998 in the units its bones are in -- so a length in one has to be
   * carried into the other before it can be compared with where a bone is.
   */
  const REACH =
    (gripTransform(swordDef, boundsOf(join(ITEMS, 'sword_jian', 'sword_jian.glb'))).tipDistance /
      DEFAULT_CANONICAL_HEIGHT) *
    RIG_HEIGHT;

  /** Where a bone sits, in the body's axes and relative to the hips. */
  const placeIn = (bone: number, pose: PoseRotations): { right: number; up: number; forward: number } => {
    const world = poseWorldMatrices(nodes, pose);
    const m = world[bone] ?? [];
    const hipsAt = world[hipsBone.index] ?? [];
    const from: Vec3 = [
      (m[12] ?? 0) - (hipsAt[12] ?? 0),
      (m[13] ?? 0) - (hipsAt[13] ?? 0),
      (m[14] ?? 0) - (hipsAt[14] ?? 0),
    ];
    return {
      right: dot(from, RIGHT),
      up: dot(from, frame.up),
      forward: dot(from, frame.forward),
    };
  };

  /**
   * Where the *tip* of the held blade is, which is what the player watches.
   *
   * Spec 139 asserted all of this on the hand, because before spec 140 there was
   * no weapon and the hand was the only proxy for it. There is one now, and the
   * two answers came apart the moment the wind-up was rebuilt around the elbow:
   * a folded elbow puts the hand beside the ear rather than above the head, and
   * the sword above the head. A lever amplifies -- the hand travels 0.43 between
   * the load and the blow and the tip travels three times that -- so the hand
   * had stopped being a proxy for anything.
   */
  const tipAt = (ms: number): { right: number; up: number; forward: number } => {
    const pose = poseAt(PIG_STRIKE, { nodes, naming }, ms);
    const hand = placeIn(handBone.index, pose);
    const { blade } = axesIn('weapon.main', pose);
    return {
      right: hand.right + dot(blade, RIGHT) * REACH,
      up: hand.up + dot(blade, frame.up) * REACH,
      forward: hand.forward + dot(blade, frame.forward) * REACH,
    };
  };

  /**
   * The same, in the pig's idle -- which is where a sheathed sword is judged.
   *
   * A scabbard is strapped to the chest, so it rides whatever the chest does:
   * at the swing's guard key the chest is already yawed ten degrees into the
   * wind-up, and a sword hanging correctly off it leans by exactly that much.
   * Asserting "no sideways lean" against that pose measures the *torso*, not the
   * scabbard, and the only way to pass it would be to hang the sword crooked so
   * it comes out straight one frame in eight hundred.
   *
   * Idle is also the pose `weapon.stow` was calibrated at, and the pose a pig
   * wearing a sword is in essentially all of the time.
   */
  const idlePose = clipPoseAt(
    splitGlb(new Uint8Array(readFileSync(join(CLIP_DIR, 'idle.glb')))),
    nodes,
    0,
  );

  it('points the blade forward and a little up at guard, never down', () => {
    const { blade } = axesAt('weapon.main', STRIKE_KEY_MS.guard);
    expect(dot(blade, FORWARD)).toBeGreaterThan(0.85);
    // 20 degrees up: sin(20) is 0.34.
    expect(dot(blade, UP)).toBeCloseTo(0.34, 1);
  });

  it('holds it edge up and down, with the flats facing the pig’s sides', () => {
    // The requirement stated three ways because it is the one that was wrong:
    // the flat's normal is the body's lateral axis, it is level, and the blade
    // is therefore edge-on when the pig is seen head-on.
    const { flat } = axesAt('weapon.main', STRIKE_KEY_MS.guard);
    expect(Math.abs(dot(flat, RIGHT))).toBeGreaterThan(0.98);
    expect(Math.abs(dot(flat, UP))).toBeLessThan(0.1);
  });

  it('comes back to the same roll it started in', () => {
    // Mid-swing the blade *must* roll -- a grip is fixed to the hand, the arm
    // turns, and an edge that never turned into the cut would be a blade held
    // rigid through an arc. What is required is that the rest orientation is
    // the one asked for at both ends, so a swing does not leave the sword
    // quietly rotated in the hand.
    const start = axesAt('weapon.main', STRIKE_KEY_MS.guard);
    const end = axesAt('weapon.main', STRIKE_KEY_MS.settle);
    expect(dot(start.flat, end.flat)).toBeGreaterThan(0.999);
    expect(dot(start.blade, end.blade)).toBeGreaterThan(0.999);
  });

  it('never dangles the blade straight down out of the hand', () => {
    for (const ms of [0, 130, 300, 400, 500, 600, 800]) {
      const { blade } = axesAt('weapon.main', ms);
      expect(dot(blade, UP), `blade points down at ${ms}ms`).toBeGreaterThan(-0.95);
    }
  });

  it('carries the blade up and back to load, then down and across to strike', () => {
    // The chop, stated as a direction rather than as a hand position -- and the
    // distinction is the whole point of this test existing. Every assertion
    // beside it measures where the hand *is*, and the hand kept going over the
    // shoulder perfectly while the blade coming out of it pointed at the floor:
    // re-solving `weapon.main` left five wrist poses a constant 105 degrees out,
    // because they were authored against the grip it replaced, and nothing in
    // the tree was looking at what the hand carried.
    const load = axesAt('weapon.main', STRIKE_KEY_MS.load);
    expect(dot(load.blade, UP), 'blade up at the load').toBeGreaterThan(0.4);
    expect(dot(load.blade, FORWARD), 'blade back at the load').toBeLessThan(-0.3);

    const contact = axesAt('weapon.main', STRIKE_CONTACT_MS);
    expect(dot(contact.blade, UP), 'blade down at contact').toBeLessThan(-0.35);

    // The strike is a *reversal*, which is what makes it a chop rather than a
    // poke: the blade ends up on the far side of horizontal from where it was.
    expect(dot(load.blade, contact.blade)).toBeLessThan(0);
  });

  it('lifts the tip clear over the head and sweeps it across the body', () => {
    // The silhouette argument, moved onto the thing that casts the silhouette.
    // Spec 139 made all three of these claims about the *hand*, because there
    // was no weapon then and the hand was the only proxy for one. Rebuilding the
    // wind-up around the elbow broke the proxy and not the swing: a folded elbow
    // puts the hand beside the ear and the sword above the head, which is what
    // an arm does with a sword and what the hand alone can no longer see.
    const head = placeIn(headBone.index, poseAt(PIG_STRIKE, { nodes, naming }, STRIKE_KEY_MS.load));
    const load = tipAt(STRIKE_KEY_MS.load);
    expect(load.up, 'tip over the head at the load').toBeGreaterThan(head.up);
    expect(load.forward, 'tip behind the body at the load').toBeLessThan(-0.1 * RIG_HEIGHT);

    // A swing and not a prod: the tip starts on the wielding side and finishes
    // past the midline on the other.
    expect(load.right).toBeGreaterThan(0);
    expect(tipAt(STRIKE_CONTACT_MS).right).toBeLessThan(0);
  });

  it('carries the tip a body height of arc between the load and the blow', () => {
    // A lever amplifies. The hand travels 0.43 of a body height through the
    // strike and the tip travels three times that, which is the whole reason a
    // sword reads at forty pixels when a fist does not.
    let arc = 0;
    let previous = tipAt(STRIKE_KEY_MS.load);
    for (let ms = STRIKE_KEY_MS.load + 5; ms <= STRIKE_CONTACT_MS; ms += 5) {
      const now = tipAt(ms);
      arc += Math.hypot(now.right - previous.right, now.up - previous.up, now.forward - previous.forward);
      previous = now;
    }
    expect(arc).toBeGreaterThan(1.0 * RIG_HEIGHT);
  });

  it('raises the blade over the whole wind-up rather than in one whip', () => {
    // What was reported: "movement has 2 phases of raising a sword". It was not
    // two poses. The blade held still for 140ms, turned a hundred degrees in
    // 80ms, and held still for another 160ms -- a dead beat, a whip, a dead
    // beat -- which reads as two movements with something happening between
    // them. Neither the keys nor a position graph shows it; only the rate does.
    //
    // So: find when the raise is a tenth done and when it is nine tenths done,
    // and require that span to be a real fraction of the wind-up. A whip
    // between two stalls crosses both thresholds almost at once -- the version
    // this replaced spans 70ms of its 300, and this one spans 120. Counting
    // humps in the rate would *not* catch it: there was only ever one hump, and
    // the problem was the stillness on either side of it.
    const STEP = 10;
    const times: number[] = [];
    const travelled: number[] = [];
    let sum = 0;
    let previous = axesAt('weapon.main', 0).blade;
    for (let ms = STEP; ms <= STRIKE_KEY_MS.coil; ms += STEP) {
      const now = axesAt('weapon.main', ms).blade;
      sum += Math.acos(Math.max(-1, Math.min(1, dot(previous, now))));
      previous = now;
      times.push(ms);
      travelled.push(sum);
    }
    const total = travelled[travelled.length - 1] ?? 0;
    expect(total).toBeGreaterThan(1);

    const crosses = (fraction: number): number =>
      times[travelled.findIndex((amount) => amount >= fraction * total)] ?? 0;
    const spread = crosses(0.9) - crosses(0.1);
    expect(spread, 'the raise is spread across the wind-up').toBeGreaterThan(0.35 * STRIKE_KEY_MS.coil);
  });

  it('keeps the blade above the horizon for the whole wind-up', () => {
    // What a player actually reports is "it points at the ground for a moment
    // before it swings", and that is a statement about the frames *between*
    // keys -- an arm on its way from one pose to another passes through
    // everything in between, and a blade is a long lever on the end of it. So
    // this samples rather than checking the keys, which are the only thing
    // anybody reads while authoring.
    for (let ms = 0; ms <= STRIKE_KEY_MS.load; ms += 10) {
      const { blade } = axesAt('weapon.main', ms);
      expect(dot(blade, UP), `blade dips below the horizon at ${ms}ms`).toBeGreaterThan(-0.1);
    }
  });

  it('steps the wielding-side leg back to brace, then drives it through', () => {
    // The right leg is the wielding side. It goes back during the wind-up and
    // comes through as the blow lands -- which is where the weight for the
    // swing comes from, and without it the pig is a torso rotating in place.
    //
    // The *stance* half of this claim -- how far, and that the left foot stays
    // put while it happens -- lives in `pig-strike.test.ts` beside the table it
    // is a fact about. What this file keeps is the half spec 140 cares about:
    // that the leg on the sword's side is the one that moves.
    const footAt = (role: 'rightFoot' | 'leftFoot', ms: number): number => {
      const bone = boneNode(nodes, naming, role);
      if (!bone) throw new Error(`no ${role}`);
      const world = poseWorldMatrices(nodes, poseAt(PIG_STRIKE, { nodes, naming }, ms))[bone.index] ?? [];
      const hips = boneNode(nodes, naming, 'hips');
      const at = worldPosition(hips ?? bone);
      return dot([(world[12] ?? 0) - at[0], (world[13] ?? 0) - at[1], (world[14] ?? 0) - at[2]], FORWARD);
    };

    const guardGap = footAt('rightFoot', STRIKE_KEY_MS.guard) - footAt('leftFoot', STRIKE_KEY_MS.guard);
    const loadGap = footAt('rightFoot', STRIKE_KEY_MS.load) - footAt('leftFoot', STRIKE_KEY_MS.load);
    const contactGap = footAt('rightFoot', STRIKE_KEY_MS.contact) - footAt('leftFoot', STRIKE_KEY_MS.contact);

    // Braced: the right foot is further behind the left at the top of the
    // wind-up than it was at rest. The threshold used to be 0.15 and the swing
    // used to clear it easily -- on a gap that was closing from both ends,
    // because the left foot was sliding forward under the pelvis by more than
    // the right foot was stepping back. Planting the left foot cost this
    // two thirds of its number and none of its motion.
    //
    // The two margins are deliberately loose, and looser again since spec 244
    // put the stepping foot on the ground -- which bounded the step at both
    // ends, since a leg that may not leave the floor cannot reach as far back
    // and a body that must stay over its own feet cannot drive as far through.
    // They are here to say the step is a step rather than noise; how far it
    // goes is `pig-strike.test.ts`'s to bound, beside the table it is a fact
    // about, and a second copy of those numbers here is a second thing to
    // retune every time the stance moves. This is exactly that second copy,
    // caught: it went on demanding 0.22 of drive-through for a spec after the
    // measurement said 0.116.
    expect(loadGap).toBeLessThan(guardGap - 0.05);
    // Driven through: by contact it has come forward past where it started.
    expect(contactGap).toBeGreaterThan(loadGap + 0.1);
    expect(contactGap).toBeGreaterThan(guardGap);
  });

  it('sheathes it upright and leaning back, in the pig’s own fore-aft plane', () => {
    const { blade, flat } = axesIn('weapon.stow', idlePose);
    // Hilt up and forward, tip down and back: 30 degrees off vertical, so the
    // blade axis is -cos(30) up and -sin(30) forward.
    expect(dot(blade, UP)).toBeCloseTo(-Math.cos(Math.PI / 6), 1);
    expect(dot(blade, FORWARD)).toBeCloseTo(-Math.sin(Math.PI / 6), 1);
    // No sideways lean: it lies in the plane through the spine and the facing
    // direction rather than crossing the back diagonally.
    expect(Math.abs(dot(blade, RIGHT))).toBeLessThan(0.12);
    // Same roll as in the hand.
    expect(Math.abs(dot(flat, RIGHT))).toBeGreaterThan(0.95);
  });

  it('wears it on the left, which is the side a right hand draws from', () => {
    // The socket's *offset*, which is the half of a calibration that a rotation
    // cannot express and that is easy to leave at zero without noticing: a
    // correctly-angled sword hung on the body's midline looks like it is growing
    // out of the spine. The pig wields right-handed, so the scabbard goes on the
    // left, and it goes out far enough to clear the torso rather than merely
    // being on the correct side of it.
    const socket = skeleton?.sockets.find((entry) => entry.id === 'weapon.stow');
    const bone = nodes.find((node) => node.name === socket?.bone);
    const spine = boneNode(nodes, naming, 'chest');
    const shoulder = boneNode(nodes, naming, 'leftArm');
    if (!socket || !bone || !spine || !shoulder) throw new Error('no stow socket to measure');

    const world = poseWorldMatrices(nodes, idlePose);
    const offset = socket.offset ?? [0, 0, 0];
    const m = world[bone.index] ?? [];
    // The socket's own place: the bone's origin plus its offset, taken through
    // the bone's basis, which is what `socketPivot` builds in the scene graph.
    const place = (axis: number): number =>
      (m[12 + axis] ?? 0) +
      (m[axis] ?? 0) * (offset[0] ?? 0) +
      (m[4 + axis] ?? 0) * (offset[1] ?? 0) +
      (m[8 + axis] ?? 0) * (offset[2] ?? 0);

    const midline = world[spine.index] ?? [];
    const from: Vec3 = [place(0) - (midline[12] ?? 0), place(1) - (midline[13] ?? 0), place(2) - (midline[14] ?? 0)];
    const sideways = dot(from, RIGHT);

    // Left of the spine, by most of the way out to the shoulder -- the body's
    // own width rather than a number chosen here, so this survives a re-rig.
    const arm = worldPosition(shoulder);
    const half = Math.abs(
      dot([arm[0] - (midline[12] ?? 0), arm[1] - (midline[13] ?? 0), arm[2] - (midline[14] ?? 0)], RIGHT),
    );
    expect(half).toBeGreaterThan(0);
    expect(sideways).toBeLessThan(-0.5 * half);
  });
});
