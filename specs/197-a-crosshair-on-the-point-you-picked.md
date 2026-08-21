# 197 — A crosshair for the point you are picking

## Problem

A hotbar press starts an *aim* (spec 080): the shape of the blow is drawn on the
ground and the game waits for the left click that places it. What is left
pointing at that decision is the browser's arrow -- the one thing on screen that
belongs to the operating system rather than to this game, drawn in whatever the
desktop theme says, and the one mark whose tip is not obviously where the click
will land. A game that renders its own numbers in a 5x7 table of `#` because a
webfont is a binary blob nobody can review should not be aiming with the file
manager's pointer.

So: while an aim is pending, the canvas wears a pixel-art crosshair, authored
and rendered the way `pixel-font.ts` is -- rows of `#`, axis-aligned rects with
`shape-rendering: crispEdges`, exact at whatever scale it is asked for -- handed
to CSS as a data URI with its hotspot named.

## Shape

`world/crosshair.ts`, pure, no DOM:

```ts
const CROSSHAIR: readonly string[]        // 9x9, '#' for a lit pixel
export const CROSSHAIR_SIDE: number       // 9
export const CROSSHAIR_BOX: number        // 22 drawn px, margin included
export const CROSSHAIR_HOTSPOT: number    // the centre pixel's middle
export function crosshairRects(): readonly PixelRect[]
export function crosshairPath(): string
export function crosshairSvg(options?: { scale?; fill?; outline? }): string
export function crosshairCursor(options?: CrosshairOptions): string
export function worldCursor(input: { aiming: boolean; overDrop: boolean }): string
```

`view.ts` already sets `canvas.style.cursor` from one rule (the drop's pointer,
spec 158); that line becomes `worldCursor(...)`, so which cursor the world wears
is one decision in a module a test can reach rather than a chain of `if`s in the
frame.

## Invariants tested

- The art is square and symmetric about both axes, and the four pixels around
  its centre are dark -- a crosshair whose arms meet is a plus sign, and the gap
  is what lets the mark sit on what it points at.
- The centre pixel is lit, and the hotspot is inside the drawn box and within
  half a screen pixel of its middle: the click lands where the crosshair says.
- The drawn box is at most 32px square, which is the size ceiling some engines
  refuse a cursor image over.
- The cursor value is a `url(...)` with the hotspot pair and a keyword fallback
  behind it, so an engine that refuses SVG cursors still shows a crosshair.
- Aiming wins over the drop's pointer; no aim and no drop is the empty string,
  which is what the canvas had before either rule existed.
- Every rect is inside the authored box, the fill and outline reach the SVG, and
  the SVG survives being percent-encoded into a `url()`.

## Out of scope

- Any change to what is aimed, what it costs or when it may be cast. This reads
  one boolean the aim already decided and returns a string.
- A cursor for the attack order, the right-click move order or the pickup order,
  and any change to the drop's existing pointer beyond who wins when both apply.
- A cursor for a *confirmed* aim: the question has been answered and the body is
  walking into range, so the pointer goes back to being a pointer.
- Animation, and any second variant for out of range -- the range ring and the
  dimmed shape already say that on the ground.
