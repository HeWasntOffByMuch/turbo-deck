import { describe, expect, it } from 'vitest';
import { EntityMotion, lerpAngle, shortestTurn } from './interpolate.js';

const DEG = Math.PI / 180;

describe('shortestTurn', () => {
  it('takes the short way across the wrap', () => {
    expect(shortestTurn(350 * DEG, 10 * DEG)).toBeCloseTo(20 * DEG, 9);
    expect(shortestTurn(10 * DEG, 350 * DEG)).toBeCloseTo(-20 * DEG, 9);
  });

  it('stays within half a turn', () => {
    for (let from = -720; from <= 720; from += 17) {
      for (let to = -720; to <= 720; to += 23) {
        const delta = shortestTurn(from * DEG, to * DEG);
        expect(Math.abs(delta)).toBeLessThanOrEqual(Math.PI + 1e-9);
      }
    }
  });
});

describe('lerpAngle', () => {
  it('passes through zero rather than backwards through pi', () => {
    const mid = lerpAngle(350 * DEG, 10 * DEG, 0.5);
    // 350 -> 10 the short way is through 360/0.
    expect(mid).toBeCloseTo(360 * DEG, 9);
    // ...and emphatically not through 180.
    expect(Math.abs(mid - 180 * DEG)).toBeGreaterThan(Math.PI / 2);
  });
});

describe('EntityMotion', () => {
  it('draws a body it has seen once standing still', () => {
    const motion = new EntityMotion();
    motion.observe(1, 100, 50, 4, 0, 30);

    for (const alpha of [0, 0.5, 1]) {
      expect(motion.sample(1, alpha)).toEqual({ x: 100, y: 50, z: 4, facing: 0 });
    }
  });

  it('reaches the latest observation exactly at alpha 1', () => {
    const motion = new EntityMotion();
    motion.observe(1, 0, 0, 0, 0, 0);
    motion.observe(1, 30, -12, 5, 1, 3);

    expect(motion.sample(1, 1)).toEqual({ x: 30, y: -12, z: 5, facing: 1 });
  });

  it('is monotone between two observations and never overshoots', () => {
    const motion = new EntityMotion();
    motion.observe(1, 0, 0, 0, 0, 0);
    motion.observe(1, 30, 60, 9, 0, 3);

    let previousX = -Infinity;
    for (let alpha = 0; alpha <= 1.0001; alpha += 0.05) {
      const pose = motion.sample(1, alpha);
      expect(pose).not.toBeNull();
      if (!pose) return;
      expect(pose.x).toBeGreaterThanOrEqual(previousX - 1e-9);
      expect(pose.x).toBeLessThanOrEqual(30 + 1e-9);
      expect(pose.y).toBeLessThanOrEqual(60 + 1e-9);
      previousX = pose.x;
    }
  });

  it('clamps past the end rather than extrapolating a late delta', () => {
    const motion = new EntityMotion();
    motion.observe(1, 0, 0, 0, 0, 0);
    motion.observe(1, 30, 0, 0, 0, 3);

    expect(motion.sample(1, 4)?.x).toBe(30);
    expect(motion.sample(1, -2)?.x).toBe(0);
  });

  it('walks forward across a stream of deltas three ticks apart', () => {
    const motion = new EntityMotion();
    for (let tick = 0; tick <= 30; tick += 3) motion.observe(1, tick * 2, 0, 0, 0, tick);

    // Having consumed the whole stream, the drawn body is at the last position.
    expect(motion.sample(1, 1)?.x).toBe(60);
    // ...and mid-interval it is one interval behind, not ahead of the server.
    expect(motion.sample(1, 0)?.x).toBe(54);
    expect(motion.sample(1, 0.5)?.x).toBe(57);
  });

  it('ignores an observation older than the newest one', () => {
    const motion = new EntityMotion();
    motion.observe(1, 0, 0, 0, 0, 0);
    motion.observe(1, 30, 0, 0, 0, 6);
    motion.observe(1, 15, 0, 0, 0, 3);

    expect(motion.sample(1, 1)?.x).toBe(30);
    expect(motion.sample(1, 0)?.x).toBe(0);
  });

  it('replaces an observation for the tick it already holds', () => {
    const motion = new EntityMotion();
    motion.observe(1, 0, 0, 0, 0, 0);
    motion.observe(1, 30, 0, 0, 0, 3);
    motion.observe(1, 33, 0, 0, 0, 3);

    // The correction lands, and the interval it interpolates over is unchanged.
    expect(motion.sample(1, 1)?.x).toBe(33);
    expect(motion.sample(1, 0)?.x).toBe(0);
  });

  it('turns the short way between deltas', () => {
    const motion = new EntityMotion();
    motion.observe(1, 0, 0, 0, 350 * DEG, 0);
    motion.observe(1, 0, 0, 0, 10 * DEG, 3);

    expect(motion.sample(1, 0.5)?.facing).toBeCloseTo(360 * DEG, 9);
  });

  it('forgets a despawned body rather than holding a stale pose', () => {
    const motion = new EntityMotion();
    motion.observe(1, 5, 5, 0, 0, 0);
    motion.forget(1);

    expect(motion.sample(1, 0.5)).toBeNull();
    expect(motion.has(1)).toBe(false);
  });

  it('retains only the entities still on screen', () => {
    const motion = new EntityMotion();
    motion.observe(1, 0, 0, 0, 0, 0);
    motion.observe(2, 0, 0, 0, 0, 0);
    motion.observe(3, 0, 0, 0, 0, 0);

    motion.retain(new Set([2]));

    expect(motion.sample(1, 0)).toBeNull();
    expect(motion.sample(2, 0)).not.toBeNull();
    expect(motion.sample(3, 0)).toBeNull();
  });

  it('reports the newest pose unsmoothed', () => {
    const motion = new EntityMotion();
    motion.observe(1, 0, 0, 0, 0, 0);
    motion.observe(1, 30, 0, 0, 0, 3);

    expect(motion.latest(1)?.x).toBe(30);
    expect(motion.latest(99)).toBeNull();
  });
});
