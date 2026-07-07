import { describe, expect, it } from 'vitest';
import {
  dealTransform,
  easeInCubic,
  easeOutBack,
  idleTransform,
  IDLE_BOB_PX,
  IDLE_TILT_RAD,
  playTransform,
  REST_TRANSFORM,
} from './card-anim.js';

describe('easing helpers', () => {
  it('fix the endpoints at 0 and 1', () => {
    expect(easeInCubic(0)).toBeCloseTo(0);
    expect(easeInCubic(1)).toBeCloseTo(1);
    expect(easeOutBack(0)).toBeCloseTo(0);
    expect(easeOutBack(1)).toBeCloseTo(1);
  });

  it('easeOutBack overshoots past 1 somewhere in (0,1)', () => {
    let sawOvershoot = false;
    for (let t = 0.5; t < 1; t += 0.01) {
      if (easeOutBack(t) > 1) sawOvershoot = true;
    }
    expect(sawOvershoot).toBe(true);
  });
});

describe('idleTransform', () => {
  it('stays within the bob/tilt bounds for all times', () => {
    for (let slot = 0; slot < 3; slot++) {
      for (let ms = 0; ms < 20000; ms += 37) {
        const tf = idleTransform(slot, ms);
        expect(Math.abs(tf.offsetY)).toBeLessThanOrEqual(IDLE_BOB_PX + 1e-9);
        expect(Math.abs(tf.rotation)).toBeLessThanOrEqual(IDLE_TILT_RAD + 1e-9);
        expect(tf.scale).toBe(1);
        expect(tf.alpha).toBe(1);
      }
    }
  });

  it('phase-offsets the slots so they do not move in lockstep', () => {
    const a = idleTransform(0, 500);
    const b = idleTransform(1, 500);
    const c = idleTransform(2, 500);
    expect(a.offsetY).not.toBeCloseTo(b.offsetY);
    expect(b.offsetY).not.toBeCloseTo(c.offsetY);
  });
});

describe('playTransform', () => {
  it('starts at rest', () => {
    const start = playTransform(0);
    expect(start.offsetX).toBeCloseTo(REST_TRANSFORM.offsetX);
    expect(start.offsetY).toBeCloseTo(REST_TRANSFORM.offsetY);
    expect(start.rotation).toBeCloseTo(REST_TRANSFORM.rotation);
    expect(start.scale).toBeCloseTo(REST_TRANSFORM.scale);
    expect(start.alpha).toBeCloseTo(REST_TRANSFORM.alpha);
  });

  it('ends fully faded, lifted and enlarged', () => {
    const end = playTransform(1);
    expect(end.alpha).toBe(0);
    expect(end.offsetY).toBeLessThan(0);
    expect(end.scale).toBeGreaterThan(1);
  });

  it('fades monotonically (non-increasing alpha)', () => {
    let prev = playTransform(0).alpha;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const alpha = playTransform(t).alpha;
      expect(alpha).toBeLessThanOrEqual(prev + 1e-9);
      prev = alpha;
    }
  });
});

describe('dealTransform', () => {
  it('starts below, shrunk and transparent', () => {
    const start = dealTransform(0);
    expect(start.offsetY).toBeGreaterThan(0);
    expect(start.scale).toBeLessThan(1);
    expect(start.alpha).toBe(0);
  });

  it('settles exactly at rest', () => {
    const end = dealTransform(1);
    expect(end.offsetX).toBeCloseTo(REST_TRANSFORM.offsetX);
    expect(end.offsetY).toBeCloseTo(REST_TRANSFORM.offsetY);
    expect(end.rotation).toBeCloseTo(REST_TRANSFORM.rotation);
    expect(end.scale).toBeCloseTo(REST_TRANSFORM.scale);
    expect(end.alpha).toBeCloseTo(REST_TRANSFORM.alpha);
  });
});
