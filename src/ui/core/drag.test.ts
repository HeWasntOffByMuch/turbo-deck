/**
 * The drag controller (spec 127), against a tree of stub widgets.
 *
 * No screen and no items here on purpose: what is being checked is that a
 * payload finds a target, that a target that refuses is walked past, and that
 * letting go over nothing loses nothing.
 */

import { describe, expect, it } from 'vitest';
import { Column } from './containers.js';
import { DragController, dropTargetFor, type DragPayload, type DropTarget } from './drag.js';
import type { Constraint, Point, Size } from './geom.js';
import { Widget } from './widget.js';

class Box extends Widget {
  constructor(
    name: string,
    private readonly size: Size = { width: 20, height: 20 },
  ) {
    super();
    this.name = name;
  }

  protected override measureSelf(_constraint: Constraint): Size {
    return this.size;
  }
}

/** A box that can be dropped on, and remembers what it took. */
class Bin extends Box implements DropTarget {
  readonly took: DragPayload[] = [];
  accepts = true;

  canAcceptDrop(): boolean {
    return this.accepts;
  }

  onDrop(payload: DragPayload): void {
    this.took.push(payload);
  }
}

function tree(): { root: Column; source: Box; bin: Bin; child: Box } {
  const root = new Column('root');
  const source = new Box('source');
  const bin = new Bin('bin');
  // A child *inside* the bin, so the walk-up is exercised: a cursor over a cell
  // is nearly always over something drawn in the cell.
  const child = new Box('label', { width: 8, height: 8 });
  bin.add(child);
  root.addAll([source, bin]);
  root.rect = { x: 0, y: 0, width: 20, height: 40 };
  source.rect = { x: 0, y: 0, width: 20, height: 20 };
  bin.rect = { x: 0, y: 20, width: 20, height: 20 };
  child.rect = { x: 4, y: 24, width: 8, height: 8 };
  return { root, source, bin, child };
}

const at = (x: number, y: number): Point => ({ x, y });

describe('dropTargetFor', () => {
  it('walks up to the nearest target that accepts', () => {
    const { source, bin, child } = tree();
    const payload: DragPayload = { source, data: 'thing' };
    expect(dropTargetFor(child, payload)).toBe(bin);
  });

  it('walks past a target that refuses', () => {
    const { source, bin, child } = tree();
    bin.accepts = false;
    expect(dropTargetFor(child, { source, data: 'thing' })).toBeNull();
  });

  it('answers null for nothing', () => {
    const { source } = tree();
    expect(dropTargetFor(null, { source, data: 'thing' })).toBeNull();
  });
});

describe('DragController', () => {
  function controller(root: Widget): DragController {
    return new DragController({ hitTest: (point) => root.hitTest(point) });
  }

  it('carries a payload to a target', () => {
    const { root, source, bin } = tree();
    const drag = controller(root);
    drag.begin({ source, data: 'thing' }, at(4, 4));
    expect(drag.active).not.toBeNull();

    drag.moveTo(at(6, 26));
    expect(drag.hovering).toBe(bin);
    expect(drag.drop(at(6, 26))).toBe(true);
    expect(bin.took).toHaveLength(1);
    expect(bin.took[0]?.data).toBe('thing');
    expect(drag.active).toBeNull();
  });

  /**
   * There is nowhere else for an item to go (spec 126 has no ground), so letting
   * go over nothing has to be a cancel. An interface that can destroy something
   * by being released in the wrong place is one people stop dragging in.
   */
  it('treats a release over nothing as a cancel', () => {
    const { root, source, bin } = tree();
    const drag = controller(root);
    drag.begin({ source, data: 'thing' }, at(4, 4));
    expect(drag.drop(at(500, 500))).toBe(false);
    expect(bin.took).toHaveLength(0);
    expect(drag.active).toBeNull();
  });

  it('drops nothing on a target that refuses', () => {
    const { root, source, bin } = tree();
    bin.accepts = false;
    const drag = controller(root);
    drag.begin({ source, data: 'thing' }, at(4, 4));
    expect(drag.drop(at(6, 26))).toBe(false);
    expect(bin.took).toHaveLength(0);
  });

  it('cancels without dropping', () => {
    const { root, source, bin } = tree();
    const drag = controller(root);
    drag.begin({ source, data: 'thing' }, at(4, 4));
    drag.cancel();
    expect(drag.active).toBeNull();
    expect(drag.drop(at(6, 26))).toBe(false);
    expect(bin.took).toHaveLength(0);
  });

  /** The keyboard's path, and deliberately the same payload and the same drop. */
  it('drops on a named target with no cursor involved', () => {
    const { root, source, bin } = tree();
    const drag = controller(root);
    drag.begin({ source, data: 'thing' }, at(4, 4));
    expect(drag.dropOnTarget(bin)).toBe(true);
    expect(bin.took).toHaveLength(1);
    expect(drag.active).toBeNull();
  });

  it('refuses a named target that will not take it', () => {
    const { root, source, bin } = tree();
    bin.accepts = false;
    const drag = controller(root);
    drag.begin({ source, data: 'thing' }, at(4, 4));
    expect(drag.dropOnTarget(bin)).toBe(false);
    // Still in hand: a wrong keystroke costs a keystroke, not the item.
    expect(drag.active).not.toBeNull();
  });

  it('reports the cursor and the payload to whoever draws the ghost', () => {
    const { root, source } = tree();
    const seen: (string | null)[] = [];
    const drag = new DragController({
      hitTest: (point) => root.hitTest(point),
      onChange: (payload) => seen.push((payload?.data as string | undefined) ?? null),
    });
    drag.begin({ source, data: 'thing' }, at(1, 1));
    drag.moveTo(at(2, 2));
    drag.cancel();
    expect(seen).toEqual(['thing', 'thing', null]);
  });
});
