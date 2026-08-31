/**
 * Which tabs a page is offered (specs 140, 253).
 *
 * `main.ts` is DOM from its first line and cannot be reached from Vitest, which
 * is exactly why this one decision was lifted out of it: a seventh workbench
 * added without a `game` flag should fail here rather than turn up on a phone --
 * or, since spec 253, in front of a player.
 */

import type { ViewHandle } from './view-handle.js';
import { describe, expect, it } from 'vitest';
import { mountLanded, showsTabButtons, tabPress, visibleTabs, type ShellTab } from './shell-tabs.js';

const TABS: readonly ShellTab[] = [
  { label: 'Play', game: true },
  { label: 'Movement sandbox' },
  { label: 'Rig debug' },
  { label: 'Map editor' },
  { label: 'Studio' },
  { label: 'VFX' },
  // Spec 229. A workbench: it is a tree, a form and a file picker.
  { label: 'SFX' },
];

describe('the tabs a page is offered', () => {
  it('offers every tab on a mouse, at a bench', () => {
    expect(visibleTabs(TABS, false)).toEqual(TABS);
  });

  it('offers only the game on a finger, and in the shipped client', () => {
    // One filter over both reasons (spec 253). The argument is `gameOnly`
    // rather than `compact` precisely so that there is no second rule here to
    // disagree with this one about which tabs are the game.
    expect(visibleTabs(TABS, true).map((tab) => tab.label)).toEqual(['Play']);
  });

  it('leaves not one bench in the shipped client', () => {
    // The list this asserts against is the tab array in `main.ts`, and the
    // point of naming all six is that adding a seventh without a `game` flag
    // has to keep being caught here.
    expect(visibleTabs(TABS, true).some((tab) => tab.game !== true)).toBe(false);
    expect(visibleTabs(TABS, true)).toHaveLength(1);
  });

  it('keeps every tab marked as the game, rather than just the first', () => {
    // If a second playable view ever arrives, it comes along; the rule is the
    // flag and not "the first entry".
    const two = [...TABS, { label: 'Arena', game: true }];
    expect(visibleTabs(two, true).map((tab) => tab.label)).toEqual(['Play', 'Arena']);
  });

  it('falls back to the whole list rather than hiding everything', () => {
    // A list with no game in it is not a case this can improve on, and a shell
    // with no tabs mounts nothing and shows a black page.
    const workbenches = TABS.filter((tab) => tab.game !== true);
    expect(visibleTabs(workbenches, true)).toEqual(workbenches);
  });

  it('draws no tab buttons when there is only one tab to be on', () => {
    // Which is what takes the strip off the top of the world in the game build
    // (spec 253): the buttons are not hidden, there is nothing left to draw.
    expect(showsTabButtons(visibleTabs(TABS, true))).toBe(false);
    expect(showsTabButtons(visibleTabs(TABS, false))).toBe(true);
  });
});

describe('what pressing a tab does while a mount is in flight (spec 203)', () => {
  const none = new Set<number>();
  /** A stand-in for a mounted view: only its presence is ever read. */
  const held: ViewHandle = {
    element: null as unknown as HTMLElement,
    start: () => undefined,
    stop: () => undefined,
  };

  it('mounts a tab that has never been mounted', () => {
    expect(tabPress(1, 0, none, null)).toBe('mount');
  });

  it('mounts a tab whose slot holds null, not just one that holds undefined', () => {
    // The bug this signature exists to prevent, and it took the whole app down.
    // The shell keeps its views in a `(ViewHandle | null)[]` filled with `null`,
    // and the call site asked `handles[i] !== undefined` -- true for `null` --
    // so **every tab reported itself already mounted**, took the `show` branch,
    // found nothing and returned. Nothing mounted and nothing threw: the tab bar
    // drew over an empty app.
    //
    // Every test in this block passed throughout, because the decision was right
    // and the question was wrong. `held` is the handle now, so a caller cannot
    // get emptiness wrong.
    const slots: (ViewHandle | null)[] = [null, null];
    expect(tabPress(1, 0, none, slots[1])).toBe('mount');
    expect(tabPress(1, 0, none, slots[5])).toBe('mount');
  });

  it('shows one that was mounted and put away', () => {
    expect(tabPress(1, 0, none, held)).toBe('show');
  });

  it('ignores a press on the tab already showing', () => {
    expect(tabPress(0, 0, none, held)).toBe('ignore');
  });

  it('ignores a second press while the first mount is still in flight', () => {
    // The one that matters. `active` moves on the press so the button lights
    // at once, so without the in-flight set a second press would see
    // `index !== active` only on the *first* press and `held` false on both --
    // two mounts, two in-tab servers, one of them orphaned.
    expect(tabPress(1, 1, new Set([1]), null)).toBe('ignore');
    expect(tabPress(1, 0, new Set([1]), null)).toBe('ignore');
  });

  it('shows a mount that lands on the tab still being looked at', () => {
    expect(mountLanded(2, 2)).toBe('show');
  });

  it('shelves one that lands after the player moved on', () => {
    expect(mountLanded(2, 0)).toBe('shelve');
  });
});
