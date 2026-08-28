/**
 * What the held-weapon table has to agree with (spec 165).
 *
 * Both ends of it are elsewhere -- the item ids are in `src/server/data/`, the
 * model ids are folders under `assets/items/` -- so the table is exactly the
 * kind of thing that goes stale silently. A renamed item leaves a player holding
 * nothing, and there is no error anywhere: the row simply stops matching.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_ITEMS } from '../../../server/data/items.js';
import { validateWeaponDef } from '../../../items/validate.js';
import { itemsWithModels, itemsWithTypes, weaponModelFor, weaponTypeFor } from './weapon-look.js';

const ITEMS_DIR = join(process.cwd(), 'assets', 'items');

/** Every weapon document in the tree, read the way `weapon-assets.ts` globs them. */
const documents = readdirSync(ITEMS_DIR)
  .filter((name) => statSync(join(ITEMS_DIR, name)).isDirectory())
  .map((name) => {
    const result = validateWeaponDef(
      JSON.parse(readFileSync(join(ITEMS_DIR, name, `${name}.weapondef.json`), 'utf8')),
    );
    if (!result.value) throw new Error(`${name} does not validate; run npm run validate:items`);
    return result.value;
  });

describe('the held-weapon table', () => {
  it('names only items that exist', () => {
    const ids = new Set(ALL_ITEMS.map((item) => item.id));
    for (const itemId of itemsWithModels()) expect(ids.has(itemId)).toBe(true);
  });

  it('names only weapons that exist', () => {
    const models = new Set(documents.map((weapon) => weapon.id));
    for (const itemId of itemsWithModels()) {
      const model = weaponModelFor(itemId);
      expect(model).not.toBeNull();
      expect(models.has(model ?? '')).toBe(true);
    }
  });

  it('only ever puts a model in a main hand', () => {
    // A row for a helmet would resolve and attach to a weapon socket, which is
    // a hat held like a sword.
    for (const itemId of itemsWithModels()) {
      expect(ALL_ITEMS.find((item) => item.id === itemId)?.slot).toBe('mainHand');
    }
  });

  it('draws the sword and the bow, which is the point', () => {
    expect(weaponModelFor('sword.worn')).toBe('sword_jian');
    expect(weaponModelFor('bow.hunting')).toBe('bow_recurve');
  });

  it('lets two items share one model', () => {
    // The two swords differ in numbers rather than in shape, which is what
    // `WeaponDef.name`'s doc means by "not an item id".
    expect(weaponModelFor('sword.keen')).toBe(weaponModelFor('sword.worn'));
  });

  it('draws empty hands for an item nothing has been made for', () => {
    // Null rather than a stand-in. The iron maul and the weighted stars have no
    // mesh, and drawing the maul as the knotted stick -- the nearest thing in
    // the tree -- would be a lie the player reads as a fact about their gear.
    expect(weaponModelFor('maul.iron')).toBeNull();
    expect(weaponModelFor('stars.weighted')).toBeNull();
    expect(weaponModelFor(null)).toBeNull();
    expect(weaponModelFor(undefined)).toBeNull();
    expect(weaponModelFor('not.an.item')).toBeNull();
  });

  it('sends each weapon to a socket the biped actually has', () => {
    // A document may name any socket, and one naming a socket this skeleton has
    // no row for attaches to nothing and draws nothing.
    const skeleton = JSON.parse(
      readFileSync(join(process.cwd(), 'assets', 'units', 'biped.skeleton.json'), 'utf8'),
    ) as { sockets: { id: string; rotationDeg?: number[] }[] };
    const sockets = new Map(skeleton.sockets.map((socket) => [socket.id, socket]));
    for (const itemId of itemsWithModels()) {
      const weapon = documents.find((entry) => entry.id === weaponModelFor(itemId));
      expect(weapon).toBeDefined();
      const socket = sockets.get(weapon?.socket ?? '');
      expect(socket).toBeDefined();
      // And a *calibrated* one. A socket with no rotation is the bind pose's
      // idea of a hand, which is how the bow first came out lying along the arm
      // like a lance.
      expect(socket?.rotationDeg).toBeDefined();
    }
  });
});

describe('what kind of weapon a thing is', () => {
  /**
   * The gap this closes: a maul and a sword wound up identically, because the
   * wind-up was chosen by the *ability's* damage and nothing anywhere asked what
   * the player was holding.
   */
  it('tells the six weapons apart', () => {
    expect(weaponTypeFor('sword.worn')).toBe('sword');
    expect(weaponTypeFor('sword.keen')).toBe('sword');
    expect(weaponTypeFor('maul.iron')).toBe('maul');
    expect(weaponTypeFor('staff.emberwood')).toBe('staff');
    expect(weaponTypeFor('bow.hunting')).toBe('bow');
    expect(weaponTypeFor('stars.weighted')).toBe('thrown');
  });

  it('answers null for bare hands and for an id it has never heard of', () => {
    // Null rather than a default kind: guessing `sword` would make an unarmed
    // body swing a blade, and an id from a newer server is the same case.
    expect(weaponTypeFor(null)).toBeNull();
    expect(weaponTypeFor(undefined)).toBeNull();
    expect(weaponTypeFor('')).toBeNull();
    expect(weaponTypeFor('halberd.imaginary')).toBeNull();
  });

  it('names only items the game actually has', () => {
    const ids = new Set(ALL_ITEMS.map((item) => item.id));
    for (const id of itemsWithTypes()) expect(ids, id).toContain(id);
  });

  /**
   * Complete where the model table is deliberately not.
   *
   * A model is a `.glb` that may not have been made yet -- the maul and the
   * stars have none -- but a *kind* is always knowable, so every main-hand item
   * in the game has one. A weapon with no kind falls back to the light/heavy
   * pair, which is the answer for a body whose weapon is unknown, and using it
   * for a weapon sitting in the player's own hand would be wrong rather than
   * merely vague.
   */
  it('covers every main-hand item, mesh or no mesh', () => {
    for (const item of ALL_ITEMS) {
      if (item.slot !== 'mainHand') continue;
      expect(weaponTypeFor(item.id), item.id).not.toBeNull();
    }
    expect(weaponModelFor('maul.iron')).toBeNull();
    expect(weaponTypeFor('maul.iron')).toBe('maul');
  });
});
