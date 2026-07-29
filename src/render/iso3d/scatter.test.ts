import { describe, expect, it } from 'vitest';
import type { Vec2 } from '../../sim/types.js';
import { scatterProps } from './scatter.js';

const W = 1200;
const H = 900;
const KEEP_OUT: Vec2[] = [{ x: W / 2, y: H / 2 }];

describe('scatterProps', () => {
  it('is deterministic: same (seed, bounds) replays an identical prop list', () => {
    const a = scatterProps(1234, W, H, KEEP_OUT);
    const b = scatterProps(1234, W, H, KEEP_OUT);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('keeps every prop inside the margin-inset bounds', () => {
    const props = scatterProps(7, W, H, KEEP_OUT, { margin: 60 });
    for (const p of props) {
      expect(p.x).toBeGreaterThanOrEqual(60);
      expect(p.x).toBeLessThanOrEqual(W - 60);
      expect(p.y).toBeGreaterThanOrEqual(60);
      expect(p.y).toBeLessThanOrEqual(H - 60);
    }
  });

  it('keeps every prop clear of the keep-out radius', () => {
    const radius = 160;
    const props = scatterProps(42, W, H, KEEP_OUT, { keepOutRadius: radius });
    for (const p of props) {
      for (const k of KEEP_OUT) {
        expect(Math.hypot(p.x - k.x, p.y - k.y)).toBeGreaterThanOrEqual(radius);
      }
    }
  });

  it('respects the minimum spacing between placed props', () => {
    const spacing = 70;
    const props = scatterProps(99, W, H, KEEP_OUT, { spacing });
    for (let i = 0; i < props.length; i++) {
      for (let j = i + 1; j < props.length; j++) {
        const a = props[i];
        const b = props[j];
        if (!a || !b) continue;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(spacing);
      }
    }
  });

  it('produces a different arrangement for a different seed', () => {
    const a = scatterProps(1, W, H, KEEP_OUT);
    const b = scatterProps(2, W, H, KEEP_OUT);
    expect(a).not.toEqual(b);
  });

  it('places the requested counts of each kind when the arena has room', () => {
    const props = scatterProps(5, W, H, KEEP_OUT, { trees: 10, bushes: 12 });
    expect(props.filter((p) => p.kind === 'tree')).toHaveLength(10);
    expect(props.filter((p) => p.kind === 'bush')).toHaveLength(12);
  });
});
