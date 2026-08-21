# 200 — A crosshair for the point you are picking

## Problem

The pointer over the world never said anything. A hotbar press starts an *aim*
(spec 080) -- the shape of the blow is drawn on the ground and the game waits
for the left click that places it -- and what was left pointing at that decision
was the browser's arrow, drawn in whatever the desktop theme says, with its hot
point at a tip rather than at the place the blow lands. Hovering a body said
nothing either. A game that renders its own numbers from a 5x7 table of `#`
because a webfont is a binary blob nobody can review should be able to say both
of those things in its own register.

So: two marks, drawn the way `pixel-font.ts` draws glyphs -- rows of `#`,
axis-aligned rects with `shape-rendering: crispEdges`, exact at whatever scale
they are asked for.

## The thing this got wrong twice

The first two cuts made the marks **CSS cursor images**: a
`cursor: url("data:image/svg+xml,...") 11 11, crosshair`. On a real machine the
mark landed four to seven CSS pixels up and left of the point it was marking --
about *half* the hotspot -- with the pointer provably stationary, and corrected
itself on the next mouse move.

It took a phone recording of the screen to see at all: neither a headless
screenshot nor OBS captures what the compositor draws for a cursor, and the
first attempt to fix it (assigning the style inside the input event rather than
in the animation frame, on the theory that the hit test had not re-run) changed
nothing. Measured against the arrow's own hot point across the swap, with the
camera shake registered out and the pointer confirmed still for ten frames
either side, the offset was `(-6.0, -6.8)` CSS px -- which is what a hotspot
scaled by something near 1.5 while its image is not would produce.

A hotspot is applied between the style and the glass by a layer that also has a
device scale and a page zoom to apply, and CSS has no way to ask what it did.
So the marks are **drawn in the page** at the pointer position the game already
tracks, with `cursor: none` under them. There is no hotspot to be right about,
and -- for the first time -- a probe can measure where the mark went.

## Shape

Three states, and the arrow is what stands the rest of the time:

| Under the pointer | Drawn mark | Canvas cursor |
|---|---|---|
| A skill is armed | the **full** crosshair | `none` |
| A body a click would act on | the **small** mark | `none` |
| A drop (spec 158) | — | `pointer` |
| Anything else, or the interface | — | the page's arrow |

`world/crosshair.ts`, pure, no DOM:

```ts
export type CrosshairArt = 'full' | 'small'
export const CROSSHAIR_SIDE: number      // 9 font px
export const CROSSHAIR_BOX: number       // 22 drawn px, margin included
export const CROSSHAIR_CENTRE: number    // what a caller offsets by to centre it
export function crosshairRects(art?: CrosshairArt): readonly PixelRect[]
export function crosshairSvg(options?: { art?; scale?; fill?; outline? }): string
export function worldMark(input: WorldPointerInput): CrosshairArt | null
export function worldCursor(input: WorldPointerInput): string
```

`hud.setCrosshair(mark, at)` draws it: one sized holder moved by `transform`,
both marks built once and swapped by `display`. `view.ts` calls `applyCursor`
from the frame *and* from every pointer and key event, so the mark keeps up with
the pointer that moved it rather than waiting for the next frame.

## Invariants tested

- Both marks are square and symmetric about both axes, and the four pixels
  around the full crosshair's centre are dark -- a crosshair whose arms meet is
  a plus sign, and the gap is what lets the mark sit on what it points at.
- The small mark lights only pixels the full one lights, and fewer of them:
  arming a skill *extends* the mark, it never redraws it somewhere else.
- The drawn box is centred on the pointer to within half a pixel, which is what
  the box being even and the art's middle pixel straddling it costs. Asserted in
  Node as arithmetic, and **measured in a browser** off the element's own
  rectangle: on the pointer within 1px while hovering a body, when a skill is
  armed over it, after arming by clicking a slot, and while the pointer moves.
- `worldCursor` says `none` exactly where `worldMark` draws something. A hidden
  cursor with nothing drawn is a pointer the player cannot find, and that pairing
  is the one way this can fail badly.
- The precedence: an armed skill outranks a body and a drop alike, since its
  click places the aim rather than doing anything to what is underneath; a body
  outranks a drop; nothing under the pointer draws no mark.
- Nothing is drawn while the pointer is over the interface or off the canvas --
  `cursor` is already null there -- so a button keeps the arrow that says it is a
  button, and no hidden cursor is ever left over a window.

## Out of scope

- Any change to what is aimed, what it costs or when it may be cast. This reads
  two booleans the game already decided and draws.
- A mark for the right-click move order or the pickup order, and any change to
  the drop's pointing hand beyond who wins when both apply.
- A mark for a *confirmed* aim: the question has been answered and the body is
  walking into range, so the pointer goes back to what is under it.
- Animation, and any second variant for out of range -- the range ring and the
  dimmed shape already say that on the ground.
- Chasing the last frame of latency. An OS cursor is composited at pointer rate
  and a page element is not; placing the mark from the pointer event rather than
  from the frame is as close as a page gets.
