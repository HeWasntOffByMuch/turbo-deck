/**
 * Smoothing 20Hz deltas into whatever rate the browser paints at (spec 063).
 *
 * The sim runs at 60Hz and describes itself at 20 -- spec 057's rate split --
 * so between two deltas a remote entity has no new authoritative position at
 * all. Drawing the replica raw means every body on screen jumps three ticks'
 * worth of travel five times a second, which is the classic 20Hz stutter and
 * has nothing to do with how well the netcode works.
 *
 * This is **presentation, not state**. The replica goes on holding exactly what
 * the server said; what lives here is a parallel smoothed pose that is only ever
 * read by a mesh's transform. Nothing feeds it back into a decision, which is
 * what keeps the "no `if` in src/render/ changes a game outcome" line intact
 * while the thing on screen is, strictly, never where the server says it is.
 *
 * The local player is not in here. `GameClient` predicts it every tick, so the
 * renderer draws `view().self` directly -- interpolating an already-60Hz
 * position would only add a frame of input lag to the one body that must not
 * have any.
 *
 * Pure: no three.js, no DOM, tested headlessly.
 */

export interface DrawnPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly facing: number;
}

interface Observation extends DrawnPose {
  readonly tick: number;
}

interface Track {
  previous: Observation;
  latest: Observation;
}

const TAU = Math.PI * 2;

/**
 * The signed turn from `from` to `to`, in (-PI, PI].
 *
 * Facing is an angle on the wire and angles wrap, so the naive lerp from 350deg
 * to 10deg walks the long way round: a body that turned 20 degrees is drawn
 * spinning 340 the other way. Every rotation in here goes through this.
 */
export function shortestTurn(from: number, to: number): number {
  let delta = (to - from) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta <= -Math.PI) delta += TAU;
  return delta;
}

/** Interpolate an angle the short way round. */
export function lerpAngle(from: number, to: number, t: number): number {
  return from + shortestTurn(from, to) * t;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export class EntityMotion {
  private readonly tracks = new Map<number, Track>();

  /**
   * Records where the server says an entity is, as of `tick`.
   *
   * The first observation of an entity sets both ends of its track, so a body
   * that has just spawned is drawn standing where it spawned rather than
   * sliding in from wherever the previous slot happened to be.
   *
   * Observations at or before the newest one are ignored: an out-of-order
   * arrival is worse than no arrival, because it would make the entity walk
   * backwards for one interval.
   */
  observe(id: number, x: number, y: number, z: number, facing: number, tick: number): void {
    const next: Observation = { x, y, z, facing, tick };
    const track = this.tracks.get(id);
    if (!track) {
      this.tracks.set(id, { previous: next, latest: next });
      return;
    }
    if (tick < track.latest.tick) return;
    if (tick === track.latest.tick) {
      track.latest = next;
      return;
    }
    track.previous = track.latest;
    track.latest = next;
  }

  /**
   * Where to draw an entity. `alpha` is how far through a delta interval the
   * frame is -- 0 just after one landed, 1 as the next is due.
   *
   * Clamped rather than extrapolated. Past `alpha = 1` the honest answer is "the
   * next delta is late", and holding still for a frame reads far better than
   * inventing travel that then has to be taken back.
   */
  sample(id: number, alpha: number): DrawnPose | null {
    const track = this.tracks.get(id);
    if (!track) return null;
    const t = alpha <= 0 ? 0 : alpha >= 1 ? 1 : alpha;
    const { previous, latest } = track;
    return {
      x: lerp(previous.x, latest.x, t),
      y: lerp(previous.y, latest.y, t),
      z: lerp(previous.z, latest.z, t),
      facing: lerpAngle(previous.facing, latest.facing, t),
    };
  }

  /** The last authoritative pose, unsmoothed -- for anything that must not lag. */
  latest(id: number): DrawnPose | null {
    return this.tracks.get(id)?.latest ?? null;
  }

  has(id: number): boolean {
    return this.tracks.has(id);
  }

  forget(id: number): void {
    this.tracks.delete(id);
  }

  /**
   * Drops every entity not in `live`. The renderer calls this with the ids it
   * still sees, so a despawn removes the track rather than leaving a pose that
   * a later id reuse would inherit.
   */
  retain(live: ReadonlySet<number>): void {
    for (const id of [...this.tracks.keys()]) {
      if (!live.has(id)) this.tracks.delete(id);
    }
  }

  clear(): void {
    this.tracks.clear();
  }
}
