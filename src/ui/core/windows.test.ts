import { describe, expect, it } from 'vitest';
import { Column } from './containers.js';
import { NO_MODIFIERS, type UiEvent } from './events.js';
import type { Point, Size } from './geom.js';
import { LayerStack, LAYER_IDS } from './layers.js';
import {
  applyLayout,
  captureLayout,
  LAYOUT_VERSION,
  layoutSignature,
  loadLayout,
  migrateLayout,
  parseLayout,
  saveLayout,
  type StorageLike,
  type StoredLayout,
} from './layout-store.js';
import { UiRoot } from './root.js';
import { WindowManager } from './window-manager.js';
import { bakeAtlas } from '../render/atlas.js';
import { THEME } from '../theme/theme.js';
import { Label } from '../widgets/label.js';
import { TextField } from '../widgets/text-field.js';
import { TabPanel } from '../widgets/tabs.js';
import { ScrollView } from '../widgets/scroll-view.js';
import { clampToViewport, MIN_VISIBLE, pullIntoViewport, UiWindow } from '../widgets/window.js';

const ATLAS = bakeAtlas(THEME);
const VIEWPORT: Size = { width: 320, height: 200 };

function pointer(phase: 'down' | 'up' | 'move', x: number, y: number, time: number, button = 0): UiEvent {
  return { kind: 'pointer', phase, pos: { x, y }, button, mods: NO_MODIFIERS, time };
}

function key(code: string, time: number): UiEvent {
  return { kind: 'key', phase: 'down', code, mods: NO_MODIFIERS, time };
}

interface Harness {
  readonly root: UiRoot;
  readonly manager: WindowManager;
  readonly layers: LayerStack;
  window(id: string): UiWindow;
  frame(time?: number): void;
}

function harness(count = 3, viewport: Size = VIEWPORT): Harness {
  const manager = new WindowManager();
  const layers = new LayerStack();
  layers.place('windows', manager);

  for (let i = 0; i < count; i++) {
    const body = new Column(`body${i}`);
    body.add(new Label(`window ${i}`, 'body'));
    const window = new UiWindow(body, {
      title: `Window ${i}`,
      at: { x: 8 + i * 12, y: 8 + i * 12 },
      size: { width: 100, height: 60 },
      resizable: true,
    });
    manager.register(window, `w${i}`);
  }

  const root = new UiRoot(layers, { theme: THEME, atlas: ATLAS, viewport, windows: manager, layers });
  root.update(0);
  return {
    root,
    manager,
    layers,
    window: (id) => {
      const found = manager.get(id);
      if (!found) throw new Error(`no window ${id}`);
      return found;
    },
    frame: (time = 16) => {
      root.update(time);
    },
  };
}

describe('dragging a window', () => {
  it('moves by the pointer delta, snapped to the grid', () => {
    const h = harness(1);
    const window = h.window('w0');
    const start = { ...window.at };

    const bar = window.titleRect(h.root.layoutContext());
    h.root.handle(pointer('down', bar.x + 10, bar.y + 2, 0));
    h.root.handle(pointer('move', bar.x + 10 + 21, bar.y + 2 + 13, 10));
    h.frame();

    const unit = THEME.spacing.unit;
    expect(window.at.x % unit).toBe(0);
    expect(window.at.y % unit).toBe(0);
    expect(window.at.x).toBe(Math.round((start.x + 21) / unit) * unit);
    expect(window.at.y).toBe(Math.round((start.y + 13) / unit) * unit);
  });

  it('does not move when the drag starts on the body', () => {
    const h = harness(1);
    const window = h.window('w0');
    const before = { ...window.at };
    const bodyY = window.at.y + window.titleRect(h.root.layoutContext()).height + 10;

    h.root.handle(pointer('down', window.at.x + 10, bodyY, 0));
    h.root.handle(pointer('move', window.at.x + 60, bodyY + 40, 10));
    h.frame();
    expect(window.at).toEqual(before);
  });

  it('can never be dragged fully off screen', () => {
    const h = harness(1);
    const window = h.window('w0');
    const context = h.root.layoutContext();
    for (const target of [
      { x: -10_000, y: -10_000 },
      { x: 10_000, y: 10_000 },
      { x: 0, y: -400 },
    ]) {
      window.place(target, context, VIEWPORT);
      expect(window.at.x + window.size.width).toBeGreaterThanOrEqual(MIN_VISIBLE);
      expect(window.at.x).toBeLessThanOrEqual(VIEWPORT.width - MIN_VISIBLE);
      expect(window.at.y).toBeGreaterThanOrEqual(0);
      expect(window.at.y).toBeLessThanOrEqual(VIEWPORT.height - MIN_VISIBLE);
    }
  });

  it('keeps the handle reachable even for a window wider than the viewport', () => {
    // Clamping the whole window on screen would make this one unmovable, and on a
    // phone most windows are this one.
    const at = clampToViewport({ x: -50, y: 0 }, { width: 500, height: 60 }, VIEWPORT);
    expect(at.x).toBeLessThanOrEqual(VIEWPORT.width - MIN_VISIBLE);
    expect(at.x + 500).toBeGreaterThanOrEqual(MIN_VISIBLE);
  });
});

describe('resizing', () => {
  it('respects the minimum and never inverts', () => {
    const h = harness(1);
    const window = h.window('w0');
    const context = h.root.layoutContext();
    window.resize({ width: -200, height: -200 }, context, VIEWPORT);
    expect(window.size.width).toBeGreaterThanOrEqual(window.minSize.width);
    expect(window.size.height).toBeGreaterThanOrEqual(window.minSize.height);
  });

  it('never grows past the viewport', () => {
    const h = harness(1);
    const window = h.window('w0');
    window.resize({ width: 10_000, height: 10_000 }, h.root.layoutContext(), VIEWPORT);
    expect(window.size.width).toBeLessThanOrEqual(VIEWPORT.width);
    expect(window.size.height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  /**
   * A window narrower than its own name (spec 147).
   *
   * The title is the only thing that says which window this is, so two windows
   * dragged down to the 64px floor are two identical stubs -- and telling them
   * apart is what you need in order to undo it.
   */
  it('never shrinks a window narrower than its own title', () => {
    const h = harness(1);
    const window = h.window('w0');
    window.resize({ width: 0, height: 0 }, h.root.layoutContext(), VIEWPORT);
    expect(window.size.width).toBeGreaterThanOrEqual(window.minTitleWidth());
  });

  it('lets the viewport win over the title floor, so a window still fits its tab', () => {
    // On a narrow phone the floor can exceed the whole screen. A window wider
    // than the tab is worse than one whose name is clipped.
    const tiny = { width: 48, height: 40 };
    const h = harness(1, tiny);
    const window = h.window('w0');
    window.resize({ width: 10_000, height: 10_000 }, h.root.layoutContext(), tiny);
    expect(window.size.width).toBeLessThanOrEqual(tiny.width);
  });

  /**
   * The grip has to beat its own content to the hit test (spec 147).
   *
   * The router sends every `drag` to whichever widget took the press, so a grip
   * the content overlaps is a grip that never sees one. It overlaps by
   * construction: 7px square in a corner whose content box is inset by 4.
   */
  it('hit-tests to the window across the whole grip, not just the part outside the content', () => {
    const h = harness(1);
    const window = h.window('w0');
    const grip = window.gripRect(h.root.layoutContext());
    expect(grip.width).toBeGreaterThan(0);
    for (const point of [
      { x: grip.x, y: grip.y },
      { x: grip.x + Math.floor(grip.width / 2), y: grip.y + Math.floor(grip.height / 2) },
      { x: grip.x + grip.width - 1, y: grip.y + grip.height - 1 },
    ]) {
      expect(h.layers.hitTest(point), `${point.x},${point.y}`).toBe(window as never);
    }
  });

  it('resizes from a drag on the grip', () => {
    const h = harness(1);
    const window = h.window('w0');
    const before = { ...window.size };
    const grip = window.gripRect(h.root.layoutContext());
    const from = { x: grip.x + 1, y: grip.y + 1 };

    h.root.handle(pointer('down', from.x, from.y, 0));
    h.root.handle(pointer('move', from.x + 40, from.y + 30, 10));
    h.frame();

    expect(window.size.width).toBeGreaterThan(before.width);
    expect(window.size.height).toBeGreaterThan(before.height);
  });

  /**
   * The grip also beats a scrollbar, which is a newer collision than the content.
   *
   * The bar column is `barThickness` (6) wide down the right edge of the scroll
   * view's inner rect, and the scroll view is the window's content box inset by
   * one -- so its bottom-right corner lands inside the 7x7 grip and overlaps it
   * by a 2x2 square. Since the scroll view began taking drags on its bar, that
   * corner is a press two widgets both want. The grip wins because it is 7px
   * square in total and the bar has the whole rest of its column.
   */
  it('gives the grip a press that a scrollbar would otherwise take', () => {
    const manager = new WindowManager();
    const layers = new LayerStack();
    layers.place('windows', manager);
    const list = new Column('list');
    for (let i = 0; i < 40; i++) list.add(new Label(`line ${i}`, 'body'));
    const scroller = new ScrollView(list, 'scroll');
    const window = new UiWindow(scroller, {
      title: 'Log',
      at: { x: 8, y: 8 },
      size: { width: 120, height: 80 },
      resizable: true,
    });
    manager.register(window, 'log');
    const root = new UiRoot(layers, { theme: THEME, atlas: ATLAS, viewport: VIEWPORT, windows: manager, layers });
    root.update(0);
    // The premise: there really is a bar here to compete with.
    expect(scroller.scrollable).toBe(true);

    const before = { ...window.size };
    const scrolled = scroller.scrollOffset;
    const grip = window.gripRect(root.layoutContext());
    // The *contested* pixels, not the corner. The window's own padding band --
    // the outer 4 pixels of the grip -- belongs to nothing else and would pass
    // this test with the override deleted, which is a test that proves nothing.
    // One in from the grip's top-left is inside the bar column and inside the
    // scroll view's inner rect, so it is a press both widgets want.
    const from = { x: grip.x + 1, y: grip.y + 1 };
    expect(scroller.hitTest({ x: from.x, y: from.y - grip.height })).not.toBe(null);

    root.handle(pointer('down', from.x, from.y, 0));
    root.handle(pointer('move', from.x + 40, from.y + 30, 10));
    root.update(16);

    expect(window.size.width).toBeGreaterThan(before.width);
    expect(window.size.height).toBeGreaterThan(before.height);
    // ...and the list did not scroll under it, which is what the other reading
    // of that press would have done.
    expect(scroller.scrollOffset).toBe(scrolled);
  });

  it('does not resize a window that was not built resizable', () => {
    const manager = new WindowManager();
    const layers = new LayerStack();
    layers.place('windows', manager);
    const fixed = new UiWindow(new Column('body'), {
      title: 'Fixed',
      at: { x: 8, y: 8 },
      size: { width: 100, height: 60 },
    });
    manager.register(fixed, 'fixed');
    const root = new UiRoot(layers, { theme: THEME, atlas: ATLAS, viewport: VIEWPORT, windows: manager, layers });
    root.update(0);

    const corner = { x: fixed.at.x + fixed.size.width - 2, y: fixed.at.y + fixed.size.height - 2 };
    root.handle(pointer('down', corner.x, corner.y, 0));
    root.handle(pointer('move', corner.x + 40, corner.y + 30, 10));
    root.update(16);
    expect(fixed.size).toEqual({ width: 100, height: 60 });
  });
});

describe('z-order', () => {
  it('is always a permutation of the registered ids', () => {
    const h = harness(4);
    const ids = [...h.manager.ids()].sort();
    for (const id of ['w2', 'w0', 'w3', 'w0']) {
      h.manager.focus(id);
      expect([...h.manager.order].sort()).toEqual(ids);
      expect(new Set(h.manager.order).size).toBe(h.manager.order.length);
    }
  });

  it('brings a clicked window to the front', () => {
    const h = harness(3);
    expect(h.manager.order[h.manager.order.length - 1]).toBe('w2');

    const target = h.window('w0');
    // Somewhere only w0 covers -- the windows are staggered by 12px.
    h.root.handle(pointer('down', target.at.x + 2, target.at.y + 2, 0));
    expect(h.manager.order[h.manager.order.length - 1]).toBe('w0');
  });

  it('paints and hit-tests in the same order', () => {
    const h = harness(3);
    h.manager.focus('w0');
    const painted = h.manager.children.map((child) => child.name);
    expect(painted).toEqual(['Window 1', 'Window 2', 'Window 0']);
  });

  it('focusing the front-most window changes nothing', () => {
    const h = harness(3);
    const before = [...h.manager.order];
    h.manager.focus('w2');
    expect(h.manager.order).toEqual(before);
  });
});

describe('escape', () => {
  it('closes the topmost closable window and consumes the key', () => {
    const h = harness(3);
    expect(h.root.handle(key('Escape', 0))).toBe(true);
    expect(h.window('w2').visible).toBe(false);
    expect(h.window('w1').visible).toBe(true);
  });

  it('skips a pinned window and closes the one behind it', () => {
    const h = harness(3);
    h.window('w2').pinned = true;
    h.root.handle(key('Escape', 0));
    expect(h.window('w2').visible).toBe(true);
    expect(h.window('w1').visible).toBe(false);
  });

  it('is NOT consumed when there is nothing to close, so gameplay still sees it', () => {
    // An unclosable window and a pinned one, so Escape has nothing left -- and
    // must let the key through, or a player could never cancel a cast with a
    // window open.
    const manager = new WindowManager();
    const layers = new LayerStack();
    layers.place('windows', manager);
    const fixed = new UiWindow(new Column('a'), { title: 'Fixed', closable: false });
    const pinned = new UiWindow(new Column('b'), { title: 'Pinned' });
    pinned.pinned = true;
    manager.register(fixed, 'fixed');
    manager.register(pinned, 'pinned');
    const root = new UiRoot(layers, { theme: THEME, atlas: ATLAS, viewport: VIEWPORT, windows: manager, layers });
    root.update(0);

    expect(root.handle(key('Escape', 0))).toBe(false);
    expect(fixed.visible).toBe(true);
    expect(pinned.visible).toBe(true);
  });
});

describe('layers', () => {
  it('declares them in a fixed order', () => {
    expect(LAYER_IDS).toEqual(['hud', 'windows', 'dragGhost', 'modal', 'tooltip', 'notification']);
  });

  it('a visible modal blocks the pointer reaching a window, while it still paints', () => {
    const h = harness(1);
    const window = h.window('w0');
    const inside = { x: window.at.x + 4, y: window.at.y + 4 };
    expect(h.layers.hitTest(inside)).not.toBe(null);

    const veil = new Column('veil');
    h.layers.place('modal', veil);
    h.frame();
    expect(h.layers.isBlocked()).toBe(true);
    // Still painted -- a modal darkens what is behind it, it does not delete it.
    expect(window.visible).toBe(true);
    expect(h.layers.hitTest(inside)).not.toBe(window as never);
  });

  it('the tooltip and hud layers never take the pointer', () => {
    const h = harness(1);
    const label = new Label('nope', 'body');
    h.layers.place('tooltip', label);
    h.frame();
    expect(h.layers.hitTest({ x: 1, y: 1 })).not.toBe(label as never);
  });
});

describe('the layout document', () => {
  function fakeStorage(): StorageLike & { readonly map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
      removeItem: (key) => {
        map.delete(key);
      },
    };
  }

  it('captures and re-applies as the identity', () => {
    const h = harness(3);
    const context = h.root.layoutContext();
    h.window('w0').place({ x: 40, y: 24 }, context, VIEWPORT);
    h.window('w1').resize({ width: 120, height: 80 }, context, VIEWPORT);
    h.window('w2').pinned = true;
    h.manager.close('w1');
    h.manager.focus('w0');

    const saved = captureLayout(h.manager);
    const fresh = harness(3);
    applyLayout(fresh.manager, saved, VIEWPORT);

    for (const id of ['w0', 'w1', 'w2']) {
      expect(fresh.window(id).at, id).toEqual(h.window(id).at);
      expect(fresh.window(id).size, id).toEqual(h.window(id).size);
      expect(fresh.window(id).visible, id).toBe(h.window(id).visible);
      expect(fresh.window(id).pinned, id).toBe(h.window(id).pinned);
    }
    expect(fresh.manager.order).toEqual(h.manager.order);
  });

  it('survives a round trip through storage', () => {
    const h = harness(2);
    const storage = fakeStorage();
    saveLayout(storage, captureLayout(h.manager));
    const loaded = loadLayout(storage);
    expect(loaded?.version).toBe(LAYOUT_VERSION);
    expect(loaded?.windows.map((w) => w.id)).toEqual(['w0', 'w1']);
  });

  it('returns null for junk rather than throwing', () => {
    for (const junk of ['', 'not json', '{', '[]', 'null', '3']) {
      expect(parseLayout(junk), junk).toBe(null);
    }
    expect(parseLayout(null)).toBe(null);
    expect(migrateLayout(undefined)).toBe(null);
    expect(migrateLayout({ version: 1 })).toBe(null);
  });

  it('refuses a document from the future', () => {
    expect(migrateLayout({ version: LAYOUT_VERSION + 1, windows: [] })).toBe(null);
  });

  it('upgrades a version-1 document by treating list order as z-order', () => {
    const upgraded = migrateLayout({
      version: 1,
      windows: [
        { id: 'a', x: 0, y: 0, width: 10, height: 10, open: true },
        { id: 'b', x: 0, y: 0, width: 10, height: 10, open: true },
      ],
    });
    expect(upgraded?.version).toBe(LAYOUT_VERSION);
    expect(upgraded?.order).toEqual(['a', 'b']);
  });

  it('drops malformed windows and keeps the good ones', () => {
    const parsed = migrateLayout({
      version: LAYOUT_VERSION,
      order: ['a'],
      windows: [
        { id: 'a', x: 1, y: 2, width: 3, height: 4, open: true },
        { id: 'b', x: 'no', y: 2, width: 3, height: 4 },
        { nope: true },
        null,
      ],
    });
    expect(parsed?.windows.map((w) => w.id)).toEqual(['a']);
  });

  it('pulls every window back on screen when restored at a smaller viewport', () => {
    const wide = harness(3, { width: 640, height: 400 });
    const context = wide.root.layoutContext();
    wide.window('w0').place({ x: 560, y: 340 }, context, { width: 640, height: 400 });
    const saved = captureLayout(wide.manager);

    const small = harness(3, { width: 300, height: 140 });
    applyLayout(small.manager, saved, { width: 300, height: 140 });
    for (const id of small.manager.ids()) {
      const window = small.window(id);
      expect(window.at.x, id).toBeLessThanOrEqual(300 - MIN_VISIBLE);
      expect(window.at.y, id).toBeLessThanOrEqual(140 - MIN_VISIBLE);
      expect(window.at.y, id).toBeGreaterThanOrEqual(0);
    }
  });

  it('honours restoreOpen, and restores geometry either way', () => {
    // The rule the game needs (spec 147): a window the *server* opens was never
    // a choice worth remembering, but where the player put it still is.
    const h = harness(3);
    const context = h.root.layoutContext();
    h.window('w1').place({ x: 64, y: 40 }, context, VIEWPORT);
    const saved = captureLayout(h.manager);

    const fresh = harness(3);
    applyLayout(fresh.manager, saved, VIEWPORT, { restoreOpen: (id) => id !== 'w1' });
    expect(fresh.window('w1').visible).toBe(false);
    expect(fresh.window('w0').visible).toBe(true);
    // ...and it came back where it was, closed or not.
    expect(fresh.window('w1').at).toEqual(h.window('w1').at);
  });

  it('opens everything the document says by default', () => {
    const h = harness(2);
    const saved = captureLayout(h.manager);
    const fresh = harness(2);
    fresh.manager.close('w0');
    applyLayout(fresh.manager, saved, VIEWPORT);
    expect(fresh.window('w0').visible).toBe(true);
  });

  /**
   * A save that cannot land must cost the layout and nothing else.
   *
   * `saveLayout` is called from inside the frame, so a browser refusing the
   * write -- a full origin, private mode, a sandboxed iframe -- would otherwise
   * throw out of the render loop on every frame that scheduled one.
   */
  it('never throws when storage refuses', () => {
    const h = harness(1);
    const hostile: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    expect(saveLayout(hostile, captureLayout(h.manager))).toBe(false);
    expect(loadLayout(hostile)).toBe(null);
  });

  it('reports a write that landed', () => {
    const h = harness(1);
    expect(saveLayout(fakeStorage(), captureLayout(h.manager))).toBe(true);
  });

  describe('the signature', () => {
    it('changes for everything the document records', () => {
      const h = harness(2);
      const context = h.root.layoutContext();
      const seen = new Set<string>();
      const note = (): void => {
        seen.add(layoutSignature(h.manager));
      };

      note();
      h.window('w0').place({ x: 40, y: 24 }, context, VIEWPORT);
      note();
      h.window('w0').resize({ width: 140, height: 90 }, context, VIEWPORT);
      note();
      h.manager.close('w1');
      note();
      h.window('w1').pinned = true;
      note();
      h.manager.focus('w0');
      note();
      expect(seen.size).toBe(6);
    });

    it('is stable when nothing moved, which is what makes it worth asking', () => {
      const h = harness(3);
      const before = layoutSignature(h.manager);
      h.frame(16);
      h.frame(32);
      expect(layoutSignature(h.manager)).toBe(before);
    });
  });

  it('ignores ids it has never heard of, so adding a window later is safe', () => {
    const h = harness(2);
    const layout: StoredLayout = {
      version: LAYOUT_VERSION,
      order: ['ghost', 'w1'],
      windows: [{ id: 'ghost', x: 5, y: 5, width: 10, height: 10, open: true, pinned: false }],
    };
    expect(() => {
      applyLayout(h.manager, layout, VIEWPORT);
    }).not.toThrow();
    expect(h.manager.order).toContain('w1');
  });
});

describe('tabs', () => {
  function tabbed(): { panel: TabPanel; root: UiRoot; builds: Record<string, number> } {
    const builds: Record<string, number> = { one: 0, two: 0 };
    const panel = new TabPanel();
    panel.addTab('one', 'One', () => {
      builds['one'] = (builds['one'] ?? 0) + 1;
      return new TextField('', 'field:one');
    });
    panel.addTab('two', 'Two', () => {
      builds['two'] = (builds['two'] ?? 0) + 1;
      return new Label('second', 'body');
    });
    const root = new UiRoot(panel, { theme: THEME, atlas: ATLAS, viewport: { width: 200, height: 120 } });
    root.update(0);
    return { panel, root, builds };
  }

  it('selects the first tab on its own', () => {
    const { panel } = tabbed();
    expect(panel.activeId).toBe('one');
  });

  it('builds content lazily, and only once', () => {
    const { panel, builds, root } = tabbed();
    expect(builds['one']).toBe(1);
    expect(panel.isBuilt('two')).toBe(false);

    panel.select('two');
    root.update(16);
    expect(builds['two']).toBe(1);

    panel.select('one');
    panel.select('two');
    panel.select('one');
    root.update(32);
    expect(builds['one']).toBe(1);
    expect(builds['two']).toBe(1);
  });

  it('keeps what was typed into a tab you leave and come back to', () => {
    // The whole reason content is hidden rather than destroyed.
    const { panel, root } = tabbed();
    const field = [...panel.walk()].find((widget): widget is TextField => widget instanceof TextField);
    expect(field).toBeDefined();
    field?.setText('half typed');

    panel.select('two');
    root.update(16);
    panel.select('one');
    root.update(32);
    expect(field?.text).toBe('half typed');
  });

  it('never draws a tab outside the strip', () => {
    const panel = new TabPanel();
    for (let i = 0; i < 12; i++) panel.addTab(`t${i}`, `Tab ${i}`, () => new Label(`body ${i}`, 'body'));
    const root = new UiRoot(panel, { theme: THEME, atlas: ATLAS, viewport: { width: 120, height: 80 } });
    root.update(0);

    const strip = panel.headerStrip;
    expect(strip.maxScroll).toBeGreaterThan(0);
    for (const rect of panel.tabRects()) {
      expect(rect.x).toBeGreaterThanOrEqual(strip.rect.x);
      expect(rect.x + rect.width).toBeLessThanOrEqual(strip.rect.x + strip.rect.width);
    }
  });

  it('scrolls a hidden tab into view when it is selected', () => {
    const panel = new TabPanel();
    for (let i = 0; i < 12; i++) panel.addTab(`t${i}`, `Tab ${i}`, () => new Label(`body ${i}`, 'body'));
    const root = new UiRoot(panel, { theme: THEME, atlas: ATLAS, viewport: { width: 120, height: 80 } });
    root.update(0);

    panel.select('t11');
    root.update(16);
    expect(panel.headerStrip.scrollOffset).toBeGreaterThan(0);
  });
});

/**
 * The strip is never inside the thing it scrolls (spec 198).
 *
 * The whole feature is one sentence and it is a claim about *rectangles*: the
 * body may scroll as far as it likes and the tab headers do not move. What made
 * it worth a spec is that the mount used to wrap a whole screen in one
 * `ScrollView`, so reading the bottom of the character sheet's skill tree
 * scrolled the tab headers clean off the top of the window.
 */
describe('a tab strip that stays put', () => {
  /** A panel with more in each tab than the box it is given. */
  function tall(viewport: Size = { width: 160, height: 90 }): { panel: TabPanel; root: UiRoot } {
    const panel = new TabPanel();
    const rows = (id: string, count: number): Column => {
      const column = new Column(`rows:${id}`);
      for (let i = 0; i < count; i++) column.add(new Label(`${id} row ${i}`, 'body'));
      return column;
    };
    panel.addTab('long', 'Long', () => rows('long', 40));
    panel.addTab('short', 'Short', () => rows('short', 1));
    const root = new UiRoot(panel, { theme: THEME, atlas: ATLAS, viewport });
    root.update(0);
    return { panel, root };
  }

  it('scrolls the body when it is given a height', () => {
    const { panel } = tall();
    expect(panel.bodyScroller?.scrollable).toBe(true);
  });

  it('leaves the tab headers exactly where they were when the body scrolls', () => {
    const { panel, root } = tall();
    const before = panel.tabRects().map((rect) => ({ ...rect }));
    const strip = { ...panel.headerStrip.rect };

    panel.bodyScroller?.scrollTo(9999);
    root.update(16);

    expect(panel.bodyScroller?.scrollOffset).toBeGreaterThan(0);
    expect(panel.headerStrip.rect).toEqual(strip);
    expect(panel.tabRects()).toEqual(before);
    // And the body is genuinely under them rather than over them.
    expect(panel.bodyViewport().y).toBeGreaterThanOrEqual(strip.y + strip.height);
  });

  /**
   * The property that lets this live in the widget rather than in three screens.
   *
   * A `ScrollView` offered an unbounded height measures to its content, so a
   * panel inside somebody else's scroller has nothing to scroll and behaves
   * exactly as it did before any of this.
   */
  it('scrolls nothing when nobody bounded it', () => {
    const panel = new TabPanel();
    const column = new Column('rows');
    for (let i = 0; i < 40; i++) column.add(new Label(`row ${i}`, 'body'));
    panel.addTab('long', 'Long', () => column);
    const outer = new ScrollView(panel, 'outer');
    const root = new UiRoot(outer, { theme: THEME, atlas: ATLAS, viewport: { width: 160, height: 90 } });
    root.update(0);

    expect(outer.scrollable).toBe(true);
    expect(panel.bodyScroller?.scrollable).toBe(false);
  });

  /** Spec 124's rule reaches the offset too: a tab keeps where you left it. */
  it('gives each tab its own scroll position', () => {
    const { panel, root } = tall();
    panel.bodyScroller?.scrollTo(9999);
    root.update(16);
    const left = panel.bodyScroller?.scrollOffset ?? 0;
    expect(left).toBeGreaterThan(0);

    panel.select('short');
    root.update(32);
    // A short tab is at the top -- it has not inherited the long one's offset.
    expect(panel.bodyScroller?.scrollOffset).toBe(0);

    panel.select('long');
    root.update(48);
    expect(panel.bodyScroller?.scrollOffset).toBe(left);
  });

  /**
   * The bug the `layoutGrow` brought with it, kept as a test because nothing
   * else in the tree would have caught it.
   *
   * `visible` is a bare field and `invalidateMeasure` walks *up*, so a panel
   * that is the same height whichever tab is showing has a body whose rect never
   * changes -- and `arrange` early-returns on that. The tab just selected was
   * never handed a rectangle: nothing drawn, and every row in it hit-testing at
   * the origin.
   */
  it('lays out a tab selected after one exactly as tall', () => {
    const panel = new TabPanel();
    const label = (id: string): Label => new Label(`${id} content`, 'body');
    panel.addTab('one', 'One', () => label('one'));
    panel.addTab('two', 'Two', () => label('two'));
    const root = new UiRoot(panel, { theme: THEME, atlas: ATLAS, viewport: { width: 160, height: 90 } });
    root.update(0);

    panel.select('two');
    root.update(16);
    const shown = panel.bodyScroller?.content.rect;
    expect(shown?.width).toBeGreaterThan(0);
    expect(shown?.height).toBeGreaterThan(0);
    expect(shown?.y).toBeGreaterThanOrEqual(panel.bodyViewport().y);
  });

  it('spends a wheel over the strip on the body under it', () => {
    const { panel, root } = tall();
    const strip = panel.headerStrip.rect;
    root.handle({
      kind: 'wheel',
      pos: { x: strip.x + strip.width - 2, y: strip.y + 2 },
      delta: -3,
      mods: NO_MODIFIERS,
      time: 16,
    });
    root.update(16);
    expect(panel.bodyScroller?.scrollOffset).toBeGreaterThan(0);
  });
});

describe('six windows open at once', () => {
  it('lays out once and then does nothing on a still frame', () => {
    const h = harness(6);
    const after = h.root.layoutPasses;
    for (let frame = 1; frame <= 60; frame++) h.root.update(frame * 16);
    expect(h.root.layoutPasses).toBe(after);
  });

  it('stays inside a sane draw-call budget', () => {
    const h = harness(6);
    const commands = h.root.paint().finish();
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.length).toBeLessThan(1200);
  });

  it('keeps a balanced clip stack with everything open', () => {
    const h = harness(6);
    expect(() => h.root.paint().finish()).not.toThrow();
  });
});

describe('clampToViewport', () => {
  it('is a no-op for a window already on screen', () => {
    const at: Point = { x: 20, y: 20 };
    expect(clampToViewport(at, { width: 50, height: 50 }, VIEWPORT)).toEqual(at);
  });

  it('leaves the point alone when the viewport is not known yet', () => {
    const at: Point = { x: -500, y: -500 };
    expect(clampToViewport(at, { width: 10, height: 10 }, { width: 0, height: 0 })).toEqual(at);
  });
});

/**
 * A viewport that changed under the windows (spec 137).
 *
 * The scale setting is the reason this matters. Going from 1x to 4x quarters
 * the viewport's UI width, and every open window kept the size it had -- larger
 * than the screen it was on, with both edges outside the tab and 24 pixels of
 * title bar left to grab. The way back was the setting you could no longer see.
 */
describe('a viewport that shrank', () => {
  it('never leaves a window bigger than the viewport', () => {
    const test = harness(1, { width: 320, height: 200 });
    const window = test.window('w0');
    test.manager.open('w0');
    test.frame();

    test.root.resize({ width: 80, height: 50 });
    test.frame(32);
    expect(window.size.width).toBeLessThanOrEqual(80);
    expect(window.size.height).toBeLessThanOrEqual(50);
  });

  it('pulls the whole window back on screen, not just its handle', () => {
    const test = harness(1, { width: 320, height: 200 });
    const window = test.window('w0');
    test.manager.open('w0');
    test.frame();

    test.root.resize({ width: 120, height: 90 });
    test.frame(32);
    expect(window.at.x).toBeGreaterThanOrEqual(0);
    expect(window.at.y).toBeGreaterThanOrEqual(0);
    expect(window.at.x + window.size.width).toBeLessThanOrEqual(120);
    expect(window.at.y + window.size.height).toBeLessThanOrEqual(90);
  });

  it('leaves a window that already fits exactly where it was', () => {
    const test = harness(1, { width: 320, height: 200 });
    const window = test.window('w0');
    test.manager.open('w0');
    test.frame();
    const before = { ...window.at, ...window.size };

    test.root.resize({ width: 300, height: 190 });
    test.frame(32);
    expect(window.at).toEqual({ x: before.x, y: before.y });
    expect(window.size).toEqual({ width: before.width, height: before.height });
  });
});

describe('pullIntoViewport', () => {
  it('is a no-op for a window already fully on screen', () => {
    const at: Point = { x: 20, y: 20 };
    expect(pullIntoViewport(at, { width: 50, height: 50 }, VIEWPORT)).toEqual(at);
  });

  it('is stricter than the drag clamp, which is the whole point', () => {
    const at: Point = { x: 300, y: 190 };
    const size = { width: 100, height: 60 };
    // The drag rule leaves a sliver on screen; this one puts it all back.
    expect(clampToViewport(at, size, VIEWPORT).x).toBeGreaterThan(VIEWPORT.width - size.width);
    expect(pullIntoViewport(at, size, VIEWPORT)).toEqual({ x: 220, y: 140 });
  });

  it('gives up gracefully when the window cannot fit at all', () => {
    // Nothing sensible is possible, so the top-left corner is the answer: the
    // title bar is reachable and the close button is where it always is.
    expect(pullIntoViewport({ x: 40, y: 40 }, { width: 500, height: 500 }, VIEWPORT)).toEqual({ x: 0, y: 0 });
  });
});
