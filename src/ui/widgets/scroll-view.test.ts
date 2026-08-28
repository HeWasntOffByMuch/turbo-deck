import { describe, expect, it } from 'vitest';
import { Column } from '../core/containers.js';
import { NO_MODIFIERS, wheelNotches, type UiEvent } from '../core/events.js';
import { UNBOUNDED, type Constraint, type Rect, type Size } from '../core/geom.js';
import { UiRoot } from '../core/root.js';
import { Widget, type LayoutContext } from '../core/widget.js';
import { DrawList } from '../core/draw-list.js';
import { FULL_MOTION } from '../core/motion.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import { Label } from './label.js';
import { ScrollView } from './scroll-view.js';

const ATLAS = bakeAtlas(THEME);
const CONTEXT: LayoutContext = { theme: THEME, atlas: ATLAS };
const BAR = THEME.widget('scrollView').metric('barThickness', 6);
/**
 * How far inside its own frame a scroll view's content sits.
 *
 * Expressed here rather than baked into the numbers below, because the bug this
 * guards against was three boxes disagreeing about it: the clip was inset and
 * the arrange was not, so the leftmost column of every scrolled thing was
 * clipped away. Assertions written as `rect.width - BAR` were asserting the
 * disagreement.
 */
const INSET = 1;

class Box extends Widget {
  constructor(private readonly size: Size, name = 'box') {
    super();
    this.name = name;
  }

  protected measureSelf(): Size {
    return this.size;
  }
}

function tallList(rows = 12, rowHeight = 10): Column {
  const column = new Column('list');
  for (let i = 0; i < rows; i++) column.add(new Box({ width: 40, height: rowHeight }, `row${i}`));
  return column;
}

function mounted(view: ScrollView, viewport: Size = { width: 100, height: 50 }): UiRoot {
  const root = new UiRoot(view, { theme: THEME, atlas: CONTEXT.atlas, viewport });
  root.update(0);
  return root;
}

describe('scrolling actually moves the content', () => {
  it('offsets the content upward, and re-arranges to do it', () => {
    // The bug this exists for: `scrollTo` set the offset and moved the scrollbar
    // thumb, and the content never budged -- because `arrange` early-returns on an
    // unchanged rect and a scroll view's own rect never changes. The offset was a
    // lie and the golden images agreed with it, because the thumb *had* moved.
    const view = new ScrollView(tallList(), 'scroll');
    const root = mounted(view);
    expect(view.content.rect.y).toBe(INSET);

    view.scrollTo(30);
    root.update(16);
    expect(view.scrollOffset).toBe(30);
    expect(view.content.rect.y).toBe(INSET - 30);
  });

  it('marks the subtree so a clean ancestor still descends', () => {
    const outer = new Column('outer');
    const view = new ScrollView(tallList(), 'scroll');
    outer.add(view);
    const root = new UiRoot(outer, { theme: THEME, atlas: CONTEXT.atlas, viewport: { width: 100, height: 50 } });
    root.update(0);

    view.scrollTo(20);
    // The outer column's own rect is unchanged, so it is not dirty -- but it must
    // know something below it is.
    expect(outer.needsArrange).toBe(false);
    expect(outer.needsArrangeInSubtree).toBe(true);
    root.update(16);
    expect(view.content.rect.y).toBe(view.rect.y + INSET - 20);
  });

  it('clamps to the range and never scrolls past either end', () => {
    const view = new ScrollView(tallList(), 'scroll');
    const root = mounted(view);
    view.scrollTo(-100);
    root.update(16);
    expect(view.scrollOffset).toBe(0);
    view.scrollTo(10_000);
    root.update(32);
    expect(view.scrollOffset).toBe(view.maxScroll);
    expect(view.content.rect.y).toBe(view.rect.y + INSET - view.maxScroll);
  });

  it('scrolls on the wheel and stops at the ends', () => {
    const view = new ScrollView(tallList(), 'scroll');
    const root = mounted(view);
    for (let i = 0; i < 40; i++) {
      root.handle({ kind: 'wheel', pos: { x: 10, y: 10 }, delta: -1, mods: NO_MODIFIERS, time: i });
    }
    expect(view.scrollOffset).toBe(view.maxScroll);
    for (let i = 0; i < 80; i++) {
      root.handle({ kind: 'wheel', pos: { x: 10, y: 10 }, delta: 1, mods: NO_MODIFIERS, time: 100 + i });
    }
    expect(view.scrollOffset).toBe(0);
  });

  it('goes the way a browser wheel is pointing', () => {
    // The direction only exists once a DOM `deltaY` has been converted, and the
    // conversion was the half that was wrong: the Play tab forwarded `deltaY`
    // raw, so every window in the game scrolled backwards while this file's own
    // wheel tests -- which mint a `delta` themselves -- stayed green. Asserted
    // through `wheelNotches` so the two ends cannot drift apart again.
    const view = new ScrollView(tallList(), 'scroll');
    const root = mounted(view);
    const wheel = (deltaY: number, time: number): void => {
      root.handle({ kind: 'wheel', pos: { x: 10, y: 10 }, delta: wheelNotches(deltaY), mods: NO_MODIFIERS, time });
    };

    // Pulling the wheel towards you (a positive `deltaY`) walks down the list.
    wheel(100, 0);
    expect(view.scrollOffset).toBeGreaterThan(0);
    const down = view.scrollOffset;

    // And pushing it away comes back up, by the same amount.
    wheel(-100, 1);
    expect(view.scrollOffset).toBe(0);

    // A notch is a notch: the browser's magnitude says which device and which
    // `deltaMode`, never how far. One line-mode notch moves as far as one
    // pixel-mode notch, rather than a hundredth as far.
    wheel(3, 2);
    expect(view.scrollOffset).toBe(down);
  });

  it('re-clamps when the viewport grows past the content', () => {
    const view = new ScrollView(tallList(), 'scroll');
    const root = mounted(view);
    view.scrollTo(view.maxScroll);
    root.update(16);
    expect(view.scrollOffset).toBeGreaterThan(0);

    root.resize({ width: 100, height: 1000 });
    root.update(32);
    expect(view.scrollable).toBe(false);
    expect(view.scrollOffset).toBe(0);
  });
});

/**
 * The bar's thumb, as it was actually drawn.
 *
 * Read off the draw list rather than from a private field, because "the thumb
 * stays under the pointer" is a claim about the pixels somebody is looking at.
 * It is the last solid the widget emits -- track first, thumb over it.
 */
function thumbRect(view: ScrollView): Rect {
  const commands = new DrawList();
  view.paint(commands, {
    theme: THEME,
    atlas: ATLAS,
    now: 0,
    motion: FULL_MOTION,
    hovered: null,
    pressed: null,
    focused: null,
  });
  const solids = commands.finish().filter((command) => command.kind === 'solid');
  const last = solids[solids.length - 1];
  if (last?.kind !== 'solid') throw new Error('no thumb was drawn');
  return last.dst;
}

/** A point inside the bar column, horizontally centred on it. */
function barX(view: ScrollView): number {
  return view.rect.x + view.rect.width - INSET - Math.ceil(BAR / 2);
}

function pointer(phase: 'down' | 'move' | 'up', x: number, y: number, time: number): UiEvent {
  return { kind: 'pointer', phase, pos: { x, y }, button: 0, mods: NO_MODIFIERS, time };
}

describe('dragging the scrollbar', () => {
  it('walks down the list when the bar is dragged down', () => {
    // The bug: a press on the bar fell into the content-drag rule, which is the
    // opposite gesture -- dragging content is grabbing the paper and goes with
    // the finger, dragging a bar is moving the position indicator and has to go
    // under it. So the bar ran away from the pointer.
    const view = new ScrollView(tallList(), 'scroll');
    const root = mounted(view);
    const x = barX(view);
    const thumb = thumbRect(view);

    root.handle(pointer('down', x, thumb.y + 2, 0));
    root.handle(pointer('move', x, thumb.y + 2 + 12, 1));

    expect(view.scrollOffset).toBeGreaterThan(0);
    // And the thumb went with the pointer, the same 12 pixels: the drag is scaled
    // by the *thumb's* travel, which is shorter than the content's scroll range.
    expect(thumbRect(view).y).toBe(thumb.y + 12);
  });

  it('reaches both ends and comes back', () => {
    const view = new ScrollView(tallList(), 'scroll');
    const root = mounted(view);
    const x = barX(view);

    root.handle(pointer('down', x, view.rect.y + 4, 0));
    root.handle(pointer('move', x, view.rect.y + 1000, 1));
    expect(view.scrollOffset).toBe(view.maxScroll);
    // Back up past where it started, in the same gesture.
    root.handle(pointer('move', x, view.rect.y - 1000, 2));
    expect(view.scrollOffset).toBe(0);
    root.handle(pointer('up', x, view.rect.y - 1000, 3));
  });

  it('measures from where the drag began, not from the last move', () => {
    // A gesture's `delta` is the whole journey from the press, so adding it to the
    // *current* offset applies that journey again every frame -- a drag that
    // accelerates away from the pointer and hits the end of any list in three
    // moves. Two moves that report the same delta must land in the same place.
    const view = new ScrollView(tallList(), 'scroll');
    const root = mounted(view);
    const x = barX(view);

    root.handle(pointer('down', x, view.rect.y + 4, 0));
    root.handle(pointer('move', x, view.rect.y + 4 + 10, 1));
    const once = view.scrollOffset;
    root.handle(pointer('move', x, view.rect.y + 4 + 10, 2));
    expect(view.scrollOffset).toBe(once);
    root.handle(pointer('up', x, view.rect.y + 4 + 10, 3));
  });

  it('leaves the content drag going the other way', () => {
    // Driven directly: a press over the content hits whatever child is under it,
    // and the router hands gestures to the widget that took the press -- so this
    // branch is unreachable through the root with a list this full, and it is
    // still the touch behaviour on the gaps and on a pointer-transparent child.
    const view = new ScrollView(tallList(), 'scroll');
    mounted(view);
    const inContent = { x: view.rect.x + 4, y: view.rect.y + 20 };
    const drag = (kind: 'dragStart' | 'drag', dy: number, time: number): void => {
      view.onGesture({
        kind,
        pos: { x: inContent.x, y: inContent.y + dy },
        delta: { x: 0, y: dy },
        button: 0,
        mods: NO_MODIFIERS,
        time,
      });
    };

    // Pushing the content up walks down the list -- grabbing the paper.
    drag('dragStart', -10, 0);
    expect(view.scrollOffset).toBe(10);
    // And it anchors on the press just as the bar does.
    drag('drag', -20, 1);
    expect(view.scrollOffset).toBe(20);
  });
});

describe('the scrollbar always has its room', () => {
  it('reserves bar width in measure and in arrange alike', () => {
    // Measuring the content wider than it is arranged is how a wrapped label
    // breaks its lines for a box it never gets.
    const view = new ScrollView(tallList(), 'scroll');
    const root = mounted(view, { width: 100, height: 50 });
    expect(view.content.rect.width).toBe(view.rect.width - BAR - INSET * 2);
    expect(root.viewport.width).toBe(100);
  });

  it('reserves it even when there is nothing to scroll', () => {
    // Otherwise every widget in a growing list shifts sideways the moment the bar
    // appears.
    const view = new ScrollView(tallList(1), 'scroll');
    mounted(view, { width: 100, height: 500 });
    expect(view.scrollable).toBe(false);
    expect(view.content.rect.width).toBe(view.rect.width - BAR - INSET * 2);
  });

  it('wraps a label at the width the label is actually given', () => {
    const label = new Label('the quick brown fox jumps over the lazy dog and keeps going', 'body');
    label.wrap = true;
    const view = new ScrollView(label, 'scroll');
    mounted(view, { width: 120, height: 40 });
    // Every line must fit the arranged width, not the pre-bar one.
    for (const line of label.lines(label.rect.width)) {
      expect(line.length * 7 - 1).toBeLessThanOrEqual(view.rect.width - BAR - INSET * 2);
    }
  });
});

describe('maxHeight', () => {
  // Inside a column, not as the root: a root always fills its viewport, because
  // that is what a root is. `maxHeight` is a measure preference, and it is a
  // parent that honours it.
  function inColumn(view: ScrollView): UiRoot {
    const column = new Column('holder');
    column.add(view);
    const root = new UiRoot(column, { theme: THEME, atlas: CONTEXT.atlas, viewport: { width: 100, height: 500 } });
    root.update(0);
    return root;
  }

  it('caps the viewport so a list shorter than its content can scroll', () => {
    const view = new ScrollView(tallList(12, 10), 'scroll');
    view.maxHeight = 40;
    inColumn(view);
    expect(view.rect.height).toBe(40);
    expect(view.scrollable).toBe(true);
  });

  it('without one, a generously-offered scroll view just fits its content', () => {
    const view = new ScrollView(tallList(3, 10), 'scroll');
    inColumn(view);
    expect(view.scrollable).toBe(false);
  });

  it('never reports an unbounded height when measured unbounded', () => {
    const view = new ScrollView(tallList(), 'scroll');
    const constraint: Constraint = { maxWidth: 100, maxHeight: UNBOUNDED };
    expect(view.measure(constraint, CONTEXT).height).toBeLessThan(1000);
  });

  /**
   * The invariant the 1px numbers above are only a proxy for: **everything the
   * content draws is inside the clip the children are painted through.**
   *
   * This is the assertion that would have caught the shipped bug directly. The
   * symptom was an item list whose first letter was subtly wrong -- "Worn Sword"
   * drawn as "Vorn Sword" -- which reads as a font problem and sent me looking
   * at the glyph table. It was a box disagreement, and a box disagreement is
   * something a test can state exactly.
   */
  it('paints nothing outside the box it clips to', () => {
    const label = new Label('Worn Sword');
    const view = new ScrollView(label);
    mounted(view, { width: 120, height: 60 });

    const commands = new DrawList();
    view.paint(commands, {
      theme: THEME,
      atlas: ATLAS,
      now: 0,
      motion: FULL_MOTION,
      hovered: null,
      pressed: null,
      focused: null,
    });

    const clip = commands.finish().find((command) => command.kind === 'pushClip');
    expect(clip?.kind).toBe('pushClip');
    if (clip?.kind !== 'pushClip') return;
    // Every edge of the content, inside every edge of the clip.
    expect(label.rect.x).toBeGreaterThanOrEqual(clip.rect.x);
    expect(label.rect.y).toBeGreaterThanOrEqual(clip.rect.y);
    expect(label.rect.x + label.rect.width).toBeLessThanOrEqual(clip.rect.x + clip.rect.width);
  });
});