# 147 — A window that stays where you put it

## Problem

Two halves of this were built in spec 124 and neither was ever plugged in.

`UiWindow` takes a `resizable` flag, draws a grip, and handles the drag — and
every one of the five game windows is registered as `new UiWindow(content, {
title })`, so not one of them can be resized. The bag is sized once, on the first
frame it is opened, from what its contents happened to want, and stays that size
for the life of the install. The only place the feature is exercised is the
gallery.

`layout-store.ts` is a finished, versioned, migrating, re-clamping document store
for where the windows are — and **nothing outside its own test imports it**.
`captureLayout`, `applyLayout`, `saveLayout` and `loadLayout` are dead code in
the shipped build. The scale preference persists (spec 136) and the key profile
persists (spec 135); the windows those settings are about open in their default
places every single session.

So: make the game's windows resizable, and write down where they are.

## Shape

**Resizing.** `ui-screens.ts` registers every window `resizable: true`. Two
corrections in `UiWindow` are what make that usable rather than nominal:

```ts
// widgets/window.ts
override hitTest(point: Point): Widget | null;   // the grip claims the point first
private minWidthFor(context: LayoutContext): number;  // uses minTitleWidth()
```

The grip is `gripSize` (7) square in the window's bottom-right corner; the
content box is inset by `padding` (4). So the content covers the inner 3×3 of
the grip, and `Widget.hitTest` — children back to front, deepest wins — hands
those pixels to the ScrollView. What is left as the whole resize handle is a
4-pixel corner band. Overriding `hitTest` so the grip answers before the
children is the difference between a handle and a rumour.

`minTitleWidth()` has existed since 124 and has never been called. It is the
floor `resize` clamps to: **a window is never narrower than its own name**,
because the title is the only thing that says which window it is, and an
interface where two 64-pixel stubs are indistinguishable is one you cannot undo
your way out of.

**Persistence.** The document and its migrations already exist. What is added is
the wiring, plus the two rules that wiring turns out to need:

```ts
// core/layout-store.ts
export interface ApplyOptions {
  readonly applyTab?: ApplyTab;
  /** Which ids this document may re-open. Default: all of them. */
  readonly restoreOpen?: (id: string) => boolean;
}
export function applyLayout(m: WindowManager, l: StoredLayout, v: Size, o?: ApplyOptions): void;
export function saveLayout(s: StorageLike, l: StoredLayout, key?: string): boolean;  // never throws

// world/ui-screens.ts — beside `scale` and `onBindingsChanged`, same reasons
readonly layout?: StoredLayout | null;
readonly onLayoutChanged: (layout: StoredLayout) => void;
flushLayout(): void;
```

`view.ts` reads the document at the DOM edge with `loadLayout(bindingStorage)`
and writes it with `saveLayout`, exactly as it already does for the bindings and
the scale. Nothing under `src/ui/` learns that `localStorage` exists.

**The restore is deferred to the first frame with a real viewport.** This is the
decision the whole feature turns on. `UiLayer` measures its frame in its
constructor, when the tab has not been laid out yet, and gets `Math.max(1,
clientWidth)` — a 1×1 placeholder that the first `update` corrects. `applyLayout`
re-clamps against the viewport it is handed, and re-clamping against 1×1 puts
every window at the origin at its minimum size. So the pending document is held
and applied on the first update whose viewport is bigger than a pixel.

**The save is a trailing debounce on a captured signature.** Each update the
mount builds a short signature of every window's placement; when it differs, the
write is scheduled for `nowMs + 400`, and any further change slides it. So a drag
writes once when it ends rather than sixty times while it is happening, and time
stays an argument — nothing here reads a clock. `flushLayout` forces the pending
write out, and `ui-layer.ts` calls it on `pagehide` and on the document going
hidden, so a tab closed within the debounce still keeps the layout.

**The shop and the trade window never restore open.** They are opened by the
*server* — proximity to a vendor, another player offering a trade — and the
player did not choose them. A trade window restored open has no trade in it and
no way to get one; `restoreOpen` is the predicate that says so. Their size and
position restore like everything else.

## Invariants tested

- A window cannot be resized narrower than its own title, whatever the drag.
- The resize grip hit-tests to the window across its whole area, including the
  part that overlaps the content.
- Every game window is resizable, and dragging the grip changes its size.
- A layout captured, saved, loaded and applied is the identity — position, size,
  pinned and z-order — for the same viewport.
- A layout restored while the viewport is still the 1×1 placeholder is *not*
  applied, and is still applied on the first real frame.
- A restored window keeps its stored geometry: the default placement does not
  run over it on the next open.
- `shop` and `trade` never come back open, however the document was written; the
  windows the player drives do.
- A layout saved at a large viewport and restored at a small one leaves every
  window fully on screen.
- The save is debounced: N changes inside the window produce one write, and the
  write carries the *last* state, not the first.
- A `StorageLike` whose `setItem` throws (quota, private mode) costs the layout
  and nothing else — no throw reaches the frame.
- Nothing is written before the restore has happened, so a slow first frame
  cannot overwrite a saved layout with defaults.
- `mount-presentation.test.ts` still holds: the same fight with the interface
  driven and not driven leaves identical authoritative state.

## Out of scope

- **Edge and corner resizing.** One grip, bottom-right, as spec 124 drew it.
  Eight-way resize means a hit region per edge and a cursor per region, and the
  interface has no cursor shapes at all.
- **A layout reset button.** The Display page is where it would go and the
  document is one `localStorage` key; neither is worth a screen until somebody
  wants it.
- **Per-scale layouts.** One document, re-clamped on restore. Remembering a
  different arrangement per interface scale is a different feature and a bigger
  document.
- **Snapping windows to each other or to the viewport edges.** The 4px grid is
  the only alignment aid, unchanged.
- **The HUD.** It is the DOM one and is not in the window manager.
