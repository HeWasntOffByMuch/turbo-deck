import type { Vec2 } from '../../sim/types.js';
import type { GaitInput } from './humanoid.js';

/**
 * Turns the two numbers a scene hands a unit -- where it is and which way it
 * faces -- into the four the walk cycle wants: speed, forward acceleration, turn
 * rate and distance travelled.
 *
 * Every rig that walks needs this and none of them should own it. The sim never
 * publishes a velocity (it publishes positions, and the renderer is downstream of
 * that by design), so the rig has to differentiate, and differentiating a
 * position that can also *teleport* -- a respawn, a scene switch -- is where the
 * bugs are: one frame of un-smoothed delta becomes a 4000 unit/s sprint and the
 * character's legs blur for half a second.
 *
 * Deliberately not stateful about anything but motion: no sim reads, no time
 * reads, nothing that would make a rig's appearance depend on when it was built.
 * Given the same `(dt, pos, ry)` sequence it produces the same gait every time.
 */

/** Exponential smoothing rates (1/s) for the observed velocity and acceleration. */
const VEL_SMOOTH = 22;
const ACC_SMOOTH = 14;
/**
 * A single-frame move longer than this is a teleport, not a run: the observer
 * re-seeds from the new position instead of reporting an impossible speed.
 */
const TELEPORT_DISTANCE = 400;

/** Shortest signed angle from `a` to `b`, in (-PI, PI]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class MotionObserver {
  /** The gait this observed. Reused in place, so it allocates nothing per frame. */
  readonly gait: GaitInput = { speed: 0, accel: 0, turnRate: 0, distance: 0 };

  private prevX: number | null = null;
  private prevZ = 0;
  private prevRy = 0;
  private velX = 0;
  private velZ = 0;
  private accX = 0;
  private accZ = 0;

  /** Observed ground speed in world units/s, after smoothing. */
  get speed(): number {
    return this.gait.speed;
  }

  /** Observed yaw rate in rad/s (positive turns the figure's left). */
  get turnRate(): number {
    return this.gait.turnRate;
  }

  /**
   * Fold this frame in and return the resulting gait. `dt` is elapsed *render*
   * time, so slow motion slows the character rather than teleporting it.
   */
  observe(dt: number, pos: Vec2, ry: number): GaitInput {
    const h = Math.max(1e-4, Math.min(dt, 0.1));
    const g = this.gait;

    if (this.prevX === null) {
      this.prevX = pos.x;
      this.prevZ = pos.y;
      this.prevRy = ry;
      g.speed = 0;
      g.accel = 0;
      g.turnRate = 0;
      g.distance = 0;
      return g;
    }

    const dx = pos.x - this.prevX;
    const dz = pos.y - this.prevZ;
    const moved = Math.hypot(dx, dz);
    this.prevX = pos.x;
    this.prevZ = pos.y;

    if (moved > TELEPORT_DISTANCE) {
      // Re-seed rather than report a sprint: the character was moved, not run.
      this.velX = 0;
      this.velZ = 0;
      this.accX = 0;
      this.accZ = 0;
      this.prevRy = ry;
      g.speed = 0;
      g.accel = 0;
      g.turnRate = 0;
      g.distance = 0;
      return g;
    }

    const instVelX = dx / h;
    const instVelZ = dz / h;
    const kv = Math.min(1, h * VEL_SMOOTH);
    const prevVelX = this.velX;
    const prevVelZ = this.velZ;
    this.velX += (instVelX - this.velX) * kv;
    this.velZ += (instVelZ - this.velZ) * kv;

    const ka = Math.min(1, h * ACC_SMOOTH);
    this.accX += ((this.velX - prevVelX) / h - this.accX) * ka;
    this.accZ += ((this.velZ - prevVelZ) / h - this.accZ) * ka;

    const speed = Math.hypot(this.velX, this.velZ);
    // Acceleration projected onto the direction of travel: what leans the body
    // forward. Sideways acceleration is a turn, and is reported as one.
    const accel = speed > 1e-3 ? (this.accX * this.velX + this.accZ * this.velZ) / speed : 0;

    const dRy = angleDelta(this.prevRy, ry);
    this.prevRy = ry;

    g.speed = speed;
    g.accel = accel;
    // The scene sets `group.rotation.y = -facing`, so a rising `ry` is a turn to
    // the figure's left, which is the sign the gait's bank expects.
    g.turnRate = dRy / h;
    g.distance = moved;
    return g;
  }
}
