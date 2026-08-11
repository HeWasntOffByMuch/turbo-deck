/**
 * The Display page and the options window that carries it (spec 136).
 *
 * The assertion that matters is the one every screen since phase 4 gets: the
 * page does not decide anything. A click emits, and the tick only moves when
 * `setChoice` is called back -- so a preference the mount refused cannot leave
 * the interface showing a scale it is not drawing at.
 */

import { describe, expect, it } from 'vitest';
import { DisplayScreen } from './display.js';
import { OptionsScreen } from './options.js';
import { Column } from '../core/containers.js';
import { SCALE_CHOICES, type ScaleChoice } from '../input/display-store.js';
import { THEME } from '../theme/theme.js';
import { Checkbox } from '../widgets/checkbox.js';

function screen(): DisplayScreen {
  return new DisplayScreen({ theme: THEME });
}

/** Every checkbox on the page, in the order it was built. */
function boxes(display: DisplayScreen): Checkbox[] {
  const found: Checkbox[] = [];
  const walk = (widget: { children: readonly unknown[] }): void => {
    for (const child of widget.children) {
      if (child instanceof Checkbox) found.push(child);
      else walk(child as { children: readonly unknown[] });
    }
  };
  walk(display);
  return found;
}

function boxFor(display: DisplayScreen, choice: ScaleChoice): Checkbox {
  const box = boxes(display).find((candidate) => candidate.name === `scale:${String(choice)}`);
  if (!box) throw new Error(`no box for ${String(choice)}`);
  return box;
}

describe('the display page', () => {
  it('offers every choice the store knows about', () => {
    expect(boxes(screen()).map((box) => box.name)).toEqual(
      SCALE_CHOICES.map((choice) => `scale:${String(choice)}`),
    );
  });

  it('opens on auto', () => {
    const display = screen();
    expect(display.selected).toBe('auto');
    expect(boxFor(display, 'auto').checked).toBe(true);
    expect(boxFor(display, 2).checked).toBe(false);
  });

  it('emits the choice and does not take it', () => {
    // The rule. Clicking 3x asks for 3x; until somebody answers, the page still
    // says auto, because auto is still what the interface is drawing at.
    const display = screen();
    const asked: ScaleChoice[] = [];
    display.onScaleChosen = (choice) => asked.push(choice);

    boxFor(display, 3).toggle();
    expect(asked).toEqual([3]);
    expect(display.selected).toBe('auto');

    display.setChoice(3);
    expect(display.selected).toBe(3);
    expect(boxFor(display, 3).checked).toBe(true);
    expect(boxFor(display, 'auto').checked).toBe(false);
  });

  it('ticks exactly one box, whatever is chosen', () => {
    const display = screen();
    for (const choice of SCALE_CHOICES) {
      display.setChoice(choice);
      expect(boxes(display).filter((box) => box.checked).length).toBe(1);
    }
  });

  it('never leaves the player with no scale at all', () => {
    // A checkbox toggles off on a second click, and "off" is not an answer
    // here: one of these is always the scale.
    const display = screen();
    const asked: ScaleChoice[] = [];
    display.onScaleChosen = (choice) => asked.push(choice);
    display.setChoice(2);

    boxFor(display, 2).toggle();
    expect(boxFor(display, 2).checked).toBe(true);
    expect(asked).toEqual([2]);
  });

  it('says what auto actually worked out to', () => {
    const display = screen();
    display.setEffectiveScale(3);
    const labels = labelTexts(display);
    expect(labels).toContain('Drawing at 3x');
    display.setEffectiveScale(1);
    expect(labelTexts(display)).toContain('Drawing at 1x');
  });
});

describe('the options window', () => {
  it('carries both pages, keys first', () => {
    const options = new OptionsScreen({
      theme: THEME,
      keys: new Column('keys'),
      display: screen(),
    });
    expect(options.tabs.tabIds).toEqual(['keys', 'display']);
  });
});

/** Every label's text, without importing the widget's private shape. */
function labelTexts(display: DisplayScreen): string[] {
  const found: string[] = [];
  const walk = (widget: { children: readonly unknown[] }): void => {
    for (const child of widget.children) {
      const candidate = child as { text?: unknown; children?: readonly unknown[] };
      if (typeof candidate.text === 'string') found.push(candidate.text);
      if (candidate.children) walk(candidate as { children: readonly unknown[] });
    }
  };
  walk(display);
  return found;
}
