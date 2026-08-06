# Map document format & markers (spec 048 / 052 / 072)

## Core files
- `src/terrain/map.ts` — the `MapDocument` type, `exportMap` (bake), `serializeMap`/`parseMap` (hand-rolled JSON writer/reader, not `JSON.stringify`).
- `src/terrain/map-world.ts` — `loadMap(doc)` and `MapChunkStore`: turns a document back into an array-backed `TerrainWorld` + mutable store the editor writes to.
- `maps/arena.json` — the checked-in baked map the server loads at boot.
- `scripts/bake-map.ts` — regenerates `maps/arena.json` from `createArenaWorld(seed)`; the *only* sanctioned way to produce it from scratch. After that the editor owns the file.
- `src/render/iso3d/editor/markers.ts` — pure marker placement/erase logic (`placeMarker`, `eraseMarkers`, `nextMarkerId`).
- `src/render/iso3d/editor/marker-view.ts` — three.js billboard+stem rendering of markers (`createMarkerView`) and the arena outline.
- `src/render/iso3d/editor/panel.ts` — lil-gui folder wiring the marker-kind picker into the "Markers" folder.
- `src/render/iso3d/editor/tools.ts` — `EditorMode` includes `'marker'`; `EditorState.markerKind: MapMarkerKind`.
- `src/server/world/map-file.ts` — `loadMapFile()` reads+parses `maps/arena.json` at server boot (`DEFAULT_MAP_PATH`, `TURBO_DECK_MAP` env override).
- `src/server/world/build.ts` — `buildWorldFromMap`/`buildWorldFromDocument` build the sim world from the doc via `loadMap`. **Markers are not surfaced on `BuiltWorld`/`BuiltMapWorld` at all** — only terrain/props/sampler/colliders.
- `src/server/net/map-messages.ts` — wire encode/decode of `MapChunk` including its `markers` array (varint-quantized x/z, string id/label).

## Key types (verbatim, `src/terrain/map.ts`)

```ts
export type MapMarkerKind = 'spawn' | 'objective' | 'campfire' | 'trigger';

export interface MapMarker {
  readonly kind: MapMarkerKind;
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly label?: string;
}

export interface MapChunk {
  readonly cx: number;
  readonly cz: number;
  readonly cols: number;
  readonly rows: number;
  readonly heights: readonly number[];
  readonly solid: readonly number[];       // RLE
  readonly materials: readonly number[];   // RLE
  readonly tones: readonly number[];       // RLE
  readonly props: readonly MapProp[];
  readonly markers: readonly MapMarker[];
  readonly nav: readonly number[] | null;
}

export interface MapLayer {
  readonly id: string;
  readonly seed: number;
  readonly bounds: MapRect;
  readonly baseY: number;
  readonly waterLevel: number | null;
  readonly chunks: readonly MapChunk[];
}

export interface MapDocument {
  readonly version: number;
  readonly seed: number;
  readonly grid: { readonly cellSize: number; readonly chunkCells: number };
  readonly layers: readonly MapLayer[];
  readonly arena: MapRect;
}
```

## How markers work
- Kinds: `spawn | objective | campfire | trigger` (`MARKER_KINDS` in `editor/markers.ts`).
- Placed via the editor's `'marker'` tool mode: click (not drag) calls `placeMarker(store, layerId, kind, x, z, onTouchChunk)`; id auto-generated as `${kind}-N` (lowest free N, `nextMarkerId`).
- Stored **chunk-local**: `MapChunk.markers[i].x/z` are relative to the chunk's origin. `MapChunkStore` converts to/from world space at the boundary (`storeChunk` on load, `toDocument()`/`exportMap` on save).
- Rendered in the editor as a billboard sprite (colour+glyph per kind) on a stem dropped to the exact ground height (`marker-view.ts`), depth-test off so it's always visible.
- Undo: markers ride along in the generic `ChunkSnapshot`/`restoreChunk` (props+markers copied wholesale per touched chunk) — there is no marker-specific history path.
- Round trip through the wire: `src/server/net/map-messages.ts` encodes/decodes `MapChunk.markers` for the map-streaming protocol (`MapMarkerKindValue` enum table, varint-quantized coords). This is how a client editing a map, or a client streaming the world in, receives markers.

## Server boot / gameplay use — important gap
- `loadMapFile()` reads and validates `maps/arena.json` at boot; `buildWorldFromMap` calls `loadMap(doc)` to get a `LoadedMap` which *does* have `.markers` (`LoadedMap.markers`, `map-world.ts:903`), but `build.ts`'s `BuiltWorld`/`BuiltMapWorld` never copies that field out — only `terrain/props/sampler/colliders`. **No gameplay code currently reads markers**: player spawn positions are computed elsewhere in `src/server/sim/world.ts` (`spawnEntity`, ambient spawner), not from `spawn`-kind markers.
- `maps/arena.json` as shipped has **zero populated markers** — every chunk's `"markers": []` is empty. Markers exist as a fully-built editor feature (place/erase/render/persist/wire) with no downstream consumer yet.

## arena.json shape (excerpt, header only — heightfields omitted)
```json
{
  "version": 1,
  "seed": 1,
  "grid": { "cellSize": 22, "chunkCells": 28 },
  "arena": { "minX": 0, "minZ": 0, "maxX": 1200, "maxZ": 900 },
  "layers": [
    {
      "id": "ground",
      "seed": 1,
      "bounds": { "minX": -1600, "minZ": -1600, "maxX": 2800, "maxZ": 2500 },
      "baseY": -260,
      "waterLevel": -60,
      "chunks": [
        {
          "cx": 0, "cz": 0, "cols": 28, "rows": 28,
          "heights": [ /* (cols+1)*(rows+1) numbers, one terrain row per line */ ],
          "solid": [ /* RLE value,count pairs */ ],
          "materials": [ /* RLE */ ],
          "tones": [ /* RLE */ ],
          "props": [ /* MapProp[] */ ],
          "markers": [],
          "nav": [ /* or null */ ]
        }
      ]
    }
  ]
}
```
