import { beforeEach, describe, expect, it } from 'vitest';
import { EntityActivity, CastPhaseValue } from '../../../server/net/protocol.js';
import { clipLibFixture, unitDefFixture } from '../../../units/fixtures.js';
import { UnitMachine } from '../../../units/machine.js';
import { driveUnit, speedBetween, startedCasting, type UnitFacts } from './unit-driver.js';

function facts(patch: Partial<UnitFacts> = {}): UnitFacts {
  return { speed: 0, activity: EntityActivity.Idle, castPhase: null, dead: false, ...patch };
}

function machine(): UnitMachine {
  return new UnitMachine({ unit: unitDefFixture(), clipLib: clipLibFixture() });
}

describe('startedCasting', () => {
  it('is true on the tick a cast begins', () => {
    const casting = facts({ activity: EntityActivity.Casting, castPhase: CastPhaseValue.Windup });
    expect(startedCasting(casting, facts())).toBe(true);
  });

  it('is false for every tick after the first', () => {
    // A cast lasts many ticks. Raising the trigger on each would restart the
    // swing on every frame of its own wind-up.
    const windup = facts({ activity: EntityActivity.Casting, castPhase: CastPhaseValue.Windup });
    const channel = facts({ activity: EntityActivity.Casting, castPhase: CastPhaseValue.Channel });
    expect(startedCasting(windup, windup)).toBe(false);
    expect(startedCasting(channel, windup)).toBe(false);
  });

  it('is true again when the phase goes backwards', () => {
    // A second swing landing before the first finished replicating looks like
    // channel -> windup. Read as a continuation, every attack after the first
    // in a chain would be dropped.
    const channel = facts({ activity: EntityActivity.Casting, castPhase: CastPhaseValue.Channel });
    const nextWindup = facts({ activity: EntityActivity.Casting, castPhase: CastPhaseValue.Windup });
    expect(startedCasting(nextWindup, channel)).toBe(true);
  });

  it('counts a turn into a swing as the swing beginning', () => {
    // Turning to face the aim is part of committing to the blow (spec 065), so
    // the animation starts there rather than after the body has come round.
    const turning = facts({ activity: EntityActivity.Casting, castPhase: CastPhaseValue.Turning });
    expect(startedCasting(turning, facts())).toBe(true);
  });

  it('is false for a corpse', () => {
    const dead = facts({ activity: EntityActivity.Casting, castPhase: CastPhaseValue.Windup, dead: true });
    expect(startedCasting(dead, facts())).toBe(false);
  });

  it('is false when nothing is casting', () => {
    for (const activity of [EntityActivity.Idle, EntityActivity.Moving, EntityActivity.Stunned, EntityActivity.Dead]) {
      expect(startedCasting(facts({ activity }), facts()), String(activity)).toBe(false);
    }
  });
});

describe('driveUnit', () => {
  let unit: UnitMachine;
  beforeEach(() => {
    unit = machine();
  });

  it('steps by whole ticks and by nothing else', () => {
    driveUnit(unit, facts(), null, 3);
    expect(unit.tick).toBe(3);
    driveUnit(unit, facts(), facts(), 0);
    expect(unit.tick).toBe(3);
  });

  it('writes the speed the blend tree reads', () => {
    driveUnit(unit, facts({ speed: 42 }), null, 1);
    expect(unit.getParameter('speed')).toBe(42);
  });

  it('leaves a machine that declares none of them alone', () => {
    // An author who wired their machine on triggers alone should get a machine
    // driven by triggers alone, not a crash.
    const bare = unitDefFixture();
    const stripped = { ...bare, stateMachine: { ...bare.stateMachine, parameters: [] } };
    const quiet = new UnitMachine({ unit: stripped, clipLib: clipLibFixture() });
    expect(() => driveUnit(quiet, facts({ speed: 9 }), null, 1)).not.toThrow();
    expect(quiet.getParameter('speed')).toBeUndefined();
  });

  it('reaches the locomotion state from speed alone', () => {
    // End to end through the real machine: the wire says how fast a body is
    // going and the animation follows, with nothing in between deciding.
    const moving = facts({ speed: 80 });
    for (let i = 0; i < 30; i += 1) driveUnit(unit, moving, moving, 1);
    expect(unit.stateId).not.toBe('idle');
  });

  it('fires an event on the same tick however the ticks were chunked', () => {
    // The property the whole design exists for. One frame that drained six
    // ticks and six frames that drained one must be indistinguishable.
    const busy = facts({ speed: 80 });
    const chunked = machine();
    const single = machine();
    const a = [...driveUnit(chunked, busy, null, 6)];
    const b: typeof a = [];
    for (let i = 0; i < 6; i += 1) b.push(...driveUnit(single, busy, i === 0 ? null : busy, 1));
    expect(a).toEqual(b);
    expect(chunked.tick).toBe(single.tick);
  });

  it('starts the swing when the wire says a cast began', () => {
    const casting = facts({ activity: EntityActivity.Casting, castPhase: CastPhaseValue.Windup });
    driveUnit(unit, casting, facts(), 1);
    expect(unit.stateId).toBe('swing');
  });
});

describe('speedBetween', () => {
  it('is distance over time', () => {
    expect(speedBetween({ x: 0, y: 0 }, { x: 3, y: 4 }, 0.5)).toBe(10);
  });

  it('is zero when no time passed', () => {
    // An infinity into a blend tree clamps to a dead sprint, which is what a
    // paused tab used to look like on the frame it resumed.
    expect(speedBetween({ x: 0, y: 0 }, { x: 5, y: 0 }, 0)).toBe(0);
    expect(speedBetween({ x: 0, y: 0 }, { x: 5, y: 0 }, -1)).toBe(0);
    expect(speedBetween({ x: 0, y: 0 }, { x: 5, y: 0 }, Number.NaN)).toBe(0);
  });
});
