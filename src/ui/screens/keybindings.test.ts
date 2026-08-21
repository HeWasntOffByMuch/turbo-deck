import { describe, expect, it } from 'vitest';
import { KeybindingsScreen } from './keybindings.js';
import { ContextStack, NO_MODIFIERS, type UiEvent } from '../core/events.js';
import { UiRoot } from '../core/root.js';
import { chordLabel } from '../input/actions.js';
import { fontById, measureText } from '../text/font.js';
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

/**
 * A category taller than the window scrolls rather than squashing (spec 197).
 *
 * This window is registered unscrolled and the screen had no scroller in it, so
 * `Linear.shareSpace`'s overflow branch was what a long category met: every row
 * shrunk toward nothing, no bar, and the rows at the bottom unreachable rather
 * than merely off screen. The rows are all one height by construction, so
 * "nobody was squashed" is exactly "they are all the same height as the first".
 */
describe('a category too long for its window', () => {
  it('keeps every row its own height and scrolls instead', () => {
    const map = new InputMap();
    const built = new KeybindingsScreen({ theme: THEME, map, contexts: new ContextStack() });
    built.buildAllTabs();
    const root = new UiRoot(built, { theme: THEME, atlas: ATLAS, viewport: { width: 260, height: 96 } });
    root.update(0);

    // The longest category there is, since a short one would fit and prove
    // nothing.
    const longest = [...built.tabs.tabIds].sort(
      (a, b) =>
        map.definitions.filter((action) => action.category === b).length -
        map.definitions.filter((action) => action.category === a).length,
    )[0];
    expect(longest).toBeDefined();
    if (!longest) return;
    built.tabs.select(longest);
    root.update(16);

    const rows = built.builtRows().filter((row) => row.action.category === longest);
    expect(rows.length).toBeGreaterThan(1);
    const first = rows[0]?.rect.height ?? 0;
    expect(first).toBeGreaterThan(0);
    for (const row of rows) expect(row.rect.height).toBe(first);
    expect(built.tabs.bodyScroller?.scrollable).toBe(true);
  });
});

describe('the keybinding screen', () => {
  it('has a tab per category and a row per action', () => {
    const { screen: built, map } = screen();
    expect(built.tabs.tabIds).toEqual([
      'movement',
      'combat',
      'world',
      'skillbar',
      'camera',
      'ui',
      'debug',
    ]);
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

  /**
   * A reset is a write, and a write that is not announced is not saved (spec
   * 138). It shipped announcing only `bind`, so a key put back to its default
   * came back rebound on the next refresh -- from a profile that still held the
   * override the player had just undone.
   */
  it('says the map changed, so the profile is written', () => {
    const { screen: built, map } = screen();
    const changes: string[] = [];
    built.onBindingsChanged = () => changes.push('changed');

    map.bind('move.north', 'primary', { code: 'KeyT' });
    built.resetAction('move.north');
    expect(changes).toHaveLength(1);

    map.bind('skillbar.1', 'primary', { code: 'KeyQ' });
    built.resetAllButton.press();
    expect(changes).toHaveLength(2);
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

/**
 * Capturing a pointer chord (spec 189).
 *
 * The screen barely changed for this and the tests say why: a button goes
 * through the same `applyBinding`, produces the same conflict notice and writes
 * the same override as a key, because by the time any of that runs there is only
 * a chord and it does not remember what pressed it.
 */
describe('capturing a mouse button', () => {
  it('binds the button that was pressed', () => {
    const { screen: built, map } = screen();
    built.beginCapture('world.order', 'primary');
    expect(built.capturePointer(1, NONE)).toBe(true);
    expect(map.bindingsFor('world.order').primary).toEqual({ code: 'MouseMiddle' });
    expect(built.capturing).toBe(null);
  });

  it('keeps a modifier held during the press', () => {
    const { screen: built, map } = screen();
    built.beginCapture('world.order', 'secondary');
    built.capturePointer(2, { ...NONE, shift: true, ctrl: true });
    expect(map.bindingsFor('world.order').secondary).toEqual({
      code: 'MouseRight',
      shift: true,
      ctrl: true,
    });
  });

  it('binds a wheel notch, in the direction it turned', () => {
    const { screen: built, map } = screen();
    built.beginCapture('camera.zoomIn', 'primary');
    built.captureWheel(-1, NONE);
    expect(map.bindingsFor('camera.zoomIn').primary).toEqual({ code: 'WheelDown' });
  });

  it('swallows a button it cannot name and stays open', () => {
    // The same thing a bare modifier does. Binding an invented `Mouse7` would be
    // a row the window has no way to read back to the player.
    const { screen: built, map } = screen();
    built.beginCapture('world.order', 'primary');
    expect(built.capturePointer(9, NONE)).toBe(true);
    expect(built.capturing).toEqual({ actionId: 'world.order', slot: 'primary' });
    expect(map.bindingsFor('world.order').primary).toEqual({ code: 'MouseRight' });
  });

  it('consumes a press only while a capture is armed', () => {
    // What keeps an ordinary click on an ordinary button working.
    const { screen: built } = screen();
    expect(built.capturePointer(0, NONE)).toBe(false);
    expect(built.captureWheel(1, NONE)).toBe(false);
  });

  it('reports a clash with a key exactly as it reports one with a button', () => {
    const { screen: built } = screen();
    built.beginCapture('combat.stop', 'primary');
    built.capturePointer(2, NONE);
    expect(built.conflict).toBe('RMB is also Move / attack');
  });

  it('lets Escape out of a capture a button opened', () => {
    const { screen: built, map, contexts } = screen();
    built.beginCapture('world.confirmAim', 'primary');
    built.captureKey('Escape', NONE);
    expect(built.capturing).toBe(null);
    expect(contexts.top).not.toBe('textEntry');
    expect(map.bindingsFor('world.confirmAim').primary).toEqual({ code: 'MouseLeft' });
  });

  /**
   * Every shipped label fits the box it is drawn in.
   *
   * A `Label` is drawn rather than typeset, so a string wider than its button is
   * clipped in silence -- which is how `Shift+Right Click` shipped as
   * `hift+Right Clic` in the first cut of spec 189, with every other test green.
   * A sum rather than a picture, because a golden only covers the tab it is of.
   */
  it('fits every shipped chord and every action name in its own column', () => {
    // `drawTextClipped` clips to the widget's own rect with no inset, so the
    // condition is exactly this comparison.
    //
    // At the gallery's viewport rather than this file's, and the difference is
    // the whole point of stating one: the harness above builds at 260x180, which
    // is under the theme's smallest supported frame, and `Move north` does not
    // fit its own column even today. 400x300 is where the goldens are judged.
    //
    // One screen per tab, and not for tidiness: a tab switched away is hidden
    // rather than destroyed, and a tab that has never been the active one when a
    // root arranged it has rows with no rect at all -- so a loop that selected
    // its way down the list would measure zeroes and pass.
    const map = new InputMap();
    const font = fontById('body');

    let checked = 0;
    for (const tab of new KeybindingsScreen({ theme: THEME, map }).tabs.tabIds) {
      const built = new KeybindingsScreen({ theme: THEME, map });
      built.tabs.select(tab);
      built.refresh();
      const root = new UiRoot(built, {
        theme: THEME,
        atlas: ATLAS,
        viewport: { width: 400, height: 300 },
      });
      root.update(0);
      for (const row of built.builtRows()) {
        if (row.action.category !== tab) continue;
        const binding = map.bindingsFor(row.action.id);
        for (const [button, chord] of [
          [row.primaryButton, binding.primary],
          [row.secondaryButton, binding.secondary],
        ] as const) {
          const text = chordLabel(chord);
          expect(measureText(font, text), `${row.action.id}: ${text}`).toBeLessThanOrEqual(
            button.rect.width,
          );
        }
        expect(measureText(font, row.action.label), row.action.id).toBeLessThanOrEqual(
          row.nameLabel.rect.width,
        );
        checked += 1;
      }
    }
    // Or the loop above measured nothing and said so in green.
    expect(checked).toBe(map.definitions.length);
  });

  it('says what it is waiting for without naming a keyboard', () => {
    const { screen: built } = screen();
    built.beginCapture('world.order', 'primary');
    built.refresh();
    const row = built.builtRows().find((candidate) => candidate.action.id === 'world.order');
    expect(row?.primaryButton.label).toBe('Press...');
  });
});
