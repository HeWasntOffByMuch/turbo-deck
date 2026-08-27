/**
 * Which weapon model an equipped item is drawn with (spec 165).
 *
 * Beside `monster-look.ts` and for the same reason: what a thing *is* lives in
 * `src/server/data/`, and what it *looks like* is the renderer's business. An
 * `ItemDefinition` carries a name, a slot, some modifiers and an attack id, and
 * deliberately no mesh -- a stat table that knew about `.glb` files would put a
 * presentation decision on the wire.
 *
 * ## Why it is a table and not a convention
 *
 * There are six main-hand items and three weapon meshes, and the mapping is not
 * one to one in either direction. Two swords share a model, because they differ
 * in numbers rather than in shape -- which is exactly what
 * `WeaponDef.name`'s doc means by "not an item id, two items may share a model".
 * And two items have no model at all.
 *
 * **An item with no row is drawn with empty hands, which is what every item did
 * before this existed.** That is the honest state rather than a gap to paper
 * over: the iron maul and the weighted stars have no mesh in `assets/items/`,
 * and drawing a maul as the knotted stick -- the nearest thing in the tree --
 * would be a lie about what the player is carrying that they would read as a
 * fact. A staff *is* a knotted stick, so that one is a row.
 *
 * Pure, and the ids are checked against both tables by the test beside it, so a
 * renamed item or a deleted mesh fails in Node rather than by a weapon quietly
 * failing to appear.
 */

/** Item id to the id of a document under `assets/items/`. */
const MODELS: Readonly<Record<string, string>> = {
  'sword.worn': 'sword_jian',
  'sword.keen': 'sword_jian',
  'staff.emberwood': 'stick_knot',
  'bow.hunting': 'bow_recurve',
};

/**
 * The model an item is held with, or null for one nothing has been made for.
 *
 * Null rather than a fallback model, and rather than throwing: an unequipped
 * hand, an item with no mesh and an id from a newer server all mean the same
 * thing to a renderer, which is "draw no weapon".
 */
export function weaponModelFor(itemId: string | null | undefined): string | null {
  if (itemId === null || itemId === undefined) return null;
  return MODELS[itemId] ?? null;
}

/** Every item that has a model, for the test and for a preview's roster. */
export function itemsWithModels(): readonly string[] {
  return Object.keys(MODELS).sort();
}

/**
 * What kind of weapon a main-hand item is.
 *
 * A second table beside {@link MODELS} rather than a field on it, because the
 * two answer different questions and are complete to different degrees: a model
 * is a `.glb` that may not have been made yet, and a *kind* is a fact about the
 * item that is always knowable. The maul and the stars have no mesh and are
 * still, unmistakably, a maul and a thrown weapon.
 *
 * Here rather than in `audio-wire.ts` because it is not an audio fact. It is the
 * same question this file already exists to answer -- what is this main-hand
 * item, for presentation -- and the next thing to want it is an animation, not a
 * second copy of the table.
 */
export type WeaponType = 'sword' | 'maul' | 'staff' | 'bow' | 'thrown';

const TYPES: Readonly<Record<string, WeaponType>> = {
  'sword.worn': 'sword',
  'sword.keen': 'sword',
  'maul.iron': 'maul',
  'staff.emberwood': 'staff',
  'bow.hunting': 'bow',
  'stars.weighted': 'thrown',
};

/**
 * The kind of weapon an item is, or null for bare hands and for anything this
 * build has never heard of.
 *
 * Null rather than a default kind, for {@link weaponModelFor}'s reason one step
 * along: "no weapon", "a weapon with no row" and "an id from a newer server" are
 * one answer to a caller, and guessing `sword` would make an unarmed body swing
 * a blade.
 */
export function weaponTypeFor(itemId: string | null | undefined): WeaponType | null {
  if (itemId === null || itemId === undefined) return null;
  return TYPES[itemId] ?? null;
}

/** Every item with a kind, for the test that checks them against the item table. */
export function itemsWithTypes(): readonly string[] {
  return Object.keys(TYPES).sort();
}
