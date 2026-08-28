# 251 — A window you can shut

## Problem

Every window in the design system has a title bar, a drag handle, a resize grip
and a `closable` flag -- and no way to close it with the pointer.

The three routes that exist are all keyboard or indirect: Escape shuts the
front-most window, the key or button that opened one toggles it, and the shop
and the trade table have Close buttons of their own inside their content.
Nothing in the chrome says a window can be shut, which is the one affordance a
title bar is universally read as carrying.

The framework has been built for this and stopped one step short. `UiWindow`
has had a `closable` flag, an `onClose` callback and a `requestClose()` since
spec 124; `requestClose` has **no caller anywhere in the tree**. The atlas has
an `icon:close` sprite, authored in spec 123 and drawn by nothing. And
`UiWindow.onEvent` carries the comment *"The close button is inside the title
bar and takes the press first, via its own hit test"* beside code that starts a
window drag on any press in the bar. Three finished halves of one feature, and
a comment describing a widget that was never written.

Two things beyond drawing the X have to be got right, and both are about where
a close goes rather than what it looks like.

**A press in the title bar is a drag.** The router sends every gesture to
whichever widget took the press, so a button inside the bar keeps its own
drag -- but `UiWindow.onEvent` runs on the *bubble* walk afterwards and would
arm a window drag from the same press. The comment above is not true today and
has to be made true.

**`WindowManager.close` is not the whole of closing.** `register` points
`onClose` at the manager, and for the gallery that is the whole story. In the
game it is not: `UiScreens.close` tells the server to stop sending a vendor's
stock and cancels a live trade, and `UiScreens.closeTopmost` repeats both for
Escape -- its own comment already anticipating *"a title-bar close button"*. An
X wired straight to the manager would shut the trade window without leaving the
trade, which is the exact bug spec 170 closed for Escape.

## Shape

**`src/ui/theme/theme.json`** gains a `windowClose` widget style. Its own five
states rather than a reuse of `window`'s: the window's `hover` and `pressed`
entries are read by nothing today (its paint only ever asks for `normal` or
`focused`), and giving them a second meaning is how two widgets come to share
one row and then disagree about it. `padding` is 0 -- the button *is* the icon
area -- and no new metric key is introduced, so the schema is untouched.

**`src/ui/widgets/window.ts`** gains a `WindowCloseButton`, and `UiWindow`
builds one only when `closable`.

```ts
class WindowCloseButton extends StyledWidget {
  constructor(private readonly owner: UiWindow);
  onGesture(gesture: Gesture): void;   // click -> owner.requestClose()
  onEvent(context: EventContext): void; // pointer down -> stopPropagation()
}

class UiWindow extends StyledWidget {
  readonly closeButton: WindowCloseButton | null;
  closeRect(context: LayoutContext): Rect; // zero-sized when not closable
}
```

Its geometry is derived rather than authored, from the two numbers that already
set the title bar: it is a square as tall as the body font, centred in the bar,
its right edge inset by the same `padding` the title's left edge is inset by.
On today's theme that is 10px square in a 14px bar, clearing the `heavy`
frame's 2px border on every side.

**`src/render/iso3d/world/ui-screens.ts`**: `registerWindow` re-points
`window.onClose` at `this.close(id)`. One line, and it is what makes the X, the
key that opened the window, and the mount's own calls the same close.

## Invariants tested

- A click on the X closes the window; `closable: false` builds no button at
  all, and `closeRect` is zero-sized for one.
- A press on the X does **not** arm a window drag: moving the pointer after it
  leaves the window where it was.
- A press on the bar *beside* the X still drags, and a drag that ends off the
  button does not close (the router's own cancel rule).
- The X hit-tests to itself across its whole rect, ahead of the window.
- The title is clipped before the button rather than running under it, and
  `minWidthFor` reserves the room -- so a window resized to its floor shows its
  whole name *and* its X.
- The button tracks the window: it stays in the top-right corner after a drag
  and after a resize.
- In the game, closing the shop with the X calls `onVendor('')` and closing a
  live trade cancels it -- the same side effects Escape already has.
- Nothing is drawn translucent, and no window golden gains a blend.

## Out of scope

- The chat log, the action bar, the selected-unit readout and the dialogue
  bubble. None is a `UiWindow` -- they are docked furniture with no title bar,
  nothing in the layout store, and nothing the player opened.
- The Play tab's settings popovers (view, day and night, player lights, retro
  filter, hike look, weather) and every `lil-gui` panel in the map editor, the
  sandboxes, the Studio tab and the SFX tab. They are not built on this
  framework and this spec does not reach them.
- Focusability. The X is not a tab stop: Escape is already the keyboard route,
  and a stop in every window's cycle for a key that exists is noise.
- Making it a finger-sized target. At 10 UI pixels it is about 22 CSS pixels on
  a phone, against `MIN_TAP_PX`'s 44 -- but so is every other piece of window
  chrome, including the 14-pixel title bar it sits in and the 7-pixel resize
  grip, so a close button alone big enough to tap would be the odd one out
  rather than the fix. Growing the chrome for touch is a change to the bar's
  own height and belongs in a spec about that.
- A close *sound* of its own. `ui.close` is emitted by whoever does the
  closing, which is now the same place for every route.
