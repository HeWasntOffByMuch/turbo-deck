# 141 — A phone that is detected as one

## Problem

Spec 140 built a phone layout and hung the whole of it on one media query.
`isCoarsePointer()` is `matchMedia('(pointer: coarse)')`, and a real Android
phone loading the deployed build answered **false**: six tab buttons across the
top of the world, seven tuning popovers in the corner, the developer readout
over the grass, the captioned desktop weapon column, and no fullscreen button —
the exact frame spec 140 exists to prevent, on the exact device it was written
for.

The photograph is unambiguous about which half failed. The window buttons spec
140 added are *there*, so the build is current; they are drawn captioned, which
is `hudLayout(false)`. Nothing about the layout is wrong. The device question is.

`(pointer: coarse)` describes the *primary* pointing device, and a browser is
free to say "fine" about a touchscreen — Chrome's "Desktop site" does exactly
that, deliberately, along with faking a ~980px layout viewport. A stylus, a
paired mouse and a few OEM builds do the same. Spec 093 chose that query when
the only thing riding on it was whether to offer a fullscreen button; spec 140
put six decisions on it without revisiting the choice, and one query that can
be wrong became six things that are.

This spec makes the question survive being lied to, and finishes the phone frame:
the weapon switch goes, and the fullscreen button comes back.

## Shape

### The device question, as arithmetic over facts

```ts
// src/render/iso3d/device.ts — pure.
export interface DeviceFacts {
  /** `(pointer: coarse)` — the *primary* pointer is a finger. */
  readonly coarsePointer: boolean;
  /** `(any-pointer: coarse)` — *some* pointer is a finger. */
  readonly anyCoarsePointer: boolean;
  /** `navigator.maxTouchPoints`. Zero on a machine with no touchscreen. */
  readonly maxTouchPoints: number;
  /** The window, CSS px. Only its shorter side is read. */
  readonly viewport: { readonly width: number; readonly height: number };
}

/** The largest short side, CSS px, that a touch device is still handheld at. */
export const HANDHELD_MAX_SHORT_SIDE = 620;

export function isHandheld(facts: DeviceFacts): boolean;
export function readDeviceFacts(): DeviceFacts;   // the one impure line
```

Three rules, in order:

1. **No touch anywhere, not handheld.** `maxTouchPoints === 0 && !anyCoarsePointer`
   is a desktop, whatever else is true. This is the rule that keeps a narrow
   browser window on a laptop out of the phone layout — spec 094's "a phone does
   not become a desktop" still holds, from the other end.
2. **A coarse *primary* pointer is handheld.** The old rule, kept, because when
   it is true it is right.
3. **Otherwise, touch plus a small frame is handheld.** `maxTouchPoints > 0` and
   `min(width, height) <= HANDHELD_MAX_SHORT_SIDE`. This is the rule that catches
   the photograph: desktop-site mode keeps `maxTouchPoints` honest — it is a
   hardware count, and nothing in Chrome fakes it — while lying about the pointer
   and inflating the viewport to ~980 CSS px. A phone held sideways is still only
   ~450 CSS px tall in that mode, so the *short* side gives it away.

The short side rather than the width, so the answer does not change when the
phone is turned over — which is what lets this still be **decided once, at mount,
with no resize listener**, exactly as spec 094 wanted. 620 clears a phone in
either orientation and an iPad's 768 short side by enough to be a decision rather
than a coincidence; a tablet that wants the compact frame gets it from rule 2,
which is true on every tablet that has not been told to lie.

`isCoarsePointer` is deleted rather than kept beside this. Two device questions
with different answers is the bug this spec is about, and every one of its five
callers wanted "is this a phone" rather than "what did the media query say".

### The frame it finishes

```ts
// src/render/iso3d/world/hud-layout.ts
export interface HudLayout {
  // ...as before, plus:
  /** Whether the weapon switch is drawn at all (spec 141). */
  readonly showsWeaponSwitch: boolean;
}
```

False on a phone. It is three permanent buttons spending the bottom-left corner
on a choice a player makes rarely, and both windows that can make it — the bag
and the sheet — are one tap away since spec 140. Nothing is lost that was not
already reachable; a corner is gained.

The fullscreen button stays, and is the *only* thing in the tab bar on a phone.
It already existed and already worked; it was invisible because
`createFullscreenButton` returned `null` on the same failed query. It moves to
`isHandheld` with everything else.

### It is tested where it broke

The pure rule takes a `DeviceFacts` and returns a boolean, so **every device in
the table below is a test** rather than a thing somebody has to hold:

| device | coarse | any-coarse | touch pts | viewport | handheld |
|---|---|---|---|---|---|
| desktop, mouse | ✗ | ✗ | 0 | 1920×1080 | ✗ |
| desktop, narrow window | ✗ | ✗ | 0 | 500×900 | ✗ |
| phone, landscape | ✓ | ✓ | 5 | 844×390 | ✓ |
| phone, portrait | ✓ | ✓ | 5 | 390×844 | ✓ |
| **phone, desktop-site mode** | **✗** | **✗** | **5** | **980×453** | **✓** |
| tablet | ✓ | ✓ | 5 | 1024×768 | ✓ |
| touchscreen laptop | ✗ | ✓ | 10 | 1920×1080 | ✗ |

The fifth row is the photograph. It is written down as a device rather than as a
quirk, because the thing that made this bug possible was that no row existed at
all — one boolean was asked one way and believed.

And the browser half asserts the frame rather than the flag: a phone-shaped
context with **touch emulation and a fine pointer** — desktop-site mode as far as
the page can tell — must still come up with no tab buttons, no tuning popovers,
no weapon switch, an undrawn readout and a fullscreen button. That is
`scripts/preview-touch.ts`'s second context, and it is the check that would have
caught this.

## Invariants tested

Pure, in Node:

- Every row of the table above, by name.
- A machine with no touch is never handheld, at any viewport — including one
  narrower than `HANDHELD_MAX_SHORT_SIDE`.
- A coarse primary pointer is handheld at any viewport, including a large one.
- The short side is what counts: a viewport and its transpose give the same
  answer, so turning the phone over never changes the layout.
- The threshold is a boundary, not a slope: exactly `HANDHELD_MAX_SHORT_SIDE` is
  handheld and one more is not.
- A zero or negative viewport does not throw and does not report handheld off a
  touchless device — a frame is measured before layout in more places than one.
- `hudLayout(true)` draws no weapon switch; `hudLayout(false)` does.
- The compact frame's sums still hold with the weapon row gone: the centred
  hotbar clears the window-button row, which is now the only corner row.

In a browser, because the flag being right and the frame being right are two
different claims:

- A phone context that reports a **fine** pointer and non-zero `maxTouchPoints`
  gets the compact frame: no tab buttons, no tuning popovers, no weapon switch,
  a readout that is written and not drawn, and exactly one fullscreen button.
- The three window buttons still open and close their windows there.

## Out of scope

- **A manual override.** No `?mobile=1`, no setting. The rule has a test table
  now; the answer to a device it gets wrong is a row, not a switch.
- **A resize listener.** Still decided once, at mount (spec 094). The short side
  is rotation-invariant, and toggling desktop-site mode reloads the page.
- **Portrait layout.** The compact HUD is still designed for landscape; a phone
  held upright gets the same furniture in a narrower frame.
- **Anything else in the tab bar.** The fullscreen button is the only control a
  phone gets, as spec 140 settled.
