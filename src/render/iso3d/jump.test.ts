import { describe, expect, it } from 'vitest';
import { JumpMotion } from './jump.js';

/**
 * The figure's cosmetic hop (spec 046). It exists so the cloth can be driven
 * against jumping, falling and landing, so what has to hold is that a hop is a
 * clean, single, repeatable event: it comes back down, it reports exactly one
 * landing, and it cannot be stacked mid-air into a rocket.
 */

const G = 422; // ~9.81 m/s^2 at 43 world units per metre

/** Run to touchdown, returning the peak height and the landing speed. */
function hop(m: JumpMotion, height: number, dt = 1 / 60): { peak: number; landings: number; speed: number } {
  m.trigger(height, G);
  let peak = 0;
  let landings = 0;
  let speed = 0;
  for (let i = 0; i < 2000; i++) {
    const e = m.update(dt, G);
    peak = Math.max(peak, m.y);
    if (e.landingSpeed > 0) {
      landings++;
      speed = e.landingSpeed;
    }
  }
  return { peak, landings, speed };
}

describe('JumpMotion', () => {
  it('starts grounded and still', () => {
    const m = new JumpMotion();
    expect(m.y).toBe(0);
    expect(m.airborne).toBe(false);
    expect(m.state).toBe('grounded');
  });

  it('reaches roughly the requested height and comes back down', () => {
    const m = new JumpMotion();
    const r = hop(m, 60);
    // Discrete integration undershoots slightly; within 10% is plenty.
    expect(r.peak).toBeGreaterThan(54);
    expect(r.peak).toBeLessThan(66);
    expect(m.y).toBe(0);
    expect(m.state).toBe('grounded');
  });

  it('reports exactly one landing, at about the launch speed', () => {
    const m = new JumpMotion();
    const r = hop(m, 60);
    expect(r.landings).toBe(1);
    // Explicit Euler bleeds a few percent off the arc; it must not bleed more,
    // and it must never come down *faster* than it went up.
    const launch = Math.sqrt(2 * G * 60);
    expect(r.speed).toBeGreaterThan(launch * 0.94);
    expect(r.speed).toBeLessThanOrEqual(launch);
  });

  it('reports the launch on exactly one frame', () => {
    const m = new JumpMotion();
    m.trigger(50, G);
    let launches = 0;
    for (let i = 0; i < 400; i++) if (m.update(1 / 60, G).launched) launches++;
    expect(launches).toBe(1);
  });

  it('ignores a trigger while airborne', () => {
    const m = new JumpMotion();
    expect(m.trigger(50, G)).toBe(true);
    m.update(1 / 60, G);
    expect(m.trigger(50, G)).toBe(false);
    expect(m.drop(500)).toBe(false);
  });

  it('rejects a nonsense jump', () => {
    const m = new JumpMotion();
    expect(m.trigger(0, G)).toBe(false);
    expect(m.trigger(Number.NaN, G)).toBe(false);
    expect(m.trigger(50, 0)).toBe(false);
    expect(m.y).toBe(0);
  });

  it('falls from a drop and lands harder from higher up', () => {
    const low = new JumpMotion();
    const high = new JumpMotion();
    low.drop(40);
    high.drop(300);
    const land = (m: JumpMotion): number => {
      for (let i = 0; i < 3000; i++) {
        const e = m.update(1 / 60, G);
        if (e.landingSpeed > 0) return e.landingSpeed;
      }
      return 0;
    };
    const lowSpeed = land(low);
    const highSpeed = land(high);
    expect(lowSpeed).toBeGreaterThan(0);
    expect(highSpeed).toBeGreaterThan(lowSpeed * 2);
  });

  it('crouches on landing and eases back out', () => {
    const m = new JumpMotion();
    m.drop(200);
    let crouched = 0;
    for (let i = 0; i < 3000; i++) {
      m.update(1 / 60, G);
      crouched = Math.max(crouched, m.crouch);
    }
    expect(crouched).toBeGreaterThan(0.3);
    expect(m.crouch).toBe(0);
    expect(m.state).toBe('grounded');
  });

  it('never lets the crouch exceed 1, however far it falls', () => {
    const m = new JumpMotion();
    m.drop(5000);
    for (let i = 0; i < 5000; i++) {
      m.update(1 / 60, G);
      expect(m.crouch).toBeLessThanOrEqual(1);
    }
  });

  it('holds still on a paused frame', () => {
    const m = new JumpMotion();
    m.trigger(60, G);
    for (let i = 0; i < 10; i++) m.update(1 / 60, G);
    const y = m.y;
    m.update(0, G);
    m.update(Number.NaN, G);
    m.update(-1, G);
    expect(m.y).toBe(y);
  });

  it('lands at the same place at a different frame rate', () => {
    const a = new JumpMotion();
    const b = new JumpMotion();
    const fast = hop(a, 80, 1 / 144);
    const slow = hop(b, 80, 1 / 30);
    expect(fast.peak).toBeCloseTo(slow.peak, -1);
    expect(fast.landings).toBe(1);
    expect(slow.landings).toBe(1);
  });
});
