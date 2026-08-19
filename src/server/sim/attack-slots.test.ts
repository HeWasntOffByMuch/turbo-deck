/**
 * The ring a target's attackers stand on (spec 184).
 */

import { describe, expect, it } from 'vitest';
import { MAX_ATTACK_SLOTS, slotAngle, slotCount, slotNearest, SlotBoard } from './attack-slots.js';

describe('slotCount', () => {
  it('grows with the ring and shrinks with the body', () => {
    expect(slotCount(200, 20)).toBeGreaterThan(slotCount(100, 20));
    expect(slotCount(100, 40)).toBeLessThan(slotCount(100, 20));
  });

  it('cuts a ring into bodies that actually fit on it', () => {
    // A ring of 100 with bodies of radius 20: the chord between neighbours must
    // be 40, so about eight fit.
    const count = slotCount(100, 20);
    const chord = 2 * 100 * Math.sin(Math.PI / count);
    expect(chord).toBeGreaterThanOrEqual(40);
  });

  it('answers one rather than zero for a ring nothing fits on', () => {
    expect(slotCount(10, 30)).toBe(1);
    expect(slotCount(0, 30)).toBe(1);
    expect(slotCount(100, 0)).toBe(1);
  });

  it('never cuts a ring finer than the claim set can hold', () => {
    expect(slotCount(100000, 1)).toBeLessThanOrEqual(MAX_ATTACK_SLOTS);
  });

  /** The real bodies, so the numbers in the spec are the numbers in the code. */
  it('gives the shipped monsters a sensible ring', () => {
    // reach = (melee.slash 70 + player 16) * 0.8
    const reach = 68.8;
    expect(slotCount(reach, 20)).toBe(10); // stalker
    expect(slotCount(reach, 30)).toBe(6); // ravager
    expect(slotCount(reach, 22)).toBe(9); // grazer
    expect(slotCount(reach, 12)).toBe(17); // small spider
  });
});

describe('slotNearest', () => {
  it('rounds to the slot an approach actually came from', () => {
    expect(slotNearest(0, 8)).toBe(0);
    expect(slotNearest(Math.PI / 2, 8)).toBe(2);
    expect(slotNearest(Math.PI, 8)).toBe(4);
    // Just past the top of the last slot wraps to the first.
    expect(slotNearest(2 * Math.PI - 0.01, 8)).toBe(0);
  });

  it('handles the negative angles atan2 actually returns', () => {
    expect(slotNearest(-Math.PI / 2, 8)).toBe(6);
    expect(slotNearest(-Math.PI, 8)).toBe(4);
  });

  it('is the inverse of slotAngle', () => {
    for (let i = 0; i < 12; i++) expect(slotNearest(slotAngle(i, 12), 12)).toBe(i);
  });
});

/** A ring of exactly `cuts` slots around target 1, with nothing else on it. */
function ringOf(board: SlotBoard, cuts: number, targetId = 1): void {
  // Invert the chord rule: a body of radius r on a ring of R gives
  // floor(PI / asin(r / R)) slots, so pick R for the r and the count wanted.
  const radius = 20;
  board.note(targetId, radius / Math.sin(Math.PI / (cuts + 0.5)), radius);
}

describe('SlotBoard', () => {
  it('cuts a target’s ring once, for everybody on it', () => {
    const board = new SlotBoard();
    ringOf(board, 8);
    expect(board.cuts(1)).toBe(8);
  });

  it('cuts it for the widest body in the fight, not for each body’s own size', () => {
    // A spider alone would get a fine ring; a ravager joining coarsens it for
    // both, because a ring that says a ravager fits where it does not is worse
    // than a ring a spider has room to spare on.
    const board = new SlotBoard();
    board.note(1, 68.8, 12);
    const alone = board.cuts(1);
    board.note(1, 68.8, 30);
    expect(board.cuts(1)).toBeLessThan(alone);
    expect(board.cuts(1)).toBe(6);
  });

  it('cuts it for the tightest ring anybody is closing to', () => {
    // A slinger stands off at 252.8 and a stalker at 68.8. The count has to fit
    // the stalker's ring, or the two of them are counting different circles.
    const board = new SlotBoard();
    board.note(1, 252.8, 20);
    board.note(1, 68.8, 20);
    expect(board.cuts(1)).toBe(10);
  });

  it('gives every attacker a different place to stand', () => {
    const board = new SlotBoard();
    ringOf(board, 8);
    const taken = new Set<number>();
    for (let i = 0; i < 8; i++) taken.add(board.take(1, 0, -1));
    expect(taken.size).toBe(8);
    expect(taken.has(-1)).toBe(false);
  });

  it('gives an attacker the slot it approached from when it is free', () => {
    const board = new SlotBoard();
    ringOf(board, 8);
    expect(board.take(1, 5, -1)).toBe(5);
    expect(board.take(1, 2, -1)).toBe(2);
  });

  it('offers the nearest free slot when the wanted one is taken', () => {
    const board = new SlotBoard();
    ringOf(board, 8);
    board.take(1, 4, -1);
    // 4 is gone, so 5 or 3; the spiral tries the positive side first.
    expect(board.take(1, 4, -1)).toBe(5);
    expect(board.take(1, 4, -1)).toBe(3);
  });

  it('lets an attacker keep the slot it already held', () => {
    const board = new SlotBoard();
    ringOf(board, 8);
    // Somebody else asks for 3 first, but the holder of 3 still gets it.
    expect(board.take(1, 3, 6)).toBe(6);
    expect(board.take(1, 3, -1)).toBe(3);
  });

  it('does not let a held slot be claimed twice', () => {
    const board = new SlotBoard();
    ringOf(board, 8);
    expect(board.take(1, 0, 3)).toBe(3);
    expect(board.take(1, 0, 3)).not.toBe(3);
  });

  /**
   * The half of the hysteresis `take` alone cannot give. Claims are taken in
   * entity creation order, so without a reservation an older body with no slot
   * walks off with the angle a younger one has been walking toward.
   */
  it('holds a slot for the body that was already walking to it', () => {
    const board = new SlotBoard();
    ringOf(board, 8);
    board.reserve(1, 4);
    // An older body wants 4 and is refused it; the holder gets it afterwards.
    expect(board.take(1, 4, -1)).not.toBe(4);
    expect(board.take(1, 4, 4)).toBe(4);
  });

  it('does not let a body be refused its own reservation', () => {
    const board = new SlotBoard();
    ringOf(board, 8);
    board.reserve(1, 4);
    expect(board.take(1, 0, 4)).toBe(4);
  });

  it('ignores a reservation for a slot the ring does not have', () => {
    const board = new SlotBoard();
    ringOf(board, 6);
    board.reserve(1, 11);
    const taken = new Set<number>();
    for (let i = 0; i < 6; i++) taken.add(board.take(1, 0, -1));
    expect(taken.size).toBe(6);
  });

  it('says so when the ring is full rather than doubling up', () => {
    const board = new SlotBoard();
    ringOf(board, 4);
    for (let i = 0; i < 4; i++) board.take(1, i, -1);
    expect(board.take(1, 0, -1)).toBe(-1);
  });

  it('keeps one target’s ring separate from another’s', () => {
    const board = new SlotBoard();
    ringOf(board, 8, 1);
    ringOf(board, 8, 2);
    expect(board.take(1, 0, -1)).toBe(0);
    expect(board.take(2, 0, -1)).toBe(0);
  });

  it('forgets everything when cleared, so a tick starts empty', () => {
    const board = new SlotBoard();
    ringOf(board, 4);
    for (let i = 0; i < 4; i++) board.take(1, i, -1);
    expect(board.take(1, 0, -1)).toBe(-1);
    board.clear();
    ringOf(board, 4);
    expect(board.take(1, 0, -1)).toBe(0);
  });

  it('answers about a target nobody has noted without hanging or throwing', () => {
    const board = new SlotBoard();
    expect(board.cuts(99)).toBe(1);
    expect(board.take(99, 5, -1)).toBe(0);
    expect(board.take(99, 5, -1)).toBe(-1);
  });

  it('holds a slot outside the ring it was taken on to the ring instead', () => {
    const board = new SlotBoard();
    ringOf(board, 6);
    // A body that held slot 11 on a finer ring must not be handed a slot that
    // does not exist on this one.
    const got = board.take(1, 0, 11);
    expect(got).toBeGreaterThanOrEqual(0);
    expect(got).toBeLessThan(6);
  });
});
