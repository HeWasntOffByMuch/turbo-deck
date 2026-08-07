import type { MapRect } from '../../../terrain/index.js';
import { orbitToOffset, zoomSpan, type Vec3 } from '../view-settings.js';

/**
 * The map editor's camera (spec 049).
 *
 * Every other view in the game rides the same isometric follow rig: pinned to a
 * unit, pitched between 10 and 85 degrees, framed by a slider. That is right for
 * playing and useless for building. You cannot get above a hillside to shape it,
 * drop to eye level to check a silhouette, or leave the player behind to work on
 * a corner of the map. This camera follows nothing and goes where it is pointed.
 *
 * Still **orthographic**, and still built out of `orbitToOffset`. The editor is
 * not a different renderer -- it is the same scene with the constraint taken off,
 * so what you shape is what the game will show.
 *
 * Pure state and pure transitions: no three.js, no DOM, no clock. Every rule
 * about where the camera may go lives here and is tested in Node; the view layer
 * only copies the resulting numbers onto a `THREE.OrthographicCamera`.
 */

/**
 * The pitch band, radians. Wider than the game's 10-85 degrees in both
 * directions: near the horizon to read a skyline, near vertical to lay out a
 * region as a plan. Stopping short of 0 and 90 on purpose -- at exactly vertical
 * the azimuth stops meaning anything and the view spins about nothing, and at
 * exactly horizontal an orthographic camera looking along the ground plane
 * renders it as a single line.
 */
export const EDITOR_ELEVATION_MIN = (3 * Math.PI) / 180;
export const EDITOR_ELEVATION_MAX = (89 * Math.PI) / 180;

/**
 * The zoom band, world units of half-span. Much wider than the game's 200-1400:
 * 40 puts a couple of terrain cells across the screen, which is the scale a
 * height brush is used at.
 *
 * The far end is a **floor on the limit**, not the limit itself. 3200 held the
 * 4400-unit world it was written for, and stopped dead there -- which was fine
 * until the map could grow (spec 082). A world you cannot zoom out far enough
 * to see is a world you cannot choose where to extend, so the real limit is
 * computed from the map by {@link maxHalfWidthFor}.
 */
export const EDITOR_MIN_HALF_WIDTH = 40;
export const EDITOR_MAX_HALF_WIDTH = 3200;
export const EDITOR_DEFAULT_HALF_WIDTH = 640;

/**
 * How far out the camera may pull for a given map: far enough to frame the
 * whole thing with room around it, and never less than the fixed floor.
 *
 * The margin matters as much as the span. Growing the world means aiming at
 * ground that is not there yet, so the useful framing is the map *plus* empty
 * space beside it -- a limit that exactly fitted the map would leave nowhere to
 * put the next part.
 */
export function maxHalfWidthFor(bounds: MapRect | null): number {
  if (!bounds) return EDITOR_MAX_HALF_WIDTH;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  return Math.max(EDITOR_MAX_HALF_WIDTH, span);
}

/**
 * How far the camera sits from its pivot. With an orthographic projection this
 * decides nothing about the framing -- only what stays between the clip planes --
 * so it matches the game's rig, whose near/far were sized against it.
 */
export const EDITOR_CAMERA_DISTANCE = 6000;

/** The opening angles: the game's isometric bearing, so the editor starts on a familiar view. */
const DEFAULT_AZIMUTH = (45 * Math.PI) / 180;
const DEFAULT_ELEVATION = (35 * Math.PI) / 180;

/** Radians of rotation per pixel dragged. ~160px for a quarter turn. */
const ORBIT_PER_PIXEL = 0.01;

/**
 * Floor on the foreshortening a dolly divides by (spec 058).
 *
 * Vertical drag moves the pivot along the camera's ground heading, and that
 * heading is squashed on screen by `sin(elevation)` -- so undoing it means
 * dividing by that sine. Near the horizon the sine goes to nothing and the
 * division goes to infinity: at the 3-degree floor the pitch band allows, a
 * hundred-pixel drag would fling the pivot nineteen screens away. Below this
 * the grip is given up rather than the control: the ground stops tracking the
 * cursor exactly, which is much less bad than losing the map.
 */
const DOLLY_MIN_SIN = 0.25;

/** How far past the map's bounds the pivot may wander before it is held. */
const PIVOT_MARGIN = 600;

export interface EditorCameraState {
  /** The pivot the camera orbits, on the ground. */
  readonly target: Vec3;
  /** Azimuth about +Y, radians, wrapped to [-PI, PI). */
  readonly azimuth: number;
  /** Elevation above the ground plane, radians, held inside the band. */
  readonly elevation: number;
  /** How far out this map lets the camera pull; see {@link maxHalfWidthFor}. */
  readonly maxHalfWidth: number;
  /** Orthographic half-span, world units. */
  readonly halfWidth: number;
  /** The rectangle the pivot is held over. */
  readonly bounds: MapRect | null;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Hold a value in a band, resolving a non-finite input to `fallback`. */
function hold(value: number, low: number, high: number, fallback: number): number {
  return clamp(Number.isFinite(value) ? value : fallback, low, high);
}

/**
 * Wrap an angle into [-PI, PI). Without this the azimuth simply accumulates: an
 * hour of orbiting the same way runs it into the thousands, where the float's
 * spacing is coarse enough for a slow drag to visibly step.
 */
export function wrapAngle(radians: number): number {
  if (!Number.isFinite(radians)) return 0;
  const wrapped = (radians + Math.PI) % (2 * Math.PI);
  return (wrapped < 0 ? wrapped + 2 * Math.PI : wrapped) - Math.PI;
}

export interface EditorCameraOptions {
  readonly target?: Partial<Vec3>;
  readonly halfWidth?: number;
  /** Rectangle the pivot is held over; omit to let it roam. */
  readonly bounds?: MapRect;
}

export function createEditorCamera(opts: EditorCameraOptions = {}): EditorCameraState {
  const bounds = opts.bounds ?? null;
  const maxHalfWidth = maxHalfWidthFor(bounds);
  const halfWidth = hold(
    opts.halfWidth ?? EDITOR_DEFAULT_HALF_WIDTH,
    EDITOR_MIN_HALF_WIDTH,
    maxHalfWidth,
    EDITOR_DEFAULT_HALF_WIDTH,
  );
  return {
    target: holdPivot(
      { x: opts.target?.x ?? 0, y: opts.target?.y ?? 0, z: opts.target?.z ?? 0 },
      bounds,
      halfWidth,
    ),
    azimuth: DEFAULT_AZIMUTH,
    elevation: DEFAULT_ELEVATION,
    halfWidth,
    maxHalfWidth,
    bounds,
  };
}

/**
 * Re-aim the limits at a map that has changed size (spec 082).
 *
 * The bounds and the zoom ceiling are captured when the camera is made, so a
 * world that grows afterwards leaves the camera fenced into the rectangle the
 * map used to be -- you can watch ground appear that you cannot then pan to.
 * Called whenever a part lands or a document is loaded.
 */
export function withMapBounds(state: EditorCameraState, bounds: MapRect | null): EditorCameraState {
  const maxHalfWidth = maxHalfWidthFor(bounds);
  const halfWidth = hold(state.halfWidth, EDITOR_MIN_HALF_WIDTH, maxHalfWidth, EDITOR_DEFAULT_HALF_WIDTH);
  return { ...state, bounds, maxHalfWidth, halfWidth, target: holdPivot(state.target, bounds, halfWidth) };
}

/**
 * Hold the pivot over the map, so a long pan cannot lose the world entirely.
 *
 * The allowance grows with the zoom. A fixed 600 units past the edge is right
 * when you are close in and sculpting, and far too tight when you are pulled
 * back looking for somewhere to grow into -- at a 3000-unit half-span the
 * whole reachable margin was a fifth of a screen. Adding the half-span means
 * the further out you are, the further out you may look, which is the same
 * relationship the pan speed already has.
 */
function holdPivot(target: Vec3, bounds: MapRect | null, halfWidth: number): Vec3 {
  const y = Number.isFinite(target.y) ? target.y : 0;
  if (!bounds) {
    return { x: Number.isFinite(target.x) ? target.x : 0, y, z: Number.isFinite(target.z) ? target.z : 0 };
  }
  const margin = PIVOT_MARGIN + (Number.isFinite(halfWidth) ? Math.max(0, halfWidth) : 0);
  return {
    x: hold(target.x, bounds.minX - margin, bounds.maxX + margin, bounds.minX),
    y,
    z: hold(target.z, bounds.minZ - margin, bounds.maxZ + margin, bounds.minZ),
  };
}

/**
 * Drag to orbit: horizontal pixels swing the bearing, vertical pixels the pitch.
 *
 * The direction is "grab the world and drag it", not "push the camera". Dragging
 * *down* pulls the far ground toward you and the view tips toward a plan; dragging
 * *up* brings the horizon up and the view falls toward an elevation. Both axes
 * follow the same rule, which is the thing that makes a free camera feel like one
 * mechanism rather than two.
 *
 * The pivot never moves, so orbiting studies the spot you are working on rather
 * than sliding off it.
 */
export function orbitEditorCamera(
  state: EditorCameraState,
  dxPixels: number,
  dyPixels: number,
): EditorCameraState {
  const dx = Number.isFinite(dxPixels) ? dxPixels : 0;
  const dy = Number.isFinite(dyPixels) ? dyPixels : 0;
  return {
    ...state,
    azimuth: wrapAngle(state.azimuth + dx * ORBIT_PER_PIXEL),
    elevation: clamp(state.elevation + dy * ORBIT_PER_PIXEL, EDITOR_ELEVATION_MIN, EDITOR_ELEVATION_MAX),
  };
}

/**
 * Middle-drag to track and dolly (spec 058), in the camera's **own** ground
 * frame: horizontal pixels slide the pivot across the camera's heading, vertical
 * pixels push it along that heading. Moving in world axes instead would send the
 * view diagonally off screen at every bearing but one, which is the thing that
 * makes a free camera unusable.
 *
 * This is a **grip**, not a speed, which is why it takes pixels and a viewport
 * rather than an axis and a `dt`. One pixel of drag moves the pivot by exactly
 * one pixel's worth of world -- `2 * halfWidth / viewportWidth` across the
 * screen -- so the ground under the cursor stays under the cursor at every zoom,
 * and the same gesture covers the same amount of *map* whether the frame took a
 * millisecond or a tenth of a second. The keyboard pan it replaces could do
 * neither: it moved a fixed fraction of the span per second, so the ground slid
 * out from under whatever you were aiming at.
 *
 * The direction is "grab the world and drag it", matching the orbit: drag right
 * and the world goes right, so the pivot goes left.
 */
export function trackEditorCamera(
  state: EditorCameraState,
  dxPixels: number,
  dyPixels: number,
  viewportWidthPx: number,
): EditorCameraState {
  const dx = Number.isFinite(dxPixels) ? dxPixels : 0;
  const dy = Number.isFinite(dyPixels) ? dyPixels : 0;
  const width = Number.isFinite(viewportWidthPx) ? viewportWidthPx : 0;
  if ((dx === 0 && dy === 0) || width <= 0) return state;

  const worldPerPixel = (2 * state.halfWidth) / width;
  // The camera sits at +offset from the pivot, so it *looks* along -offset. The
  // ground heading is that direction with its Y dropped and renormalised.
  const forwardX = -Math.cos(state.azimuth);
  const forwardZ = -Math.sin(state.azimuth);
  // The screen's right: the forward heading turned a quarter turn about +Y.
  const rightX = -forwardZ;
  const rightZ = forwardX;

  const across = dx * worldPerPixel;
  // A step along the ground heading only climbs the screen by `sin(elevation)`
  // of itself, so the world distance that answers `dy` pixels is that much
  // longer. Held off the horizon by the floor above.
  const along = (dy * worldPerPixel) / Math.max(DOLLY_MIN_SIN, Math.sin(state.elevation));

  return {
    ...state,
    target: holdPivot(
      {
        x: state.target.x - rightX * across + forwardX * along,
        y: state.target.y,
        z: state.target.z - rightZ * across + forwardZ * along,
      },
      state.bounds,
      state.halfWidth,
    ),
  };
}

/** Wheel zoom, multiplicative over the editor's band (spec 042's step, wider bounds). */
export function zoomEditorCamera(
  state: EditorCameraState,
  deltaY: number,
  deltaMode = 0,
): EditorCameraState {
  return {
    ...state,
    halfWidth: zoomSpan(
      state.halfWidth,
      Number.isFinite(deltaY) ? deltaY : 0,
      deltaMode,
      EDITOR_MIN_HALF_WIDTH,
      state.maxHalfWidth,
      EDITOR_DEFAULT_HALF_WIDTH,
    ),
  };
}

/** Drop the pivot onto a world point, keeping the angles and the zoom. */
export function lookAtEditorCamera(state: EditorCameraState, x: number, y: number, z: number): EditorCameraState {
  return { ...state, target: holdPivot({ x, y, z }, state.bounds, state.halfWidth) };
}

/** Where the camera stands: the pivot plus its orbit offset. */
export function editorCameraPosition(state: EditorCameraState): Vec3 {
  const offset = orbitToOffset({
    azimuth: state.azimuth,
    elevation: state.elevation,
    distance: EDITOR_CAMERA_DISTANCE,
  });
  return {
    x: state.target.x + offset.x,
    y: state.target.y + offset.y,
    z: state.target.z + offset.z,
  };
}
