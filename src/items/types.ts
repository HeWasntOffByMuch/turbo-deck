/**
 * A held object, as a document (spec 140).
 *
 * Mirrors `schemas/weapondef.schema.json` field for field, and is the shape a
 * *validated* document has -- handed out by `validate.ts` and by nothing else,
 * the same rule `src/units/types.ts` keeps.
 *
 * The reason this is not a unitdef, said once: **a weapon is rigid**. It has no
 * bind pose to be wrong, no skin weights to fail to sum, no clips to retarget
 * and no family to belong to. Every document in `src/units/` exists to manage
 * one of those for a thing that deforms. What a weapon has instead is a grip,
 * which is three numbers and two axes, and nothing else in this project needed
 * one.
 */

import type { Axis, Vec3 } from '../units/types.js';

export type { Axis, Vec3 };

/**
 * How a mesh meets a hand.
 *
 * Every field is a measurement of one file. It is deliberately not promoted to
 * a project-wide convention even though the two weapons that exist happen to
 * agree -- they came out of the same generator on the same afternoon, and the
 * third will not.
 */
export interface Grip {
  /** The point in mesh coordinates that sits in the palm, before scaling. */
  readonly at: Vec3;
  /** The mesh axis running toward the business end. */
  readonly point: Axis;
  /**
   * The mesh axis normal to the flat of the blade.
   *
   * `point` alone leaves the weapon free to roll about its own length, and a
   * sword held edge-up rather than flat-up is wrong in a way nobody can put a
   * name to and everybody can see. Must be perpendicular to `point`; the
   * validator refuses the parallel and antiparallel cases, because those are
   * the ones that produce a degenerate basis and therefore a NaN transform and
   * therefore a weapon that is not drawn at all.
   */
  readonly flat: Axis;
}

export interface WeaponProvenance {
  readonly source?: string;
  readonly generator?: string;
  readonly note?: string;
}

export interface WeaponDef {
  /** A note for whoever opens the file next; JSON has no comments. */
  readonly $comment?: string;
  readonly formatVersion: 1;
  readonly id: string;
  /** What a player would call it. Not an item id -- two items may share a model. */
  readonly name: string;
  readonly meshRef: string;
  /** The socket it is held in when drawn. */
  readonly socket: string;
  /** Where it rides when sheathed, or absent for a thing with nowhere to hang. */
  readonly stowSocket?: string;
  readonly grip: Grip;
  /**
   * How long it is drawn, tip to butt, in world units.
   *
   * A length rather than a scale factor, for the reason a unit's import scale is
   * measured rather than typed: nobody can check a scale factor, and anybody can
   * hold a length up against the body standing beside it.
   */
  readonly lengthWorld: number;
  readonly provenance?: WeaponProvenance;
}
