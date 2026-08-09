import { describe, expect, it } from 'vitest';
import { loadUnitBundle } from './bundle.js';
import { skeletonFixture, unitDefFixture } from './fixtures.js';
import { errorsOf } from './issues.js';
import { UnitMachine } from './machine.js';
import { scaffoldClipLib, scaffoldStateMachine, type MeasuredClip } from './scaffold.js';
import { stretchRatio, timeScaleFor } from './timing.js';
import { validateUnitBundle } from './validate.js';

function clips(...ids: readonly string[]): MeasuredClip[] {
  const durations: Record<string, number> = { idle: 2400, walk: 1000, run: 640, slash: 900, shoot: 700, fall: 1200 };
  return ids.map((id) => ({ id, source: `clips/${id}.glb`, durationMs: durations[id] ?? 800 }));
}

function input(...ids: readonly string[]) {
  return { clipLibId: 'biped.core', skeletonRef: 'biped.skeleton.json', clips: clips(...ids) };
}

/** The scaffolded documents as a unitdef, so they can go through the real parser. */
function asUnit(...ids: readonly string[]) {
  const source = input(...ids);
  const base = unitDefFixture();
  return {
    unit: { ...base, id: 'grunt', clipLibRef: 'biped.core.cliplib.json', stateMachine: scaffoldStateMachine(source) },
    clipLib: scaffoldClipLib(source),
  };
}

describe('scaffoldClipLib', () => {
  it('loops a cycle and does not loop a one-shot', () => {
    // Visible immediately when wrong: a looping death, or a walk that plays once
    // and freezes mid-stride.
    const lib = scaffoldClipLib(input('idle', 'walk', 'run', 'slash', 'fall'));
    const loops = Object.fromEntries(lib.clips.map((clip) => [clip.id, clip.loop]));
    expect(loops).toEqual({ idle: true, walk: true, run: true, slash: false, fall: false });
  });

  it('carries the measured duration through, rounded but never invented', () => {
    const lib = scaffoldClipLib({ ...input(), clips: [{ id: 'idle', source: 'clips/idle.glb', durationMs: 2400.4 }] });
    expect(lib.clips[0]?.durationMs).toBe(2400);
  });

  it('never writes a zero duration, whatever it was handed', () => {
    // A zero would divide into every rate the machine computes.
    const lib = scaffoldClipLib({ ...input(), clips: [{ id: 'idle', source: 'clips/idle.glb', durationMs: 0 }] });
    expect(lib.clips[0]?.durationMs).toBeGreaterThan(0);
  });

  it('puts events only on the attack clip, because only it has a map naming them', () => {
    const lib = scaffoldClipLib(input('idle', 'walk', 'slash'));
    expect(lib.clips.find((clip) => clip.id === 'slash')?.events.map((event) => event.name)).toEqual([
      'swing.start',
      'swing.impact',
    ]);
    expect(lib.clips.find((clip) => clip.id === 'idle')?.events).toEqual([]);
  });
});

describe('scaffoldStateMachine', () => {
  it('declares exactly the parameters the runtime driver writes', () => {
    // The rule the whole file follows. A parameter nothing sets is a control
    // nobody touches; one the runtime sets that is not declared is dropped.
    expect(scaffoldStateMachine(input('idle')).parameters.map((entry) => entry.name).sort()).toEqual([
      'attack',
      'dead',
      'speed',
    ]);
  });

  it('grows with the clip set rather than emitting states nothing can reach', () => {
    expect(scaffoldStateMachine(input('idle')).states.map((state) => state.id)).toEqual(['idle']);
    expect(scaffoldStateMachine(input('idle', 'walk')).states.map((state) => state.id)).toEqual(['idle', 'locomotion']);
    expect(scaffoldStateMachine(input('idle', 'walk', 'slash', 'fall')).states.map((state) => state.id)).toEqual([
      'idle',
      'locomotion',
      'swing',
      'down',
    ]);
  });

  it('emits no state for a clip the runtime has no way into', () => {
    // `climb`, `jump`, `dive`, `turn` are real presets with no parameter behind
    // them. A machine full of unreachable states reads as finished and is not.
    const machine = scaffoldStateMachine(input('idle', 'climb', 'jump', 'dive', 'turn'));
    expect(machine.states.map((state) => state.id)).toEqual(['idle']);
  });

  it('gives every state a category that means what it says', () => {
    const machine = scaffoldStateMachine(input('idle', 'walk', 'slash', 'fall'));
    const byId = Object.fromEntries(machine.states.map((state) => [state.id, state.category]));
    expect(byId).toEqual({ idle: 'loop', locomotion: 'loop', swing: 'locking', down: 'terminal' });
  });

  it('blends only when there is more than one clip to blend', () => {
    // A one-threshold tree is indirection over nothing.
    expect(scaffoldStateMachine(input('idle')).blendTrees).toEqual([]);
    expect(scaffoldStateMachine(input('idle', 'walk')).blendTrees).toHaveLength(1);
    expect(scaffoldStateMachine(input('idle', 'walk', 'run')).blendTrees[0]?.thresholds).toHaveLength(3);
  });

  it('prefers slash for the attack and falls back to shoot', () => {
    expect(scaffoldStateMachine(input('idle', 'slash', 'shoot')).actionTimings[0]?.clipRef).toBe('slash');
    expect(scaffoldStateMachine(input('idle', 'shoot')).actionTimings[0]?.clipRef).toBe('shoot');
    expect(scaffoldStateMachine(input('idle')).actionTimings).toEqual([]);
  });

  it('splits the action out of the clip so nothing is stretched before tuning', () => {
    // The rate is exactly 1: the scaffold takes no position on timing beyond
    // what the clip already is, and retuning it is the panel's whole purpose.
    const source = input('idle', 'slash');
    const timing = scaffoldStateMachine(source).actionTimings[0];
    if (!timing) throw new Error('no action timing scaffolded');
    const total = timing.windupMs + timing.activeMs + timing.recoveryMs;
    const slash = source.clips.find((clip) => clip.id === 'slash');
    expect(total).toBe(slash?.durationMs);
    expect(stretchRatio(timeScaleFor(timing, slash?.durationMs ?? 0))).toBeCloseTo(1, 5);
  });

  it('leads with the wind-up, because that is the decision the game is built on', () => {
    const timing = scaffoldStateMachine(input('idle', 'slash')).actionTimings[0];
    if (!timing) throw new Error('no action timing scaffolded');
    expect(timing.windupMs).toBeGreaterThan(timing.activeMs);
    expect(timing.recoveryMs).toBeGreaterThan(timing.activeMs);
  });

  it('names an idle even when the clip set has none', () => {
    const machine = scaffoldStateMachine(input('walk'));
    expect(machine.states[0]?.clipRef).toBe('walk');
  });
});

describe('what it produces actually validates and runs', () => {
  it('passes the parser both callers use', () => {
    // The point of the whole file: Export refuses to write a document that does
    // not validate, so a scaffold that produced one would be a button that
    // cannot work.
    for (const set of [['idle'], ['idle', 'walk'], ['idle', 'walk', 'run', 'slash', 'fall'], ['shoot']]) {
      const { unit, clipLib } = asUnit(...set);
      const result = loadUnitBundle(unit, clipLib);
      expect(errorsOf(result.issues), set.join('+')).toEqual([]);
    }
  });

  it('passes the full bundle check against a real skeleton', () => {
    const { unit, clipLib } = asUnit('idle', 'walk', 'run', 'slash', 'fall');
    const issues = validateUnitBundle({ unit, skeleton: skeletonFixture(), clipLib });
    expect(errorsOf(issues)).toEqual([]);
  });

  it('drives: the machine reaches locomotion, swings, and dies', () => {
    const { unit, clipLib } = asUnit('idle', 'walk', 'run', 'slash', 'fall');
    const machine = new UnitMachine({ unit, clipLib });
    expect(machine.stateId).toBe('idle');

    machine.setParameter('speed', 80);
    machine.step(10);
    expect(machine.stateId).toBe('locomotion');

    machine.trigger('attack');
    machine.step(1);
    expect(machine.stateId).toBe('swing');

    machine.setParameter('dead', true);
    machine.step(120);
    expect(machine.stateId).toBe('down');
    // Terminal means terminal: nothing gets it back up.
    machine.setParameter('dead', false);
    machine.setParameter('speed', 200);
    machine.step(120);
    expect(machine.stateId).toBe('down');
  });

  it('fires the events the action timing names', () => {
    const { unit, clipLib } = asUnit('idle', 'slash');
    const machine = new UnitMachine({ unit, clipLib });
    machine.trigger('attack');
    const fired: string[] = [];
    for (let tick = 0; tick < 120; tick += 1) fired.push(...machine.step(1).map((event) => event.name));
    expect(fired).toContain('swing.start');
    expect(fired).toContain('swing.impact');
  });

  it('a one-clip unit still runs rather than throwing', () => {
    const { unit, clipLib } = asUnit('idle');
    const machine = new UnitMachine({ unit, clipLib });
    expect(() => machine.step(60)).not.toThrow();
    expect(machine.stateId).toBe('idle');
  });
});
