/**
 * The withdrawal rule (spec 155). Headless: the whole reason it is a function
 * rather than three lines in `view.ts` is that "does the shot go off at a
 * corpse" should be answerable without a canvas.
 */

import { describe, expect, it } from 'vitest';
import { CastPhaseValue } from '../../../server/net/protocol.js';
import { committedPhase } from './cast.js';
import { windupLostItsMark, windupLostItsMarkIn, type LostMarkInput } from './withdraw.js';

const MARK_ID = 7;

function ask(overrides: Partial<LostMarkInput> = {}): boolean {
  return windupLostItsMark({
    cast: { phase: CastPhaseValue.Windup, targetEntityId: MARK_ID },
    mark: null,
    ...overrides,
  });
}

/** The two phases before the attack point, and the two after it (spec 144). */
const BEFORE = [CastPhaseValue.Windup, CastPhaseValue.Turning];
const AFTER = [CastPhaseValue.Backswing, CastPhaseValue.Channel];

describe('a wind-up whose mark is gone (spec 155)', () => {
  for (const phase of BEFORE) {
    it(`withdraws when the body has left the world, in phase ${phase}`, () => {
      // Absent rather than dead, which is what a monster actually is: since
      // spec 076 it is swept out of the world on the tick it dies, so the view
      // never holds it at zero health.
      expect(ask({ cast: { phase, targetEntityId: MARK_ID }, mark: null })).toBe(true);
    });

    it(`withdraws when the body is dead but still standing, in phase ${phase}`, () => {
      // A dead *player* stays in the world (`sim/world.ts` keeps the id stable
      // across a death), so this is the half the absence test cannot reach.
      expect(ask({ cast: { phase, targetEntityId: MARK_ID }, mark: { health: 0 } })).toBe(true);
      expect(ask({ cast: { phase, targetEntityId: MARK_ID }, mark: { health: -20 } })).toBe(true);
    });

    it(`holds while the mark is alive, in phase ${phase}`, () => {
      expect(ask({ cast: { phase, targetEntityId: MARK_ID }, mark: { health: 1 } })).toBe(false);
    });
  }

  for (const phase of AFTER) {
    it(`holds past the attack point, in phase ${phase}`, () => {
      // The blow already happened: there is nothing to prevent, and cutting the
      // follow-through short would be movement the player never asked for.
      expect(ask({ cast: { phase, targetEntityId: MARK_ID }, mark: null })).toBe(false);
      expect(ask({ cast: { phase, targetEntityId: MARK_ID }, mark: { health: 0 } })).toBe(false);
    });
  }

  it('never withdraws from a cast aimed at the ground', () => {
    // A blast placed where three bodies were standing is still placed there
    // when they scatter. `targetEntityId === 0` is the point aim (spec 070).
    for (const phase of [...BEFORE, ...AFTER]) {
      expect(ask({ cast: { phase, targetEntityId: 0 }, mark: null })).toBe(false);
      expect(ask({ cast: { phase, targetEntityId: 0 }, mark: { health: 0 } })).toBe(false);
    }
  });

  it('never withdraws when there is no cast', () => {
    expect(ask({ cast: null, mark: null })).toBe(false);
    expect(ask({ cast: null, mark: { health: 0 } })).toBe(false);
  });

  /**
   * The boundary is read from one place, so the bar and the rule cannot come to
   * different answers about which side of the attack point a phase is on.
   */
  it('turns on the same boundary the cast bar draws', () => {
    for (const phase of BEFORE) expect(committedPhase(phase)).toBe(false);
    for (const phase of AFTER) expect(committedPhase(phase)).toBe(true);
    for (const phase of [...BEFORE, ...AFTER]) {
      expect(ask({ cast: { phase, targetEntityId: MARK_ID }, mark: null })).toBe(
        !committedPhase(phase),
      );
    }
  });
});

/**
 * The lookup half: which cast is ours, and which body it names. Its own tests
 * because the shipped `sendInput` and the two wire harnesses all reach the rule
 * through it, so a mistake here is a mistake in three places at once.
 */
describe('finding our own blow in a client view (spec 155)', () => {
  const SELF = 1;
  const OTHER = 2;

  function view(
    casts: readonly { entityId: number; phase: number; targetEntityId: number }[],
    entities: readonly { id: number; health: number }[],
  ): { selfEntityId: number; casts: typeof casts; entities: typeof entities } {
    return { selfEntityId: SELF, casts, entities };
  }

  const OURS = { entityId: SELF, phase: CastPhaseValue.Windup, targetEntityId: MARK_ID };

  it('withdraws when our own wind-up names a body the view no longer holds', () => {
    expect(windupLostItsMarkIn(view([OURS], [{ id: SELF, health: 100 }]))).toBe(true);
  });

  it('holds while the body is still in the view', () => {
    const entities = [
      { id: SELF, health: 100 },
      { id: MARK_ID, health: 3 },
    ];
    expect(windupLostItsMarkIn(view([OURS], entities))).toBe(false);
  });

  it('reads our cast and not somebody else\'s', () => {
    // A monster winding up at a body that just died is the *server's* business
    // (spec 080), and nothing this client does may touch it.
    const theirs = { entityId: OTHER, phase: CastPhaseValue.Windup, targetEntityId: MARK_ID };
    expect(windupLostItsMarkIn(view([theirs], [{ id: SELF, health: 100 }]))).toBe(false);
    expect(windupLostItsMarkIn(view([theirs, OURS], [{ id: SELF, health: 100 }]))).toBe(true);
  });

  it('holds when we are casting nothing', () => {
    expect(windupLostItsMarkIn(view([], [{ id: SELF, health: 100 }]))).toBe(false);
  });
});
