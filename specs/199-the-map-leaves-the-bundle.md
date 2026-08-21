# 199 — The map leaves the bundle

## Problem

`import mapText from 'maps/arena.json?raw'` appears three times — the Play tab
(`world/view.ts`), the map editor (`editor/map-source.ts`) and the wind rig
(`wind-probe.ts`). `?raw` makes the map a **JavaScript module exporting a
string**, so the whole 11.5 MB document is compiled into the bundle.

Measured: `npm run build` emits `index-*.js` at **14,074 kB** (3,434 kB gzipped).
Most of that is map. At the 4× world `docs/infinite-map-plan.md` is aiming at it
is ~186 MB of JavaScript, and the build stops being usable well before then —
`?raw` also means the document is parsed as a JS string literal and re-parsed as
JSON at runtime, on top of whatever the minifier does to a megabyte-scale
literal.

**CI does not run `npm run build`.** It runs typecheck, lint, test and the two
bake gates. So the bundle has no watcher at all, and this regression has been
invisible since the map grew.

## Shape

### The map becomes an asset

`?raw` becomes `?url`, and the text is fetched:

```ts
// src/render/iso3d/map-asset.ts
/** The shipped map's text, fetched once per page and shared by every reader. */
export function loadShippedMapText(): Promise<string>;
```

Vite emits `maps/arena.json` into `dist/assets/` as a hashed **JSON file** rather
than as JavaScript, and hands back its URL. One memoised promise, because the
Play tab, the editor and the wind rig are three consumers of one document and a
tab switch should not re-fetch it.

The bytes are unchanged, which is the property that matters: `mapId` is a hash of
the text, the server hashes the same file from disk, and a map only one of them
would accept is not the map being played.

### Mounting becomes asynchronous

The loopback boot in `mountWorld` is deeply synchronous — `buildWorldFromMap`
feeds `warmRouting`, `fillGround`, `new GameServer`, the transport and the
channel, in that order, before anything else in a 1700-line function. Threading
a promise through it would be a rewrite.

So the await goes at the **mount boundary** instead, which is one line of each
view and a small change to the shell:

```ts
// src/render/iso3d/main.ts
readonly mount: (container: HTMLElement) => ViewHandle | Promise<ViewHandle>;
```

`activate` awaits it. Two rules the shell needs and did not before:

- **A mount in flight is remembered**, so pressing a tab twice does not mount it
  twice.
- **A tab switched away from during its own mount is disposed on arrival**, not
  shown. Otherwise a slow fetch hands back a view over whatever the player
  moved to.

Everything below the await in each view stays exactly as synchronous as it is.

### CI gets a gate

`npm run build` joins the workflow, followed by a **bundle size check**: the
emitted JS must stay under a stated ceiling. The ceiling is the durable half of
this spec — the fix is one import, and the thing that keeps it fixed is a job
that fails when a megabyte walks back in.

`scripts/check-bundle.ts` reads what the build emitted and fails with what grew,
so the message names the file rather than a number.

## Invariants tested

- **The bundle carries no map.** `check-bundle.ts` fails when emitted JS exceeds
  the ceiling; asserted against a real `npm run build` in CI.
- **The map ships as an asset.** `dist/assets/` contains a JSON file the size of
  `maps/arena.json`, and no emitted `.js` contains the map's opening bytes.
- **The text is byte-identical**, so `mapIdOf` over the fetched text equals
  `mapIdOf` over the file on disk. Same map, same hash, same wire check.
- **One fetch per page.** `loadShippedMapText` called three times issues one
  request and returns the same string.
- **A tab switched away from mid-mount is disposed**, and never shown or
  started.
- **A tab pressed twice while mounting mounts once.**
- **A failed fetch is a stated failure**, not a blank tab: the Play tab already
  has a connection banner and the editor a readout, and "the map did not load"
  is a sentence rather than an empty world.

## Out of scope

- Splitting the map into region files. That is spec 200; this spec moves one
  file out of the bundle and changes nothing about its shape.
- Fetching per region, or any streaming change on the client. The Play tab's
  remote path already streams and is untouched.
- Caching the asset across reloads beyond whatever the browser's own HTTP cache
  does. No `IndexedDB`, no quota story.
- The server. It reads the file from disk and always did.
- Making the *other* five tabs' mounts asynchronous for their own reasons. They
  gain the ability and use none of it.
