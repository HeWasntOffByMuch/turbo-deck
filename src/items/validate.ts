/**
 * The half of validating a weapon that a JSON Schema cannot do (spec 140).
 *
 * The schema checks the shape; this checks the things that are only wrong in
 * combination. There is one that matters and it is the reason this file exists:
 * **a grip's two axes have to span a plane.** `point: "+Z"` with `flat: "+Z"`
 * (or `"-Z"`) passes every structural check, produces a zero-length cross
 * product, and from there a basis with a zero column, a quaternion of NaNs, and
 * a weapon that is not drawn at all. A weapon that renders *wrong* gets noticed
 * in a second; a weapon that renders *nowhere* gets blamed on the loader.
 *
 * Pure, and part of the deterministic core -- it reads a document and never a
 * file, so the Studio tab and CI can both run it.
 */

import { error, pointer, warning, type Issue } from '../units/issues.js';
import { validateAgainstSchema } from '../units/schema.js';
import { axesArePerpendicular } from './grip.js';
import type { WeaponDef } from './types.js';

export interface WeaponResult {
  readonly value: WeaponDef | null;
  readonly issues: readonly Issue[];
}

/**
 * How long a one-handed weapon may sensibly be, as a fraction of a body.
 *
 * A warning and not an error, because "too long" is a judgement and somebody
 * will want a pike. The bound exists because `lengthWorld` is in world units --
 * a number in the tens -- and the mesh it scales is in the units a modelling
 * tool exported, which is a number near one. Typing the mesh's own length into
 * the field is the obvious slip, and it draws a sword the size of a coin with
 * nothing anywhere complaining.
 */
const SHORT_FOR_A_WEAPON = 4;
const LONG_FOR_A_WEAPON = 200;

export function validateWeaponDef(document: unknown): WeaponResult {
  const structural = validateAgainstSchema('weapondef', document);
  if (structural.length > 0) return { value: null, issues: structural };

  const weapon = document as WeaponDef;
  const issues: Issue[] = [];

  if (!axesArePerpendicular(weapon.grip.point, weapon.grip.flat)) {
    issues.push(
      error(
        'weapon.grip.degenerate',
        pointer('grip', 'flat'),
        `the grip's point axis (${weapon.grip.point}) and flat axis (${weapon.grip.flat}) are the same line, so they ` +
          'do not span a plane. There is no basis to build from two parallel axes, and the transform that comes out ' +
          'of one is NaN -- the weapon would not be drawn at all rather than drawn wrongly. `flat` is the normal to ' +
          'the flat of the blade, so for a blade running -Z it is one of +/-X or +/-Y.',
      ),
    );
  }

  if (weapon.lengthWorld < SHORT_FOR_A_WEAPON) {
    issues.push(
      warning(
        'weapon.length.tiny',
        pointer('lengthWorld'),
        `${weapon.lengthWorld} world units is smaller than a fist. This field is the length the weapon is DRAWN at, ` +
          'in the same units a body is 55 tall -- it is not the length the mesh was authored at, which is usually ' +
          'near 1. Putting the mesh\'s own length here is the slip this warning exists for.',
      ),
    );
  } else if (weapon.lengthWorld > LONG_FOR_A_WEAPON) {
    issues.push(
      warning(
        'weapon.length.huge',
        pointer('lengthWorld'),
        `${weapon.lengthWorld} world units is several bodies long. Deliberate for a siege weapon and a typo otherwise.`,
      ),
    );
  }

  // A stow socket the same as the held socket means "sheathe it into your hand",
  // which is not a thing -- and it would draw the weapon twice on the frame the
  // switch happens.
  if (weapon.stowSocket !== undefined && weapon.stowSocket === weapon.socket) {
    issues.push(
      error(
        'weapon.socket.same',
        pointer('stowSocket'),
        `"${weapon.socket}" is both where this is held and where it is stowed, so putting it away would leave it ` +
          'exactly where it was.',
      ),
    );
  }

  return { value: issues.some((issue) => issue.severity === 'error') ? null : weapon, issues };
}

/**
 * Checks a weapon against the sockets a skeleton actually has.
 *
 * Separate from the document check because it needs two documents, and because a
 * weapon is not bound to one rig -- the same sword is held by everything with a
 * `weapon.main`. So this is what a *pairing* is checked by, and a weapon on its
 * own is never wrong for naming a socket some other skeleton lacks.
 */
export function checkWeaponSockets(weapon: WeaponDef, socketIds: readonly string[]): readonly Issue[] {
  const issues: Issue[] = [];
  const has = new Set(socketIds);
  if (!has.has(weapon.socket)) {
    issues.push(
      error(
        'weapon.socket.missing',
        pointer('socket'),
        `this skeleton has no socket called "${weapon.socket}". It has: ${socketIds.join(', ') || '(none)'}`,
      ),
    );
  }
  if (weapon.stowSocket !== undefined && !has.has(weapon.stowSocket)) {
    issues.push(
      warning(
        'weapon.stowSocket.missing',
        pointer('stowSocket'),
        `this skeleton has no socket called "${weapon.stowSocket}", so a sheathed weapon simply will not be drawn ` +
          'on it. A warning rather than an error: a rig with nowhere to hang a sword is a rig, not a mistake.',
      ),
    );
  }
  return issues;
}
