# 122 — windows that remember where they were

## Problem

Spec 121 built a framework and nine widgets, and there is nowhere to put them. An
inventory, a character sheet and a keybinding table are all *windows*: they open,
they move, they stack, one of them has the keyboard, and the player expects to
find them tomorrow where they left them today.

The parts that look easy and are not: z-order that survives clicking, a drag that
lands on the grid rather than wherever the cursor happened to be, a window clamped
to a viewport that now varies (spec 123 made the UI a scale rather than a fixed
canvas, so the viewport changes when the window does), and a saved layout that
still loads after the schema changes.

## Shape

### A window is a panel with a title bar and a place to be

```ts
// src/ui/widgets/window.ts
export interface WindowOptions {
  readonly title: string;
  readonly closable?: boolean;     // default true
  readonly resizable?: boolean;    // default false
  readonly minSize?: Size;
  readonly maxSize?: Size;
}

export class UiWindow extends StyledWidget {
  readonly content: Widget;
  open: boolean;
  pinned: boolean;                 // a pinned window does not close on Escape
  place(at: Point): void;          // snapped to the grid, clamped to the viewport
  onClose: (() => void) | null;
}
```

Dragging is by the title bar only, snapped to `theme.spacing.unit` — the same 4px
grid everything else sits on, so a moved window stays aligned with the one beside
it. Resizing is a corner grip, bounded by `minSize`/`maxSize` and by the viewport.

### The manager owns the order, because a window cannot

```ts
// src/ui/core/window-manager.ts
export class WindowManager extends Widget {
  add(window: UiWindow, id: string): void;
  focus(id: string): void;          // moves to the front
  close(id: string): boolean;
  closeTopmost(): boolean;          // what Escape does
  readonly order: readonly string[]; // back to front
}
```

Z-order is a list, not a number on each window. A window that carried its own
depth would need every *other* window rewritten whenever one came forward, and
two windows could hold the same depth with nothing to say which won.

### Layers, so a tooltip is never under a window

The fixed enum from spec 123's design, made real:

```
Hud 10 -> Windows 20 -> DragGhost 30 -> Modal 40 -> Tooltip 50 -> Notification 60
```

A `LayerStack` is a `Stack` whose children are these, in order. Nothing assigns a
z-index by hand, ever.

### Tabs keep their state when you leave them

```ts
// src/ui/widgets/tabs.ts
export class TabStrip extends StyledWidget { … }
export class TabPanel extends StyledWidget {
  addTab(id: string, label: string, build: () => Widget): void;
  select(id: string): void;
  readonly activeId: string;
}
```

Content is built lazily on first selection and then **kept** — switching away
hides a widget rather than destroying it, so a half-typed search box is still
half-typed when you come back. Overflow is a chevron that scrolls the strip, not
a row that runs off the edge.

### The layout is a document, and documents get versioned

```ts
// src/ui/core/layout-store.ts
export interface StoredLayout {
  readonly version: number;
  readonly windows: readonly {
    readonly id: string;
    readonly x: number; readonly y: number;
    readonly width: number; readonly height: number;
    readonly open: boolean;
    readonly pinned: boolean;
    readonly activeTab?: string;
  }[];
}
export function migrateLayout(raw: unknown): StoredLayout | null;
export function captureLayout(manager: WindowManager): StoredLayout;
export function applyLayout(manager: WindowManager, layout: StoredLayout, viewport: Size): void;
```

`migrateLayout` returns null rather than throwing for anything it cannot
understand, because a corrupted preference must not stop the game opening.
Persistence goes through a `StorageLike` injected at the DOM edge, exactly as
`editor/persistence.ts` already does it — the module stays pure and testable.

Restoring **re-clamps to the current viewport**. A layout saved on a wide monitor
must not put a window off the edge of a phone, and since spec 123 the viewport is
a function of the window size and the UI scale, so this is the common case rather
than the exotic one.

### Tooltips

Follow the cursor, appear after `theme.input.tooltipDelayMs`, and flip rather than
overflow: a tooltip near the right edge opens to the left. The delay is measured
from the timestamps handed to `update`, like everything else here, so the whole
behaviour is replayable.

## Invariants tested

- Dragging a window by its title bar moves it by exactly the pointer delta,
  snapped to the 4px grid; dragging by its body does not move it.
- A window can never be dragged or restored fully outside the viewport: its title
  bar always keeps at least `minVisible` pixels on screen.
- Resizing respects `minSize` and `maxSize` and never inverts the rect.
- Clicking any part of a window brings it to the front of `order` and gives it the
  focused style; the previously focused one loses it.
- `order` is a permutation of the added ids at all times — no duplicates, none
  lost.
- Escape closes the topmost *closable, unpinned* window and nothing else; with no
  such window it is not consumed, so gameplay still sees it.
- A modal blocks pointer and key routing to every layer below it while still
  painting them.
- Tab content is built once: selecting a tab, leaving and returning does not
  rebuild it, and a value typed into it survives the round trip.
- Tab overflow never draws a tab outside the strip.
- `captureLayout` then `applyLayout` is the identity for position, size, open
  state, pinned state and active tab.
- `migrateLayout` returns null for junk, for a future version, and for a
  structurally wrong document, and upgrades a version-1 document to the current
  one.
- A layout captured at one viewport and applied at a smaller one leaves every
  window on screen.
- A tooltip near an edge flips instead of overflowing, and appears only after the
  delay has passed in the timestamps handed to `update`.
- Six windows open at once: the draw-call count and the layout-pass count are both
  asserted, and a still frame with six windows open does no layout work.

## Out of scope

- **Any game screen.** This spec builds the furniture; the inventory and the
  character sheet are phases 4 and 5, and they wait on server work that does not
  exist (see `docs/ui/00-architecture.md` §2.7).
- **Rebindable actions.** Escape and Tab are wired directly here; spec 125 gives
  them an `InputMap`.
- **Docking, snapping windows to each other, or maximise.** A window goes where it
  is put.
- **Animation.** Windows appear and disappear; tweening is phase 7.
- **The Play tab.** Still untouched.

Tested by `src/ui/**/*.test.ts` and by new golden images over a six-window
gallery; `npx tsx scripts/preview-ui-gallery.ts` continues to assert the browser
backend matches the software one.
