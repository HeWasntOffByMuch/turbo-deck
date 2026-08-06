/**
 * Where the enemies are (spec 074).
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

import type { MapDocument } from '../../terrain/index.js';
import { monsterById } from '../data/monsters.js';

export interface SpawnPoint {
  /** The marker's id, unique across the document. */
  readonly id: string;
  readonly monsterId: string;
  readonly x: number;
  /** The document's `z`. The sim's ground plane is (x, y). */
  readonly y: number;
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
      // when it loads one: a marker's stored x is an offset inside its chunk.
      const originX = layer.bounds.minX + chunk.cx * extent;
      const originZ = layer.bounds.minZ + chunk.cz * extent;
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
        points.push({ id: marker.id, monsterId, x: originX + marker.x, y: originZ + marker.z });
      }
    }
  }

  return points.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
