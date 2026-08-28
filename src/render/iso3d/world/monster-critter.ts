/**
 * Which monsters are drawn as animals rather than as machines.
 *
 * `appearance.ts` answers which *rig* draws a body and `monster-look.ts` answers
 * what a mech rig is built out of. This answers the question neither could: some
 * bodies are not mech rigs at all. Every monster in the arena has been a
 * `MechRig` since spec 062 -- a chassis on articulated legs, which is the right
 * silhouette for a stalker and the wrong one for a sheep, and no amount of
 * tuning in the look table turns one into the other. The critter rig that draws
 * the player has been sitting one directory up the whole time, already carrying
 * the walk cycle, the coat derivation and the ear wobble an animal needs.
 *
 * So this is the seam, and its shape is deliberately the same as the two files
 * beside it: **adding an animal is adding a row**, and a type id with no row
 * gets exactly the mech it got before. Nothing enumerates the monsters that are
 * animals; `scene.ts` asks about the one it is building and believes the answer.
 *
 * Pure: no three.js. It names a species and two numbers; the rig module knows
 * how to build one.
 */

import type { FigureTuning } from '../../cloth/params.js';
import type { CritterId } from '../../critters/index.js';

/**
 * A monster drawn as a critter: which animal, and how it is sized.
 *
 * The two figure knobs are the same pair the player's row carries and they do
 * the same job. `bodyScale` sizes the drawn animal against the *sim* radius it
 * is selected and collided by -- a species is authored at its own scale, and the
 * server's number is the one that has to be matched. `strideScale` gives back
 * the ground a scaled-down body's legs stopped covering, which is what keeps a
 * walk from skating: the gait is driven by how fast the body is actually
 * travelling, so a shorter leg at the same speed takes more steps than it should
 * unless it is told otherwise.
 */
export interface MonsterCritter {
  readonly species: CritterId;
  readonly figure: Pick<FigureTuning, 'bodyScale' | 'strideScale'>;
}

/**
 * The sheep, drawn at half the size it is authored.
 *
 * The species stands 42 units at the shoulder and is 57 nose to tail, which is
 * a full-grown ewe next to a player; `0.475` makes it a small one, about a
 * third of the player's drawn height. That is a look rather than a constraint,
 * and the constraint it has to stay inside is the sim's: `radius` in the
 * monster table halves with it, because the ring is what the cursor picks the
 * body by and a body drawn at half its collider is a target with a gap around
 * it.
 *
 * `strideScale` is the other half of the same change, and the one that is easy
 * to forget. The gait is driven by how fast the body is actually travelling, so
 * a leg scaled to half its length at an unchanged 62 move speed takes the same
 * number of steps to cover twice its own length -- which is a skate, not a
 * walk. Roughly `1 / bodyScale` gives the ground back, and
 * `monster-critter.test.ts` holds the pair to it -- 2.15 rather than the 2.105
 * that is exactly `1 / 0.475`, so the legs are covering fractionally more than
 * the body needs rather than fractionally less.
 */
const SHEEP: MonsterCritter = {
  species: 'sheep',
  figure: { bodyScale: 0.475, strideScale: 2.15 },
};

// A Map rather than a record, for the reason `monsterLookFor` is one: a type id
// arrives off the wire, and `CRITTER_MONSTERS['constructor']` on an object
// literal answers with something that is not a species at all.
const CRITTER_MONSTERS: ReadonlyMap<string, MonsterCritter> = new Map([['sheep', SHEEP]]);

/**
 * The animal a monster is drawn as, or `null` to build it the way it is built
 * today.
 *
 * The record is copied on the way out for the reason `monsterLookFor`'s are:
 * a rig may hold what it is handed, and two bodies of the same type must not
 * share one record.
 */
export function monsterCritterFor(typeId: string): MonsterCritter | null {
  const row = CRITTER_MONSTERS.get(typeId);
  if (row === undefined) return null;
  return { species: row.species, figure: { ...row.figure } };
}

/** Every type id drawn as an animal, for a test or a panel. Sorted, so it is stable. */
export function monsterCritterIds(): readonly string[] {
  return [...CRITTER_MONSTERS.keys()].sort();
}
