# 197 — A crosshair for the point you are picking

## Problem

The pointer over the world never said anything. A hotbar press starts an *aim*
(spec 080) -- the shape of the blow is drawn on the ground and the game waits
for the left click that places it -- and what was left pointing at that decision
was the browser's arrow, drawn in whatever the desktop theme says, with its hot
point at a tip rather than at the place the blow lands. Hovering a body said
nothing either: the body lights up, but the pointer over it is the same pointer
as over empty grass. A game that renders its own numbers from a 5x7 table of `#`
because a webfont is a binary blob nobody can review should be able to say both
of those things in its own register.

So: two marks, drawn the way `pixel-font.ts` draws glyphs -- rows of `#`,
axis-aligned rects with `shape-rendering: crispEdges`, exact at whatever scale
they are asked for -- handed to CSS as data URIs with their hotspots named.

## Shape

Three states, and the arrow is what stands the rest of the time:

| Under the pointer | Cursor |
|---|---|
| A skill is armed | the **full** crosshair -- arms to the edge of the box |
| A body a click would act on | the **small** mark -- the four arm tips and the centre dot |
| A drop (spec 158) | the pointing hand, unchanged |
| Anything else | the page's own arrow |

`world/crosshair.ts`, pure, no DOM:

```ts
export type CrosshairArt = 'full' | 'small'
export const CROSSHAIR_SIDE: number       // 9 font px
export const CROSSHAIR_BOX: number        // 22 drawn px, margin included
export const CROSSHAIR_HOTSPOT: number    // the centre pixel's middle
export function crosshairRects(art?: CrosshairArt): readonly PixelRect[]
export function crosshairPath(art?: CrosshairArt): string
export function crosshairSvg(options?: { art?; scale?; fill?; outline? }): string
export function crosshairCursor(options?: CrosshairOptions): string
export function worldCursor(input: {
  aiming: boolean; overEnemy: boolean; overDrop: boolean
}): string
```

`view.ts` already set `canvas.style.cursor` from one rule; that line becomes
`worldCursor(...)`, with the hovered body resolved once and asked both
questions, so which cursor the world wears is one decision in a module a test
can reach rather than a chain of `if`s in the frame. What counts as a body is
`attackable`'s answer -- the same predicate the right-click attack order uses --
so the mark and what the button does cannot disagree.

## Invariants tested

- Both marks are square and symmetric about both axes, and the four pixels
  around the full crosshair's centre are dark -- a crosshair whose arms meet is
  a plus sign, and the gap is what lets the mark sit on what it points at.
- The small mark lights only pixels the full one lights, and fewer of them:
  arming a skill *extends* the mark, it never redraws it somewhere else.
- **Going from the small mark to the full one moves nothing**: same box, same
  hotspot, asserted in Node and again in the browser. A cursor image is placed
  by its hotspot, so two marks that disagreed would jump against each other on a
  key press mid-fight. (The arrow *does* jump when it hands over, its hot point
  being a tip where a crosshair's is a centre; that is accepted, because it
  happens on a hover the player chose to make.)
- The hotspot is inside the drawn box and within half a screen pixel of its
  middle: the click lands where the crosshair says.
- The drawn box is at most 32px square, the ceiling over which some engines
  refuse a cursor image outright, and both marks decode at that size in a real
  browser.
- Each cursor value is a `url(...)` with the hotspot pair and a keyword fallback
  behind it, so an engine that refuses SVG cursors still shows a crosshair.
- The precedence: an armed skill outranks a body and a drop alike, since its
  click places the aim rather than doing anything to what is underneath; a body
  outranks a drop; nothing under the pointer is the empty string.
- Every rect is inside the authored box, the fill and outline reach the SVG, and
  the SVG survives being percent-encoded into a `url()`.

## Out of scope

- Any change to what is aimed, what it costs or when it may be cast. This reads
  two booleans the game already decided and returns a string.
- A cursor for the right-click move order or the pickup order, and any change to
  the drop's pointing hand beyond who wins when both apply.
- A cursor for a *confirmed* aim: the question has been answered and the body is
  walking into range, so the pointer goes back to what is under it.
- Animation, and any second variant for out of range -- the range ring and the
  dimmed shape already say that on the ground.
