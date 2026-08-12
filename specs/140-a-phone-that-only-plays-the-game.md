# 140 — A phone that only plays the game

## Problem

`scripts/preview-touch.ts` photographs an 844×390 landscape frame, and the top
of it is a workbench: six tab buttons — Play, Movement sandbox, Rig debug, Map
editor, Studio, VFX — wrapping across the frame, a fullscreen toggle, and seven
tuning popovers piled into the right-hand corner underneath them, overlapping
the tabs because neither row knows about the other. Five of the six tabs cannot
be driven by a finger at all: the editor is a three-button drag model (spec 049)
and the two sandboxes and the two studios are walls of `lil-gui` sliders. They
are on a phone because `main.ts` builds the same bar everywhere.

Underneath that, the three windows the interface arrived with (spec 131) are
unreachable and unusable on touch, for two separate reasons:

- **Nothing opens them.** `I`, `C` and `Escape` are the only ways in
  (`key-actions.ts:35-45`), and a phone has no `I`, no `C` and no `Escape`.
- **Touch never reaches them.** `onPointerDown` sends a touch straight into
  `TouchGestures` (`view.ts:827-837`) and only the *mouse* path offers an event
  to `ui.handlePointer` first. So even a window opened by other means eats
  nothing, closes on nothing, and the tap under it orders the player to walk to
  wherever the window is.

And the camera cannot be turned. Spec 129 gave it `[` and `]` and the wiring has
been dead since spec 125: `orbitStep` asks a `held` set for the key *codes*
`BracketLeft`/`BracketRight`, and `held` has stored rebindable *action ids* ever
since keys became bindable. `resolve('BracketLeft')` returns `[]`, nothing is
ever added, and the only check that would have caught it — `scripts/probe-orbit.ts`
— is manual and not in CI. So the one answer spec 129 gave to "a rock is standing
in front of me" does not work on any device, and on a phone there is not even a
key to press.

This spec is the phone pass over all four: the shell offers the game and nothing
else, the developer furniture is not built, the three windows get buttons and get
touch, and two fingers turn the camera.

## Shape

### Still one flag

`isCoarsePointer()` (spec 093) remains the only thing that decides, and nothing
new asks the window how wide it is. What grows is the pure table it feeds, so
each new "a phone does not get this" is a field that is asserted in Node rather
than an `if` somewhere in the DOM:

```ts
// src/render/iso3d/world/hud-layout.ts
export interface HudLayout {
  // ...as before, plus:
  /** Whether the seven tuning popovers are built at all (spec 140). */
  readonly showsTuningMenus: boolean;
  /** One of the window buttons: inventory, equipment, options. */
  readonly systemButton: BoxSize;
  readonly systemGap: number;
  /** Whether a window button carries its name beside its icon. */
  readonly systemIconOnly: boolean;
  readonly systemIconPx: number;
}
```

`showsReadout` and `showsTuningMenus` are separate fields and both false on a
phone, because they are two different things that happen to go together today:
one is a text panel written by `hud.ts`, the other is seven popovers built in
`view.ts`. Collapsing them into one `developerChrome` boolean would read as a
rule and it is not one — the day a phone wants the retro filter switch back, one
of them flips.

### The shell offers the game and nothing else

```ts
// src/render/iso3d/shell-tabs.ts — pure.
export interface ShellTab { readonly label: string; readonly game?: boolean }
export function visibleTabs<T extends ShellTab>(tabs: readonly T[], compact: boolean): readonly T[];
```

On a coarse pointer, only tabs marked `game` survive; everything else is the
whole list. A `game` flag rather than an index or a label match, for the same
reason `fullscreen` is a property on the tab: which tabs are the game is a fact
about the tabs, not about their order in the bar.

The bar itself is still built, and on a phone it holds exactly one control: the
fullscreen button. That is not an exception to "remove all buttons" — it is the
button the rest of the phone experience is downstream of, because browser chrome
takes a third of a 390px frame (spec 093), and it is `null` on any device that
cannot go fullscreen anyway. When the tab list comes back down to one entry the
tab *buttons* are not drawn: a tab strip you cannot leave is furniture.

`ui-layer.ts` measures the bar to know where the app's chrome ends
(`chromeBottomCss`), so the bar keeps existing and keeps its `data-tab-bar`
handle rather than being deleted on a phone — a window opening under a bar that
is not there would be a second bug to find later.

### Three buttons, because a phone cannot press I

```ts
// src/render/iso3d/world/icons.ts
export type SystemIconId = 'inventory' | 'character' | 'options';
export function systemIconSvg(id: SystemIconId, options?: IconOptions): string;

// src/render/iso3d/world/hud.ts
export const SYSTEM_BUTTONS: readonly {
  readonly id: WindowId;
  readonly name: string;
  readonly icon: SystemIconId;
}[];

interface HudHandle {
  // ...
  /** What to call when a window button is pressed. The mount calls `ui.toggle`. */
  onOpen(handler: (id: WindowId) => void): void;
}
```

A bag, a figure and a cog, bottom right — mirroring the weapon switch bottom
left, and the corner a thumb reaches in landscape. Inline SVG through the same
`weaponIconSvg` machinery, for the same three reasons (spec 094): not emoji,
because half of them are coloured by the platform; not a sprite sheet, because
nothing here may be fetched; `currentColor`, so the lit/unlit styling the update
loop writes carries the icon and no second code path decides.

They are drawn on **both** layouts. "For discoverability" is not a phone problem
— `I` and `C` are undiscoverable on a desktop too — and the row is the same three
buttons either way, wider and captioned where there is room.

The button reports *which window*, and nothing else. `hud.ts` stays a file where
no `if` changes an outcome: `view.ts` receives the id and calls the same
`ui.toggle` that a key binding calls, so a button and a key cannot come to mean
different things.

Lit while its window is open, from `ui.isOpen(id)` — the window is the state, the
same way the weapon switch reads `equipment.mainHand` back off the server rather
than remembering what was clicked.

### Touch reaches the interface

The rule the mouse path already follows — offer it to the interface, act on it
only if the interface did not want it — becomes the rule for touch too:

```
pointerdown (touch) → ui.handlePointer('down', …) ?
                        yes → remember this pointer id as the interface's
                        no  → gestures.down(sample)
pointermove/up (touch) → whoever owns that pointer id
```

Ownership is per pointer id and settled on the way down, which is what stops a
finger that started on a window from also being half of a pinch, and stops a
finger that started on the world from posting an order the moment a window opens
underneath it.

A tap on the *world* is unchanged. A tap on a UI window is a `down` and an `up`
in UI pixels, which is the whole gesture vocabulary the bag was rebuilt around in
spec 137 — one press and one release on a cell — so the screens need nothing new
to be usable by a finger.

### Two fingers turn the camera

Two fingers moving already report a pinch. They now report what they did to the
*midpoint* in the same breath, because a real two-finger gesture is both at once
and reporting one of them would make the other unreachable:

```ts
// src/render/iso3d/world/touch.ts
export type TouchGesture =
  | { readonly kind: 'tap'; readonly x: number; readonly y: number }
  | { readonly kind: 'twoFinger'; readonly ratio: number; readonly dragX: number };
```

`ratio` is what it always was — the separation now over the separation at the
last report, so successive moves compose. `dragX` is how far the midpoint moved
sideways since that same report, in canvas pixels. A pure spread reports
`dragX ≈ 0`, a pure swipe reports `ratio ≈ 1`, and the view applies both without
either needing to decide which gesture this "really" is. A degenerate separation
no longer suppresses the whole report: it costs the ratio (`1`, meaning no zoom)
and the swipe still arrives.

```ts
// src/render/iso3d/world/orbit-keys.ts
export const ORBIT_DEG_PER_PX = 0.25;
export function orbitDrag(dragXPx: number): number;
```

Degrees per canvas pixel rather than per second, because a drag is direct
manipulation and its "rate" is the finger. 0.25°/px is a little over a half turn
across an 844px frame — the same order as the four-second keyboard sweep, and
enough to get behind a formation in one gesture without a flick spinning the
world. **The world follows the fingers**: swiping right turns the camera
anticlockwise, so the scene under the fingers travels with them. Non-finite input
turns nothing, the same contract `zoomSpan` has.

Both routes write `ViewControls.orbitBy`, so the pinch, the swipe, the keys and
the Orbit slider are one piece of state (spec 129) — and on a phone, where the
slider is not built at all now, `orbitBy` is still the same clamped, wrapped
write.

### And the keys start working again

`orbitStep` reads key codes, and `held` has held action ids since spec 125. The
fix is a second set beside it:

```ts
const heldKeys = new Set<string>();   // raw event.code, for input that is not rebindable
```

added on `keydown` and dropped on `keyup`, cleared by `blur` and by the interface
taking the keyboard, exactly as `held` is. Not a binding entry in
`bindings.json`: spec 129 chose two hard-coded codes on purpose, the keybindings
screen has golden images over the actions it lists, and inventing a camera
section in the profile format is a bigger change than the bug is.

What this really fixes is the *absence of a check*. `orbit-keys.test.ts` tests
`orbitStep` and passed throughout, because the break was in the wiring and not in
the arithmetic — so the test that earns its keep here is the one that drives the
real page, and `scripts/probe-orbit.ts` gains the two-finger case beside the two
keyboard ones.

## Invariants tested

Pure, in Node:

- `visibleTabs` returns every tab on a fine pointer, and only the tabs marked
  `game` on a coarse one — and the Play tab is marked, which is the assertion
  that fails the day somebody adds a seventh workbench and marks it wrong.
- `hudLayout(true)` builds no tuning menus; `hudLayout(false)` builds them.
- Every compact window button is square and at least `MIN_TAP_PX` on a side.
- The compact bottom band still fits: the centred hotbar clears the weapon row on
  the left **and the window-button row on the right** inside
  `PHONE_LANDSCAPE.width`. This is spec 094's sum with a third term, and it is
  the one that fails when a fourth window button is added.
- `systemIconSvg` returns a distinct icon per `SYSTEM_BUTTONS` entry, honours the
  requested size, and paints in `currentColor`.
- Two fingers spreading with a still midpoint report `ratio > 1` and
  `dragX === 0`; two fingers moving together with a fixed separation report
  `ratio === 1` and the midpoint's travel; a gesture that does both reports both.
- Successive `twoFinger` reports compose multiplicatively in `ratio` and additively
  in `dragX`, so the total is the gesture rather than the last frame of it.
- Fingers exactly on top of each other report `ratio === 1` rather than an
  infinity, and still report their `dragX`.
- A second finger landing still suppresses the tap for both fingers, and
  `cancel`/`clear` still emit nothing — spec 093's rules survive the new field.
- `orbitDrag` is zero for zero, opposite for opposite signs, linear in between,
  and zero for a non-finite input.

In a browser, because none of it is reachable from Vitest:

- On a coarse pointer the bar has no tab buttons and the corner has no tuning
  popovers, and on a fine pointer both are there. The developer readout is not
  drawn on either — it is `display:none` on a phone, which is what
  `preview-touch.ts` reads its clock through, so the assertion is on the *painted*
  frame rather than on `textContent`.
- Each of the three window buttons opens its window on a tap, and a second tap
  closes it. Read off `data-ui-windows`, which already publishes what is open.
- A tap inside an open window does not also order the player to walk there:
  the destination is unchanged across it.
- A two-finger swipe turns the view, in the direction the fingers went, and by no
  more than the rate it claims — the *ceiling* is the assertion that catches
  degrees handed to something that wanted radians.
- `[` and `]` turn the view again, which is the regression this spec found.

## Out of scope

- **Movement.** Still no virtual joystick; tapping the ground is the move order
  (spec 093), and the three new buttons are windows rather than a d-pad.
- **The shop and the trade table.** Both are opened by something happening — a
  vendor nearby, another player's invitation — rather than by a player deciding
  to look at them, so neither gets a button. `V` still works where there are keys.
- **Rebindable camera keys.** Two hard-coded codes, as spec 129 chose.
- **A settings surface on a phone.** The seven popovers are not rebuilt smaller;
  they are not built. The options window (spec 135) is what a phone gets, and the
  day the retro filter belongs in it, it becomes a tab there rather than a cog in
  the corner.
- **The map editor and the studios on touch.** Still mouse-only, and now honestly
  unreachable on a phone rather than reachable and broken.
- **A resize listener.** The layout is still chosen once from the pointer
  (spec 094): a phone does not become a desktop.
- **Two-finger pitch, rotate-by-twist, long-press, double-tap.** One tap, one
  pinch, one horizontal swipe.
