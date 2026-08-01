import { snoise, snoise2 } from '../noise.js';
import type { RobeTuning } from './params.js';

/**
 * The procedural wind field driving the robe (spec 046).
 *
 * Pure and dependency-free: it owns a clock and a smoothed wind vector, and is
 * advanced with `update(dt, tuning)`. Everything the tuning asks for -- a change
 * of direction, of strength, or switching the wind off entirely -- is *eased*
 * toward rather than applied: a wind that snapped would yank the whole robe
 * sideways in one frame, which never happens outdoors and reads immediately as
 * fake.
 *
 * The shape of the wind is three layers:
 *  - a **sustained** speed and heading from the tuning,
 *  - a **gust envelope**, two octaves of value noise at `gustFrequency`, adding
 *    up to `gustStrength` on top (and never subtracting below zero),
 *  - **turbulence**, a slow wander of the heading plus a per-particle variation
 *    factor the solver applies so a single panel is not pushed as one rigid
 *    sheet.
 *
 * Deterministic: same seed, same `dt` sequence, same tuning => same wind.
 */
export class WindField {
  /** Current wind velocity in world units/s. Read by the solver each step. */
  vx = 0;
  vy = 0;
  vz = 0;
  /**
   * Per-particle variation (0..1) the solver multiplies its wind sample by:
   * `1 + turbulence * noise`. Surfaced here rather than baked into the vector so
   * the solver can vary it *across* a panel, not just over time.
   */
  turbulence = 0;

  /** Smoothed scalars behind the vector, so direction/strength ease independently. */
  private speed = 0;
  private heading = 0;
  private clock = 0;
  /** Decaying one-shot gust from {@link gust}, in world units/s. */
  private burst = 0;
  private started = false;

  constructor(private readonly seed = 1337) {}

  /** Current wind speed (world units/s), for the debug readout. */
  get strength(): number {
    return Math.hypot(this.vx, this.vy, this.vz);
  }

  /** Current wind heading in degrees, for the debug readout. */
  get headingDeg(): number {
    return (Math.atan2(this.vz, this.vx) * 180) / Math.PI;
  }

  /**
   * Kick a one-shot gust of `strength` world units/s on top of the sustained
   * wind; it decays away over about a second. Used by the sandbox's "Gust"
   * button to watch the robe react to a discrete event.
   */
  gust(strength: number): void {
    if (!Number.isFinite(strength)) return;
    this.burst = Math.max(this.burst, strength);
  }

  /**
   * Advance the field by `dt` seconds. `windTransition` sets how fast the
   * smoothed speed/heading chase their targets; disabling the wind targets zero
   * speed rather than zeroing the vector, so it dies away instead of stopping.
   */
  update(dt: number, t: RobeTuning): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    // Cap the step so a tab-switch stall cannot jump the gust noise a long way.
    const h = Math.min(dt, 0.25);
    this.clock += h;

    const enabled = t.windEnabled >= 0.5;
    // Gust envelope in [0, 1]: two octaves so a swell carries a faster flutter.
    const env = Math.max(0, snoise2(this.seed, this.clock * t.gustFrequency));
    const targetSpeed = enabled ? t.windStrength + env * t.gustStrength : 0;

    // Heading wanders slowly with turbulence; the base direction comes from the
    // tuning. Chased as a continuous angle (no wrap) so a slider drag past 180
    // degrees eases the short way rather than spinning the wind around.
    const wander = snoise(this.seed + 977, this.clock * 0.19) * t.windTurbulence * 0.8;
    const targetHeading = (t.windDirection * Math.PI) / 180 + wander;

    if (!this.started) {
      // First frame: adopt the target outright rather than easing up from zero,
      // so the robe is already settled in the wind when the view opens.
      this.speed = targetSpeed;
      this.heading = targetHeading;
      this.started = true;
    }

    const ease = 1 - Math.exp(-t.windTransition * h);
    this.speed += (targetSpeed - this.speed) * ease;
    // Shortest-arc chase, so 359 -> 1 degrees crosses zero instead of unwinding.
    let dh = (targetHeading - this.heading) % (Math.PI * 2);
    if (dh > Math.PI) dh -= Math.PI * 2;
    if (dh < -Math.PI) dh += Math.PI * 2;
    this.heading += dh * ease;

    // One-shot gusts decay on their own timescale, independent of the easing.
    this.burst *= Math.exp(-2.2 * h);
    if (this.burst < 0.01) this.burst = 0;

    const speed = this.speed + (enabled || this.burst > 0 ? this.burst : 0);
    this.vx = Math.cos(this.heading) * speed;
    this.vz = Math.sin(this.heading) * speed;
    // A slight updraft/downdraft so gusts lift hems rather than only pushing
    // them flat: small, slow, and proportional to the wind actually blowing.
    this.vy = snoise(this.seed + 4231, this.clock * 0.27) * speed * 0.12 * t.windTurbulence;

    this.turbulence = t.windTurbulence;
  }
}
