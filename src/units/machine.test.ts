/**
 * The state machine both the tool and the game drive (spec 110).
 *
 * The tests that matter most are the event ones. An event is a hit landing, and
 * a hit that lands twice -- or lands on a different tick at 30fps than at 144 --
 * is a bug a player feels long before anyone can see it in a log.
 */

import { describe, expect, it } from 'vitest';
import { blendWeights, UnitMachine, type FiredEvent } from './machine.js';
import type { ClipLib, StateMachine, UnitDef } from './types.js';

const TICK = 1000 / 60;

function clipLib(patch: Partial<ClipLib> = {}): ClipLib {
  return {
    formatVersion: 1,
    id: 'test.core',
    skeletonRef: 'x.skeleton.json',
    clips: [
      { id: 'idle', source: 'clips/idle.glb', durationMs: 1200, loop: true, events: [] },
      {
        id: 'walk',
        source: 'clips/walk.glb',
        durationMs: 1000,
        loop: true,
        events: [
          { name: 'footstep.l', normalizedTime: 0.1 },
          { name: 'footstep.r', normalizedTime: 0.6 },
        ],
      },
      { id: 'run', source: 'clips/run.glb', durationMs: 600, loop: true, events: [] },
      {
        id: 'attack',
        source: 'clips/attack.glb',
        durationMs: 600,
        loop: false,
        events: [
          { name: 'swing.start', normalizedTime: 0 },
          { name: 'swing.impact', normalizedTime: 0.5 },
        ],
      },
      { id: 'death', source: 'clips/death.glb', durationMs: 800, loop: false, events: [] },
    ],
    ...patch,
  };
}

function machineOf(patch: Partial<StateMachine> = {}, unitPatch: Partial<UnitDef> = {}): UnitDef {
  return {
    formatVersion: 1,
    id: 'test',
    meshRef: 'x.glb',
    skeletonRef: 'x.skeleton.json',
    clipLibRef: 'x.cliplib.json',
    provenance: {
      tripoTaskIds: { imageToModel: 'a', rigCheck: 'b', rig: null, retarget: [] },
      modelVersion: 'v',
      faceLimit: 100,
      referenceImageSha256: 'a'.repeat(64),
      creditsSpent: 0,
      generatedAt: '2026-01-01T00:00:00Z',
    },
    import: { normals: 'flat', targetTris: 100, scale: 1, upAxis: '+Y' },
    maxTimeScale: 2,
    stateMachine: {
      parameters: [
        { name: 'speed', type: 'float' },
        { name: 'attack', type: 'trigger' },
        { name: 'dead', type: 'bool' },
      ],
      states: [
        { id: 'idle', clipRef: 'idle', loop: true, timeScale: 1, blendInMs: 0, category: 'loop' },
        { id: 'locomotion', clipRef: 'move', loop: true, timeScale: 1, blendInMs: 0, category: 'loop' },
        { id: 'swing', clipRef: 'attack', loop: false, timeScale: 1, blendInMs: 0, category: 'locking' },
        { id: 'death', clipRef: 'death', loop: false, timeScale: 1, blendInMs: 0, category: 'terminal' },
      ],
      blendTrees: [
        {
          id: 'move',
          parameter: 'speed',
          thresholds: [
            { value: 0, clipRef: 'idle' },
            { value: 34, clipRef: 'walk' },
            { value: 150, clipRef: 'run' },
          ],
        },
      ],
      transitions: [
        { from: 'idle', to: 'locomotion', condition: 'speed > 5', durationMs: 0, interruptible: true },
        { from: 'locomotion', to: 'idle', condition: 'speed < 5', durationMs: 0, interruptible: true },
        { from: '*', to: 'swing', condition: 'attack', durationMs: 0, interruptible: false },
        { from: 'swing', to: 'idle', condition: 'exit', durationMs: 0, interruptible: false },
        { from: '*', to: 'death', condition: 'dead', durationMs: 0, interruptible: true },
      ],
      actionTimings: [
        {
          actionId: 'basic.attack',
          windupMs: 200,
          activeMs: 100,
          recoveryMs: 200,
          clipRef: 'attack',
          eventMap: { active: 'swing.impact' },
        },
      ],
      ...patch,
    },
    ...unitPatch,
  };
}

function build(patch: Partial<StateMachine> = {}, unitPatch: Partial<UnitDef> = {}, entry = 'idle'): UnitMachine {
  return new UnitMachine({ unit: machineOf(patch, unitPatch), clipLib: clipLib(), tickMs: TICK, entryStateId: entry });
}

/** Runs `ticks` in chunks of `chunk`, collecting everything that fired. */
function run(machine: UnitMachine, ticks: number, chunk = 1): readonly FiredEvent[] {
  const fired: FiredEvent[] = [];
  let done = 0;
  while (done < ticks) {
    const size = Math.min(chunk, ticks - done);
    fired.push(...machine.step(size));
    done += size;
  }
  return fired;
}

// --- events ------------------------------------------------------------------

describe('events', () => {
  it('fire once per lap of a looping clip', () => {
    const machine = build();
    machine.setParameter('speed', 40); // walk dominates the blend
    machine.step(1);
    // A 1000ms clip at 60Hz is 60 ticks. Three laps, two events each.
    const fired = run(machine, 180);
    const footsteps = fired.filter((event) => event.name.startsWith('footstep'));
    expect(footsteps.length).toBe(6);
  });

  it('fire identically however the ticks are chunked', () => {
    // The 30/60/144 Hz property: the render loop's chunk size must not change
    // which tick an event lands on.
    const reference = (() => {
      const machine = build();
      machine.setParameter('speed', 40);
      machine.step(1);
      return run(machine, 240, 1).map((event) => `${event.tick}:${event.name}`);
    })();

    for (const chunk of [2, 3, 5, 8]) {
      const machine = build();
      machine.setParameter('speed', 40);
      machine.step(1);
      const fired = run(machine, 240, chunk).map((event) => `${event.tick}:${event.name}`);
      expect(fired, `chunk of ${chunk}`).toEqual(reference);
    }
  });

  it('fire in ascending time order within one lap', () => {
    const machine = build();
    machine.setParameter('speed', 40);
    machine.step(1);
    const fired = run(machine, 60);
    const names = fired.filter((event) => event.name.startsWith('footstep')).map((event) => event.name);
    expect(names).toEqual(['footstep.l', 'footstep.r']);
  });

  it('fire an event authored at time zero', () => {
    // The playhead starts before frame zero so the first tick lands on it. Off
    // by one the other way and a swing's commit frame never fires at all.
    const machine = build();
    machine.trigger('attack');
    const fired = run(machine, 4);
    expect(fired.map((event) => event.name)).toContain('swing.start');
  });

  it('do not fire again once a one-shot has ended', () => {
    // Its playhead sits on the last frame forever; without a guard the event on
    // that frame would fire on every tick that followed.
    const machine = build({ transitions: [] });
    const attackOnly = new UnitMachine({
      unit: machineOf({ transitions: [] }),
      clipLib: clipLib(),
      tickMs: TICK,
      entryStateId: 'swing',
    });
    void machine;
    const fired = run(attackOnly, 240);
    expect(fired.filter((event) => event.name === 'swing.impact').length).toBe(1);
    expect(fired.filter((event) => event.name === 'swing.start').length).toBe(1);
  });

  it('report the clip and state they came from', () => {
    const machine = build();
    machine.setParameter('speed', 40);
    const fired = run(machine, 90);
    const step = fired.find((event) => event.name === 'footstep.l');
    expect(step?.clipId).toBe('walk');
    expect(step?.stateId).toBe('locomotion');
  });

  it('are not doubled by a crossfade', () => {
    // Both states are playing during a blend, but only the incoming one fires.
    // Otherwise every gait change puts two footsteps under one stride.
    const blended = machineOf({
      transitions: [
        { from: 'idle', to: 'locomotion', condition: 'speed > 5', durationMs: 250, interruptible: true },
      ],
    });
    const machine = new UnitMachine({ unit: blended, clipLib: clipLib(), tickMs: TICK, entryStateId: 'idle' });
    machine.setParameter('speed', 40);
    const fired = run(machine, 120);
    const perTick = new Map<number, number>();
    for (const event of fired) perTick.set(event.tick, (perTick.get(event.tick) ?? 0) + 1);
    expect([...perTick.values()].every((count) => count === 1)).toBe(true);
  });
});

// --- determinism -------------------------------------------------------------

describe('determinism', () => {
  it('reaches the same state whether stepped one tick at a time or in bulk', () => {
    const single = build();
    const bulk = build();
    for (const machine of [single, bulk]) machine.setParameter('speed', 40);
    run(single, 200, 1);
    run(bulk, 200, 10);
    expect(single.snapshot()).toEqual(bulk.snapshot());
  });

  it('gives the same poses for the same inputs', () => {
    const a = build();
    const b = build();
    for (const machine of [a, b]) machine.setParameter('speed', 80);
    run(a, 137);
    run(b, 137);
    expect(a.poses()).toEqual(b.poses());
  });
});

// --- state categories --------------------------------------------------------

describe('state categories', () => {
  it('lets loop states transition freely', () => {
    const machine = build();
    machine.setParameter('speed', 40);
    machine.step(1);
    expect(machine.stateId).toBe('locomotion');
    machine.setParameter('speed', 0);
    machine.step(1);
    expect(machine.stateId).toBe('idle');
  });

  it('refuses every transition out of a locking state until it ends', () => {
    // The decision the game is built on: committing to a blow means being
    // committed to it.
    const machine = build();
    machine.trigger('attack');
    machine.step(1);
    expect(machine.stateId).toBe('swing');

    machine.setParameter('speed', 200);
    machine.setParameter('dead', true);
    // A 600ms clip is 36 ticks; nothing may move it before then.
    run(machine, 20);
    expect(machine.stateId).toBe('swing');

    run(machine, 40);
    expect(machine.stateId).not.toBe('swing');
  });

  it('gives a terminal state no exit', () => {
    const machine = build();
    machine.setParameter('dead', true);
    machine.step(1);
    expect(machine.stateId).toBe('death');
    machine.setParameter('speed', 200);
    machine.setParameter('dead', false);
    run(machine, 300);
    expect(machine.stateId).toBe('death');
  });

  it('returns a one-shot to where it came from', () => {
    const oneshot = machineOf({
      states: [
        { id: 'idle', clipRef: 'idle', loop: true, timeScale: 1, blendInMs: 0, category: 'loop' },
        { id: 'swing', clipRef: 'attack', loop: false, timeScale: 1, blendInMs: 0, category: 'oneshot' },
      ],
      transitions: [{ from: '*', to: 'swing', condition: 'attack', durationMs: 0, interruptible: false }],
      blendTrees: [],
    });
    const machine = new UnitMachine({ unit: oneshot, clipLib: clipLib(), tickMs: TICK, entryStateId: 'idle' });
    machine.trigger('attack');
    machine.step(1);
    expect(machine.stateId).toBe('swing');
    run(machine, 60);
    expect(machine.stateId).toBe('idle');
  });
});

// --- blending ----------------------------------------------------------------

describe('blend trees', () => {
  const tree = {
    id: 'move',
    parameter: 'speed',
    thresholds: [
      { value: 0, clipRef: 'idle' },
      { value: 34, clipRef: 'walk' },
      { value: 150, clipRef: 'run' },
    ],
  };

  it('picks the pair either side of the value and weights them', () => {
    const samples = blendWeights(tree, 17);
    expect(samples.map((sample) => sample.clipId)).toEqual(['idle', 'walk']);
    expect(samples[0]?.weight).toBeCloseTo(0.5, 6);
    expect(samples[1]?.weight).toBeCloseTo(0.5, 6);
  });

  it('clamps rather than extrapolating past the ends', () => {
    // A speed above the fastest threshold is a run, not a run-and-a-half.
    expect(blendWeights(tree, -50)).toEqual([{ clipId: 'idle', normalizedTime: 0, weight: 1 }]);
    expect(blendWeights(tree, 9999)).toEqual([{ clipId: 'run', normalizedTime: 0, weight: 1 }]);
  });

  it('lands exactly on a threshold with a single clip at full weight', () => {
    const samples = blendWeights(tree, 34);
    expect(samples.filter((sample) => sample.weight > 0.999).map((sample) => sample.clipId)).toEqual(['walk']);
  });

  it('always sums to one', () => {
    for (const value of [-10, 0, 5, 34, 90, 150, 400]) {
      const total = blendWeights(tree, value).reduce((sum, sample) => sum + sample.weight, 0);
      expect(total, `speed ${value}`).toBeCloseTo(1, 6);
    }
  });
});

describe('poses', () => {
  it('sum to one, blending or not', () => {
    const blended = machineOf({
      transitions: [
        { from: 'idle', to: 'locomotion', condition: 'speed > 5', durationMs: 250, interruptible: true },
      ],
    });
    const machine = new UnitMachine({ unit: blended, clipLib: clipLib(), tickMs: TICK, entryStateId: 'idle' });
    machine.setParameter('speed', 60);
    for (let tick = 0; tick < 40; tick += 1) {
      machine.step(1);
      const total = machine.poses().reduce((sum, sample) => sum + sample.weight, 0);
      expect(total, `tick ${tick}`).toBeCloseTo(1, 5);
    }
  });

  it('include the outgoing state while a transition blends', () => {
    const blended = machineOf({
      transitions: [
        { from: 'idle', to: 'locomotion', condition: 'speed > 5', durationMs: 250, interruptible: true },
      ],
    });
    const machine = new UnitMachine({ unit: blended, clipLib: clipLib(), tickMs: TICK, entryStateId: 'idle' });
    machine.setParameter('speed', 200);
    machine.step(2);
    expect(machine.snapshot().previousStateId).toBe('idle');
    expect(machine.snapshot().blend).toBeLessThan(1);
    machine.step(30);
    expect(machine.snapshot().previousStateId).toBeNull();
    expect(machine.snapshot().blend).toBe(1);
  });
});

// --- actions -----------------------------------------------------------------

describe('actions', () => {
  it('rescale the clip to the timing rather than the other way round', () => {
    // The rule the whole format exists for. A 600ms clip over a 500ms action
    // runs at 1.2x, so it is *done* after 500ms (30 ticks) rather than after its
    // own 600ms (36 ticks). Compared against the same state entered normally,
    // which at 30 ticks is only five sixths of the way through.
    //
    // Transitions are stripped so the measurement is of the playhead and not of
    // the exit transition that would otherwise have already fired.
    const noExit = machineOf({ transitions: [] });
    const scaled = new UnitMachine({ unit: noExit, clipLib: clipLib(), tickMs: TICK, entryStateId: 'idle' });
    expect(scaled.startAction('basic.attack')).toBe(true);
    expect(scaled.stateId).toBe('swing');
    run(scaled, 30);
    expect(scaled.snapshot().normalizedTime).toBe(1);

    const unscaled = new UnitMachine({ unit: noExit, clipLib: clipLib(), tickMs: TICK, entryStateId: 'swing' });
    run(unscaled, 30);
    expect(unscaled.snapshot().normalizedTime).toBeLessThan(0.9);
  });

  it('report which phase they are in', () => {
    const machine = build();
    machine.startAction('basic.attack');
    machine.step(1);
    expect(machine.snapshot().actionPhase).toBe('windup');
    run(machine, 14); // ~250ms in: past the 200ms wind-up
    expect(machine.snapshot().actionPhase).toBe('active');
    run(machine, 6); // ~350ms: into recovery
    expect(machine.snapshot().actionPhase).toBe('recovery');
  });

  it('land their impact event inside the active window', () => {
    // The check the validator makes statically, confirmed dynamically: the event
    // fires while the phase is the one it is mapped to.
    const machine = build();
    machine.startAction('basic.attack');
    let phaseAtImpact: string | null = null;
    for (let tick = 0; tick < 40; tick += 1) {
      const fired = machine.step(1);
      if (fired.some((event) => event.name === 'swing.impact')) {
        phaseAtImpact = machine.snapshot().actionPhase;
        break;
      }
    }
    expect(phaseAtImpact).toBe('active');
  });

  it('refuse an action that is not in the table', () => {
    expect(build().startAction('nope')).toBe(false);
  });
});

// --- parameters --------------------------------------------------------------

describe('parameters', () => {
  it('ignore a name the unit never declared', () => {
    const machine = build();
    machine.setParameter('invented', 5);
    expect(machine.getParameter('invented')).toBeUndefined();
  });

  it('consume a trigger, so it fires one transition and not the next', () => {
    const machine = build();
    machine.trigger('attack');
    machine.step(1);
    expect(machine.stateId).toBe('swing');
    run(machine, 60); // through the swing and back to idle
    expect(machine.stateId).toBe('idle');
    run(machine, 30);
    // The trigger was spent by the first transition; nothing re-enters.
    expect(machine.stateId).toBe('idle');
  });

  it('start numeric at zero and boolean at false', () => {
    const machine = build();
    expect(machine.getParameter('speed')).toBe(0);
    expect(machine.getParameter('dead')).toBe(false);
  });
});
