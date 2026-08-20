# 198 — A zoom you choose, and a cap that means something

## Problem

Three server constants answer one question — *what can the camera frame?* — and
all three are sized against `MAX_VIEW_HALF_WIDTH = 1400`, a zoom the game is not
going to be played at. The intended band is 320–420.

Run through the real `cameraFrustum` / `internalRenderSize`, worst case across
16:10, 16:9, 21:9, 32:9 and portrait windows:

| | sized for 1400 | sized for 420 |
|---|---|---|
| worst ground reach | 3107 u | **932 u** |
| `INTEREST_CHUNK_RADIUS` | 8 → 289 chunks | **3 → 49 chunks** |
| `MAP_CHUNK_REQUEST_RADIUS` | 6 → 169 chunks | **2 → 25 chunks** |
| `MAP_CHUNK_BURST` | 169 | **25** |

32:9 is the worst case in both rows, for the reason `INTEREST_CHUNK_RADIUS`
already documents: `internalRenderSize` trades height rather than capping the
aspect, so horizontal reach keeps growing with the window.

Resident terrain per player drops from 169 map chunks to 25 — at the ~10 ms a
cold chunk costs (spec 197), a cold window is a quarter-second of prefetch
rather than two and a half seconds. That is what makes `docs/infinite-map-plan.md`'s
bounded residency affordable, which is why this comes first: it re-sizes the
arithmetic every later phase is measured against, and it is a few lines.

**The viewport is not being blocked.** Capping the slider is a decision for
later; this spec only stops the *server* paying for a zoom nobody uses.

## Shape

### Two numbers, not one

```ts
// src/render/iso3d/view-settings.ts
export const SUPPORTED_MAX_VIEW_HALF_WIDTH = 420;  // what the server is sized off
export const MAX_VIEW_HALF_WIDTH = 1400;           // where the slider stops — unchanged
export const MIN_VIEW_HALF_WIDTH = 200;            // unchanged; going closer is free
```

`INTEREST_CHUNK_RADIUS` 8 → 3 and `MAP_CHUNK_REQUEST_RADIUS` 6 → 2 in
`src/server/config.ts`; `MAP_CHUNK_BURST` is already derived from the radius and
follows on its own. Capping for real later is making the two constants equal, and
every number moves with it.

**The server never learns the player's choice.** Per-connection interest sized to
what somebody is actually framing is 1.3× at best and would reopen the hole spec
072 closed on purpose: `decideChunkRequest` validates against the server's own
position precisely so a client cannot widen its read window by lying, and a
client-reported zoom is exactly such a claim.

### The setting

A row on the options window's Display page, beside interface scale and the
frame-time readout, persisted through `display-store.ts` — the versioned
document over an injected `StorageLike` that already holds both.
`DISPLAY_VERSION` goes to 3; a version 2 document reads as "no preference",
which is what the game shipped with.

Past `SUPPORTED_MAX_VIEW_HALF_WIDTH` the row marks itself a **dev setting**, and
the warning says what actually happens rather than only that it is unsupported:
*terrain and units beyond the supported view may not be loaded.* The symptom is
holes in the ground, and a warning that does not name it makes them look like a
bug.

`clampViewHalfWidth` stays the single funnel every path to the zoom goes
through, so the band is one constant and nothing can frame outside it.

### Why overshooting is safe

Three properties, and the second is the one that keeps a dev setting from being
a bandwidth surface:

- **It degrades visibly and harmlessly.** Ground past the guaranteed reach is a
  hole and bodies past it wink out. Nothing crashes; for a dev it draws the
  streaming boundary on screen.
- **A wide zoom cannot ask for more.** `MapChunkCache.wanted` is handed
  `MAP_CHUNK_REQUEST_RADIUS`, a constant — the zoom is not an input to it. Nor
  can it be made to work client-side: `decideChunkRequest` refuses past the same
  radius. True today by accident; asserted here on purpose.
- **Zooming closer is unconstrained.** A narrower view never needs data a wider
  one did not.

## Invariants tested

- **Both relationship tests re-point at the supported cap.**
  `interest.test.ts` and `map-radius.test.ts` assert the relationship rather than
  the numbers, and keep doing so against `SUPPORTED_MAX_VIEW_HALF_WIDTH` across
  every window shape they already cover.
- **The default zoom is inside the supported band.**
  `DEFAULT_VIEW_HALF_WIDTH <= SUPPORTED_MAX_VIEW_HALF_WIDTH`. Without it an
  ordinary configuration could ship visible holes while this spec describes them
  as dev-only.
- **The supported cap does not exceed the slider's.** They may be equal — that is
  what capping for real looks like — but a supported band wider than the slider
  is incoherent.
- **The request window does not read the zoom.** `wanted` returns the same
  request set at the narrowest zoom and the widest.
- **The burst still covers the whole request window**, which is the relationship
  spec 165 restored and `MAP_CHUNK_BURST` derives from.
- **A stored zoom round-trips**, an absent one reads as the default, and a
  corrupt document costs the default rather than throwing — the rule
  `display-store.ts` already holds for scale.

## Out of scope

- **Capping the slider at 420.** Deliberately not now; this spec makes it a
  one-line change when it is wanted.
- Per-connection interest sized to a player's own zoom. See above — it reopens a
  closed hole for 1.3×.
- Moving `MIN_VIEW_HALF_WIDTH`. Going closer is outside all of this arithmetic.
- The editor's own zoom band, which is separate and stays.
- Anything about residency. This spec only re-sizes the windows; specs 200-202
  are what make them bounded.
