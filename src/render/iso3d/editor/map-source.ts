import {
  createArenaWorld,
  exportMap,
  loadMap,
  worldVegetation,
  type LoadedMap,
  type MapDocument,
} from '../../../terrain/index.js';
import { PLAY_HEIGHT, PLAY_WIDTH } from '../../../shared/world.js';

/**
 * Where the editor's map comes from (spec 049).
 *
 * Split out of the view so it can be exercised without a WebGL context: this is
 * the whole of the editor's relationship with the terrain system, and it is worth
 * being able to assert on it in Node.
 *
 * The generated world is baked **once** and then dropped. Everything downstream
 * -- the terrain mesh, the prop field, the ground height under a cursor -- reads
 * the returned `LoadedMap` and never the generator, which is what makes the
 * editor an editor of data rather than a second viewer of the feature list.
 */

/** Bake the generated world for a seed and load it straight back. */
export function bakeEditorMap(seed: number): { document: MapDocument; map: LoadedMap } {
  const world = createArenaWorld(seed);
  const document = exportMap({
    world,
    props: worldVegetation(seed, world),
    seed,
    // The sim's play rectangle: the one thing in a document that is world-space.
    arena: { minX: 0, minZ: 0, maxX: PLAY_WIDTH, maxZ: PLAY_HEIGHT },
  });
  return { document, map: loadMap(document) };
}
