/**
 * The bow shot, driven the way the game drives it (spec 164).
 *
 * Beside `pig-swing.test.ts` and for the reason that file gives: `src/units/`
 * may not import `unit-driver.ts`, so "does the trigger the driver raises reach
 * a state" can only be asked from this side of the fence.
 *
 * It is the question the spec exists for. `driveUnit` raised one `attack`
 * trigger for every cast, and the pig's machine had one attack state -- so a
 * player holding the Hunting Bow, a level-1 weapon they can buy in the first
 * minute, threw a sword chop at things four hundred units away, once per shot,
 * forever.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { abilityById } from '../../../server/data/abilities.js';
import { itemById } from '../../../server/data/items.js';
import { SERVER_TICK_RATE } from '../../../server/config.js';
import { CastPhaseValue, EntityActivity } from '../../../server/net/protocol.js';
import { loadUnitBundle } from '../../../units/bundle.js';
import { UnitMachine } from '../../../units/machine.js';
import { SHOT_CLIP_ID, SHOT_RELEASE_MS } from '../../../units/pig-shot.js';
import { attackTriggerFor, driveUnit, DRIVEN_PARAMETERS, type UnitFacts } from './unit-driver.js';

const UNIT_DIR = join(process.cwd(), 'assets', 'units', 'pig_a_pose_full');
const FAMILY_DIR = join(process.cwd(), 'assets', 'units');

const bundle = loadUnitBundle(
  JSON.parse(readFileSync(join(UNIT_DIR, 'pig_a_pose_full.unitdef.json'), 'utf8')),
  JSON.parse(readFileSync(join(FAMILY_DIR, 'biped.core.cliplib.json'), 'utf8')),
);

function machineFor(): UnitMachine {
  const value = bundle.value;
  if (!value) throw new Error('the pig unit does not load');
  return new UnitMachine({ unit: value.unit, clipLib: value.clipLib, entryStateId: 'idle' });
}

const idle: UnitFacts = {
  speed: 0,
  activity: EntityActivity.Idle,
  castPhase: null,
  attackRate: 1,
  abilityId: null,
  castTicksLeft: null,
  dead: false,
};

function casting(abilityId: string): UnitFacts {
  return {
    speed: 0,
    activity: EntityActivity.Casting,
    castPhase: CastPhaseValue.Windup,
    attackRate: 1,
    abilityId,
    castTicksLeft: 60,
    dead: false,
  };
}

describe('which animation an attack picks', () => {
  it('draws a bow for the arrow and swings for everything else', () => {
    expect(attackTriggerFor('ranged.shot')).toBe(DRIVEN_PARAMETERS.shoot);
    expect(attackTriggerFor('melee.slash')).toBe(DRIVEN_PARAMETERS.attack);
    expect(attackTriggerFor('melee.heavy')).toBe(DRIVEN_PARAMETERS.attack);
    // A thrown star and an arcane bolt are projectiles too, and neither has a
    // clip. They keep the swing rather than getting a bow draw, because a wrong
    // animation is worse than a generic one.
    expect(attackTriggerFor('ranged.star')).toBe(DRIVEN_PARAMETERS.attack);
    expect(attackTriggerFor('bolt.arcane')).toBe(DRIVEN_PARAMETERS.attack);
    expect(attackTriggerFor(null)).toBe(DRIVEN_PARAMETERS.attack);
    // An id nothing knows is not a reason to stand still.
    expect(attackTriggerFor('not.an.ability')).toBe(DRIVEN_PARAMETERS.attack);
  });

  it('is read off what the ability sends, not off a list of ids', () => {
    // The property the rule is built on, so a fourth arrow ability gets the
    // draw without anyone remembering to come back here.
    const shot = abilityById('ranged.shot');
    expect(shot?.projectile?.look).toBe('arrow');
  });

  it('is the attack the Hunting Bow actually gives a player', () => {
    // The whole reason this is reachable rather than theoretical: a level-1
    // weapon whose basic attack is the arrow.
    const bow = itemById('bow.hunting');
    expect(bow?.basicAttackId).toBe('ranged.shot');
    expect(bow?.levelRequirement).toBe(1);
  });
});

describe('the trigger reaches a state', () => {
  it('loads the pig’s own documents without an error', () => {
    expect(bundle.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(bundle.value).not.toBeNull();
  });

  it('draws when a shot begins and swings when a slash does', () => {
    const machine = machineFor();
    driveUnit(machine, idle, null, 10);
    expect(machine.stateId).toBe('idle');

    driveUnit(machine, casting('ranged.shot'), idle, 1);
    expect(machine.stateId).toBe('draw');
  });

  it('does not draw a bow for a sword', () => {
    const machine = machineFor();
    driveUnit(machine, idle, null, 10);
    driveUnit(machine, casting('melee.slash'), idle, 1);
    expect(machine.stateId).toBe('swing');
  });

  it('returns to the loop it came from', () => {
    const machine = machineFor();
    const running: UnitFacts = { ...idle, speed: 200, activity: EntityActivity.Moving };
    driveUnit(machine, running, null, 30);
    expect(machine.stateId).toBe('locomotion');

    const shooting: UnitFacts = { ...casting('ranged.shot'), speed: 200 };
    driveUnit(machine, shooting, running, 1);
    expect(machine.stateId).toBe('draw');
    // Past the end of the clip, at the rate it is entered at.
    driveUnit(machine, shooting, shooting, Math.ceil((1150 / 1000) * SERVER_TICK_RATE) + 4);
    expect(machine.stateId).toBe('locomotion');
  });

  it('looses on the tick the sim resolves the shot', () => {
    const machine = machineFor();
    driveUnit(machine, idle, null, 10);
    const shooting = casting('ranged.shot');
    driveUnit(machine, shooting, idle, 1);

    const fired: number[] = [];
    for (let tick = 1; tick <= 80; tick += 1) {
      for (const event of driveUnit(machine, shooting, shooting, 1)) {
        if (event.name === 'swing.impact') fired.push(tick);
      }
    }
    expect(fired.length).toBe(1);
    // Within a tick: an event fires on an integer frame crossing and a 69-frame
    // clip cannot land exactly on the release's normalized time.
    const at = ((fired[0] ?? 0) * 1000) / SERVER_TICK_RATE;
    expect(Math.abs(at - SHOT_RELEASE_MS)).toBeLessThan(1000 / SERVER_TICK_RATE + 1);
  });

  it('rescales the draw to the wind-up the sim is actually running', () => {
    // Gameplay timing is authoritative and the clip is what bends (spec 144).
    // A hasted archer's draw has to finish with the wind-up, or the pig is
    // drawn still pulling a string whose arrow left.
    const machine = machineFor();
    driveUnit(machine, idle, null, 10);
    const hasted: UnitFacts = { ...casting('ranged.shot'), attackRate: 2 };
    driveUnit(machine, hasted, idle, 1);

    const fired: number[] = [];
    for (let tick = 1; tick <= 80; tick += 1) {
      for (const event of driveUnit(machine, hasted, hasted, 1)) {
        if (event.name === 'swing.impact') fired.push(tick);
      }
    }
    const at = ((fired[0] ?? 0) * 1000) / SERVER_TICK_RATE;
    expect(at).toBeGreaterThan(SHOT_RELEASE_MS / 2 - 1000 / SERVER_TICK_RATE - 1);
    expect(at).toBeLessThan(SHOT_RELEASE_MS / 2 + 1000 / SERVER_TICK_RATE + 1);
  });

  it('falls back to the swing on a unit that has no draw', () => {
    // The fox and the dev mannequin share this clip library and have no draw
    // state. A dropped trigger there would be a body standing perfectly still
    // through its own attack, which is worse than a generic animation and much
    // harder to notice.
    const value = bundle.value;
    if (!value) throw new Error('the pig unit does not load');
    const withoutDraw = {
      ...value.unit,
      stateMachine: {
        ...value.unit.stateMachine,
        parameters: value.unit.stateMachine.parameters.filter((entry) => entry.name !== 'shoot'),
        states: value.unit.stateMachine.states.filter((entry) => entry.id !== 'draw'),
        transitions: value.unit.stateMachine.transitions.filter((entry) => entry.to !== 'draw'),
      },
    };
    const machine = new UnitMachine({ unit: withoutDraw, clipLib: value.clipLib, entryStateId: 'idle' });
    driveUnit(machine, idle, null, 10);
    driveUnit(machine, casting('ranged.shot'), idle, 1);
    expect(machine.stateId).toBe('swing');
  });

  it('is wired to the clip the table wrote', () => {
    const value = bundle.value;
    const state = value?.unit.stateMachine.states.find((entry) => entry.id === 'draw');
    expect(state?.clipRef).toBe(SHOT_CLIP_ID);
    // `oneshot` rather than `locking`, for the reason the pig's own comment
    // gives about `swing`: a locking state refuses every transition until it
    // finishes, so a body killed mid-draw would finish the draw and fall a
    // second later. Right for a monster, wrong for the player.
    expect(state?.category).toBe('oneshot');
  });
});
