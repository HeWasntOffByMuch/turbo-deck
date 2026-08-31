# 256 — A plate for a player

## Problem

Every body in the game wears the same overhead bar: a 52px red sliver with a
guard track under it that only appears once the guard is dented. It was written
for a monster (spec 145) and a player got it by default, so the one body a
player looks at all session says nothing about *who* it is beyond a name that is
drawn for everybody except themselves.

Three facts a player already has are not on it. **Level** is replicated for
every player (`EntityField.Level`, sent since the delta encoder was written) and
drawn nowhere in the world. **Guard** is replicated as a fraction and hidden
whenever it is full, which is the resting state, so the row under the health bar
is empty most of a fight. And a bar with no subdivisions on it can only be read
as a fraction -- "about half" -- when the number behind it is a quantity a
player is spending and being spent.

The reference is the unit plate every ARPG of this shape ships: a level box, a
health row cut into segments worth a fixed amount each, a second row under it,
all inside one frame.

## Shape

**`src/render/iso3d/world/player-plate.ts`** (new, pure -- no DOM, no three.js):

```ts
export const PLATE: {
  readonly border: number;   // the dark edge round the whole plate
  readonly padding: number;  // frame showing between the edge and the rows
  readonly gap: number;      // the frame rule between rows, and beside the box
  readonly levelWidth: number;
  readonly barWidth: number;
  readonly healthHeight: number;
  readonly guardHeight: number;
};
export const PLATE_WIDTH: number;   // derived from PLATE, never typed twice
export const PLATE_HEIGHT: number;
export const PLATE_LEVEL_HEIGHT: number;

export const HEALTH_PER_SEGMENT = 10;
export const MAX_SEGMENTS = 8;

export function healthPerSegment(maxHealth: number): number;
export function healthTicks(maxHealth: number): readonly number[]; // fractions in (0,1)
export const GUARD_TICKS: readonly number[];                       // quarters
```

`healthPerSegment` **doubles** rather than capping: the step opens at
`HEALTH_PER_SEGMENT` and doubles until the bar is cut into no more than
`MAX_SEGMENTS`. A cap on the *count* would leave a big pool showing seven even
ticks and one long remainder, which reads as a broken bar; doubling keeps every
segment the same width **and** worth a stated amount of health, so a tick still
means something on a level-60 body. That the step is always a power-of-two
multiple of ten is the price, and it is the cheap half.

The two rows are ticked on different terms, and that is forced rather than
chosen. Health is replicated as an absolute, so its ticks are absolute -- one
every `healthPerSegment(maxHealth)` points. **Guard is replicated as a fraction
and nothing else**, so the only honest subdivision of it is a fraction, and
`GUARD_TICKS` is quarters. Deriving an absolute from a fraction would be the
client inventing a number the server never sent.

**`src/render/iso3d/world/hud.ts`** grows a second overhead shape. `barFor(id,
player)` builds the plate for a player and the bar spec 145 shipped for
everything else; a holder whose kind disagrees with what is asked for is rebuilt
rather than restyled, which cannot happen today (an entity id is a player or is
not, for its whole life) and costs one comparison to be sure of.

The plate carries `data-plate="player"` on its holder. Everything already hung
off these elements keeps working unchanged: `data-entity`, `data-self`,
`data-name`, `data-bar="health"`, `data-bar="guard"`, `data-bar="cast"`,
`data-bar="statuses"`, `data-status`, and the health track's first two children
being ghost-then-fill in that order (the ticks are appended after them).

Three things about the plate are decisions rather than layout:

- **The guard row is drawn whether or not it is dented.** For a monster the
  spec 147 rule stands -- a bar that is always full is a bar nobody reads -- but
  on a plate that row is part of the frame, and a frame with an empty-looking
  row in it says the body has no guard rather than that it has all of it.
- **The name is drawn for the local player too.** Spec 145 withheld it on the
  grounds that you know who you are. The plate is a nameplate, and a plate whose
  name is missing on exactly one body in the world is a plate with a hole in it.
- **The colours do not move.** Green for your own health and red for anybody
  else's is the one distinction the floating bar already makes, and the level
  box takes the same colour as its own health fill rather than introducing a
  fourth.

`scripts/probe-health-flash.ts` learns about `data-plate="player"` for one
check: "a full guard bar was drawn" is a claim about the spec 147 rule, and the
plate is exempt from that rule by design, so a player plate would fail it on
every frame of every run.

## Invariants tested

- `PLATE_WIDTH` and `PLATE_HEIGHT` are the sum of the parts, so the DOM and the
  arithmetic cannot disagree about how wide a plate is.
- `healthPerSegment` never returns a step leaving more than `MAX_SEGMENTS`
  segments, and never returns one smaller than `HEALTH_PER_SEGMENT`.
- Every step it returns is a power-of-two multiple of `HEALTH_PER_SEGMENT`.
- `healthTicks` returns strictly increasing fractions, all strictly inside
  `(0, 1)` -- never a tick on either end of the bar.
- Consecutive ticks are evenly spaced, and the gap is exactly
  `healthPerSegment(max) / max`.
- A bar is never cut into more than `MAX_SEGMENTS`, at any max health from 1 to
  a level-60 body and beyond.
- Nonsense max health -- 0, negative, NaN, Infinity -- answers no ticks rather
  than throwing or looping.
- `GUARD_TICKS` is quarters, strictly inside `(0, 1)`.

## Out of scope

- **The lower row is guard, not a resource pool.** Resource is not on the wire
  per entity -- only the local player's own is in `ClientView` -- so a pool row
  would mean one thing over your own head and a different thing over everybody
  else's. Putting resource on the wire is a protocol change and wants its own
  spec.
- Monsters. Their bar is spec 145's, unchanged, including the guard rule.
- The player's own pool bars at the foot of the frame (spec 164), the cast bar
  and the swap bar, which keep their shapes and hang off the plate exactly as
  they hung off the bar.
- Any new colour. The plate is drawn in the ones the HUD already has.
