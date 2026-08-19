# 186 — A status you can see

## Problem

Spec 147 built a progression system that is almost entirely status-driven:
thirty-six skills of which twenty-eight fire on a trigger, eighteen milestones,
fifteen synergies. Nearly all of them resolve into one of the twelve ids in
`sim/statuses.ts`.

**None of them is replicated.** `ServerMessageType` has twenty-two entries and
not one carries a status; `ReplicatedEntity` has id, kind, typeId, position,
facing, health, maxHealth, activity, activityUntilTick, level, name, turnRate,
poise, shield and shieldUntilTick, and no status list. `world/auras.ts` has said
so since spec 121 — *"no status is replicated ... there is no buff or debuff
list on the wire at all"* — and named the fix it could not make: *"the day a
status list is replicated, `aurasFor` gains a branch."*

So Flow builds and drains with nothing on screen; a Perception character marks a
target **Exposed for everybody** and no member of that everybody can see the
mark; a body that has Adapted to your bolt shrugs off 30% of it and looks
identical to one that has not. The mechanics are live, tested and invisible.

Spec 173 already solved this exact problem once, for the one state that did
reach a client. A poise break sets `activity: Stunned` and `activityUntilTick`,
both replicated, and `world/stun-icon.ts` turns them into a swirl over the head
with **no client state at all** — a pure function of two replicated fields and
the drawn tick. This spec puts statuses on the wire in the shape that function
already wanted, and draws them the same way.

## Shape

### Which statuses ride the wire (`src/server/data/status-visuals.ts`)

Not all twelve. The status map is where *"everything the progression needs to
remember between ticks"* goes, and some of what it remembers is bookkeeping
rather than a condition:

```ts
export interface StatusVisual {
  readonly id: string;
  /** Stable wire index. Append only -- a client on an older build reads by number. */
  readonly wire: number;
  readonly name: string;
  /** Which way it cuts, for colour. Never for a game outcome. */
  readonly kind: 'boon' | 'affliction';
  readonly icon: StatusIconId;
  readonly maxStacks: number;
}

export const STATUS_VISUALS: readonly StatusVisual[] = [ /* eight rows */ ];
export function visualFor(id: string): StatusVisual | null;
export function visualByWire(wire: number): StatusVisual | null;
```

Eight rows: `flow`, `momentum`, `prepared`, `attuned` (boons), `exposed`,
`vulnerable`, `sundered`, `adapted` (afflictions).

Four ids stay off deliberately, and the rule is one sentence: **the wire carries
the conditions somebody could point at, not the timers the sim keeps for
itself.** `recentlyHit` is a 0.2s internal window Perfect Exit reads;
`secondWind.spent` and `perfectExit.spent` are inverted — the status means the
thing is *not* available, and a mark meaning "you have used your comeback" is a
readout question rather than something to hang over a head; `inCombat` gates
resting and belongs to the refusal that explains it. A row here is a promise
that a player can act on the mark.

`adapted` is the one row that is not an id. Adaptation is per ability
(`adapt:bolt.arcane`), so it is **collapsed to one mark carrying the largest
stack count** any ability has on that body. A mark over a head cannot say *which*
ability anyway, and what it honestly means — "this body is learning to shrug
something off" — is true of the collapsed form.

`magnitude` does not ride. It is the size of the effect, and the mark says
*that* a body is Exposed rather than by how much, on the same argument that made
poise a fraction: the only question the picture asks is whether it is there.

### The wire (`net/protocol.ts`, `net/messages.ts`, `net/delta.ts`)

A tenth entity field, beside the nine already there:

```ts
Statuses: 1 << 9,
```

Payload, when the bit is set: `u8 count`, then per status `u8 wire`,
`u8 stacks`, `u32 expiresAtTick`. Six bytes each, at most eight of them, and
only in the deltas where the set actually changed.

**An absolute expiry tick, never a remaining count** — the same choice
`activityUntilTick` and `shieldUntilTick` already made, and the thing that makes
the drawing stateless: every client watching a body agrees on when its Flow ends
without anybody having had to watch it start.

`ReplicatedEntity` gains `readonly statuses: readonly WireStatus[]`,
defaulting to empty for everything that has none — which is most bodies most of
the time.

`DeltaTracker` gains a `statuses` line in `KnownEntity` and marks the field dirty
when the packed list differs by wire id, stacks or expiry. Sorted by wire index
before packing, so a set that has not changed cannot look changed because the
server's map iterated in a different order.

### The mark (`src/render/iso3d/world/status-marks.ts`)

Pure, stateless, and deliberately shaped like `stun-icon.ts`:

```ts
export interface StatusMark {
  readonly id: string;
  readonly icon: StatusIconId;
  readonly kind: 'boon' | 'affliction';
  readonly stacks: number;
  /** 0..1. Full until the last few ticks, then thinning into the end. */
  readonly opacity: number;
}

export function statusMarks(
  statuses: readonly WireStatus[],
  drawnTick: number,
): readonly StatusMark[];
```

Three rules carried straight over from the swirl:

- **A stale entry is refused on read**, exactly as `statusOf` refuses one in the
  sim and `stunMark` refuses a passed window. A late delta cannot leave a mark
  up, so correctness never depends on a removal arriving.
- **The fade is a count of ticks, not a fraction of the window.** The function is
  handed an end and not a length, so "the last eight ticks" is expressible and
  "the last third" is not — and it is the better rule anyway, because Flow at
  1.2s and Exposed at 2s should tail off the same way.
- **No fade in.** A status arrives because something happened; a mark that ramps
  up over its first frames reads as unrelated to the blow that caused it.

Order is fixed by wire index rather than by arrival, for the reason `AURA_ORDER`
is fixed: two bodies carrying the same statuses always show the same picture, and
a mark never moves along the row because something else was applied.

### The mount (`world/hud.ts`, `world/icons.ts`)

A row of marks in the per-body holder the stun swirl already lives in, above the
name. Built once per body at a fixed width and shown/hidden, like the swirl —
a status is short and creating elements per application would churn the DOM on
every blow. Eight glyphs join `STUN_ICON` in `icons.ts`, drawn in the same
24x24 stroke vocabulary.

Colour is by `kind` and nothing else: boons in the guard blue the HUD already
uses for a bar that is holding, afflictions in the debuff rust from the VFX
palette. Never per status — eight colours over a head is a legend, not a
picture.

## Invariants tested

- **Round trip.** An entity with statuses encodes and decodes to the same list,
  including an empty one, and a client that never hears the field keeps `[]`.
- **Absolute ticks survive.** A status encoded at tick T and read at tick T+n
  reports the same `expiresAtTick`, not a shifted remainder.
- **A stale status draws nothing.** `statusMarks` with `drawnTick >= expiresAtTick`
  returns no mark for it, whatever the delta said — the same assertion
  `stun-icon.test.ts` makes about a passed window.
- **Statelessness.** Calling `statusMarks` twice with the same arguments returns
  the same answer, and a body first seen mid-status is marked (there is no
  observed start to miss).
- **Order is by wire index**, not by the order the server's map happened to
  iterate.
- **The fade is a tick count.** A status with 8 ticks left is at full opacity; one
  with 4 is at half, whether its window was 30 ticks or 300.
- **Only the eight visible ids ride.** An entity carrying `recentlyHit`,
  `inCombat`, `secondWind.spent` and `perfectExit.spent` and nothing else sends
  no status field at all.
- **`adapted` collapses.** A body with three adaptation entries sends one mark
  carrying the largest stack count.
- **The delta stays a delta.** A body whose statuses have not changed does not
  set the field; refreshing a status to a new expiry does.
- **Presentation only.** `presentation-only.test.ts` runs the same seed and
  inputs with the marks driven and without, and the authoritative state is
  identical.
- **It shows something with no build at all.** Almost every row needs a
  milestone behind it, so a fresh character could have gone on seeing an empty
  row forever with nobody noticing the wire was wrong. `Vulnerable` is written
  on *commit*, for anybody who swings at anything, and a test asserts a mark
  appears from one ordinary swing.

## The developer path

`admin:triggerEvent 'status' x y <radius>` puts every visible row on every body
in range for ten seconds, in the same register as spec 158's `'drop'` and
`'reveal'`. It exists because the rows are milestone-gated, and the alternative
to it is levelling a Perception character every time somebody wants to look at
the marks — the same argument the action bar's `?slots=` makes about a bar that
is empty by design.

It writes only into `statuses`, so it can no more change an outcome than the
real thing can: every row is read by the sim through the same `statusOf`, and
what a demo Exposed does to a blow is exactly what a real one does. It draws
nothing from `state.rng`, so triggering one cannot shift a roll.

## Out of scope

- **Mounting the aura system.** `aurasFor` now *can* be fed — its `statuses`
  parameter exists for exactly this — but starting and stopping particle rings
  through `AuraTracker` is a budget question and a teardown question, and this
  spec is the wire plus the cheap mark. Finding 02 of the audit stays open, one
  step shorter.
- **The character sheet.** Live statuses do not appear on it here. The sheet
  answers "what have I built"; this answers "what is true right now".
- **Magnitude, and naming a synergy.** Neither rides. Spec 147's rule that the
  fifteen pairs are never named on the sheet is not weakened by a mark that says
  a body is Exposed without saying what made it so.
- **The other findings of the audit.** `weakPoint`'s missing bit, the undrawn
  shield, the hardcoded `damageType`, `attackMissed` and the `.impact` debug
  disc are each their own change.
