/**
 * Sound (spec 133).
 *
 * There is nothing to hear here and that is the design: `src/ui/` emits an *id*
 * into a sink it was handed, and never learns what a sound is. What these check
 * is the vocabulary, the default, and the rule about *when* a sound is emitted.
 */

import { describe, expect, it } from 'vitest';
import { RecordingSink, SILENT, UI_SOUNDS } from './sound.js';
import { Button } from '../widgets/button.js';
import { THEME } from '../theme/theme.js';
import { bakeAtlas } from '../render/atlas.js';

const ATLAS = bakeAtlas(THEME);
const NO_MODS = { shift: false, ctrl: false, alt: false, meta: false };

/** A real click, through the gesture the router would deliver. */
function press(button: Button): void {
  button.onGesture({
    kind: 'click',
    pos: { x: 0, y: 0 },
    delta: { x: 0, y: 0 },
    button: 0,
    mods: NO_MODS,
    time: 0,
  });
}

describe('the vocabulary', () => {
  it('is closed and small', () => {
    // Seven is a lot for an interface; an eighth should have to argue for itself.
    expect(UI_SOUNDS).toHaveLength(7);
    expect(new Set(UI_SOUNDS).size).toBe(UI_SOUNDS.length);
    for (const id of UI_SOUNDS) expect(id.startsWith('ui.')).toBe(true);
  });
});

describe('the silent sink', () => {
  /**
   * So a widget can always emit without asking whether anybody is listening.
   * The alternative -- an optional sink and a `?.` at every call site -- is one
   * chance per site to forget, and the one that gets forgotten is the error.
   */
  it('accepts every id and does nothing', () => {
    for (const id of UI_SOUNDS) expect(() => SILENT.play(id)).not.toThrow();
  });
});

describe('the recording sink', () => {
  it('remembers in order, so a test can assert what an interaction asked for', () => {
    const sink = new RecordingSink();
    sink.play('ui.open');
    sink.play('ui.press');
    expect(sink.played).toEqual(['ui.open', 'ui.press']);
    sink.clear();
    expect(sink.played).toEqual([]);
  });
});

describe('where a sound comes from', () => {
  /**
   * At the intent, not the outcome.
   *
   * A press makes its noise when it is pressed, not when whatever it asked for
   * comes back: a button that stayed silent until a round trip later is a button
   * that felt broken. The refusal has its own sound, and it arrives when the
   * refusal does.
   */
  it('is the press itself, not what the press achieved', () => {
    const sink = new RecordingSink();
    const button = new Button('Buy');
    button.sounds = sink;
    button.rect = { x: 0, y: 0, width: 40, height: 12 };
    // No `onPress` handler at all: nothing downstream, nothing agreed, and the
    // sound still happens because the player pressed a button.
    press(button);
    expect(sink.played).toEqual(['ui.press']);
  });

  it('says nothing for a button that refused the press', () => {
    const sink = new RecordingSink();
    const button = new Button('Buy');
    button.sounds = sink;
    button.enabled = false;
    button.rect = { x: 0, y: 0, width: 40, height: 12 };
    press(button);
    // A greyed-out button that clicked would be a button claiming to have done
    // something. The refusal is silent here because nothing was refused -- there
    // was nothing to refuse.
    expect(sink.played).toEqual([]);
  });

  it('defaults to silence, so a widget nobody wired up still works', () => {
    const button = new Button('Buy');
    button.rect = { x: 0, y: 0, width: 40, height: 12 };
    expect(() => press(button)).not.toThrow();
    expect(ATLAS.width).toBeGreaterThan(0);
  });
});
