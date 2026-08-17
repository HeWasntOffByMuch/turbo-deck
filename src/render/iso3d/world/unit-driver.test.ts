import { beforeEach, describe, expect, it } from 'vitest';
import { EntityActivity, CastPhaseValue } from '../../../server/net/protocol.js';
import { clipLibFixture, unitDefFixture } from '../../../units/fixtures.js';
import { bundleErrorText, loadUnitBundle } from '../../../units/bundle.js';
import { UnitMachine } from '../../../units/machine.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  advanceSpeed,
  BLEND_SLEW_PER_SECOND,
  driveUnit,
  hasDeathAnimation,
  slewSpeed,
  speedBetween,
  startedCasting,
  STOPPED,
  type SpeedClock,
  type UnitFacts,
} from './unit-driver.js';

function facts(patch: Partial<UnitFacts> = {}): UnitFacts {
  return {
    speed: 0,
    activity: EntityActivity.Idle,
    castPhase: null,
    attackRate: 1,
    abilityId: null,
    dead: false,
    ...patch,
  };
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


describe('slewSpeed', () => {
  const slew = (from: number, to: number, ticks = 1): number => slewSpeed(from, to, ticks, TICK_SECONDS);

  it('holds still on a frame that drained no tick', () => {
    // Same clock rule as `advanceSpeed`: a signal the sim owns does not advance
    // because the browser drew a frame.
    expect(slewSpeed(100, 0, 0, TICK_SECONDS)).toBe(100);
  });

  it('reaches the target and stays there', () => {
    let value = MOVE_SPEED;
    for (let tick = 0; tick < 60; tick += 1) value = slew(value, 0);
    expect(value).toBe(0);
    expect(slew(value, 0)).toBe(0);
  });

  it('never overshoots from either side', () => {
    expect(slew(0, 3)).toBe(3);
    expect(slew(3, 0)).toBe(0);
  });

  it('is monotone toward the target', () => {
    let value = MOVE_SPEED;
    for (let tick = 0; tick < 20; tick += 1) {
      const next = slew(value, 0);
      expect(next).toBeLessThanOrEqual(value);
      value = next;
    }
  });

  it('is framerate independent on the sim clock', () => {
    let stepped = MOVE_SPEED;
    for (let tick = 0; tick < 6; tick += 1) stepped = slew(stepped, 0);
    expect(slew(MOVE_SPEED, 0, 6)).toBeCloseTo(stepped, 10);
  });

  it('gives up full speed in about the 150ms the transitions are authored at', () => {
    const ticks = Math.ceil(MOVE_SPEED / (BLEND_SLEW_PER_SECOND * TICK_SECONDS));
    // The ramp itself, plus at most the one tick rounding up to a whole one
    // costs. Both halves named rather than a single magic bound, because the
    // point of the number is that it matches the authored transition.
    const ramp = (MOVE_SPEED / BLEND_SLEW_PER_SECOND) * 1000;
    expect(ramp).toBeLessThanOrEqual(160);
    expect(ticks * TICK_MS).toBeLessThanOrEqual(ramp + TICK_MS);
    expect(slew(MOVE_SPEED, 0, ticks)).toBe(0);
  });

  it('crosses the transition threshold within one tick when setting off', () => {
    // Rising, the slew must not delay `speed > 5` or the state change would lag
    // the input by a visible amount.
    expect(slew(0, MOVE_SPEED)).toBeGreaterThan(5);
  });
});

describe('stopping, through the pig\'s real thresholds', () => {
  /**
   * The regression this exists for (spec 119).
   *
   * Read off the committed unitdef rather than restated here: the fault was a
   * parameter stepping straight over the walk band, and a test that invented
   * its own thresholds could not have noticed.
   */
  const machineDoc = JSON.parse(
    readFileSync(
      join(process.cwd(), 'assets/units/pig_a_pose_full/pig_a_pose_full.unitdef.json'),
      'utf8',
    ),
  ) as { stateMachine: { blendTrees: { id: string; thresholds: { value: number; clipRef: string }[] }[] } };
  const move = machineDoc.stateMachine.blendTrees.find((tree) => tree.id === 'move');
  const walk = move?.thresholds.find((threshold) => threshold.clipRef === 'walk')?.value ?? 0;
  const run = move?.thresholds.find((threshold) => threshold.clipRef === 'run')?.value ?? 0;

  it('has the thresholds this test is about', () => {
    expect(walk).toBeGreaterThan(0);
    expect(run).toBeGreaterThan(walk);
  });

  it('visits the walk band on the way down instead of stepping over it', () => {
    let value = MOVE_SPEED;
    let inWalkBand = 0;
    for (let tick = 0; tick < 60 && value > 0; tick += 1) {
      value = slewSpeed(value, 0, 1, TICK_SECONDS);
      if (value >= walk && value < run) inWalkBand += 1;
    }
    // Several ticks of actual walk, not a single frame clipping through it.
    expect(inWalkBand).toBeGreaterThanOrEqual(4);
  });

  it('spends the whole descent somewhere the tree can blend', () => {
    let value = MOVE_SPEED;
    const seen: number[] = [];
    while (value > 0) {
      value = slewSpeed(value, 0, 1, TICK_SECONDS);
      seen.push(value);
    }
    expect(seen.length).toBeGreaterThanOrEqual(8);
    expect(seen[seen.length - 1]).toBe(0);
  });

  it('is what the old assignment was not', () => {
    // The behaviour being replaced, stated so the diff has a control: assigning
    // the measured speed put the tree on the idle clip in one tick, which is
    // the cut that was reported.
    const assigned = 0;
    expect(assigned < walk).toBe(true);
    expect(slewSpeed(MOVE_SPEED, 0, 1, TICK_SECONDS)).toBeGreaterThan(walk);
  });
});


describe('the pig, driven to a stop through its own machine', () => {
  /**
   * The whole fix, end to end (spec 119): the real unitdef, the real machine,
   * a real stop, and the question the report was about -- does the run pose
   * fade, or is it simply gone.
   */
  const DIR = 'assets/units/pig_a_pose_full';
  const read = (name: string): unknown =>
    JSON.parse(readFileSync(join(process.cwd(), DIR, name), 'utf8'));
  // The clip library lives a directory up, with the family (spec 139): it is
  // the biped family's, not this body's, and every member reads the same one.
  const readFamily = (name: string): unknown =>
    JSON.parse(readFileSync(join(process.cwd(), 'assets/units', name), 'utf8'));
  const bundle = loadUnitBundle(read('pig_a_pose_full.unitdef.json'), readFamily('biped.core.cliplib.json'));

  /** Weight of one clip in a tick's poses, summed over both blending layers. */
  const weightOf = (poses: readonly { clipId: string; weight: number }[], clipId: string): number =>
    poses.filter((pose) => pose.clipId === clipId).reduce((total, pose) => total + pose.weight, 0);

  /** Run for `ticks`, holding `speed`, and report what each tick drew. */
  function drive(
    machine: UnitMachine,
    blend: number,
    target: number,
    ticks: number,
  ): { blend: number; frames: { run: number; walk: number; idle: number }[] } {
    const frames: { run: number; walk: number; idle: number }[] = [];
    let value = blend;
    for (let tick = 0; tick < ticks; tick += 1) {
      value = slewSpeed(value, target, 1, TICK_SECONDS);
      machine.setParameter('speed', value);
      machine.step(1);
      const poses = machine.poses();
      frames.push({
        run: weightOf(poses, 'run'),
        walk: weightOf(poses, 'walk'),
        idle: weightOf(poses, 'idle'),
      });
    }
    return { blend: value, frames };
  }

  it('loads', () => {
    expect(bundle.value, bundleErrorText(bundle)).not.toBeNull();
  });

  it('fades the run out over several ticks instead of dropping it in one', () => {
    const loaded = bundle.value;
    if (!loaded) throw new Error(bundleErrorText(bundle));
    const machine = new UnitMachine({ unit: loaded.unit, clipLib: loaded.clipLib });

    // Up to speed first, and settled there.
    const running = drive(machine, 0, MOVE_SPEED, 60);
    expect(running.frames[running.frames.length - 1]?.run).toBeGreaterThan(0.9);

    // Then the move order ends: the measured speed steps to zero in one tick.
    const stopping = drive(machine, running.blend, 0, 60);

    // The run must not vanish in a single tick, which is what was reported.
    const runWeights = stopping.frames.map((frame) => frame.run);
    const ticksWithRun = runWeights.filter((weight) => weight > 0.01).length;
    expect(ticksWithRun).toBeGreaterThanOrEqual(5);

    // It must come down rather than hold and cut.
    expect(runWeights[0] ?? 0).toBeGreaterThan(0.5);
    expect(runWeights[runWeights.length - 1] ?? 1).toBeLessThan(0.01);

    // The walk is genuinely visited on the way down -- the band the old step
    // jumped clean over.
    expect(stopping.frames.some((frame) => frame.walk > 0.3)).toBe(true);

    // And it ends standing.
    expect(stopping.frames[stopping.frames.length - 1]?.idle).toBeGreaterThan(0.9);
  });

  it('never drops every clip at once while stopping', () => {
    const loaded = bundle.value;
    if (!loaded) throw new Error(bundleErrorText(bundle));
    const machine = new UnitMachine({ unit: loaded.unit, clipLib: loaded.clipLib });
    const running = drive(machine, 0, MOVE_SPEED, 60);
    for (const frame of drive(machine, running.blend, 0, 60).frames) {
      // A tick that drew nothing would be a body that blinked.
      expect(frame.run + frame.walk + frame.idle).toBeGreaterThan(0.5);
    }
  });
});


describe('hasDeathAnimation', () => {
  /**
   * The scene squashes a corpse to 0.6 so a kill reads. That is right for the
   * procedural rigs, which have no death clip, and wrong for a body that falls
   * over by itself -- which drew the pig at half size for the whole of its
   * collapse and snapped it back to full size on respawn.
   */
  const DIR = 'assets/units/pig_a_pose_full';
  const read = (name: string): unknown =>
    JSON.parse(readFileSync(join(process.cwd(), DIR, name), 'utf8'));
  // The clip library lives a directory up, with the family (spec 139): it is
  // the biped family's, not this body's, and every member reads the same one.
  const readFamily = (name: string): unknown =>
    JSON.parse(readFileSync(join(process.cwd(), 'assets/units', name), 'utf8'));
  const bundle = loadUnitBundle(read('pig_a_pose_full.unitdef.json'), readFamily('biped.core.cliplib.json'));

  it('is true for the pig, which has a terminal state to fall into', () => {
    const unit = bundle.value?.unit;
    if (!unit) throw new Error(bundleErrorText(bundle));
    expect(hasDeathAnimation(unit)).toBe(true);
  });

  it('is the same answer before the machine has caught up', () => {
    // The reason this asks the document and not the current state: a corpse the
    // client joined to find already on the ground spends its first frame in the
    // entry state, and a per-frame answer would pop it from squashed to full.
    const loaded = bundle.value;
    if (!loaded) throw new Error(bundleErrorText(bundle));
    const driven = new UnitMachine({ unit: loaded.unit, clipLib: loaded.clipLib });
    expect(driven.stateId).toBe('idle');
    expect(hasDeathAnimation(loaded.unit)).toBe(true);
    driveUnit(driven, facts({ dead: true }), facts(), 1);
    expect(driven.stateId).toBe('down');
    expect(hasDeathAnimation(loaded.unit)).toBe(true);
  });

  it('is false for a unit whose author wired no death state', () => {
    // That body still needs the squash, and gets it without anyone having to
    // remember the rule.
    const bare = unitDefFixture();
    const noDeath = {
      ...bare,
      stateMachine: {
        ...bare.stateMachine,
        states: bare.stateMachine.states.map((state) => ({ ...state, category: 'loop' as const })),
      },
    };
    expect(hasDeathAnimation(noDeath)).toBe(false);
  });
});
