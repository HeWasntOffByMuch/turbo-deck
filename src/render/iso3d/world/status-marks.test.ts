import { describe, expect, it } from 'vitest';
import type { WireStatus } from '../../../server/net/messages.js';
import {
  ADAPTED_ID,
  STATUS_VISUALS,
  visualFor,
  type StatusIconId,
} from '../../../server/data/status-visuals.js';
import { ALL_DOTS, dotById } from '../../../server/data/damage-over-time.js';
import { StatusId } from '../../../server/sim/statuses.js';
import { FADE_TICKS, formatTimer, statusMarks } from './status-marks.js';

/** The wire index for a status id, so a test reads by name rather than by number. */
function wireOf(id: string): number {
  const visual = visualFor(id);
  if (!visual) throw new Error(`no visible row for ${id}`);
  return visual.wire;
}

function status(id: string, expiresAtTick: number, stacks = 1): WireStatus {
  return { wire: wireOf(id), stacks, expiresAtTick };
}

describe('statusMarks (spec 186)', () => {
  it('draws a live status', () => {
    const marks = statusMarks([status(StatusId.Flow, 100, 2)], 40);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.id).toBe(StatusId.Flow);
    expect(marks[0]?.kind).toBe('boon');
    expect(marks[0]?.stacks).toBe(2);
    expect(marks[0]?.opacity).toBe(1);
  });

  it('refuses a window that has already passed, whatever the delta said', () => {
    // The property the whole design rests on. Nothing prunes the replicated
    // list, so a status that ran out three seconds ago is still sitting in it,
    // and drawing it would put a mark on screen the sim stopped honouring. Same
    // comparison `statusOf` makes in the sim and `stunMark` makes about a
    // stagger.
    expect(statusMarks([status(StatusId.Exposed, 100)], 100)).toHaveLength(0);
    expect(statusMarks([status(StatusId.Exposed, 100)], 250)).toHaveLength(0);
  });

  it('marks a body first seen mid-status', () => {
    // There is no observed start to have missed: a body that is Exposed right
    // now is Exposed whether or not this client watched the weak point. This is
    // the difference from `stagger-flinch`, which correctly refuses.
    const marks = statusMarks([status(StatusId.Exposed, 500)], 499);
    expect(marks).toHaveLength(1);
  });

  it('is stateless: the same arguments give the same answer, always', () => {
    const held = [status(StatusId.Attuned, 200, 3)];
    const first = statusMarks(held, 60);
    const second = statusMarks(held, 60);
    expect(second).toEqual(first);
    // And asking about a later tick does not disturb the earlier answer.
    statusMarks(held, 190);
    expect(statusMarks(held, 60)).toEqual(first);
  });

  it('orders by wire index rather than by the order it was handed', () => {
    const scrambled = [
      status(StatusId.Sundered, 300),
      status(StatusId.Flow, 300),
      status(StatusId.Exposed, 300),
      status(StatusId.Momentum, 300),
    ];
    const ids = statusMarks(scrambled, 0).map((mark) => mark.id);
    expect(ids).toEqual([StatusId.Flow, StatusId.Momentum, StatusId.Exposed, StatusId.Sundered]);
    // Reversing the input must not reverse the picture.
    expect(statusMarks([...scrambled].reverse(), 0).map((mark) => mark.id)).toEqual(ids);
  });

  it('fades over a count of ticks, not a fraction of the window', () => {
    // The short window and the long one tail off identically -- which is the
    // whole reason the fade is a count. A fraction would fade a several-second
    // Adaptation for seconds and a 1.2s Flow for a fifth of one.
    const short = statusMarks([status(StatusId.Flow, 30)], 30 - FADE_TICKS / 2);
    const long = statusMarks([status(StatusId.Flow, 3000)], 3000 - FADE_TICKS / 2);
    expect(short[0]?.opacity).toBeCloseTo(0.5, 5);
    expect(long[0]?.opacity).toBeCloseTo(0.5, 5);
  });

  it('is at full opacity until the last few ticks, and never fades in', () => {
    expect(statusMarks([status(StatusId.Flow, 100)], 1)[0]?.opacity).toBe(1);
    expect(statusMarks([status(StatusId.Flow, 100)], 100 - FADE_TICKS)[0]?.opacity).toBe(1);
    expect(statusMarks([status(StatusId.Flow, 100)], 99)[0]?.opacity).toBeCloseTo(1 / FADE_TICKS, 5);
  });

  it('shows a count only where the count can mean something', () => {
    const flow = statusMarks([status(StatusId.Flow, 100, 3)], 0)[0];
    const sundered = statusMarks([status(StatusId.Sundered, 100, 1)], 0)[0];
    expect(flow?.showsCount).toBe(true);
    // A "1" over a status that can only ever be 1 is a number that never means
    // anything.
    expect(sundered?.showsCount).toBe(false);
  });

  it('clamps a count to what the sim would let that status reach', () => {
    const visual = visualFor(StatusId.Flow);
    const marks = statusMarks([status(StatusId.Flow, 100, 99)], 0);
    expect(marks[0]?.stacks).toBe(visual?.maxStacks);
    expect(statusMarks([status(StatusId.Flow, 100, 0)], 0)[0]?.stacks).toBe(1);
  });

  it('drops a wire index this build has no row for', () => {
    // A client talking to a newer server. The decoder reads the bytes so the
    // frame stays aligned; the drawing is where an unnamed glyph is refused.
    const unknown: WireStatus = { wire: 240, stacks: 1, expiresAtTick: 500 };
    expect(statusMarks([unknown], 0)).toHaveLength(0);
    expect(statusMarks([unknown, status(StatusId.Flow, 500)], 0)).toHaveLength(1);
  });

  it('draws nothing for a body carrying nothing', () => {
    expect(statusMarks([], 40)).toHaveLength(0);
  });

  it('survives a nonsense tick without inventing a mark', () => {
    expect(statusMarks([status(StatusId.Flow, 100)], Number.NaN)).toHaveLength(1);
    expect(
      statusMarks([{ wire: wireOf(StatusId.Flow), stacks: 1, expiresAtTick: Number.NaN }], 0),
    ).toHaveLength(0);
  });

  it('has a glyph and a kind for every row in the table', () => {
    // A row added without a picture would draw the fallback glyph on every body
    // that ever carried it, which looks filled in and says nothing.
    const at = 500;
    const all = STATUS_VISUALS.map((visual) => ({
      wire: visual.wire,
      stacks: 1,
      expiresAtTick: at,
    }));
    const marks = statusMarks(all, 0);
    expect(marks).toHaveLength(STATUS_VISUALS.length);
    for (const mark of marks) {
      expect(mark.icon, mark.id).toBeTruthy();
      expect(['boon', 'affliction'], mark.id).toContain(mark.kind);
      expect(mark.name, mark.id).toBeTruthy();
    }
  });
});

describe('countdowns (spec 191)', () => {
  it('counts down against the drawn tick', () => {
    const marks = statusMarks([status(StatusId.Exposed, 200)], 80);
    expect(marks[0]?.remainingTicks).toBe(120);
    expect(marks[0]?.timer).toBe('2.0');
  });

  it('shows one decimal below ten seconds and whole seconds above', () => {
    // A stated duration is read once; a countdown is read while it moves, so it
    // is rounded harder than the description standard's two decimals.
    expect(formatTimer(60 * 2.4)).toBe('2.4');
    expect(formatTimer(60 * 9.9)).toBe('9.9');
    expect(formatTimer(60 * 10)).toBe('10');
    expect(formatTimer(60 * 42.3)).toBe('43');
  });

  it('never reads as finished while the mark is still up', () => {
    // A mark with one tick left is still on the body, so a timer that had
    // already reached zero would be describing a status that is gone.
    expect(formatTimer(1)).not.toBe('0.0');
    const marks = statusMarks([status(StatusId.Slowed, 101)], 100);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.timer).not.toBe('0.0');
  });

  it('draws no timer for a status the design says has no clock', () => {
    // Prepared is applied with an effectively infinite window and ends by being
    // spent. A countdown toward that is a clock nothing is running.
    const marks = statusMarks([status(StatusId.Prepared, 500)], 0);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.remainingTicks).toBeNull();
    expect(marks[0]?.timer).toBeNull();
  });

  it('draws no timer for a remaining time that cannot be trusted', () => {
    // What the u32 truncation of `MAX_SAFE_INTEGER - tick` actually delivers.
    // Flow is a row with no `indefinite` flag, so this is the *value* rule
    // rather than the design one, and it has to hold on its own.
    const marks = statusMarks([status(StatusId.Flow, 0xffffffff)], 0);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.remainingTicks).toBeNull();
    expect(marks[0]?.timer).toBeNull();
  });

  it('still times a status whose window is merely long', () => {
    const marks = statusMarks([status(ADAPTED_ID, 60 * 600)], 0);
    expect(marks[0]?.remainingTicks).toBe(60 * 600);
    expect(marks[0]?.timer).toBe('600');
  });
});

/**
 * The afflictions over a body (spec 190).
 *
 * Every row spec 186 shipped was something a build *earned*, and losing one
 * cost nothing but a boon. These seven take health while they are on, so the
 * mark is the only thing that tells being poisoned apart from being wrong about
 * your own health bar -- which makes three things worth pinning down.
 *
 * **The two tables have to agree.** The affliction is authored in
 * `data/damage-over-time.ts` and the picture in `data/status-visuals.ts`, and
 * nothing forces them to name the same thing: a row added to one and not the
 * other is a mark with no glyph or a mechanic with no mark, and both look fine
 * from inside their own file.
 *
 * **The count is only worth drawing where it can move.** Poison at five is the
 * whole of that affliction and Burn is the same fire refreshed, so one shows a
 * number and the other must not -- and the ceiling the clamp uses is the sim's
 * own, not a second opinion about how deep a poison can get.
 *
 * **A window that has passed draws nothing.** Nothing prunes the replicated
 * list, and a pulse pass that has stopped is invisible from out here, so the
 * comparison is the only thing that takes the mark off.
 */
describe('the afflictions (spec 190)', () => {
  /**
   * The glyph each affliction is drawn with.
   *
   * Written out rather than read back off the table, because reading the table
   * would only prove that it agrees with itself -- and a glyph swapped between
   * two rows is exactly the mistake that survives that.
   */
  const GLYPHS: Readonly<Record<string, StatusIconId>> = {
    [StatusId.Burn]: 'burn',
    [StatusId.Bleed]: 'bleed',
    [StatusId.Poison]: 'poison',
    [StatusId.Corrosion]: 'corrosion',
    [StatusId.Shock]: 'shock',
    [StatusId.Frostbite]: 'frostbite',
    [StatusId.Decay]: 'decay',
  };

  it('draws every affliction the sim can apply, named and pictured as its own row', () => {
    for (const row of ALL_DOTS) {
      // `status` looks the wire index up by id, so a row with no picture at all
      // fails here rather than going quietly missing from the loop.
      const marks = statusMarks([status(row.id, 500)], 0);
      expect(marks, row.id).toHaveLength(1);
      const mark = marks[0];
      expect(mark?.id, row.id).toBe(row.id);
      // One string, in two tables. The name over the head is the one nobody can
      // check against the mechanic, so it is checked here instead.
      expect(mark?.name, row.id).toBe(row.name);
      expect(mark?.icon, row.id).toBe(GLYPHS[row.id]);
      // Colour comes from the kind and from nothing else, and there is no
      // reading of any of these seven under which one is good for you.
      expect(mark?.kind, row.id).toBe('affliction');
    }
    expect(ALL_DOTS).toHaveLength(7);
  });

  it('shows a stacking affliction’s count and clamps it to the sim’s own ceiling', () => {
    const poison = dotById(StatusId.Poison);
    const visual = visualFor(StatusId.Poison);
    // The ceiling the mark clamps to and the concentration doing the damage are
    // one number, so the two tables are asked to say it together.
    expect(visual?.maxStacks).toBe(poison?.maxStacks);

    const deep = statusMarks([status(StatusId.Poison, 500, 99)], 0)[0];
    expect(deep?.showsCount).toBe(true);
    expect(deep?.stacks).toBe(poison?.maxStacks);
    // One dart still draws its "1": there the number is live, and hiding it
    // would read as "this one does not stack".
    expect(statusMarks([status(StatusId.Poison, 500, 1)], 0)[0]?.showsCount).toBe(true);
  });

  it('shows no count for an affliction that is refreshed rather than stacked', () => {
    // A second Ember Toss is the same fire on a new clock, so a count over it
    // could only ever be a 1.
    const burn = statusMarks([status(StatusId.Burn, 500)], 0)[0];
    expect(burn?.showsCount).toBe(false);
    expect(burn?.stacks).toBe(1);
    expect(dotById(StatusId.Burn)?.maxStacks).toBe(1);
  });

  it('draws nothing for an affliction whose window has passed, however stale the delta said', () => {
    // The delta carries whatever was in the map when it was built, and the pulse
    // pass stopping is invisible from out here -- so a body that shook a poison
    // off two seconds ago must not still be wearing five stacks of it.
    expect(statusMarks([status(StatusId.Poison, 400, 5)], 400)).toHaveLength(0);
    expect(statusMarks([status(StatusId.Poison, 400, 5)], 520)).toHaveLength(0);

    // And the one still running beside it is untouched: the refusal is per
    // entry, not a decision about the body.
    const marks = statusMarks([status(StatusId.Poison, 400, 5), status(StatusId.Burn, 900)], 520);
    expect(marks.map((mark) => mark.id)).toEqual([StatusId.Burn]);
  });
});
