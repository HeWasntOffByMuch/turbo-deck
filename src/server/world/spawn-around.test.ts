/**
 * Where a second player stands (spec 145).
 */

import { describe, expect, it } from 'vitest';
import { spawnAround } from './spawn-around.js';

const BASE = { x: 600, y: 450 };
const SPACING = 40;
const ANYWHERE = (): boolean => true;

describe('spawnAround', () => {
  it('gives the base itself to the first arrival', () => {
    expect(spawnAround(BASE, [], SPACING, ANYWHERE)).toEqual(BASE);
  });

  it('steps off the base when somebody is standing on it', () => {
    const second = spawnAround(BASE, [BASE], SPACING, ANYWHERE);
    expect(second).not.toEqual(BASE);
    expect(Math.hypot(second.x - BASE.x, second.y - BASE.y)).toBeGreaterThanOrEqual(SPACING - 1e-9);
  });

  it('keeps a whole crowd apart', () => {
    // Nineteen is every candidate the rings hold: 1 + 6 + 12.
    const placed: { x: number; y: number }[] = [];
    for (let i = 0; i < 19; i++) placed.push(spawnAround(BASE, placed, SPACING, ANYWHERE));
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        if (!a || !b) throw new Error('missing');
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(SPACING - 1e-9);
      }
    }
  });

  it('is deterministic: the same occupied set, the same point, always', () => {
    const occupied = [BASE, { x: BASE.x + SPACING, y: BASE.y }];
    const first = spawnAround(BASE, occupied, SPACING, ANYWHERE);
    for (let i = 0; i < 20; i++) {
      expect(spawnAround(BASE, occupied, SPACING, ANYWHERE)).toEqual(first);
    }
  });

  it('refuses ground that does not fit', () => {
    // Everything west of the base is water; the answer must be east of it.
    const at = spawnAround(BASE, [BASE], SPACING, (x) => x >= BASE.x);
    expect(at.x).toBeGreaterThanOrEqual(BASE.x);
  });

  it('falls back to the base rather than failing to spawn anybody', () => {
    // No ground fits at all. Spawning somebody close beats refusing a login for
    // a reason nobody can act on.
    expect(spawnAround(BASE, [BASE], SPACING, () => false)).toEqual(BASE);
  });
});
