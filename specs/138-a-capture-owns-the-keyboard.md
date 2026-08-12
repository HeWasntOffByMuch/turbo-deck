# 138 — a capture owns the keyboard

## Problem

Two reports, one cause: **binding a key does nothing, and trying to bind one
breaks every other key.**

Spec 137 stopped a press from taking focus, because an open window holding the
arrow keys and Space was breaking the game. The keybinding capture was the one
thing in the interface that depended on that behaviour and nothing said so:
clicking a row's button armed the capture, and the key that followed reached the
screen *only* because the pressed button was still holding focus and the event
bubbled up through it. With focus cleared, keys are dispatched at the root, whose
path is itself, and `KeybindingsScreen.onEvent` is never called.

So the capture waits forever. And a waiting capture has `textEntry` pushed, which
swallows every key by design — so after one attempt at rebinding, nothing on the
keyboard works for the rest of the session. Escape does not save you either: the
mount gives Escape to the window list *before* routing, so it closes the options
window and leaves the capture armed and the context pushed with nothing left on
screen to pop it.

The gap that let this ship: every test of binding a key called `captureKey`
directly. Nothing tested the two events a player actually produces — a press,
then a key.

## Shape

### The mount asks the screen, rather than routing to focus

```ts
// src/render/iso3d/world/ui-screens.ts, first thing in handleKey
if (phase === 'down' && this.keybindings.capturing && this.keybindings.captureKey(code, mods)) {
  return true;
}
```

Routing a key means routing it to *focus*, and after spec 137 nothing is
focused. The keybinding screen is the one widget in the interface whose whole job
is to hear a key it was not given, so the mount — the one place that sees every
key — hands it over directly. This is the same shape as every other decision in
that file: who hears an input is the mount's business.

**Before Escape's list**, deliberately. A capture is the thing in front of you,
exactly like a drag: Escape has to call it off rather than close the window it
was opened in.

### A capture does not outlive its window

The options window can close without Escape — the title bar's cross, a second
press of `K`. So the frame check that already clears the tooltip and cancels a
carry when the bag closes gains a third line for the capture.

Three cleanups of the same shape now, and the shape is the rule: **anything that
holds a context or draws above the windows has to be cancelled when its window
goes away**, because none of them are inside the window they belong to.

## Invariants tested

- A press on a row's bind button followed by a key binds that key, driven through
  `handlePointer` and `handleKey` rather than by calling `captureKey`.
- After binding, `textEntry` is off the stack and an ordinary gameplay key
  reaches gameplay again.
- Escape while capturing cancels the capture, binds nothing, and leaves the
  options window open.
- A capture whose window closes any other way is cancelled by the next frame.
- In a browser (`scripts/preview-world.ts`): the click, the key, the saved
  profile, that the keyboard works afterwards, and the row's Reset putting it
  back.

## Out of scope

- **Restoring focus-follows-press.** It is what spec 137 removed and why.
- **A key to clear a binding.** `unbindCapturing` exists, is reachable from
  nothing, and predates this; wiring it is a decision about what Delete means
  while capturing rather than a bug fix.
