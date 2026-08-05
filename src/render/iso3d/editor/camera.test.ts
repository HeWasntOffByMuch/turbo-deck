import { describe, expect, it } from 'vitest';
import type { MapRect } from '../../../terrain/index.js';
import {
  createEditorCamera,
  editorCameraPosition,
  EDITOR_CAMERA_DISTANCE,
  EDITOR_ELEVATION_MAX,
  EDITOR_ELEVATION_MIN,
  EDITOR_MAX_HALF_WIDTH,
  EDITOR_MIN_HALF_WIDTH,
  lookAtEditorCamera,
  orbitEditorCamera,
  trackEditorCamera,
  wrapAngle,
  zoomEditorCamera,
  type EditorCameraState,
} from './camera.js';

/**
 * Spec 049. The editor camera is the one part of the editor with no visual to
 * check it against -- a camera that is subtly wrong just feels bad to use -- so
 * the rules about where it may go are all stated here.
 */

const BOUNDS: MapRect = { minX: -1600, minZ: -1600, maxX: 2800, maxZ: 2500 };

const fresh = (): EditorCameraState => createEditorCamera({ target: { x: 600, z: 450 }, bounds: BOUNDS });

describe('wrapAngle', () => {
  it('brings any angle into [-PI, PI)', () => {
    for (const a of [0, 0.5, Math.PI, -Math.PI, 7, -7, 1000, -1000]) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThanOrEqual(-Math.PI);
      expect(w).toBeLessThan(Math.PI);
      // Same direction, just named once.
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a), 9);
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a), 9);
    }
  });

  it('resolves a non-finite angle rather than propagating it', () => {
    expect(wrapAngle(NaN)).toBe(0);
    expect(wrapAngle(Infinity)).toBe(0);
  });
});

describe('orbit', () => {
  it('holds the pitch in the band however far it is dragged', () => {
    for (const drag of [1e4, -1e4, 1e9, -1e9]) {
      const s = orbitEditorCamera(fresh(), 0, drag);
      expect(s.elevation).toBeGreaterThanOrEqual(EDITOR_ELEVATION_MIN);
      expect(s.elevation).toBeLessThanOrEqual(EDITOR_ELEVATION_MAX);
    }
  });

  it('never flips over the pole or drops under the ground', () => {
    // Repeated drags in one direction saturate rather than wrapping past vertical.
    let s = fresh();
    for (let i = 0; i < 500; i++) s = orbitEditorCamera(s, 0, 40);
    expect(s.elevation).toBeCloseTo(EDITOR_ELEVATION_MAX, 9);
    for (let i = 0; i < 1000; i++) s = orbitEditorCamera(s, 0, -40);
    expect(s.elevation).toBeCloseTo(EDITOR_ELEVATION_MIN, 9);
  });

  it('keeps the bearing bounded over a long session', () => {
    let s = fresh();
    for (let i = 0; i < 5000; i++) s = orbitEditorCamera(s, 30, 0);
    expect(s.azimuth).toBeGreaterThanOrEqual(-Math.PI);
    expect(s.azimuth).toBeLessThan(Math.PI);
  });

  it('drags the world rather than pushing the camera', () => {
    // Pinned because it is the one thing here with no test to fall back on but
    // how it feels: dragging *down* tips the view toward a plan, dragging *up*
    // drops it toward an elevation. Both axes follow the same rule.
    const s = fresh();
    expect(orbitEditorCamera(s, 0, 60).elevation).toBeGreaterThan(s.elevation);
    expect(orbitEditorCamera(s, 0, -60).elevation).toBeLessThan(s.elevation);
    expect(orbitEditorCamera(s, 60, 0).azimuth).toBeGreaterThan(s.azimuth);
    expect(orbitEditorCamera(s, -60, 0).azimuth).toBeLessThan(s.azimuth);
  });

  it('does not move the pivot or the zoom', () => {
    const before = fresh();
    const after = orbitEditorCamera(before, 120, -80);
    expect(after.target).toEqual(before.target);
    expect(after.halfWidth).toBe(before.halfWidth);
  });

  it('survives a non-finite drag', () => {
    const s = orbitEditorCamera(fresh(), NaN, Infinity);
    expect(Number.isFinite(s.azimuth)).toBe(true);
    expect(Number.isFinite(s.elevation)).toBe(true);
  });
});

describe('track and dolly (spec 058)', () => {
  /** A viewport wide enough that a pixel is a round number of world units. */
  const WIDTH = 1000;

  it('is a grip: one pixel of drag is one pixel of world, across the screen', () => {
    const s = { ...fresh(), halfWidth: 500, azimuth: 0, elevation: Math.PI / 2 };
    // 2 * 500 world units spread over 1000 pixels: one world unit per pixel.
    const after = trackEditorCamera(s, 100, 0, WIDTH);
    expect(Math.hypot(after.target.x - s.target.x, after.target.z - s.target.z)).toBeCloseTo(100, 6);
  });

  it('covers ground in proportion to the zoom, so the grip holds at any span', () => {
    const moved = (halfWidth: number): number => {
      const s = { ...fresh(), halfWidth };
      const after = trackEditorCamera(s, 40, 0, WIDTH);
      return Math.hypot(after.target.x - s.target.x, after.target.z - s.target.z);
    };
    expect(moved(400)).toBeCloseTo(moved(100) * 4, 6);
  });

  it('grabs the world: dragging right moves the pivot left, dragging down moves it away', () => {
    // At azimuth 0 the camera stands along +x and looks back along -x, so its
    // ground heading is -x and its screen-right is -z.
    const s = { ...fresh(), azimuth: 0, elevation: Math.PI / 2 };
    const right = trackEditorCamera(s, 60, 0, WIDTH);
    expect(right.target.z).toBeGreaterThan(s.target.z);
    expect(right.target.x).toBeCloseTo(s.target.x, 6);

    const down = trackEditorCamera(s, 0, 60, WIDTH);
    expect(down.target.x).toBeLessThan(s.target.x);
    expect(down.target.z).toBeCloseTo(s.target.z, 6);
  });

  it('moves in the camera\'s own frame, not the world\'s', () => {
    const straight = trackEditorCamera({ ...fresh(), azimuth: 0, elevation: Math.PI / 2 }, 0, 50, WIDTH);
    const turned = trackEditorCamera({ ...fresh(), azimuth: Math.PI / 2, elevation: Math.PI / 2 }, 0, 50, WIDTH);
    const base = fresh();
    // A quarter turn of the camera turns the same drag a quarter turn.
    expect(straight.target.x - base.target.x).toBeCloseTo(-(50 * 2 * base.halfWidth) / WIDTH, 6);
    expect(turned.target.z - base.target.z).toBeCloseTo(-(50 * 2 * base.halfWidth) / WIDTH, 6);
  });

  it('tracks perpendicular to the dolly, and both cover the same ground overhead', () => {
    const start = { ...fresh(), azimuth: 0.9, elevation: Math.PI / 2 };
    const across = trackEditorCamera(start, 30, 0, WIDTH);
    const along = trackEditorCamera(start, 0, 30, WIDTH);
    const ax = across.target.x - start.target.x;
    const az = across.target.z - start.target.z;
    const lx = along.target.x - start.target.x;
    const lz = along.target.z - start.target.z;
    expect(ax * lx + az * lz).toBeCloseTo(0, 6);
    // Looking straight down there is no foreshortening, so the two match.
    expect(Math.hypot(lx, lz)).toBeCloseTo(Math.hypot(ax, az), 6);
  });

  it('undoes the ground\'s foreshortening when dollying, and stops doing so at the horizon', () => {
    const dolly = (elevation: number): number => {
      const s = { ...fresh(), elevation };
      const after = trackEditorCamera(s, 0, 50, WIDTH);
      return Math.hypot(after.target.x - s.target.x, after.target.z - s.target.z);
    };
    const flat = dolly(Math.PI / 2);
    // A 30-degree pitch squashes the ground to half, so the pivot moves twice as
    // far to keep the same patch of ground under the cursor.
    expect(dolly(Math.PI / 6)).toBeCloseTo(flat * 2, 6);
    // ...but the divisor is floored, so a near-horizon view does not fling it.
    expect(dolly(EDITOR_ELEVATION_MIN)).toBeCloseTo(flat * 4, 6);
  });

  it('is reversible: a drag and its opposite return to the start', () => {
    for (const azimuth of [0, 0.7, 2.4, -1.9, Math.PI / 2]) {
      const start = { ...fresh(), azimuth };
      const there = trackEditorCamera(start, 37, -22, WIDTH);
      const back = trackEditorCamera(there, -37, 22, WIDTH);
      expect(back.target.x).toBeCloseTo(start.target.x, 6);
      expect(back.target.z).toBeCloseTo(start.target.z, 6);
    }
  });

  it('does not change the angles or the zoom', () => {
    const before = fresh();
    const after = trackEditorCamera(before, 40, -30, WIDTH);
    expect(after.azimuth).toBe(before.azimuth);
    expect(after.elevation).toBe(before.elevation);
    expect(after.halfWidth).toBe(before.halfWidth);
  });

  it('moves nothing on a zero drag or a zero-width viewport', () => {
    const s = fresh();
    expect(trackEditorCamera(s, 0, 0, WIDTH)).toBe(s);
    // A canvas that has not been laid out yet must not divide by nothing.
    expect(trackEditorCamera(s, 50, 50, 0)).toBe(s);
  });

  it('holds the pivot over the map however far the drag runs', () => {
    const s = { ...fresh(), halfWidth: EDITOR_MAX_HALF_WIDTH };
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]] as const) {
      let run = s;
      for (let i = 0; i < 400; i++) run = trackEditorCamera(run, dx * 60, dy * 60, WIDTH);
      expect(run.target.x).toBeGreaterThan(BOUNDS.minX - 1000);
      expect(run.target.x).toBeLessThan(BOUNDS.maxX + 1000);
      expect(run.target.z).toBeGreaterThan(BOUNDS.minZ - 1000);
      expect(run.target.z).toBeLessThan(BOUNDS.maxZ + 1000);
    }
  });

  it('lets the pivot roam when no bounds were given', () => {
    let s = createEditorCamera({ halfWidth: 1000 });
    for (let i = 0; i < 200; i++) s = trackEditorCamera(s, 100, 0, WIDTH);
    expect(Math.hypot(s.target.x, s.target.z)).toBeGreaterThan(5000);
  });

  it('survives a non-finite input', () => {
    const s = trackEditorCamera(fresh(), NaN, 30, Infinity);
    expect(Number.isFinite(s.target.x)).toBe(true);
    expect(Number.isFinite(s.target.z)).toBe(true);
  });
});

describe('zoom', () => {
  it('stays inside the editor band', () => {
    let s = fresh();
    for (let i = 0; i < 200; i++) s = zoomEditorCamera(s, 100);
    expect(s.halfWidth).toBeCloseTo(EDITOR_MAX_HALF_WIDTH, 6);
    for (let i = 0; i < 400; i++) s = zoomEditorCamera(s, -100);
    expect(s.halfWidth).toBeCloseTo(EDITOR_MIN_HALF_WIDTH, 6);
  });

  it('opens a wider band than the game\'s, both ways', () => {
    // The point of the editor band: closer than a duel, wider than the arena.
    expect(EDITOR_MIN_HALF_WIDTH).toBeLessThan(200);
    expect(EDITOR_MAX_HALF_WIDTH).toBeGreaterThan(1400);
  });

  it('zooms in on scroll up and out on scroll down', () => {
    const s = fresh();
    expect(zoomEditorCamera(s, -100).halfWidth).toBeLessThan(s.halfWidth);
    expect(zoomEditorCamera(s, 100).halfWidth).toBeGreaterThan(s.halfWidth);
  });

  it('does not move the pivot or the angles', () => {
    const before = fresh();
    const after = zoomEditorCamera(before, -240);
    expect(after.target).toEqual(before.target);
    expect(after.azimuth).toBe(before.azimuth);
    expect(after.elevation).toBe(before.elevation);
  });

  it('survives a non-finite delta', () => {
    expect(Number.isFinite(zoomEditorCamera(fresh(), NaN).halfWidth)).toBe(true);
    expect(Number.isFinite(zoomEditorCamera(fresh(), Infinity).halfWidth)).toBe(true);
  });
});

describe('camera placement', () => {
  it('always stands above its pivot, at the configured distance', () => {
    for (let deg = 3; deg <= 89; deg++) {
      const s = { ...fresh(), elevation: (deg * Math.PI) / 180 };
      const at = editorCameraPosition(s);
      expect(at.y).toBeGreaterThan(s.target.y);
      const offset = Math.hypot(at.x - s.target.x, at.y - s.target.y, at.z - s.target.z);
      expect(offset).toBeCloseTo(EDITOR_CAMERA_DISTANCE, 6);
    }
  });

  it('follows the pivot', () => {
    const s = fresh();
    const moved = lookAtEditorCamera(s, s.target.x + 300, 0, s.target.z - 120);
    const from = editorCameraPosition(s);
    const to = editorCameraPosition(moved);
    expect(to.x - from.x).toBeCloseTo(300, 6);
    expect(to.z - from.z).toBeCloseTo(-120, 6);
  });

  it('holds a look-at outside the map back over it', () => {
    const s = lookAtEditorCamera(fresh(), 1e6, 0, -1e6);
    expect(s.target.x).toBeLessThan(BOUNDS.maxX + 1000);
    expect(s.target.z).toBeGreaterThan(BOUNDS.minZ - 1000);
  });
});

describe('the opening state', () => {
  it('starts in the band, over the point it was given', () => {
    const s = fresh();
    expect(s.target.x).toBe(600);
    expect(s.target.z).toBe(450);
    expect(s.elevation).toBeGreaterThanOrEqual(EDITOR_ELEVATION_MIN);
    expect(s.elevation).toBeLessThanOrEqual(EDITOR_ELEVATION_MAX);
    expect(s.halfWidth).toBeGreaterThanOrEqual(EDITOR_MIN_HALF_WIDTH);
    expect(s.halfWidth).toBeLessThanOrEqual(EDITOR_MAX_HALF_WIDTH);
  });

  it('resolves a nonsense opening request', () => {
    const s = createEditorCamera({ target: { x: NaN, z: Infinity }, halfWidth: NaN, bounds: BOUNDS });
    expect(Number.isFinite(s.target.x)).toBe(true);
    expect(Number.isFinite(s.target.z)).toBe(true);
    expect(Number.isFinite(s.halfWidth)).toBe(true);
  });
});
