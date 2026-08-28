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
import { DEFAULT_SHOW_FPS, SCALE_CHOICES, type ScaleChoice } from '../input/display-store.js';
import { THEME } from '../theme/theme.js';
import { Checkbox } from '../widgets/checkbox.js';

const ZOOM = { min: 200, max: 1400, supported: 420 };

function screen(): DisplayScreen {
  return new DisplayScreen({ theme: THEME, zoom: ZOOM });
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
    // The scale row only. The page has grown a second, unrelated checkbox since
    // spec 165, and the thing being asserted here is that the exclusive group
    // matches the store -- not how many checkboxes the page happens to have.
    const scaleBoxes = boxes(screen()).filter((box) => box.name.startsWith('scale:'));
    expect(scaleBoxes.map((box) => box.name)).toEqual(
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
    // The scale row only: the page carries an unrelated checkbox now, and what
    // is being asserted is that the exclusive group is exclusive.
    const display = screen();
    for (const choice of SCALE_CHOICES) {
      display.setChoice(choice);
      const scaleBoxes = boxes(display).filter((box) => box.name.startsWith('scale:'));
      expect(scaleBoxes.filter((box) => box.checked).length).toBe(1);
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

describe('the frame-rate switch (specs 165, 252)', () => {
  it('opens off, because nothing ships with a frame-time graph over the world', () => {
    // Spec 165 opened this on, so that a meter behind a checkbox two pages in
    // could be found at all. Spec 252 turns it off: the page a player opens is
    // not the page that argument was about, and the row is still right here.
    const display = screen();
    expect(display.frameRateShown).toBe(DEFAULT_SHOW_FPS);
    expect(display.frameRateShown).toBe(false);
    expect(fpsBox(display).checked).toBe(false);
  });

  it('emits the wish and decides nothing itself', () => {
    // The rule every screen since phase 4 follows, and the reason this page has
    // no state that can disagree with what is drawn: the tick does not move
    // until the mount calls back.
    const display = screen();
    const asked: boolean[] = [];
    display.onShowFpsChosen = (show) => asked.push(show);

    const box = fpsBox(display);
    box.setChecked(true);
    box.onToggle?.(true);
    expect(asked).toEqual([true]);
    // Neither the page's state nor its tick moved: the mount has not answered.
    expect(display.frameRateShown).toBe(false);
    expect(box.checked).toBe(false);

    display.setShowFps(true);
    expect(display.frameRateShown).toBe(true);
    expect(fpsBox(display).checked).toBe(true);
  });

  it('asks to turn back off once it is on', () => {
    const display = screen();
    const asked: boolean[] = [];
    display.onShowFpsChosen = (show) => asked.push(show);
    display.setShowFps(true);

    const box = fpsBox(display);
    box.setChecked(false);
    box.onToggle?.(false);
    expect(asked).toEqual([false]);
    expect(box.checked).toBe(true);
  });
});

function fpsBox(display: DisplayScreen): Checkbox {
  const box = boxes(display).find((candidate) => candidate.name === 'showFps');
  if (!box) throw new Error('no frame-rate checkbox');
  return box;
}

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

describe('the widest-zoom row (spec 202)', () => {
  /** Every label on the page, in the order it was built. */
  function labels(display: DisplayScreen): { text: string; visible: boolean }[] {
    const found: { text: string; visible: boolean }[] = [];
    const walk = (widget: { children: readonly unknown[] }): void => {
      for (const child of widget.children) {
        const w = child as { text?: string; visible: boolean; children: readonly unknown[] };
        if (typeof w.text === 'string') found.push({ text: w.text, visible: w.visible });
        walk(w);
      }
    };
    walk(display as unknown as { children: readonly unknown[] });
    return found;
  }

  const shown = (display: DisplayScreen): string[] =>
    labels(display)
      .filter((l) => l.visible && l.text !== '')
      .map((l) => l.text);

  it('opens on the supported cap and says nothing about dev settings', () => {
    const display = screen();
    expect(display.maxZoomChoice).toBe('supported');
    expect(shown(display)).toContain(`Widest zoom: ${String(ZOOM.supported)}`);
    expect(shown(display).some((t) => t.includes('Dev setting'))).toBe(false);
  });

  it('warns, and says what degrades, once past the supported view', () => {
    const display = screen();
    display.setMaxZoom(900);
    const text = shown(display).join(' ');
    expect(text).toContain('Widest zoom: 900');
    // The symptom by name. A warning that only says "unsupported" leaves the
    // holes looking like a bug.
    expect(text).toContain('Dev setting');
    expect(text).toContain('terrain and units may not load');
  });

  it('takes the warning away again on the way back into the band', () => {
    const display = screen();
    display.setMaxZoom(900);
    display.setMaxZoom('supported');
    expect(shown(display).some((t) => t.includes('Dev setting'))).toBe(false);
  });

  it('does not decide anything: the row moves only when the mount answers', () => {
    // The contract every screen since phase 4 holds, and the reason this page
    // has no state that can disagree with the frame being drawn.
    const display = screen();
    const asked: unknown[] = [];
    display.onMaxZoomChosen = (choice) => asked.push(choice);
    display.setMaxZoom(700);
    expect(display.maxZoomChoice).toBe(700);
    expect(asked).toEqual([]);
  });
});
