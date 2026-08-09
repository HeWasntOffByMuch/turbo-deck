/**
 * How often a distant unit's pose is actually applied (spec 111).
 *
 * The brief asks for a reduced mixer update rate past a threshold, and skinning
 * skipped entirely outside the frustum. What that saves is worth being precise
 * about, because it is not what it sounds like: the vertex skinning itself
 * happens on the GPU and an object the renderer culled never reaches it. The
 * cost this controls is on the CPU and it is paid per unit per application —
 * `mixer.update` sampling every track, writing every bone's local transform, and
 * the skeleton's world-matrix walk that follows. Forty units in a fight is forty
 * of those a frame, and a unit twelve hundred units away that updates on every
 * fourth tick is indistinguishable from one that does not.
 *
 * **The machine is never throttled — only the mixer.** Events are gameplay-shaped
 * even though they are presentation: a footstep and a swing impact are authored
 * on a frame index, and a machine that skipped ticks would fire them late, twice,
 * or not at all. Stepping it is integer arithmetic and costs nothing worth
 * saving. So the cadence here decides how often the *pose* is written, and the
 * tick count marches on regardless.
 *
 * Pure and tested headlessly, because "when does a unit stop animating" is a
 * question with a right answer and no need of a GPU to ask it.
 */

/** Distances in world units. A player is ~16 units across, so these are bodies. */
export interface LodThresholds {
  /** Under this, every tick. */
  readonly near: number;
  /** Under this, every second tick. Beyond, every fourth. */
  readonly far: number;
}

/**
 * Defaults, in the same world units the arena is measured in.
 *
 * `near` is roughly the width of what the isometric camera has in frame at the
 * default zoom, so anything a player is actually looking at animates at full
 * rate. `far` is past where a body is a handful of pixels.
 */
export const DEFAULT_LOD: LodThresholds = { near: 600, far: 1400 };

/** Applications are skipped between these, so 4 means one tick in four. */
export const LOD_CADENCE = { near: 1, mid: 2, far: 4 } as const;

/**
 * Ticks between pose applications, or 0 for "do not apply at all".
 *
 * Zero is a real answer and is the frustum case: a unit nobody can see does not
 * need a pose, and skipping it is the whole of the saving rather than a
 * reduction in it. A unit that comes back into view gets a pose on the next tick
 * it is applied on, from a machine that has been stepping the whole time, so it
 * reappears mid-stride rather than snapping from where it left.
 */
export function mixerCadence(distance: number, inFrustum: boolean, thresholds: LodThresholds = DEFAULT_LOD): number {
  if (!inFrustum) return 0;
  if (!(distance > thresholds.near)) return LOD_CADENCE.near;
  if (!(distance > thresholds.far)) return LOD_CADENCE.mid;
  return LOD_CADENCE.far;
}

/**
 * Whether this tick is one of the ones a given cadence applies on.
 *
 * Keyed on the tick rather than on a per-unit counter, deliberately: a counter
 * would reset every time a unit crossed a threshold, so a body walking toward
 * the camera would stutter at each boundary as its phase jumped. A modulo of a
 * shared clock has no phase to lose.
 *
 * The `id` offset spreads a crowd across the available ticks. Forty units all
 * updating on tick 0 mod 4 is the same frame cost as no LOD at all, once every
 * four frames, which reads as a periodic hitch rather than as a saving.
 */
export function shouldApply(cadence: number, tick: number, id = 0): boolean {
  if (cadence <= 0) return false;
  if (cadence === 1) return true;
  return (((tick + id) % cadence) + cadence) % cadence === 0;
}
