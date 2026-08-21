# 198 — A tab you can still reach

## Problem

**The character window's tab strip is inside the thing that scrolls it.**
`registerWindow` wraps every screen in one `ScrollView` around the *whole*
screen, so scrolling the skill tree scrolls the heading, the experience meter
and the tab headers along with it. The Skills tab is the tallest content in the
interface — six attribute columns of up to six skills each — so on the shipped
window the strip is not merely pushed up, it is clipped away entirely, and a
player who scrolled down to read a skill cannot get back to Attributes without
scrolling back to the top first. The tabs are the one part of a tabbed screen
that must never leave.

**And the same mistake from the other side: a tabbed screen with no scroller at
all is squashed.** The options window is registered unscrolled and neither
`OptionsScreen` nor `KeybindingsScreen` puts a scroller inside itself, so a
category with more rows than the window is tall goes through
`Linear.shareSpace`'s overflow branch — every row shrunk toward zero, no bar,
and the rows at the bottom unreachable rather than merely off screen.

The two are one bug: **whether a tabbed screen scrolls is decided by whoever
mounted it**, and neither of the two answers a mount can give keeps the strip
reachable. So the decision moves into the widget that owns the strip.

## Shape

### The rule

> A tab strip is never inside the thing it scrolls.

`TabPanel` scrolls its **own body**. Each tab's content is wrapped in a
`ScrollView` when the tab is built, and the strip is that scroller's *sibling*
rather than its content — so "the tabs cannot scroll away" is a fact about the
widget tree instead of a rule each screen has to remember.

```ts
class TabPanel extends Column {
  /** The active tab's scroller, or null before anything has been built. */
  get bodyScroller(): ScrollView | null;
  /** The visible body box — what a hit test against a tab's rows must be inside. */
  bodyViewport(): Rect;
  /** Scroll the active tab by wheel notches. Returns whether anything moved. */
  wheelBody(delta: number): boolean;
}
```

One scroller **per tab**, not one shared by the body, and that is spec 124's own
rule rather than a new one: content is built once and *kept*, so that a tab you
come back to still has what you left in it — and the comment that rule was
written under names "a scroll position" as one of the things nobody thinks of as
state. A shared scroller would clamp a long tab's offset against a short tab's
content the moment you switched, and the position would be gone.

The scroller is chromeless (`paintSelf` overridden away, the way `ChatLogView`
already does it), because `TabPanel.paintSelf` draws the panel box around the
body: two frames drawn from two widgets is a rectangle inside a rectangle.

### Nothing changes for a panel nobody bounded

`ScrollView` measures its content against `UNBOUNDED` and returns
`min(offered, wanted)`, so a `TabPanel` inside somebody else's scroller — offered
an unbounded height — still measures to its natural height and still scrolls
nothing. The panel becomes a scroller only when it is *given* a height, which is
what a window does. That is what makes this safe to put in the widget rather
than in three screens.

### The mount stops scrolling the sheet

`registerWindow('character', …, false)`, and `CharacterScreen` gives its
`TabPanel` `layoutGrow = 1`. The note that has been copied into three screens —
"no `layoutGrow` on the tabs, a Linear squashes children it cannot fit" — was
right for as long as the panel could not scroll, and is what has to be undone
now that it can: a panel that can be squeezed *and* scrolls is exactly what a
window wants. `OptionsScreen` gets the same line, which is what closes the
squashed-keybindings half.

The character window is registered with a `minSize` tall enough for the pinned
band plus a row of content, because pinning is what makes a window resizable
below its own chrome a thing that can happen: `shareSpace` starves a grower to
zero when the fixed children alone overflow, so at 40px the strip would vanish
along with the body.

### A wheel over the pinned band still scrolls

The wheel bubbles, so a notch over the body reaches the tab's scroller on its
own and a notch over the strip reaches `TabPanel` (which now scrolls the body
when the strip has no overflow of its own to spend it on). A notch over the
sheet's pinned heading is the one that has nothing above it — the panel is not
on that path — so `CharacterScreen` forwards it into `wheelBody`. Without that
line the window scrolls everywhere except its own top inch, which reads as a
broken wheel rather than as a pinned header.

### A hidden row is not hovered

`CharacterScreen.hintAt` walks laid-out rectangles, and a row scrolled out of
the body keeps its rect — above the viewport, under the pinned heading. So the
hit test is now gated on the point being inside `tabs.bodyViewport()`. This is
the same class of bug spec 147 fixed with `showing()`: a rect that is still
correct for a widget nobody can see.

## Invariants tested

- The strip's rect does not move when a tab's body is scrolled to its end, and
  every tab header stays inside the window (the mount, in Node).
- A `TabPanel` given a bounded height shorter than its content scrolls, and one
  offered an unbounded height does not — the second is what keeps every screen
  mounted inside a scroller behaving as it did.
- Each tab keeps its own scroll offset across a switch away and back.
- Selecting a tab whose content is short after one whose content was scrolled
  leaves the short one at the top.
- The character window's `minSize` fits the pinned band plus one skill row, so a
  theme that grows the heading fails in Node rather than on screen.
- A wheel over the sheet's pinned heading scrolls the active tab's body.
- `hintAt` answers nothing for a point over a row that has been scrolled out of
  the body, and still answers for the same row once it is scrolled back.
- The keybindings screen's rows are no longer squashed in a window too short for
  them: they keep their natural height and the body scrolls.

## Out of scope

- **Sticky headers in general.** Nothing gains "pin this widget to the top of
  whatever scroller it is in": the pinned band here is a *sibling* of the
  scrolled area, which is a layout fact rather than a per-frame correction, and
  a real sticky implementation needs paint order, an opaque band and an
  invalidation on every scroll.
- **The other windows.** The bag, the shop and the trade table stay wrapped by
  the mount's scroller; none of them has tabs, and nothing about them is
  unreachable.
- **Chevrons on an overflowing strip.** Still a drag or a wheel, as spec 124 left
  it.
- **Remembering a scroll offset across a session.** The layout store holds where
  a window is and how big; where a tab was scrolled to dies with the tab, as it
  always has.
