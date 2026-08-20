import { describe, expect, it } from 'vitest';
import { InputMap } from '../../../ui/input/input-map.js';
import { abilityById } from '../../../server/data/abilities.js';
import { NO_ATTACK_SPEED } from '../../../server/sim/attack-timing.js';
import { NEUTRAL_TRAITS } from '../../../server/player/derived.js';
import { equipmentAddress } from '../../../server/player/inventory.js';
import type { EffectiveStats } from '../../../server/state/types.js';
import { VIAL_ABILITY_ID, buildActionBar } from './action-bar.js';
import { actionBarViewOf, type ActionBarSource } from './action-bar-model.js';

const BAR = buildActionBar(['melee.heavy', null, 'ground.quake', null]);

const STATS: EffectiveStats = {
  maxHealth: 138,
  moveSpeed: 150,
  turnRate: 210,
  attackDamage: 12,
  attackRange: 56,
  baseAttackTimeTicks: 30,
  ...NO_ATTACK_SPEED,
  armor: 0,
  spellPower: 1,
  critChance: 0,
  maxResource: 40,
  resourceRegen: 0.5,
  basicAttackId: 'melee.slash',
  skillAbilityIds: [],
  traits: NEUTRAL_TRAITS,
};

function source(overrides: Partial<ActionBarSource> = {}): ActionBarSource {
  return {
    bar: BAR,
    cooldowns: {},
    resource: 100,
    restoration: { charges: 2, maxCharges: 2 },
    casts: [],
    selfEntityId: 1,
    requestedAbilityId: null,
    aimingAbilityId: null,
    stats: null,
    swap: null,
    tick: 0,
    map: new InputMap(),
    ...overrides,
  };
}

describe('actionBarViewOf (spec 190)', () => {
  it('fills a slot from the plan and leaves an empty one empty', () => {
    const view = actionBarViewOf(source());
    expect(view.slots).toHaveLength(BAR.length);
    expect(view.slots[0]?.ability?.id).toBe('melee.heavy');
    expect(view.slots[1]?.ability).toBeNull();
    expect(view.slots[2]?.ability?.id).toBe('ground.quake');
    expect(view.slots[4]?.ability?.id).toBe(VIAL_ABILITY_ID);
  });

  it('says what actually fires each slot, off the key map', () => {
    // Never a guess and never the slot's own number: a rebound skillbar key has
    // to reach the label, which is the whole reason the map is an input here.
    const map = new InputMap();
    map.bind('skillbar.1', 'primary', { code: 'KeyQ' });
    const view = actionBarViewOf(source({ map }));
    expect(view.slots[0]?.keyLabel).toBe('Q');
    expect(view.slots[1]?.keyLabel).toBe('2');
  });

  it('counts the flask on the vial and on nothing else', () => {
    const view = actionBarViewOf(source({ restoration: { charges: 1, maxCharges: 3 } }));
    expect(view.slots[4]?.badge).toBe('1/3');
    expect(view.slots[0]?.badge).toBe('');
  });

  it('drains the wedge against the tick being drawn', () => {
    const heavy = abilityById('melee.heavy');
    if (!heavy) throw new Error('no melee.heavy');
    const half = Math.round(heavy.cooldownTicks / 2);
    const view = actionBarViewOf(source({ cooldowns: { 'melee.heavy': 100 }, tick: 100 - half }));
    expect(view.slots[0]?.ability?.sweep).toBeCloseTo(half / heavy.cooldownTicks, 2);
    expect(view.slots[0]?.ability?.secondsLeft).toBeCloseTo(half / 60, 2);
  });

  it('is not on cooldown once the tick has passed the ready tick', () => {
    const view = actionBarViewOf(source({ cooldowns: { 'melee.heavy': 100 }, tick: 140 }));
    expect(view.slots[0]?.ability?.sweep).toBe(0);
    expect(view.slots[0]?.ability?.secondsLeft).toBe(0);
  });

  /**
   * The three highlights are one question, and they outrank each other in the
   * order the player can still act on them: an aim is the one being decided
   * about, a cast is happening, and a request lasts one round trip.
   */
  it('lights an aimed slot ahead of a casting one, and a casting one ahead of a request', () => {
    const aimed = actionBarViewOf(
      source({
        aimingAbilityId: 'ground.quake',
        casts: [{ entityId: 1, abilityId: 'ground.quake' }],
        requestedAbilityId: 'ground.quake',
      }),
    );
    expect(aimed.slots[2]?.highlight).toBe('aimed');

    const casting = actionBarViewOf(
      source({
        casts: [{ entityId: 1, abilityId: 'ground.quake' }],
        requestedAbilityId: 'ground.quake',
      }),
    );
    expect(casting.slots[2]?.highlight).toBe('casting');

    const requested = actionBarViewOf(source({ requestedAbilityId: 'ground.quake' }));
    expect(requested.slots[2]?.highlight).toBe('requested');

    expect(actionBarViewOf(source()).slots[2]?.highlight).toBeNull();
  });

  it("does not light a slot for somebody else's cast", () => {
    const view = actionBarViewOf(source({ casts: [{ entityId: 9, abilityId: 'ground.quake' }] }));
    expect(view.slots[2]?.highlight).toBeNull();
  });

  it('never lights an empty slot', () => {
    const view = actionBarViewOf(source({ aimingAbilityId: null, requestedAbilityId: null }));
    expect(view.slots[1]?.highlight).toBeNull();
  });

  it('draws a change in flight over the slot it is happening to, empty or not', () => {
    // Putting your first skill into an empty slot is the commonest change there
    // is, and it is exactly the case a check on the ability would have skipped.
    const swap = {
      kind: 0,
      from: { container: 'inventory' as const, index: 0 },
      to: equipmentAddress('skill2'),
      progress: 0.4,
    };
    const view = actionBarViewOf(source({ swap }));
    expect(view.slots[1]?.change?.progress).toBe(0.4);
    expect(view.slots[1]?.change?.label.length).toBeGreaterThan(0);
    expect(view.slots[0]?.change).toBeNull();
  });

  it('leaves everything payable before the stats have landed', () => {
    // A bar that opened every session greyed out would be saying "you cannot
    // cast" about a character it has not been told anything about yet.
    const view = actionBarViewOf(source({ resource: 0, stats: null }));
    expect(view.slots[0]?.ability?.affordable).toBe(true);
  });

  it('dims what cannot be paid for, and an empty flask with it', () => {
    const poor = actionBarViewOf(source({ resource: 0, stats: STATS }));
    expect(poor.slots[2]?.ability?.affordable).toBe(false);

    const empty = actionBarViewOf(
      source({ stats: STATS, restoration: { charges: 0, maxCharges: 2 } }),
    );
    expect(empty.slots[4]?.ability?.affordable).toBe(false);
  });
});
