/**
 * The status map (spec 147).
 *
 * Small enough that the tests are mostly about the edges, and the edges are
 * where a timer system goes wrong: reading a stale entry, an expiry that is off
 * by a tick, a stack that grows past its cap, a "clear" that leaves the key
 * behind.
 */

import { describe, expect, it } from 'vitest';
import {
  adaptationAgainst,
  adaptedKey,
  applyStatus,
  clearStatus,
  expireStatuses,
  hasStatus,
  NO_STATUSES,
  stacksOf,
  statusOf,
  StatusId,
} from './statuses.js';

describe('applying', () => {
  it('is live up to the tick before it expires, and gone on it', () => {
    const held = applyStatus(NO_STATUSES, StatusId.Flow, 100, 10);
    expect(hasStatus(held, StatusId.Flow, 109)).toBe(true);
    // The expiry tick itself is *not* live. One convention, stated once, so a
    // duration of 10 means ten ticks rather than eleven.
    expect(hasStatus(held, StatusId.Flow, 110)).toBe(false);
    expect(hasStatus(held, StatusId.Flow, 999)).toBe(false);
  });

  it('refuses a duration of zero or less, and allocates nothing for it', () => {
    // The common case for a body with no traits: every grant is a no-op, and it
    // has to cost nothing per tick per body.
    expect(applyStatus(NO_STATUSES, StatusId.Flow, 0, 0)).toBe(NO_STATUSES);
    expect(applyStatus(NO_STATUSES, StatusId.Flow, 0, -5)).toBe(NO_STATUSES);
    expect(applyStatus(NO_STATUSES, StatusId.Flow, 0, Number.NaN)).toBe(NO_STATUSES);
  });

  it('stacks up to the cap and refreshes the duration each time', () => {
    let held = applyStatus(NO_STATUSES, StatusId.Flow, 0, 10, { maxStacks: 3 });
    held = applyStatus(held, StatusId.Flow, 5, 10, { maxStacks: 3 });
    expect(stacksOf(held, StatusId.Flow, 5)).toBe(2);
    expect(statusOf(held, StatusId.Flow, 5)?.expiresAtTick).toBe(15);

    held = applyStatus(held, StatusId.Flow, 6, 10, { maxStacks: 3 });
    held = applyStatus(held, StatusId.Flow, 7, 10, { maxStacks: 3 });
    expect(stacksOf(held, StatusId.Flow, 7)).toBe(3);
  });

  it('starts again at one stack once it has lapsed', () => {
    let held = applyStatus(NO_STATUSES, StatusId.Flow, 0, 10, { maxStacks: 3 });
    held = applyStatus(held, StatusId.Flow, 1, 10, { maxStacks: 3 });
    expect(stacksOf(held, StatusId.Flow, 1)).toBe(2);
    // Re-applied after the lapse: the old entry is stale, so it does not count.
    held = applyStatus(held, StatusId.Flow, 100, 10, { maxStacks: 3 });
    expect(stacksOf(held, StatusId.Flow, 100)).toBe(1);
  });

  it('keeps the stronger magnitude when two sources apply the same mark', () => {
    // An exposure is worth what the character who applied it is worth. A second,
    // weaker one must not dilute the first.
    let held = applyStatus(NO_STATUSES, StatusId.Exposed, 0, 60, { magnitude: 0.25 });
    held = applyStatus(held, StatusId.Exposed, 1, 60, { magnitude: 0.1 });
    expect(statusOf(held, StatusId.Exposed, 1)?.magnitude).toBe(0.25);
  });
});

describe('reading', () => {
  it('never returns a stale entry, even before it has been swept', () => {
    // Correctness does not depend on the sweep running. `expireStatuses` is a
    // garbage collector, not a rule.
    const held = applyStatus(NO_STATUSES, StatusId.Prepared, 0, 5);
    expect(Object.keys(held)).toContain(StatusId.Prepared);
    expect(statusOf(held, StatusId.Prepared, 500)).toBeNull();
    expect(stacksOf(held, StatusId.Prepared, 500)).toBe(0);
  });

  it('answers zero for something that was never applied', () => {
    expect(stacksOf(NO_STATUSES, StatusId.Momentum, 0)).toBe(0);
    expect(statusOf(NO_STATUSES, StatusId.Momentum, 0)).toBeNull();
  });
});

describe('expiry', () => {
  it('drops what has lapsed and keeps what has not', () => {
    let held = applyStatus(NO_STATUSES, StatusId.Flow, 0, 5);
    held = applyStatus(held, StatusId.Attuned, 0, 50);
    const swept = expireStatuses(held, 10);
    expect(Object.keys(swept)).toEqual([StatusId.Attuned]);
  });

  it('returns the same object when nothing lapsed, so an idle tick allocates nothing', () => {
    const held = applyStatus(NO_STATUSES, StatusId.Flow, 0, 50);
    expect(expireStatuses(held, 10)).toBe(held);
    expect(expireStatuses(NO_STATUSES, 10)).toBe(NO_STATUSES);
  });

  it('clears a named status outright, key and all', () => {
    // What being staggered does to Flow. A status left in the map with zero
    // stacks would still be found by `Object.entries`, which Catalysis reads.
    const held = applyStatus(NO_STATUSES, StatusId.Flow, 0, 50);
    expect(Object.keys(clearStatus(held, StatusId.Flow))).toEqual([]);
    expect(clearStatus(held, StatusId.Momentum)).toBe(held);
  });
});

describe('adaptation', () => {
  it('is per ability, so learning one blow teaches nothing about another', () => {
    const held = applyStatus(NO_STATUSES, adaptedKey('skill.poisonDart'), 0, 100, { maxStacks: 5 });
    expect(adaptationAgainst(held, 'skill.poisonDart', 0, 0.06, 0.3)).toBeCloseTo(0.06, 9);
    expect(adaptationAgainst(held, 'melee.slash', 0, 0.06, 0.3)).toBe(0);
  });

  it('grows with the stacks and stops at the cap', () => {
    let held = NO_STATUSES;
    for (let i = 0; i < 20; i++) {
      held = applyStatus(held, adaptedKey('skill.blight'), 0, 100, { maxStacks: 5 });
    }
    expect(stacksOf(held, adaptedKey('skill.blight'), 0)).toBe(5);
    expect(adaptationAgainst(held, 'skill.blight', 0, 0.06, 0.3)).toBeCloseTo(0.3, 9);
    // And the cap wins even when the stacks would carry it past.
    expect(adaptationAgainst(held, 'skill.blight', 0, 0.5, 0.3)).toBe(0.3);
  });

  it('is nothing at all for a body without the trait', () => {
    const held = applyStatus(NO_STATUSES, adaptedKey('skill.poisonDart'), 0, 100, { maxStacks: 5 });
    expect(adaptationAgainst(held, 'skill.poisonDart', 0, 0, 0.3)).toBe(0);
    expect(adaptationAgainst(held, 'skill.poisonDart', 0, 0.06, 0)).toBe(0);
  });

  it('decays: a stack that lapsed is a lesson forgotten', () => {
    const held = applyStatus(NO_STATUSES, adaptedKey('skill.poisonDart'), 0, 10, { maxStacks: 5 });
    expect(adaptationAgainst(held, 'skill.poisonDart', 9, 0.06, 0.3)).toBeCloseTo(0.06, 9);
    expect(adaptationAgainst(held, 'skill.poisonDart', 10, 0.06, 0.3)).toBe(0);
  });
});

describe('determinism', () => {
  it('rebuilds in insertion order, so a replay walks the same map', () => {
    let held = NO_STATUSES;
    held = applyStatus(held, StatusId.Flow, 0, 100);
    held = applyStatus(held, StatusId.Attuned, 0, 100);
    held = applyStatus(held, StatusId.Exposed, 0, 5);
    expect(Object.keys(held)).toEqual([StatusId.Flow, StatusId.Attuned, StatusId.Exposed]);
    // A sweep preserves it, and so does a clear.
    expect(Object.keys(expireStatuses(held, 10))).toEqual([StatusId.Flow, StatusId.Attuned]);
    expect(Object.keys(clearStatus(held, StatusId.Attuned))).toEqual([
      StatusId.Flow,
      StatusId.Exposed,
    ]);
  });

  it('never mutates what it was handed', () => {
    const before = applyStatus(NO_STATUSES, StatusId.Flow, 0, 100);
    const snapshot = JSON.stringify(before);
    applyStatus(before, StatusId.Attuned, 0, 100);
    clearStatus(before, StatusId.Flow);
    expireStatuses(before, 999);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
