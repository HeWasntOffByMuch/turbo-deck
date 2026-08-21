/**
 * Which tabs a device is offered (spec 140).
 *
 * `main.ts` is DOM from its first line and cannot be reached from Vitest, which
 * is exactly why this one decision was lifted out of it: a seventh workbench
 * added without a `game` flag should fail here rather than turn up on a phone.
 */

import { describe, expect, it } from 'vitest';
import { mountLanded, showsTabButtons, tabPress, visibleTabs, type ShellTab } from './shell-tabs.js';

const TABS: readonly ShellTab[] = [
  { label: 'Play', game: true },
  { label: 'Movement sandbox' },
  { label: 'Rig debug' },
  { label: 'Map editor' },
  { label: 'Studio' },
  { label: 'VFX' },
];

describe('the tabs a device is offered', () => {
  it('offers every tab on a mouse', () => {
    expect(visibleTabs(TABS, false)).toEqual(TABS);
  });

  it('offers only the game on a finger', () => {
    expect(visibleTabs(TABS, true).map((tab) => tab.label)).toEqual(['Play']);
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
    expect(showsTabButtons(visibleTabs(TABS, true))).toBe(false);
    expect(showsTabButtons(visibleTabs(TABS, false))).toBe(true);
  });
});

describe('what pressing a tab does while a mount is in flight (spec 199)', () => {
  const none = new Set<number>();

  it('mounts a tab that has never been mounted', () => {
    expect(tabPress(1, 0, none, false)).toBe('mount');
  });

  it('shows one that was mounted and put away', () => {
    expect(tabPress(1, 0, none, true)).toBe('show');
  });

  it('ignores a press on the tab already showing', () => {
    expect(tabPress(0, 0, none, true)).toBe('ignore');
  });

  it('ignores a second press while the first mount is still in flight', () => {
    // The one that matters. `active` moves on the press so the button lights
    // at once, so without the in-flight set a second press would see
    // `index !== active` only on the *first* press and `held` false on both --
    // two mounts, two in-tab servers, one of them orphaned.
    expect(tabPress(1, 1, new Set([1]), false)).toBe('ignore');
    expect(tabPress(1, 0, new Set([1]), false)).toBe('ignore');
  });

  it('shows a mount that lands on the tab still being looked at', () => {
    expect(mountLanded(2, 2)).toBe('show');
  });

  it('shelves one that lands after the player moved on', () => {
    expect(mountLanded(2, 0)).toBe('shelve');
  });
});
