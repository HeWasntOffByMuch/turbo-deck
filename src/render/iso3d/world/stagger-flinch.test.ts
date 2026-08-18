/**
 * The flinch a poise break puts on a body (spec 168).
 *
 * Pure, so a whole break's worth of reaction is replayed in Node with no canvas
 * and no clock. Every case here is a statement about a *tick*, because that is
 * the only time this module knows about.
 */

import { describe, expect, it } from 'vitest';

import { EntityActivity } from '../../../server/net/protocol.js';
import {
  FLINCH_PITCH,
  FLINCH_YAW,
  StaggerFlinches,
  STEADY,
} from './stagger-flinch.js';

const IDLE = EntityActivity.Idle;
const STUNNED = EntityActivity.Stunned;

/** Walks a body from calm into a break, and returns the reader mid-window. */
function broken(windowTicks = 30): { flinches: StaggerFlinches; start: number } {
  const flinches = new StaggerFlinches();
  flinches.read(1, IDLE, 0, 0);
  return { flinches, start: windowTicks };
}

describe('a break rocks the body it broke (spec 168)', () => {
  it('says nothing about a body seen for the first time', () => {
    const flinches = new StaggerFlinches();
    // Already staggered on first sight: walked into view mid-break, or a
    // reconnect. Nobody here watched it land, so nothing is drawn.
    expect(flinches.read(1, STUNNED, 30, 0)).toEqual(STEADY);
  });

  it('throws the body on the tick the break lands, not a moment later', () => {
    const { flinches } = broken();
    const at = flinches.read(1, STUNNED, 30, 0);
    // Full throw immediately: a reaction that ramps up from zero reads as
    // unrelated to the hit.
    expect(at.yaw).toBeCloseTo(FLINCH_YAW, 10);
    expect(at.pitch).toBeCloseTo(0, 10);
  });

  it('is a pure function of the tick it is handed', () => {
    const a = new StaggerFlinches();
    const b = new StaggerFlinches();
    a.read(1, IDLE, 0, 0);
    b.read(1, IDLE, 0, 0);
    a.read(1, STUNNED, 30, 0);
    b.read(1, STUNNED, 30, 0);
    for (const tick of [3, 7, 11, 19, 26]) {
      expect(a.read(1, STUNNED, 30, tick)).toEqual(b.read(1, STUNNED, 30, tick));
    }
  });

  it('decays to exactly zero by the end of the window', () => {
    const { flinches } = broken();
    flinches.read(1, STUNNED, 30, 0);
    const late = flinches.read(1, STUNNED, 30, 29);
    expect(Math.abs(late.yaw)).toBeLessThan(FLINCH_YAW * 0.02);
    // And at the window's end it is exactly steady rather than nearly so, so
    // the body settles onto its heading instead of snapping the last fraction.
    expect(flinches.read(1, IDLE, 0, 30)).toEqual(STEADY);
  });

  it('never exceeds its own bounds', () => {
    const { flinches } = broken();
    flinches.read(1, STUNNED, 48, 0);
    for (let tick = 0; tick < 48; tick++) {
      const at = flinches.read(1, STUNNED, 48, tick);
      expect(Math.abs(at.yaw)).toBeLessThanOrEqual(FLINCH_YAW + 1e-9);
      expect(Math.abs(at.pitch)).toBeLessThanOrEqual(FLINCH_PITCH + 1e-9);
    }
  });

  it('does not restart on every tick of one window', () => {
    // The bug the edge check exists to prevent: a start recorded on each tick
    // of the window holds the body at full throw and then drops it.
    const { flinches } = broken();
    flinches.read(1, STUNNED, 30, 0);
    const mid = flinches.read(1, STUNNED, 30, 15);
    expect(Math.abs(mid.yaw)).toBeLessThan(FLINCH_YAW * 0.5);
  });

  it('restarts on a second break, because a break is a contact', () => {
    // Spec 146's rule for the kick, and the opposite of the white chunk beside
    // it: a contact never merges.
    const flinches = new StaggerFlinches();
    flinches.read(1, IDLE, 0, 0);
    flinches.read(1, STUNNED, 30, 0);
    const settling = flinches.read(1, STUNNED, 30, 20);
    // Out of the window and calm again...
    flinches.read(1, IDLE, 0, 30);
    // ...then broken a second time, which is at full throw again rather than
    // continuing the first one's decay.
    const again = flinches.read(1, STUNNED, 160, 130);
    expect(again.yaw).toBeCloseTo(FLINCH_YAW, 10);
    expect(Math.abs(again.yaw)).toBeGreaterThan(Math.abs(settling.yaw));
  });

  it('scales the decay to the window it was told about', () => {
    // A longer stagger reads as a longer one: the same fraction through two
    // different windows is the same amount of throw.
    const short = new StaggerFlinches();
    const long = new StaggerFlinches();
    short.read(1, IDLE, 0, 0);
    long.read(1, IDLE, 0, 0);
    short.read(1, STUNNED, 30, 0);
    long.read(1, STUNNED, 60, 0);
    const a = short.read(1, STUNNED, 30, 15);
    const b = long.read(1, STUNNED, 60, 30);
    // Same envelope at the halfway point; the oscillation's phase differs, so
    // the envelope is what is compared.
    expect(Math.hypot(a.yaw / FLINCH_YAW, a.pitch / FLINCH_PITCH)).toBeCloseTo(
      Math.hypot(b.yaw / FLINCH_YAW, b.pitch / FLINCH_PITCH),
      6,
    );
  });

  it('holds rather than inverting when the clock steps backwards', () => {
    const { flinches } = broken();
    flinches.read(1, STUNNED, 30, 10);
    const back = flinches.read(1, STUNNED, 30, 4);
    expect(back.yaw).toBeCloseTo(FLINCH_YAW, 10);
    expect(back.pitch).toBeCloseTo(0, 10);
  });

  it('forgets a body, so the map cannot grow without bound', () => {
    const flinches = new StaggerFlinches();
    flinches.read(1, IDLE, 0, 0);
    flinches.read(2, IDLE, 0, 0);
    expect(flinches.tracked).toBe(2);
    flinches.forget(1);
    expect(flinches.tracked).toBe(1);
  });

  it('prunes everything that left the world', () => {
    // A body can leave by going out of interest range rather than by dying, so
    // the sweep is "who is still here" and not "who was marked dead".
    const flinches = new StaggerFlinches();
    for (const id of [1, 2, 3]) flinches.read(id, IDLE, 0, 0);
    flinches.retain(new Set([2]));
    expect(flinches.tracked).toBe(1);
    // And the survivor kept its track rather than being reset.
    flinches.read(2, STUNNED, 30, 0);
    expect(flinches.read(2, STUNNED, 30, 0).yaw).toBeCloseTo(FLINCH_YAW, 10);
  });

  it('draws nothing for a body that is merely idle', () => {
    const flinches = new StaggerFlinches();
    flinches.read(1, IDLE, 0, 0);
    expect(flinches.read(1, IDLE, 0, 5)).toEqual(STEADY);
  });

  it('ignores an activityUntilTick that has already passed', () => {
    // A stale window is not a break. Without the `now < until` half this would
    // flinch on every stale delta.
    const flinches = new StaggerFlinches();
    flinches.read(1, IDLE, 0, 100);
    expect(flinches.read(1, STUNNED, 30, 100)).toEqual(STEADY);
  });
});
