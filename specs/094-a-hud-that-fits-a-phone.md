# 094 — A HUD that fits a phone

## Problem

Spec 093 gave touch the gestures it needs and then said, in as many words, that
responsive layout was out of scope: "the HUD, hotbar and panels keep their
desktop metrics". Driving the built page at 844×390 shows what that costs. The
diagnostic readout — tick, delta, seed, corrections — is a six-line panel pinned
to the top left of a frame that is 390px tall, and it is developer instrumentation
sitting on the world. The hotbar is eight 92px buttons, 741px of an 844px frame,
each one carrying a keyboard number that a phone has no key for. The weapon
switch is a captioned panel of 132px buttons naming items in text.

This is the layout pass: on a device driven by a finger, the readout is not
drawn, the hotbar is small squares with no key numbers, and the weapon switch is
icons. Desktop keeps every metric it has, including the numbers, because there
the keys are real.

## Shape

### One flag, and the metrics derived from it

The device question is already answered — `isCoarsePointer()` from spec 093 —
so nothing new decides *whether* to be compact. What is new is a pure table of
what compact *means*, so the sizes can be asserted in Node rather than measured
by eye on a phone:

```ts
// src/render/iso3d/world/hud-layout.ts
export const PHONE_LANDSCAPE = { width: 844, height: 390 };
/** The smallest side a tap target may have, in CSS px. */
export const MIN_TAP_PX = 44;

export interface HudLayout {
  readonly compact: boolean;
  readonly slot: { readonly width: number; readonly height: number };
  readonly slotGap: number;
  readonly slotFontPx: number;
  readonly showsKeyNumber: boolean;
  readonly showsReadout: boolean;
  readonly weapon: { readonly width: number; readonly height: number };
  readonly weaponGap: number;
  readonly weaponIconOnly: boolean;
  readonly weaponDirection: 'row' | 'column';
  readonly weaponIconPx: number;
  readonly edge: number;
}

export function hudLayout(compact: boolean): HudLayout;
/** The width of `count` boxes in a row, gaps included. */
export function stripWidth(box: { width: number }, gap: number, count: number): number;
```

The interesting part is not the numbers, it is that they are *checkable*: eight
compact slots plus the weapon row plus both margins have to fit inside 844px
with the hotbar still centred, and every compact button has to be at least
`MIN_TAP_PX` on its shortest side. Both are arithmetic, and both are exactly the
kind of thing that silently stops being true when somebody adds a ninth ability.

### The readout is not drawn, but it is still written

Compact does not delete the readout element; it hides it and keeps updating its
text. That is deliberate and worth stating, because it looks like a leftover:
`scripts/preview-touch.ts` and `scripts/preview-world.ts` read the sim's tick and
the target line out of `document.body.textContent`, which includes a
`display:none` subtree. The readout is the harness's clock, the same way
`data-entity` on a health bar is the harness's handle on a body (spec 063).
Removing it from the DOM would leave the touch harness with no way to tell "the
tap did nothing" from "the frame had not run yet", which is the failure spec 093
was debugged out of.

What the player loses with the panel is one line that was never debug output:
what the next tap will do while a skill is aimed (spec 080). That line moves to
its own small readout above the hotbar, shown only while something is aimed —
so an aim in progress still says how to answer it, and an idle frame is just the
world.

### Icons, as markup rather than a font

```ts
// src/render/iso3d/world/icons.ts
export function weaponIconSvg(abilityId: string, options?: { size?: number; color?: string }): string;
```

Inline SVG strings keyed by the *attack* the weapon names, which is what the
switch is choosing (spec 079). Not emoji: the switch would then look like
whatever font the phone happened to have, and half of them colour it. Not a
sprite sheet: nothing here may be fetched (spec 065). The paths draw with
`currentColor`, so the lit/unlit colouring the update loop already writes carries
the icon with it and no second code path decides which icon is selected.

## Invariants tested

- `hudLayout(false)` is today's desktop HUD: the readout is drawn, the slot keeps
  its key number, and the weapon switch is a named column.
- `hudLayout(true)` drops the readout and the key number, and its weapon switch
  is icon-only.
- Every compact tap target — hotbar slot and weapon button — is square and at
  least `MIN_TAP_PX` on a side.
- The compact hotbar is smaller than the desktop one, in both width and area.
- Eight compact slots, centred, clear the compact weapon row on the left and its
  mirror on the right, inside `PHONE_LANDSCAPE.width`. This is the assertion that
  fails when a ninth ability is added rather than when a screenshot is looked at.
- The compact bottom band (edge + slot height) is at most a quarter of
  `PHONE_LANDSCAPE.height`, so the HUD sits on the frame rather than in it.
- `weaponIconSvg` returns a distinct icon for every attack `WEAPON_SWITCH`
  offers — the regression guard for a weapon added to `data/items.ts` that
  quietly draws the fallback.
- An unknown ability id returns the fallback rather than empty markup, since a
  zero-width button cannot be pressed.
- The markup honours the requested size and paints in `currentColor` by default.

## Out of scope

- The two settings popovers and the map editor. The cog's panel is twenty rows
  deep and the editor is a three-button drag model (spec 093); both need their
  own pass and neither is on the critical path to playing.
- A resize listener. The layout is chosen once, from the pointer, not from the
  window — a phone does not become a desktop, and re-laying out the HUD mid-frame
  to chase a rotation is a bigger change than this.
- Icons for abilities. The hotbar keeps its names, shortened only by being set
  smaller; a glyph vocabulary for eight skills is a design exercise, not a
  layout pass.
- Moving anything into CSS classes or a stylesheet. The HUD is inline styles
  throughout and staying consistent is worth more here than saving the bytes.
