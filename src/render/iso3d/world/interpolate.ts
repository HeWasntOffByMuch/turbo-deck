/**
 * Playing the 20Hz wire back at whatever rate the browser paints (specs 063,
 * 253).
 *
 * The sim runs at 60Hz and describes itself at 20 -- spec 057's rate split --
 * so between two deltas a remote entity has no new authoritative position at
 * all. Drawing the replica raw means every body on screen jumps three ticks'
 * worth of travel five times a second, which is the classic 20Hz stutter and
 * has nothing to do with how well the netcode works.
 *
 * Spec 063 bridged that with a ramp from 0 to 1 restarted by each arriving
 * delta, and spec 253 is what was wrong with it: **an arrival is not a clock.**
 * A delta lands on a socket callback whenever the network delivers it, so a
 * ramp zeroed by that carries the wire's jitter plus a frame of quantisation,
 * and it is restarted from a position it had not finished walking to -- early
 * arrivals snap the body forward by whatever was left of the ramp, late ones
 * freeze it at the far end. Measured on an ordinary connection, one frame in
 * ten drew a walking body standing still and one in ten drew it at nearly twice
 * its speed.
 *
 * So a body is drawn **at a time**, and the time comes from a clock this client
 * runs. `advance` moves it, `sample` reads it, and what the wire supplies is a
 * ring of timestamped samples to read *between* rather than a phase to restart.
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
 * Pure: no three.js, no DOM, time is an argument, tested headlessly.
 */

import { BROADCAST_EVERY_N_TICKS, SERVER_TICK_RATE } from '../../../server/config.js';

export interface DrawnPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly facing: number;
}

interface Observation extends DrawnPose {
  readonly tick: number;
}

const TAU = Math.PI * 2;

const TICK_MS = 1000 / SERVER_TICK_RATE;

/**
 * How far behind the newest sample the clock plays, in sim ticks.
 *
 * **Derived, not chosen.** One whole broadcast interval is what guarantees a
 * bracketing pair still exists when a delta is a full interval late; the extra
 * half interval is what centres the clock inside that pair, so jitter has the
 * same headroom early and late. Anything less is asymmetric -- an early arrival
 * has room and a late one clamps, which is the freeze this exists to remove.
 *
 * What it costs is stated in spec 253 rather than hidden: the old ramp averaged
 * `newest - 1.5` ticks, so remote bodies are 50ms further behind than they were.
 * That is presentation only -- spec 221 made reach the answer taken server-side
 * at the tick a wind-up begins, so what is drawn is never what a blow is
 * measured against -- and a wind-up that stutters is harder to read than one
 * that is smooth and 50ms old.
 */
export const PLAYBACK_DELAY_TICKS = BROADCAST_EVERY_N_TICKS * 1.5;

/**
 * How many samples to keep per entity.
 *
 * Five intervals of history at four numbers each. It only has to be deep enough
 * that the clock, sitting 1.5 intervals back, still finds a pair around it after
 * a stall has delivered several deltas at once.
 */
export const OBSERVATION_DEPTH = 6;

/**
 * Past this the wire is not late, it is a different wire -- a hidden tab, a
 * reconnect, a stall long enough that catching up smoothly would be a body
 * sprinting across the map to somewhere it no longer is. The clock is set
 * rather than steered.
 */
const RESYNC_TICKS = BROADCAST_EVERY_N_TICKS * 8;

/**
 * How hard the clock leans on its error, per tick of frame time.
 *
 * What is fed to this is the *low-passed* error, never the raw one: the target
 * is a staircase that jumps a whole interval at a time, and that sawtooth is
 * the shape of the broadcast rather than a fault to correct. A controller given
 * the raw error chases the staircase and oscillates -- measured, that version
 * was three times worse than the ramp it replaced.
 */
const WARP_GAIN = 0.5;

/** The most the clock may run fast or slow. 15% is well under noticing. */
const MAX_WARP = 0.15;

/**
 * The low pass, in ticks. A second of frame time, so several intervals of
 * sawtooth average out and what is left is real disagreement between the
 * server's broadcast clock and this browser's frame clock.
 */
const DRIFT_SMOOTHING_TICKS = 60;

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
  private readonly tracks = new Map<number, Observation[]>();
  /** The newest tick any entity has been observed at -- the clock's target. */
  private newestTick = 0;
  /** The playback head, in fractional sim ticks. */
  private clock = 0;
  private started = false;
  /** The low-passed error the warp is taken from. */
  private drift = 0;

  /**
   * Records where the server says an entity is, as of `tick`.
   *
   * Called for every entity every frame, so most calls are the same tick as the
   * last and land on the in-place branch: the replica reports every body it
   * holds whether or not this delta mentioned it, and a second sample of one
   * tick would collapse the interval being played back.
   *
   * Observations before the newest one are dropped. An out-of-order arrival is
   * worse than no arrival, because it would make the entity walk backwards.
   */
  observe(id: number, x: number, y: number, z: number, facing: number, tick: number): void {
    const next: Observation = { x, y, z, facing, tick };
    if (tick > this.newestTick) {
      this.newestTick = tick;
    } else if (tick + RESYNC_TICKS < this.newestTick) {
      // The wire went *backwards*, by more than a stall could account for. A
      // tick is a server's own count, so the only thing that reads like this is
      // a different server -- a reconnect to one that restarted. Left to grow
      // only, `newestTick` would keep the head permanently past everything the
      // new session ever says, and every remote body would be drawn at its
      // newest sample unsmoothed: the 20Hz stutter back for good, and only for
      // players who had reconnected.
      //
      // Safe against one straggling entity because `observe` is called with the
      // view's single tick for every body in it, so this is the whole replica
      // moving rather than one row of it.
      // Cleared rather than merely rewound: an id that exists in both sessions
      // holds samples from ticks far in this one's future, and `observe` drops
      // anything older than a track's newest -- so that body would refuse every
      // sample the new server ever sent and stand still for the session.
      this.newestTick = tick;
      this.started = false;
      this.tracks.clear();
    }
    const track = this.tracks.get(id);
    if (!track) {
      this.tracks.set(id, [next]);
      return;
    }
    const last = track[track.length - 1] as Observation;
    if (tick < last.tick) return;
    if (tick === last.tick) {
      track[track.length - 1] = next;
      return;
    }
    track.push(next);
    if (track.length > OBSERVATION_DEPTH) track.shift();
  }

  /**
   * Moves the playback head on by `dtMs` of real time. Once a frame, before any
   * sampling.
   *
   * The head free-runs at one tick per tick and is *steered* rather than set:
   * what a delta supplies is a sample of a staircase, so the answer to a clock
   * that has drifted is to run it a few percent fast or slow until it has not.
   * A jump would be the stutter arriving by another door.
   */
  advance(dtMs: number): void {
    const target = this.newestTick - PLAYBACK_DELAY_TICKS;
    if (!this.started) {
      this.resyncTo(target);
      this.started = true;
      return;
    }
    // **The head is only ever set forward.** A head past its target is the
    // ordinary case rather than a fault -- it is what "the server has nothing
    // to say" looks like from here, and every body is correctly held at its
    // newest sample throughout. Setting it back would rewind the head into
    // samples it has already played and draw the body's last movement again,
    // over and over, for as long as the wire stayed quiet.
    if (target - this.clock > RESYNC_TICKS) {
      this.resyncTo(target);
      return;
    }
    const dtTicks = Math.max(0, dtMs) / TICK_MS;
    const smoothing = Math.min(1, dtTicks / DRIFT_SMOOTHING_TICKS);
    this.drift += (target - this.clock - this.drift) * smoothing;
    const warp = Math.max(-MAX_WARP, Math.min(MAX_WARP, this.drift * WARP_GAIN));
    // The lead over the newest sample is bounded by the same number that
    // forgives a stall. Past it the body is being held still anyway, and an
    // unbounded lead is an unbounded recovery once the wire comes back --
    // minutes of running 15% slow to work off a silence nobody watched.
    const ceiling = this.newestTick + RESYNC_TICKS;
    const advanced = this.clock + dtTicks * (1 + warp);
    if (advanced >= ceiling) {
      this.clock = ceiling;
      // Or the bias built up while capped is carried into the recovery.
      this.drift = 0;
      return;
    }
    this.clock = advanced;
  }

  /**
   * Sets the head, and drops the history behind it.
   *
   * A resync says the wire this client is reading is not the one it was reading
   * -- a hidden tab, a reconnect, a stall long enough to give up on. The samples
   * from before it describe a session that is over, and interpolating out of one
   * would walk the body across the map from wherever it used to be.
   */
  private resyncTo(target: number): void {
    this.clock = target;
    this.drift = 0;
    for (const [id, track] of this.tracks) {
      if (track.length > 1) this.tracks.set(id, [track[track.length - 1] as Observation]);
    }
  }

  /**
   * Where to draw an entity, at the playback head.
   *
   * Interpolated over the *tick span* of the pair the head sits between, so a
   * gap twice as wide takes twice as long to play back -- which is what a fixed
   * ramp could not say, and what turned a stall into a sprint.
   *
   * Clamped rather than extrapolated. Past the newest sample the honest answer
   * is "the next delta is late", and holding still reads far better than
   * inventing travel that then has to be taken back.
   */
  sample(id: number): DrawnPose | null {
    const track = this.tracks.get(id);
    if (!track || track.length === 0) return null;
    const newest = track[track.length - 1] as Observation;
    if (track.length === 1) return poseOf(newest);

    const head = this.clock;
    if (head >= newest.tick) return poseOf(newest);
    const oldest = track[0] as Observation;
    if (head <= oldest.tick) return poseOf(oldest);

    let lo = oldest;
    let hi = track[1] as Observation;
    for (let i = 0; i + 1 < track.length; i += 1) {
      lo = track[i] as Observation;
      hi = track[i + 1] as Observation;
      if (head <= hi.tick) break;
    }
    const span = hi.tick - lo.tick;
    const t = span <= 0 ? 1 : Math.max(0, Math.min(1, (head - lo.tick) / span));
    return {
      x: lerp(lo.x, hi.x, t),
      y: lerp(lo.y, hi.y, t),
      z: lerp(lo.z, hi.z, t),
      facing: lerpAngle(lo.facing, hi.facing, t),
    };
  }

  /** The last authoritative pose, unsmoothed -- for anything that must not lag. */
  latest(id: number): DrawnPose | null {
    const track = this.tracks.get(id);
    if (!track || track.length === 0) return null;
    return poseOf(track[track.length - 1] as Observation);
  }

  /** Where the playback head is, in fractional sim ticks. For tests and probes. */
  playbackTick(): number {
    return this.clock;
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
    this.newestTick = 0;
    this.clock = 0;
    this.started = false;
    this.drift = 0;
  }
}

function poseOf(observation: Observation): DrawnPose {
  return {
    x: observation.x,
    y: observation.y,
    z: observation.z,
    facing: observation.facing,
  };
}
