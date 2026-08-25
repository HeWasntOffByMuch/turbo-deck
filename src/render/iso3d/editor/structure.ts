import { hashUnit2 } from '../../../shared/hash.js';
import {
  footprintRadius,
  STRUCTURE_KINDS,
  type ChunkCoord,
  type MapChunkStore,
  type Prop,
  type StructureKind,
} from '../../../terrain/index.js';

/**
 * Putting a building down (spec 222). Pure: no three.js, no DOM, and -- unlike
 * every other prop tool here -- no `Rng` either.
 *
 * The scatter is seeded because where a stroke lands is *random* and a seeded
 * stroke is one a test can assert on. Nothing here is random at all, which is a
 * stronger claim than seeding: a house goes exactly where the cursor is, at the
 * scale and the yaw the panel says, and pressing twice on the same spot from the
 * same panel gives two identical props. That is what a placement tool is for --
 * a village is a layout somebody decided, not a distribution.
 *
 * One press, one building. There is no drag: a density brush is what the scatter
 * already is, and dragging a building across the ground would leave a trail of
 * forty of them, which is exactly the argument `view.ts` already makes about
 * markers.
 */

export interface StructureSettings {
  readonly structure: StructureKind;
  readonly structureScale: number;
  /**
   * Where the front faces, in **degrees**.
   *
   * A number somebody sets on a slider, so it is stored and shown in the unit
   * they think in; `Prop.rotation` is radians and the conversion happens here,
   * once, rather than in the panel and the tool separately.
   */
  readonly structureYaw: number;
}

export const DEFAULT_STRUCTURE: StructureSettings = {
  structure: 'house',
  structureScale: 1,
  structureYaw: 0,
};

/**
 * The sizes a building may be put down at.
 *
 * One pair for both controls: the panel's slider is built from these and the
 * drag clamps to them, so the two cannot come to different answers about which
 * sizes exist -- a slider that offered a size the drag refused would be a
 * building you could set down one way and not the other.
 */
export const STRUCTURE_SCALE_MIN = 0.5;
export const STRUCTURE_SCALE_MAX = 2;
/**
 * The sizes in between, as a count of steps to the unit.
 *
 * A drag lands on one of these rather than on whatever real number the cursor
 * happened to be at, and that is the shared-bounds rule one step further in:
 * the panel offers sizes in twentieths, so a drag that produced
 * `1.1401525949033495` would put a number in that slider it could not have been
 * set to, and place the *next* building at it. Two huts dragged to about the
 * same size coming out the same size is the point of a step rather than a side
 * effect of one.
 *
 * A **count** rather than a width, because the rounding is done with it and the
 * two forms do not agree in binary: `Math.round(r / 0.05) * 0.05` is
 * `1.1500000000000001`, which is the number the panel would then display, while
 * `Math.round(r * 20) / 20` is the double that prints as `1.15`. The width is
 * derived from it for the slider, and `1 / 20` is exactly the double `0.05`.
 */
export const STRUCTURE_SCALE_STEPS_PER_UNIT = 20;
export const STRUCTURE_SCALE_STEP = 1 / STRUCTURE_SCALE_STEPS_PER_UNIT;

/** What a building of this kind blocks at scale 1. */
export function baseFootprint(kind: StructureKind): number {
  return footprintRadius({ kind, x: 0, y: 0, scale: 1, rotation: 0, tint: 0 });
}

/**
 * The scale a drag of this length means, or **null** for a drag too short to
 * be one -- in which case the panel's size stands and the gesture is a click.
 *
 * The distance **is** the footprint radius, so the ring stays under the cursor
 * rather than tracking some multiple of where it went. Every other radius in
 * this editor is dragged out the same way.
 *
 * Where sizing engages is derived rather than chosen, and that is what keeps
 * the gesture from having a step in it: the threshold is the *smallest ring*,
 * so the first scale this can ever return is `STRUCTURE_SCALE_MIN` and the
 * value climbs continuously from there. A threshold picked independently --
 * "a dozen units", say -- would jump from whatever the panel said straight to
 * the minimum the moment it was crossed, which reads as the building
 * collapsing rather than as a size being set.
 */
export function dragScale(kind: StructureKind, distance: number): number | null {
  const base = baseFootprint(kind);
  // NaN specifically, rather than "not finite": the clamp below already handles
  // a distance of any size, and refusing an infinite one would be the gesture
  // silently falling back to the panel at the far end of its own range.
  if (!(base > 0) || Number.isNaN(distance)) return null;
  if (distance < base * STRUCTURE_SCALE_MIN) return null;
  // Snapped to the step, then clamped. Either order gives the same answer,
  // because both bounds are whole steps -- which is worth keeping true.
  const steps = Math.round((distance / base) * STRUCTURE_SCALE_STEPS_PER_UNIT);
  const snapped = steps / STRUCTURE_SCALE_STEPS_PER_UNIT;
  return Math.min(STRUCTURE_SCALE_MAX, Math.max(STRUCTURE_SCALE_MIN, snapped));
}

export interface StructureResult {
  readonly placed: Prop | null;
  /** Chunks whose contents changed: the one the building was filed into. */
  readonly dirty: readonly ChunkCoord[];
  /**
   * Why nothing was placed, for the editor's status line.
   *
   * A refusal that is dropped on the floor is a click that did nothing with no
   * word about why, which is indistinguishable from a tool that does not work --
   * the same finding the marker tool's "no ground there" came from.
   */
  readonly refused: string | null;
}

/** The per-building weathering seed, so two huts are not the same hut twice. */
const HASH_STRUCTURE_TINT = 0x5eed20;

/**
 * The tint a building is stored with.
 *
 * Hashed from where it stands rather than drawn, for the reason every other
 * hashed variation in the prop field is: this tool has no `Rng` and must not
 * grow one. It is written **into the document** rather than resolved at draw
 * time because that is what `Prop.tint` is -- so a hut nudged later keeps the
 * weathering it was placed with only if it is placed again, which is the same
 * deal a scattered tree gets.
 */
function tintAt(x: number, z: number): number {
  return hashUnit2(Math.round(x), Math.round(z), HASH_STRUCTURE_TINT) * 2 - 1;
}

/** True for a kind this tool is allowed to place. Guards a settings object that
 *  has been round-tripped through storage or a URL. */
export function isPlaceableStructure(kind: string): kind is StructureKind {
  return (STRUCTURE_KINDS as readonly string[]).includes(kind);
}

/**
 * The footprint a structure of these settings takes, in world units.
 *
 * What the editor draws its cursor ring at, so the ring is the ground the
 * building will actually block rather than a brush size that means nothing to
 * this tool. Derived from `footprintRadius`, so the ring and the collider are
 * the same circle and cannot drift.
 */
export function structureFootprint(settings: StructureSettings): number {
  return footprintRadius({
    kind: settings.structure,
    x: 0,
    y: 0,
    scale: settings.structureScale,
    rotation: 0,
    tint: 0,
  });
}

/**
 * Place one building at (x, z).
 *
 * Refuses a point with no ground under it, and refuses nothing else. Crowding is
 * deliberately not checked: a well belongs *next to* the houses round it, and
 * the spacing rule the scatter enforces exists to stop a density brush piling
 * props on one spot, which is not a thing a single press can do.
 */
export function placeStructure(
  store: MapChunkStore,
  layerId: string,
  settings: StructureSettings,
  at: { readonly x: number; readonly z: number },
  onTouchChunk?: (cx: number, cz: number) => void,
): StructureResult {
  if (!Number.isFinite(at.x) || !Number.isFinite(at.z)) {
    return { placed: null, dirty: [], refused: 'nowhere to put it' };
  }
  const layer = store.layerInfo(layerId);
  if (!layer) return { placed: null, dirty: [], refused: 'no layer to build on' };

  const col = Math.floor((at.x - layer.origin.x) / store.cellSize);
  const row = Math.floor((at.z - layer.origin.z) / store.cellSize);
  if (!store.cellSolid(layerId, col, row)) {
    return { placed: null, dirty: [], refused: 'no ground there: a building has to stand on the map' };
  }

  const scale = Number.isFinite(settings.structureScale) ? Math.max(0.1, settings.structureScale) : 1;
  const prop: Prop = {
    kind: settings.structure,
    x: at.x,
    y: at.z,
    scale,
    rotation: (((settings.structureYaw % 360) + 360) % 360) * (Math.PI / 180),
    tint: tintAt(at.x, at.z),
  };

  // Snapshot before anything changes, exactly as the scatter does. Every chunk
  // the building's footprint reaches, not only the one it is filed into: the
  // prop lands in one chunk, but its walls stand over whatever is beside it, so
  // that is the ground the caller has to re-mesh.
  if (onTouchChunk) {
    for (const c of store.chunksWithin(layerId, at.x, at.z, structureFootprint(settings))) {
      onTouchChunk(c.cx, c.cz);
    }
  }

  const landed = store.addProp(layerId, prop);
  if (!landed) {
    return { placed: null, dirty: [], refused: 'no ground there: a building has to stand on the map' };
  }
  return { placed: prop, dirty: [landed], refused: null };
}
