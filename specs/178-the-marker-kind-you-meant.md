# 178 — The marker kind you meant

## Problem

Reported after 176 and 177 had both landed, and it is the one that actually cost
somebody an afternoon:

> I was creating spawn markers and thought I was making small_spider spawners,
> because the dropdown is always visible.

The Markers folder is a five-button strip over a **Spawner monster** dropdown,
and the dropdown is live whatever is armed. So you pick `small_spider`, click,
and get `spawn` markers — a kind nothing in the game reads. The map saves
correctly, the server boots correctly, the arena is empty, and every step of it
looked right.

Three things line up to produce that, and each is defensible alone:

- **`spawn` and `spawner` differ by two letters** and sit in the same grid, one
  first and one last. Only the second one does anything.
- **The dropdown is always shown.** Deliberately (the note in `panel.ts` says
  so): the strip is two columns, and a control that appears and disappears under
  it shifts everything below every time you change your mind. True — but shown
  and *live* are different claims, and a live control under a strip reads as
  belonging to whatever is armed.
- **`spawn` was the default armed kind.** So the first marker anybody places is
  the inert one.

Underneath all three is a fact worth stating plainly: of the five kinds, **only
`spawner` has a reader anywhere.** `spawn`, `objective`, `campfire` and
`trigger` are written to the map, replicated to clients, and looked at by
nothing — sockets with nothing plugged into them. The panel presented all five
identically.

## Shape

Nothing about the document format moves. A marker kind is a byte on the wire
(`MapMarkerKindValue`) and a string in every saved map; renaming one would be a
migration. What changes is what the panel *says* and what it lets you touch.

```ts
/** `spawner` draws as MONSTER. Same split FENCE_STYLE_CHOICES already makes. */
export const MARKER_CHOICES = choices(MARKER_KINDS, { spawner: 'monster' });

/** What placing this kind actually does, in one line. */
export function markerKindEffect(kind: MapMarkerKind): string;
```

- **`spawner` is labelled MONSTER**, which ends the near-collision outright: the
  strip reads SPAWN / OBJECTIVE / CAMPFIRE / TRIGGER / MONSTER, and the dropdown
  under it is called **Monster**. Choosing a monster and pressing MONSTER is one
  gesture that says one thing.
- **The dropdown is disabled unless its own kind is armed.** Still shown — the
  layout argument stands — but dead, which is the part that was missing.
  Live-looking and inert is the worst of the three states.
- **A `Does` row** says what the armed kind does: `spawns the monster below`, or
  `nothing reads it yet`. The same rule the character sheet follows for a stat
  that changes nothing yet — say so in as many words rather than describe an
  effect that is not there.
- **`spawner` is the default armed kind**, so the first marker somebody places
  is the one with a reader.
- **Placing says what it placed**: `placed spawner-2: grazer`, or `placed
  spawn-1` for a kind with no label. The presence of the monster's name is the
  tell, on the frame the marker appears.

## Invariants tested

- `createEditorSettings().markerKind` is `spawner`.
- `MARKER_CHOICES` labels `spawner` as `monster`, and **no label is a prefix of
  another** — the property that `spawn`/`spawner` broke.
- `MARKER_CHOICES` still carries every stored kind, in `MARKER_KINDS` order:
  what the button says may change, what the map stores may not.
- `markerKindEffect` names the spawner's effect and says the other four are read
  by nothing — enumerated over `MARKER_KINDS`, so a kind that gains a reader
  fails this test until the line is updated.
- In a real browser (`scripts/probe-map-editor.ts`): the monster kind is armed
  with nobody choosing it; the Monster dropdown is enabled for it and
  **disabled** after arming `spawn`; the `Does` row says the right thing in both
  states; and placing reports `spawner-N: <monster>`.

The panel checks are in the probe rather than in Node because that is where they
mean anything — `panel.ts` is lil-gui and a DOM, and "the dropdown is disabled"
is a fact about the rendered row. Its rows are found by `.lil-controller` /
`.lil-name`: this build's lil-gui prefixes its classes, and the obvious
selectors match nothing at all, which a probe reports as every question about
the row failing.

## Out of scope

- **Giving the other four kinds readers.** `objective`, `campfire`, `trigger`
  and `spawn` stay as they are; this spec makes their inertness visible, it does
  not decide what they should become. A player spawn point in particular is a
  real feature and is not this change.
- **Removing them from the strip.** They are part of the document format and
  placing one is how a future system gets its data authored ahead of time.
- **Naming the monster on the billboard in the world.** A spawner draws as a red
  `M`; which monster it names is in the panel and in the status line, not over
  its head.
