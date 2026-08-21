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

So: the canvas wears a pixel-art crosshair, authored and rendered the way
`pixel-font.ts` is -- rows of `#`, axis-aligned rects with
`shape-rendering: crispEdges`, exact at whatever scale it is asked for -- handed
to CSS as a data URI with its hotspot named.

There are **two** marks and they are the same mark, which the first cut of this
got wrong. A cursor image is placed by its hotspot, and an arrow's hotspot is
its *tip* while a crosshair's is its *centre* -- so showing the crosshair only
while aiming meant every press swapped one for the other, which leaves the click
point exactly where it was and moves everything the eye tracks, by about half
the mark. No hotspot value fixes that: centre is where a crosshair's hotspot has
to be, or it stops marking the point. What fixes it is never handing over from
the arrow, so the resting canvas wears the same crosshair with its arms
retracted to four tips and a centre dot -- same box, same hotspot -- and arming
a skill extends the arms and moves nothing.

## Shape

`world/crosshair.ts`, pure, no DOM:

```ts
const CROSSHAIR: readonly string[]        // 9x9, '#' for a lit pixel
export const CROSSHAIR_SIDE: number       // 9
export const CROSSHAIR_BOX: number        // 22 drawn px, margin included
export const CROSSHAIR_HOTSPOT: number    // the centre pixel's middle
export type CrosshairArt = 'aiming' | 'resting'
export function crosshairRects(art?: CrosshairArt): readonly PixelRect[]
export function crosshairPath(art?: CrosshairArt): string
export function crosshairSvg(options?: { art?; scale?; fill?; outline? }): string
export function crosshairCursor(options?: CrosshairOptions): string
export function worldCursor(input: { aiming: boolean; overDrop: boolean }): string
```

`view.ts` already sets `canvas.style.cursor` from one rule (the drop's pointer,
spec 158); that line becomes `worldCursor(...)`, so which cursor the world wears
is one decision in a module a test can reach rather than a chain of `if`s in the
frame.

## Invariants tested

- Both marks are square and symmetric about both axes, and the four pixels
  around the crosshair's centre are dark -- a crosshair whose arms meet is a
  plus sign, and the gap is what lets the mark sit on what it points at.
- The resting mark lights only pixels the crosshair also lights, and fewer of
  them: arming a skill *extends* the mark, it never redraws it elsewhere, and
  the thing on screen the whole time a player walks around is the quieter one.
- The two cursors declare the same box and the same hotspot, so swapping one
  for the other cannot shift the mark by a pixel. This is the reason the pair
  exists, and it is asserted in Node and again in the browser.
- The centre pixel is lit, and the hotspot is inside the drawn box and within
  half a screen pixel of its middle: the click lands where the crosshair says.
- The drawn box is at most 32px square, which is the size ceiling some engines
  refuse a cursor image over.
- The cursor value is a `url(...)` with the hotspot pair and a keyword fallback
  behind it, so an engine that refuses SVG cursors still shows a crosshair.
- Aiming wins over the drop's pointer; no aim and no drop is the resting mark,
  never the OS arrow.
- Every rect is inside the authored box, the fill and outline reach the SVG, and
  the SVG survives being percent-encoded into a `url()`.

## Out of scope

- Any change to what is aimed, what it costs or when it may be cast. This reads
  one boolean the aim already decided and returns a string.
- A cursor for the attack order, the right-click move order or the pickup order.
  The drop's pointing hand (spec 158) stays, and stays a hand-over: it is an
  *affordance* saying the thing under the pointer can be clicked at all, and it
  costs its few pixels of apparent movement on a hover the player chose to make
  rather than on a key press in the middle of a fight.
- A cursor for a *confirmed* aim: the question has been answered and the body is
  walking into range, so the pointer goes back to being a pointer.
- Animation, and any second variant for out of range -- the range ring and the
  dimmed shape already say that on the ground.
