import { describe, expect, it } from 'vitest';
import { KeybindingsScreen } from './keybindings.js';
import { ContextStack, NO_MODIFIERS, type UiEvent } from '../core/events.js';
import { UiRoot } from '../core/root.js';
import { chordLabel } from '../input/actions.js';
import { InputMap, type Modifiers } from '../input/input-map.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';

const ATLAS = bakeAtlas(THEME);
const NONE: Modifiers = { shift: false, ctrl: false, alt: false, meta: false };

function screen(): { screen: KeybindingsScreen; map: InputMap; contexts: ContextStack; root: UiRoot } {
  const map = new InputMap();
  const contexts = new ContextStack();
  const built = new KeybindingsScreen({ theme: THEME, map, contexts });
  built.buildAllTabs();
  const root = new UiRoot(built, { theme: THEME, atlas: ATLAS, viewport: { width: 260, height: 180 } });
  root.update(0);
  built.refresh();
  root.update(16);
  return { screen: built, map, contexts, root };
}

function key(code: string, mods: Modifiers = NONE): UiEvent {
  return { kind: 'key', phase: 'down', code, mods: { ...NO_MODIFIERS, ...mods }, time: 0 };
}

describe('the keybinding screen', () => {
  it('has a tab per category and a row per action', () => {
    const { screen: built, map } = screen();
    expect(built.tabs.tabIds).toEqual(['movement', 'combat', 'skillbar', 'ui', 'debug']);
    expect(built.builtRows()).toHaveLength(map.definitions.length);
  });

  it('shows each action’s chords as a player reads them', () => {
    const { screen: built } = screen();
    const row = built.builtRows().find((candidate) => candidate.action.id === 'move.north');
    expect(row?.primaryButton.label).toBe('W');
    expect(row?.secondaryButton.label).toBe('Up');
  });

  it('flags an unbound action rather than leaving it blank', () => {
    // Blank reads as "no name", not as "nothing will happen".
    const { screen: built, map } = screen();
    map.bind('combat.stop', 'primary', null);
    built.refresh();
    const row = built.builtRows().find((candidate) => candidate.action.id === 'combat.stop');
    expect(row?.primaryButton.label).toBe(chordLabel(null));
    expect(row?.primaryButton.label).toBe('Unbound');
  });
});

describe('capture', () => {
  it('binds the next key pressed', () => {
    const { screen: built, map } = screen();
    built.beginCapture('move.north', 'primary');
    expect(built.capturing).toEqual({ actionId: 'move.north', slot: 'primary' });

    built.captureKey('KeyT', NONE);
    expect(built.capturing).toBe(null);
    expect(map.resolve('KeyT', NONE, 'gameplay')).toContain('move.north');
    expect(map.resolve('KeyW', NONE, 'gameplay')).not.toContain('move.north');
  });

  it('pushes textEntry while capturing and pops it after', () => {
    // The whole reason contexts are a stack: while capturing, Digit1 must bind
    // and not also cast.
    const { screen: built, contexts } = screen();
    expect(contexts.reachesGameplay('key')).toBe(true);

    built.beginCapture('skillbar.1', 'primary');
    expect(contexts.has('textEntry')).toBe(true);
    expect(contexts.reachesGameplay('key')).toBe(false);

    built.captureKey('Digit4', NONE);
    expect(contexts.has('textEntry')).toBe(false);
    expect(contexts.reachesGameplay('key')).toBe(true);
  });

  it('keeps the modifiers that were held', () => {
    const { screen: built, map } = screen();
    built.beginCapture('combat.stop', 'primary');
    built.captureKey('KeyQ', { ...NONE, ctrl: true, shift: true });
    expect(map.bindingsFor('combat.stop').primary).toEqual({ code: 'KeyQ', ctrl: true, shift: true });
    expect(map.resolve('KeyQ', NONE, 'gameplay')).toEqual([]);
  });

  it('Escape cancels rather than binding', () => {
    const { screen: built, map, contexts } = screen();
    built.beginCapture('move.north', 'primary');
    built.captureKey('Escape', NONE);
    expect(built.capturing).toBe(null);
    expect(contexts.has('textEntry')).toBe(false);
    expect(map.isModified('move.north')).toBe(false);
  });

  it('ignores a bare modifier and stays open', () => {
    // Reaching for Ctrl+K means pressing Ctrl first.
    const { screen: built } = screen();
    built.beginCapture('move.north', 'primary');
    built.captureKey('ShiftLeft', NONE);
    expect(built.capturing).not.toBe(null);
    built.captureKey('KeyK', { ...NONE, shift: true });
    expect(built.capturing).toBe(null);
  });

  it('swallows a key event while capturing, and passes it on when not', () => {
    const { screen: built, root, map } = screen();
    root.handle(key('KeyT'));
    expect(map.isModified('move.north')).toBe(false);

    built.beginCapture('move.north', 'primary');
    root.handle(key('KeyT'));
    expect(map.resolve('KeyT', NONE, 'gameplay')).toContain('move.north');
  });

  it('unbinds the slot being captured', () => {
    const { screen: built, map } = screen();
    built.beginCapture('combat.stop', 'primary');
    built.unbindCapturing();
    expect(map.isUnbound('combat.stop')).toBe(true);
    expect(built.capturing).toBe(null);
  });

  it('opening a second capture closes the first cleanly', () => {
    const { screen: built, contexts } = screen();
    built.beginCapture('move.north', 'primary');
    built.beginCapture('move.south', 'primary');
    expect(built.capturing?.actionId).toBe('move.south');
    built.cancelCapture();
    // Not left one deep: an unbalanced push would swallow the keyboard forever.
    expect(contexts.has('textEntry')).toBe(false);
  });
});

describe('conflicts', () => {
  it('binds anyway and says what it clashes with', () => {
    const { screen: built, map } = screen();
    built.beginCapture('move.south', 'primary');
    built.captureKey('KeyW', NONE);

    expect(built.conflict).toContain('Move north');
    // Both live. Refusing would make swapping two keys impossible.
    expect([...map.resolve('KeyW', NONE, 'gameplay')].sort()).toEqual(['move.north', 'move.south']);
  });

  it('says nothing for a free chord', () => {
    const { screen: built } = screen();
    built.beginCapture('move.south', 'primary');
    built.captureKey('KeyT', NONE);
    expect(built.conflict).toBe('');
  });

  it('does not warn about a chord already on the same action', () => {
    const { screen: built } = screen();
    built.beginCapture('move.north', 'primary');
    built.captureKey('ArrowUp', NONE);
    expect(built.conflict).toBe('');
  });
});

describe('reset', () => {
  it('restores one action and disables its own reset button', () => {
    const { screen: built, map } = screen();
    const row = built.builtRows().find((candidate) => candidate.action.id === 'move.north');
    expect(row?.resetButton.enabled).toBe(false);

    map.bind('move.north', 'primary', { code: 'KeyT' });
    built.refresh();
    expect(row?.resetButton.enabled).toBe(true);

    built.resetAction('move.north');
    expect(row?.primaryButton.label).toBe('W');
    expect(row?.resetButton.enabled).toBe(false);
  });

  it('reset-all clears every override', () => {
    const { screen: built, map } = screen();
    map.bind('move.north', 'primary', { code: 'KeyT' });
    map.bind('skillbar.1', 'primary', { code: 'KeyQ' });
    built.resetAllButton.press();
    expect(map.toOverrides()).toEqual([]);
  });
});

describe('filtering', () => {
  it('hides rows that do not match, and shows them all again when cleared', () => {
    const { screen: built, root } = screen();
    const total = built.visibleRows().length;

    built.filter.setText('skillbar');
    built.refresh();
    root.update(32);
    const filtered = built.visibleRows();
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(total);
    for (const row of filtered) expect(row.action.category).toBe('skillbar');

    built.filter.setText('');
    built.refresh();
    expect(built.visibleRows()).toHaveLength(total);
  });

  it('matches the label and the id, case-insensitively', () => {
    const { screen: built } = screen();
    // Case-insensitive: shouting at it finds the same row.
    built.filter.setText('MOVE NORTH');
    built.refresh();
    expect(built.visibleRows().map((row) => row.action.id)).toEqual(['move.north']);

    built.filter.setText('north');
    built.refresh();
    expect(built.visibleRows().map((row) => row.action.id)).toEqual(['move.north']);

    built.filter.setText('ui.');
    built.refresh();
    expect(built.visibleRows().every((row) => row.action.id.startsWith('ui.'))).toBe(true);
  });
});
