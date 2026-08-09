# 107 — A menu each, and one open at a time

## Problem

The Play tab's view cog has been the drawer everything visual gets dropped
into. It opened with four camera sliders (spec 033); it now carries sixty-odd
rows across seven unrelated subjects — the camera, the day/night clock, the
sun, the player's torch and magic light, the terrain overlays, the retro
filter, the colour grade, and the ten hike switches (specs 097-106). On a
1080p window it is a column taller than the screen that scrolls, so finding
"Soft shadows" means dragging past everything else first, and nothing in it
tells you which of two neighbouring sliders belongs to which effect.

Spec 075 already made the argument and stopped after one: the weather got its
own button because it answers a different question from the view. So do the
clock, the player's lights, the filter and the hike look. Each gets its own
button and its own popover, and — since they all open into the same corner of
the same window — opening one closes the rest.

## Shape

### A group that permits one open menu

The exclusivity is a two-line state machine and nothing to do with the DOM, so
it is a pure module that the panels drive with callbacks:

```ts
// src/render/iso3d/menu-group.ts
export interface MenuGroup {
  /** Register a menu. `apply` is called when *this* menu opens or closes. */
  add(apply: (open: boolean) => void): MenuHandle;
  closeAll(): void;
  /** Which member is open, or -1. Registration order; for tests. */
  openIndex(): number;
}
export interface MenuHandle {
  isOpen(): boolean;
  toggle(): void;
  open(): void;
  close(): void;
}
export function createMenuGroup(): MenuGroup;
```

`apply` fires only on a change, and the outgoing menu is closed before the
incoming one opens, so at no point are two popovers in the document at once.

### A button and a popover, built once

The cog's popover styling, its button, its `Reset` and its section headings were
already copied once into `weather-controls.ts`, whose own comment said the third
panel was the moment to lift them out. This is the third, fourth, fifth and
sixth:

```ts
// src/render/iso3d/settings-menu.ts
export function createSettingsMenu(opts: {
  glyph: string;      // the button's face
  label: string;      // its title and aria-label
  group: MenuGroup;
  fontSize?: number;  // glyphs are not all the same size at the same px
}): SettingsMenu;
export interface SettingsMenu {
  readonly element: HTMLElement;  // button + popover, position:relative
  readonly panel: HTMLElement;    // rows go here
  readonly handle: MenuHandle;
}
export function section(text: string): HTMLElement;
export function resetButton(tip: string, widgets: readonly Resettable[]): HTMLButtonElement;
```

The sliders stay where they are. `view-controls.ts` builds polled widgets with
no change callback and `weather-controls.ts` builds pushing ones; that
difference is real and merging them would thread a callback through sixty rows
to serve three.

### Which rows go behind which button

Six buttons in the top-right corner, in this order:

| Button | Label | Holds |
|---|---|---|
| ⚙ | View settings | Camera: orbit, height, view span, follow lag. Terrain: unwalkable, spawners |
| ☀ | Day and night | The cycle, the clock, day length, and the manual sun direction/elevation |
| ✦ | Player lights | Torch (range, brightness, flicker, shadows) and the magic orb |
| ▦ | Retro filter | Colour steps, dither, weave, weave size, pixel size, and the colour grade |
| ❖ | Hike look | All ten steps of specs 097-106 |
| ≋ | Weather | Unchanged from spec 075 |

The manual sun sliders sit with the cycle rather than with the camera because
they *are* the sun — they are what drives it when the cycle is switched off, and
their tooltips have said so since spec 047.

Each popover carries its own `Reset`, restoring the widgets in that popover
only. One button that silently reset the other five would be worse than the
single panel it replaced.

Glyphs are plain symbols rather than emoji, for the reason spec 075 gives: a
headless Chromium's font stack has no colour emoji and renders a tofu box, and
so does any player whose system stack is equally sparse.

`ViewControls` grows one member, `menus: MenuGroup`, so the weather panel can
join the same group without the scene having to hand one down:

```ts
const weather = createWeatherControls({ group: scene.controls.menus });
```

### The sandboxes

`movement.ts` and `debug-view.ts` pass `lighting: false` and get three buttons:
view, sun (the two manual sliders, with no cycle above them) and hike. They run
no post pass, so there is no retro button and no grade, exactly as before.

## Invariants tested

`menu-group.test.ts`, headlessly, since none of it needs a document:

- Opening a second menu closes the first, and `openIndex()` names the second.
- Toggling the open menu closes it and leaves nothing open.
- `apply` is called only when that menu's state actually changes — a menu that
  was already closed is not told to close again when a sibling opens.
- The outgoing menu is applied `false` before the incoming one is applied
  `true`.
- `closeAll()` closes whatever is open and is a no-op when nothing is.
- A handle whose menu is closed reports `isOpen() === false` after a sibling
  opens.

The panels themselves stay unasserted, as they have been since spec 033: the
suite runs in Node with no DOM. What a browser has to check instead —
that the rows still reach their effect through the new buttons — is
`scripts/preview-hike.ts` and `scripts/probe-lowres.ts`, which drive the real
page and now open the Hike menu rather than the cog.

## Out of scope

- Persisting which menu was open, or any setting in it. `view-controls.ts` still
  holds no state but its widgets, and every session opens at defaults (spec 097).
- Closing a menu by clicking the world behind it, or on Escape. The buttons are
  a toggle each and the group makes them exclusive; a click-away handler over a
  canvas that already binds every button is a separate question.
- Any change to what a widget does. This moves rows between popovers and changes
  nothing about the values they produce — `hike()`, `retro()`, `grade()`,
  `sky()` and `playerLights()` return exactly what they returned before.
- The map editor's lil-gui panel, which is a different system entirely.
