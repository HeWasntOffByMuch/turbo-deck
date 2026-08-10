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

/**
 * How big a body is *drawn*, in raster pixels, not how far away it is.
 *
 * This started out as a distance in world units and could not work (spec 118).
 * The Play camera is orthographic and sits at a fixed 6000-unit standoff --
 * set for near/far-plane clearance, which is all a standoff can be set for
 * under a projection where it cannot affect framing. Every unit in the game was
 * therefore more than four times past a 1400-unit "far" threshold, the player
 * in the middle of the screen included, and every one of them animated at 15Hz
 * under a body whose position was interpolated every frame.
 *
 * Under an orthographic projection every on-screen body is drawn at the same
 * scale wherever it stands, so eye distance is not a weak signal here -- it is
 * not a signal. Apparent size is decided by the zoom, so that is what is
 * measured, and it is measured in the unit the saving is actually about: how
 * many pixels of screen this body is worth.
 */
export interface LodThresholds {
  /** At or above this drawn height in pixels, every tick. */
  readonly full: number;
  /** At or above this, every second tick. Below it, every fourth. */
  readonly reduced: number;
}

/**
 * Defaults, in pixels of the virtual raster the game actually draws into.
 *
 * Set from the configurations that exist rather than from round numbers. The
 * retro filter's smallest virtual size is 320x180 and the widest zoom is a
 * 2800-unit span, so a 55.65-unit body runs from about 6px (smallest raster,
 * fully zoomed out) to 111px (retro off on a 1280px canvas, default zoom). At
 * the default zoom it is 28px on the smallest raster and 42px on the default
 * one -- both of which are the character somebody is playing, so `full` sits
 * below them. `reduced` sits above the fully-zoomed-out end, which is the case
 * the LOD was built for and the only one where a quarter-rate pose is honestly
 * invisible.
 */
export const DEFAULT_LOD: LodThresholds = { full: 24, reduced: 10 };

/**
 * A body's drawn height in pixels, from the view span and the raster width.
 *
 * The same quantity `worldPerPixel` gives the pixel-snap, asked the other way
 * round. Inlined rather than imported so this module stays free of anything
 * that might one day reach for a canvas: it is one division, and the test
 * beside it pins it to the same numbers.
 */
export function drawnPixels(worldHeight: number, spanWidth: number, virtualWidth: number): number {
  const worldPerPixel = Math.abs(spanWidth) / Math.max(1, virtualWidth);
  return worldPerPixel > 0 ? Math.abs(worldHeight) / worldPerPixel : 0;
}

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
export function mixerCadence(pixels: number, inFrustum: boolean, thresholds: LodThresholds = DEFAULT_LOD): number {
  if (!inFrustum) return 0;
  if (pixels >= thresholds.full) return LOD_CADENCE.near;
  if (pixels >= thresholds.reduced) return LOD_CADENCE.mid;
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
