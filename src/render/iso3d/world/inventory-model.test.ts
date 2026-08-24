/**
 * The inventory's view-model (spec 127).
 *
 * This is where the boundary between the game and `src/ui/` is paid for, so what
 * is worth asserting is that the mapping is total: a bag with holes in it, a
 * stack, an id the table has dropped, and an item with no art all come out as
 * something the screen can draw.
 */

import { describe, expect, it } from 'vitest';
import { ALL_ITEMS, itemById } from '../../../server/data/items.js';
import {
  effectiveScaling,
  formatScaling,
  NO_SCALING,
  ScalingGrade,
  type ScalingGradeModifiers,
} from '../../../server/data/weapon-scaling.js';
import type { ItemDetail, ItemDetailSpan } from '../../../ui/screens/inventory.js';
import {
  EMPTY_EQUIPMENT,
  emptyInventory,
  EQUIP_SLOTS,
  SKILL_EQUIP_SLOTS,
} from '../../../server/state/types.js';
import { bakeAtlas } from '../../../ui/render/atlas.js';
import { THEME } from '../../../ui/theme/theme.js';
import { containerViewOf, detailsFor, iconFor, itemViewOf, UNKNOWN_ICON } from './inventory-model.js';

describe('containerViewOf', () => {
  it('maps a bag with holes in it, keeping every index', () => {
    const bag = [...emptyInventory()];
    bag[2] = { defId: 'sword.worn', count: 1 };
    bag[7] = { defId: 'potion.minor', count: 4 };

    const view = containerViewOf({ inventory: bag, equipment: EMPTY_EQUIPMENT, level: 3 });
    expect(view.bag).toHaveLength(bag.length);
    expect(view.bag[0]).toBeNull();
    expect(view.bag[2]).toMatchObject({ defId: 'sword.worn', name: 'Worn Sword', slot: 'mainHand' });
    expect(view.bag[7]).toMatchObject({ count: 4, icon: 'item:potion' });
    expect(view.level).toBe(3);
  });

  it('maps what is worn, and leaves an empty slot empty', () => {
    const view = containerViewOf({
      inventory: emptyInventory(),
      equipment: { ...EMPTY_EQUIPMENT, mainHand: 'bow.hunting' },
      level: 1,
    });
    expect(view.worn['mainHand']).toMatchObject({ defId: 'bow.hunting', icon: 'item:bow' });
    expect(view.worn['head']).toBeNull();
  });

  /**
   * The slot list is handed to the screen rather than listed there, so a seventh
   * slot appears without the screen being told. This is the assertion that keeps
   * that true.
   */
  it('offers exactly the equipment slots the server has, in order', () => {
    const view = containerViewOf({
      inventory: emptyInventory(),
      equipment: EMPTY_EQUIPMENT,
      level: 1,
    });
    // The paperdoll's slots and the skill row's between them are every
    // equipment slot the server has, in order (spec 188). Two lists because
    // they are drawn in two places -- the worn things beside a body, the four
    // skills in a row under the bag that mirrors the bar.
    expect([...view.slots, ...view.skillSlots].map((slot) => slot.id)).toEqual([...EQUIP_SLOTS]);
    expect(view.skillSlots.map((slot) => slot.id)).toEqual([...SKILL_EQUIP_SLOTS]);
    for (const slot of view.skillSlots) expect(slot.label.length).toBeGreaterThan(0);
    for (const slot of view.slots) expect(slot.label.length).toBeGreaterThan(0);
  });

  /** An id the table has dropped is still in somebody's bag, and still drawable. */
  it('draws an item the table no longer defines rather than hiding it', () => {
    const bag = [...emptyInventory()];
    bag[0] = { defId: 'sword.imaginary', count: 1 };
    const view = containerViewOf({ inventory: bag, equipment: EMPTY_EQUIPMENT, level: 1 });
    expect(view.bag[0]).toMatchObject({
      defId: 'sword.imaginary',
      name: 'sword.imaginary',
      slot: null,
      icon: UNKNOWN_ICON,
    });
  });
});

describe('icons', () => {
  it('names a sprite the atlas actually has, for every item in the table', () => {
    const atlas = bakeAtlas(THEME);
    for (const item of ALL_ITEMS) {
      expect(atlas.hasSprite(iconFor(item.id))).toBe(true);
    }
  });

  it('falls back to the box rather than to nothing', () => {
    expect(iconFor('nothing.at.all')).toBe(UNKNOWN_ICON);
    expect(bakeAtlas(THEME).hasSprite(UNKNOWN_ICON)).toBe(true);
  });

  it('gives every item its own name, not its id', () => {
    expect(itemViewOf('helm.leather', 1).name).toBe('Leather Cap');
  });
});

/**
 * What an item says about itself (spec 185).
 *
 * Asserted against the real table rather than a fixture, because the thing being
 * checked is the *mapping*: that a row's modifiers come out as lines somebody
 * could read, in one order, with a drawback distinguishable from a benefit.
 */
describe('detailsFor', () => {
  const linesOf = (defId: string): readonly string[] => detailsFor(defId).map((line) => line.text);

  it('names the tier and where it is worn, in one line', () => {
    expect(detailsFor('sword.keen')[0]).toEqual({ text: 'Rare  Main Hand', tone: 'rarity' });
    // Nothing carried is worn anywhere, so the tier stands on its own rather
    // than beside an empty half-sentence.
    expect(detailsFor('potion.minor')[0]).toEqual({ text: 'Common', tone: 'rarity' });
  });

  it('writes each modifier out, benefits and drawbacks apart', () => {
    // The maul is the row that has both, which is why it is the one asked.
    expect(detailsFor('maul.iron')).toEqual([
      { text: 'Rare  Main Hand', tone: 'rarity' },
      {
        text: 'S / - / -',
        tone: 'normal',
        spans: [
          { text: 'S', tone: 'strength' },
          { text: ' / ', tone: 'normal' },
          { text: '-', tone: 'agility' },
          { text: ' / ', tone: 'normal' },
          { text: '-', tone: 'intelligence' },
        ],
      },
      { text: '+2 Strength', tone: 'good' },
      { text: '+14 Damage', tone: 'good' },
      { text: '+10 Range', tone: 'good' },
      { text: '-20% Attack Speed', tone: 'bad' },
      { text: 'Worth 110 coins', tone: 'dim' },
    ]);
  });

  it('writes a fraction as a percentage, and rounds it like one', () => {
    // 0.15 * 100 in binary floating point is 15.000000000000002.
    expect(linesOf('sword.keen')).toContain('+15% Attack Speed');
    expect(linesOf('shield.oak')).toContain('+6% Armour');
  });

  it('says an item cannot be sold rather than leaving it unpriced', () => {
    // Every row is worth something today, so this is asserted on the rule rather
    // than on a row: it is the branch that would otherwise never be exercised
    // until somebody authored a quest item and found a blank where a price goes.
    for (const item of ALL_ITEMS) {
      const worth = detailsFor(item.id).at(-1);
      expect(worth?.tone, item.id).toBe('dim');
      expect(worth?.text, item.id).toBe(
        item.value > 0 ? `Worth ${item.value} coins` : 'Cannot be sold',
      );
    }
  });

  it('says nothing at all about an id the table has dropped', () => {
    // A tier and nothing else: there is no row to read stats or a price off, and
    // inventing either would be a lie about something in somebody's bag.
    expect(detailsFor('gone.missing')).toEqual([{ text: 'Common', tone: 'rarity' }]);
  });

  it('draws no line for a stat it has no words for', () => {
    // Every describable field is in the table; a `traits` grant is deliberately
    // not (spec 185), and it must produce no line rather than a raw key.
    const described = detailsFor('trinket.bloodstone').map((line) => line.text);
    expect(described.some((text) => text.includes('traits'))).toBe(false);
    expect(described).toContain('+12% Health');
  });

  it('puts the tier on every view, and common on one it cannot place', () => {
    expect(itemViewOf('trinket.bloodstone', 1).rarity).toBe('exceptional');
    expect(itemViewOf('sword.worn', 1).rarity).toBe('common');
    expect(itemViewOf('gone.missing', 1).rarity).toBe('common');
  });
});

/**
 * The compact scaling line (spec 216).
 *
 * Everything here is about the *line*, not about the numbers: that it exists on
 * weapons and nowhere else, that its three positions never move, and that the
 * grades in it came from the resolver rather than from the row. The arithmetic
 * is `data/weapon-scaling.test.ts`'s.
 */
describe('the weapon scaling line', () => {
  const scalingOf = (defId: string, modifiers?: ScalingGradeModifiers): ItemDetail | undefined =>
    detailsFor(defId, modifiers).find((line) => line.spans !== undefined);

  it('is three positions, one character each, separated by slashes', () => {
    expect(scalingOf('maul.iron')?.text).toBe('S / - / -');
    expect(scalingOf('sword.worn')?.text).toBe('A / D / -');
    expect(scalingOf('stars.weighted')?.text).toBe('- / S / -');
    expect(scalingOf('staff.emberwood')?.text).toBe('E / - / A');
  });

  it('never uses a word, a percentage or an attribute name inside the line', () => {
    for (const item of ALL_ITEMS) {
      const line = scalingOf(item.id);
      if (!line) continue;
      expect(line.text, item.id).toMatch(/^[SABCDE-] \/ [SABCDE-] \/ [SABCDE-]$/);
    }
  });

  it('holds Strength, Agility and Intelligence in that order, whatever the grades', () => {
    // The staff is the row that would reorder if anything sorted by strength of
    // scaling: its Intelligence is `A` and its Strength is `E`.
    const spans = scalingOf('staff.emberwood')?.spans ?? [];
    expect(
      spans.filter((span: ItemDetailSpan) => span.tone !== 'normal').map((span) => span.tone),
    ).toEqual([
      'strength',
      'agility',
      'intelligence',
    ]);
  });

  it('colours the letters by attribute and leaves the separators neutral', () => {
    const spans = scalingOf('sword.worn')?.spans ?? [];
    expect(spans).toEqual([
      { text: 'A', tone: 'strength' },
      { text: ' / ', tone: 'normal' },
      { text: 'D', tone: 'agility' },
      { text: ' / ', tone: 'normal' },
      { text: '-', tone: 'intelligence' },
    ]);
  });

  it('draws `-` for None, in every position', () => {
    // No shipped row scales with nothing, so the rule is asserted through the
    // resolver's own answer for one: a weapon that scales with nothing must say
    // so rather than omitting the line and reading as un-configured.
    const spans = scalingOf('maul.iron')?.spans ?? [];
    expect(spans[2]).toEqual({ text: '-', tone: 'agility' });
    expect(spans[4]).toEqual({ text: '-', tone: 'intelligence' });
    expect(formatScaling(NO_SCALING)).toBe('- / - / -');
  });

  it('is drawn for a weapon and for nothing else', () => {
    for (const item of ALL_ITEMS) {
      const has = scalingOf(item.id) !== undefined;
      expect(has, item.id).toBe(item.slot === 'mainHand');
    }
  });

  // The requirement the whole design is for: the line is the resolver's answer,
  // so a modifier that moves the damage moves the tooltip in the same breath.
  it('shows effective scaling, and returns to base when the modifier goes', () => {
    const base = scalingOf('sword.worn')?.text;
    expect(base).toBe('A / D / -');
    expect(scalingOf('sword.worn', { strength: 0, agility: 2, intelligence: 0 })?.text).toBe('A / B / -');
    // Nothing was written into the row: the same call with no modifiers answers
    // exactly what it answered before one was ever applied.
    expect(scalingOf('sword.worn')?.text).toBe(base);
  });

  it('agrees with the resolver rather than deriving its own grades', () => {
    const modifiers = { strength: -1, agility: 1, intelligence: 0 };
    const weapon = itemById('bow.hunting');
    const expected = effectiveScaling(weapon?.scaling ?? NO_SCALING, modifiers);
    expect(scalingOf('bow.hunting', modifiers)?.text).toBe(formatScaling(expected));
  });

  it('clamps in the line exactly as it clamps in the damage', () => {
    const huge = { strength: 9, agility: 9, intelligence: 9 };
    const floor = { strength: -9, agility: -9, intelligence: -9 };
    // All three reach `S`, the Worn Sword's `None` in Intelligence included: a
    // step lifts a `None` the same way it lifts anything else, which is the
    // brief's own `INT - +1 -> E`. A modifier that could not create scaling
    // would make "raise a grade" mean two different things.
    expect(scalingOf('sword.worn', huge)?.text).toBe('S / S / S');
    expect(scalingOf('sword.worn', floor)?.text).toBe('- / - / -');
  });

  it('reaches every tooltip in the bag through containerViewOf', () => {
    const bag = [...emptyInventory()];
    bag[0] = { defId: 'sword.worn', count: 1 };
    const plain = containerViewOf({ inventory: bag, equipment: EMPTY_EQUIPMENT, level: 9 });
    const wearing = containerViewOf({
      inventory: bag,
      equipment: EMPTY_EQUIPMENT,
      level: 9,
      scalingModifiers: { strength: 0, agility: 2, intelligence: 0 },
    });
    const lineOf = (view: ReturnType<typeof containerViewOf>): string | undefined =>
      view.bag[0]?.details.find((line) => line.spans !== undefined)?.text;
    expect(lineOf(plain)).toBe('A / D / -');
    expect(lineOf(wearing)).toBe('A / B / -');
  });

  it('keeps the weapon\'s base scaling reachable beside the effective line', () => {
    // The tooltip draws the effective grades; the row still says what it always
    // said, which is what a later spec showing both would read.
    expect(itemById('sword.worn')?.scaling).toEqual({
      strength: ScalingGrade.A,
      agility: ScalingGrade.D,
      intelligence: ScalingGrade.None,
    });
  });
});

/** The two rows that make the modifier path reachable content (spec 216). */
describe('an item that moves a grade', () => {
  it('says what it does in words a player can read', () => {
    const lines = detailsFor('trinket.precision').map((line) => line.text);
    expect(lines).toContain('+1 Agility Scaling');
  });

  it('writes a drawback as a drawback', () => {
    const lines = detailsFor('trinket.runic');
    expect(lines.find((line) => line.text === '+2 Intelligence Scaling')?.tone).toBe('good');
    expect(lines.find((line) => line.text === '-1 Strength Scaling')?.tone).toBe('bad');
  });
});
