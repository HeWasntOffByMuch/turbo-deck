/**
 * An attack that was called off stops being drawn (spec 166).
 *
 * Beside `pig-swing.test.ts` and `pig-shoot.test.ts`, and for the reason those
 * give: the decision lives in `unit-driver.ts` under `src/render/`, and
 * `src/units/` may not import it, so "does a withdrawal reach the machine" can
 * only be asked from this side of the fence.
 *
 * The behaviour it pins is the one the whole game is built around. `melee.slash`
 * has a 500ms wind-up a player may withdraw from, and the sim refunds
 * everything when they do -- and the pig went on to finish the chop anyway, over
 * the next three hundred milliseconds, impact frame included, for a blow the
 * server had already agreed did not happen.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { abilityById } from '../../../server/data/abilities.js';
import { SERVER_TICK_RATE } from '../../../server/config.js';
import { CastPhaseValue, EntityActivity } from '../../../server/net/protocol.js';
import { loadUnitBundle } from '../../../units/bundle.js';
import { UnitMachine } from '../../../units/machine.js';
import { SHOT_DURATION_MS } from '../../../units/pig-shot.js';
import { STRIKE_DURATION_MS } from '../../../units/pig-strike.js';
import { cancelledCast, driveUnit, type UnitFacts } from './unit-driver.js';

const UNIT_DIR = join(process.cwd(), 'assets', 'units', 'pig_a_pose_full');
const FAMILY_DIR = join(process.cwd(), 'assets', 'units');

const bundle = loadUnitBundle(
  JSON.parse(readFileSync(join(UNIT_DIR, 'pig_a_pose_full.unitdef.json'), 'utf8')),
  JSON.parse(readFileSync(join(FAMILY_DIR, 'biped.core.cliplib.json'), 'utf8')),
);

function machineFor(entry = 'idle'): UnitMachine {
  const value = bundle.value;
  if (!value) throw new Error('the pig unit does not load');
  return new UnitMachine({ unit: value.unit, clipLib: value.clipLib, entryStateId: entry });
}

const IDLE: UnitFacts = {
  speed: 0,
  activity: EntityActivity.Idle,
  castPhase: null,
  attackRate: 1,
  abilityId: null,
  castTicksLeft: null,
  dead: false,
};

/** A cast in its wind-up with `left` ticks of itself still to run. */
function winding(abilityId: string, left: number): UnitFacts {
  return {
    ...IDLE,
    activity: EntityActivity.Casting,
    castPhase: CastPhaseValue.Windup,
    abilityId,
    castTicksLeft: left,
  };
}

/** The whole cast, in ticks: wind-up plus whatever tail the ability has. */
function castTicks(abilityId: string): number {
  const ability = abilityById(abilityId);
  return (ability?.windupTicks ?? 0) + (ability?.backswingTicks ?? 0);
}

describe('the rule', () => {
  it('is a cast that vanished with time still on it', () => {
    const slash = winding('melee.slash', 40);
    expect(cancelledCast(IDLE, slash)).toBe(true);
    // Still casting: nothing has been called off.
    expect(cancelledCast(slash, slash)).toBe(false);
    // Was not casting to begin with.
    expect(cancelledCast(IDLE, IDLE)).toBe(false);
    // No previous frame to compare against.
    expect(cancelledCast(IDLE, null)).toBe(false);
  });

  it('lets a cast that ran its course finish', () => {
    // The sampling margin. `previous` is the last frame that was driven, and a
    // frame at 20fps drains three ticks, so a cast ending on schedule is last
    // seen with a few left. Reading that as a cancellation would cut the tail
    // off every completed attack on a slow machine.
    expect(cancelledCast(IDLE, winding('melee.slash', 0))).toBe(false);
    expect(cancelledCast(IDLE, winding('melee.slash', 3))).toBe(false);
    expect(cancelledCast(IDLE, winding('melee.slash', 6))).toBe(false);
    expect(cancelledCast(IDLE, winding('melee.slash', 7))).toBe(true);
  });
});

describe('a withdrawn wind-up', () => {
  it('stops the swing rather than finishing it', () => {
    const machine = machineFor();
    driveUnit(machine, IDLE, null, 10);
    const swinging = winding('melee.slash', castTicks('melee.slash'));
    driveUnit(machine, swinging, IDLE, 1);
    expect(machine.stateId).toBe('swing');

    // A third of the way in, and then the player asks not to.
    driveUnit(machine, swinging, swinging, 10);
    expect(machine.stateId).toBe('swing');
    driveUnit(machine, IDLE, swinging, 1);
    expect(machine.stateId).toBe('idle');
  });

  it('never fires the impact of a blow that did not happen', () => {
    // The half that is not cosmetic. `swing.impact` is what a hit sound and a
    // hit spark hang off, and a withdrawn attack that still emitted one would
    // be the renderer announcing a blow the sim refunded.
    const machine = machineFor();
    driveUnit(machine, IDLE, null, 10);
    const swinging = winding('melee.slash', castTicks('melee.slash'));
    driveUnit(machine, swinging, IDLE, 1);
    driveUnit(machine, swinging, swinging, 8);
    driveUnit(machine, IDLE, swinging, 1);

    const fired: string[] = [];
    for (let tick = 0; tick < 120; tick += 1) {
      for (const event of driveUnit(machine, IDLE, IDLE, 1)) fired.push(event.name);
    }
    expect(fired).not.toContain('swing.impact');
  });

  it('goes back to running when that is what it left', () => {
    const machine = machineFor();
    const running: UnitFacts = { ...IDLE, speed: 200, activity: EntityActivity.Moving };
    driveUnit(machine, running, null, 30);
    expect(machine.stateId).toBe('locomotion');

    const swinging: UnitFacts = { ...winding('melee.slash', castTicks('melee.slash')), speed: 200 };
    driveUnit(machine, swinging, running, 1);
    expect(machine.stateId).toBe('swing');
    driveUnit(machine, running, swinging, 1);
    expect(machine.stateId).toBe('locomotion');
  });

  it('cross-fades out rather than cutting', () => {
    // A withdrawal that snapped to the idle pose would replace one wrong
    // picture with a different one. The machine reports a blend below 1 while
    // two states are still mixed.
    const machine = machineFor();
    driveUnit(machine, IDLE, null, 10);
    const swinging = winding('melee.slash', castTicks('melee.slash'));
    driveUnit(machine, swinging, IDLE, 1);
    driveUnit(machine, swinging, swinging, 8);
    driveUnit(machine, IDLE, swinging, 1);

    const snapshot = machine.snapshot();
    expect(snapshot.stateId).toBe('idle');
    expect(snapshot.previousStateId).toBe('swing');
    expect(snapshot.blend).toBeLessThan(1);
  });

  it('stops a bow draw the same way', () => {
    const machine = machineFor();
    driveUnit(machine, IDLE, null, 10);
    const drawing = winding('ranged.shot', castTicks('ranged.shot'));
    driveUnit(machine, drawing, IDLE, 1);
    expect(machine.stateId).toBe('draw');
    driveUnit(machine, drawing, drawing, 20);
    driveUnit(machine, IDLE, drawing, 1);
    expect(machine.stateId).toBe('idle');
  });
});

describe('an attack that was not called off', () => {
  it('plays to the end of its own clip', () => {
    // The regression this rule has to not cause. A completed attack's cast
    // outlives its animation, so the tick the cast ends is a tick the machine
    // is already back in its loop -- and if it were not, cancelling there would
    // clip the follow-through off every attack in the game.
    const machine = machineFor();
    driveUnit(machine, IDLE, null, 10);
    let previous = IDLE;
    const total = castTicks('melee.slash');
    for (let tick = 0; tick < total; tick += 1) {
      const facts = winding('melee.slash', total - tick);
      driveUnit(machine, facts, previous, 1);
      previous = facts;
    }
    // The clip is shorter than the cast, so it has finished on its own.
    expect(machine.stateId).toBe('idle');
    driveUnit(machine, IDLE, previous, 1);
    expect(machine.stateId).toBe('idle');
  });

  it('is authored to fit inside the cast it belongs to', () => {
    // The invariant the rule above rests on, asserted rather than assumed: an
    // attack with its own clip finishes drawing before the sim stops rooting
    // the body. Break this and a completed attack starts being cancelled at its
    // own attack point.
    const clips: Readonly<Record<string, number>> = {
      'melee.slash': STRIKE_DURATION_MS,
      'ranged.shot': SHOT_DURATION_MS,
    };
    for (const [abilityId, durationMs] of Object.entries(clips)) {
      const castMs = (castTicks(abilityId) * 1000) / SERVER_TICK_RATE;
      expect(durationMs).toBeLessThanOrEqual(castMs);
    }
  });
});

describe('what a cancel may not touch', () => {
  it('does nothing to a body that is walking', () => {
    const machine = machineFor();
    const running: UnitFacts = { ...IDLE, speed: 200, activity: EntityActivity.Moving };
    driveUnit(machine, running, null, 30);
    expect(machine.stateId).toBe('locomotion');
    expect(machine.cancelAction()).toBe(false);
    expect(machine.stateId).toBe('locomotion');
  });

  it('does nothing to a body that has gone down', () => {
    // `down` is terminal, and a cancel that could leave it would stand a corpse
    // back up.
    const machine = machineFor();
    driveUnit(machine, { ...IDLE, dead: true }, null, 20);
    expect(machine.stateId).toBe('down');
    expect(machine.cancelAction()).toBe(false);
    expect(machine.stateId).toBe('down');
  });

  it('does nothing when there is nowhere to go back to', () => {
    // A machine that began life inside an attack has no loop it came from, and
    // inventing one would be this file choosing a pose.
    const machine = machineFor('swing');
    expect(machine.stateId).toBe('swing');
    expect(machine.cancelAction()).toBe(false);
    expect(machine.stateId).toBe('swing');
  });
});

describe('the attack after a withdrawal', () => {
  it('still swings, even while the replicated activity never changed', () => {
    // The case this rule creates and has to answer for. `castPhase` comes from
    // the predicted cast list and `activity` is replicated at 20Hz, so a
    // withdrawal and the next attack can both happen between two deltas: the
    // cast list goes windup, nothing, windup while the activity says `Casting`
    // throughout. Before spec 166 the animation played on regardless and the
    // second attack was drawn by the first one's leftovers; now the first is
    // cancelled, so a second that failed to start would leave the pig standing
    // perfectly still through an attack it is really making.
    const machine = machineFor();
    driveUnit(machine, IDLE, null, 10);
    const first = winding('melee.slash', castTicks('melee.slash'));
    driveUnit(machine, first, IDLE, 1);
    expect(machine.stateId).toBe('swing');

    // Withdrawn, with the activity still saying otherwise.
    const between: UnitFacts = { ...first, castPhase: null, castTicksLeft: null };
    driveUnit(machine, between, first, 1);
    expect(machine.stateId).toBe('idle');

    // And straight into the next one.
    driveUnit(machine, first, between, 1);
    expect(machine.stateId).toBe('swing');
  });
});
