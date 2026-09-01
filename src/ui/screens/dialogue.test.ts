import { describe, expect, it } from 'vitest';

import { bakeAtlas } from '../render/atlas.js';
import type { LayoutContext } from '../core/widget.js';
import { THEME } from '../theme/theme.js';
import { BUBBLE_LIFT, BUBBLE_WIDTH, DialogueDock, DialogueScreen } from './dialogue.js';

/**
 * Spec 246. The dialogue bubble.
 *
 * What is asserted here is the half a golden image cannot state: that nothing is
 * drawn when nobody is speaking, that the box stays put while the text grows,
 * that a click on it does not fall through to the world, and that it stays on
 * screen when the speaker is at the edge of it.
 */

const VIEWPORT = { width: 800, height: 600 };
const CONTEXT: LayoutContext = { theme: THEME, atlas: bakeAtlas(THEME) };

function screen(): DialogueScreen {
  return new DialogueScreen({ theme: THEME });
}

/**
 * Lay the bubble out inside a dock, the way the mount does.
 *
 * A fresh dock each time on purpose: `DialogueDock` holds no state of its own,
 * so re-docking is free, and building one per call keeps each assertion about a
 * tree that was laid out exactly once.
 */
function laid(bubble: DialogueScreen, viewport = VIEWPORT): DialogueDock {
  const dock = new DialogueDock(bubble);
  relayout(dock, viewport);
  return dock;
}

function relayout(dock: DialogueDock, viewport = VIEWPORT): void {
  dock.measure({ maxWidth: viewport.width, maxHeight: viewport.height }, CONTEXT);
  dock.arrange({ x: 0, y: 0, width: viewport.width, height: viewport.height }, CONTEXT);
}

describe('visibility', () => {
  it('draws nothing before anybody speaks', () => {
    // The trap `chat.ts` names and `selected-unit.ts` repeats: an empty view is
    // exactly what the screen already looks like, so a visibility settled after
    // a has-anything-changed check is a decision never taken.
    const bubble = screen();
    expect(bubble.visible).toBe(false);
  });

  it('draws nothing when the conversation ends', () => {
    const bubble = screen();
    bubble.setView({ speaker: 'Rell', text: 'Hello', typing: false, choices: [] });
    expect(bubble.visible).toBe(true);
    bubble.setView(null);
    expect(bubble.visible).toBe(false);
  });

  it('draws nothing for a speaker with no name', () => {
    const bubble = screen();
    bubble.setView({ speaker: '', text: 'Hello', typing: false, choices: [] });
    expect(bubble.visible).toBe(false);
  });
});

describe('content', () => {
  it('shows the speaker and exactly what has been revealed', () => {
    const bubble = screen();
    bubble.setView({ speaker: 'Rell', text: 'Look', typing: true, choices: [] });
    laid(bubble);
    const text = drawnText(bubble);
    expect(text).toContain('Rell:');
    expect(text).toContain('Look');
  });

  it('shows a reply per choice', () => {
    const bubble = screen();
    bubble.setView({
      speaker: 'Rell',
      text: 'Looking for something?',
      typing: false,
      choices: ['Show me.', 'Who are you?', 'Never mind.'],
    });
    laid(bubble);
    const text = drawnText(bubble);
    for (const choice of ['Show me.', 'Who are you?', 'Never mind.']) {
      expect(text).toContain(choice);
    }
  });

  it('keeps its reply widgets while the text grows under them', () => {
    // A screen that tore down its buttons every frame would lose the hover state
    // on the one under the cursor between the press and the release.
    const bubble = screen();
    const view = { speaker: 'Rell', text: '', typing: false, choices: ['A', 'B'] };
    bubble.setView(view);
    laid(bubble);
    const before = buttons(bubble);
    bubble.setView({ ...view, text: 'Something longer now' });
    laid(bubble);
    expect(buttons(bubble)).toEqual(before);
  });

  it('rebuilds them when the replies change', () => {
    const bubble = screen();
    bubble.setView({ speaker: 'Rell', text: 'x', typing: false, choices: ['A'] });
    laid(bubble);
    const before = buttons(bubble);
    bubble.setView({ speaker: 'Rell', text: 'x', typing: false, choices: ['A', 'B'] });
    laid(bubble);
    expect(buttons(bubble)).not.toEqual(before);
    expect(buttons(bubble)).toHaveLength(2);
  });
});

describe('placement', () => {
  it('is the same width however long the line is', () => {
    // Anchored to a moving body, a width that followed the content would slide
    // both edges every time a character was revealed.
    const bubble = screen();
    bubble.setAnchor({ x: 400, y: 300 });
    bubble.setView({ speaker: 'Rell', text: 'Hi', typing: false, choices: [] });
    laid(bubble);
    const narrow = bubble.rect.width;
    bubble.setView({
      speaker: 'Rell',
      text: 'A much longer line that would wrap several times over if it were allowed to',
      typing: false,
      choices: [],
    });
    laid(bubble);
    expect(bubble.rect.width).toBe(narrow);
    expect(bubble.rect.width).toBe(BUBBLE_WIDTH);
    // And it grew downward, which is what a fixed width buys.
    expect(bubble.rect.height).toBeGreaterThan(0);
  });

  it('sits above the anchor and centred on it', () => {
    const bubble = screen();
    bubble.setAnchor({ x: 400, y: 300 });
    bubble.setView({ speaker: 'Rell', text: 'Hello there', typing: false, choices: [] });
    laid(bubble);
    expect(Math.abs(bubble.rect.x + bubble.rect.width / 2 - 400)).toBeLessThanOrEqual(1);
    expect(bubble.rect.y + bubble.rect.height).toBeLessThanOrEqual(300 - BUBBLE_LIFT + 1);
  });

  it('stays on screen when the speaker is at the edge', () => {
    // Walking up to somebody puts them in the middle of the screen only by
    // luck, and half a conversation off the frame is half a conversation.
    const bubble = screen();
    bubble.setView({ speaker: 'Rell', text: 'Hello there', typing: false, choices: ['Yes'] });
    for (const at of [
      { x: 0, y: 0 },
      { x: VIEWPORT.width, y: 0 },
      { x: 0, y: VIEWPORT.height },
      { x: VIEWPORT.width, y: VIEWPORT.height },
    ]) {
      bubble.setAnchor(at);
      laid(bubble);
      expect(bubble.rect.x, `x at ${at.x},${at.y}`).toBeGreaterThanOrEqual(0);
      expect(bubble.rect.y, `y at ${at.x},${at.y}`).toBeGreaterThanOrEqual(0);
      expect(bubble.rect.x + bubble.rect.width).toBeLessThanOrEqual(VIEWPORT.width);
      expect(bubble.rect.y + bubble.rect.height).toBeLessThanOrEqual(VIEWPORT.height);
    }
  });

  it('follows a moving anchor without the text having to change', () => {
    // The bug this is written for: `UiRoot.update` lays out nothing that is not
    // dirty, so an anchor set without invalidating leaves the bubble where it
    // was first placed -- which looks right while a line is typing, because the
    // text is invalidating on its own, and freezes the moment it finishes.
    const bubble = screen();
    bubble.setView({ speaker: 'Rell', text: 'Hello', typing: false, choices: [] });
    bubble.setAnchor({ x: 200, y: 300 });
    const dock = laid(bubble);
    const first = bubble.rect.x;

    // Re-laid the way the root does it: only if something asked to be.
    bubble.setAnchor({ x: 500, y: 300 });
    expect(dock.needsArrange || dock.needsArrangeInSubtree).toBe(true);
    relayout(dock);
    expect(bubble.rect.x).not.toBe(first);
    expect(Math.abs(bubble.rect.x + bubble.rect.width / 2 - 500)).toBeLessThanOrEqual(1);
  });

  it('places itself somewhere sensible with no anchor at all', () => {
    const bubble = screen();
    bubble.setView({ speaker: 'Rell', text: 'Hello', typing: false, choices: [] });
    laid(bubble);
    expect(bubble.rect.x).toBeGreaterThanOrEqual(0);
    expect(bubble.rect.y).toBeGreaterThanOrEqual(0);
  });

  it('does not fall off a viewport narrower than it is', () => {
    const bubble = screen();
    bubble.setAnchor({ x: 10, y: 40 });
    bubble.setView({ speaker: 'Rell', text: 'Hello', typing: false, choices: [] });
    laid(bubble, { width: 120, height: 90 });
    expect(bubble.rect.x).toBeGreaterThanOrEqual(0);
    expect(bubble.rect.y).toBeGreaterThanOrEqual(0);
  });
});

describe('the pointer', () => {
  it('takes a click on the bubble rather than letting it reach the world', () => {
    // This is the one place that inverts `selected-unit.ts`'s rule: a readout is
    // something you look *through*, and a bubble with replies in it is something
    // you press.
    const bubble = screen();
    bubble.setAnchor({ x: 400, y: 300 });
    bubble.setView({ speaker: 'Rell', text: 'Hello', typing: false, choices: [] });
    laid(bubble);
    const middle = { x: bubble.rect.x + bubble.rect.width / 2, y: bubble.rect.y + 4 };
    expect(bubble.hitTest(middle)).not.toBeNull();
  });

  it('lets a click beside the bubble through', () => {
    const bubble = screen();
    bubble.setAnchor({ x: 400, y: 300 });
    bubble.setView({ speaker: 'Rell', text: 'Hello', typing: false, choices: [] });
    const dock = laid(bubble);
    // The dock fills the frame and must not swallow the three-quarters of it the
    // bubble does not cover.
    expect(dock.hitTest({ x: 20, y: VIEWPORT.height - 20 })).toBeNull();
  });

  it('reports a click on the body of the bubble as an advance', () => {
    const bubble = screen();
    let advances = 0;
    bubble.onAdvance = (): void => {
      advances += 1;
    };
    bubble.setAnchor({ x: 400, y: 300 });
    bubble.setView({ speaker: 'Rell', text: 'Hello', typing: true, choices: [] });
    laid(bubble);
    bubble.onGesture({
      kind: 'click',
      pos: { x: bubble.rect.x + 4, y: bubble.rect.y + 4 },
      delta: { x: 0, y: 0 },
      button: 0,
      mods: { shift: false, ctrl: false, alt: false, meta: false },
      time: 0,
    });
    expect(advances).toBe(1);
  });

  it('publishes its own box, which is what a line with no replies is pressed by (spec 259)', () => {
    // The reply rects answer "where do I press to choose"; this answers "where
    // do I press to go on", which for a sign is the only press there is.
    const bubble = screen();
    expect(bubble.bubbleRect).toBeNull();
    bubble.setAnchor({ x: 400, y: 300 });
    bubble.setView({ speaker: 'Sign', text: 'Beware the bridge.', typing: false, choices: [] });
    laid(bubble);
    const box = bubble.bubbleRect;
    expect(box).not.toBeNull();
    // The box a press has to land in, so it has to be the one the hit test
    // takes -- a published rectangle that is not the pressable one would be a
    // harness aiming at the world.
    expect(bubble.hitTest({ x: (box?.x ?? 0) + 4, y: (box?.y ?? 0) + 4 })).not.toBeNull();
    // And it goes away with the bubble, since a box for something not on screen
    // is a press into empty space.
    bubble.setView(null);
    expect(bubble.bubbleRect).toBeNull();
  });

  it('clamps an anchor that has run off the top rather than dropping it', () => {
    // What the mount's `bubbleAnchor` relies on (spec 259's follow-up): the
    // lift is in world units, so a zoomed-in camera can put the point above the
    // frame while the speaker is squarely in the middle of it. Clamping is the
    // right answer there and was already what this does; what was wrong was one
    // level up, where such an anchor was being replaced by null.
    const bubble = screen();
    bubble.setAnchor({ x: 400, y: -600 });
    bubble.setView({ speaker: 'Sign', text: 'Beware the bridge.', typing: false, choices: [] });
    laid(bubble);
    const at = bubble.placement(VIEWPORT);
    expect(at.y).toBeGreaterThanOrEqual(0);
    expect(at.y).toBeLessThan(VIEWPORT.height / 2);
    // And it is *not* the no-anchor placement, which is centred and low -- the
    // two being told apart is the whole of the bug this guards.
    const adrift = screen();
    adrift.setView({ speaker: 'Sign', text: 'Beware the bridge.', typing: false, choices: [] });
    laid(adrift);
    expect(adrift.placement(VIEWPORT).y).toBeGreaterThan(VIEWPORT.height / 2);
  });

  it('reports a reply by its index', () => {
    const bubble = screen();
    const pressed: number[] = [];
    bubble.onChoice = (index): void => {
      pressed.push(index);
    };
    bubble.setView({ speaker: 'Rell', text: 'x', typing: false, choices: ['A', 'B', 'C'] });
    laid(bubble);
    for (const button of buttonWidgets(bubble)) button.onPress?.(0);
    expect(pressed).toEqual([0, 1, 2]);
  });
});

/**
 * Every string the tree would draw, in order.
 *
 * Both accessors, because the two widgets that carry text call it different
 * things: a `Label` has `text` and a `Button` has `label`.
 */
function drawnText(root: { children: readonly unknown[] }): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    const widget = node as {
      text?: string;
      label?: string;
      children?: readonly unknown[];
      visible?: boolean;
    };
    if (widget.visible === false) return;
    for (const value of [widget.text, widget.label]) {
      if (typeof value === 'string' && value !== '') out.push(value);
    }
    for (const child of widget.children ?? []) walk(child);
  };
  for (const child of root.children) walk(child);
  return out;
}

/** The reply widgets' names, as an identity check across a re-layout. */
function buttons(root: { children: readonly unknown[] }): string[] {
  return buttonWidgets(root).map((button) => button.name);
}

function buttonWidgets(root: { children: readonly unknown[] }): { name: string; onPress: ((now: number) => void) | null }[] {
  const out: { name: string; onPress: ((now: number) => void) | null }[] = [];
  const walk = (node: unknown): void => {
    const widget = node as {
      name?: string;
      onPress?: ((now: number) => void) | null;
      children?: readonly unknown[];
    };
    if (typeof widget.name === 'string' && widget.name.startsWith('dialogue:choice:')) {
      out.push({ name: widget.name, onPress: widget.onPress ?? null });
    }
    for (const child of widget.children ?? []) walk(child);
  };
  for (const child of root.children) walk(child);
  return out;
}
