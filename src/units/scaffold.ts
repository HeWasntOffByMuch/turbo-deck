/**
 * A first unitdef for a unit that has just been generated (spec 112).
 *
 * Between "the job succeeded" and "there is a unit" sat a gap nothing crossed.
 * Export refuses to invent clip durations — a made-up duration validates and
 * then silently rescales every action timing, which is the one failure this
 * format exists to prevent — and it refuses to invent a state machine, because
 * a unit with no states is not a unit. Both refusals are right. What was
 * missing was anything that produced them honestly.
 *
 * So: durations are **measured** off the loaded `.glb` by the caller and passed
 * in, and the machine is derived from which clips actually exist.
 *
 * ## The rule this follows
 *
 * **Scaffold only what the runtime can drive.** `unit-driver.ts` writes exactly
 * three things — `speed`, `dead` and an `attack` trigger — so those are the
 * parameters, and every state here is reachable by one of them. It would be
 * easy to also emit a `hurt` state, a `jump`, a `climb`; they would validate,
 * they would look thorough, and nothing in the game would ever enter them. A
 * starting point full of states that cannot be reached is worse than a small
 * one, because it reads as finished.
 *
 * Everything here is a *starting point*, not an answer. The timings are split
 * from the clip's own length so the rate is exactly 1.0 and nothing is stretched
 * before a person has touched it; retuning them is the entire purpose of the
 * preview panel, and the 2x bound is what catches a retune that went too far.
 */

import { DEFAULT_MAX_TIME_SCALE } from './timing.js';
import type { ActionTiming, Clip, ClipLib, State, StateMachine, Transition } from './types.js';

/** A clip that exists, with the duration read off its file. */
export interface MeasuredClip {
  /** The clip id, which is the preset intent it was retargeted from. */
  readonly id: string;
  /** Relative to the unit directory, e.g. `clips/walk.glb`. */
  readonly source: string;
  /** Measured, never guessed. */
  readonly durationMs: number;
}

/**
 * Which presets loop.
 *
 * A cycle is a loop; a thing that happens once is not. Getting this wrong is
 * visible immediately — a looping death, or a walk that plays once and freezes
 * mid-stride — which is why it is a table rather than a heuristic on the name.
 */
const LOOPING: ReadonlySet<string> = new Set(['idle', 'walk', 'run', 'climb']);

/** Locomotion clips in speed order, with the thresholds the blend tree uses. */
const LOCOMOTION: readonly { readonly id: string; readonly value: number }[] = [
  { id: 'idle', value: 0 },
  { id: 'walk', value: 34 },
  { id: 'run', value: 150 },
];

/** Below this the unit is standing still. Matches the reference unit's tuning. */
const MOVING_SPEED = 5;

/** The clip an attack is thrown with, in order of preference. */
const ATTACK_CLIPS: readonly string[] = ['slash', 'shoot'];

/** The clip a death rests on. `fall` is the nearest the vocabulary has. */
const DEATH_CLIPS: readonly string[] = ['fall', 'hurt'];

/**
 * The events an attack clip carries, and the phases they mark.
 *
 * Emitted with the clip rather than left empty, because the action timing's
 * `eventMap` names them and a map pointing at events that do not exist is a
 * document that does not validate. The times are a starting guess and are meant
 * to be dragged.
 */
const SWING_EVENTS = [
  { name: 'swing.start', normalizedTime: 0 },
  { name: 'swing.impact', normalizedTime: 0.55 },
] as const;

export interface ScaffoldInput {
  readonly clipLibId: string;
  readonly skeletonRef: string;
  readonly clips: readonly MeasuredClip[];
}

/**
 * A clip library over what was actually retargeted.
 *
 * No events except on the attack clip, and those exist only because the action
 * timing has to name something real. Everything else is authored by dragging a
 * marker, which is a thing a person does while watching, not a thing a
 * generator guesses.
 */
export function scaffoldClipLib(input: ScaffoldInput): ClipLib {
  const attack = pickFirst(input.clips, ATTACK_CLIPS);
  return {
    formatVersion: 1,
    id: input.clipLibId,
    skeletonRef: input.skeletonRef,
    clips: input.clips.map(
      (clip): Clip => ({
        id: clip.id,
        source: clip.source,
        durationMs: Math.max(1, Math.round(clip.durationMs)),
        loop: LOOPING.has(clip.id),
        events: clip.id === attack?.id ? SWING_EVENTS.map((event) => ({ ...event })) : [],
      }),
    ),
  };
}

/**
 * A state machine reaching only the states the runtime can actually get to.
 *
 * Grows with the clip set: a unit with only an idle gets one state and no
 * transitions, one with a walk gets the locomotion blend, one with a slash gets
 * a locking swing, one with a fall gets a terminal death. Nothing is emitted
 * for a clip that has no way in.
 */
export function scaffoldStateMachine(input: ScaffoldInput, maxTimeScale = DEFAULT_MAX_TIME_SCALE): StateMachine {
  const have = new Set(input.clips.map((clip) => clip.id));
  const locomotion = LOCOMOTION.filter((entry) => have.has(entry.id));
  const attack = pickFirst(input.clips, ATTACK_CLIPS);
  const death = pickFirst(input.clips, DEATH_CLIPS);

  // A blend tree needs two clips to blend between; with one it is just a clip,
  // and a one-threshold tree would be a layer of indirection over nothing.
  const blended = locomotion.length >= 2;
  const idleClip = have.has('idle') ? 'idle' : (input.clips[0]?.id ?? 'idle');

  const states: State[] = [
    { id: 'idle', clipRef: idleClip, loop: true, timeScale: 1, blendInMs: 150, category: 'loop' },
  ];
  const transitions: Transition[] = [];

  if (blended) {
    states.push({ id: 'locomotion', clipRef: 'move', loop: true, timeScale: 1, blendInMs: 150, category: 'loop' });
    transitions.push(
      { from: 'idle', to: 'locomotion', condition: `speed > ${MOVING_SPEED}`, durationMs: 150, interruptible: true },
      { from: 'locomotion', to: 'idle', condition: `speed < ${MOVING_SPEED}`, durationMs: 150, interruptible: true },
    );
  }

  if (attack) {
    states.push({ id: 'swing', clipRef: attack.id, loop: false, timeScale: 1, blendInMs: 60, category: 'locking' });
    transitions.push(
      { from: '*', to: 'swing', condition: 'attack', durationMs: 60, interruptible: false },
      { from: 'swing', to: 'idle', condition: 'exit', durationMs: 120, interruptible: false },
    );
  }

  if (death) {
    states.push({ id: 'down', clipRef: death.id, loop: false, timeScale: 1, blendInMs: 200, category: 'terminal' });
    transitions.push({ from: '*', to: 'down', condition: 'dead', durationMs: 200, interruptible: true });
  }

  return {
    // Exactly what `unit-driver.ts` writes. A parameter the runtime never sets
    // is a control nothing touches; one the runtime sets that is not declared
    // here is silently dropped by `setParameter`.
    parameters: [
      { name: 'speed', type: 'float' },
      { name: 'dead', type: 'bool' },
      { name: 'attack', type: 'trigger' },
    ],
    states,
    blendTrees: blended
      ? [
          {
            id: 'move',
            parameter: 'speed',
            thresholds: locomotion.map((entry) => ({ value: entry.value, clipRef: entry.id })),
          },
        ]
      : [],
    transitions,
    actionTimings: attack ? [attackTiming(attack, maxTimeScale)] : [],
  };
}

/**
 * The basic attack, split out of the clip's own length.
 *
 * Deliberately summing to the clip's duration, so the rate is exactly 1.0 and
 * the scaffold stretches nothing before anybody has looked at it. The split
 * — a long wind-up, a brief active window, a recovery you can be punished in —
 * is this game's whole design premise, so it is the starting shape rather than
 * three equal thirds.
 *
 * `maxTimeScale` is taken and not used for arithmetic on purpose: at rate 1.0
 * the bound cannot be breached, and the parameter is here so a future split that
 * does not sum to the duration cannot silently ignore it.
 */
function attackTiming(clip: MeasuredClip, maxTimeScale: number): ActionTiming {
  void maxTimeScale;
  const total = Math.max(3, Math.round(clip.durationMs));
  const windupMs = Math.round(total * 0.45);
  const activeMs = Math.max(1, Math.round(total * 0.15));
  return {
    actionId: 'basic.attack',
    windupMs,
    activeMs,
    // The remainder rather than another percentage, so the three always sum to
    // the clip's real length and the rate is exactly 1.
    recoveryMs: Math.max(1, total - windupMs - activeMs),
    clipRef: clip.id,
    eventMap: { windup: SWING_EVENTS[0].name, active: SWING_EVENTS[1].name },
  };
}

function pickFirst(clips: readonly MeasuredClip[], preferred: readonly string[]): MeasuredClip | null {
  for (const id of preferred) {
    const found = clips.find((clip) => clip.id === id);
    if (found) return found;
  }
  return null;
}
