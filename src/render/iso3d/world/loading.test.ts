/**
 * The load gate's three rules (spec 165): position before world, a bar that
 * only goes forward, and a latch that never re-covers a world already shown.
 */

import { describe, expect, it } from 'vitest';

import { LoadGate, type LoadInput } from './loading.js';

const BASE: LoadInput = {
  haveMap: true,
  located: true,
  held: 0,
  needed: 25,
  meshPending: 0,
};

describe('the load gate', () => {
  it('waits for the map before anything else', () => {
    const gate = new LoadGate();
    expect(gate.progress({ ...BASE, haveMap: false, located: false }).phase).toBe('connecting');
  });

  it('will not show the world until the player has been placed', () => {
    // The rule this module exists for. Every chunk in the ready radius has
    // arrived and it still says `locating`, because there is no position to
    // have centred that radius on.
    const gate = new LoadGate();
    const progress = gate.progress({ ...BASE, located: false, held: 25, needed: 25 });

    expect(progress.phase).toBe('locating');
    expect(gate.open).toBe(false);
  });

  it('streams, then meshes, then opens', () => {
    const gate = new LoadGate();
    expect(gate.progress({ ...BASE, held: 10 }).phase).toBe('streaming');
    expect(gate.progress({ ...BASE, held: 25, meshPending: 6 }).phase).toBe('meshing');
    expect(gate.progress({ ...BASE, held: 25, meshPending: 0 }).phase).toBe('ready');
    expect(gate.open).toBe(true);
  });

  it('never walks the bar backwards', () => {
    // `needed` moves as the player does, so a growing denominator would
    // otherwise shrink the fraction mid-load.
    const gate = new LoadGate();
    const first = gate.progress({ ...BASE, held: 20, needed: 25 }).fraction;
    const second = gate.progress({ ...BASE, held: 20, needed: 40 }).fraction;

    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('reaches a full bar only when it is actually ready', () => {
    const gate = new LoadGate();
    expect(gate.progress({ ...BASE, held: 25, meshPending: 4 }).fraction).toBeLessThan(1);
    expect(gate.progress({ ...BASE, held: 25, meshPending: 0 }).fraction).toBe(1);
  });

  it('latches, so walking into unstreamed ground does not re-cover the screen', () => {
    const gate = new LoadGate();
    gate.progress({ ...BASE, held: 25 });
    expect(gate.open).toBe(true);

    // The player has walked to the edge of what has arrived.
    const later = gate.progress({ ...BASE, held: 3, needed: 25, meshPending: 9 });
    expect(later.phase).toBe('ready');
    expect(later.fraction).toBe(1);
    expect(gate.open).toBe(true);
  });

  it('does not stall below full on a map with nothing left to send', () => {
    // A player at the edge of the world: the ready radius reaches past what the
    // map declares, so `needed` is small and must still be reachable.
    const gate = new LoadGate();
    expect(gate.progress({ ...BASE, held: 0, needed: 0 }).phase).toBe('ready');
  });
});
