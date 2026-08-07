import { Rng } from '../../../shared/prng.js';
import {
  FENCE_TILE_LENGTH,
  type ChunkCoord,
  type FenceKind,
  type MapChunkStore,
  type Prop,
} from '../../../terrain/index.js';

/**
 * The fence tool (spec 058).
 *
 * Pure and seeded, like the scatter beside it: every random choice comes from an
 * `Rng` passed in and handed back advanced, so a run is a thing a test can
 * assert on rather than only describe.
 *
 * The difference from the scatter is the *shape* of the stroke. Every other tool
 * here fills an area under a circle; a fence follows a **path**. So this one is
 * not given a radius and a duration and asked to sprinkle -- it is given the
 * point the mouse has reached and the point the last tile ended at, and it lays
 * whole tiles along the line between them until what is left is shorter than a
 * tile. The leftover carries to the next frame in the path state, which is why
 * the same drag produces the same fence at 30fps and at 144, and why dragging
 * slowly does not pile tiles on top of each other.
 *
 * A fence is stored as ordinary props -- one per tile, `FENCE_TILE_LENGTH *
 * scale` apart, each turned onto its direction of travel. That is what makes
 * saving, loading, undo, the eraser and the prop colliders work for fences
 * without any of them learning a new concept.
 */

/**
 * The fence styles: regular and rough, in timber and then in stone (spec 059,
 * 060). Ordered so the panel's two-column strip groups them by material.
 *
 * `wood` keeps its id rather than being renamed to what the button calls it,
 * because that id is written into every map already saved with a picket fence.
 */
export const FENCE_STYLES = ['wood', 'boards', 'brick', 'rubble'] as const;
export type FenceStyle = (typeof FENCE_STYLES)[number];

export interface FenceSettings {
  readonly style: FenceStyle;
  /** Size multiplier. Tiles are laid this much longer as well as taller. */
  readonly fenceScale: number;
  /**
   * Whether tiles may draw their materials in varied tones (spec 061).
   *
   * On for a field wall, off for a run meant to read as one built thing, where
   * the mottling reads as dirt rather than as material. Stored per tile rather
   * than kept here, so two runs in one map can differ and a save keeps both.
   */
  readonly variedColor: boolean;
}

export const DEFAULT_FENCE: FenceSettings = { style: 'wood', fenceScale: 1, variedColor: true };

const STYLE_KINDS: Record<FenceStyle, FenceKind> = {
  wood: 'fence-wood',
  boards: 'fence-boards',
  brick: 'fence-brick',
  rubble: 'fence-rubble',
};

/** Which prop kind a style stores as. */
export function fencePropKind(style: FenceStyle): FenceKind {
  return STYLE_KINDS[style] ?? 'fence-wood';
}

/** How far apart tiles of this size are laid, and how long each one is drawn. */
export function fenceStep(settings: FenceSettings): number {
  const scale = Number.isFinite(settings.fenceScale) ? Math.max(0.2, settings.fenceScale) : 1;
  return FENCE_TILE_LENGTH * scale;
}

/**
 * The prop rotation that lays a tile along `(dx, dz)`.
 *
 * A tile is drawn running along its own local +X, and `buildPropField` turns a
 * prop about +Y by three.js's convention, under which local +X comes out at
 * world `(cos r, -sin r)`. Hence the negated z. Dropping that sign reflects every
 * tile about the x axis: an east-west run survives it, and any other run has its
 * tiles skewed off the line being drawn. Pinned in the props test against a real
 * built field rather than here, because the convention is the renderer's.
 */
export function fenceRotation(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

/**
 * Where the run has got to. `started` is false before the first sample of a
 * stroke, because a single point has no direction to lay a tile along.
 */
export interface FencePath {
  readonly x: number;
  readonly z: number;
  readonly started: boolean;
}

export const NO_FENCE_PATH: FencePath = { x: 0, z: 0, started: false };

export interface FenceStep {
  readonly x: number;
  readonly z: number;
  readonly onTouchChunk?: (cx: number, cz: number) => void;
}

export interface FenceResult {
  readonly added: readonly Prop[];
  readonly path: FencePath;
  readonly rng: Rng;
  readonly dirty: readonly ChunkCoord[];
}

/**
 * Tiles laid in one frame, capped.
 *
 * The cursor can jump arbitrarily far in one frame -- a tab regaining focus, a
 * pick that lands on the far side of the map, a stall -- and without a cap that
 * one frame would lay a thousand tiles in a straight line across everything.
 * Over the cap the run simply resumes from where the cursor now is.
 */
const MAX_TILES_PER_STEP = 24;

const UNIT = 1 << 24;

/** A float in [0, 1) from the immutable Rng, with the advanced Rng. */
function unit(rng: Rng): [number, Rng] {
  const [n, next] = rng.nextInt(0, UNIT - 1);
  return [n / UNIT, next];
}

/**
 * Lay fence along the path from where the last tile ended to where the cursor
 * is now.
 *
 * The press only anchors: `started` is false, nothing is laid, and the next
 * sample is the one that has a direction to work with.
 *
 * A tile is skipped -- without giving up the run -- where the layer says there
 * is no ground, or where a fence tile is already standing. The second rule is
 * what stops dragging back over a run doubling it into a thicket, which is
 * otherwise the first thing that happens to anyone drawing a paddock.
 */
export function fenceStroke(
  store: MapChunkStore,
  layerId: string,
  settings: FenceSettings,
  step: FenceStep,
  path: FencePath,
  rng: Rng,
): FenceResult {
  const layer = store.layerInfo(layerId);
  if (!layer || !Number.isFinite(step.x) || !Number.isFinite(step.z)) {
    return { added: [], path, rng, dirty: [] };
  }
  // The press anchors the run and lays nothing.
  if (!path.started) return { added: [], path: { x: step.x, z: step.z, started: true }, rng, dirty: [] };

  const length = fenceStep(settings);
  let fromX = path.x;
  let fromZ = path.z;
  const toX = step.x;
  const toZ = step.z;
  const span = Math.hypot(toX - fromX, toZ - fromZ);
  if (span < length) return { added: [], path, rng, dirty: [] };

  // One direction for the whole sample: the cursor moved in a straight line
  // between two frames, whatever curve the hand was drawing.
  const dirX = (toX - fromX) / span;
  const dirZ = (toZ - fromZ) / span;
  const rotation = fenceRotation(dirX, dirZ);
  const kind = fencePropKind(settings.style);
  const scale = length / FENCE_TILE_LENGTH;

  const added: Prop[] = [];
  const dirty: ChunkCoord[] = [];
  const seenChunks = new Set<string>();
  let next = rng;
  const tiles = Math.min(MAX_TILES_PER_STEP, Math.floor(span / length));

  for (let i = 0; i < tiles; i++) {
    // The tile spans [from, from + length]; the prop sits at its middle, because
    // that is where the geometry is centred.
    const midX = fromX + dirX * (length / 2);
    const midZ = fromZ + dirZ * (length / 2);
    fromX += dirX * length;
    fromZ += dirZ * length;

    const col = Math.floor((midX - layer.origin.x) / store.cellSize);
    const row = Math.floor((midZ - layer.origin.z) / store.cellSize);
    if (!store.cellSolid(layerId, col, row)) continue;
    // Half a tile of clearance: the gap between two tiles of a run is exactly a
    // tile, so this rejects a second pass over the same ground and nothing else.
    const crowded = store
      .propsWithin(layerId, midX, midZ, length * 0.5)
      .some((other) => other.kind === kind);
    if (crowded) continue;

    // Announced before the prop is added, so the undo snapshot is of the chunk
    // as it was -- the same ordering rule the scatter follows.
    if (step.onTouchChunk) {
      for (const c of store.chunksWithin(layerId, midX, midZ, length / 2)) step.onTouchChunk(c.cx, c.cz);
    }

    let tint: number;
    [tint, next] = unit(next);
    const prop: Prop = {
      kind,
      x: midX,
      y: midZ,
      scale,
      rotation,
      tint: tint * 2 - 1,
      // Absent rather than false when varied, so the default costs the document
      // nothing and a map written before the option existed still parses.
      ...(settings.variedColor ? {} : { uniform: true }),
    };
    const at = store.addProp(layerId, prop);
    if (!at) continue;
    const chunkKey = `${at.cx},${at.cz}`;
    if (!seenChunks.has(chunkKey)) {
      seenChunks.add(chunkKey);
      dirty.push(at);
    }
    added.push(prop);
  }

  // The run resumes from the end of the last tile, so the leftover is carried
  // rather than rounded away -- that is what keeps the spacing exact however
  // often the stroke is sampled. Past the cap it resumes from the cursor.
  const resumed = tiles >= MAX_TILES_PER_STEP ? { x: toX, z: toZ } : { x: fromX, z: fromZ };
  return { added, path: { ...resumed, started: true }, rng: next, dirty };
}
