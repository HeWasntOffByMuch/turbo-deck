import type { Vec2 } from '../../sim/types.js';

/**
 * The canonical 2:1 isometric world->screen mapping for the scene (spec 018),
 * kept as a pure, dependency-free function so it is trivially reproducible and
 * unit-testable in Node. The three.js `OrthographicCamera` renders the real 3D
 * geometry at the same fixed angle; this helper is the same mapping expressed
 * as flat math for any 2D overlay/aim work and for the determinism test.
 */

export interface IsoParams {
  /** Screen pixel that world origin (0,0) maps to. */
  readonly originX: number;
  readonly originY: number;
  /** Horizontal world-unit -> screen-pixel scale (halved per iso axis). */
  readonly scaleX: number;
  /** Vertical scale; 0.5 * scaleX gives a classic 2:1 isometric look. */
  readonly scaleY: number;
}

export const DEFAULT_ISO: IsoParams = { originX: 0, originY: 0, scaleX: 1, scaleY: 0.5 };

/**
 * Project a ground-plane world position to isometric screen space. Pure: the
 * same `(pos, params)` always yields the same point, so anything derived from
 * it (e.g. an aim vector) stays reproducible.
 */
export function worldToIso(pos: Vec2, params: IsoParams = DEFAULT_ISO): Vec2 {
  return {
    x: params.originX + (pos.x - pos.y) * (params.scaleX / 2),
    y: params.originY + (pos.x + pos.y) * (params.scaleY / 2),
  };
}
