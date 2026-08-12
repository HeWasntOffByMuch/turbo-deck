/**
 * The pig's swing, driven the way the game drives it (spec 139).
 *
 * On this side of the fence rather than beside the pose table, because it is a
 * claim about the *game*: `unit-driver.ts` lives under `src/render/`, and
 * `src/units/` may not import it -- the sim never reads the renderer, and lint
 * says so. So the question "does the trigger the driver raises now reach a
 * state" has to be asked from here.
 *
 * It is the question the whole spec exists for. `driveUnit` has raised an
 * `attack` trigger on the first tick of every cast since spec 111; the pig's
 * unitdef declared the parameter and no state read it, so every one of those
 * triggers was dropped and the player's own body never moved.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUnitBundle } from '../../../units/bundle.js';
import { UnitMachine } from '../../../units/machine.js';
import { STRIKE_CONTACT_MS } from '../../../units/pig-strike.js';
import { SERVER_TICK_RATE } from '../../../server/config.js';
import { CastPhaseValue, EntityActivity } from '../../../server/net/protocol.js';
import { driveUnit, type UnitFacts } from './unit-driver.js';

const UNIT_DIR = join(process.cwd(), 'assets', 'units', 'pig_a_pose_full');
/** The family's own documents, one level above each member. */
const FAMILY_DIR = join(process.cwd(), 'assets', 'units');

describe('the trigger finally reaches a state', () => {
  const bundle = loadUnitBundle(
    JSON.parse(readFileSync(join(UNIT_DIR, 'pig_a_pose_full.unitdef.json'), 'utf8')),
    JSON.parse(readFileSync(join(FAMILY_DIR, 'biped.core.cliplib.json'), 'utf8')),
  );

  it('loads the pig’s own documents without an error', () => {
    expect(bundle.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(bundle.value).not.toBeNull();
  });

  /** The pig's machine, driven the way `unit-driver.ts` drives it in the game. */
  function machineFor(): UnitMachine {
    const value = bundle.value;
    if (!value) throw new Error('the pig unit does not load');
    return new UnitMachine({ unit: value.unit, clipLib: value.clipLib, entryStateId: 'idle' });
  }

  it('swings when a cast begins, and not before', () => {
    const machine = machineFor();
    const standing: UnitFacts = { speed: 0, activity: EntityActivity.Idle, castPhase: null, dead: false };
    const casting: UnitFacts = {
      speed: 0,
      activity: EntityActivity.Casting,
      castPhase: CastPhaseValue.Windup,
      dead: false,
    };
    driveUnit(machine, standing, null, 10);
    expect(machine.stateId).toBe('idle');

    // This is the whole bug the spec was written for: before the `swing` state
    // existed, `driveUnit` raised this trigger on every cast and the machine had
    // nowhere to put it.
    driveUnit(machine, casting, standing, 1);
    expect(machine.stateId).toBe('swing');
  });

  it('fires the impact once, on the tick the wind-up ends', () => {
    const machine = machineFor();
    const casting: UnitFacts = {
      speed: 0,
      activity: EntityActivity.Casting,
      castPhase: CastPhaseValue.Windup,
      dead: false,
    };
    const impacts: number[] = [];
    let previous: UnitFacts | null = null;
    for (let tick = 0; tick < 60; tick += 1) {
      for (const event of driveUnit(machine, casting, previous, 1)) {
        if (event.name === 'swing.impact') impacts.push(tick);
      }
      previous = casting;
    }
    expect(impacts.length).toBe(1);
    // Within a tick of 500ms. The machine resolves an event to an integer frame
    // of the clip's cycle, and a 48-frame cycle cannot land exactly on 0.625.
    const at = ((impacts[0] ?? 0) * 1000) / SERVER_TICK_RATE;
    expect(Math.abs(at - STRIKE_CONTACT_MS)).toBeLessThan(1000 / SERVER_TICK_RATE + 1);
  });

  it('returns to the loop it came from rather than always to idle', () => {
    const machine = machineFor();
    const running: UnitFacts = { speed: 200, activity: EntityActivity.Moving, castPhase: null, dead: false };
    driveUnit(machine, running, null, 30);
    expect(machine.stateId).toBe('locomotion');

    const casting: UnitFacts = {
      speed: 200,
      activity: EntityActivity.Casting,
      castPhase: CastPhaseValue.Windup,
      dead: false,
    };
    driveUnit(machine, casting, running, 1);
    expect(machine.stateId).toBe('swing');
    // Long enough for the 800ms clip to run out, and then some.
    driveUnit(machine, running, casting, 70);
    expect(machine.stateId).toBe('locomotion');
  });

  it('lets death interrupt the swing, which is why it is not `locking`', () => {
    const machine = machineFor();
    const casting: UnitFacts = {
      speed: 0,
      activity: EntityActivity.Casting,
      castPhase: CastPhaseValue.Windup,
      dead: false,
    };
    driveUnit(machine, casting, null, 5);
    expect(machine.stateId).toBe('swing');
    driveUnit(machine, { ...casting, dead: true }, casting, 2);
    expect(machine.stateId).toBe('down');
  });
});
