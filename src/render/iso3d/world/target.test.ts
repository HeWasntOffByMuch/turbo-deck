/**
 * The auto-attack driver (spec 070). Headless: the whole point of keeping the
 * decision out of the view is that "does the player stop walking once they are
 * in reach" needs no canvas to answer.
 */

import { describe, expect, it } from 'vitest';
import { autoAttack, STANDOFF_FRACTION, type AutoAttackInput, type TargetSnapshot } from './target.js';

const TARGET: TargetSnapshot = { id: 7, x: 400, y: 0, radius: 20, health: 40 };

function ask(overrides: Partial<AutoAttackInput> = {}): ReturnType<typeof autoAttack> {
  return autoAttack({
    self: { x: 0, y: 0 },
    target: TARGET,
    range: 70,
    rooted: false,
    readyAtTick: 0,
    tick: 100,
    ...overrides,
  });
}

describe('auto-attacking a named target (spec 070)', () => {
  it('asks for nothing at all with no target', () => {
    expect(ask({ target: null })).toEqual({ chaseTo: null, attack: false, drop: false });
  });

  it('chases when the target is out of reach, and does not swing at nothing', () => {
    const decision = ask();
    expect(decision.attack).toBe(false);
    expect(decision.chaseTo).not.toBeNull();
  });

  it('stops the chase inside reach, on the near side of the target', () => {
    const chase = ask().chaseTo;
    if (!chase) throw new Error('expected a chase');
    const reach = 70 + TARGET.radius;
    const gap = Math.hypot(TARGET.x - chase.x, TARGET.y - chase.y);
    // Inside reach, so arriving means being able to swing...
    expect(gap).toBeLessThan(reach);
    expect(gap).toBeCloseTo(reach * STANDOFF_FRACTION, 6);
    // ...and on our side of it, so the chase never walks through the body.
    expect(chase.x).toBeLessThan(TARGET.x);
    expect(chase.x).toBeGreaterThan(0);
  });

  it('stands still and swings once it is in reach', () => {
    const decision = ask({ self: { x: 340, y: 0 } });
    expect(decision.chaseTo).toBeNull();
    expect(decision.attack).toBe(true);
  });

  it('counts reach to the target\'s edge, not to its centre', () => {
    // 95 out is beyond the 70 range but inside 70 + the 20-unit body.
    const near = ask({ self: { x: TARGET.x - 85, y: 0 } });
    expect(near.attack).toBe(true);
    const fat = ask({ target: { ...TARGET, radius: 0 }, self: { x: TARGET.x - 85, y: 0 } });
    expect(fat.attack).toBe(false);
  });

  it('does not re-commit while a cast is already running', () => {
    expect(ask({ self: { x: 340, y: 0 }, rooted: true }).attack).toBe(false);
  });

  it('waits out the cooldown the server gave it', () => {
    const inReach = { self: { x: 340, y: 0 } };
    expect(ask({ ...inReach, readyAtTick: 130, tick: 129 }).attack).toBe(false);
    expect(ask({ ...inReach, readyAtTick: 130, tick: 130 }).attack).toBe(true);
  });

  it('drops a target that has died, and swings at it no more', () => {
    const decision = ask({ self: { x: 340, y: 0 }, target: { ...TARGET, health: 0 } });
    expect(decision.drop).toBe(true);
    expect(decision.attack).toBe(false);
    expect(decision.chaseTo).toBeNull();
  });

  it('keeps chasing a target that walks away, without ever dropping it', () => {
    // The order stands as long as the body does: only death ends it.
    const far = ask({ target: { ...TARGET, x: 4000 } });
    expect(far.drop).toBe(false);
    expect(far.chaseTo).not.toBeNull();
  });
});
