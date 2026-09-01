import {
  spawnerSettingsEmpty,
  type ChunkCoord,
  type MapChunkStore,
  type MapMarker,
  type MapMarkerKind,
  type MapSpawnerSettings,
} from '../../../terrain/index.js';

/**
 * Placing and clearing markers (spec 052). Pure: no three.js, no DOM.
 *
 * `marker-view.ts` draws what this decides. The split matters here more than it
 * looks: a marker's id is the thing whatever reads the map later keys off, so
 * how ids are chosen is a rule about the *document*, not about the editor's
 * chrome, and it belongs somewhere a test can reach.
 */

export const MARKER_KINDS: readonly MapMarkerKind[] = [
  'spawn',
  'objective',
  'campfire',
  'trigger',
  'spawner',
];

/** Billboard colour per kind. */
export const MARKER_COLORS: Record<MapMarkerKind, number> = {
  spawn: 0x6fd48a,
  objective: 0xf0c65a,
  campfire: 0xe8843c,
  trigger: 0xb98ce0,
  spawner: 0xe0605c,
};

/** The letter drawn on the billboard. */
export const MARKER_GLYPHS: Record<MapMarkerKind, string> = {
  spawn: 'S',
  objective: 'O',
  campfire: 'C',
  trigger: 'T',
  spawner: 'M',
};

/**
 * What to write under a marker's disc, or `''` for one that needs nothing.
 *
 * A spawner is the reason this exists. Every marker of a kind draws the same
 * coloured disc with the same letter on it, which is exactly right for the four
 * kinds where the kind *is* the whole meaning -- one spawn point is much like
 * another. A spawner's meaning is its label: it is the monster that stands
 * there, it is the only thing separating a field of sheep from a ravager, and
 * until this the editor drew both as the same red M. Placing a flock and
 * placing a boss looked identical on the map you were editing.
 *
 * Pure, and here rather than in `marker-view.ts`, for the reason the whole file
 * is: what a marker *says* is a judgement, what it looks like is drawing, and a
 * judgement in a canvas callback is a judgement no test can reach. The same
 * split `world/spawner-overlay.ts` makes for the in-game overlay.
 *
 * Any labelled marker gets its label, not just a spawner. A `trigger` named
 * `boss-door` is worth reading too, and a rule that applied to one kind would
 * be a rule somebody has to remember to extend.
 */
export function markerCaption(marker: Pick<MapMarker, 'label'>): string {
  return marker.label?.trim() ?? '';
}

/**
 * The next free id for a kind: `spawn-1`, `spawn-2`, and so on.
 *
 * The **lowest** free number, not one past the highest, so deleting `spawn-2`
 * and placing again reuses it instead of climbing forever. Ids are generated
 * rather than typed because a marker with no id is useless to whatever reads the
 * map, and a text field in the middle of a placement flow is a worse experience
 * than a name you can simply never change.
 */
export function nextMarkerId(existing: readonly MapMarker[], kind: MapMarkerKind): string {
  const taken = new Set<number>();
  for (const marker of existing) {
    if (marker.kind !== kind) continue;
    const match = /^(.+)-(\d+)$/.exec(marker.id);
    if (match && match[1] === kind) taken.add(Number(match[2]));
  }
  let n = 1;
  while (taken.has(n)) n++;
  return `${kind}-${n}`;
}

export interface PlaceMarkerResult {
  readonly marker: MapMarker | null;
  readonly dirty: readonly ChunkCoord[];
}

/**
 * Place one marker at a world point.
 *
 * On a click, never on a drag: ground and vegetation are bulk things and a
 * spawn point is not, so dragging would leave a trail of forty of them.
 */
export function placeMarker(
  store: MapChunkStore,
  layerId: string,
  kind: MapMarkerKind,
  x: number,
  z: number,
  onTouchChunk?: (cx: number, cz: number) => void,
  label?: string,
): PlaceMarkerResult {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return { marker: null, dirty: [] };
  const marker: MapMarker = {
    kind,
    id: nextMarkerId(store.markers(layerId), kind),
    x,
    z,
    // A spawner's label is the monster it spawns (spec 076), so it is the one
    // kind that is useless without one -- for the rest an empty label is just
    // an unnamed point, and storing `''` would be noise in the document.
    ...(label === undefined || label === '' ? {} : { label }),
  };

  // Announce the chunk before writing to it, so an undo entry captures the
  // state the placement is about to replace rather than the placement itself.
  if (onTouchChunk) {
    for (const c of store.chunksWithin(layerId, x, z, Math.max(1, store.cellSize))) onTouchChunk(c.cx, c.cz);
  }

  const at = store.addMarker(layerId, marker);
  return at ? { marker, dirty: [at] } : { marker: null, dirty: [] };
}

/**
 * Clear markers under the eraser, on the same terms as props: by centre, inside
 * the shared radius. One eraser that takes everything, rather than two erasers
 * and a mode switch to choose between them.
 */
export function eraseMarkers(
  store: MapChunkStore,
  layerId: string,
  at: { readonly x: number; readonly z: number; readonly radius: number },
  onTouchChunk?: (cx: number, cz: number) => void,
): { removed: readonly MapMarker[]; dirty: readonly ChunkCoord[] } {
  if (!(at.radius > 0) || !Number.isFinite(at.x) || !Number.isFinite(at.z)) return { removed: [], dirty: [] };
  if (onTouchChunk) {
    for (const c of store.chunksWithin(layerId, at.x, at.z, at.radius)) onTouchChunk(c.cx, c.cz);
  }
  return store.removeMarkersWithin(layerId, at.x, at.z, at.radius);
}

/**
 * The marker nearest a world point, within `radius`, or null (spec 222).
 *
 * Used to answer "which marker did that click name" for a pick that came back
 * as a *ground* point rather than as a billboard -- and as the pure statement of
 * the rule the billboard pick has to agree with.
 *
 * Nearest rather than first, and ties broken on id, because a tie is not a
 * hypothetical here: markers are dropped at cursor positions and two of them
 * can sit on the same spot exactly. An answer that depended on the order chunks
 * happen to iterate in would make clicking the same place twice select two
 * different things.
 */
export function markerAt(
  markers: readonly MapMarker[],
  x: number,
  z: number,
  radius: number,
): MapMarker | null {
  if (!(radius > 0) || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  const r2 = radius * radius;
  let best: MapMarker | null = null;
  let bestD2 = Infinity;
  for (const marker of markers) {
    const d2 = (marker.x - x) ** 2 + (marker.z - z) ** 2;
    if (d2 > r2) continue;
    if (d2 < bestD2 || (d2 === bestD2 && best !== null && marker.id < best.id)) {
      best = marker;
      bestD2 = d2;
    }
  }
  return best;
}

/** What the select tool may change about a marker. Every field optional. */
export interface MarkerPatch {
  readonly kind?: MapMarkerKind;
  readonly label?: string;
  readonly x?: number;
  readonly z?: number;
  readonly spawner?: MapSpawnerSettings;
}

/**
 * The marker `patch` turns `marker` into, with the document's own rules applied.
 *
 * Pure, and separate from the store write below it, because everything worth
 * getting right here is a *decision* and nothing here is a mutation:
 *
 * - **A kind that cannot read a spawner's numbers does not carry them.** The
 *   parser refuses that document (spec 222), so a select tool that let somebody
 *   turn a spawner into a campfire and kept its leash radius would produce a map
 *   that saves and will not load. Dropped here rather than checked at the save,
 *   because the moment a kind changes is the moment it stops being true.
 * - **An empty label is absent, not `''`.** A spawner's label is the monster it
 *   spawns and the rest are free text; storing an empty string would put a key
 *   in the document meaning nothing, which `placeMarker` already avoids on the
 *   way in.
 * - **An empty settings block is absent**, on the same terms, and for the same
 *   reason the parser normalizes one: a block somebody emptied and no block are
 *   the same statement.
 */
export function patchMarker(marker: MapMarker, patch: MarkerPatch): MapMarker {
  const kind = patch.kind ?? marker.kind;
  const label = patch.label ?? marker.label;
  const spawner = patch.spawner ?? marker.spawner;
  const kept =
    kind !== 'spawner' || spawner === undefined
      ? undefined
      : spawnerSettingsEmpty(spawner)
        ? undefined
        : spawner;
  return {
    kind,
    id: marker.id,
    x: patch.x ?? marker.x,
    z: patch.z ?? marker.z,
    ...(label === undefined || label.trim() === '' ? {} : { label }),
    ...(kept === undefined ? {} : { spawner: kept }),
  };
}

export interface UpdateMarkerResult {
  /** What the marker became, or null if nothing holds that id or it landed nowhere. */
  readonly marker: MapMarker | null;
  readonly dirty: readonly ChunkCoord[];
}

/**
 * Apply a patch to the marker with this id (spec 222).
 *
 * The one write the select tool makes, whether it is renaming a spawner or
 * dragging it across the map -- `MapChunkStore.updateMarker` re-files it when
 * the point moved, so a move is not a special case here or anywhere above.
 *
 * Chunks are announced *before* the write, exactly as `placeMarker` does, so an
 * undo entry captures the state the edit is about to replace. Both the chunk it
 * came from and the one it is going to, since a drag across a seam changes two.
 */
export function updateMarker(
  store: MapChunkStore,
  layerId: string,
  id: string,
  patch: MarkerPatch,
  onTouchChunk?: (cx: number, cz: number) => void,
): UpdateMarkerResult {
  const current = store.markers(layerId).find((m) => m.id === id);
  if (!current) return { marker: null, dirty: [] };
  const next = patchMarker(current, patch);

  if (onTouchChunk) {
    const reach = Math.max(1, store.cellSize);
    for (const c of store.chunksWithin(layerId, current.x, current.z, reach)) onTouchChunk(c.cx, c.cz);
    for (const c of store.chunksWithin(layerId, next.x, next.z, reach)) onTouchChunk(c.cx, c.cz);
  }

  const dirty = store.updateMarker(layerId, id, next);
  return dirty ? { marker: next, dirty } : { marker: null, dirty: [] };
}
