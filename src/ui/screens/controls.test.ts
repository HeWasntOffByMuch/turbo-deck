/**
 * The controls card (spec 255).
 *
 * The two claims that would be broken without a test and that nothing else
 * can see: that a row's content comes from the *live* `InputMap` rather than
 * a copy of the defaults, so a rebind changes what the card draws with no
 * second table to fall out of step -- and that an unbound featured action
 * drops its whole row rather than drawing a cap with nothing on it.
 *
 * Spec 256 adds a third: that dismissing the card and remembering it are two
 * separate reports rather than one -- closing it must not imply "seen", and
 * "seen" must never be assumed by anything but the checkbox itself.
 */

import { describe, expect, it } from 'vitest';
import { Anchor } from '../core/containers.js';
import { LayerStack } from '../core/layers.js';
import { UiRoot } from '../core/root.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import { InputMap } from '../input/input-map.js';
import { CARD_WIDTH, ControlsScreen, controlHints, type ControlGlyph } from './controls.js';

const VIEWPORT = { width: 300, height: 300 };
const ATLAS = bakeAtlas(THEME);

/**
 * Docked the way a real mount would (`chat.test.ts`'s shape): the top-level
 * content of a `UiRoot` is always arranged to fill the whole viewport, so a
 * screen with a fixed width has to sit inside something that respects its own
 * measured size -- an `Anchor` does, and a bare `Stack` would not.
 */
function harness(): { screen: ControlsScreen; root: UiRoot } {
  const screen = new ControlsScreen({ theme: THEME });
  const layers = new LayerStack();
  const dock = new Anchor('controls:dock');
  dock.pointerTransparent = true;
  dock.place(screen, 'topRight');
  layers.place('hud', dock);
  const root = new UiRoot(layers, { theme: THEME, atlas: ATLAS, viewport: VIEWPORT, layers });
  root.update(0);
  return { screen, root };
}

/** A key glyph's label, or a description of what it actually was -- for a clear failure. */
function keyLabelOf(glyph: ControlGlyph | undefined): string {
  if (!glyph) return '<missing>';
  return glyph.kind === 'key' ? glyph.label : `<pointer:${glyph.sprite}>`;
}

describe('the close button', () => {
  it('is square, not a wide rectangle with the X off to one side', () => {
    // The reported bug (spec 256): `Button.measureSelf` adds `ICON_ADVANCE`
    // for a label that is not there, so a close button with none came out a
    // wide rectangle with the X adrift near its left edge. Asserted off the
    // arranged rect rather than off the class, because what went wrong was
    // the measurement, not the widget's identity.
    const { screen } = harness();
    const box = screen.closeButton.rect;
    expect(box.width).toBeGreaterThan(0);
    expect(box.width).toBe(box.height);
  });
});

describe('the card itself', () => {
  it('closes with a square button', () => {
    // The reported bug (spec 256): `Button.measureSelf` adds `ICON_ADVANCE` for
    // a label that is not there, so the close button came out a wide rectangle
    // with the X adrift near its left edge. Asserted off the *arranged rect*
    // rather than off the class, because what went wrong was the measurement.
    const { screen } = harness();
    const box = screen.closeButton.rect;
    expect(box.width).toBeGreaterThan(0);
    expect(box.width).toBe(box.height);
  });

  it('says what it will stop showing, and has the room to', () => {
    // The word that carries the meaning is AGAIN, and it was once dropped to
    // save one pixel -- so this pins the *text*, not just that something fits.
    // A card narrowed back to 140 clips it, which is how it went missing.
    const { screen } = harness();
    expect(screen.rememberCheckbox.label).toBe("DON'T SHOW AGAIN");
    const box = screen.rememberCheckbox.rect;
    expect(box.width).toBeGreaterThan(0);
    expect(box.width).toBeLessThanOrEqual(CARD_WIDTH);
  });
});

describe('controlHints', () => {
  it('derives every featured row from the shipped defaults, in order', () => {
    const hints = controlHints(new InputMap());
    expect(hints.map((hint) => hint.label)).toEqual([
      'Move',
      'Move / attack',
      'Select / aim',
      'Skills',
      'Stop',
      'Bag',
      'Character',
      'Zoom',
    ]);

    // Move: north, west, south, east -- WASD, in that order.
    expect(hints[0]?.glyphs.map(keyLabelOf)).toEqual(['W', 'A', 'S', 'D']);
    // Skills: the first four skillbar digits.
    expect(hints[3]?.glyphs.map(keyLabelOf)).toEqual(['1', '2', '3', '4']);
  });

  it('draws a keyboard binding as a keycap, and a pointer binding as its picture', () => {
    const hints = controlHints(new InputMap());
    const bag = hints.find((hint) => hint.label === 'Bag');
    expect(bag?.glyphs).toEqual([{ kind: 'key', label: 'I' }]);

    const moveAttack = hints.find((hint) => hint.label === 'Move / attack');
    expect(moveAttack?.glyphs).toEqual([{ kind: 'pointer', sprite: 'mouseRight' }]);

    const selectAim = hints.find((hint) => hint.label === 'Select / aim');
    expect(selectAim?.glyphs).toEqual([{ kind: 'pointer', sprite: 'mouseLeft' }]);

    const zoom = hints.find((hint) => hint.label === 'Zoom');
    expect(zoom?.glyphs).toEqual([{ kind: 'pointer', sprite: 'mouseWheel' }]);
  });

  it('changes a keycap label when the action is rebound', () => {
    const map = new InputMap();
    map.bind('ui.character', 'primary', { code: 'KeyX' });
    const hints = controlHints(map);
    const character = hints.find((hint) => hint.label === 'Character');
    expect(character?.glyphs).toEqual([{ kind: 'key', label: 'X' }]);
  });

  it('draws a pointer picture for a control rebound onto a pointer button', () => {
    const map = new InputMap();
    map.bind('ui.character', 'primary', { code: 'MouseLeft' });
    const hints = controlHints(map);
    const character = hints.find((hint) => hint.label === 'Character');
    expect(character?.glyphs).toEqual([{ kind: 'pointer', sprite: 'mouseLeft' }]);
  });

  it('falls back to a keycap for a pointer button with no picture of its own', () => {
    // Mouse4/Mouse5/the middle button are pointer codes, but this game has
    // drawn no picture for any of them -- so they read as text, like any
    // other key, rather than pointing the atlas at a sprite it never baked.
    const map = new InputMap();
    map.bind('ui.character', 'primary', { code: 'MouseMiddle' });
    const hints = controlHints(map);
    const character = hints.find((hint) => hint.label === 'Character');
    expect(character?.glyphs[0]?.kind).toBe('key');
  });

  it('drops a single-action row entirely when its action has no binding', () => {
    const map = new InputMap();
    map.bind('combat.stop', 'primary', null);
    const hints = controlHints(map);
    expect(hints.some((hint) => hint.label === 'Stop')).toBe(false);
    expect(hints).toHaveLength(7);
  });

  it('drops a whole multi-action row when only one of its caps is unbound', () => {
    // A row missing one of its four caps would be a row lying about what it
    // takes to use the skillbar -- so the rule is all four or none.
    const map = new InputMap();
    map.bind('skillbar.3', 'primary', null);
    const hints = controlHints(map);
    expect(hints.some((hint) => hint.label === 'Skills')).toBe(false);
    expect(hints).toHaveLength(7);

    // ...and the Move row, sharing nothing with skillbar.3, is untouched.
    expect(hints.some((hint) => hint.label === 'Move')).toBe(true);
  });

  it('drops nothing when every featured action keeps its default binding', () => {
    expect(controlHints(new InputMap())).toHaveLength(8);
  });
});

describe('the controls card', () => {
  it('reports a dismiss rather than acting on it, and does not imply remembering', () => {
    // The whole rule every screen here follows: what closing this card means
    // -- discarding it for the session -- is not this file's to decide.
    const { screen } = harness();
    let dismissed = 0;
    let remembered: boolean | undefined;
    screen.onDismiss = () => {
      dismissed++;
    };
    screen.onRemember = (value) => {
      remembered = value;
    };
    screen.closeButton.press(0);
    expect(dismissed).toBe(1);
    // Nothing about the screen's own state moved: it does not hide itself,
    // it only says so.
    expect(screen.visible).toBe(true);
    // Spec 256: the X used to also mean "seen". It no longer touches
    // `onRemember` at all -- that is the checkbox's alone.
    expect(remembered).toBeUndefined();
  });

  it('reports the "don\'t show again" checkbox rather than acting on it', () => {
    const { screen } = harness();
    let remembered: boolean | undefined;
    screen.onRemember = (value) => {
      remembered = value;
    };
    expect(screen.rememberCheckbox.checked).toBe(false);

    screen.rememberCheckbox.toggle();
    // The value is reported...
    expect(remembered).toBe(true);
    // ...and the widget owns its own checked state, the same way a bag cell
    // does: there is no server or mount that could refuse this, so nothing
    // here puts it back the way `DisplayScreen`'s exclusive rows do.
    expect(screen.rememberCheckbox.checked).toBe(true);
    // The screen itself does nothing else with it -- not hide, not dismiss.
    expect(screen.visible).toBe(true);

    screen.rememberCheckbox.toggle();
    expect(remembered).toBe(false);
  });

  it('setRemember seeds the checkbox without notifying', () => {
    const { screen } = harness();
    let calls = 0;
    screen.onRemember = () => {
      calls++;
    };
    screen.setRemember(true);
    expect(screen.rememberCheckbox.checked).toBe(true);
    expect(calls).toBe(0);

    screen.setRemember(false);
    expect(screen.rememberCheckbox.checked).toBe(false);
    expect(calls).toBe(0);
  });

  it('is a fixed width, whatever it is offered and whatever it holds', () => {
    const { screen, root } = harness();
    screen.setView({ hints: controlHints(new InputMap()) });
    root.update(0);
    expect(screen.rect.width).toBe(CARD_WIDTH);

    screen.setView({ hints: [] });
    root.update(0);
    expect(screen.rect.width).toBe(CARD_WIDTH);
  });

  it('shows one row per hint and hides the rest, rather than rebuilding the pool', () => {
    const { screen, root } = harness();
    screen.setView({ hints: controlHints(new InputMap()) });
    root.update(0);
    const full = screen.rect.height;

    const map = new InputMap();
    map.bind('combat.stop', 'primary', null);
    map.bind('skillbar.1', 'primary', null);
    screen.setView({ hints: controlHints(map) });
    root.update(0);
    // Two rows fewer, so the card is shorter -- the gap left by a dropped row
    // is not drawn as an empty one.
    expect(screen.rect.height).toBeLessThan(full);
  });

  it('draws something once it is given hints, and nothing extra when it is given none', () => {
    const { screen, root } = harness();
    screen.setView({ hints: [] });
    root.update(0);
    const empty = root.paint().finish().length;

    screen.setView({ hints: controlHints(new InputMap()) });
    root.update(0);
    expect(root.paint().finish().length).toBeGreaterThan(empty);
  });
});
