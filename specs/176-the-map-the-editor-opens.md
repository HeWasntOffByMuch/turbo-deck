# 176 — The map the editor opens

## Problem

Markers placed in the Map editor never reach the game, and the reason is not in
the marker code at all: **the editor has never opened the map the game plays.**

`createEditorView` builds its world with `bakeEditorMap(viewSeed())`, and
`viewSeed()` falls back to `Date.now() >>> 0`. So every session of the Map
editor opens a *freshly generated world from the clock* — a different one each
time — while the Play tab beside it imports `maps/arena.json?raw` and plays the
shipped arena, and the server boots from that same file. Place spawners, save,
copy the download over `maps/arena.json`, and either nothing you placed is there
or the whole world has been replaced by a stranger's.

Every part of saving works. The store round-trips markers, `serializeMap` writes
them, `parseMap` reads them, the autosave holds them across a refresh, growth
preserves them, and the eraser and the undo both do what they say. What is wrong
is one line upstream of all of it: the document being edited is not the document
being played. `maps/arena.json` today has ten spawners; a fresh editor opens
with none, and `arena_old.json` shows four more that were lost the last time
somebody resolved a three-megabyte merge by hand.

This was invisible for as long as the shipped map *was* the generated world —
`bake-map.ts` defaults to seed 1 and the arena was seed 1 with no parts, so the
two agreed by coincidence. Spec 165 grew the map: `arena.json` is now seed
292278629 with six grown parts, and the coincidence is gone. This is the same
failure as 165 one layer up — the map grew and the editor did not.

`CLAUDE.md` already documents the intended workflow: "regenerate it with
`npx tsx scripts/bake-map.ts`, **or edit it in the Map editor tab and save over
it**." The docs describe the feature; the code never had it.

## Shape

`src/render/iso3d/editor/map-source.ts` gains the shipped map and the choice
between the two sources. It stays the whole of the editor's relationship with
where a map comes from, so nothing above it has to decide.

```ts
/** Vite inlines the same module the Play tab plays (spec 072). */
import shippedMapText from '../../../../maps/arena.json?raw';

/** The name a save of the shipped map comes back as, so "save over it" is a copy. */
export const SHIPPED_MAP_NAME = 'arena.json';

export type EditorMapChoice = 'shipped' | 'generated';

/** `?map=generated` asks for a world from a seed; anything else is the shipped map. */
export function editorMapChoice(search: string): EditorMapChoice;

export interface OpenedMap {
  readonly document: MapDocument;
  readonly map: LoadedMap;
  /** The filename a save comes back as: what was opened. */
  readonly name: string;
  /** What the readout calls it. */
  readonly from: string;
}

/** What the editor opens: the shipped map, or a generated world for a seed. */
export function openEditorMap(search: string, seed: number): OpenedMap;
```

`bakeEditorMap(seed)` stays exactly as it is — a generated world is still worth
looking at before `bake-map.ts` commits one, and it is what the part and tier
harnesses drive.

Three consequences in `view.ts`, all small:

- `EditorScene` takes its opened map as a **required** constructor argument. It
  had a fallback to the generator, which is the one line that decided this, and
  a scene that cannot reach the generator cannot quietly re-open the wrong world.
- The download is named after **what was opened** rather than after the seed:
  `arena.json` for the shipped map, the file's own name after a load, and
  `map-<seed>.json` for a generated world. You get back the name you opened.
- The readout names the map being edited, beside the chunk and marker counts.

One marker fix travels with it, because it is the same complaint from the other
end: `placeMarker` returns `{ marker: null }` when the point is off the layer or
over a hole in it, and `view.ts` dropped that on the floor. It now says so in
the status line, the way the part tool already says "no part under the cursor".

## Invariants tested

- `editorMapChoice('')` is `'shipped'` — the default is the map the game plays,
  not a world from the clock.
- `editorMapChoice('?map=generated')` is `'generated'`, and `?seed=` alone does
  **not** switch sources: a seed is which generated world, not whether.
- `openEditorMap('', seed)` parses to a document byte-identical to
  `maps/arena.json` on disk — the file `src/server/world/map-file.ts` names as
  `DEFAULT_MAP_PATH` and the Play tab imports.
- The shipped map's markers survive the editor's own round trip: opened, then
  `store.toDocument()`, then `serializeMap`/`parseMap`, every marker still there
  with its kind, id, label and world position. This is the assertion the bug
  would have failed if the editor had ever been pointed at the real map.
- Placing a marker on the shipped map and re-emitting keeps the ten that were
  already in it and adds the one placed.
- `openEditorMap('', seed).name` is `arena.json`; `openEditorMap('?map=generated',
  seed).name` is `map-<seed>.json`.
- A generated world still bakes exactly as it did (the existing `bakeEditorMap`
  suite is unchanged and must stay green).

## Out of scope

- **Writing the file back.** A browser cannot overwrite a repo file, so saving
  is still a download you copy over `maps/arena.json`. Naming it `arena.json`
  makes that a copy rather than a rename; a dev-server write-back endpoint is a
  separate change with its own safety questions.
- **The three-megabyte diff.** `arena.json` is one JSON file, and a marker edit
  is a handful of lines buried in it — which is how four spawners were lost to a
  merge conflict. Splitting markers out of the chunk arrays into their own
  document would fix that and is a wire-format change; not here.
- **The autosave's size.** The slot now holds the shipped map (~3 MB), which
  Chrome accepts today and reports as `autosave failed: storage full` when it
  does not. Nothing in this spec changes that path.
- **A restored autosave's name.** The slot stores text and no name, so a restore
  keeps the name the editor would have opened with. Persisting the name is a
  second storage key for a third-order papercut.
- **Recovering the four lost spawners.** `arena_old.json` still has them; putting
  them back is a map edit, not a code change.
