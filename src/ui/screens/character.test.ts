/**
 * The character sheet (spec 128).
 *
 * The screen knows nothing about tier gates or branch locks -- `canSpend` and
 * `blockedBecause` arrive decided. So what is worth asserting here is that it
 * *obeys* them: a button is enabled exactly when it was told it may be, and a
 * disabled one can say why.
 */

import { describe, expect, it } from 'vitest';
import { ALL_SYNERGIES } from '../../server/data/synergies.js';
import { UiRoot } from '../core/root.js';

/** The fifteen names the sheet must never print. */
const PAIR_NAMES = ALL_SYNERGIES.map((synergy) => synergy.name);
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import {
  CharacterScreen,
  nextChangeLine,
  type AttributeRowView,
  type BranchView,
  type CharacterView,
  type SkillView,
} from './character.js';

function skill(id: string, overrides: Partial<SkillView> = {}): SkillView {
  return {
    id,
    name: id,
    tier: 1,
    level: 0,
    maxLevel: 5,
    description: `what ${id} does`,
    canSpend: true,
    blockedBecause: '',
    ...overrides,
  };
}

function attributeRow(
  key: string,
  overrides: Partial<AttributeRowView> = {},
): AttributeRowView {
  return {
    key,
    name: key,
    abbrev: key.slice(0, 3).toUpperCase(),
    description: `what ${key} does`,
    allocated: 12,
    total: 12,
    canAllocate: true,
    blockedBecause: '',
    nextEffect: '',
    toNext: 0,
    active: [],
    ...overrides,
  };
}

function branch(id: string, skills: readonly SkillView[]): BranchView {
  return { id, name: id, pointsSpent: 0, skills };
}

function viewOf(overrides: Partial<CharacterView> = {}): CharacterView {
  return {
    name: 'Kestrel',
    level: 4,
    experience: { current: 120, toNext: 260 },
    unspentPoints: 2,
    unspentAttributePoints: 3,
    attributes: [],
    respec: { cost: 40, enabled: true },
    stats: [
      { label: 'Health', value: '138', hint: 'damage you can take before dying' },
      { label: 'Damage', value: '12', hint: 'how hard your weapon hits' },
    ],
    branches: [
      branch('attr:strength', [skill('str.crushingBlows', { level: 2 }), skill('str.unstoppable', { tier: 3 })]),
      branch('attr:wisdom', [skill('wis.discipline', { canSpend: false, blockedBecause: 'needs 10 Wisdom' })]),
    ],
    ...overrides,
  };
}

function harness(view = viewOf()): { screen: CharacterScreen; root: UiRoot } {
  const screen = new CharacterScreen({ theme: THEME });
  screen.setCharacter(view);
  const root = new UiRoot(screen, {
    theme: THEME,
    atlas: bakeAtlas(THEME),
    viewport: { width: 400, height: 300 },
  });
  // Every tab, so every row exists: content is built lazily (spec 124).
  for (const id of screen.tabs.tabIds) screen.tabs.select(id);
  screen.setCharacter(view);
  root.update(0);
  return { screen, root };
}

describe('the character sheet', () => {
  it('shows who this is and how far to the next level', () => {
    const { screen } = harness();
    expect(screen.experience.filled).toBeCloseTo(120 / 260);
    expect(screen.shown?.level).toBe(4);
  });

  it('enables a spend button exactly when it was told it may', () => {
    const { screen } = harness();
    expect(screen.rowFor('str.crushingBlows')?.spendButton.enabled).toBe(true);
    expect(screen.rowFor('wis.discipline')?.spendButton.enabled).toBe(false);
  });

  it('says why a skill cannot be taken, in the words the refusal would use', () => {
    // A tooltip is a list of lines rather than one string since spec 189: a
    // skill's description is its Technical Description, and `Tooltip` wraps per
    // line, so handing it over as prose would run every fact into a paragraph.
    const { screen } = harness();
    const refused = screen.rowFor('wis.discipline')?.tooltip() ?? [];
    expect(refused.map((line) => line.text)).toContain('needs 10 Wisdom');
    // The refusal is the *last* line and is coloured as one, so it reads as the
    // answer to "why can I not spend here" rather than as part of the mechanics.
    expect(refused[refused.length - 1]?.colorToken).toBe('danger');

    // A skill that *can* be taken says what it does, not why it cannot.
    const allowed = screen.rowFor('str.crushingBlows')?.tooltip() ?? [];
    expect(allowed.map((line) => line.text)).toEqual(['what str.crushingBlows does']);
  });

  it('emits the skill id when a spend button is pressed', () => {
    const { screen } = harness();
    const spent: string[] = [];
    screen.onSpend = (id) => spent.push(id);
    screen.rowFor('str.crushingBlows')?.spendButton.onPress?.(0);
    expect(spent).toEqual(['str.crushingBlows']);
  });

  /** The screen emits an intent and waits, exactly as the inventory does. */
  it('does not raise a level itself when the button is pressed', () => {
    const { screen } = harness();
    screen.onSpend = () => undefined;
    screen.rowFor('str.crushingBlows')?.spendButton.onPress?.(0);
    expect(screen.rowFor('str.crushingBlows')?.skill?.level).toBe(2);
  });

  it('updates a row in place when the answer comes back', () => {
    const { screen, root } = harness();
    const passes = root.layoutPasses;
    const next = viewOf({
      unspentPoints: 1,
      branches: [
        branch('attr:strength', [skill('str.crushingBlows', { level: 3 }), skill('str.unstoppable', { tier: 3 })]),
        branch('attr:wisdom', [skill('wis.discipline', { canSpend: false, blockedBecause: 'needs 10 Wisdom' })]),
      ],
    });
    screen.setCharacter(next);
    root.update(16);
    expect(screen.rowFor('str.crushingBlows')?.skill?.level).toBe(3);
    // The tab the player was looking at is not rebuilt out from under them.
    expect(root.layoutPasses).toBeGreaterThan(passes);
    expect(screen.tabs.tabIds).toEqual(['attributes', 'stats', 'skills']);
  });

  it('opens on the attributes, which is where a point is actually spent', () => {
    // Spec 147 moved the front tab. The old rule was "numbers rather than a
    // tree" and it still holds -- six rows with a "+" on each is the most
    // numeric thing on the sheet, and it is now the first decision a levelling
    // character has to make.
    const { screen } = harness();
    expect(screen.tabs.tabIds[0]).toBe('attributes');
    expect(screen.tabs.tabIds[1]).toBe('stats');
    // Three tabs, not eight: six attribute columns as six tabs overflowed the
    // strip, and they are one tree rather than six.
    expect(screen.tabs.tabIds).toHaveLength(3);
  });

  it('hides the points line only when *both* budgets are empty', () => {
    // Rather than showing "0 points to spend", which is a sentence about
    // nothing taking up a line in a panel that is short of them. Two budgets
    // since spec 147, so either one being non-empty is something to say.
    const none = viewOf({ unspentPoints: 0, unspentAttributePoints: 0 });
    expect(harness(none).screen.pointsLabel.visible).toBe(false);
    expect(harness(viewOf({ unspentPoints: 3, unspentAttributePoints: 0 })).screen.pointsLabel.visible).toBe(true);
    expect(harness(viewOf({ unspentPoints: 0, unspentAttributePoints: 2 })).screen.pointsLabel.visible).toBe(true);
  });

  it('offers a "+" per attribute, and only where the rules allow one', () => {
    const { screen } = harness(
      viewOf({
        attributes: [
          attributeRow('strength', { canAllocate: true }),
          attributeRow('wisdom', { canAllocate: false, blockedBecause: 'no unspent attribute points' }),
        ],
      }),
    );
    expect(screen.attributeRowFor('strength')?.spendButton.enabled).toBe(true);
    expect(screen.attributeRowFor('wisdom')?.spendButton.enabled).toBe(false);
    // The refusal is the server's own words, not a second sentence written here
    // -- appended to the description rather than standing in for it.
    expect(screen.attributeRowFor('wisdom')?.tooltip()).toBe(
      'what wisdom does -- no unspent attribute points',
    );
  });

  it('presses through to the caller with the attribute that was pressed', () => {
    const { screen, root } = harness(
      viewOf({ attributes: [attributeRow('perception', { canAllocate: true })] }),
    );
    const pressed: string[] = [];
    screen.onAllocate = (key) => pressed.push(key);
    screen.attributeRowFor('perception')?.spendButton.onPress?.(0);
    void root;
    expect(pressed).toEqual(['perception']);
  });

  it('never names a two-attribute pair anywhere on the sheet', () => {
    // The design rule, as a test rather than a promise (spec 147). Every string
    // this screen would draw is swept for the fifteen pair names: a future
    // "helpful" addition that listed them would fail here rather than shipping.
    // The interactions are live in the sim; naming them turns a discovery into
    // a menu, which is the opposite of what the sheet is for.
    const { screen } = harness();
    const drawn = [
      ...screen.attributeRowList.map((row) => row.tooltip()),
      ...screen.skillRows.map((row) => row.tooltip()),
      nextChangeLine(screen.shown?.attributes ?? []),
      JSON.stringify(screen.shown ?? {}),
    ].join(' ');
    for (const name of PAIR_NAMES) {
      expect(drawn.includes(name), `the sheet names the pair "${name}"`).toBe(false);
    }
    // And the view has no field to put one in.
    expect('synergies' in (screen.shown ?? {})).toBe(false);
  });

  it('answers a hover with the row under it, and nothing where there is no row', () => {
    // The rows have carried a `tooltip()` since spec 128 and nothing ever asked
    // them; this is the wiring, so it is worth a test that it is wired.
    const { screen, root } = harness(
      viewOf({
        attributes: [
          attributeRow('strength', { nextEffect: 'Crushing Blows', toNext: 2 }),
        ],
      }),
    );
    // The rect a hit test reads only exists once the tab holding it is the one
    // laid out, which is a property of the panel rather than of this screen.
    screen.tabs.select('attributes');
    root.update(0);
    const row = screen.attributeRowFor('strength');
    expect(row).not.toBeNull();
    if (!row) return;
    const middle = { x: row.rect.x + row.rect.width / 2, y: row.rect.y + row.rect.height / 2 };
    expect(screen.hintAt(middle)).toBe('what strength does -- 2 more: Crushing Blows');
    expect(screen.hintAt({ x: -50, y: -50 })).toBe('');
  });

  it('answers only from the tab you are looking at', () => {
    // A tab that is switched away is *hidden*, never destroyed (spec 124), so
    // every row in it keeps `visible` true and keeps the rectangle it was last
    // arranged into. Asking the rows directly therefore answered a hover over
    // the Attributes tab with whichever skill happened to be laid out at the
    // same coordinates -- which is the whole of the report this test is for.
    const { screen, root } = harness(
      viewOf({ attributes: [attributeRow('strength', { description: 'Overpower.' })] }),
    );
    screen.tabs.select('attributes');
    root.update(0);
    const row = screen.attributeRowFor('strength');
    expect(row).not.toBeNull();
    if (!row) return;
    const middle = { x: row.rect.x + row.rect.width / 2, y: row.rect.y + row.rect.height / 2 };
    expect(screen.hintAt(middle)).toContain('Overpower.');

    // Same coordinates, a different tab. The row is still there and still has
    // that rectangle; it is just not what the player is looking at.
    screen.tabs.select('skills');
    root.update(0);
    expect(screen.hintAt(middle)).not.toContain('Overpower.');
  });

  it('answers a hover over a stat line with that line\'s own hint', () => {
    // The stat rows are bare labels rather than a row class, so they are found
    // by position in the list rather than by type -- worth its own case, since
    // an off-by-one there would hand every stat its neighbour's sentence.
    const { screen, root } = harness();
    screen.tabs.select('stats');
    root.update(0);
    const rows = screen.statRowList;
    expect(rows.length).toBeGreaterThan(1);
    for (const [index, row] of rows.entries()) {
      const at = { x: row.rect.x + 2, y: row.rect.y + row.rect.height / 2 };
      expect(screen.hintAt(at)).toBe(screen.shown?.stats[index]?.hint);
    }
  });

  it('still says what an attribute does when there is nothing to spend', () => {
    // The refusal used to *replace* the description, so a character between two
    // level-ups -- which is nearly always -- got "no unspent attribute points"
    // on all six rows and no way to find out what any of them were for.
    const { screen } = harness(
      viewOf({
        unspentAttributePoints: 0,
        attributes: [
          attributeRow('strength', {
            description: 'Overpower. Poise damage, stagger duration.',
            canAllocate: false,
            blockedBecause: 'no unspent attribute points',
            nextEffect: 'Committed Swing — hyper-armour while winding up',
            toNext: 3,
          }),
        ],
      }),
    );
    const hint = screen.attributeRowFor('strength')?.tooltip() ?? '';
    expect(hint).toContain('Overpower. Poise damage, stagger duration.');
    // ...and the other two clauses are appended, not substituted for it.
    expect(hint).toContain('Committed Swing');
    expect(hint).toContain('no unspent attribute points');
  });

  it('says so when a stat is not implemented, rather than describing it', () => {
    const { screen } = harness(
      viewOf({
        stats: [{ label: 'Attack speed', value: '+0 (1.00x)', hint: 'Not implemented: nothing grants it yet.' }],
      }),
    );
    screen.tabs.select('stats');
    // The hint is whatever the content table said. A screen that wrote its own
    // would be a second description to keep in step with the code.
    expect(screen.shown?.stats[0]?.hint).toContain('Not implemented');
  });

  it('names the nearest change rather than listing all six', () => {
    // The brief's "surface what mechanically changes next", taken literally:
    // one sentence, about whichever attribute is closest to doing something.
    expect(
      nextChangeLine([
        attributeRow('strength', { toNext: 9, nextEffect: 'Committed Swing' }),
        attributeRow('perception', { toNext: 2, nextEffect: 'Opening Read' }),
        attributeRow('wisdom', { toNext: 0, nextEffect: '' }),
      ]),
    ).toBe('2 more PER: Opening Read');
    expect(nextChangeLine([attributeRow('wisdom', { toNext: 0, nextEffect: '' })])).toBe('');
  });
});

/**
 * A tab is built lazily on first selection and then kept (spec 124), so the
 * view it is built *from* is not the view the sheet was last handed. The
 * factories used to close over the `CharacterView` that happened to be current
 * when the tabs were registered -- which is the one the sheet opened on -- so a
 * player who allocated an attribute and only then looked at the tree got a tree
 * gated on the attributes they had before they spent.
 */
describe('a tab built after the sheet has moved on', () => {
  function opened(view: CharacterView): { screen: CharacterScreen; root: UiRoot } {
    const screen = new CharacterScreen({ theme: THEME });
    screen.setCharacter(view);
    const root = new UiRoot(screen, {
      theme: THEME,
      atlas: bakeAtlas(THEME),
      viewport: { width: 400, height: 300 },
    });
    root.update(0);
    return { screen, root };
  }

  const locked = branch('attr:wisdom', [
    skill('wis.discipline', { canSpend: false, blockedBecause: 'needs 10 Wisdom, you have 8' }),
  ]);
  const open = branch('attr:wisdom', [skill('wis.discipline')]);

  it('gates the tree on the attributes the sheet was last told about', () => {
    const { screen, root } = opened(viewOf({ branches: [locked] }));

    // The point lands while the player is still on the Attributes tab.
    screen.setCharacter(viewOf({ branches: [open] }));
    root.update(16);

    // Only now do they go and look at what it opened.
    screen.tabs.select('skills');
    root.update(32);
    expect(screen.rowFor('wis.discipline')?.spendButton.enabled).toBe(true);
    expect(screen.rowFor('wis.discipline')?.tooltip()).not.toContain('needs 10 Wisdom');
  });

  /**
   * The same fault seen from the other side, and the one a player would report
   * as "my points went nowhere": what is *in* a skill is drawn from the same
   * view the gate is, so a tree first opened after a point was spent showed the
   * level it had before.
   */
  it('shows what was already spent, not what was spent as of opening', () => {
    const { screen, root } = opened(
      viewOf({ branches: [branch('attr:wisdom', [skill('wis.discipline', { level: 0 })])] }),
    );
    screen.setCharacter(
      viewOf({ branches: [branch('attr:wisdom', [skill('wis.discipline', { level: 2 })])] }),
    );
    root.update(16);

    screen.tabs.select('skills');
    root.update(32);
    expect(screen.rowFor('wis.discipline')?.skill?.level).toBe(2);
  });
});
