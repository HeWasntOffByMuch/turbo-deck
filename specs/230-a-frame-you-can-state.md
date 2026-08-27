# 230 — A frame you can state

## Problem

Spec 141 stopped trusting `(pointer: coarse)` because a browser is free to lie
about it, and asks four facts instead. Its third rule — touch anywhere plus a
short side under `HANDHELD_MAX_SHORT_SIDE` — is measurement rather than a claim,
and measurement cannot separate a phone in desktop-site mode from a **small
touchscreen desktop**: both report a hardware touch count, a fine primary
pointer and a frame around 450–620 CSS px.

A Steam Deck in SteamOS desktop mode is exactly that machine. Its panel is
1280x800, so Firefox's chrome plus any display scale or page zoom puts
`innerHeight` under 620, and the whole phone frame arrives on a device being
driven with a trackpad and a keyboard: five of the six tabs gone, and with one
tab left `showsTabButtons` draws no tab strip at all, so the Studio and the map
editor are not reachable from the page.

The threshold is not the thing to move. 620 was chosen against a real photograph
of a real phone, and raising it walks back into the bug spec 141 exists to fix —
there is no number that separates these two machines, because on the four facts
they are the same machine. What is missing is a way to *say* which one this is.

## Shape

```ts
// src/render/iso3d/device.ts — pure, beside `isHandheld`.

/** The frame a URL asked for, or null when it asked for nothing. */
export function frameOverride(search: string): boolean | null;
```

`?frame=desktop` forces the desktop frame, `?frame=phone` forces the compact
one, and anything else — absent, empty, misspelled — is `null` and the
measurement decides, exactly as it does today.

`isHandheldDevice()` becomes `frameOverride(location.search) ?? isHandheld(readDeviceFacts())`,
which is the one place worth putting it: every caller already goes through that
function, and spec 141's rule that the tab bar, the HUD and the fullscreen button
must get the same answer holds without any of them learning that an override
exists.

`isHandheld` and `readDeviceFacts` are untouched. An override is a person's
answer, not a fact about the hardware, and folding it into `DeviceFacts` would
make the device table a table of two different kinds of thing.

Both directions rather than the one that prompted it: forcing the compact frame
on a desktop is how the phone layout gets looked at without a phone in your hand,
which is a thing `preview-touch.ts` needs a whole CDP harness to do today.

## Invariants tested

- `?frame=desktop` is `false` and `?frame=phone` is `true`, whatever the facts
  underneath say — including on a device that answers every handheld rule.
- An absent, empty or unrecognised `frame` is `null`, so an unknown value costs
  the measurement rather than a frame; `?frame=` and `?frame=tablet` both defer.
- The value is read case-insensitively and trimmed, like `?perf`.
- Other parameters are not disturbed: `?seed=4&frame=desktop` still answers
  `false`, and `?seed=4` alone answers `null`.
- A handheld-PC row in the device table — touch, fine pointer, 1024x600 —
  answers `true` from the measurement, so the row records *why* the override
  exists rather than asserting the bug is gone.

## Out of scope

- **Persistence.** The override lives in the URL and nowhere else. The
  preferences that outlive a session (bindings, interface scale) are versioned
  documents in `src/ui/input/`, and this is decided at mount before any of that
  exists; a second source of truth for the device question is the shape of the
  bug spec 141 was written about.
- **Re-deciding on resize.** `isHandheldDevice` still answers once and caches
  (spec 094), so an override applies from the load that carried it. The tab
  strip is built once at mount, so nothing would see a later answer anyway.
- **Moving `HANDHELD_MAX_SHORT_SIDE`.** Argued against above.
- **A UI for it.** A control that changes the frame belongs in the options
  window with the interface scale, and wants the persistence this spec declines.
