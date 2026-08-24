import type { ChunkCoord, MapChunkStore, MapMarker, MapMarkerKind } from '../../../terrain/index.js';

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
