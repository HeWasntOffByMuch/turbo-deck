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
import { checkWeaponSockets, validateWeaponDef } from './validate.js';
import { validateSkeleton } from '../units/validate.js';
import type { Vec3 } from './types.js';

const ITEMS = join(process.cwd(), 'assets', 'items');

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
      JSON.parse(readFileSync(join(process.cwd(), 'assets', 'units', 'pig.skeleton.json'), 'utf8')),
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
