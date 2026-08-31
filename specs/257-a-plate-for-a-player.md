# 257 — A plate for a player

## Problem

Every body in the game wears the same overhead bar: a 52px red sliver with a
guard track under it that only appears once the guard is dented. It was written
for a monster (spec 145) and a player got it by default, so the one body a
player looks at all session says nothing about *who* it is beyond a name that is
drawn for everybody except themselves.

Two facts a player already has are not on it. **Level** is replicated for every
player (`EntityField.Level`, sent since the delta encoder was written) and drawn
nowhere in the world. And **guard** is replicated as a fraction and hidden
whenever it is full, which is the resting state, so the row under the health bar
is empty for most of a fight.

The reference is the unit plate every ARPG of this shape ships: a level box, a
health row, a second row under it, all inside one frame.

## Shape

**`src/render/iso3d/world/player-plate.ts`** (new, pure -- no DOM, no three.js):

```ts
export const PLATE: {
  readonly border: number;   // the dark edge round the whole plate
  readonly padding: number;  // frame showing between the edge and the rows
  readonly levelWidth: number;
  readonly gap: number;      // the frame rule between rows, and beside the box
  readonly barWidth: number;
  readonly healthHeight: number;
  readonly guardHeight: number;
};
export const PLATE_WIDTH: number;   // derived from PLATE, never typed twice
export const PLATE_HEIGHT: number;
export const PLATE_LEVEL_HEIGHT: number;
export const PLATE_LEVEL_PX: number; // how big the level is set
```

**Neither row is subdivided.** The first cut marked the health row every
`healthPerSegment(maxHealth)` points and the guard row in quarters, on the
argument that an unmarked bar can only be read as "about half". Against this
game's health totals that argument does not survive contact: a fresh character
is around 40 health and marks every ten of it are three lines that tell a player
nothing they would ever act on, and the guard row's quarters are a fraction cut
into fractions. So the marks are **gone rather than switched off** -- with the
arithmetic that placed them, which is the rule spec 250 set when it took the
fixture shadows out: a socket with nothing plugged into it is what this repo
keeps rediscovering a hundred specs later.

**The level box holds the number and nothing else.** It carried a 1px ring in
the health fill's colour, which said what the fill beside it was already saying
and spent two pixels of a fifteen-pixel box on saying it -- and those two pixels
are the difference between a level a player can read over a body and one they
have to lean in for. `PLATE_LEVEL_PX` is what the box can hold without them: two
digits (`MAX_PLAYER_LEVEL` is 60) at a monospace advance of about 0.6em, which
is also the face the name above the plate is set in.

**`src/render/iso3d/world/hud.ts`** grows a second overhead shape. `barFor(id,
player)` builds the plate for a player and the bar spec 145 shipped for
everything else; a holder whose kind disagrees with what is asked for is rebuilt
rather than restyled, which cannot happen today (an entity id is a player or is
not, for its whole life) and costs one comparison to be sure of.

The plate carries `data-plate="player"` on its holder. Everything already hung
off these elements keeps working unchanged: `data-entity`, `data-self`,
`data-name`, `data-bar="health"`, `data-bar="guard"`, `data-bar="cast"`,
`data-bar="statuses"`, `data-status`, and the health track's first two children
being ghost-then-fill in that order, and nothing else.

Three things about the plate are decisions rather than layout:

- **The guard row is drawn whether or not it is dented.** For a monster the
  spec 147 rule stands -- a bar that is always full is a bar nobody reads -- but
  on a plate that row is part of the frame, and a frame with an empty-looking
  row in it says the body has no guard rather than that it has all of it.
- **The name is drawn for the local player too.** Spec 145 withheld it on the
  grounds that you know who you are. The plate is a nameplate, and a plate whose
  name is missing on exactly one body in the world is a plate with a hole in it.
- **The colours do not move.** Green for your own health and red for anybody
  else's is the one distinction the floating bar already makes, and the plate
  introduces no other.

`scripts/probe-health-flash.ts` learns about `data-plate="player"` for one
check: "a full guard bar was drawn" is a claim about the spec 147 rule, and the
plate is exempt from that rule by design, so a player plate would fail it on
every frame of every run.

## Invariants tested

- `PLATE_WIDTH` and `PLATE_HEIGHT` are the sum of the parts, so the DOM and the
  arithmetic cannot disagree about how wide a plate is.
- `PLATE_LEVEL_HEIGHT` is exactly the space the two rows occupy, so a level box
  cannot push the plate taller than `PLATE_HEIGHT` says it is.
- The level box is under a fifth of the plate: it is the label, not the subject.
- Two digits at `PLATE_LEVEL_PX` fit inside `PLATE.levelWidth`, and
  `PLATE_LEVEL_PX` fits inside `PLATE_LEVEL_HEIGHT` -- and is larger than the
  health row is tall, which is the floor it was raised to meet.

In a browser (`scripts/preview-unit-plate.ts`), against the real `createHud`:

- The plate measures `PLATE_WIDTH` x `PLATE_HEIGHT`, and both rows come out the
  heights they were given rather than being negotiated down by a flex parent.
- The level box draws `60` at `PLATE_LEVEL_PX` with **nothing around it** and no
  overflow -- both halves, because the absent ring is what bought the size.
- Neither row holds anything past its bands.
- A monster still wears spec 145's bar: no level box, no name, a 5px track.

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
