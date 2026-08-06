/**
 * The weapon switch's contents (spec 077).
 *
 * The switch itself is DOM and is not tested here; what is worth pinning is the
 * table it derives from, because that is the part that silently stops offering
 * an attack when somebody edits `data/items.ts`.
 */

import { describe, expect, it } from 'vitest';
import { abilityById, BASIC_ATTACK_ID } from '../../../server/data/abilities.js';
import { ALL_ITEMS } from '../../../server/data/items.js';
import { WEAPON_SWITCH } from './hud.js';

describe('the weapon switch', () => {
  it('offers every distinct auto-attack a main hand can name, exactly once', () => {
    const attacks = new Set(
      ALL_ITEMS.filter((item) => item.slot === 'mainHand').map(
        (item) => item.basicAttackId ?? BASIC_ATTACK_ID,
      ),
    );
    expect(new Set(WEAPON_SWITCH.map((entry) => entry.abilityId))).toEqual(attacks);
    expect(WEAPON_SWITCH).toHaveLength(attacks.size);
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

  it('names a real item and a real ability in every entry', () => {
    for (const entry of WEAPON_SWITCH) {
      expect(ALL_ITEMS.some((item) => item.id === entry.itemId)).toBe(true);
      expect(abilityById(entry.abilityId)).not.toBeNull();
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });
});
