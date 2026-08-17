import { describe, expect, it } from 'vitest';
import { abilityById } from '../../../server/data/abilities.js';
import { SKILLBAR_SLOTS } from '../../../ui/input/actions.js';
import {
  abilityForSlot,
  ACTION_BAR,
  actionBarFromQuery,
  buildActionBar,
  SKILL_SLOTS,
  VIAL_ABILITY_ID,
} from './action-bar.js';

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
 * The developer path (spec 163).
 *
 * It exists because an empty bar left every ability except the auto-attack and
 * the flask unreachable from the shipped page, and the browser harnesses that
 * check the aim, the cooldown refusal and the ground telegraph had nothing left
 * to press. A player has no way to reach it; `?slots=` is in the same register
 * as `?seed=` and `?wire=`.
 */
describe('?slots=', () => {
  it('is the shipped bar when it is not asked for', () => {
    expect(actionBarFromQuery('')).toBe(ACTION_BAR);
    expect(actionBarFromQuery('?seed=4')).toBe(ACTION_BAR);
  });

  it('fills the slots it names, in order', () => {
    const bar = actionBarFromQuery('?slots=melee.heavy,bolt.seek');
    expect(abilityForSlot(bar, 0)).toBe('melee.heavy');
    expect(abilityForSlot(bar, 1)).toBe('bolt.seek');
    expect(abilityForSlot(bar, 2)).toBeNull();
  });

  it('leaves an empty entry empty rather than shifting the rest along', () => {
    const bar = actionBarFromQuery('?slots=melee.heavy,,ground.quake');
    expect(abilityForSlot(bar, 1)).toBeNull();
    expect(abilityForSlot(bar, 2)).toBe('ground.quake');
  });

  it('never lets the vial be taken off the bar', () => {
    // Five names would overwrite the fifth slot if the vial were one of them.
    const bar = actionBarFromQuery('?slots=a,b,c,d,e,f,g');
    expect(bar).toHaveLength(SKILL_SLOTS + 1);
    expect(abilityForSlot(bar, SKILL_SLOTS)).toBe(VIAL_ABILITY_ID);
    expect(bar[SKILL_SLOTS]?.kind).toBe('vial');
  });

  it('keeps the key numbers whatever is in the slots', () => {
    expect(buildActionBar(['x']).map((slot) => slot.keyNumber)).toEqual([1, 2, 3, 4, 5]);
  });
});
