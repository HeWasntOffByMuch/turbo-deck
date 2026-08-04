# 054 — Save, load and autosave

## Problem

Every edit so far lives in memory and dies on refresh. Eight specs of tooling
have built an editor whose work cannot leave the tab, which makes it a toy.

The format has been ready since spec 048 — `serializeMap` and `parseMap` are
tested, round-trip exactly, and produce a 0.62 MB document for the full world
with nav baked. What is missing is the three doors: a file out, a file in, and a
net under the whole thing.

## Shape

### Storage, behind a seam

```ts
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const AUTOSAVE_KEY = 'turbo-deck.editor.autosave';

function writeAutosave(storage: StorageLike, text: string): AutosaveResult;
function readAutosave(storage: StorageLike): MapDocument | null;
function clearAutosave(storage: StorageLike): void;
function mapFilename(doc: MapDocument): string;
```

`StorageLike` rather than reaching for `localStorage` directly, so every rule
about what is written and what happens when it fails is testable in Node against
a fake — including the case that actually bites, which is the quota.

**Quota failures are reported, not thrown.** A browser that refuses the write
(private mode, a full origin) must leave the editor working and say so, not take
the session down with it. `writeAutosave` returns `{ ok: false, reason }` and the
readout shows it.

**A corrupt autosave is discarded, not fatal.** `readAutosave` runs the stored
text through `parseMap` — the same validation a dropped file gets — and returns
null if it does not survive. A half-written slot from a killed tab cannot brick
the tab that opens next.

### Save

`serializeMap` → `Blob` → object URL → a click on a temporary anchor → revoke.
Named `map-<seed>.json`, so saving twice from the same world overwrites rather
than littering the downloads folder with numbered copies.

### Load

Two doors onto the same function, because the two habits are different: a **file
input** in the panel, and **drag-and-drop** anywhere on the canvas. Both read
text, run `parseMap`, and hand the document to the scene.

Loading **replaces the scene**: the terrain mesh, the prop field, the markers and
the nav overlay are all rebuilt, and the undo stack is cleared. Keeping history
across a load would let one Ctrl+Z restore a chunk from a map that is no longer
open — the one way this stack can produce a genuinely corrupt state.

A file that fails to parse changes nothing at all and reports why. That matters
more than it sounds: the failure mode to avoid is a half-loaded map, and the
whole-document parse makes that unrepresentable.

### Autosave

Every 30 seconds, and **only when something changed**. A revision counter ticks
on every stroke end, every undo and every load; the autosave compares it to the
revision it last wrote. An idle editor writes nothing, so the slot is not
rewritten a hundred times while a person reads the panel.

On mount, an autosave that parses is **restored automatically** — that is the
point of the feature, and a refresh that silently discarded your work would be
the bug it exists to prevent. There is a **Discard autosave** button beside it,
so a fresh generated world is always one click away rather than a trip through
devtools.

## Invariants tested

**Autosave slot**

- A document written and read back is the same document, through `parseMap`.
- A quota failure returns `{ ok: false }` with a reason and does not throw.
- Text that is not JSON, or is JSON of the wrong shape, reads back as null rather
  than throwing.
- An absent slot reads back as null.
- Clearing removes it.
- Writing is skipped when the revision has not moved, and happens when it has.

**Filename**

- Contains the seed, ends in `.json`, and is stable for the same document.

**Load**

- A document that parses replaces the map; one that does not leaves everything
  as it was and reports the error.
- Loading clears the undo stack.

**Round trip through the whole editor**

- Sculpt, scatter, place a marker, save, reload the text, and the reloaded map
  has the same heights, props and markers — the property the format's fixed-point
  test implies, asserted here end to end through the tools that produced it.

## Out of scope

- Multiple named save slots, or a map browser. One autosave and a file per map.
- Server-side storage of any kind. Static hosting, as the brief requires.
- Merging or diffing two maps.
- Migrating an older `version` on load. There is only version 1; the validator
  rejects anything else, which is the right behaviour until there is a second.
