import { hashUnit2 } from '../../../shared/hash.js';
import {
  fixtureLight,
  footprintRadius,
  isFixtureKind,
  PLACED_KINDS,
  signText,
  type ChunkCoord,
  type MapChunkStore,
  type PlacedKind,
  type Prop,
} from '../../../terrain/index.js';

/**
 * Putting a building down (spec 224). Pure: no three.js, no DOM, and -- unlike
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
  readonly structure: PlacedKind;
  readonly structureScale: number;
  /**
   * What a light fixture is placed burning at (spec 250).
   *
   * Read only for a kind that emits, exactly as `structureYaw` is read only by
   * a kind that has a front -- a well is round and a lamp post is dark until
   * one of these two says otherwise.
   *
   * Absent means "whatever the kind's row says", which is also what a fixture
   * placed at those numbers stores: `placeStructure` writes an override only
   * where one differs, so a lamp put down without touching either slider costs
   * the document no bytes and follows `FIXTURE_LIGHTS` for the rest of its life.
   */
  readonly fixtureBrightness?: number;
  readonly fixtureRadius?: number;
  /**
   * Where the front faces, in **degrees**.
   *
   * A number somebody sets on a slider, so it is stored and shown in the unit
   * they think in; `Prop.rotation` is radians and the conversion happens here,
   * once, rather than in the panel and the tool separately.
   */
  readonly structureYaw: number;
  /**
   * What a sign is placed saying (spec 259).
   *
   * Read only by a kind that has anything to do with it, exactly as
   * `fixtureBrightness` is read only by a kind that emits: a message on a well
   * is a field nothing will ever look at, which is the thing `parseMarker`
   * refuses one system over.
   *
   * A **required** string rather than an optional one, and that is not
   * tidiness: `gui.add` refuses a field whose value is not there, logs
   * `gui.add failed`, hands back `undefined`, and the `.name()` on the end of
   * the chain throws -- which stops panel construction where it stands and
   * opens the Map editor tab black. Spec 250 shipped exactly that by seeding
   * two sliders `null`, and `tools.test.ts` asserts it cannot happen again.
   */
  readonly signText: string;
}

export const DEFAULT_STRUCTURE: StructureSettings = {
  structure: 'house',
  structureScale: 1,
  structureYaw: 0,
  signText: '',
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
export function baseFootprint(kind: PlacedKind): number {
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
export function dragScale(kind: PlacedKind, distance: number): number | null {
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
export function isPlaceableStructure(kind: string): kind is PlacedKind {
  return (PLACED_KINDS as readonly string[]).includes(kind);
}

/**
 * The light override a fixture is placed with, or **undefined** for one at its
 * kind's defaults (spec 250).
 *
 * Undefined rather than the resolved numbers, and that is the whole of why a
 * document does not grow: `fixtureLight` reads the row when there is no
 * override, so a lamp placed without touching a slider follows a retune of
 * `FIXTURE_LIGHTS` forever, and one placed at 1.5 does not.
 *
 * A panel that has never been opened has neither number set, and a kind that
 * emits nothing gets neither whatever they say -- a light on a hut is a field
 * nothing will ever read, which is the thing `parseMarker` refuses one step
 * over.
 */
export function fixtureOverride(
  settings: StructureSettings,
): { readonly brightness: number; readonly radius: number } | undefined {
  if (!isFixtureKind(settings.structure)) return undefined;
  const base = fixtureLight({
    kind: settings.structure,
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    tint: 0,
  });
  if (!base) return undefined;
  const brightness = settings.fixtureBrightness ?? base.brightness;
  const radius = settings.fixtureRadius ?? base.radius;
  if (brightness === base.brightness && radius === base.radius) return undefined;
  return { brightness, radius };
}

/**
 * The message this tool would place, or **null** for nothing to place.
 *
 * `fixtureOverride`'s shape one field along, and the same rule: a kind that
 * cannot read it never gets one, whatever the panel happens to be holding, so
 * arming the sign, typing a message and then switching to a hut does not write
 * a sentence into a building.
 *
 * The trimming and the bound are `signText`'s, asked of a prospective prop
 * rather than reimplemented -- so what the tool refuses to place and what the
 * game refuses to read are one answer. A message longer than `MAX_SIGN_TEXT` is
 * *cut* here and *refused* by `parseMap`, which is the right way round: a
 * document is a file that may already be wrong, and a tool is a person still
 * typing.
 */
export function messageOf(settings: StructureSettings): string | null {
  return signText({
    kind: settings.structure,
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    tint: 0,
    text: settings.signText,
  });
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
  const light = fixtureOverride(settings);
  const text = messageOf(settings);
  // Refused rather than placed blank (spec 259). A sign with nothing on it is a
  // post the crosshair slides over and a click walks past -- `signMarks` drops
  // it and `signText` is what decides, at every layer -- so putting one down
  // would be a tool that appears to work and produces scenery. The eraser is a
  // radius, so it would also be scenery that is a nuisance to take back.
  if (settings.structure === 'sign' && text === null) {
    return { placed: null, dirty: [], refused: 'a sign needs a message: type one in the panel' };
  }
  const prop: Prop = {
    kind: settings.structure,
    x: at.x,
    y: at.z,
    scale,
    rotation: (((settings.structureYaw % 360) + 360) % 360) * (Math.PI / 180),
    tint: tintAt(at.x, at.z),
    ...(light ? { light } : {}),
    ...(text === null ? {} : { text }),
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
