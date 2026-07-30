import { describe, expect, it } from 'vitest';
import {
  cameraFrustum,
  HOVER_PLAYER_ID,
  internalRenderSize,
  MAX_RENDER_W,
  pickHovered,
  REFERENCE_ASPECT,
  RENDER_H,
} from './view-frame.js';
import { HAND_KEYS, WAVE_KEY } from './input.js';

describe('internal render size (spec 039)', () => {
  it('keeps a fixed pixel height and takes the window aspect', () => {
    const size = internalRenderSize(1600, 900);
    expect(size.height).toBe(RENDER_H);
    expect(size.width).toBe(Math.round(RENDER_H * (1600 / 900)));
  });

  it('holds pixels square rather than squashing them when the width caps out', () => {
    const size = internalRenderSize(5120, 1440); // ultrawide: past the width cap
    expect(size.width).toBe(MAX_RENDER_W);
    expect(size.width / size.height).toBeCloseTo(5120 / 1440, 1);
    expect(size.height).toBeLessThan(RENDER_H);
  });

  it('falls back to the reference aspect for a degenerate box', () => {
    expect(internalRenderSize(0, 0)).toEqual({ width: Math.round(RENDER_H * REFERENCE_ASPECT), height: RENDER_H });
  });
});

describe('camera frustum (spec 039)', () => {
  it('holds the vertical span constant as the window widens', () => {
    const narrow = cameraFrustum(320, 1.6);
    const wide = cameraFrustum(320, 2.4);
    expect(wide.halfHeight).toBe(narrow.halfHeight);
    expect(wide.halfWidth).toBeGreaterThan(narrow.halfWidth);
  });

  it('reproduces the pre-fullscreen framing at the reference aspect', () => {
    const frustum = cameraFrustum(320, REFERENCE_ASPECT);
    expect(frustum.halfWidth).toBeCloseTo(320, 6);
    expect(frustum.halfHeight).toBeCloseTo(320 / REFERENCE_ASPECT, 6);
  });
});

describe('hover picking (spec 039)', () => {
  const player = { id: HOVER_PLAYER_ID, position: { x: 100, y: 100 }, radius: 16 };
  const enemy = { id: 7, position: { x: 140, y: 100 }, radius: 22 };

  it('picks nothing on empty ground, and nothing at all without a cursor', () => {
    expect(pickHovered({ x: 400, y: 400 }, [player, enemy])).toBeNull();
    expect(pickHovered(null, [player, enemy])).toBeNull();
  });

  it('picks the unit whose footprint holds the cursor', () => {
    expect(pickHovered({ x: 104, y: 103 }, [player, enemy])).toBe(HOVER_PLAYER_ID);
    expect(pickHovered({ x: 150, y: 100 }, [player, enemy])).toBe(7);
  });

  it('picks the nearer of two overlapping units, so only one is ever outlined', () => {
    const overlapping = { id: 9, position: { x: 108, y: 100 }, radius: 22 };
    expect(pickHovered({ x: 107, y: 100 }, [player, overlapping])).toBe(9);
    expect(pickHovered({ x: 101, y: 100 }, [player, overlapping])).toBe(HOVER_PLAYER_ID);
  });

  it('stops at the footprint: on the rim it hovers, a hair outside it does not', () => {
    expect(pickHovered({ x: 100 + player.radius, y: 100 }, [player])).toBe(HOVER_PLAYER_ID);
    expect(pickHovered({ x: 100 + player.radius + 0.5, y: 100 }, [player])).toBeNull();
  });
});

describe('key bindings (spec 039)', () => {
  it('plays the hand with Q/W/E/R, keeping the digits as aliases', () => {
    expect([HAND_KEYS.KeyQ, HAND_KEYS.KeyW, HAND_KEYS.KeyE, HAND_KEYS.KeyR]).toEqual([0, 1, 2, 3]);
    expect([HAND_KEYS.Digit1, HAND_KEYS.Digit2, HAND_KEYS.Digit3, HAND_KEYS.Digit4]).toEqual([0, 1, 2, 3]);
  });

  it('no longer summons the wave with Q, since the hand took it', () => {
    expect(WAVE_KEY).not.toBe('KeyQ');
    expect(HAND_KEYS[WAVE_KEY]).toBeUndefined();
  });
});
