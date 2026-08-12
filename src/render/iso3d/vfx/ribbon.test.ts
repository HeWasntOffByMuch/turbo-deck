import { describe, expect, it } from 'vitest';
import { fallbackSegment, ribbonSegments, MAX_SEGMENTS, SEGMENT_STRIDE } from './ribbon.js';
import { modeCode, MODE_RIBBON } from './batches.js';
import { RENDER } from './compile.js';
import { RIBBON_SAMPLES } from './pool.js';

/** A track laid out the way the pool lays one out: samples, oldest first. */
function track(points: readonly (readonly [number, number, number])[]): Float32Array {
  const samples = new Float32Array(RIBBON_SAMPLES * 3);
  points.forEach(([x, y, z], index) => {
    samples[index * 3] = x;
    samples[index * 3 + 1] = y;
    samples[index * 3 + 2] = z;
  });
  return samples;
}

function out(): Float32Array {
  return new Float32Array(MAX_SEGMENTS * SEGMENT_STRIDE);
}

describe('ribbonSegments', () => {
  it('chains the samples and the head into one segment each', () => {
    const samples = track([
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
    ]);
    const buffer = out();
    const count = ribbonSegments(samples, 0, 3, 30, 0, 0, 4, 0.25, buffer);
    expect(count).toBe(3);
    // The last segment ends at the particle, not at the newest sample: samples
    // are distance-gated, so the head always leads them.
    expect(buffer[2 * SEGMENT_STRIDE + 3]).toBe(30);
  });

  it('meets end to end, so a chain has no seams', () => {
    const samples = track([
      [0, 0, 0],
      [8, 3, 1],
      [15, 4, 3],
      [21, 2, 6],
    ]);
    const buffer = out();
    const count = ribbonSegments(samples, 0, 4, 26, -2, 9, 3, 0.2, buffer);
    for (let s = 0; s + 1 < count; s++) {
      const to = s * SEGMENT_STRIDE + 3;
      const from = (s + 1) * SEGMENT_STRIDE;
      expect([buffer[from], buffer[from + 1], buffer[from + 2]]).toEqual([buffer[to], buffer[to + 1], buffer[to + 2]]);
      // And the widths agree across the join, or the streak steps.
      expect(buffer[s * SEGMENT_STRIDE + 7]).toBeCloseTo(buffer[(s + 1) * SEGMENT_STRIDE + 6] as number, 6);
    }
  });

  it('tapers from the head to the tail, monotonically and never to nothing', () => {
    const samples = track([
      [0, 0, 0],
      [6, 0, 0],
      [12, 0, 0],
      [18, 0, 0],
      [24, 0, 0],
    ]);
    const buffer = out();
    const count = ribbonSegments(samples, 0, 5, 30, 0, 0, 8, 0.25, buffer);

    // The oldest end is the thinnest, the head is full width.
    expect(buffer[6]).toBeCloseTo(2, 6);
    expect(buffer[(count - 1) * SEGMENT_STRIDE + 7]).toBeCloseTo(8, 6);
    for (let s = 0; s < count; s++) {
      const from = buffer[s * SEGMENT_STRIDE + 6] as number;
      const to = buffer[s * SEGMENT_STRIDE + 7] as number;
      expect(to).toBeGreaterThan(from);
      expect(from).toBeGreaterThan(0);
    }
  });

  it('holds a floor under the tail, so it never tapers to sub-pixel', () => {
    // One virtual pixel is about 0.84 world units at the Play tab's default
    // zoom; below that the rasteriser catches a quad in some places and misses
    // it in others, and the streak comes out beaded.
    const samples = track([
      [0, 0, 0],
      [6, 0, 0],
      [12, 0, 0],
    ]);
    const buffer = out();
    ribbonSegments(samples, 0, 3, 18, 0, 0, 6, 0.01, buffer);
    expect(buffer[6]).toBeGreaterThanOrEqual(0.84);
  });

  it('never makes the tail wider than the head', () => {
    // A streak already thinner than the floor has nothing to taper, and a floor
    // applied blindly would draw a wedge pointing backwards.
    const samples = track([
      [0, 0, 0],
      [2, 0, 0],
    ]);
    const buffer = out();
    const count = ribbonSegments(samples, 0, 2, 4, 0, 0, 0.4, 0, buffer);
    for (let s = 0; s < count; s++) {
      // Float32 rounding: the widths are stored in the buffer, so 0.4 comes back
      // as 0.40000000596.
      expect(buffer[s * SEGMENT_STRIDE + 6]).toBeCloseTo(0.4, 5);
      expect(buffer[s * SEGMENT_STRIDE + 7]).toBeCloseTo(0.4, 5);
    }
  });

  it('drops the head link when the newest sample is already the particle', () => {
    // The tick the distance gate fires, the newest sample *is* the position, so
    // that link is a zero-length quad -- one wasted instance per drop per frame.
    const samples = track([
      [0, 0, 0],
      [5, 0, 0],
      [10, 0, 0],
    ]);
    const buffer = out();
    expect(ribbonSegments(samples, 0, 3, 10, 0, 0, 4, 0.3, buffer)).toBe(2);
    // And the streak still reaches the drop.
    expect(buffer[SEGMENT_STRIDE + 3]).toBe(10);
  });

  it('comes back bent when the flight was', () => {
    // A real ballistic sample set: constant horizontal speed, gravity pulling
    // the later samples down. The middle of the chain must sit off the line
    // between its ends -- a straight chain (which is what one stretched quad
    // gives) would score zero here.
    const points: [number, number, number][] = [];
    for (let step = 0; step < 5; step++) {
      const t = step * 0.06;
      points.push([200 * t, 120 * t - 0.5 * 1100 * t * t, 0]);
    }
    const samples = track(points);
    const buffer = out();
    const count = ribbonSegments(samples, 0, 5, 200 * 0.3, 120 * 0.3 - 0.5 * 1100 * 0.09, 0, 4, 0.15, buffer);

    const firstX = buffer[0] as number;
    const firstY = buffer[1] as number;
    const lastX = buffer[(count - 1) * SEGMENT_STRIDE + 3] as number;
    const lastY = buffer[(count - 1) * SEGMENT_STRIDE + 4] as number;
    const midAt = Math.floor(count / 2) * SEGMENT_STRIDE;
    const midX = buffer[midAt] as number;
    const midY = buffer[midAt + 1] as number;

    // Distance from the middle joint to the chord between the two ends.
    const dx = lastX - firstX;
    const dy = lastY - firstY;
    const length = Math.hypot(dx, dy);
    const offLine = Math.abs(dx * (firstY - midY) - (firstX - midX) * dy) / length;
    expect(offLine).toBeGreaterThan(2);
  });

  it('keeps the newest samples when the buffer cannot hold them all', () => {
    const points: [number, number, number][] = [];
    for (let step = 0; step < 6; step++) points.push([step * 5, 0, 0]);
    const samples = track(points);
    const small = new Float32Array(2 * SEGMENT_STRIDE);
    const count = ribbonSegments(samples, 0, 6, 30, 0, 0, 4, 0.2, small);
    expect(count).toBe(2);
    // Dropped the oldest, not the newest: the streak stays attached to the drop.
    expect(small[0]).toBe(20);
    expect(small[SEGMENT_STRIDE + 3]).toBe(30);
  });

  it('reads a track at its own offset in the shared store', () => {
    const samples = new Float32Array(RIBBON_SAMPLES * 3 * 2);
    const base = RIBBON_SAMPLES * 3;
    samples[base] = 100;
    samples[base + 1] = 5;
    samples[base + 2] = -3;
    const buffer = out();
    const count = ribbonSegments(samples, base, 1, 110, 5, -3, 2, 0.5, buffer);
    expect(count).toBe(1);
    expect([buffer[0], buffer[1], buffer[2]]).toEqual([100, 5, -3]);
  });

  it('writes nothing for an empty track', () => {
    expect(ribbonSegments(track([]), 0, 0, 1, 2, 3, 4, 0.2, out())).toBe(0);
  });
});

describe('fallbackSegment', () => {
  it('lays a stub back along the direction of travel', () => {
    const buffer = out();
    const count = fallbackSegment(50, 20, 0, 100, 0, 0, 3, 0.2, buffer);
    expect(count).toBe(1);
    // Ends at the particle, starts behind it.
    expect([buffer[3], buffer[4], buffer[5]]).toEqual([50, 20, 0]);
    expect(buffer[0]).toBeLessThan(50);
    expect(buffer[7]).toBeCloseTo(3, 6);
  });

  it('is never degenerate for a particle that is not moving', () => {
    const buffer = out();
    fallbackSegment(0, 40, 0, 0, 0, 0, 2, 0.2, buffer);
    const dx = (buffer[3] as number) - (buffer[0] as number);
    const dy = (buffer[4] as number) - (buffer[1] as number);
    const dz = (buffer[5] as number) - (buffer[2] as number);
    expect(Math.hypot(dx, dy, dz)).toBeGreaterThan(0);
  });
});

describe('the mode a ribbon draws with', () => {
  it('is its own, and not the billboard it used to fall through to', () => {
    expect(modeCode(RENDER.ribbon)).toBe(MODE_RIBBON);
    expect(modeCode(RENDER.ribbon)).not.toBe(modeCode(RENDER.billboard));
  });
});
