/**
 * A critically damped spring, in closed form. Given a target each frame it eases
 * `value` toward it while carrying velocity, so animation offsets (bob, sway,
 * pitch, roll, height, lean) settle smoothly and never snap. The analytic
 * solution is unconditionally stable for any `dt` -- no sub-stepping, no blow-up
 * at low frame rates -- which matters because the render loop's `dt` is variable.
 *
 * Pure numeric helper: no three.js, no sim state, no clock. Shared by the mech
 * rigs (spec 033) and the robed figure (spec 037); unit-tested in
 * `src/render/spring.test.ts`.
 */
const TWO_PI = Math.PI * 2;

export class Spring {
  private vel = 0;
  constructor(
    public value = 0,
    private freq = 4,
  ) {}

  /** Retune stiffness (natural frequency in Hz); higher = snappier settling. */
  setFreq(freq: number): void {
    this.freq = freq;
  }

  /** Advance one step of `dt` seconds toward `target`. */
  track(target: number, dt: number): void {
    const omega = TWO_PI * this.freq;
    const c1 = this.value - target;
    const c2 = this.vel + omega * c1;
    const e = Math.exp(-omega * dt);
    this.value = target + (c1 + c2 * dt) * e;
    this.vel = (c2 - omega * (c1 + c2 * dt)) * e;
  }
}

