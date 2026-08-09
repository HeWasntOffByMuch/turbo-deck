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

/** Authored units this build knows about. */
export type AuthoredUnitId = 'mannequin';

/**
 * The monster type ids drawn from an authored unit.
 *
 * A monster rather than the player, on purpose. The player's rig carries the
 * cloth solve, the coat palette and the critter tuning the whole Play tab was
 * built around, and replacing it would be the largest visible change in the
 * game to demonstrate a loader. A monster is where a new unit belongs anyway:
 * it is the thing the Studio tab exists to make more of.
 *
 * Empty by default. The dev mannequin is opt-in through {@link setAuthoredUnits}
 * rather than wired to a real monster id, because it is a grey untextured
 * mannequin and shipping it into the arena as a live enemy would be a worse
 * default than the rig that is there.
 */
const authored = new Map<string, AuthoredUnitId>();

/**
 * Points a set of type ids at authored units.
 *
 * Exists so a preview script, a test, or a future roster file can populate the
 * table without this module having to know which of them did it. Replaces
 * rather than merges: a caller setting the table is describing the whole roster,
 * and a merge would make "remove a unit" impossible to express.
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
    if (!typeId || unitId !== 'mannequin') continue;
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
  if (look.rig !== 'monster') return null;
  return authored.get(look.typeId) ?? null;
}
