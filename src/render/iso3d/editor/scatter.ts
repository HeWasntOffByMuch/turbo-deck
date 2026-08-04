import { Rng } from '../../../shared/prng.js';
import {
  footprintRadius,
  type ChunkCoord,
  type LayerInfo,
  type MapChunkStore,
  type Prop,
  type PropKind,
} from '../../../terrain/index.js';

/**
 * The prop scatter and the eraser (spec 051).
 *
 * Pure and **seeded**: every random choice comes from an `Rng` passed in and
 * handed back advanced, never from `Math.random`. That is the repo's rule for the
 * sim and the terrain, and it earns its keep here for a different reason -- a
 * seeded stroke is a stroke a test can assert on, rather than one it can only
 * describe in aggregate.
 *
 * Both tools share the brush's radius and the same undo entry, because they are
 * one tool wearing two hats. An eraser with its own radius is a second brush to
 * keep in step forever.
 */

export interface ScatterSettings {
  readonly species: PropKind;
  /** Props per second at the centre of the brush. */
  readonly density: number;
  /** Gradient (rise/run) above which nothing is planted. */
  readonly maxSlope: number;
  readonly scaleMin: number;
  readonly scaleMax: number;
  /** Clear ground left between two props' footprints. */
  readonly spacing: number;
  /** Lie the prop along the ground (rocks) rather than standing it up (trees). */
  readonly alignToNormal: boolean;
}

export const DEFAULT_SCATTER: ScatterSettings = {
  species: 'tree',
  density: 6,
  maxSlope: 0.6,
  scaleMin: 0.75,
  scaleMax: 1.5,
  spacing: 30,
  alignToNormal: false,
};

/** Placement attempts per prop before it is given up on. Bounds the work. */
const ATTEMPTS = 12;

const UNIT = 1 << 24;

/** A float in [0, 1) from the immutable Rng, with the advanced Rng. */
function unit(rng: Rng): [number, Rng] {
  const [n, next] = rng.nextInt(0, UNIT - 1);
  return [n / UNIT, next];
}

/**
 * The ground's gradient magnitude at a world point, measured across the cell it
 * falls in exactly as `sampleChunk` measures it -- so "too steep to plant on"
 * means the same thing as "steep enough to be drawn as rock".
 */
export function slopeAt(store: MapChunkStore, layer: LayerInfo, x: number, z: number): number {
  const cell = store.cellSize;
  const col = Math.floor((x - layer.bounds.minX) / cell);
  const row = Math.floor((z - layer.bounds.minZ) / cell);
  const h00 = store.cornerHeight(layer.id, col, row);
  const h10 = store.cornerHeight(layer.id, col + 1, row);
  const h01 = store.cornerHeight(layer.id, col, row + 1);
  const h11 = store.cornerHeight(layer.id, col + 1, row + 1);
  return Math.hypot((h10 + h11 - h00 - h01) / (2 * cell), (h01 + h11 - h00 - h10) / (2 * cell));
}

/** The unit surface normal at a world point, from the same gradient. */
export function terrainNormalAt(
  store: MapChunkStore,
  layer: LayerInfo,
  x: number,
  z: number,
): readonly [number, number, number] {
  const cell = store.cellSize;
  const col = Math.floor((x - layer.bounds.minX) / cell);
  const row = Math.floor((z - layer.bounds.minZ) / cell);
  const h00 = store.cornerHeight(layer.id, col, row);
  const h10 = store.cornerHeight(layer.id, col + 1, row);
  const h01 = store.cornerHeight(layer.id, col, row + 1);
  const h11 = store.cornerHeight(layer.id, col + 1, row + 1);
  const dx = (h10 + h11 - h00 - h01) / (2 * cell);
  const dz = (h01 + h11 - h00 - h10) / (2 * cell);
  const length = Math.hypot(dx, 1, dz);
  return [-dx / length, 1 / length, -dz / length];
}

export interface ScatterStep {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly dtSeconds: number;
  /**
   * Fractional props carried over from the previous frame. Density is per
   * *second*, so at 6/s and 60fps every frame is owed a tenth of a prop; rounding
   * that away would plant nothing forever.
   */
  readonly carry: number;
  readonly onTouchChunk?: (cx: number, cz: number) => void;
}

export interface ScatterResult {
  readonly added: readonly Prop[];
  readonly rng: Rng;
  /** Fraction of a prop owed to the next frame. */
  readonly carry: number;
  readonly dirty: readonly ChunkCoord[];
}

const EMPTY: ScatterResult = { added: [], rng: Rng.fromSeed(0), carry: 0, dirty: [] };

/**
 * Plant props under the brush for one frame.
 *
 * A candidate is rejected if it falls outside the radius, on ground steeper than
 * `maxSlope`, on a cell the layer says has no ground, or too close to a prop
 * already standing. The crowding rule is the one `vegetation.ts` uses --
 * `distance < footprint(a) + footprint(b) + spacing` -- so a hand-painted grove
 * packs the same way a generated one does, and a saturated patch simply stops
 * accepting props rather than looping.
 */
export function scatterStroke(
  store: MapChunkStore,
  layerId: string,
  settings: ScatterSettings,
  step: ScatterStep,
  rng: Rng,
): ScatterResult {
  const layer = store.layerInfo(layerId);
  const dt = Number.isFinite(step.dtSeconds) ? Math.max(0, step.dtSeconds) : 0;
  const carried = Number.isFinite(step.carry) ? Math.max(0, step.carry) : 0;
  if (!layer || !(step.radius > 0) || !Number.isFinite(step.x) || !Number.isFinite(step.z)) {
    return { ...EMPTY, rng, carry: carried };
  }

  const owed = carried + Math.max(0, settings.density) * dt;
  const wanted = Math.floor(owed);
  if (wanted <= 0) return { ...EMPTY, rng, carry: owed };

  // Announce every chunk the brush can reach *before* planting anything. Where
  // a stroke lands is random, so the chunks it will touch cannot be discovered
  // as it goes without snapshotting each one a prop too late -- and an undo
  // entry captured after the fact restores the edit it was meant to remove.
  if (step.onTouchChunk) {
    for (const c of store.chunksWithin(layerId, step.x, step.z, step.radius)) step.onTouchChunk(c.cx, c.cz);
  }

  const scaleLow = Math.min(settings.scaleMin, settings.scaleMax);
  const scaleSpan = Math.abs(settings.scaleMax - settings.scaleMin);
  const added: Prop[] = [];
  const dirty: ChunkCoord[] = [];
  const seenChunks = new Set<string>();
  let next = rng;

  // Everything already standing inside the footprint, plus a margin for the
  // props whose own footprint reaches in from outside it.
  const neighbourhood = store.propsWithin(layerId, step.x, step.z, step.radius + settings.spacing + 80);
  const standing: Prop[] = [...neighbourhood];

  for (let planted = 0; planted < wanted; planted++) {
    let placed = false;
    for (let attempt = 0; attempt < ATTEMPTS && !placed; attempt++) {
      let ua: number, ud: number, us: number, ur: number, ut: number;
      [ua, next] = unit(next);
      [ud, next] = unit(next);
      [us, next] = unit(next);
      [ur, next] = unit(next);
      [ut, next] = unit(next);

      // Uniform by area, so a stroke does not pile up in the middle.
      const angle = ua * Math.PI * 2;
      const distance = Math.sqrt(ud) * step.radius;
      const x = step.x + Math.cos(angle) * distance;
      const z = step.z + Math.sin(angle) * distance;

      const col = Math.floor((x - layer.bounds.minX) / store.cellSize);
      const row = Math.floor((z - layer.bounds.minZ) / store.cellSize);
      if (!store.cellSolid(layerId, col, row)) continue;
      if (slopeAt(store, layer, x, z) > settings.maxSlope) continue;

      const prop: Prop = {
        kind: settings.species,
        x,
        y: z,
        scale: scaleLow + us * scaleSpan,
        rotation: ur * Math.PI * 2,
        tint: ut * 2 - 1,
        ...(settings.alignToNormal ? { alignToNormal: true } : {}),
      };

      const radius = footprintRadius(prop);
      const gap = Math.max(0, settings.spacing);
      const clear = standing.every(
        (other) => (other.x - x) ** 2 + (other.y - z) ** 2 >= (radius + footprintRadius(other) + gap) ** 2,
      );
      if (!clear) continue;

      const at = store.addProp(layerId, prop);
      if (!at) continue;
      // Snapshot before the chunk changed -- the caller opened the entry, this
      // just tells it which chunks the stroke reached.
      const chunkKey = `${at.cx},${at.cz}`;
      if (!seenChunks.has(chunkKey)) {
        seenChunks.add(chunkKey);
        dirty.push(at);
      }
      standing.push(prop);
      added.push(prop);
      placed = true;
    }
  }

  return { added, rng: next, carry: owed - wanted, dirty };
}

export interface EraseResult {
  readonly removed: readonly Prop[];
  readonly dirty: readonly ChunkCoord[];
}

/** Remove every prop whose centre is inside the brush. Shares the same radius. */
export function eraseStroke(
  store: MapChunkStore,
  layerId: string,
  at: { readonly x: number; readonly z: number; readonly radius: number },
  onTouchChunk?: (cx: number, cz: number) => void,
): EraseResult {
  if (!(at.radius > 0) || !Number.isFinite(at.x) || !Number.isFinite(at.z)) return { removed: [], dirty: [] };
  // Same ordering rule as the scatter: capture before removing.
  if (onTouchChunk) {
    for (const c of store.chunksWithin(layerId, at.x, at.z, at.radius)) onTouchChunk(c.cx, c.cz);
  }
  return store.removePropsWithin(layerId, at.x, at.z, at.radius);
}
