import { describe, expect, it } from 'vitest';
import { abilityById } from '../../../server/data/abilities.js';
import { SKILLBAR_SLOTS } from '../../../ui/input/actions.js';
import {
  abilityForSlot,
  ACTION_BAR,
  actionBarFor,
  actionBarFromQuery,
  buildActionBar,
  sameBar,
  SKILL_SLOTS,
  VIAL_ABILITY_ID,
} from './action-bar.js';
import { EMPTY_EQUIPMENT, type Equipment } from '../../../server/state/types.js';

describe('the action bar', () => {
  it('is four empty skill slots and the vial', () => {
    expect(ACTION_BAR).toHaveLength(SKILL_SLOTS + 1);
    expect(ACTION_BAR.filter((slot) => slot.kind === 'skill')).toHaveLength(4);
    expect(ACTION_BAR.filter((slot) => slot.kind === 'vial')).toHaveLength(1);
  });

  it('casts nothing out of a slot nothing has been put in', () => {
    for (let i = 0; i < SKILL_SLOTS; i++) expect(abilityForSlot(ACTION_BAR, i)).toBeNull();
  });

  it('holds the flask in the vial slot, and it is a real ability', () => {
    expect(abilityForSlot(ACTION_BAR, SKILL_SLOTS)).toBe(VIAL_ABILITY_ID);
    expect(abilityById(VIAL_ABILITY_ID)).toBeDefined();
  });

  it('is inert for every key past the last slot', () => {
    // There are ten skillbar bindings and five slots, so 6-0 land here on a
    // keyboard somebody is already using. They have to be as inert as the empty
    // ones rather than throwing or wrapping round.
    for (let i = ACTION_BAR.length; i < SKILLBAR_SLOTS; i++) {
      expect(abilityForSlot(ACTION_BAR, i)).toBeNull();
    }
    expect(abilityForSlot(ACTION_BAR, -1)).toBeNull();
    expect(abilityForSlot(ACTION_BAR, 999)).toBeNull();
  });

  it('numbers its keys from one, in order', () => {
    expect(ACTION_BAR.map((slot) => slot.keyNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not outgrow the keys that press it', () => {
    expect(ACTION_BAR.length).toBeLessThanOrEqual(SKILLBAR_SLOTS);
  });
});

/**
 * The developer path (spec 164).
 *
 * It exists because an empty bar left every ability except the auto-attack and
 * the flask unreachable from the shipped page, and the browser harnesses that
 * check the aim, the cooldown refusal and the ground telegraph had nothing left
 * to press. A player has no way to reach it; `?slots=` is in the same register
 * as `?seed=` and `?wire=`.
 */
describe('?slots=', () => {
  it('is null when it is not asked for, so equipment decides (spec 188)', () => {
    expect(actionBarFromQuery('')).toBeNull();
    expect(actionBarFromQuery('?seed=4')).toBeNull();
  });

  it('fills the slots it names, in order', () => {
    const bar = actionBarFromQuery('?slots=melee.heavy,bolt.seek') ?? ACTION_BAR;
    expect(abilityForSlot(bar, 0)).toBe('melee.heavy');
    expect(abilityForSlot(bar, 1)).toBe('bolt.seek');
    expect(abilityForSlot(bar, 2)).toBeNull();
  });

  it('leaves an empty entry empty rather than shifting the rest along', () => {
    const bar = actionBarFromQuery('?slots=melee.heavy,,ground.quake') ?? ACTION_BAR;
    expect(abilityForSlot(bar, 1)).toBeNull();
    expect(abilityForSlot(bar, 2)).toBe('ground.quake');
  });

  it('never lets the vial be taken off the bar', () => {
    // Five names would overwrite the fifth slot if the vial were one of them.
    const bar = actionBarFromQuery('?slots=a,b,c,d,e,f,g') ?? ACTION_BAR;
    expect(bar).toHaveLength(SKILL_SLOTS + 1);
    expect(abilityForSlot(bar, SKILL_SLOTS)).toBe(VIAL_ABILITY_ID);
    expect(bar[SKILL_SLOTS]?.kind).toBe('vial');
  });

  it('keeps the key numbers whatever is in the slots', () => {
    expect(buildActionBar(['x']).map((slot) => slot.keyNumber)).toEqual([1, 2, 3, 4, 5]);
  });
});

/**
 * The bar is a view of the equipment (spec 188).
 *
 * Which is the whole of "the four slots beside the backpack mirror the four
 * along the bottom": there is no second list to keep in step, because there is
 * no second list. Both are `SKILL_EQUIP_SLOTS` read through one function.
 */
describe('the bar the equipment produces', () => {
  const worn = (over: Partial<Record<string, string | null>>): Equipment => ({
    ...EMPTY_EQUIPMENT,
    ...over,
  });

  it('is four empty slots and the vial for a character carrying nothing', () => {
    const bar = actionBarFor(EMPTY_EQUIPMENT);
    expect(bar).toHaveLength(SKILL_SLOTS + 1);
    for (let i = 0; i < SKILL_SLOTS; i++) expect(abilityForSlot(bar, i)).toBeNull();
    expect(abilityForSlot(bar, SKILL_SLOTS)).toBe(VIAL_ABILITY_ID);
  });

  it('puts a worn sigil’s ability in the slot it is worn in', () => {
    const bar = actionBarFor(worn({ skill2: 'sigil.whirlwind' }));
    expect(abilityForSlot(bar, 0)).toBeNull();
    expect(abilityForSlot(bar, 1)).toBe('skill.whirlwind');
  });

  /**
   * Positional, so emptying slot 2 does not silently renumber the keys: the
   * index into the bar *is* the key the player presses.
   */
  it('leaves a gap where a slot is empty rather than closing it up', () => {
    const bar = actionBarFor(worn({ skill1: 'sigil.guardBreak', skill3: 'sigil.whirlwind' }));
    expect(abilityForSlot(bar, 0)).toBe('skill.guardBreak');
    expect(abilityForSlot(bar, 1)).toBeNull();
    expect(abilityForSlot(bar, 2)).toBe('skill.whirlwind');
  });

  it('ignores a worn thing that is not a skill', () => {
    expect(abilityForSlot(actionBarFor(worn({ mainHand: 'sword.worn' })), 0)).toBeNull();
  });

  it('never lets equipment reach the vial’s slot', () => {
    const bar = actionBarFor(
      worn({
        skill1: 'sigil.guardBreak',
        skill2: 'sigil.stunningBlow',
        skill3: 'sigil.whirlwind',
        skill4: 'sigil.cripplingStrike',
      }),
    );
    expect(abilityForSlot(bar, SKILL_SLOTS)).toBe(VIAL_ABILITY_ID);
  });
});

describe('telling two bars apart', () => {
  it('is the ability ids in order and nothing else', () => {
    expect(sameBar(buildActionBar(['a', 'b']), buildActionBar(['a', 'b']))).toBe(true);
    expect(sameBar(buildActionBar(['a']), buildActionBar(['b']))).toBe(false);
    expect(sameBar(buildActionBar(['a', null]), buildActionBar([null, 'a']))).toBe(false);
    expect(sameBar(buildActionBar([]), [])).toBe(false);
  });
});
