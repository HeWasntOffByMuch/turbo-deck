/**
 * The weapon switch's contents (spec 079).
 *
 * The switch itself is DOM and is not tested here; what is worth pinning is the
 * table it derives from, because that is the part that silently stops offering
 * an attack when somebody edits `data/items.ts`.
 */

import { describe, expect, it } from 'vitest';
import { abilityById, BASIC_ATTACK_ID } from '../../../server/data/abilities.js';
import { ALL_ITEMS, STARTING_KIT } from '../../../server/data/items.js';
import { WEAPON_SWITCH } from './hud.js';

describe('the weapon switch', () => {
  /** Every main hand a fresh character is handed and may actually equip. */
  const reachable = ALL_ITEMS.filter(
    (item) =>
      item.slot === 'mainHand' &&
      item.levelRequirement <= 1 &&
      STARTING_KIT.some((entry) => entry.defId === item.id),
  );

  it('offers every distinct auto-attack a fresh character can reach, exactly once', () => {
    const attacks = new Set(reachable.map((item) => item.basicAttackId ?? BASIC_ATTACK_ID));
    expect(new Set(WEAPON_SWITCH.map((entry) => entry.abilityId))).toEqual(attacks);
    expect(WEAPON_SWITCH).toHaveLength(attacks.size);
  });

  /**
   * The narrowing spec 218 made, stated as the thing it prevents.
   *
   * Until then this table was every distinct attack the item table could name,
   * and the two rules below held by coincidence: the only weapons that named a
   * shot were level-1 commons in the starting kit. The Emberwood Staff is a
   * rare level-4 one, and derived the old way it added a fourth button that
   * equips nothing, refuses silently and has no icon.
   */
  it('leaves out an attack whose only weapon a fresh character cannot reach', () => {
    const offered = new Set(WEAPON_SWITCH.map((entry) => entry.abilityId));
    const nameable = new Set(
      ALL_ITEMS.filter((item) => item.slot === 'mainHand').map(
        (item) => item.basicAttackId ?? BASIC_ATTACK_ID,
      ),
    );
    // The set the old derivation produced is strictly larger, and every attack
    // in the difference is one no starting character can throw.
    for (const abilityId of nameable) {
      if (offered.has(abilityId)) continue;
      expect(reachable.some((item) => (item.basicAttackId ?? BASIC_ATTACK_ID) === abilityId)).toBe(
        false,
      );
    }
    // And it really is doing something, or this passes on an empty difference
    // the day somebody puts every weapon in the kit.
    expect(offered.size).toBeLessThan(nameable.size);
  });

  it('offers a melee swing and both shots', () => {
    const attacks = WEAPON_SWITCH.map((entry) => entry.abilityId);
    expect(attacks).toContain('melee.slash');
    expect(attacks).toContain('ranged.shot');
    expect(attacks).toContain('ranged.star');
  });

  /**
   * A button the server refuses is a button that does nothing, and the switch
   * is the first thing anybody clicks in a fresh session.
   */
  it('offers only weapons a fresh character can actually hold', () => {
    for (const entry of WEAPON_SWITCH) {
      const item = ALL_ITEMS.find((candidate) => candidate.id === entry.itemId);
      expect(item?.levelRequirement).toBe(1);
    }
  });

  /**
   * Since spec 126 the server refuses to equip what a player is not carrying,
   * so "the level lets you" stopped being the whole answer -- the switch clicks
   * an item id, and an id that is in nobody's bag is a button that does nothing.
   */
  it('offers only weapons a fresh character is actually given', () => {
    const granted = new Set(STARTING_KIT.map((entry) => entry.defId));
    for (const entry of WEAPON_SWITCH) expect(granted.has(entry.itemId)).toBe(true);
  });

  it('names a real item and a real ability in every entry', () => {
    for (const entry of WEAPON_SWITCH) {
      expect(ALL_ITEMS.some((item) => item.id === entry.itemId)).toBe(true);
      expect(abilityById(entry.abilityId)).not.toBeNull();
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });
});
