import { describe, expect, it } from 'vitest';
import { DEFAULT_ISO, worldToIso } from './projection.js';

describe('worldToIso', () => {
  it('is a pure function of position (same input -> same point)', () => {
    const p = { x: 320, y: 180 };
    expect(worldToIso(p)).toEqual(worldToIso(p));
  });

  it('maps the origin to the params origin', () => {
    expect(worldToIso({ x: 0, y: 0 }, { originX: 100, originY: 50, scaleX: 2, scaleY: 1 })).toEqual({
      x: 100,
      y: 50,
    });
  });

  it('sends the two world axes to opposite screen-x directions (isometric)', () => {
    const alongX = worldToIso({ x: 100, y: 0 });
    const alongY = worldToIso({ x: 0, y: 100 });
    expect(alongX.x).toBeGreaterThan(0);
    expect(alongY.x).toBeLessThan(0);
    // Both axes move the point down-screen (toward larger y) by the 2:1 ratio.
    expect(alongX.y).toBeGreaterThan(0);
    expect(alongY.y).toBeCloseTo(alongX.y);
  });

  it('has a 2:1 vertical-to-horizontal ratio by default', () => {
    expect(DEFAULT_ISO.scaleY).toBeCloseTo(DEFAULT_ISO.scaleX * 0.5);
  });
});
