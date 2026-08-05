import { describe, expect, it } from 'vitest';
import { moveIntent } from './intent.js';

const ORIGIN = { x: 0, y: 0 };

describe('moveIntent', () => {
  it('is still when nothing is held', () => {
    const intent = moveIntent(new Set(), ORIGIN, { x: 10, y: 0 });
    expect(intent.moveX).toBe(0);
    expect(intent.moveY).toBe(0);
  });

  it('walks the cardinals at unit speed', () => {
    expect(moveIntent(new Set(['KeyW']), ORIGIN, { x: 1, y: 0 }).moveY).toBe(-1);
    expect(moveIntent(new Set(['KeyS']), ORIGIN, { x: 1, y: 0 }).moveY).toBe(1);
    expect(moveIntent(new Set(['KeyA']), ORIGIN, { x: 1, y: 0 }).moveX).toBe(-1);
    expect(moveIntent(new Set(['KeyD']), ORIGIN, { x: 1, y: 0 }).moveX).toBe(1);
  });

  it('normalises the diagonal, so W+D is not a sprint', () => {
    const intent = moveIntent(new Set(['KeyW', 'KeyD']), ORIGIN, { x: 1, y: 0 });
    expect(Math.hypot(intent.moveX, intent.moveY)).toBeCloseTo(1, 9);
    expect(intent.moveX).toBeCloseTo(Math.SQRT1_2, 9);
    expect(intent.moveY).toBeCloseTo(-Math.SQRT1_2, 9);
  });

  it('cancels opposed keys', () => {
    const intent = moveIntent(new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD']), ORIGIN, { x: 1, y: 0 });
    expect(intent.moveX).toBe(0);
    expect(intent.moveY).toBe(0);
  });

  it('treats the arrows as the same keys', () => {
    const wasd = moveIntent(new Set(['KeyW', 'KeyD']), ORIGIN, { x: 1, y: 0 });
    const arrows = moveIntent(new Set(['ArrowUp', 'ArrowRight']), ORIGIN, { x: 1, y: 0 });
    expect(arrows).toEqual(wasd);
  });

  it('ignores keys that are not movement', () => {
    const intent = moveIntent(new Set(['ShiftLeft', 'Digit1', 'KeyD']), ORIGIN, { x: 1, y: 0 });
    expect(intent.moveX).toBe(1);
    expect(intent.moveY).toBe(0);
  });

  it('faces the cursor, and nothing else does', () => {
    // Held keys point west; the cursor is due south. Facing follows the cursor.
    const intent = moveIntent(new Set(['KeyA']), ORIGIN, { x: 0, y: 100 });
    expect(intent.facing).toBeCloseTo(Math.PI / 2, 9);
    expect(intent.moveX).toBe(-1);
  });

  it('measures facing from the body, not from the origin', () => {
    const intent = moveIntent(new Set(), { x: 500, y: 500 }, { x: 500, y: 400 });
    expect(intent.facing).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('does not snap east when the cursor sits on the body', () => {
    const intent = moveIntent(new Set(), { x: 42, y: 42 }, { x: 42, y: 42 });
    expect(intent.facing).toBe(0);
    expect(Number.isFinite(intent.facing)).toBe(true);
  });
});
