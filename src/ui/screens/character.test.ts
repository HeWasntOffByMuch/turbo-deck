/**
 * The progression sheet: six tracks, one pool (spec 244).
 *
 * What this file is for is unchanged from spec 128: the screen decides nothing
 * about the rules, so every case here is about *presenting* an answer that
 * arrived already decided -- and about the two ways a widget tree lies, which is
 * a rectangle belonging to something nobody can see and a tab built from a view
 * the sheet has moved on from.
 */

import { describe, expect, it } from 'vitest';
import { allAttributePairs } from '../../server/data/attributes.js';
import { NO_MODIFIERS } from '../core/events.js';
import { UiRoot } from '../core/root.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import {
  CharacterScreen,
  nextChangeLine,
  tierPips,
  type CharacterView,
  type SpecializationView,
  type TrackNodeView,
  type TrackView,
} from './character.js';

function specialization(
  id: string,
  overrides: Partial<SpecializationView> = {},
): SpecializationView {
  return {
    id,
    name: id,
    tier: 0,
    maxTier: 3,
    cost: 1,
    unlocked: true,
    description: `what ${id} does`,
    canSpend: true,
    blockedBecause: '',
    ...overrides,
  };
}

function node(
  threshold: number,
  specializations: readonly SpecializationView[] = [],
  milestone: TrackNodeView['milestone'] = null,
  reached = true,
): TrackNodeView {
  return { threshold, reached, milestone, specializations };
}

function track(key: string, overrides: Partial<TrackView> = {}): TrackView {
  return {
    key,
    name: key,
    abbrev: key.slice(0, 3).toUpperCase(),
    description: `what ${key} does`,
    from: 5,
    allocated: 12,
    total: 12,
    canAdvance: true,
    blockedBecause: '',
    nextThreshold: 0,
    toNext: 0,
    nextEffect: '',
    tiersBought: 0,
    nodes: [],
    ...overrides,
  };
}

function viewOf(overrides: Partial<CharacterView> = {}): CharacterView {
  return {
    name: 'Kestrel',
    level: 4,
    experience: { current: 120, toNext: 260 },
    unspentPoints: 2,
    respec: { cost: 40, enabled: true },
    stats: [
      { label: 'Health', value: '138', hint: 'damage you can take before dying' },
      { label: 'Damage', value: '12', hint: 'how hard your weapon hits' },
    ],
    tracks: [
      track('strength', {
        nodes: [
          node(10, [
            specialization('str.crushingBlows', { tier: 2 }),
            specialization('str.unstoppable', { maxTier: 1 }),
          ]),
          node(20, [], { name: 'Crushing Blows', effect: 'Blows carry 25% more poise damage.' }),
        ],
      }),
      track('wisdom', {
        nodes: [
          node(
            10,
            [
              specialization('wis.discipline', {
                unlocked: false,
                canSpend: false,
                blockedBecause: 'needs 10 Wisdom',
              }),
            ],
            null,
            false,
          ),
        ],
      }),
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

describe('the progression sheet', () => {
  it('shows who this is and how far to the next level', () => {
    const { screen } = harness();
    expect(screen.experience.filled).toBeCloseTo(120 / 260);
    expect(screen.shown?.level).toBe(4);
  });

  it('has two tabs and neither is the old split', () => {
    // Attributes and Skills were the two halves of a split that no longer
    // exists; Progression is both of them. Stats stays, because a derived
    // readout is a different kind of information from an investment.
    const { screen } = harness();
    expect(screen.tabs.tabIds).toEqual(['progression', 'stats']);
    expect(screen.tabs.tabIds).not.toContain('attributes');
    expect(screen.tabs.tabIds).not.toContain('skills');
  });

  it('opens on a track rather than on nothing', () => {
    // An empty detail panel under six rows reads as a screen that failed to
    // load, and there is no state in which no track is worth looking at.
    const { screen } = harness();
    expect(screen.selectedTrack).toBe('strength');
    expect(screen.rowFor('str.crushingBlows')).not.toBeNull();
  });

  it('draws one row per track, whatever is on it', () => {
    const { screen } = harness();
    expect(screen.trackRowList.map((row) => row.trackKey)).toEqual(['strength', 'wisdom']);
  });

  it('enables a spend button exactly when it was told it may', () => {
    const { screen } = harness();
    expect(screen.rowFor('str.crushingBlows')?.spendButton.enabled).toBe(true);
    screen.selectTrack('wisdom');
    expect(screen.rowFor('wis.discipline')?.spendButton.enabled).toBe(false);
  });

  it('enables a track "+" exactly when it was told it may', () => {
    const { screen } = harness(
      viewOf({
        tracks: [
          track('strength', { canAdvance: true }),
          track('wisdom', { canAdvance: false, blockedBecause: 'no unspent progression points' }),
        ],
      }),
    );
    expect(screen.trackRowFor('strength')?.advanceButton.enabled).toBe(true);
    expect(screen.trackRowFor('wisdom')?.advanceButton.enabled).toBe(false);
  });

  it('says why a tier cannot be taken, in the words the refusal would use', () => {
    // A tooltip is a list of lines rather than one string since spec 191: a
    // description is a Technical Description, and `Tooltip` wraps per line, so
    // handing it over as prose would run every fact into a paragraph.
    const { screen } = harness();
    screen.selectTrack('wisdom');
    const refused = screen.rowFor('wis.discipline')?.tooltip() ?? [];
    expect(refused.map((line) => line.text)).toContain('needs 10 Wisdom');
    // The refusal is the *last* line and is coloured as one, so it reads as the
    // answer to "why can I not spend here" rather than as part of the mechanics.
    expect(refused[refused.length - 1]?.colorToken).toBe('danger');

    // One that *can* be taken says what it does and what the next tier costs.
    // Back to Strength first: the detail panel holds one track's rows at a time,
    // which is the point of it, so the other track's are gone rather than hidden.
    screen.selectTrack('strength');
    const allowed = screen.rowFor('str.crushingBlows')?.tooltip() ?? [];
    expect(allowed.map((line) => line.text)).toContain('what str.crushingBlows does');
    expect(allowed.map((line) => line.text)).toContain('Next tier: 3 of 3, 1 point(s)');
    expect(allowed.some((line) => line.colorToken === 'danger')).toBe(false);
  });

  it('emits the specialization id when a spend button is pressed', () => {
    const { screen } = harness();
    const spent: string[] = [];
    screen.onSpend = (id) => spent.push(id);
    screen.rowFor('str.crushingBlows')?.spendButton.onPress?.(0);
    expect(spent).toEqual(['str.crushingBlows']);
  });

  it('emits the attribute key when a track "+" is pressed', () => {
    const { screen } = harness();
    const pressed: string[] = [];
    screen.onAdvance = (key) => pressed.push(key);
    screen.trackRowFor('wisdom')?.advanceButton.onPress?.(0);
    expect(pressed).toEqual(['wisdom']);
  });

  /** The screen emits an intent and waits, exactly as the inventory does. */
  it('buys nothing itself when a button is pressed', () => {
    const { screen } = harness();
    screen.onSpend = () => undefined;
    screen.onAdvance = () => undefined;
    screen.rowFor('str.crushingBlows')?.spendButton.onPress?.(0);
    screen.trackRowFor('strength')?.advanceButton.onPress?.(0);
    expect(screen.rowFor('str.crushingBlows')?.specialization?.tier).toBe(2);
    expect(screen.trackRowFor('strength')?.track?.total).toBe(12);
  });

  it('selects a track when its name is pressed', () => {
    const { screen } = harness();
    screen.trackRowFor('wisdom')?.selectButton.onPress?.(0);
    expect(screen.selectedTrack).toBe('wisdom');
    expect(screen.rowFor('wis.discipline')).not.toBeNull();
    // ...and the other track's rows are gone rather than stacked behind it.
    expect(screen.rowFor('str.crushingBlows')).toBeNull();
  });

  it('updates a row in place when the answer comes back', () => {
    const { screen, root } = harness();
    const passes = root.layoutPasses;
    const next = viewOf({
      unspentPoints: 1,
      tracks: [
        track('strength', {
          nodes: [
            node(10, [
              specialization('str.crushingBlows', { tier: 3 }),
              specialization('str.unstoppable', { maxTier: 1 }),
            ]),
          ],
        }),
        track('wisdom'),
      ],
    });
    screen.setCharacter(next);
    root.update(16);
    expect(screen.rowFor('str.crushingBlows')?.specialization?.tier).toBe(3);
    expect(root.layoutPasses).toBeGreaterThan(passes);
    expect(screen.tabs.tabIds).toEqual(['progression', 'stats']);
  });

  it('hides the points line only when the pool is empty', () => {
    // Rather than showing "0 points to spend", which is a sentence about
    // nothing taking up a line in a panel that is short of them. One budget
    // since spec 244, so one condition.
    expect(harness(viewOf({ unspentPoints: 0 })).screen.pointsLabel.visible).toBe(false);
    expect(harness(viewOf({ unspentPoints: 1 })).screen.pointsLabel.visible).toBe(true);
    expect(harness(viewOf({ unspentPoints: 3 })).screen.pointsLabel.visible).toBe(true);
  });

  it('says "progression point" rather than naming two budgets', () => {
    const one = harness(viewOf({ unspentPoints: 1 })).screen;
    expect(one.pointsLabel.text).toBe('1 progression point');
    const many = harness(viewOf({ unspentPoints: 4 })).screen;
    expect(many.pointsLabel.text).toBe('4 progression points');
    for (const label of [one.pointsLabel.text, many.pointsLabel.text]) {
      expect(label).not.toContain('skill');
      expect(label).not.toContain('attribute');
    }
  });

  it('draws every string it composes in the face it has (spec 227)', () => {
    // These faces are ASCII and `glyphFor` falls back silently, so a curly
    // apostrophe or an em dash draws as a hole nobody notices until somebody
    // photographs the screen. Every string this file's own widgets build --
    // as opposed to content handed to them -- is checked.
    const { screen } = harness();
    const composed = [
      screen.pointsLabel.text,
      tierPips(1, 3),
      tierPips(0, 1),
      tierPips(3, 3),
      ...screen.trackRowList.flatMap((row) => row.tooltip().map((line) => line.text)),
    ];
    for (const text of composed) {
      for (const character of text) {
        expect(character.codePointAt(0) ?? 0, `"${text}" has "${character}"`).toBeLessThan(0x7f);
      }
    }
  });

  it('shows tiers as pips, filled for what is bought', () => {
    expect(tierPips(0, 3)).toBe('[---]');
    expect(tierPips(2, 3)).toBe('[##-]');
    expect(tierPips(3, 3)).toBe('[###]');
    // A single-tier capstone still reads as a state rather than as nothing.
    expect(tierPips(0, 1)).toBe('[-]');
    expect(tierPips(1, 1)).toBe('[#]');
    // And a corrupt tier past the maximum cannot draw more pips than there are.
    expect(tierPips(9, 3)).toBe('[###]');
  });

  it('never names a two-attribute pair anywhere on the sheet (spec 244)', () => {
    // The design rule, as a test rather than a promise. The fifteen authored
    // bonuses are gone from the rules; this is the check that the UI has not
    // grown its own copy, and that no synergy panel came back with the rewrite.
    const { screen } = harness();
    const drawn = [
      ...screen.trackRowList.flatMap((row) => row.tooltip().map((line) => line.text)),
      ...screen.specializationRowList.flatMap((row) => row.tooltip().map((line) => line.text)),
      nextChangeLine(screen.shown?.tracks ?? []),
      JSON.stringify(screen.shown ?? {}),
    ]
      .join(' ')
      .toLowerCase();
    expect(drawn).not.toContain('synerg');
    for (const [a, b] of allAttributePairs()) {
      expect(drawn.includes(`${a}+${b}`), `${a}+${b}`).toBe(false);
    }
    // And the view has no field to put one in.
    expect('synergies' in (screen.shown ?? {})).toBe(false);
    expect('pairs' in (screen.shown ?? {})).toBe(false);
  });

  it('answers a hover with the row under it, and nothing where there is no row', () => {
    const { screen, root } = harness(
      viewOf({
        tracks: [track('strength', { nextEffect: 'Crushing Blows', toNext: 2, nextThreshold: 20 })],
      }),
    );
    screen.tabs.select('progression');
    root.update(0);
    const row = screen.trackRowFor('strength');
    expect(row).not.toBeNull();
    if (!row) return;
    const middle = { x: row.rect.x + row.rect.width / 2, y: row.rect.y + row.rect.height / 2 };
    const hint = screen.hintAt(middle);
    expect(Array.isArray(hint)).toBe(true);
    expect(JSON.stringify(hint)).toContain('what strength does');
    expect(JSON.stringify(hint)).toContain('Crushing Blows');
    expect(screen.hintAt({ x: -50, y: -50 })).toBe('');
  });

  it('answers only from the tab you are looking at', () => {
    // A tab that is switched away is *hidden*, never destroyed (spec 124), so
    // every row in it keeps `visible` true and keeps the rectangle it was last
    // arranged into. Asking the rows directly therefore answered a hover over
    // the tracks with whichever stat line was laid out at the same coordinates.
    const { screen, root } = harness(
      viewOf({ tracks: [track('strength', { description: 'Overpower.' })] }),
    );
    screen.tabs.select('progression');
    root.update(0);
    const row = screen.trackRowFor('strength');
    expect(row).not.toBeNull();
    if (!row) return;
    const middle = { x: row.rect.x + row.rect.width / 2, y: row.rect.y + row.rect.height / 2 };
    expect(JSON.stringify(screen.hintAt(middle))).toContain('Overpower.');

    screen.tabs.select('stats');
    root.update(0);
    expect(JSON.stringify(screen.hintAt(middle))).not.toContain('Overpower.');
  });

  it("answers a hover over a stat line with that line's own hint", () => {
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

  it('still says what a track does when there is nothing to spend', () => {
    // The refusal used to *replace* the description, so a character between two
    // level-ups -- which is nearly always -- got "no unspent points" on all six
    // rows and no way to find out what any of them were for.
    const { screen } = harness(
      viewOf({
        unspentPoints: 0,
        tracks: [
          track('strength', {
            description: 'Overpower. Poise damage, stagger duration.',
            canAdvance: false,
            blockedBecause: 'no unspent progression points',
            nextEffect: 'Committed Swing: hyper-armour while winding up',
            toNext: 3,
            nextThreshold: 35,
          }),
        ],
      }),
    );
    const lines = (screen.trackRowFor('strength')?.tooltip() ?? []).map((line) => line.text);
    expect(lines.join(' ')).toContain('Overpower. Poise damage, stagger duration.');
    // ...and the other two clauses are appended, not substituted for it.
    expect(lines.join(' ')).toContain('Committed Swing');
    expect(lines.join(' ')).toContain('no unspent progression points');
  });

  it('names the nearest change rather than listing all six', () => {
    // The brief's "surface what mechanically changes next", taken literally:
    // one sentence, about whichever track is closest to doing something.
    expect(
      nextChangeLine([
        track('strength', { toNext: 9, nextEffect: 'Committed Swing' }),
        track('perception', { toNext: 2, nextEffect: 'Opening Read' }),
        track('wisdom', { toNext: 0, nextEffect: '' }),
      ]),
    ).toBe('2 more PER: Opening Read');
    expect(nextChangeLine([track('wisdom', { toNext: 0, nextEffect: '' })])).toBe('');
  });
});

/**
 * A tab is built lazily on first selection and then kept (spec 124), so the
 * view it is built *from* is not the view the sheet was last handed. The
 * factories used to close over the `CharacterView` that happened to be current
 * when the tabs were registered -- which is the one the sheet opened on -- so a
 * player who advanced a track and only then looked at it got a track gated on
 * the attributes they had before they spent.
 */
describe('a tab built after the sheet has moved on', () => {
  function opened(view: CharacterView): { screen: CharacterScreen; root: UiRoot } {
    const screen = new CharacterScreen({ theme: THEME });
    screen.setCharacter(view);
    screen.setCharacter(view);
    const root = new UiRoot(screen, {
      theme: THEME,
      atlas: bakeAtlas(THEME),
      viewport: { width: 400, height: 300 },
    });
    root.update(0);
    return { screen, root };
  }

  const lockedTrack = track('wisdom', {
    nodes: [
      node(
        10,
        [
          specialization('wis.discipline', {
            unlocked: false,
            canSpend: false,
            blockedBecause: 'needs 10 Wisdom, you have 8',
          }),
        ],
        null,
        false,
      ),
    ],
  });
  const openTrack = track('wisdom', {
    nodes: [node(10, [specialization('wis.discipline')])],
  });

  it('gates a track on the attributes the sheet was last told about', () => {
    const { screen, root } = opened(viewOf({ tracks: [lockedTrack] }));

    // The point lands while the player is still on the Stats tab.
    screen.tabs.select('stats');
    root.update(8);
    screen.setCharacter(viewOf({ tracks: [openTrack] }));
    root.update(16);

    // Only now do they go and look at what it opened.
    screen.tabs.select('progression');
    root.update(32);
    expect(screen.rowFor('wis.discipline')?.spendButton.enabled).toBe(true);
    expect(
      (screen.rowFor('wis.discipline')?.tooltip() ?? []).map((line) => line.text).join(' '),
    ).not.toContain('needs 10 Wisdom');
  });

  /**
   * The same fault seen from the other side, and the one a player would report
   * as "my points went nowhere": what is *in* a specialization is drawn from the
   * same view the gate is, so a track first opened after a point was spent
   * showed the tier it had before.
   */
  it('shows what was already spent, not what was spent as of opening', () => {
    const { screen, root } = opened(
      viewOf({
        tracks: [track('wisdom', { nodes: [node(10, [specialization('wis.discipline')])] })],
      }),
    );
    screen.tabs.select('stats');
    root.update(8);
    screen.setCharacter(
      viewOf({
        tracks: [
          track('wisdom', { nodes: [node(10, [specialization('wis.discipline', { tier: 2 })])] }),
        ],
      }),
    );
    root.update(16);

    screen.tabs.select('progression');
    root.update(32);
    expect(screen.rowFor('wis.discipline')?.specialization?.tier).toBe(2);
  });
});

/**
 * The sheet's own half of spec 198.
 *
 * The screen is not wrapped in the mount's `ScrollView`: it pins its heading,
 * its meter, its points line and the tab strip, and the tab under them scrolls.
 * Two things follow that are worth asserting rather than assuming -- the wheel
 * still works over the band that no longer moves, and a row scrolled out from
 * under it is not hovered.
 */
describe('a sheet that scrolls under its tabs', () => {
  /** Mounted in a box too short for the tracks, which is the interesting case. */
  function shortened(): { screen: CharacterScreen; root: UiRoot } {
    const view = viewOf({
      tracks: ['strength', 'agility', 'intelligence', 'constitution', 'perception', 'wisdom'].map(
        (key) =>
          track(key, {
            nodes: [node(10, [specialization(`${key}.one`), specialization(`${key}.two`)])],
          }),
      ),
    });
    const screen = new CharacterScreen({ theme: THEME });
    screen.setCharacter(view);
    const root = new UiRoot(screen, {
      theme: THEME,
      atlas: bakeAtlas(THEME),
      viewport: { width: 200, height: 120 },
    });
    for (const id of screen.tabs.tabIds) screen.tabs.select(id);
    screen.setCharacter(view);
    screen.tabs.select('progression');
    root.update(0);
    return { screen, root };
  }

  it('keeps the tab headers on screen with the body scrolled to its end', () => {
    const { screen, root } = shortened();
    const strip = { ...screen.tabs.headerStrip.rect };
    expect(screen.tabs.bodyScroller?.scrollable).toBe(true);

    screen.tabs.bodyScroller?.scrollTo(9999);
    root.update(16);

    expect(screen.tabs.headerStrip.rect).toEqual(strip);
    for (const rect of screen.tabs.tabRects()) {
      expect(rect.y).toBeGreaterThanOrEqual(screen.rect.y);
      expect(rect.y + rect.height).toBeLessThanOrEqual(screen.rect.y + screen.rect.height);
    }
  });

  it('says nothing about a row that has been scrolled out of the body', () => {
    const { screen, root } = shortened();
    const row = screen.trackRowFor('strength');
    expect(row).not.toBeNull();
    if (!row) return;
    const middle = { x: row.rect.x + row.rect.width / 2, y: row.rect.y + row.rect.height / 2 };
    expect(screen.hintAt(middle)).not.toBe('');

    // Far enough that the row is above the viewport, keeping the rectangle it
    // was last arranged into -- which is now under the pinned band.
    screen.tabs.bodyScroller?.scrollTo(9999);
    root.update(16);
    const moved = { x: row.rect.x + row.rect.width / 2, y: row.rect.y + row.rect.height / 2 };
    expect(moved.y).toBeLessThan(screen.tabs.bodyViewport().y);
    expect(screen.hintAt(moved)).toBe('');
  });

  it('spends a wheel over the pinned heading on the tab under it', () => {
    // The heading is outside the panel, so the notch bubbles past it to the
    // window and dies there unless the screen hands it down.
    const { screen, root } = shortened();
    expect(screen.tabs.bodyScroller?.scrollOffset).toBe(0);
    root.handle({
      kind: 'wheel',
      pos: { x: screen.rect.x + 4, y: screen.rect.y + 2 },
      delta: -2,
      mods: NO_MODIFIERS,
      time: 16,
    });
    root.update(16);
    expect(screen.tabs.bodyScroller?.scrollOffset).toBeGreaterThan(0);
  });
});
