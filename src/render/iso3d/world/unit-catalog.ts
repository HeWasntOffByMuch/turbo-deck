/**
 * Which entities are drawn from an authored unit (spec 111).
 *
 * A table with one row in it today, and that is the honest state of things: the
 * dev mannequin is the only authored unit that exists, and everything else in
 * the arena is drawn by the procedural critter and mech rigs it has always been
 * drawn by. The alternative — flipping the whole roster onto a format with one
 * document in it — would be trading a world that renders for a world that does
 * not, in exchange for a claim about architecture.
 *
 * So this file is the seam, and its shape is the point: adding a unit is adding
 * a row, and an entity with no row falls through to exactly what it does today.
 * `appearanceOf` still decides what an entity *is*; this decides only whether
 * something authored has been made for it.
 *
 * Pure: no three.js, no fetch, no URLs. It names a unit; the loader beside it
 * knows where the bytes are.
 */

import type { Appearance } from './appearance.js';
import { authoredUnitAssets, authoredUnitIds, type AuthoredUnitId } from './unit-assets.js';

export type { AuthoredUnitId };

/** The id the player entity is drawn under; see `appearanceOf`. */
export const PLAYER_TYPE_ID = 'player';

/**
 * The type ids drawn from an authored unit.
 *
 * Monsters **and** the player. It was monsters only, on the grounds that the
 * player's rig carries the cloth solve, the coat palette and the critter tuning
 * the whole Play tab was built around, and that swapping it out to demonstrate a
 * loader would trade a world that renders for a claim about architecture. That
 * was the right call while the only authored unit was a grey untextured
 * mannequin; it stops being right the moment a real generated character exists,
 * because the player is the body somebody looks at for hours and it is the one
 * that has to prove the format.
 *
 * So the default table now has a row: the player is the generated unit. Every
 * other entity still falls through to exactly what it drew before, which is the
 * property this seam exists to keep -- adding a unit is adding a row, and a
 * missing row changes nothing.
 */
export const DEFAULT_AUTHORED_UNITS: Readonly<Record<string, AuthoredUnitId>> = {
  [PLAYER_TYPE_ID]: 'pig_a_pose_full',
  // The merchant (spec 244), and the second row this table has ever had. It is
  // the fox because a body somebody walks up to and talks to is the other one
  // that has to prove the format -- and because a friendly NPC is exactly what
  // the seam is for: one row, and everything else in the roster still draws
  // what it drew before.
  //
  // The fox's own state machine has an idle, a locomotion blend and a death,
  // which is the whole of what this body ever does. Its swing came across with
  // it and reaches nothing, since a friendly row has no attack to trigger one.
  'npc.merchant': 'fox_a_pose',
};

const authored = new Map<string, AuthoredUnitId>(Object.entries(DEFAULT_AUTHORED_UNITS));

/**
 * Points a set of type ids at authored units.
 *
 * Exists so a preview script, a test, or a future roster file can populate the
 * table without this module having to know which of them did it. Replaces
 * rather than merges: a caller setting the table is describing the whole roster,
 * and a merge would make "remove a unit" impossible to express.
 *
 * Which is why {@link DEFAULT_AUTHORED_UNITS} has to be spread in by the caller
 * that wants it. The Play tab calls this on mount with whatever `?units=` says,
 * and an empty query is still a whole roster -- so a default living only in this
 * module's initial map was wiped before the first frame, and the player kept
 * drawing as the critter rig with nothing anywhere reporting a problem.
 */
export function setAuthoredUnits(entries: Readonly<Record<string, AuthoredUnitId>>): void {
  authored.clear();
  for (const [typeId, unitId] of Object.entries(entries)) authored.set(typeId, unitId);
}

/**
 * Reads the roster off a `?units=` query parameter.
 *
 * `?units=grazer:mannequin,ravager:mannequin`. A dev switch and nothing more --
 * the same shape as `?seed=`, renderer-only, and off unless somebody types it.
 * It exists because the alternative for seeing an authored unit in the game was
 * editing a source file, which means the one thing this spec is *for* is the one
 * thing nobody would casually check.
 *
 * Unparseable pairs and unknown unit ids are skipped rather than thrown on: this
 * is a URL somebody typed, and a typo in it should cost a missing monster and
 * not a blank tab.
 */
export function unitsFromQuery(search: string = globalThis.location?.search ?? ''): Readonly<Record<string, AuthoredUnitId>> {
  const raw = new URLSearchParams(search).get('units');
  if (raw === null || raw.trim() === '') return {};
  const entries: Record<string, AuthoredUnitId> = {};
  for (const pair of raw.split(',')) {
    const [typeId, unitId] = pair.split(':');
    // Checked against what this build actually has rather than against a union
    // type: the roster is the contents of `assets/units/` now, so the set is
    // not knowable at compile time. A name nothing was exported under is
    // skipped and said out loud -- it is almost always a typo, and silently
    // drawing the old rig is how a typo survives.
    if (!typeId || !unitId) continue;
    if (authoredUnitAssets(unitId) === null) {
      console.error(`[units] no authored unit called "${unitId}". This build has: ${authoredUnitIds().join(', ') || '(none)'}`);
      continue;
    }
    entries[typeId.trim()] = unitId;
  }
  return entries;
}

/** What is in the table right now, for a panel or a test. */
export function authoredUnits(): Readonly<Record<string, AuthoredUnitId>> {
  return Object.fromEntries(authored);
}

/**
 * The authored unit for a body, or null to draw it the way it is drawn today.
 *
 * Only ever a monster. A projectile is a few pixels of geometry with no
 * skeleton, a prop does not move, and the player is deliberately out of scope
 * above — so a table entry naming one of those is ignored rather than honoured,
 * which keeps a typo in a roster file from putting a mannequin where the arrow
 * should be.
 */
export function authoredUnitFor(look: Appearance): AuthoredUnitId | null {
  // A projectile is a few pixels of geometry with no skeleton and a prop does
  // not move, so neither can be an authored unit however the table is filled in.
  if (look.rig !== 'monster' && look.rig !== 'player') return null;
  const id = authored.get(look.typeId) ?? null;
  // A row naming a unit this build does not have draws the old rig rather than
  // nothing: the default table ships pointing at a generated unit, and a
  // checkout where that unit has not been baked should still render a game.
  return id !== null && authoredUnitAssets(id) !== null ? id : null;
}
