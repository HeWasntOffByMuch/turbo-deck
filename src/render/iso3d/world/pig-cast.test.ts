/**
 * The spell cast, driven the way the game drives it (spec 230).
 *
 * Beside `pig-swing.test.ts` and `pig-shoot.test.ts`, and for the reason those
 * files give: `src/units/` may not import `unit-driver.ts`, so "does the trigger
 * the driver raises reach a state" can only be asked from this side of the
 * fence.
 *
 * It is the question the spec exists for, twice over. Every spell in the game
 * was drawn as a sword chop, because `attackTriggerFor` had two answers and
 * neither of them was a cast. And the fix is not simply a third clip: the swing
 * and the draw were each authored for **one** ability, so each one's own beat is
 * that ability's wind-up and today's playback rate is already right, while seven
 * spells share the cast -- and their wind-ups run from half a second to nearly
 * three times that.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { abilityById, ALL_ABILITIES } from '../../../server/data/abilities.js';
import { SERVER_TICK_RATE } from '../../../server/config.js';
import { CastPhaseValue, EntityActivity } from '../../../server/net/protocol.js';
import { loadUnitBundle } from '../../../units/bundle.js';
import { UnitMachine } from '../../../units/machine.js';
import { CAST_CLIP_ID, CAST_DURATION_MS, CAST_RELEASE_MS } from '../../../units/pig-cast.js';
import {
  attackTriggerFor,
  clipStretch,
  driveUnit,
  DRIVEN_PARAMETERS,
  triggerFor,
  type UnitFacts,
} from './unit-driver.js';

const UNIT_DIR = join(process.cwd(), 'assets', 'units', 'pig_a_pose_full');
const FAMILY_DIR = join(process.cwd(), 'assets', 'units');
const TICK_MS = 1000 / SERVER_TICK_RATE;

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

/**
 * A body mid-cast, with the rate the scene would have measured off the wire.
 *
 * `attackRate` is `authoredWindup / span` and nothing else, so an unhasted cast
 * is exactly 1 -- which is the whole point of the test below: at rate 1 a
 * shared clip plays at its own speed, and its own speed is nobody's wind-up.
 */
function casting(abilityId: string, attackRate = 1): UnitFacts {
  return {
    speed: 0,
    activity: EntityActivity.Casting,
    castPhase: CastPhaseValue.Windup,
    attackRate,
    abilityId,
    castTicksLeft: 60,
    dead: false,
  };
}

/** The tick `swing.impact` fires on, driving one tick at a time from a standstill. */
function releaseTickOf(machine: UnitMachine, facts: UnitFacts): number | null {
  driveUnit(machine, idle, null, 10);
  driveUnit(machine, facts, idle, 1);
  for (let tick = 1; tick <= 200; tick += 1) {
    for (const event of driveUnit(machine, facts, facts, 1)) {
      if (event.name === 'swing.impact') return tick;
    }
  }
  return null;
}

describe('which animation an ability picks', () => {
  it('focuses for a spell, draws for an arrow and swings for everything else', () => {
    expect(attackTriggerFor('ground.quake')).toBe(DRIVEN_PARAMETERS.cast);
    expect(attackTriggerFor('self.mend')).toBe(DRIVEN_PARAMETERS.cast);
    expect(attackTriggerFor('channel.drain')).toBe(DRIVEN_PARAMETERS.cast);
    expect(attackTriggerFor('ranged.shot')).toBe(DRIVEN_PARAMETERS.shoot);
    expect(attackTriggerFor('melee.slash')).toBe(DRIVEN_PARAMETERS.attack);
    expect(attackTriggerFor('melee.heavy')).toBe(DRIVEN_PARAMETERS.attack);
    expect(attackTriggerFor(null)).toBe(DRIVEN_PARAMETERS.attack);
    expect(attackTriggerFor('not.an.ability')).toBe(DRIVEN_PARAMETERS.attack);
  });

  it('leaves a weapon skill swinging, however spell-shaped its row is', () => {
    // The finding the field exists for. Whirlwind and Rime Touch are both an
    // `area` circle on the caster's own feet, both `targeting: 'self'`, both
    // damage in a radius -- and one is a blade going all the way round. There
    // is no mechanical fact separating them, which is why the look is authored.
    const spin = abilityById('skill.whirlwind');
    const rime = abilityById('skill.rimeTouch');
    expect(spin?.kind).toBe(rime?.kind);
    expect(spin?.targeting).toBe(rime?.targeting);
    expect(attackTriggerFor('skill.whirlwind')).toBe(DRIVEN_PARAMETERS.attack);
    expect(attackTriggerFor('skill.rimeTouch')).toBe(DRIVEN_PARAMETERS.cast);
  });

  it('is read off the row rather than off a list of ids', () => {
    // Said over the whole table rather than over a handful of ids, which is
    // what makes it a statement about the rule: an eighth spell is drawn as one
    // by saying so in its own row, with nothing in the renderer to keep in sync.
    const spells = ALL_ABILITIES.filter((ability) => ability.castLook !== undefined);
    expect(spells.length).toBeGreaterThan(0);
    for (const ability of ALL_ABILITIES) {
      const focuses = attackTriggerFor(ability.id) === DRIVEN_PARAMETERS.cast;
      expect(focuses).toBe(ability.castLook !== undefined);
    }
  });
});

describe('the clip is rebased onto the cast it is drawing', () => {
  it('leaves the swing and the draw exactly as they were', () => {
    // Each was authored for one ability, so `attackRate` is already the whole
    // answer for them and a factor of anything but 1 would be a regression in
    // an animation nobody asked about.
    expect(clipStretch(DRIVEN_PARAMETERS.attack, 'melee.slash')).toBe(1);
    expect(clipStretch(DRIVEN_PARAMETERS.shoot, 'ranged.shot')).toBe(1);
    expect(clipStretch(DRIVEN_PARAMETERS.attack, null)).toBe(1);
    // Including when the cast fell back to the swing, which is the case a unit
    // with no focus state is in -- it is drawing `slash`, so it gets `slash`'s
    // rate rather than a spell's.
    expect(clipStretch(DRIVEN_PARAMETERS.attack, 'ground.quake')).toBe(1);
  });

  it('is the clip’s own release over the ability’s wind-up', () => {
    for (const ability of ALL_ABILITIES.filter((entry) => entry.castLook !== undefined)) {
      const windupMs = ability.windupTicks * TICK_MS;
      expect(clipStretch(DRIVEN_PARAMETERS.cast, ability.id)).toBeCloseTo(CAST_RELEASE_MS / windupMs, 9);
    }
  });

  it('is never a division by nothing', () => {
    expect(clipStretch(DRIVEN_PARAMETERS.cast, null)).toBe(1);
    expect(clipStretch(DRIVEN_PARAMETERS.cast, 'not.an.ability')).toBe(1);
  });
});

describe('the trigger reaches a state', () => {
  it('loads the pig’s own documents without an error', () => {
    expect(bundle.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(bundle.value).not.toBeNull();
  });

  it('focuses when a spell begins and swings when a slash does', () => {
    const machine = machineFor();
    driveUnit(machine, idle, null, 10);
    expect(machine.stateId).toBe('idle');

    driveUnit(machine, casting('ground.quake'), idle, 1);
    expect(machine.stateId).toBe('focus');
  });

  it('does not focus for a sword or a bow', () => {
    for (const [abilityId, state] of [
      ['melee.slash', 'swing'],
      ['ranged.shot', 'draw'],
    ] as const) {
      const machine = machineFor();
      driveUnit(machine, idle, null, 10);
      driveUnit(machine, casting(abilityId), idle, 1);
      expect(machine.stateId).toBe(state);
    }
  });

  it('returns to the loop it came from', () => {
    const machine = machineFor();
    const running: UnitFacts = { ...idle, speed: 200, activity: EntityActivity.Moving };
    driveUnit(machine, running, null, 30);
    expect(machine.stateId).toBe('locomotion');

    const spelling: UnitFacts = { ...casting('self.mend'), speed: 200 };
    driveUnit(machine, spelling, running, 1);
    expect(machine.stateId).toBe('focus');
    // Past the end of the clip, at the rate it is entered at: Mend's wind-up is
    // longer than the clip's own release, so the whole thing is stretched.
    const rate = clipStretch(DRIVEN_PARAMETERS.cast, 'self.mend');
    driveUnit(machine, spelling, spelling, Math.ceil(CAST_DURATION_MS / rate / TICK_MS) + 4);
    expect(machine.stateId).toBe('locomotion');
  });

  it('falls back to the swing on a unit that has no focus state', () => {
    // The fox and the dev mannequin share this clip library and have neither a
    // draw nor a focus. A dropped trigger there would be a body standing
    // perfectly still through its own cast, which is worse than a generic
    // animation and much harder to notice.
    const value = bundle.value;
    if (!value) throw new Error('the pig unit does not load');
    const withoutFocus = {
      ...value.unit,
      stateMachine: {
        ...value.unit.stateMachine,
        parameters: value.unit.stateMachine.parameters.filter((entry) => entry.name !== 'cast'),
        states: value.unit.stateMachine.states.filter((entry) => entry.id !== 'focus'),
        transitions: value.unit.stateMachine.transitions.filter((entry) => entry.to !== 'focus'),
      },
    };
    const machine = new UnitMachine({ unit: withoutFocus, clipLib: value.clipLib, entryStateId: 'idle' });
    expect(triggerFor(machine, 'ground.quake')).toBe(DRIVEN_PARAMETERS.attack);
    driveUnit(machine, idle, null, 10);
    driveUnit(machine, casting('ground.quake'), idle, 1);
    expect(machine.stateId).toBe('swing');
  });

  it('is wired to the clip the table wrote', () => {
    const value = bundle.value;
    const state = value?.unit.stateMachine.states.find((entry) => entry.id === 'focus');
    expect(state?.clipRef).toBe(CAST_CLIP_ID);
    // `oneshot` rather than `locking`, for the reason the pig's own comment
    // gives about `swing`: a locking state refuses every transition until it
    // finishes, so a body killed mid-cast would finish the cast and fall a
    // second later. Right for a monster, wrong for the player.
    expect(state?.category).toBe('oneshot');
  });
});

describe('the hands come forward on the tick the spell lands', () => {
  // The property the whole spec is for, asserted at both ends of the table:
  // `channel.drain` at 0.5s and `ground.quake` at 1.4s are nearly a factor of
  // three apart, and the clip's own release is 0.85s, so at rate 1 the picture
  // would be a third of a second early on one and half a second late on the
  // other.
  for (const abilityId of ['channel.drain', 'skill.arcLash', 'skill.blight', 'self.mend', 'ground.quake']) {
    it(`lands ${abilityId} on its own wind-up`, () => {
      const ability = abilityById(abilityId);
      expect(ability?.castLook).toBe('focus');
      const windup = ability?.windupTicks ?? 0;
      const facts = casting(abilityId);
      const fired = releaseTickOf(machineFor(), facts);
      expect(fired).not.toBeNull();
      // Within a tick either way: an event fires on an integer frame crossing,
      // and a rescaled clip's frames do not line up with the sim's ticks.
      expect(Math.abs((fired ?? 0) - windup)).toBeLessThanOrEqual(1);
    });
  }

  it('would not, without the rebase', () => {
    // The control. Same clip, same machine, driven at the rate the scene
    // measures off the wire and nothing else -- which is what shipped before
    // this spec and is what every other clip still gets.
    const machine = machineFor();
    const facts = casting('ground.quake');
    driveUnit(machine, idle, null, 10);
    machine.setActionRate(facts.attackRate);
    machine.trigger(DRIVEN_PARAMETERS.cast);
    let fired: number | null = null;
    for (let tick = 1; tick <= 200 && fired === null; tick += 1) {
      for (const event of machine.step(1)) if (event.name === 'swing.impact') fired = tick;
    }
    const windup = abilityById('ground.quake')?.windupTicks ?? 0;
    expect(fired).not.toBeNull();
    expect(Math.abs((fired ?? 0) - windup)).toBeGreaterThan(20);
  });

  it('still tracks a wind-up the sim shortened underneath it', () => {
    // `attackRate` is measured off the ticks the server sent, so a status that
    // shaped this cast's wind-up is already in it and the rebase rides on top.
    const ability = abilityById('skill.blight');
    const windup = ability?.windupTicks ?? 0;
    const facts = casting('skill.blight', 1.5);
    const fired = releaseTickOf(machineFor(), facts);
    expect(Math.abs((fired ?? 0) - windup / 1.5)).toBeLessThanOrEqual(1);
  });
});
