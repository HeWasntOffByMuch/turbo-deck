/**
 * The character sheet (spec 128).
 *
 * The screen knows nothing about tier gates or branch locks -- `canSpend` and
 * `blockedBecause` arrive decided. So what is worth asserting here is that it
 * *obeys* them: a button is enabled exactly when it was told it may be, and a
 * disabled one can say why.
 */

import { describe, expect, it } from 'vitest';
import { UiRoot } from '../core/root.js';
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

function branch(id: string, skills: readonly SkillView[], locked = false): BranchView {
  return { id, name: id, locked, pointsSpent: 0, skills };
}

function viewOf(overrides: Partial<CharacterView> = {}): CharacterView {
  return {
    name: 'Kestrel',
    level: 4,
    experience: { current: 120, toNext: 260 },
    unspentPoints: 2,
    unspentAttributePoints: 3,
    attributes: [],
    synergies: [],
    statSkills: [],
    respec: { cost: 40, enabled: true },
    stats: [
      { label: 'Health', value: '138' },
      { label: 'Damage', value: '12' },
    ],
    branches: [
      branch('might', [skill('might.toughness', { level: 2 }), skill('might.cleave', { tier: 2 })]),
      branch('arcane', [skill('arcane.focus', { canSpend: false, blockedBecause: 'the arcane branch is locked' })], true),
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
    expect(screen.rowFor('might.toughness')?.spendButton.enabled).toBe(true);
    expect(screen.rowFor('arcane.focus')?.spendButton.enabled).toBe(false);
  });

  it('says why a skill cannot be taken, in the words the refusal would use', () => {
    const { screen } = harness();
    expect(screen.rowFor('arcane.focus')?.tooltip()).toContain('the arcane branch is locked');
    // A skill that *can* be taken says what it does, not why it cannot.
    expect(screen.rowFor('might.toughness')?.tooltip()).toBe('what might.toughness does');
  });

  it('emits the skill id when a spend button is pressed', () => {
    const { screen } = harness();
    const spent: string[] = [];
    screen.onSpend = (id) => spent.push(id);
    screen.rowFor('might.toughness')?.spendButton.onPress?.(0);
    expect(spent).toEqual(['might.toughness']);
  });

  /** The screen emits an intent and waits, exactly as the inventory does. */
  it('does not raise a level itself when the button is pressed', () => {
    const { screen } = harness();
    screen.onSpend = () => undefined;
    screen.rowFor('might.toughness')?.spendButton.onPress?.(0);
    expect(screen.rowFor('might.toughness')?.skill?.level).toBe(2);
  });

  it('updates a row in place when the answer comes back', () => {
    const { screen, root } = harness();
    const passes = root.layoutPasses;
    const next = viewOf({
      unspentPoints: 1,
      branches: [
        branch('might', [skill('might.toughness', { level: 3 }), skill('might.cleave', { tier: 2 })]),
        branch('arcane', [skill('arcane.focus', { canSpend: false, blockedBecause: 'locked' })], true),
      ],
    });
    screen.setCharacter(next);
    root.update(16);
    expect(screen.rowFor('might.toughness')?.skill?.level).toBe(3);
    // The tab the player was looking at is not rebuilt out from under them.
    expect(root.layoutPasses).toBeGreaterThan(passes);
    expect(screen.tabs.tabIds).toEqual(['attributes', 'stats', 'might', 'arcane']);
  });

  it('opens on the attributes, which is where a point is actually spent', () => {
    // Spec 147 moved the front tab. The old rule was "numbers rather than a
    // tree" and it still holds -- six rows with a "+" on each is the most
    // numeric thing on the sheet, and it is now the first decision a levelling
    // character has to make.
    const { screen } = harness();
    expect(screen.tabs.tabIds[0]).toBe('attributes');
    expect(screen.tabs.tabIds[1]).toBe('stats');
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
    // The refusal is what the tooltip says, not a second sentence written here.
    expect(screen.attributeRowFor('wisdom')?.tooltip()).toBe('no unspent attribute points');
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
