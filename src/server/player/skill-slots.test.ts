/**
 * The four slots' rules (spec 184).
 *
 * Pure, so all of it is asserted without a server: what a character may cast,
 * which moves count as a swap, and the one hard rule the brief states about
 * swapping -- a skill on cooldown may not leave its slot.
 */

import { describe, expect, it } from 'vitest';
import { applyMove, equipmentAddress } from './inventory.js';
import {
  activeSkillOf,
  addressIsSkillSlot,
  movesASkill,
  skillAbilityIdsOf,
  skillSlotAbilities,
  skillSlotOnCooldown,
  skillSwapRefusal,
  SKILL_EQUIP_SLOTS,
  SKILL_SLOT_COUNT,
} from './skill-slots.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  type Equipment,
  type Inventory,
} from '../state/types.js';

const inv = (index: number) => ({ container: 'inventory', index }) as const;
const slot = (name: 'skill1' | 'skill2' | 'skill3' | 'skill4') => equipmentAddress(name);

const WORN: Equipment = {
  ...EMPTY_EQUIPMENT,
  mainHand: 'sword.worn',
  skill1: 'sigil.guardBreak',
  skill3: 'sigil.whirlwind',
};

function bagWith(defId: string, at = 0): Inventory {
  const bag = [...emptyInventory()];
  bag[at] = { defId, count: 1 };
  return bag;
}

describe('what a character may cast', () => {
  it('has four slots', () => {
    expect(SKILL_SLOT_COUNT).toBe(4);
    expect(SKILL_EQUIP_SLOTS).toHaveLength(4);
  });

  it('reads the abilities off the worn sigils', () => {
    expect(skillAbilityIdsOf(WORN)).toEqual(['skill.guardBreak', 'skill.whirlwind']);
  });

  /**
   * Positional for the bar and closed up for the gate, and the two are
   * different functions on purpose: the index into the first *is* the key you
   * press, so a list that closed its gaps would renumber a player's keys the
   * moment a slot was emptied.
   */
  it('keeps the gaps where the bar reads it, and closes them where the gate does', () => {
    expect(skillSlotAbilities(WORN)).toEqual(['skill.guardBreak', null, 'skill.whirlwind', null]);
    expect(skillAbilityIdsOf(WORN)).toHaveLength(2);
  });

  it('answers null for an empty slot, a sword and an id the table has forgotten', () => {
    expect(activeSkillOf(null)).toBeNull();
    expect(activeSkillOf('sword.worn')).toBeNull();
    expect(activeSkillOf('sigil.fromAnOlderBuild')).toBeNull();
  });

  it('gives a character with nothing worn nothing to cast', () => {
    expect(skillAbilityIdsOf(EMPTY_EQUIPMENT)).toEqual([]);
  });
});

describe('which moves are swaps', () => {
  it('counts a move into a skill slot and out of one', () => {
    expect(movesASkill({ from: inv(0), to: slot('skill1') })).toBe(true);
    expect(movesASkill({ from: slot('skill1'), to: inv(0) })).toBe(true);
    expect(movesASkill({ from: slot('skill1'), to: slot('skill2') })).toBe(true);
  });

  it('leaves an ordinary move alone', () => {
    expect(movesASkill({ from: inv(0), to: inv(1) })).toBe(false);
    expect(movesASkill({ from: inv(0), to: equipmentAddress('mainHand') })).toBe(false);
  });

  /**
   * An inventory index is never a skill slot however large it is. The naive
   * `index >= 6` version got this wrong and would have timed every bag drag
   * past the sixth cell.
   */
  it('never mistakes a bag index for a slot ordinal', () => {
    for (let i = 0; i < 24; i++) expect(addressIsSkillSlot(inv(i))).toBe(false);
  });
});

describe('a skill on cooldown cannot leave its slot', () => {
  const READY_AT = 500;
  const cooldowns = { 'skill.guardBreak': READY_AT };

  it('refuses while the cooldown is running', () => {
    const move = { from: slot('skill1'), to: inv(0) };
    expect(skillSwapRefusal(WORN, move, cooldowns, READY_AT - 1)).not.toBeNull();
  });

  it('allows it the tick the cooldown ends', () => {
    const move = { from: slot('skill1'), to: inv(0) };
    expect(skillSwapRefusal(WORN, move, cooldowns, READY_AT)).toBeNull();
  });

  /**
   * Stated over **both** ends of the move. Swapping a fresh sigil *into* an
   * occupied slot empties that slot just as surely as dragging the old one out,
   * and a check that only looked at `from` would leave the obvious way round it.
   */
  it('refuses a move that would displace a skill on cooldown', () => {
    const move = { from: inv(0), to: slot('skill1') };
    expect(skillSwapRefusal(WORN, move, cooldowns, READY_AT - 1)).not.toBeNull();
  });

  it('says nothing about a slot holding a skill that is ready', () => {
    const move = { from: slot('skill3'), to: inv(0) };
    expect(skillSwapRefusal(WORN, move, cooldowns, READY_AT - 1)).toBeNull();
  });

  it('says nothing about an empty slot', () => {
    expect(skillSlotOnCooldown(WORN, slot('skill2'), cooldowns, READY_AT - 1)).toBe(false);
  });

  it('says nothing about a move that is not a swap at all', () => {
    const move = { from: inv(0), to: inv(1) };
    expect(skillSwapRefusal(WORN, move, cooldowns, 0)).toBeNull();
  });
});

describe('what fits in a skill slot', () => {
  it('takes a sigil in any of the four', () => {
    for (const name of SKILL_EQUIP_SLOTS) {
      const outcome = applyMove(bagWith('sigil.whirlwind'), EMPTY_EQUIPMENT, {
        from: inv(0),
        to: equipmentAddress(name),
      }, 10);
      expect(outcome.ok, name).toBe(true);
      if (outcome.ok) expect(outcome.equipment[name]).toBe('sigil.whirlwind');
    }
  });

  it('refuses a sword in a skill slot', () => {
    const outcome = applyMove(bagWith('sword.worn'), EMPTY_EQUIPMENT, {
      from: inv(0),
      to: slot('skill1'),
    }, 10);
    expect(outcome.ok).toBe(false);
  });

  it('refuses a sigil in the main hand', () => {
    const outcome = applyMove(bagWith('sigil.whirlwind'), EMPTY_EQUIPMENT, {
      from: inv(0),
      to: equipmentAddress('mainHand'),
    }, 10);
    expect(outcome.ok).toBe(false);
  });

  it('still checks the level requirement on the way in', () => {
    const outcome = applyMove(bagWith('sigil.whirlwind'), EMPTY_EQUIPMENT, {
      from: inv(0),
      to: slot('skill1'),
    }, 1);
    expect(outcome.ok).toBe(false);
  });
});
