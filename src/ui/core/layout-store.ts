/**
 * Where the windows were, across a reload (spec 122).
 *
 * A versioned document, and three rules that come from it being a *preference*
 * rather than a save file.
 *
 * **It never throws.** `migrateLayout` returns null for anything it cannot
 * understand -- junk, a future version, a structurally wrong document -- because
 * a corrupted preference must not stop the game opening. The cost of a bad parse
 * is windows in their default places, which is a bad afternoon; the cost of a
 * throw is a black screen.
 *
 * **It re-clamps on apply.** A layout saved on a wide monitor must not put a
 * window off the edge of a phone. Since spec 121 the viewport is a function of
 * the window size *and* the UI scale, so restoring at a different size is the
 * common case rather than the exotic one.
 *
 * **It does not touch storage.** Persistence goes through a `StorageLike` handed
 * in at the DOM edge, exactly as `render/iso3d/editor/persistence.ts` already
 * does it, so everything here is testable in Node against a fake.
 */

import type { Size } from './geom.js';
import type { WindowManager } from './window-manager.js';

export const LAYOUT_VERSION = 2;

export interface StoredWindow {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly open: boolean;
  readonly pinned: boolean;
  readonly activeTab?: string;
}

export interface StoredLayout {
  readonly version: number;
  readonly windows: readonly StoredWindow[];
  /** Back to front, so z-order survives too. Ids not in `windows` are ignored. */
  readonly order: readonly string[];
}

/** The subset of `localStorage` this needs. Injected, never reached for. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const LAYOUT_KEY = 'turbo-deck.ui.layout';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readWindow(raw: unknown): StoredWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record['id'] !== 'string' || record['id'].length === 0) return null;
  if (!isFiniteNumber(record['x']) || !isFiniteNumber(record['y'])) return null;
  if (!isFiniteNumber(record['width']) || !isFiniteNumber(record['height'])) return null;
  const activeTab = record['activeTab'];
  return {
    id: record['id'],
    x: Math.round(record['x']),
    y: Math.round(record['y']),
    width: Math.max(0, Math.round(record['width'])),
    height: Math.max(0, Math.round(record['height'])),
    open: record['open'] === true,
    pinned: record['pinned'] === true,
    ...(typeof activeTab === 'string' ? { activeTab } : {}),
  };
}

/**
 * Read whatever was stored, or null.
 *
 * Version 1 had no `order`; it is upgraded by treating the window list's own
 * order as the z-order, which is what it effectively was. That is the whole
 * migration, and it is here rather than inline so that adding version 3 has an
 * obvious place to go.
 */
export function migrateLayout(raw: unknown): StoredLayout | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const version = record['version'];
  if (!isFiniteNumber(version) || version < 1) return null;
  // A document from the future was written by a build that knew something this
  // one does not. Defaults are safer than a half-understood restore.
  if (version > LAYOUT_VERSION) return null;
  if (!Array.isArray(record['windows'])) return null;

  const windows = record['windows']
    .map((entry) => readWindow(entry))
    .filter((entry): entry is StoredWindow => entry !== null);

  const rawOrder = record['order'];
  const order =
    version >= 2 && Array.isArray(rawOrder)
      ? rawOrder.filter((id): id is string => typeof id === 'string')
      : windows.map((entry) => entry.id);

  return { version: LAYOUT_VERSION, windows, order };
}

export function parseLayout(text: string | null): StoredLayout | null {
  if (text === null) return null;
  try {
    return migrateLayout(JSON.parse(text));
  } catch {
    // Not even JSON. Same answer as any other unreadable document.
    return null;
  }
}

/** What each window's tab panel currently shows, if it has one. */
export type ActiveTabLookup = (id: string) => string | undefined;

export function captureLayout(manager: WindowManager, activeTab: ActiveTabLookup = () => undefined): StoredLayout {
  const windows: StoredWindow[] = [];
  for (const id of manager.ids()) {
    const window = manager.get(id);
    if (!window) continue;
    const tab = activeTab(id);
    windows.push({
      id,
      x: window.at.x,
      y: window.at.y,
      width: window.size.width,
      height: window.size.height,
      open: window.visible,
      pinned: window.pinned,
      ...(tab === undefined ? {} : { activeTab: tab }),
    });
  }
  return { version: LAYOUT_VERSION, windows, order: [...manager.order] };
}

export type ApplyTab = (id: string, tabId: string) => void;

/**
 * Put the windows back.
 *
 * Ids in the document that no longer exist are skipped, and windows the document
 * has never heard of keep their defaults -- so adding a window in a later build
 * does not invalidate everybody's saved layout.
 */
export function applyLayout(
  manager: WindowManager,
  layout: StoredLayout,
  viewport: Size,
  applyTab: ApplyTab = () => undefined,
): void {
  for (const stored of layout.windows) {
    const window = manager.get(stored.id);
    if (!window) continue;
    window.restore({ x: stored.x, y: stored.y }, { width: stored.width, height: stored.height }, viewport);
    window.visible = stored.open;
    window.pinned = stored.pinned;
    if (stored.activeTab !== undefined) applyTab(stored.id, stored.activeTab);
  }
  // Re-establish z-order back to front, skipping anything unknown.
  for (const id of layout.order) {
    if (manager.get(id)) manager.focus(id);
  }
  manager.setViewport(viewport);
}

export function saveLayout(storage: StorageLike, layout: StoredLayout, key = LAYOUT_KEY): void {
  storage.setItem(key, JSON.stringify(layout));
}

export function loadLayout(storage: StorageLike, key = LAYOUT_KEY): StoredLayout | null {
  return parseLayout(storage.getItem(key));
}
