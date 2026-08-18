# 177 — A save that reaches the file

## Problem

Spec 176 pointed the editor at the map the game plays. It did not close the
loop: **the editor still cannot save.** What it can do is hand you a download,
which is the first of four steps —

1. press Save to file,
2. find `arena.json` in `~/Downloads`,
3. copy it over `maps/arena.json`,
4. restart the server —

with nothing anywhere confirming that any of them happened. Miss one and the
symptom is that the game does not have what you placed, which is exactly what
"the editor did not save my markers" looks like. Every rule about saving a
marker can be green in Node and the arena can still be empty.

The autosave makes it worse rather than better. It says **"autosaved"**, and the
work survives a refresh, so it *looks* persistent. It is in `localStorage`; the
file on disk has not been touched. A word that reads as "saved" is doing the
opposite of its job.

Verified before writing this: the server half is sound. `maps/arena.json` edited
through the editor, copied into place, server restarted — a real client at
`?server` sees all thirteen monsters, the three new ones included. Nothing
between `spawnPointsFrom` and the wire is at fault. What is missing is a save
that lands.

## Shape

**In development the editor writes the file.** `POST /api/map?name=<file>` is
served by a Vite plugin that exists only under `vite serve`; a built page has no
such endpoint and keeps the download it always had.

`scripts/dev-map-write.ts` — the disk half, with the rules that matter pure:

```ts
/** Absolute path a requested name resolves to, or why it will not be written. */
export function resolveMapWrite(name: string, root?: string): MapWriteTarget | MapWriteRefusal;
/** Write over `maps/<name>`, atomically. Returns what to say about it. */
export function writeMapFile(name: string, text: string, root?: string): { ok: boolean; detail: string };
export function mapWritePlugin(root?: string): Plugin;   // apply: 'serve'
```

`src/render/iso3d/editor/map-write.ts` — the browser half, taking its `fetch`:

```ts
export type MapWriteKind = 'written' | 'unavailable' | 'refused' | 'offline';
export async function writeMapToDisk(fetchLike: FetchLike, name: string, text: string): Promise<MapWriteResult>;
```

Four kinds rather than ok/failed, because they have four different fixes, and a
single "save failed" sends you looking in the wrong place — which is the failure
this spec is about. `unavailable` in particular is **not** an error: it is a
built page saying "use the download", in as many words.

In the editor: a `Save to maps/ (dev server)` button above `Save to file`, the
readout carrying `N edits not in maps/`, and the autosave renamed to what it
actually did — `autosaved to this browser -- not to maps/`.

One rule that is not obvious and was measured rather than reasoned. **The
write must not hot-reload the page.** `maps/arena.json` is a module in the graph
(`?raw`, imported by the Play tab and by the editor), so writing it makes Vite
reload the tab: three seconds after the click the page went blank and came back
on the Play tab, re-streaming 169 chunks, with the editor rebuilt from disk. For
a write the editor *made* that is precisely backwards — the newest copy of the
map is the one in the tab. So the plugin suppresses the reload for its own
writes and only for those, invalidating the module without announcing it, so a
later reload by hand still reads the new bytes. A change from `grow-map.ts` or a
checkout reloads as before.

A second thing 176 got wrong shows up here too: a **restored autosave from
before 176** holds a world generated from the clock, and 176 named its save
`arena.json` because that is what the editor opens. One click would then drop a
stranger's world on top of the map the server boots from, under the right
filename. The seed answers it — a restored slot whose seed is not the shipped
map's is named after itself and says so in the readout.

## Invariants tested

- `writeMapToDisk` tells the four outcomes apart: a 200 reports what was
  written; a 404 is `unavailable` and names the download as the remedy; a 4xx is
  `refused` and passes the server's own words through; a 5xx or a throwing
  `fetch` is `offline`.
- The name is URL-escaped, so a filename with a space or an `&` reaches the
  server intact.
- `resolveMapWrite` accepts a bare `.json` name and refuses: empty, `..`,
  `../package.json`, `sub/x.json`, an absolute path, a backslash escape, a
  non-`.json` name, a null byte, and `../maps-elsewhere/x.json` — the last by
  resolved parent, since a prefix test would pass it.
- `writeMapFile` writes a real document; refuses a truncated one **and leaves
  the previous file byte-identical**; refuses a path outside `maps/` with the
  file it aimed at unchanged.
- End to end in a browser (`scripts/probe-map-editor.ts`), against a real dev
  server: the editor says how many edits are not on disk, the button reports
  what it wrote, `maps/arena.json` actually changes, the file gains the placed
  marker and keeps every marker that was there, and the editor stops reporting
  edits off disk. The map is backed up and restored around it.
- Against the built bundle, the same button reports `no dev server here` and
  points at the download — the endpoint is dev-only by construction.

## Out of scope

- **Reloading the running game.** The write says "restart the server to load
  it", because that is what is true. Hot-swapping a live world is a much larger
  change than the one this spec is about.
- **Writing anywhere but `maps/`.** One directory, bare filenames, `.json` only.
- **Production.** `apply: 'serve'` — there is no write endpoint in a build, and
  the probe drives the shipped bundle to check exactly that.
- **The three-megabyte diff.** Still one JSON file; a marker edit is still a
  handful of lines buried in it. Unchanged from 176.
- **Recovering the four spawners lost to a merge in `arena_old.json`.** Still a
  map edit rather than a code change.
