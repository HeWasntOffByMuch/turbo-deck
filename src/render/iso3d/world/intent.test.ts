import { describe, expect, it } from 'vitest';
import { ARRIVE_EPS, moveIntent, steerTo, type IntentInput } from './intent.js';

const ORIGIN = { x: 0, y: 0 };

function intent(over: Partial<IntentInput> = {}): ReturnType<typeof moveIntent> {
  return moveIntent({
    held: new Set(),
    self: ORIGIN,
    destination: null,
    facing: 0,
    castAim: null,
    world: null,
    ...over,
  });
}

describe('moveIntent', () => {
  it('is still when nothing is held and nothing is ordered', () => {
    const result = intent();
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  it('walks the cardinals at unit speed', () => {
    expect(intent({ held: new Set(['KeyW']) }).moveY).toBe(-1);
    expect(intent({ held: new Set(['KeyS']) }).moveY).toBe(1);
    expect(intent({ held: new Set(['KeyA']) }).moveX).toBe(-1);
    expect(intent({ held: new Set(['KeyD']) }).moveX).toBe(1);
  });

  it('normalises the diagonal, so W+D is not a sprint', () => {
    const result = intent({ held: new Set(['KeyW', 'KeyD']) });
    expect(Math.hypot(result.moveX, result.moveY)).toBeCloseTo(1, 9);
    expect(result.moveX).toBeCloseTo(Math.SQRT1_2, 9);
    expect(result.moveY).toBeCloseTo(-Math.SQRT1_2, 9);
  });

  it('cancels opposed keys', () => {
    const result = intent({ held: new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD']) });
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  it('treats the arrows as the same keys', () => {
    expect(intent({ held: new Set(['ArrowUp', 'ArrowRight']) })).toEqual(
      intent({ held: new Set(['KeyW', 'KeyD']) }),
    );
  });

  it('ignores keys that are not movement', () => {
    const result = intent({ held: new Set(['ShiftLeft', 'Digit1', 'KeyD']) });
    expect(result.moveX).toBe(1);
  });

  it('faces where it is going', () => {
    expect(intent({ held: new Set(['KeyA']) }).facing).toBeCloseTo(Math.PI, 9);
    expect(intent({ held: new Set(['KeyS']) }).facing).toBeCloseTo(Math.PI / 2, 9);
  });

  it('keeps its heading when it is standing still', () => {
    expect(intent({ facing: 1.25 }).facing).toBe(1.25);
  });
});

describe('a standing move order', () => {
  it('walks toward the destination', () => {
    const result = intent({ self: ORIGIN, destination: { x: 0, y: 100 } });
    expect(result.moveX).toBeCloseTo(0, 9);
    expect(result.moveY).toBeCloseTo(1, 9);
    expect(result.facing).toBeCloseTo(Math.PI / 2, 9);
    expect(result.arrived).toBe(false);
  });

  it('reports arrival once it is close enough, and asks for nothing', () => {
    const result = intent({ self: ORIGIN, destination: { x: ARRIVE_EPS - 1, y: 0 } });
    expect(result.arrived).toBe(true);
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  it('does not claim arrival when there is no order to arrive at', () => {
    expect(intent({ destination: null }).arrived).toBe(false);
  });

  /**
   * Grabbing the keys is how manual control is taken back. Having to cancel a
   * standing order first reads exactly like a stuck key.
   */
  it('lets held keys override the order', () => {
    const result = intent({ held: new Set(['KeyW']), destination: { x: 0, y: 900 } });
    expect(result.moveY).toBe(-1);
    expect(result.arrived).toBe(false);
  });

  it('does not report arrival while keys are steering', () => {
    const result = intent({
      held: new Set(['KeyW']),
      self: ORIGIN,
      destination: { x: 0, y: 0 },
    });
    expect(result.arrived).toBe(false);
  });
});

describe('while casting', () => {
  /**
   * The server roots a caster outright, so predicting a walk here diverges on
   * every tick of every wind-up -- a correction per tick, on the one action the
   * player is watching most closely.
   */
  it('asks for no movement, whatever is held', () => {
    const result = intent({ held: new Set(['KeyW', 'KeyD']), castAim: { x: 100, y: 0 } });
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  it('asks for no movement toward a standing order either', () => {
    const result = intent({ destination: { x: 500, y: 500 }, castAim: { x: 100, y: 0 } });
    expect(result.moveX).toBe(0);
    expect(result.moveY).toBe(0);
  });

  /**
   * The bug this replaced: holding the old heading meant the client drew a body
   * that never turned, while the server turned it the whole time.
   */
  it('asks to face the aim, so the body visibly comes round', () => {
    expect(intent({ facing: 0, castAim: { x: 0, y: 100 } }).facing).toBeCloseTo(Math.PI / 2, 9);
    expect(intent({ facing: 0, castAim: { x: -100, y: 0 } }).facing).toBeCloseTo(Math.PI, 9);
  });

  it('keeps its heading for an aim sitting on top of it', () => {
    expect(intent({ facing: 1.25, self: { x: 5, y: 5 }, castAim: { x: 5, y: 5 } }).facing).toBe(1.25);
  });
});

describe('steerTo', () => {
  it('is null without a destination', () => {
    expect(steerTo(ORIGIN, null)).toBeNull();
  });

  it('is null once inside the arrival radius', () => {
    expect(steerTo(ORIGIN, { x: 0, y: ARRIVE_EPS })).toBeNull();
    expect(steerTo(ORIGIN, { x: 0, y: ARRIVE_EPS + 1 })).not.toBeNull();
  });

  it('returns a unit vector at any distance', () => {
    for (const far of [10, 100, 10_000]) {
      const direction = steerTo(ORIGIN, { x: far, y: far });
      expect(direction).not.toBeNull();
      if (!direction) return;
      expect(Math.hypot(direction.x, direction.y)).toBeCloseTo(1, 9);
    }
  });
});
