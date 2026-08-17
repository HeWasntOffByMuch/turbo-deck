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
import { itemsWithModels, weaponModelFor } from './weapon-look.js';

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
