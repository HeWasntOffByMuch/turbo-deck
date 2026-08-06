/**
 * The auto-attack driver (spec 070). Headless: the whole point of keeping the
 * decision out of the view is that "does the player stop walking once they are
 * in reach" needs no canvas to answer.
 */

import { describe, expect, it } from 'vitest';
import { autoAttack, STANDOFF_FRACTION, type AutoAttackInput, type TargetSnapshot } from './target.js';

const TARGET: TargetSnapshot = { id: 7, x: 400, y: 0, radius: 20, health: 40 };
/** The basic attack's reach, before the target's body is added to it. */
const RANGE = 70;

function ask(overrides: Partial<AutoAttackInput> = {}): ReturnType<typeof autoAttack> {
  return autoAttack({
    self: { x: 0, y: 0 },
    target: TARGET,
    range: RANGE,
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
    // 70 out is inside the standoff on `70 + the 20-unit body` (72) and outside
    // the standoff on the range alone (56), so the body's width is the whole of
    // the difference between swinging and walking closer.
    const near = ask({ self: { x: TARGET.x - 70, y: 0 } });
    expect(near.attack).toBe(true);
    const fat = ask({ target: { ...TARGET, radius: 0 }, self: { x: TARGET.x - 70, y: 0 } });
    expect(fat.attack).toBe(false);
  });

  /**
   * Spec 077. The standoff is where a chase *stops*, not merely where it points.
   *
   * It used to be both and neither: the walk aimed at `reach * STANDOFF` and
   * halted the moment it was inside `reach`, so a body came to rest exactly on
   * the edge it was meant to keep clear of.
   */
  it('keeps walking until it is inside the standoff, not merely inside reach', () => {
    const reach = RANGE + TARGET.radius;
    // Between the standoff and the edge: still closing, not yet swinging.
    const between = ask({ self: { x: TARGET.x - (reach + reach * STANDOFF_FRACTION) / 2, y: 0 } });
    expect(between.attack).toBe(false);
    expect(between.chaseTo).not.toBeNull();
  });

  /**
   * The bug that made it matter. A ranged attack is gated by the server at the
   * ability's own range, measured from the caster -- so a chase that comes to
   * rest past that number leaves the player standing and asking, and every
   * request comes back `outOfRange`. The standoff has to land inside it.
   */
  it('stops a ranged chase inside the range the server gates on', () => {
    for (const range of [300, 420]) {
      const target = { ...TARGET, radius: 22 };
      const decision = ask({ range, target, self: { x: -400, y: 0 } });
      const chase = decision.chaseTo;
      expect(chase, `range ${range}`).not.toBeNull();
      if (!chase) continue;
      const stop = Math.hypot(target.x - chase.x, target.y - chase.y);
      expect(stop, `range ${range}`).toBeLessThan(range);
      // And the attack fires from there rather than from further out.
      expect(ask({ range, target, self: chase }).attack, `range ${range}`).toBe(true);
    }
  });

  it('does not re-commit while a cast is already running', () => {
    expect(ask({ self: { x: 340, y: 0 }, rooted: true }).attack).toBe(false);
  });

  /**
   * Spec 077. A move order withdraws from a cast now, so a chase issued while
   * committed would call the swing off on the player's behalf -- and the one
   * thing a feint has to be is theirs.
   */
  it('asks for no chase while committed, however far out the target is', () => {
    expect(ask({ self: { x: -900, y: 0 }, rooted: true }).chaseTo).toBeNull();
    expect(ask({ self: { x: 340, y: 0 }, rooted: true }).chaseTo).toBeNull();
    // And it still says so when the target has died under a committed swing.
    expect(ask({ target: { ...TARGET, health: 0 }, rooted: true }).drop).toBe(true);
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
