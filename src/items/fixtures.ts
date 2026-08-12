/**
 * A valid weapon document for the tests to break (spec 140).
 *
 * Same rule as `src/units/fixtures.ts`: a builder taking a patch, so a test
 * starts from something known-good and mutates one field, and a failure names
 * the rule that broke rather than a wall of unrelated schema errors. Shared by
 * reference is how one test poisons the next, so this returns a fresh object.
 */

import type { WeaponDef } from './types.js';

/**
 * A blade along -Z with its flat normal on +Y, which is the shape both supplied
 * meshes turned out to have. Held at the middle of a grip that is not at the
 * mesh origin, because a grip at the origin would let a missing offset pass.
 */
export function weaponDefFixture(patch: Partial<WeaponDef> = {}): WeaponDef {
  return {
    formatVersion: 1,
    id: 'sword.test',
    name: 'Test Sword',
    meshRef: 'sword.test.glb',
    socket: 'weapon.main',
    stowSocket: 'weapon.stow',
    grip: { at: [0, 0, 1], point: '-Z', flat: '+Y' },
    lengthWorld: 36,
    ...patch,
  };
}
