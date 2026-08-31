import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_TOKENS } from '../../../ui/theme/theme.js';
import { InputMap } from '../../../ui/input/input-map.js';
import { abilityById } from '../../../server/data/abilities.js';
import { NO_ATTACK_SPEED } from '../../../server/sim/attack-timing.js';
import { NO_WEAPON } from '../../../server/data/weapon-scaling.js';
import { NEUTRAL_TRAITS } from '../../../server/player/derived.js';
import { equipmentAddress } from '../../../server/player/inventory.js';
import type { EffectiveStats } from '../../../server/state/types.js';
import { ALL_ITEMS } from '../../../server/data/items.js';
import { bakeAtlas } from '../../../ui/render/atlas.js';
import { THEME } from '../../../ui/theme/theme.js';
import { abilityIconFor, UNKNOWN_ABILITY_ICON } from './character-model.js';
import { VIAL_ABILITY_ID, buildActionBar } from './action-bar.js';
import { actionBarViewOf, type ActionBarSource } from './action-bar-model.js';

const BAR = buildActionBar(['skill.stunningBlow', null, 'skill.blight', null]);

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
  ...NO_WEAPON,
  traits: NEUTRAL_TRAITS,
};

function source(overrides: Partial<ActionBarSource> = {}): ActionBarSource {
  return {
    bar: BAR,
    cooldowns: {},
    resource: 100,
    restoration: { charges: 2, maxCharges: 2 },
    refunds: [],
    casts: [],
    selfEntityId: 1,
    requestedAbilityId: null,
    aimingAbilityId: null,
    stats: null,
    swap: null,
    tick: 0,
    map: new InputMap(),
    showsKeys: true,
    ...overrides,
  };
}

describe('actionBarViewOf (spec 196)', () => {
  it('fills a slot from the plan and leaves an empty one empty', () => {
    const view = actionBarViewOf(source());
    expect(view.slots).toHaveLength(BAR.length);
    expect(view.slots[0]?.ability?.id).toBe('skill.stunningBlow');
    expect(view.slots[1]?.ability).toBeNull();
    expect(view.slots[2]?.ability?.id).toBe('skill.blight');
    expect(view.slots[4]?.ability?.id).toBe(VIAL_ABILITY_ID);
  });

  /**
   * The check the shipped bar needed and did not have.
   *
   * `abilityIconFor` answers `item:unknown` for an id with no row, so every
   * skill a player equipped and the flask beside them came out as the same
   * question mark -- five boxes, all identical, all wrong, with the goldens
   * beside them perfect because they name their sprites by hand.
   */
  it('has real art for every ability a slot can hold', () => {
    const atlas = bakeAtlas(THEME);
    const holders = [
      ...ALL_ITEMS.flatMap((item) => (item.activeSkillId ? [item.activeSkillId] : [])),
      VIAL_ABILITY_ID,
    ];
    expect(holders.length).toBeGreaterThan(0);
    for (const id of holders) {
      const icon = abilityIconFor(id);
      expect(icon, id).not.toBe(UNKNOWN_ABILITY_ICON);
      expect(atlas.hasSprite(icon), `${id} -> ${icon}`).toBe(true);
    }
  });

  /**
   * The tooltip the DOM slots carried as a `title` and a canvas has no way to.
   *
   * Through spec 191's vocabulary rather than a sentence written for the bar,
   * which is what that vocabulary was built for -- and each line keeps the tone
   * it was given there, so `src/ui/` can colour it without knowing what any of
   * it means.
   */
  it('says what a slot holds, in the words the ability table already has', () => {
    const view = actionBarViewOf(source());
    const lines = view.slots[0]?.hint ?? [];
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]?.text).toBe(abilityById('skill.stunningBlow')?.name);
    // Every line past the name carries a colour token; the name takes the
    // tooltip's own.
    expect(lines.slice(1).every((line) => (line.colorToken ?? '').length > 0)).toBe(true);
  });

  it('draws the scaling notation with a hue per position (spec 242)', () => {
    // The weapon tooltip's `S / - / D`, on the bar. Slot 0 holds Stunning Blow,
    // which is pure Strength `A`, so the first position is lit and the other
    // two are `-` -- and the separators take the line's own colour, so what
    // carries a hue is the three grades and not the punctuation between them.
    const lines = actionBarViewOf(source()).slots[0]?.hint ?? [];
    const notation = lines.find((line) => line.spans !== undefined);
    expect(notation?.text).toBe('A / - / -');
    expect(notation?.spans?.map((span) => span.colorToken)).toEqual([
      ATTRIBUTE_TOKENS.strength,
      notation?.colorToken,
      ATTRIBUTE_TOKENS.agility,
      notation?.colorToken,
      ATTRIBUTE_TOKENS.intelligence,
    ]);
    // The runs and the whole line say the same thing, or the tooltip's wrap and
    // its repeat-hover key describe something nobody is shown.
    expect(notation?.spans?.map((span) => span.text).join('')).toBe(notation?.text);
  });

  it('says nothing at all for an empty slot', () => {
    // "Empty -- no skill assigned" is a box that pops up to tell a player what
    // they can already see.
    expect(actionBarViewOf(source()).slots[1]?.hint).toEqual([]);
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

  it('names no key on a finger, which has no keyboard to press', () => {
    const view = actionBarViewOf(source({ showsKeys: false }));
    expect(view.slots.map((entry) => entry.keyLabel)).toEqual(['', '', '', '', '']);
  });

  it('counts the flask on the vial and on nothing else', () => {
    const view = actionBarViewOf(source({ restoration: { charges: 1, maxCharges: 3 } }));
    expect(view.slots[4]?.badge).toBe('1/3');
    expect(view.slots[0]?.badge).toBe('');
  });

  it('drains the wedge against the tick being drawn', () => {
    const heavy = abilityById('skill.stunningBlow');
    if (!heavy) throw new Error('no skill.stunningBlow');
    const half = Math.round(heavy.cooldownTicks / 2);
    const view = actionBarViewOf(source({ cooldowns: { 'skill.stunningBlow': 100 }, tick: 100 - half }));
    expect(view.slots[0]?.ability?.sweep).toBeCloseTo(half / heavy.cooldownTicks, 2);
    expect(view.slots[0]?.ability?.secondsLeft).toBeCloseTo(half / 60, 2);
  });

  it('is not on cooldown once the tick has passed the ready tick', () => {
    const view = actionBarViewOf(source({ cooldowns: { 'skill.stunningBlow': 100 }, tick: 140 }));
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
        aimingAbilityId: 'skill.blight',
        casts: [{ entityId: 1, abilityId: 'skill.blight' }],
        requestedAbilityId: 'skill.blight',
      }),
    );
    expect(aimed.slots[2]?.highlight).toBe('aimed');

    const casting = actionBarViewOf(
      source({
        casts: [{ entityId: 1, abilityId: 'skill.blight' }],
        requestedAbilityId: 'skill.blight',
      }),
    );
    expect(casting.slots[2]?.highlight).toBe('casting');

    const requested = actionBarViewOf(source({ requestedAbilityId: 'skill.blight' }));
    expect(requested.slots[2]?.highlight).toBe('requested');

    expect(actionBarViewOf(source()).slots[2]?.highlight).toBeNull();
  });

  it("does not light a slot for somebody else's cast", () => {
    const view = actionBarViewOf(source({ casts: [{ entityId: 9, abilityId: 'skill.blight' }] }));
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

/**
 * Which slot a refund is drawn on (spec 253).
 *
 * The mark is a fact about an *ability*; which square that ability is sitting
 * in is this layer's question, and the answer is only ever "the slot holding
 * it".
 */
describe('cooldown refunds on the bar', () => {
  const MARK = { abilityId: 'skill.blight', seconds: 1.2, startedMs: 4000 };

  it('marks the slot holding the ability, and no other', () => {
    // BAR is [stunningBlow, empty, blight, empty] plus the vial.
    const view = actionBarViewOf(source({ refunds: [MARK] }));
    expect(view.slots[2]?.refund).toEqual({ label: '-1.2', startedMs: 4000 });
    expect(view.slots[0]?.refund).toBeNull();
    expect(view.slots[1]?.refund).toBeNull();
    expect(view.slots[3]?.refund).toBeNull();
  });

  it('marks every slot a single trigger paid', () => {
    const view = actionBarViewOf(
      source({
        refunds: [MARK, { abilityId: 'skill.stunningBlow', seconds: 0.4, startedMs: 4000 }],
      }),
    );
    expect(view.slots[0]?.refund?.label).toBe('-0.4');
    expect(view.slots[2]?.refund?.label).toBe('-1.2');
  });

  /**
   * A refund for something the player is no longer carrying: they cancelled a
   * follow-through, it paid a skill, and the skill came out of its slot before
   * the mark expired. There is nowhere to draw it, and that is the whole answer.
   */
  it('has nowhere to put a refund for an ability no slot holds', () => {
    const view = actionBarViewOf(source({ refunds: [{ abilityId: 'skill.acidSpray', seconds: 1.2, startedMs: 0 }] }));
    expect(view.slots.every((slot) => slot.refund === null)).toBe(true);
  });

  it('leaves every slot unmarked when nothing was refunded', () => {
    const view = actionBarViewOf(source());
    expect(view.slots.every((slot) => slot.refund === null)).toBe(true);
  });
});
