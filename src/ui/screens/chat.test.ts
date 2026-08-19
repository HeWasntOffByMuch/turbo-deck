/**
 * The chat screen (spec 189).
 *
 * The assertions that matter here are the two the feature would be broken
 * without and that nothing else can see: that the field pushes `textEntry` --
 * the context that stops a typed `1` casting an ability -- and that it pops it
 * again, because a stranded push swallows every key in the game from then on.
 */

import { describe, expect, it } from 'vitest';
import { Anchor } from '../core/containers.js';
import { LayerStack } from '../core/layers.js';
import { UiRoot } from '../core/root.js';
import { FULL_MOTION, REDUCED_MOTION } from '../core/motion.js';
import { colorKey } from '../core/color.js';
import type { Widget } from '../core/widget.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import { CHANNEL_TOKENS, ChatScreen, LOG_WIDTH, MAX_CHARS, SPEAKER_TOKEN, type ChatLineView } from './chat.js';

const VIEWPORT = { width: 640, height: 400 };

interface Harness {
  readonly chat: ChatScreen;
  readonly root: UiRoot;
  readonly focus: {
    focus(widget: Widget | null): boolean;
    push(id: 'textEntry'): void;
    pop(id: 'textEntry'): void;
  };
  frame(now?: number): void;
  tints(): readonly string[];
}

function harness(): Harness {
  const layers = new LayerStack();
  const chat = new ChatScreen({ theme: THEME });
  // Docked the way the mount docks it: an `Anchor` filling the viewport with the
  // log pinned to its bottom-left corner. Placed straight into the layer instead,
  // a `Stack` arranges its children to *fill*, so the log would be measured at
  // 320 and then arranged at the width of the whole frame -- which is the one
  // thing about its shape worth asserting.
  const dock = new Anchor('chat:dock');
  dock.pointerTransparent = true;
  dock.place(chat, 'bottomLeft');
  layers.place('hud', dock);
  const root = new UiRoot(layers, {
    theme: THEME,
    atlas: bakeAtlas(THEME),
    viewport: VIEWPORT,
    layers,
  });
  const focus = {
    focus: (widget: Widget | null): boolean => root.focus.focus(widget),
    push: (id: 'textEntry'): void => {
      root.pushContext(id);
    },
    pop: (id: 'textEntry'): void => {
      root.popContext(id);
    },
  };
  return {
    chat,
    root,
    focus,
    frame(now = 0) {
      root.update(now);
    },
    tints() {
      const seen = new Set<string>();
      for (const command of root.paint().finish()) {
        if (command.kind === 'sprite') seen.add(colorKey(command.tint));
      }
      return [...seen];
    },
  };
}

function line(overrides: Partial<ChatLineView> = {}): ChatLineView {
  return { id: 1, channel: 0, from: 'Ada', text: 'watch the ravager', ...overrides };
}

describe('the chat screen', () => {
  it('draws a say in two colours: the speaker, and what they said', () => {
    const bag = harness();
    bag.chat.setView({ lines: [line()], reveal: 1 });
    bag.frame();

    const tints = bag.tints();
    expect(tints).toContain(colorKey(THEME.color(SPEAKER_TOKEN)));
    expect(tints).toContain(colorKey(THEME.color(CHANNEL_TOKENS[0])));
  });

  it('draws a system line in one colour, with nobody speaking', () => {
    const bag = harness();
    bag.chat.setView({ lines: [line({ channel: 1, from: '', text: 'Grazer was slain' })], reveal: 1 });
    bag.frame();

    const tints = bag.tints();
    expect(tints).toContain(colorKey(THEME.color(CHANNEL_TOKENS[1])));
    expect(tints).not.toContain(colorKey(THEME.color(SPEAKER_TOKEN)));
  });

  it('draws an admin broadcast in the accent', () => {
    const bag = harness();
    bag.chat.setView({ lines: [line({ channel: 2, from: '', text: 'restarting soon' })], reveal: 1 });
    bag.frame();

    expect(bag.tints()).toContain(colorKey(THEME.color(CHANNEL_TOKENS[2])));
  });

  it('gives each channel a colour of its own', () => {
    // Three tones that already mean something, and three *different* ones: a
    // channel drawn in the colour of another is a legend with two entries the
    // same.
    const keys = new Set(Object.values(CHANNEL_TOKENS).map((token) => colorKey(THEME.color(token))));
    expect(keys.size).toBe(3);
  });

  it('is no wider than the log, whatever it is offered', () => {
    const bag = harness();
    bag.chat.setView({ lines: [line({ text: 'x'.repeat(MAX_CHARS) })], reveal: 1 });
    bag.frame();
    expect(bag.chat.rect.width).toBe(LOG_WIDTH);
  });

  it('wraps a long line rather than running off the edge', () => {
    const bag = harness();
    bag.chat.setView({ lines: [line({ text: 'x'.repeat(MAX_CHARS) })], reveal: 1 });
    bag.frame();
    const tall = bag.chat.rect.height;

    bag.chat.setView({ lines: [line({ id: 2, text: 'short' })], reveal: 1 });
    bag.frame(1);
    expect(bag.chat.rect.height).toBeLessThan(tall);
  });
});

describe('the input line', () => {
  it('is not there until it is opened', () => {
    const bag = harness();
    expect(bag.chat.isOpen).toBe(false);
    expect(bag.chat.field.visible).toBe(false);
  });

  it('pushes textEntry on open and pops it on close', () => {
    // The whole reason the context stack exists (spec 123), and nothing had ever
    // pushed it: `TextField.setFocused` had no caller in the tree.
    const bag = harness();
    expect(bag.root.contexts.ids()).toEqual(['gameplay']);

    bag.chat.open(bag.focus);
    expect(bag.root.contexts.ids()).toEqual(['gameplay', 'textEntry']);
    expect(bag.root.contexts.reachesGameplay('key')).toBe(false);
    expect(bag.root.focus.focused).toBe(bag.chat.field);

    bag.chat.close(bag.focus);
    expect(bag.root.contexts.ids()).toEqual(['gameplay']);
    expect(bag.root.contexts.reachesGameplay('key')).toBe(true);
    expect(bag.root.focus.focused).toBeNull();
  });

  it('does not push twice when opened twice', () => {
    const bag = harness();
    bag.chat.open(bag.focus);
    bag.chat.open(bag.focus);
    expect(bag.root.contexts.ids()).toEqual(['gameplay', 'textEntry']);
    bag.chat.close(bag.focus);
    expect(bag.root.contexts.ids()).toEqual(['gameplay']);
  });

  it('refuses the character past what the server would keep', () => {
    const bag = harness();
    bag.chat.open(bag.focus);
    bag.chat.setInputText('x'.repeat(MAX_CHARS + 40));
    expect(bag.chat.inputText).toHaveLength(MAX_CHARS);
  });

  it('reports a submitted line, trimmed', () => {
    const bag = harness();
    const said: string[] = [];
    bag.chat.onSubmit = (text) => said.push(text);
    bag.chat.open(bag.focus);
    bag.chat.setInputText('  hello  ');
    bag.chat.field.onSubmit?.(bag.chat.inputText);

    expect(said).toEqual(['hello']);
  });

  it('reports an empty submit as empty rather than not at all', () => {
    // The mount closes on it instead of broadcasting a blank line to everyone in
    // the game, and it can only do that if it hears about it.
    const bag = harness();
    const said: string[] = [];
    bag.chat.onSubmit = (text) => said.push(text);
    bag.chat.open(bag.focus);
    bag.chat.field.onSubmit?.('   ');

    expect(said).toEqual(['']);
  });

  it('empties the field and says so when it closes', () => {
    const bag = harness();
    let closed = 0;
    bag.chat.onClosed = () => {
      closed++;
    };
    bag.chat.open(bag.focus);
    bag.chat.setInputText('half a thought');
    bag.chat.close(bag.focus);

    expect(bag.chat.inputText).toBe('');
    expect(closed).toBe(1);
    // ...and closing again is not a second closing.
    bag.chat.close(bag.focus);
    expect(closed).toBe(1);
  });

  it('is transparent to the pointer while closed, and reachable while open', () => {
    // The wheel is camera zoom in the Play tab: a closed log that took it would
    // break zoom in one corner of the screen with nothing drawn to say why.
    const bag = harness();
    bag.chat.setView({ lines: [line()], reveal: 1 });
    bag.frame();
    const inside = { x: bag.chat.rect.x + 4, y: bag.chat.rect.y + 4 };
    expect(bag.chat.hitTest(inside)).toBeNull();

    bag.chat.open(bag.focus);
    bag.frame(1);
    expect(bag.chat.hitTest({ x: bag.chat.log.rect.x + 4, y: bag.chat.log.rect.y + 4 })).not.toBeNull();
  });
});

describe('leaving the screen', () => {
  it('draws nothing once it is fully gone', () => {
    const bag = harness();
    bag.chat.setView({ lines: [line()], reveal: 1 });
    bag.frame();
    expect(bag.root.paint().finish().length).toBeGreaterThan(0);

    bag.chat.setView({ lines: [line()], reveal: 0 });
    expect(bag.root.paint().finish()).toHaveLength(0);
  });

  it('clips itself while it is leaving, anchored at the bottom', () => {
    // The oldest line goes first: a log that retracted from the bottom would
    // take the line somebody is still reading and leave the one they finished.
    const bag = harness();
    bag.chat.setView({ lines: [line()], reveal: 1 });
    bag.frame();
    const box = bag.chat.rect;

    bag.chat.setView({ lines: [line()], reveal: 0.5 });
    const clips = bag.root
      .paint()
      .finish()
      .filter((command) => command.kind === 'pushClip');
    // The screen's own is the outermost: it is pushed before anything under it
    // is painted, the scroll view's inside it.
    const clip = clips[0];
    if (clip?.kind !== 'pushClip') throw new Error('expected the screen to clip itself');
    expect(clip.rect.height).toBe(Math.round(box.height * 0.5));
    expect(clip.rect.y + clip.rect.height).toBe(box.y + box.height);
  });

  it('costs no clip at all once it has fully arrived', () => {
    const bag = harness();
    bag.chat.setView({ lines: [line()], reveal: 1 });
    bag.frame();
    const clips = bag.root
      .paint()
      .finish()
      .filter((command) => command.kind === 'pushClip');
    // The scroll view clips its own content, so there is one; what must not be
    // here is a second, whole-screen one for an animation that is not running.
    expect(clips).not.toHaveLength(0);
    expect(
      clips.every((command) => command.kind !== 'pushClip' || command.rect.height !== bag.chat.rect.height),
    ).toBe(true);
  });

  it('snaps rather than easing for a player who asked for less motion', () => {
    const bag = harness();
    bag.root.setMotion(REDUCED_MOTION);
    bag.chat.setView({ lines: [line()], reveal: 1 });
    bag.frame();
    const whole = bag.root.paint().finish().length;

    bag.chat.setView({ lines: [line()], reveal: 0.5 });
    expect(bag.root.paint().finish()).toHaveLength(0);

    bag.root.setMotion(FULL_MOTION);
    bag.chat.setView({ lines: [line()], reveal: 1 });
    expect(bag.root.paint().finish().length).toBe(whole);
  });
});

describe('what it costs', () => {
  it('lays out nothing on a frame in which nobody spoke', () => {
    const bag = harness();
    const lines = [line(), line({ id: 2, from: 'Bru', text: 'coming' })];
    bag.chat.setView({ lines, reveal: 1 });
    bag.frame();
    const settled = bag.root.layoutPasses;

    for (let frame = 1; frame < 60; frame++) {
      bag.chat.setView({ lines, reveal: 1 });
      bag.frame(frame * 16);
    }
    expect(bag.root.layoutPasses).toBe(settled);
  });

  it('follows its own tail as lines arrive', () => {
    const bag = harness();
    const lines: ChatLineView[] = [];
    for (let i = 0; i < 40; i++) {
      lines.push(line({ id: i + 1, text: `line ${i}` }));
      bag.chat.setView({ lines: [...lines], reveal: 1 });
      bag.frame(i);
      bag.chat.settle();
    }
    bag.frame(100);
    bag.chat.settle();
    expect(bag.chat.log.scrollOffset).toBe(bag.chat.log.maxScroll);
    expect(bag.chat.log.maxScroll).toBeGreaterThan(0);
  });
});
