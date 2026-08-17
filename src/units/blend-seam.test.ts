/**
 * What an interrupted cross-fade may not do (spec 167).
 *
 * The machine has one outgoing layer, so a fade that is interrupted has to
 * choose what it fades *from*. Choosing `current` regardless is the obvious
 * answer and it is wrong in one case, which is the case a body attacking on a
 * loop hits every single cycle: the state being entered is the one the fade was
 * in the middle of leaving.
 *
 * Measured on the *clip mix* rather than on bones, because that is what
 * `UnitRig.applyPoses` is handed and it is where the discontinuity is. What it
 * does to the bones is measured against the real committed clips by
 * `scripts/probe-shot-loop.ts`, which is where the 47-degree number in the spec
 * comes from.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadUnitBundle } from './bundle.js';
import { UnitMachine } from './machine.js';
import type { PoseSample } from './machine.js';

const UNITS = join(process.cwd(), 'assets', 'units');

/**
 * The pig's real documents, not `unitDefFixture`.
 *
 * The same reason `presentation-only.test.ts` gives: the fixture's death
 * transition is `!grounded` over a bool that starts false, so a machine built
 * from it is dead on its first tick and animates nothing. Reading the shipped
 * documents also means this fails if the states the game actually drives stop
 * being one-shots.
 */
const bundle = loadUnitBundle(
  JSON.parse(readFileSync(join(UNITS, 'pig_a_pose_full', 'pig_a_pose_full.unitdef.json'), 'utf8')),
  JSON.parse(readFileSync(join(UNITS, 'biped.core.cliplib.json'), 'utf8')),
);
if (!bundle.value) throw new Error('the pig unit does not validate');
const { unit: PIG, clipLib: CLIPS } = bundle.value;

/** The bow draw: the one-shot a body attacking on a loop re-enters every cycle. */
const DRAW = PIG.stateMachine.states.find((state) => state.id === 'draw');
if (!DRAW) throw new Error('the pig has no draw state');

function machineFor(): UnitMachine {
  return new UnitMachine({ unit: PIG, clipLib: CLIPS, entryStateId: 'idle' });
}

/** The mix as a map, so a weight can be asked for by clip. */
function mixOf(machine: UnitMachine): Map<string, PoseSample> {
  return new Map(machine.poses().map((sample) => [sample.clipId, sample]));
}

function weightOf(machine: UnitMachine, clipId: string): number {
  return mixOf(machine).get(clipId)?.weight ?? 0;
}

describe('a fade that is interrupted', () => {
  it('reverses rather than snapping, when it is sent back where it came from', () => {
    const machine = machineFor();
    machine.step(20);

    // Into the draw, and let it settle so the mix is entirely its clip.
    machine.trigger('shoot');
    machine.step(40);
    expect(weightOf(machine, DRAW.clipRef)).toBeGreaterThan(0.99);

    // Back to idle, part-way -- the state the fade is heading toward is barely
    // on screen yet.
    machine.cancelAction();
    machine.step(1);
    const leaving = weightOf(machine, DRAW.clipRef);
    expect(leaving).toBeGreaterThan(0.5);
    expect(leaving).toBeLessThan(1);

    // And straight back into the attack, which is what a second swing on a
    // standing order looks like. The clip that was on screen must still be on
    // screen: this is the tick that used to be drawn as 100% of a pose the body
    // was only a quarter of the way toward.
    machine.trigger('shoot');
    machine.step(1);
    expect(weightOf(machine, DRAW.clipRef)).toBeGreaterThan(leaving);
  });

  it('still fades from the state it is in, when that is not a reversal', () => {
    // The ordinary case, unchanged: leaving a state for a third one fades from
    // where the machine actually is.
    const machine = machineFor();
    machine.setParameter('speed', 200);
    machine.step(30);
    const moving = machine.stateId;
    expect(moving).toBe('locomotion');

    machine.trigger('shoot');
    machine.step(1);
    expect(machine.snapshot().previousStateId).toBe(moving);
  });
});

describe('the mix handed to a mixer', () => {
  it('names each clip once', () => {
    // `applyPoses` keys its actions by clip id, so two samples naming one clip
    // are not two layers -- the second overwrites the first, and which one wins
    // depends on array order. A reversal is exactly how two playheads on one
    // clip arise, so this is the property that makes that safe.
    const machine = machineFor();
    machine.step(20);
    machine.trigger('shoot');
    machine.step(40);
    machine.cancelAction();
    machine.step(1);
    machine.trigger('shoot');

    for (let tick = 0; tick < 12; tick += 1) {
      machine.step(1);
      const ids = machine.poses().map((sample) => sample.clipId);
      expect(ids.length).toBe(new Set(ids).size);
    }
  });

  it('always sums to a whole body', () => {
    // Weights that did not add to one would draw a body part-way to its bind
    // pose, which is the other way a seam shows up. Checked across a reversal,
    // which is where the merge could have lost some.
    const machine = machineFor();
    machine.step(20);
    machine.trigger('shoot');
    machine.step(40);
    machine.cancelAction();
    machine.step(1);
    machine.trigger('shoot');

    for (let tick = 0; tick < 12; tick += 1) {
      machine.step(1);
      const total = machine.poses().reduce((sum, sample) => sum + sample.weight, 0);
      expect(total).toBeCloseTo(1, 6);
    }
  });
});
