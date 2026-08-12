/**
 * The modal dialog (spec 130).
 *
 * Most of what makes it modal is not in `dialog.ts` at all -- the layer does it.
 * So the assertions split in two: the ones about the *layer* (a click beside it
 * reaches nothing) and the ones about the keyboard and the context stack, which
 * is the half a layer cannot know about.
 */

import { describe, expect, it } from 'vitest';
import { ContextStack, NO_MODIFIERS, type UiEvent } from '../core/events.js';
import type { FocusManager } from '../core/focus.js';
import { LayerStack } from '../core/layers.js';
import { UiRoot } from '../core/root.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import { Button } from './button.js';
import { Dialog } from './dialog.js';
import { Panel } from './panel.js';

interface Harness {
  readonly dialog: Dialog;
  readonly contexts: ContextStack;
  readonly focus: FocusManager;
  readonly layers: LayerStack;
  readonly root: UiRoot;
  readonly behind: Button;
  readonly answers: string[];
}

function harness(cancellable = true): Harness {
  const contexts = new ContextStack();
  const layers = new LayerStack();
  const answers: string[] = [];

  const behind = new Button('Behind', 'behind');
  const panel = new Panel('column', 'window');
  panel.add(behind);
  layers.place('windows', panel);

  const dialog = new Dialog({
    theme: THEME,
    title: 'Sell',
    message: 'Sell Worn Sword for 4 coins?',
    confirmLabel: 'Sell',
    cancellable,
  });
  dialog.onConfirm = () => answers.push('confirm');
  dialog.onCancel = () => answers.push('cancel');
  layers.place('modal', dialog);

  const root = new UiRoot(layers, {
    theme: THEME,
    atlas: bakeAtlas(THEME),
    viewport: { width: 400, height: 300 },
    layers,
  });
  root.update(0);
  // `root.focus`, not one of our own: keys are routed to whatever *the root's*
  // focus manager holds, so a dialog focused in a second manager is a dialog no
  // keystroke ever reaches. Cost four failing tests to find, twice now.
  return { dialog, contexts, focus: root.focus, layers, root, behind, answers };
}

const key = (code: string): UiEvent => ({
  kind: 'key',
  phase: 'down',
  code,
  mods: NO_MODIFIERS,
  time: 0,
});

describe('a dialog', () => {
  it('is invisible and inert until it is shown', () => {
    const test = harness();
    expect(test.dialog.visible).toBe(false);
    test.root.handle(key('Enter'));
    expect(test.answers).toEqual([]);
  });

  it('pushes the modal context while it is open, and pops it on the way out', () => {
    const test = harness();
    expect(test.contexts.has('modal')).toBe(false);
    test.dialog.show(test.contexts, test.focus);
    expect(test.contexts.has('modal')).toBe(true);
    expect(test.contexts.reachesGameplay('key')).toBe(false);

    test.dialog.hide(test.contexts, test.focus);
    expect(test.contexts.has('modal')).toBe(false);
    expect(test.contexts.reachesGameplay('key')).toBe(true);
  });

  it('pops the context when it closes by confirming, not only by cancelling', () => {
    const test = harness();
    test.dialog.onConfirm = () => test.dialog.hide(test.contexts, test.focus);
    test.dialog.show(test.contexts, test.focus);
    test.root.handle(key('Enter'));
    expect(test.contexts.has('modal')).toBe(false);
  });

  it('confirms on Enter and cancels on Escape', () => {
    const test = harness();
    test.dialog.show(test.contexts, test.focus);
    test.root.update(0);
    test.root.handle(key('Enter'));
    test.root.handle(key('Escape'));
    expect(test.answers).toEqual(['confirm', 'cancel']);
  });

  /**
   * The reason Escape has to reach the dialog first: dismissing the thing in
   * front of you must not also close the thing behind it. `UiRoot` gives Escape
   * to the window manager, so a dialog that did not swallow it would be one
   * keypress doing two things nobody asked for.
   */
  it('swallows the Escape it answered', () => {
    const test = harness();
    test.dialog.show(test.contexts, test.focus);
    test.root.update(0);
    expect(test.root.handle(key('Escape'))).toBe(true);
  });

  it('ignores Escape when it is not cancellable, and still closes on confirm', () => {
    const test = harness(false);
    test.dialog.show(test.contexts, test.focus);
    test.root.update(0);
    test.root.handle(key('Escape'));
    expect(test.answers).toEqual([]);
    expect(test.dialog.cancelButton.visible).toBe(false);

    test.root.handle(key('Enter'));
    expect(test.answers).toEqual(['confirm']);
  });

  it('takes the keyboard when it opens', () => {
    const test = harness();
    test.focus.focus(test.behind);
    test.dialog.show(test.contexts, test.focus);
    expect(test.focus.focused).toBe(test.dialog.confirmButton);
  });

  it('gives the keyboard back when it closes', () => {
    const test = harness();
    test.dialog.show(test.contexts, test.focus);
    test.dialog.hide(test.contexts, test.focus);
    expect(test.focus.focused).toBeNull();
  });

  /** The half the layer does, asserted through the layer. */
  it('stops a click reaching what is behind it', () => {
    const test = harness();
    test.root.update(0);
    const at = { x: test.behind.rect.x + 2, y: test.behind.rect.y + 2 };
    expect(test.layers.hitTest(at)).toBe(test.behind);

    test.dialog.show(test.contexts, test.focus);
    test.root.update(16);
    // Not the button any more: `blocksBelow` stops the walk at the modal layer,
    // and the dialog itself may or may not be over that point.
    expect(test.layers.hitTest(at)).not.toBe(test.behind);
  });

  it('changes the question without becoming a second dialog', () => {
    const test = harness();
    test.dialog.show(test.contexts, test.focus);
    test.dialog.ask('Sell', 'Sell Keen Longsword for 27 coins?');
    expect(test.dialog.question).toContain('27');
    // Still one push, so one pop closes it.
    test.dialog.hide(test.contexts, test.focus);
    expect(test.contexts.has('modal')).toBe(false);
  });

  it('is safe to close twice', () => {
    const test = harness();
    test.dialog.show(test.contexts, test.focus);
    test.dialog.hide(test.contexts, test.focus);
    test.dialog.hide(test.contexts, test.focus);
    expect(test.contexts.has('modal')).toBe(false);
    expect(test.contexts.depth()).toBe(1);
  });
});
