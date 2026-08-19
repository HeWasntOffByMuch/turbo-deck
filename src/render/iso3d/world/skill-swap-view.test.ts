/**
 * What a skill-slot change looks like while it happens (spec 184).
 *
 * Pure, so all three surfaces are checked without a browser: the fraction the
 * two bars fill by, which cell is which end, which bar slot is being changed,
 * and the word the action bar says. What is asserted throughout is that
 * *nothing here decides anything* -- every answer is a comparison against two
 * ticks the server stamped.
 */

import { describe, expect, it } from 'vitest';
import { SkillSwapKind, SKILL_SWAP } from '../../../server/data/skill-effects.js';
import type { PendingSkillSwap } from '../../../server/net/messages.js';
import { equipmentAddress } from '../../../server/player/inventory.js';
import { EntityActivity } from '../../../server/net/protocol.js';
import {
  barSlotOf,
  roleOf,
  swapLabel,
  swapOverhead,
  swapProgress,
} from './skill-swap-view.js';

const inv = (index: number) => ({ container: 'inventory', index }) as const;

function pending(over: Partial<PendingSkillSwap> = {}): PendingSkillSwap {
  return {
    kind: SkillSwapKind.Equip,
    from: inv(3),
    to: equipmentAddress('skill1'),
    startedTick: 100,
    readyAtTick: 190,
    ...over,
  };
}

describe('how far through it is', () => {
  it('is nothing at the tick it was asked for and everything when it lands', () => {
    expect(swapProgress(pending(), 100)?.progress).toBe(0);
    expect(swapProgress(pending(), 145)?.progress).toBeCloseTo(0.5, 6);
    expect(swapProgress(pending(), 190)?.progress).toBe(1);
  });

  /**
   * The drawn tick is an *estimate* and can sit either side of the server's, so
   * both ends are clamped: a bar past full or below empty would read as a
   * glitch in the one moment the player is watching it.
   */
  it('clamps rather than running past either end', () => {
    expect(swapProgress(pending(), 50)?.progress).toBe(0);
    expect(swapProgress(pending(), 5000)?.progress).toBe(1);
  });

  it('is nothing at all when there is no change', () => {
    expect(swapProgress(null, 120)).toBeNull();
  });

  it('reads a zero-length change as done rather than dividing by nothing', () => {
    const instant = pending({ startedTick: 40, readyAtTick: 40 });
    expect(swapProgress(instant, 40)?.progress).toBe(1);
  });
});

describe('which end a cell is', () => {
  it('names the source and the destination and nothing else', () => {
    const swap = swapProgress(pending(), 120);
    expect(roleOf(swap, inv(3))).toBe('out');
    expect(roleOf(swap, equipmentAddress('skill1'))).toBe('in');
    expect(roleOf(swap, inv(4))).toBeNull();
    expect(roleOf(swap, equipmentAddress('skill2'))).toBeNull();
  });

  it('names nothing when there is no change', () => {
    expect(roleOf(null, inv(3))).toBeNull();
  });
});

describe('which bar slot is being changed', () => {
  it('is the skill slot a change is going into', () => {
    for (const [index, name] of (['skill1', 'skill2', 'skill3', 'skill4'] as const).entries()) {
      const swap = swapProgress(pending({ to: equipmentAddress(name) }), 120);
      expect(barSlotOf(swap), name).toBe(index);
    }
  });

  it('is the skill slot a change is coming out of, when it goes to the bag', () => {
    const swap = swapProgress(
      pending({ kind: SkillSwapKind.Unequip, from: equipmentAddress('skill3'), to: inv(2) }),
      120,
    );
    expect(barSlotOf(swap)).toBe(2);
  });

  /**
   * Dragging one skill onto another touches two bar slots; the one named is the
   * *destination*, because that is the slot whose contents are about to be
   * different.
   */
  it('is the destination when both ends are skill slots', () => {
    const swap = swapProgress(
      pending({ kind: SkillSwapKind.Swap, from: equipmentAddress('skill1'), to: equipmentAddress('skill4') }),
      120,
    );
    expect(barSlotOf(swap)).toBe(3);
  });

  it('is nothing when there is no change', () => {
    expect(barSlotOf(null)).toBeNull();
  });
});

describe('the word', () => {
  it('tells the three apart', () => {
    expect(swapLabel(SkillSwapKind.Equip)).toBe('EQUIPPING');
    expect(swapLabel(SkillSwapKind.Swap)).toBe('SWAPPING');
    expect(swapLabel(SkillSwapKind.Unequip)).toBe('REMOVING');
  });
});

describe('the bar over a body', () => {
  /**
   * The half every client can draw. It says *that* a change is happening and
   * never which one -- which slot and which direction are facts about a bag,
   * and a bag is its owner's business.
   */
  it('shows for a body that is changing a skill and for nothing else', () => {
    const until = 500;
    expect(swapOverhead(EntityActivity.Swapping, until, 460).visible).toBe(true);
    expect(swapOverhead(EntityActivity.Casting, until, 460).visible).toBe(false);
    expect(swapOverhead(EntityActivity.Stunned, until, 460).visible).toBe(false);
    expect(swapOverhead(EntityActivity.Idle, until, 460).visible).toBe(false);
  });

  it('stops on the tick the change lands, not one after it', () => {
    expect(swapOverhead(EntityActivity.Swapping, 500, 499).visible).toBe(true);
    expect(swapOverhead(EntityActivity.Swapping, 500, 500).visible).toBe(false);
  });

  it('fills over the authored duration, from the one tick that is replicated', () => {
    const until = 500;
    const span = SKILL_SWAP.durationTicks;
    expect(swapOverhead(EntityActivity.Swapping, until, until - span).progress).toBeCloseTo(0, 6);
    expect(swapOverhead(EntityActivity.Swapping, until, until - span / 2).progress).toBeCloseTo(0.5, 6);
    expect(swapOverhead(EntityActivity.Swapping, until, until - 1).progress).toBeCloseTo(
      1 - 1 / span,
      6,
    );
  });

  it('never runs backwards for a body seen mid-change', () => {
    // A client that came into view halfway through has no start tick to work
    // from and gets the honest reading anyway, because the *end* is replicated.
    const progress = swapOverhead(EntityActivity.Swapping, 500, 400).progress;
    expect(progress).toBeGreaterThanOrEqual(0);
    expect(progress).toBeLessThanOrEqual(1);
  });
});
