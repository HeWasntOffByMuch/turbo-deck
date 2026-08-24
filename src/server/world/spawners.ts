/**
 * Where the enemies are (spec 076).
 *
 * The map document is the only answer. A `spawner` marker is a named point in
 * world space whose `label` is a monster id, and this turns the document's
 * markers into the flat, sorted list the sim's spawner walks every tick.
 *
 * Pure: reads a document, returns data. The one opinion it holds is that a
 * spawner naming a monster nobody has heard of is a *boot failure* rather than a
 * point that quietly never spawns -- the two look identical from inside the game
 * (an empty patch of ground), and only one of them is worth an hour of looking
 * for the monster that should be there.
 */

import type { MapDocument, MapMarker } from '../../terrain/index.js';
import { SERVER_TICK_RATE } from '../config.js';
import { monsterById } from '../data/monsters.js';

export interface SpawnPoint {
  /** The marker's id, unique across the document. */
  readonly id: string;
  readonly monsterId: string;
  readonly x: number;
  /** The document's `z`. The sim's ground plane is (x, y). */
  readonly y: number;
  /**
   * Ticks between the kill and the replacement, or null for the config's own
   * (spec 222).
   *
   * Null rather than a number resolved here, because the default is a *live*
   * config value the admin console can change without a restart -- resolving it
   * at load would freeze whatever it happened to be when the map was read.
   */
  readonly respawnTicks: number | null;
  /**
   * How far a body from this point may be dragged, or null for the sim's own.
   *
   * Null for the other half of the same reason: the default is `LEASH_RADIUS`,
   * which lives in `sim/world.ts` beside the check that reads it and beside the
   * nav padding derived from it. Copying it here would be a second statement of
   * a number that has exactly one home, and this file's job is to say what the
   * *document* asked for.
   */
  readonly leashRadius: number | null;
}

export class SpawnerError extends Error {}

/**
 * Every spawner in the document, sorted by id.
 *
 * Sorted because the order spawners are considered in is sim order, and the
 * order markers happen to sit in the chunk array is an artefact of which chunk a
 * level designer clicked in first. A replay may not depend on that.
 */
export function spawnPointsFrom(doc: MapDocument): readonly SpawnPoint[] {
  const points: SpawnPoint[] = [];
  const seen = new Set<string>();

  const extent = doc.grid.cellSize * doc.grid.chunkCells;

  for (const layer of doc.layers) {
    for (const chunk of layer.chunks) {
      // Chunk-local to world space, the same conversion `MapChunkStore` makes
      // when it loads one: a marker's stored x is an offset inside its chunk,
      // and chunk indices are counted from the layer's *origin* -- not from
      // `bounds.min`, which moves independently once the map has grown west
      // or north of where it was first baked (spec 083).
      const originX = layer.origin.x + chunk.cx * extent;
      const originZ = layer.origin.z + chunk.cz * extent;
      for (const marker of chunk.markers) {
        if (marker.kind !== 'spawner') continue;
        const monsterId = marker.label ?? '';
        if (!monsterById(monsterId)) {
          throw new SpawnerError(
            monsterId === ''
              ? `spawner ${marker.id} has no monster: its label must be a monster id`
              : `spawner ${marker.id} names an unknown monster: ${monsterId}`,
          );
        }
        if (seen.has(marker.id)) {
          throw new SpawnerError(`two spawners share the id ${marker.id}`);
        }
        seen.add(marker.id);
        points.push({
          id: marker.id,
          monsterId,
          x: originX + marker.x,
          y: originZ + marker.z,
          respawnTicks: respawnTicksOf(marker),
          leashRadius: positiveOrNull(marker.spawner?.leashRadius, marker, 'leashRadius'),
        });
      }
    }
  }

  return points.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * A spawner's own respawn clock in ticks, or null for the config's (spec 222).
 *
 * The document authors seconds; the sim counts ticks. This is the one boundary
 * that converts, so nothing above it has to know the tick rate and nothing below
 * it has to know that a person wrote the number.
 *
 * Rounded to a whole tick and floored at one, because a sub-tick wait is a wait
 * of zero and "0.001 seconds" is a request nobody could have meant literally --
 * whereas an author who wrote a genuinely tiny number wanted "as fast as
 * possible", which is what one tick is.
 */
function respawnTicksOf(marker: MapMarker): number | null {
  const seconds = positiveOrNull(marker.spawner?.respawnSeconds, marker, 'respawnSeconds');
  return seconds === null ? null : Math.max(1, Math.round(seconds * SERVER_TICK_RATE));
}

/**
 * A finite, positive number, null when absent -- and a boot failure otherwise.
 *
 * The same stance this file already takes on a spawner naming a monster nobody
 * has heard of, for the same reason: a zero respawn time and a negative leash
 * are indistinguishable from inside the game (a patch of ground behaving oddly)
 * and only one of the two possible reactions to that is worth anybody's hour.
 */
function positiveOrNull(value: number | undefined, marker: MapMarker, field: string): number | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw new SpawnerError(`spawner ${marker.id} has a ${field} that is not a positive number: ${String(value)}`);
  }
  return value;
}
