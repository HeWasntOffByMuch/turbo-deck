import { describe, expect, it } from 'vitest';

import { BROADCAST_EVERY_N_TICKS } from '../../../server/config.js';
import { approachLead, approachOrderFor } from './approach.js';

/**
 * Walking over to a thing before asking for it (specs 158, 256).
 *
 * These were `loot-drop.test.ts`'s while the drop was the only caller. They
 * moved with the decision rather than being copied beside it, so a pickup and a
 * conversation cannot come to two answers about how close is close enough.
 */
describe('walking over to it', () => {
  const mark = { x: 100, y: 0 };

  it('walks while it is out of reach and stops when it is not', () => {
    const far = approachOrderFor({
      self: { x: 0, y: 0 },
      selfHealth: 100,
      target: mark,
      reach: 50,
      lead: 0,
      pending: false,
    });
    expect(far.walkTo).toEqual({ x: 100, y: 0 });
    expect(far.ask).toBe(false);

    const near = approachOrderFor({
      self: { x: 70, y: 0 },
      selfHealth: 100,
      target: mark,
      reach: 50,
      lead: 0,
      pending: false,
    });
    expect(near.walkTo).toBeNull();
    expect(near.ask).toBe(true);
  });

  /**
   * The bug this exists for: the client's prediction leads the server while it
   * walks, so arriving at *its* copy of the reach and asking earns an
   * out-of-range refusal from a server holding the body a stride further back.
   */
  it('keeps closing while the lead would put the server out of range', () => {
    const far = { x: 60, y: 0 };
    // 60 away, reach 50: out of range on both clocks, so it walks.
    expect(
      approachOrderFor({ self: { x: 0, y: 0 }, selfHealth: 100, target: far, reach: 50, lead: 20, pending: false }).ask,
    ).toBe(false);
    // 45 away: inside the client's own reach, and *not* inside it once the
    // 20-unit lead is taken off. It keeps walking rather than asking.
    const edge = approachOrderFor({
      self: { x: 15, y: 0 },
      selfHealth: 100,
      target: far,
      reach: 50,
      lead: 20,
      pending: false,
    });
    expect(edge.ask).toBe(false);
    expect(edge.walkTo).toEqual({ x: 60, y: 0 });
    // 25 away: inside even with the lead taken off. Now it asks, and stops.
    const arrived = approachOrderFor({
      self: { x: 35, y: 0 },
      selfHealth: 100,
      target: far,
      reach: 50,
      lead: 20,
      pending: false,
    });
    expect(arrived.ask).toBe(true);
    expect(arrived.walkTo).toBeNull();
  });

  /** It stops and asks at the same distance -- or it stands there being refused. */
  it('never stops walking at a distance it will not ask from', () => {
    for (const lead of [0, 5, 20, 49, 200]) {
      for (let gap = 0; gap <= 80; gap += 1) {
        const order = approachOrderFor({
          self: { x: 0, y: 0 },
          selfHealth: 100,
          target: { x: gap, y: 0 },
          reach: 50,
          lead,
          pending: false,
        });
        expect(order.ask, `lead ${lead} gap ${gap}`).toBe(order.walkTo === null);
      }
    }
  });

  it('derives the lead from the connection rather than assuming one', () => {
    // A body doing 150 units/s on a 12-tick round trip is 30 units ahead.
    expect(approachLead(150, 12, 60, 126)).toBeCloseTo(30, 6);
    // A pathological connection cannot eat the whole reach.
    expect(approachLead(150, 10_000, 60, 126)).toBe(63);
    // A body that cannot move needs no margin at all.
    expect(approachLead(0, 12, 60, 126)).toBe(0);
  });

  /**
   * The bug: on a fast connection the measured round trip rounds to zero, the
   * lead came out zero, and the order asked from *exactly* the distance the
   * server refuses past. A prediction is never zero ticks ahead, so that was
   * one refusal and a retry on every single pickup -- "it says too far away and
   * then picks it up".
   */
  it('never lets a moving body ask from the boundary itself', () => {
    for (const rtt of [0, 1, 2, 3]) {
      const lead = approachLead(155, rtt, 60, 126);
      expect(lead, `round trip ${rtt}`).toBeGreaterThan(0);
      // At least a broadcast interval of travel, which is the coarsest this
      // client's knowledge of where the server put it ever is.
      expect(lead, `round trip ${rtt}`).toBeCloseTo((155 * BROADCAST_EVERY_N_TICKS) / 60, 6);
    }
    // ...and a measured round trip past that floor still wins.
    expect(approachLead(155, 20, 60, 126)).toBeGreaterThan(approachLead(155, 0, 60, 126));
  });

  /** One ask, not sixty a second while the answer is in flight. */
  it('does not ask twice while a request is unanswered', () => {
    const order = approachOrderFor({
      self: { x: 100, y: 0 },
      selfHealth: 100,
      target: mark,
      reach: 50,
      lead: 0,
      pending: true,
    });
    expect(order.ask).toBe(false);
    expect(order.walkTo).toBeNull();
  });

  it('does nothing without an order, and nothing while dead', () => {
    expect(
      approachOrderFor({ self: { x: 0, y: 0 }, selfHealth: 100, target: null, reach: 50, lead: 0, pending: false }),
    ).toEqual({ walkTo: null, ask: false });
    expect(
      approachOrderFor({ self: { x: 100, y: 0 }, selfHealth: 0, target: mark, reach: 50, lead: 0, pending: false }),
    ).toEqual({ walkTo: null, ask: false });
  });
});
