import { describe, expect, it } from 'vitest';
import { ADAPTED_PREFIX, StatusId, adaptedKey } from '../sim/statuses.js';
import {
  ADAPTED_ID,
  MAX_VISIBLE_STATUSES,
  STATUS_VISUALS,
  visualByWire,
  visualFor,
} from './status-visuals.js';

describe('the visible status table (spec 186)', () => {
  it('gives every row a unique wire index, and one that survives a rebuild', () => {
    const seen = new Set<number>();
    for (const visual of STATUS_VISUALS) {
      expect(seen.has(visual.wire), `duplicate wire index ${visual.wire}`).toBe(false);
      seen.add(visual.wire);
      expect(Number.isInteger(visual.wire)).toBe(true);
      expect(visual.wire).toBeGreaterThanOrEqual(0);
      // The byte the packer writes. A row past 255 would be silently clamped
      // onto another row's index, which is the worst way this could fail.
      expect(visual.wire).toBeLessThanOrEqual(255);
    }
    expect(seen.size).toBe(MAX_VISIBLE_STATUSES);
  });

  it('gives every row a unique id', () => {
    const ids = new Set(STATUS_VISUALS.map((visual) => visual.id));
    expect(ids.size).toBe(STATUS_VISUALS.length);
  });

  it('round-trips id to wire and back', () => {
    for (const visual of STATUS_VISUALS) {
      expect(visualByWire(visual.wire)).toBe(visual);
      expect(visualFor(visual.id)).toBe(visual);
    }
  });

  it('collapses every adaptation key onto the one adapted row', () => {
    const collapsed = visualFor(ADAPTED_ID);
    expect(collapsed).not.toBeNull();
    // The family is per ability, so the table cannot enumerate it: any key with
    // the prefix has to answer the same row, including one for an ability that
    // does not exist yet.
    expect(visualFor(adaptedKey('bolt.arcane'))).toBe(collapsed);
    expect(visualFor(adaptedKey('ground.quake'))).toBe(collapsed);
    expect(visualFor(`${ADAPTED_PREFIX}something.invented`)).toBe(collapsed);
  });

  it('keeps the sim’s own bookkeeping off the wire', () => {
    // The rule the table exists to hold: conditions somebody could point at,
    // not the timers the sim keeps for itself. Each of these is live in the sim
    // and none of them is a thing to hang over a body.
    for (const id of [
      StatusId.RecentlyHit,
      StatusId.InCombat,
      StatusId.SecondWindSpent,
      StatusId.PerfectExitSpent,
      'exposed.bounty',
      'dmg:7',
      'farm:spawner-3',
    ]) {
      expect(visualFor(id), id).toBeNull();
    }
  });

  it('shows the nine conditions a player can act on', () => {
    for (const id of [
      StatusId.Flow,
      StatusId.Momentum,
      StatusId.Prepared,
      StatusId.Attuned,
      StatusId.Exposed,
      StatusId.Vulnerable,
      StatusId.Sundered,
      // The one a skill applies rather than a build earning (spec 188), and by
      // this table's own rule the most pointable-at of the lot.
      StatusId.Slowed,
    ]) {
      expect(visualFor(id), id).not.toBeNull();
    }
    expect(visualFor(ADAPTED_ID)).not.toBeNull();
    expect(STATUS_VISUALS).toHaveLength(9);
  });

  it('answers null for an index it has no row for', () => {
    // A client reading a newer server. Null rather than a throw, so an unknown
    // mark costs one glyph rather than the frame.
    expect(visualByWire(200)).toBeNull();
    expect(visualByWire(-1)).toBeNull();
  });

  it('never says a row stacks without saying how far', () => {
    for (const visual of STATUS_VISUALS) {
      expect(visual.maxStacks, visual.id).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(visual.maxStacks), visual.id).toBe(true);
    }
  });
});
