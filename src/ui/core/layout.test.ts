import { describe, expect, it } from 'vitest';
import { Anchor, Column, Grid, Row, Stack } from './containers.js';
import { distribute, shrinkToFit } from './distribute.js';
import { UNBOUNDED, uniformInsets, type Constraint, type Rect, type Size } from './geom.js';
import { Widget, type LayoutContext } from './widget.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';

const CONTEXT: LayoutContext = { theme: THEME, atlas: bakeAtlas(THEME) };

/** A widget of a fixed size, so a layout assertion is about the layout. */
class Box extends Widget {
  measureCount = 0;

  constructor(private readonly size: Size, name = 'box') {
    super();
    this.name = name;
  }

  protected measureSelf(): Size {
    this.measureCount++;
    return this.size;
  }
}

/** Index into an array, failing loudly rather than with `undefined is not an object`. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
}

function layout(root: Widget, box: Rect): void {
  const constraint: Constraint = { maxWidth: box.width, maxHeight: box.height };
  root.measure(constraint, CONTEXT);
  root.arrange(box, CONTEXT);
}

describe('distribute', () => {
  it('sums to exactly the total, for every remainder', () => {
    for (let total = 0; total < 40; total++) {
      for (const weights of [[1, 1, 1], [1, 2, 3], [2, 0, 2], [5]]) {
        const parts = distribute(total, weights);
        expect(parts.reduce((sum, value) => sum + value, 0)).toBe(total);
      }
    }
  });

  it('hands the leftover pixels to the leftmost children, in order', () => {
    // 10 across three equal children is 3,3,3 with one left over -- and it goes
    // to the first. Two left over goes to the first two. Deterministically, so a
    // golden image is repeatable.
    expect(distribute(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(distribute(11, [1, 1, 1])).toEqual([4, 4, 3]);
    expect(distribute(12, [1, 1, 1])).toEqual([4, 4, 4]);
  });

  it('gives nothing to a zero or negative weight, and does not count it', () => {
    expect(distribute(10, [1, 0, 1])).toEqual([5, 0, 5]);
    expect(distribute(10, [1, -4, 1])).toEqual([5, 0, 5]);
  });

  it('returns all zeroes when nothing wants to grow', () => {
    expect(distribute(100, [0, 0])).toEqual([0, 0]);
  });
});

describe('shrinkToFit', () => {
  it('never takes a child below its minimum', () => {
    const out = shrinkToFit([10, 10, 10], [8, 0, 0], 15);
    expect(out[0]).toBeGreaterThanOrEqual(8);
    expect(out.reduce((sum, value) => sum + value, 0)).toBe(15);
  });

  it('stops when nothing can give any more, instead of looping', () => {
    const out = shrinkToFit([5, 5], [5, 5], 100);
    expect(out).toEqual([5, 5]);
  });
});

describe('Row and Column', () => {
  it('tiles its children across the full inner width, losing nothing', () => {
    const row = new Row();
    const kids = [new Box({ width: 10, height: 5 }), new Box({ width: 10, height: 5 }), new Box({ width: 10, height: 5 })];
    for (const kid of kids) kid.layoutGrow = 1;
    row.addAll(kids);
    layout(row, { x: 0, y: 0, width: 100, height: 20 });

    expect(kids.map((k) => k.rect.width)).toEqual([34, 33, 33]);
    expect(kids[0]?.rect.x).toBe(0);
    expect(kids[1]?.rect.x).toBe(34);
    expect(kids[2]?.rect.x).toBe(67);
    const last = at(kids, 2).rect;
    expect(last.x + last.width).toBe(100);
  });

  it('accounts for the gap, so the children still sum to the box', () => {
    const row = new Row();
    row.gap = 4;
    const kids = [new Box({ width: 0, height: 5 }), new Box({ width: 0, height: 5 })];
    for (const kid of kids) kid.layoutGrow = 1;
    row.addAll(kids);
    layout(row, { x: 0, y: 0, width: 100, height: 20 });
    expect(kids[0]?.rect.width).toBe(48);
    expect(kids[1]?.rect.width).toBe(48);
    expect(at(kids, 1).rect.x + at(kids, 1).rect.width).toBe(100);
  });

  it('gives two equally-weighted children equal space regardless of content', () => {
    // The bug this exists for: treating grow as "take the leftover" makes the
    // wider child keep its head start forever, so a 50/50 split silently becomes
    // whatever the content happened to be.
    const row = new Row();
    const narrow = new Box({ width: 10, height: 5 });
    const wide = new Box({ width: 300, height: 5 });
    narrow.layoutGrow = 1;
    wide.layoutGrow = 1;
    row.addAll([narrow, wide]);
    layout(row, { x: 0, y: 0, width: 200, height: 20 });
    expect(narrow.rect.width).toBe(100);
    expect(wide.rect.width).toBe(100);
  });

  it('leaves non-growing children at their natural size', () => {
    const row = new Row();
    const fixed = new Box({ width: 30, height: 5 });
    const grower = new Box({ width: 10, height: 5 });
    grower.layoutGrow = 1;
    row.addAll([fixed, grower]);
    layout(row, { x: 0, y: 0, width: 100, height: 20 });
    expect(fixed.rect.width).toBe(30);
    expect(grower.rect.width).toBe(70);
  });

  it('stacks a column top to bottom with integral rects', () => {
    const column = new Column();
    column.padding = uniformInsets(4);
    const kids = [new Box({ width: 20, height: 10 }), new Box({ width: 20, height: 10 })];
    column.addAll(kids);
    layout(column, { x: 0, y: 0, width: 60, height: 60 });
    expect(kids[0]?.rect).toEqual({ x: 4, y: 4, width: 52, height: 10 });
    expect(kids[1]?.rect).toEqual({ x: 4, y: 14, width: 52, height: 10 });
  });

  it('skips invisible children entirely', () => {
    const row = new Row();
    const shown = new Box({ width: 10, height: 5 });
    const hidden = new Box({ width: 10, height: 5 });
    hidden.visible = false;
    row.addAll([shown, hidden]);
    shown.layoutGrow = 1;
    layout(row, { x: 0, y: 0, width: 100, height: 20 });
    expect(shown.rect.width).toBe(100);
  });
});

describe('every arranged rect is whole pixels', () => {
  it('holds across a nest of odd sizes', () => {
    const root = new Column();
    root.padding = uniformInsets(3);
    root.gap = 3;
    for (let i = 0; i < 5; i++) {
      const inner = new Row();
      inner.gap = 3;
      for (let j = 0; j < 3; j++) {
        const box = new Box({ width: 7, height: 9 });
        box.layoutGrow = j;
        inner.add(box);
      }
      inner.layoutGrow = 1;
      root.add(inner);
    }
    layout(root, { x: 0, y: 0, width: 337, height: 211 });
    for (const widget of root.walk()) {
      for (const value of [widget.rect.x, widget.rect.y, widget.rect.width, widget.rect.height]) {
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });
});

describe('Stack, Anchor and Grid', () => {
  it('gives every stack child the whole box', () => {
    const stack = new Stack();
    const a = new Box({ width: 10, height: 10 });
    const b = new Box({ width: 20, height: 5 });
    stack.addAll([a, b]);
    layout(stack, { x: 2, y: 3, width: 40, height: 40 });
    expect(a.rect).toEqual({ x: 2, y: 3, width: 40, height: 40 });
    expect(b.rect).toEqual({ x: 2, y: 3, width: 40, height: 40 });
  });

  it('pins anchored children to their corners at their own size', () => {
    const anchor = new Anchor();
    const topLeft = new Box({ width: 10, height: 10 });
    const bottomRight = new Box({ width: 10, height: 10 });
    const centre = new Box({ width: 10, height: 10 });
    anchor.place(topLeft, 'topLeft');
    anchor.place(bottomRight, 'bottomRight');
    anchor.place(centre, 'center');
    layout(anchor, { x: 0, y: 0, width: 100, height: 50 });
    expect(topLeft.rect).toMatchObject({ x: 0, y: 0 });
    expect(bottomRight.rect).toMatchObject({ x: 90, y: 40 });
    expect(centre.rect).toMatchObject({ x: 45, y: 20 });
  });

  it('fills a grid left to right and then down', () => {
    const grid = new Grid(3, 10, 10);
    grid.gap = 2;
    const cells = Array.from({ length: 5 }, () => new Box({ width: 10, height: 10 }));
    grid.addAll(cells);
    layout(grid, { x: 0, y: 0, width: 40, height: 40 });
    expect(cells[0]?.rect).toMatchObject({ x: 0, y: 0 });
    expect(cells[2]?.rect).toMatchObject({ x: 24, y: 0 });
    expect(cells[3]?.rect).toMatchObject({ x: 0, y: 12 });
    expect(grid.rows()).toBe(2);
  });
});

describe('dirty flags', () => {
  it('does no measuring at all on a second, unchanged pass', () => {
    const column = new Column();
    const box = new Box({ width: 10, height: 10 });
    column.add(box);
    const rect = { x: 0, y: 0, width: 50, height: 50 };

    layout(column, rect);
    const after = box.measureCount;
    expect(after).toBeGreaterThan(0);

    layout(column, rect);
    layout(column, rect);
    expect(box.measureCount).toBe(after);
  });

  it('invalidateMeasure marks the node and its ancestors, not its siblings', () => {
    const root = new Column();
    const left = new Column();
    const right = new Column();
    const leaf = new Box({ width: 1, height: 1 });
    left.add(leaf);
    root.addAll([left, right]);
    layout(root, { x: 0, y: 0, width: 10, height: 10 });
    expect(root.needsMeasure).toBe(false);

    leaf.invalidateMeasure();
    expect(leaf.needsMeasure).toBe(true);
    expect(left.needsMeasure).toBe(true);
    expect(root.needsMeasure).toBe(true);
    expect(right.needsMeasure).toBe(false);
  });

  it('invalidateArrange marks the node and its descendants', () => {
    const root = new Column();
    const child = new Column();
    const leaf = new Box({ width: 1, height: 1 });
    child.add(leaf);
    root.add(child);
    layout(root, { x: 0, y: 0, width: 10, height: 10 });

    child.invalidateArrange();
    expect(child.needsArrange).toBe(true);
    expect(leaf.needsArrange).toBe(true);
    expect(root.needsArrange).toBe(false);
  });
});

describe('unbounded constraints', () => {
  it('never let a widget claim an unbounded size as its own', () => {
    // The failure this guards: a "fill the space" widget answering an unbounded
    // measure with the constraint, so every ancestor inherits nine quadrillion
    // pixels as its desired height.
    const column = new Column();
    column.add(new Box({ width: 10, height: 10 }));
    const size = column.measure({ maxWidth: UNBOUNDED, maxHeight: UNBOUNDED }, CONTEXT);
    expect(size.height).toBeLessThan(1000);
    expect(size.width).toBeLessThan(1000);
  });
});
