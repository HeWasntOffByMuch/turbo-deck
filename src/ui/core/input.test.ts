import { describe, expect, it } from 'vitest';
import { Column } from './containers.js';
import { ContextStack, NO_MODIFIERS, type UiEvent } from './events.js';
import { focusableWidgets, FocusManager } from './focus.js';
import type { Rect, Size } from './geom.js';
import { UiRoot } from './root.js';
import { Widget, type LayoutContext } from './widget.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import { Button } from '../widgets/button.js';

const CONTEXT: LayoutContext = { theme: THEME, atlas: bakeAtlas(THEME) };

class Box extends Widget {
  readonly log: string[] = [];

  constructor(private readonly size: Size, name: string) {
    super();
    this.name = name;
  }

  protected measureSelf(): Size {
    return this.size;
  }

  onGesture(gesture: { kind: string }): void {
    this.log.push(gesture.kind);
  }
}

/** Index into an array, failing loudly rather than with `undefined is not an object`. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
}

function pointer(phase: 'down' | 'up' | 'move', x: number, y: number, time: number, button = 0): UiEvent {
  return { kind: 'pointer', phase, pos: { x, y }, button, mods: NO_MODIFIERS, time };
}

function key(code: string, time: number, phase: 'down' | 'up' = 'down'): UiEvent {
  return { kind: 'key', phase, code, mods: NO_MODIFIERS, time };
}

function makeRoot(content: Widget, viewport: Size = { width: 100, height: 100 }): UiRoot {
  const root = new UiRoot(content, { theme: THEME, atlas: CONTEXT.atlas, viewport });
  root.update(0);
  return root;
}

/** A row of two boxes side by side, which is enough to test every routing rule. */
function twoBoxes(): { root: UiRoot; a: Box; b: Box; parent: Column } {
  const parent = new Column('parent');
  const a = new Box({ width: 100, height: 50 }, 'a');
  const b = new Box({ width: 100, height: 50 }, 'b');
  parent.addAll([a, b]);
  const root = makeRoot(parent);
  return { root, a, b, parent };
}

describe('hit testing', () => {
  it('returns the front-most widget containing the point', () => {
    const { root, a, b } = twoBoxes();
    expect(root.content.hitTest({ x: 10, y: 10 })).toBe(a);
    expect(root.content.hitTest({ x: 10, y: 60 })).toBe(b);
  });

  it('skips invisible widgets', () => {
    const { root, a, b } = twoBoxes();
    a.visible = false;
    root.update(1);
    expect(root.content.hitTest({ x: 10, y: 10 })).not.toBe(a);
    expect(b.visible).toBe(true);
  });

  it('falls through a pointer-transparent widget to what is behind it', () => {
    const { root, a, parent } = twoBoxes();
    a.pointerTransparent = true;
    expect(root.content.hitTest({ x: 10, y: 10 })).toBe(parent);
  });

  it('returns null outside every widget', () => {
    const { root } = twoBoxes();
    expect(root.content.hitTest({ x: -5, y: -5 })).toBe(null);
  });
});

describe('click, drag and capture', () => {
  it('a press and release inside the widget is a click', () => {
    const { root, a } = twoBoxes();
    root.handle(pointer('down', 10, 10, 0));
    root.handle(pointer('up', 11, 11, 50));
    expect(a.log).toContain('click');
    expect(a.log).not.toContain('dragStart');
  });

  it('a press that moves past the threshold is a drag and NOT a click', () => {
    const { root, a } = twoBoxes();
    root.handle(pointer('down', 10, 10, 0));
    root.handle(pointer('move', 40, 10, 10));
    root.handle(pointer('up', 40, 10, 20));
    expect(a.log).toContain('dragStart');
    expect(a.log).toContain('dragEnd');
    expect(a.log).not.toContain('click');
  });

  it('a press that slides off the widget before release is cancelled', () => {
    const { root, a, b } = twoBoxes();
    root.handle(pointer('down', 10, 10, 0));
    root.handle(pointer('up', 10, 60, 20));
    expect(a.log).not.toContain('click');
    expect(b.log).not.toContain('click');
  });

  it('keeps capture on the presser while the cursor moves over a sibling', () => {
    const { root, a, b } = twoBoxes();
    root.handle(pointer('down', 10, 10, 0));
    expect(root.router.pressedWidget).toBe(a);
    root.handle(pointer('move', 10, 60, 10));
    // Hover follows the cursor; capture does not.
    expect(root.router.hoveredWidget).toBe(b);
    expect(root.router.pressedWidget).toBe(a);
    root.handle(pointer('up', 10, 60, 20));
    expect(root.router.pressedWidget).toBe(null);
  });

  it('emits enter and leave exactly once per transition', () => {
    const { root, a, b } = twoBoxes();
    root.handle(pointer('move', 10, 10, 0));
    root.handle(pointer('move', 12, 12, 1));
    root.handle(pointer('move', 10, 60, 2));
    expect(a.log.filter((entry) => entry === 'enter')).toHaveLength(1);
    expect(a.log.filter((entry) => entry === 'leave')).toHaveLength(1);
    expect(b.log.filter((entry) => entry === 'enter')).toHaveLength(1);
  });
});

describe('double click is decided from the timestamps handed in', () => {
  it('two quick clicks are a double, two slow ones are not', () => {
    const { root, a } = twoBoxes();
    root.handle(pointer('down', 10, 10, 0));
    root.handle(pointer('up', 10, 10, 10));
    root.handle(pointer('down', 10, 10, 20));
    root.handle(pointer('up', 10, 10, 30));
    expect(a.log).toContain('doubleClick');

    const slow = twoBoxes();
    slow.root.handle(pointer('down', 10, 10, 0));
    slow.root.handle(pointer('up', 10, 10, 10));
    slow.root.handle(pointer('down', 10, 10, 5000));
    slow.root.handle(pointer('up', 10, 10, 5010));
    expect(slow.a.log).not.toContain('doubleClick');
  });

  it('replays identically, because nothing reads a clock', () => {
    const script: readonly UiEvent[] = [
      pointer('move', 5, 5, 0),
      pointer('down', 10, 10, 8),
      pointer('up', 10, 10, 24),
      pointer('down', 10, 10, 40),
      pointer('up', 10, 10, 60),
      pointer('move', 10, 70, 90),
      pointer('down', 10, 70, 100),
      pointer('move', 60, 70, 140),
      pointer('up', 60, 70, 180),
    ];
    const run = (): string[] => {
      const { root, a, b } = twoBoxes();
      for (const event of script) root.handle(event);
      return [...a.log, '|', ...b.log];
    };
    expect(run()).toEqual(run());
  });

  it('three fast clicks are a click and a double, not two doubles', () => {
    const { root, a } = twoBoxes();
    for (let i = 0; i < 3; i++) {
      root.handle(pointer('down', 10, 10, i * 20));
      root.handle(pointer('up', 10, 10, i * 20 + 5));
    }
    expect(a.log.filter((entry) => entry === 'doubleClick')).toHaveLength(1);
  });
});

describe('focus', () => {
  function focusTree(): { root: UiRoot; buttons: Button[]; column: Column } {
    const column = new Column('col');
    const buttons = [new Button('one'), new Button('two'), new Button('three')];
    column.addAll(buttons);
    const root = makeRoot(column, { width: 200, height: 200 });
    return { root, buttons, column };
  }

  it('walks focusable widgets depth-first and wraps', () => {
    const { root, buttons } = focusTree();
    expect(root.moveFocus(1)).toBe(buttons[0]);
    expect(root.moveFocus(1)).toBe(buttons[1]);
    expect(root.moveFocus(1)).toBe(buttons[2]);
    expect(root.moveFocus(1)).toBe(buttons[0]);
    expect(root.moveFocus(-1)).toBe(buttons[2]);
  });

  it('skips disabled and invisible widgets', () => {
    const { root, buttons, column } = focusTree();
    at(buttons, 1).enabled = false;
    at(buttons, 2).visible = false;
    expect(focusableWidgets(column)).toEqual([buttons[0]]);
    expect(root.moveFocus(1)).toBe(buttons[0]);
    expect(root.moveFocus(1)).toBe(buttons[0]);
  });

  it('skips a widget inside a hidden ancestor even when its own flags are fine', () => {
    const outer = new Column('outer');
    const hidden = new Column('hidden');
    const button = new Button('deep');
    hidden.add(button);
    outer.add(hidden);
    hidden.visible = false;
    expect(focusableWidgets(outer)).toEqual([]);
  });

  it('drops focus when the focused widget becomes unreachable', () => {
    const { root, buttons, column } = focusTree();
    root.moveFocus(1);
    expect(root.focus.focused).toBe(buttons[0]);
    at(buttons, 0).visible = false;
    root.focus.revalidate(column);
    expect(root.focus.focused).toBe(null);
  });

  it('refuses to focus something unfocusable', () => {
    const manager = new FocusManager();
    const box = new Box({ width: 1, height: 1 }, 'plain');
    expect(manager.focus(box)).toBe(false);
    expect(manager.focused).toBe(null);
  });
});

describe('the context stack', () => {
  it('starts at gameplay and lets everything through', () => {
    const stack = new ContextStack();
    expect(stack.top().id).toBe('gameplay');
    expect(stack.reachesGameplay('key')).toBe(true);
    expect(stack.reachesGameplay('pointer')).toBe(true);
  });

  it('a text field swallows keys but a plain UI context does not', () => {
    const stack = new ContextStack();
    stack.push('ui');
    expect(stack.reachesGameplay('key')).toBe(true);
    stack.push('textEntry');
    expect(stack.reachesGameplay('key')).toBe(false);
    stack.pop('textEntry');
    expect(stack.reachesGameplay('key')).toBe(true);
  });

  it('a modal blocks the pointer below it', () => {
    const stack = new ContextStack();
    stack.push('modal');
    expect(stack.reachesGameplay('pointer')).toBe(false);
  });

  it('pops the topmost matching entry and never the base', () => {
    const stack = new ContextStack();
    stack.push('ui');
    stack.push('modal');
    stack.pop('modal');
    expect(stack.ids()).toEqual(['gameplay', 'ui']);
    stack.pop('gameplay');
    expect(stack.ids()[0]).toBe('gameplay');
  });
});

describe('a button behaves the same from a click and from the keyboard', () => {
  it('fires onPress either way, and never when disabled', () => {
    let presses = 0;
    const button = new Button('Go');
    button.onPress = () => {
      presses++;
    };
    const column = new Column();
    column.add(button);
    const root = makeRoot(column, { width: 200, height: 60 });

    const target: Rect = button.rect;
    root.handle(pointer('down', target.x + 2, target.y + 2, 0));
    root.handle(pointer('up', target.x + 2, target.y + 2, 10));
    expect(presses).toBe(1);

    root.focus.focus(button);
    root.handle(key('Space', 20));
    expect(presses).toBe(2);
    root.handle(key('Enter', 30));
    expect(presses).toBe(3);

    button.enabled = false;
    root.handle(key('Space', 40));
    expect(presses).toBe(3);
  });
});
