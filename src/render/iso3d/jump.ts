/**
 * The robed figure's vertical motion (spec 037): a small ballistic hop plus a
 * landing recovery, used to exercise the cloth against jumping, falling and
 * landing.
 *
 * **This is cosmetic only.** The combat sim has no notion of height, so nothing
 * here reads or writes sim state and no game outcome depends on it -- it is a
 * renderer-side offset applied to the character's root, in the same category as
 * the mech's body bob. If jumping ever becomes a real mechanic it belongs in
 * `src/sim/`, and this class becomes the thing that *reads* it.
 *
 * Pure: no three.js, no clock, no randomness. `update` is a function of
 * `(state, dt, gravity)`, so a hop replays identically and is unit-testable.
 */

/** What happened during one {@link JumpMotion.update}. Reused, never allocated. */
export interface JumpEvents {
  /** True on the frame the figure left the ground. */
  launched: boolean;
  /** Downward speed on the frame it touched down (0 on every other frame). */
  landingSpeed: number;
}

export type JumpPhase = 'grounded' | 'rising' | 'falling' | 'recovering';

export class JumpMotion {
  /** Height above the ground in world units. */
  y = 0;
  /** Vertical velocity in world units/s. */
  vy = 0;
  /** 0..1 landing crouch, spiking on touchdown and easing back out. */
  crouch = 0;

  private phase: JumpPhase = 'grounded';
  private readonly events: JumpEvents = { launched: false, landingSpeed: 0 };

  /** Whether the figure is off the ground (the rig tucks the legs when it is). */
  get airborne(): boolean {
    return this.phase === 'rising' || this.phase === 'falling';
  }

  get state(): JumpPhase {
    return this.phase;
  }

  /**
   * Hop to `height` world units, given `gravity`. Ignored while already
   * airborne -- no double jumps, and no way to stack launch impulses.
   */
  trigger(height: number, gravity: number): boolean {
    if (this.airborne) return false;
    if (!(height > 0) || !(gravity > 0)) return false;
    // v = sqrt(2gh): the launch speed that peaks at exactly `height`.
    this.vy = Math.sqrt(2 * gravity * height);
    this.phase = 'rising';
    return true;
  }

  /**
   * Teleport to `height` with no upward velocity, to watch a long fall. Also
   * ignored while airborne, so it cannot be used to accumulate height.
   */
  drop(height: number): boolean {
    if (this.airborne) return false;
    if (!(height > 0)) return false;
    this.y = height;
    this.vy = 0;
    this.phase = 'falling';
    return true;
  }

  /** Advance one frame. The returned object is reused; read it before the next call. */
  update(dt: number, gravity: number): JumpEvents {
    const e = this.events;
    e.launched = false;
    e.landingSpeed = 0;
    if (!Number.isFinite(dt) || dt <= 0) return e;
    const h = Math.min(dt, 0.1);
    const g = Number.isFinite(gravity) && gravity > 0 ? gravity : 0;

    if (this.phase === 'rising' && this.y <= 0 && this.vy > 0) e.launched = true;

    if (this.airborne) {
      this.vy -= g * h;
      this.y += this.vy * h;
      if (this.vy <= 0 && this.phase === 'rising') this.phase = 'falling';
      if (this.y <= 0) {
        e.landingSpeed = Math.max(0, -this.vy);
        this.y = 0;
        this.vy = 0;
        this.phase = 'recovering';
        // Crouch depth scales with impact, saturating so a long fall does not
        // fold the figure through the floor.
        this.crouch = Math.min(1, e.landingSpeed / 260);
      }
    } else {
      this.y = 0;
      this.vy = 0;
    }

    // Ease the crouch back out; once it is gone the figure is grounded again.
    if (this.crouch > 0) {
      this.crouch *= Math.exp(-7 * h);
      if (this.crouch < 0.01) this.crouch = 0;
    }
    if (this.phase === 'recovering' && this.crouch === 0) this.phase = 'grounded';

    return e;
  }
}
