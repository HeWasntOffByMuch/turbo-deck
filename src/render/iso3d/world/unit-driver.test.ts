import { beforeEach, describe, expect, it } from 'vitest';
import { EntityActivity, CastPhaseValue } from '../../../server/net/protocol.js';
import { clipLibFixture, unitDefFixture } from '../../../units/fixtures.js';
import { UnitMachine } from '../../../units/machine.js';
import {
  advanceSpeed,
  driveUnit,
  speedBetween,
  startedCasting,
  STOPPED,
  type SpeedClock,
  type UnitFacts,
} from './unit-driver.js';

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

const TICK_SECONDS = 1 / 60;
const TICK_MS = 1000 / 60;
/** What the player moves at, from `player/stats.ts`. */
const MOVE_SPEED = 155;

describe('advanceSpeed', () => {
  it('holds the last answer on a frame that drained no tick', () => {
    // The bug this exists for. A drawn position only moves when a tick drained,
    // so a frame that drained none has measured nothing -- and reporting that
    // as a stop is what put the pig's blend tree on the idle clip for most of
    // every second above 60fps.
    const running = advanceSpeed(STOPPED, MOVE_SPEED * TICK_SECONDS, 1, TICK_SECONDS);
    expect(running.speed).toBeCloseTo(MOVE_SPEED, 6);
    expect(advanceSpeed(running, 0, 0, TICK_SECONDS).speed).toBeCloseTo(MOVE_SPEED, 6);
  });

  it('carries the travel of a zero-tick frame into the next measurement', () => {
    // Nothing is lost, only deferred: a remote body does move between ticks,
    // and dropping that distance would read as a body slower than it is.
    let clock: SpeedClock = STOPPED;
    for (let i = 0; i < 3; i += 1) clock = advanceSpeed(clock, 1, 0, TICK_SECONDS);
    expect(clock.pending).toBe(3);
    expect(advanceSpeed(clock, 0, 1, TICK_SECONDS).speed).toBeCloseTo(3 * 60, 6);
  });

  it('reports the same speed at every refresh rate', () => {
    // A body moving a fixed distance per tick is moving at one speed, and how
    // often the browser painted is not part of it.
    for (const refreshHz of [30, 60, 75, 120, 144, 165]) {
      const seen = drive(refreshHz, 240).speeds.slice(60);
      for (const speed of seen) expect(speed, `${refreshHz}Hz`).toBeCloseTo(MOVE_SPEED, 6);
    }
  });

  it('reads a stop within a tick of it happening', () => {
    const running = advanceSpeed(STOPPED, MOVE_SPEED * TICK_SECONDS, 1, TICK_SECONDS);
    expect(advanceSpeed(running, 0, 1, TICK_SECONDS).speed).toBe(0);
  });

  it('ignores travel that is not a number', () => {
    expect(advanceSpeed(STOPPED, Number.NaN, 1, TICK_SECONDS).speed).toBe(0);
    expect(advanceSpeed(STOPPED, -5, 1, TICK_SECONDS).speed).toBe(0);
    expect(advanceSpeed(STOPPED, 1, 1, 0).speed).toBe(0);
  });
});

/**
 * A body moving at a fixed rate per tick, drawn at `refreshHz` (spec 118).
 *
 * Mirrors the accumulator in `view.ts`: real time in, whole 60Hz steps out, and
 * a drawn position that only moves on the steps -- which is true of the local
 * player because prediction advances a tick at a time, and true of a remote one
 * because the interpolator has no newer sample to walk toward.
 */
function drive(refreshHz: number, frames: number) {
  const unit = machine();
  // The fixture's death transition reads `!grounded`, which nothing on the wire
  // drives. Standing up first keeps this about locomotion.
  unit.setParameter('grounded', true);
  const frameMs = 1000 / refreshHz;
  let accumulator = 0;
  let x = 0;
  let drawn = 0;
  let clock: SpeedClock = STOPPED;
  let previous: UnitFacts | null = null;
  const speeds: number[] = [];
  const clips: string[] = [];

  for (let frame = 0; frame < frames; frame += 1) {
    accumulator += frameMs;
    let ticks = 0;
    while (accumulator >= TICK_MS) {
      accumulator -= TICK_MS;
      ticks += 1;
      x += MOVE_SPEED * TICK_SECONDS;
    }
    clock = advanceSpeed(clock, x - drawn, ticks, TICK_SECONDS);
    drawn = x;
    const current = facts({ speed: clock.speed, activity: EntityActivity.Moving });
    driveUnit(unit, current, previous, ticks);
    previous = current;
    speeds.push(clock.speed);
    // What the renderer samples, which it does on every frame and not only on
    // the ones that stepped the machine.
    const poses = [...unit.poses()].sort((a, b) => b.weight - a.weight);
    clips.push(poses[0]?.clipId ?? 'none');
  }
  return { speeds, clips, stateId: unit.stateId };
}

describe('the blend tree over a real frame loop (spec 118)', () => {
  it('holds one gait for the whole run, at every refresh rate', () => {
    // The regression. Measured on the frame clock this alternated between the
    // run clip and frame 0.02 of a fifteen-second idle -- every other frame at
    // 120Hz, and 118 frames in 300 at 75Hz.
    for (const refreshHz of [30, 60, 75, 120, 144, 165]) {
      const { clips, stateId } = drive(refreshHz, 300);
      const settled = clips.slice(60);
      expect(new Set(settled), `${refreshHz}Hz`).toEqual(new Set(['run']));
      expect(stateId, `${refreshHz}Hz`).toBe('locomotion');
    }
  });

  it('still comes to rest when the body does', () => {
    // The other half: a clock that held its last answer forever would be a pig
    // that runs on the spot after it stops.
    const unit = machine();
    unit.setParameter('grounded', true);
    let clock: SpeedClock = STOPPED;
    let previous: UnitFacts | null = null;
    const moving = () => {
      clock = advanceSpeed(clock, MOVE_SPEED * TICK_SECONDS, 1, TICK_SECONDS);
      const current = facts({ speed: clock.speed, activity: EntityActivity.Moving });
      driveUnit(unit, current, previous, 1);
      previous = current;
    };
    for (let i = 0; i < 60; i += 1) moving();
    expect(unit.stateId).toBe('locomotion');

    for (let i = 0; i < 60; i += 1) {
      clock = advanceSpeed(clock, 0, 1, TICK_SECONDS);
      const current = facts({ speed: clock.speed });
      driveUnit(unit, current, previous, 1);
      previous = current;
    }
    expect(unit.stateId).toBe('idle');
  });
});
