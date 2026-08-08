# 093 — Controls that work on a phone

## Problem

The play view is bound to a three-button mouse. The order that runs the game is
a right-click (spec 070), the answer to an aim is a left-click (spec 080), and
the zoom is a wheel (spec 042). A touch device has none of those: a tap arrives
as `button 0`, so on a phone the only reachable action today is "confirm an aim
that cannot be started", the wheel never fires, and the browser's own pinch and
pull-to-refresh eat the gestures before the canvas sees them.

This gives touch the three things it needs to play: a tap that carries the
orders, a pinch that zooms, and a way to get the browser chrome out of the way.
It does not restyle anything for a small screen — the HUD, the hotbar and the
panels are the size they are.

## Shape

### One gesture, so the tap is answered by whatever is being asked

A mouse has two buttons and spec 080 spends both: right orders, left answers a
pending aim. Touch has one gesture and has to carry both, so the rule is
*contextual rather than modal* — a tap means "yes, there" to whatever question
is currently on screen:

| State | A tap does |
|---|---|
| No aim pending | Exactly the right-click path: attack the body under it, else move to the ground under it (and withdraw from any blow, spec 090) |
| Ground aim pending | Confirms it at the tapped point — the left-click path |
| Unit aim pending, tap found a body | Confirms it on that body — the left-click path |
| Unit aim pending, tap found grass | **Cancels the aim** — the right-click "no" |

The last row is the one place touch and mouse deliberately disagree. A mouse
*ignores* a unit-aim click that missed, because the other button is right there
to back out with and throwing the aim away would punish a near miss. On touch
there is no other button, so ignoring it would make a unit-gesture aim a trap
with no way out but reloading the page. Tapping the thing the aim asked for
confirms; tapping anywhere else means no.

Nothing about this is a new rule about the game — it is a second route into
`confirmAim()` and the existing right-click body, chosen by what is pending.
Mouse behaviour is untouched.

### The recogniser is pure

```ts
// src/render/iso3d/world/touch.ts
export interface TouchSample { readonly id: number; readonly x: number; readonly y: number; readonly t: number; }
export type TouchGesture =
  | { readonly kind: 'tap'; readonly x: number; readonly y: number }
  | { readonly kind: 'pinch'; readonly ratio: number };

export class TouchGestures {
  down(sample: TouchSample): void;
  move(sample: TouchSample): TouchGesture | null;   // a pinch, while two are down
  up(sample: TouchSample): TouchGesture | null;     // a tap, if it stayed one
  cancel(id: number): void;
  clear(): void;
  get active(): number;
}
```

Time arrives as `event.timeStamp` on the sample rather than being read from a
clock, which is the whole reason this is testable in Node: a tap is a fact about
a sequence of timed samples, not about when the test ran. It goes in
`PURE_RENDER` alongside `intent.ts`, and `view.ts` keeps the listeners.

A tap is one pointer, up within `TAP_MAX_MS` of its own down and never further
than `TAP_SLOP_PX` from where it started. A second finger landing ends any tap
in progress — those two fingers are a pinch, and neither of them may also post
an order when it lifts.

### Pinch reuses the wheel's band, not a second set of numbers

```ts
// src/render/iso3d/view-settings.ts
export function pinchViewHalfWidth(current: number, ratio: number): number;
// src/render/iso3d/view-controls.ts
interface ViewControls { pinchZoom(ratio: number): void; }
```

Fingers spreading (`ratio > 1`) narrows the span — the pinch is direct
manipulation, so the ground under the fingers gets bigger as they separate.
`current / ratio`, clamped to the same `MIN/MAX_VIEW_HALF_WIDTH` the wheel and
the slider are held to, so no gesture can frame outside the band. `pinchZoom`
writes the same slider `attachWheelZoom` writes, because the slider is the
state (spec 034) — the panel and the pinch cannot disagree about the zoom.

### Fullscreen belongs to the shell, not the play view

The button sits in the tab bar in `main.ts`, because going fullscreen is a fact
about the window rather than about the game, and because the tab bar is the only
furniture every tab shares. It is only built when the Fullscreen API exists, and
only shown on a coarse pointer, so the desktop bar keeps its four buttons.

```ts
// src/render/iso3d/fullscreen.ts
export function createFullscreenButton(target: HTMLElement): HTMLElement | null;
```

Entering asks for `landscape` from the Screen Orientation API and *ignores the
rejection*. Locking orientation is only permitted while fullscreen and only on
mobile; every desktop browser and every iPhone rejects the promise, and an
unhandled rejection in the console is a worse outcome than a phone the player
turns themselves.

iPhone Safari still has no element fullscreen (iPad has had it since 16.4), so
on that one device the button does not appear and the fallback is the home-screen
install — hence `mobile-web-app-capable` in the head, which is the only real
fullscreen that platform offers.

### The page has to stop fighting the canvas

`index.html` grows the viewport meta it never had (`viewport-fit=cover` for the
notch), and `#app` gets `touch-action:none` and `overscroll-behavior:none`. Both
are load-bearing rather than polish: without `touch-action` the browser claims
the pinch and the pan before a `pointermove` is delivered, and without
`overscroll-behavior` a downward drag is pull-to-refresh. The corner controls
inset by `env(safe-area-inset-*)` so a notch does not sit on the cog.

## Invariants tested

- A down/up pair inside the slop and the time budget yields one tap, at the
  position the finger went **down** — that is the point that was aimed at.
- A pointer that travels past `TAP_SLOP_PX` yields no tap, and one held past
  `TAP_MAX_MS` yields no tap, whichever way it ends.
- A second finger landing suppresses the tap for **both** fingers: neither the
  first nor the second posts one when it lifts, and lifting back to one finger
  does not re-arm a tap.
- Two fingers moving report a pinch whose ratio is the change since the *last*
  report, so consecutive moves compose multiplicatively to the total spread —
  a ratio sampled against the gesture's start would apply the same spread twice.
- A pinch from a degenerate (zero) separation reports no gesture rather than a
  non-finite ratio.
- `cancel` and `clear` drop pointers without emitting anything, and a cancelled
  pointer cannot later produce a tap.
- `pinchViewHalfWidth` inverts the ratio (spreading zooms in), clamps at both
  ends, round-trips a ratio and its reciprocal inside the band, and falls back
  to the default span on a non-finite input — the same contract `zoomSpan` has.

## Out of scope

- **The map editor.** Its input is a three-button drag model — orbit, track and
  paint (spec 049) — and one gesture cannot carry three drags. It keeps its
  mouse bindings and gets nothing here.
- The two tuning sandboxes. They inherit `pinchZoom` on the interface because
  they share `createViewControls`, but nothing binds a gesture to them.
- Responsive layout. The HUD, hotbar and panels keep their desktop metrics; this
  spec is about which gestures reach the game, not how big anything is.
- Movement. There is no virtual joystick — tapping the ground is the move order,
  which is what the game was already built around; WASD stays a keyboard thing.
- Long-press, double-tap, two-finger pan or rotate. One tap and one pinch.
- Persisting the fullscreen state across a reload, which no panel here does.
