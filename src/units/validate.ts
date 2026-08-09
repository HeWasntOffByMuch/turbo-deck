/**
 * Everything a JSON Schema cannot say (spec 107).
 *
 * The schema checks shape; this checks meaning. Reference resolution, ordering,
 * uniqueness, and the one rule the whole format exists for -- that a clip is
 * never rescaled past the point where it stops reading as the motion it was.
 *
 * Split into per-document validation and a cross-document bundle pass, because
 * they are available at different times. A skeleton can be checked the moment it
 * is written; whether a unit's states resolve needs its clip library in hand.
 * Keeping them apart is what lets the Studio tab validate a document being
 * edited without having loaded the other two.
 *
 * Pure: no filesystem, no DOM, no clock. The runner in `scripts/` does the
 * reading and hands documents in.
 */

import { parseCondition, conditionParameter } from './condition.js';
import { error, hasErrors, pointer, warning, type Issue, type Result } from './issues.js';
import { validateAgainstSchema } from './schema.js';
import { actionTotalMs, inWindow, phaseWindows, stretchRatio, timeScaleFor } from './timing.js';
import type { Clip, ClipLib, Skeleton, UnitBundle, UnitDef } from './types.js';

/**
 * Bone names that mean somebody paid for finger joints.
 *
 * A warning, never an error: a rig that has them still works, it is just wasting
 * bones on articulation that is a fraction of a pixel at this camera. Matched on
 * the mixamo names, which is why `naming` is a field on the skeleton -- a
 * different naming spec would want a different list, not a different severity.
 */
const FINGER_BONES = /(Thumb|Index|Middle|Ring|Pinky)\d/i;

/** The phase names an `eventMap` key is checked against; anything else is free-form. */
const PHASE_KEYS = ['windup', 'active', 'recovery'] as const;
type PhaseKey = (typeof PHASE_KEYS)[number];

function isPhaseKey(key: string): key is PhaseKey {
  return (PHASE_KEYS as readonly string[]).includes(key);
}

/** Collects ids, reporting the second and later sightings of each. */
function findDuplicates(
  entries: readonly { readonly id: string; readonly path: string }[],
  code: string,
  what: string,
): Issue[] {
  const seen = new Set<string>();
  const issues: Issue[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      issues.push(error(code, entry.path, `duplicate ${what} id "${entry.id}"`));
    }
    seen.add(entry.id);
  }
  return issues;
}

// --- skeleton ----------------------------------------------------------------

export function validateSkeleton(doc: unknown): Result<Skeleton> {
  const structural = validateAgainstSchema('skeleton', doc);
  if (structural.length > 0) return { value: null, issues: structural };

  const skeleton = doc as Skeleton;
  const issues: Issue[] = [];

  if (skeleton.boneBudget.min > skeleton.boneBudget.max) {
    issues.push(
      error(
        'skeleton.boneBudget.inverted',
        pointer('boneBudget'),
        `min ${skeleton.boneBudget.min} is above max ${skeleton.boneBudget.max}`,
      ),
    );
  }

  const count = skeleton.bones.length;
  if (count < skeleton.boneBudget.min || count > skeleton.boneBudget.max) {
    issues.push(
      error(
        'skeleton.boneBudget',
        pointer('bones'),
        `${count} bones, outside the declared budget of ${skeleton.boneBudget.min}..${skeleton.boneBudget.max}`,
      ),
    );
  }

  // Parent-before-child is checked by walking forwards and only accepting a
  // parent already seen. That one pass rules out forward references, unknown
  // parents and cycles together -- a cycle cannot exist in a list where every
  // parent precedes its child.
  const seen = new Set<string>();
  const names = new Set<string>();
  let roots = 0;
  skeleton.bones.forEach((bone, index) => {
    if (names.has(bone.name)) {
      issues.push(
        error('skeleton.name.duplicate', pointer('bones', index, 'name'), `duplicate bone name "${bone.name}"`),
      );
    }
    names.add(bone.name);

    if (bone.parent === null) {
      roots += 1;
      if (roots > 1) {
        issues.push(
          error(
            'skeleton.root.multiple',
            pointer('bones', index, 'parent'),
            `"${bone.name}" is a second root; a rig family has exactly one`,
          ),
        );
      }
    } else if (!seen.has(bone.parent)) {
      issues.push(
        error(
          'skeleton.parent.forward',
          pointer('bones', index, 'parent'),
          `"${bone.name}" names parent "${bone.parent}", which does not appear earlier in the list`,
        ),
      );
    }
    seen.add(bone.name);

    if (FINGER_BONES.test(bone.name)) {
      issues.push(
        warning(
          'skeleton.fingers',
          pointer('bones', index, 'name'),
          `"${bone.name}" is a finger joint -- wasteful at this camera, where a hand is a few pixels`,
        ),
      );
    }
  });

  if (roots === 0) {
    issues.push(error('skeleton.root.missing', pointer('bones'), 'no bone has a null parent'));
  }

  // Left/Right symmetry, by name. The numeric version -- mirrored bind
  // transforms within a tolerance -- needs a measured bind pose and is checked
  // below only when there is one.
  for (const [index, bone] of skeleton.bones.entries()) {
    const mirrored = mirrorName(bone.name);
    if (mirrored !== null && !names.has(mirrored)) {
      issues.push(
        error(
          'skeleton.symmetry',
          pointer('bones', index, 'name'),
          `"${bone.name}" has no counterpart "${mirrored}"; the rig is not left-right symmetric`,
        ),
      );
    }
  }

  const socketIds = skeleton.sockets.map((socket, index) => ({
    id: socket.id,
    path: pointer('sockets', index, 'id'),
  }));
  issues.push(...findDuplicates(socketIds, 'skeleton.socket.duplicate', 'socket'));
  skeleton.sockets.forEach((socket, index) => {
    if (!names.has(socket.bone)) {
      issues.push(
        error(
          'skeleton.socket.bone',
          pointer('sockets', index, 'bone'),
          `socket "${socket.id}" hangs off "${socket.bone}", which is not a bone in this skeleton`,
        ),
      );
    }
  });

  if (skeleton.bindPose === null) {
    issues.push(
      warning(
        'skeleton.provisional',
        pointer('bindPose'),
        'provisional: the bone contract is written down but no rig has been measured against it. No unit may ship against this skeleton until it is filled in.',
      ),
    );
  } else {
    const bound = new Set(skeleton.bindPose.bones.map((bone) => bone.name));
    for (const [index, bone] of skeleton.bones.entries()) {
      if (!bound.has(bone.name)) {
        issues.push(
          error(
            'skeleton.bindPose.missing',
            pointer('bindPose', 'bones'),
            `bone "${bone.name}" (index ${index}) has no bind transform`,
          ),
        );
      }
    }
    skeleton.bindPose.bones.forEach((bone, index) => {
      if (!names.has(bone.name)) {
        issues.push(
          error(
            'skeleton.bindPose.extra',
            pointer('bindPose', 'bones', index, 'name'),
            `bind pose names "${bone.name}", which is not a bone in this skeleton`,
          ),
        );
      }
    });
  }

  return { value: hasErrors(issues) ? null : skeleton, issues };
}

/**
 * The counterpart name for a sided bone, or null for one that is not sided.
 *
 * Matched on a word boundary so `LeftUpLeg` mirrors and a hypothetical bone with
 * "left" buried inside a longer word does not.
 */
function mirrorName(name: string): string | null {
  if (/Left/.test(name)) return name.replace(/Left/g, 'Right');
  if (/Right/.test(name)) return name.replace(/Right/g, 'Left');
  return null;
}

// --- clip library ------------------------------------------------------------

export function validateClipLib(doc: unknown): Result<ClipLib> {
  const structural = validateAgainstSchema('cliplib', doc);
  if (structural.length > 0) return { value: null, issues: structural };

  const lib = doc as ClipLib;
  const issues: Issue[] = [];

  issues.push(
    ...findDuplicates(
      lib.clips.map((clip, index) => ({ id: clip.id, path: pointer('clips', index, 'id') })),
      'cliplib.clip.duplicate',
      'clip',
    ),
  );

  lib.clips.forEach((clip, clipIndex) => {
    const eventNames = new Set<string>();
    let previous = Number.NEGATIVE_INFINITY;
    clip.events.forEach((event, eventIndex) => {
      const at = pointer('clips', clipIndex, 'events', eventIndex);
      if (event.normalizedTime <= previous) {
        issues.push(
          error(
            'cliplib.event.order',
            `${at}/normalizedTime`,
            `event "${event.name}" at ${event.normalizedTime} is not after the previous event at ${previous}`,
          ),
        );
      }
      previous = event.normalizedTime;
      if (eventNames.has(event.name)) {
        issues.push(
          error('cliplib.event.duplicate', `${at}/name`, `clip "${clip.id}" has two events named "${event.name}"`),
        );
      }
      eventNames.add(event.name);
    });
  });

  return { value: hasErrors(issues) ? null : lib, issues };
}

// --- unit definition ---------------------------------------------------------

/**
 * The checks a unitdef can make on its own: ids, the parameter table, and
 * whether the graph is wired to nodes that exist. Whether those nodes resolve to
 * real *clips* needs the library, and is {@link validateUnitBundle}'s job.
 */
export function validateUnitDef(doc: unknown): Result<UnitDef> {
  const structural = validateAgainstSchema('unitdef', doc);
  if (structural.length > 0) return { value: null, issues: structural };

  const unit = doc as UnitDef;
  const machine = unit.stateMachine;
  const issues: Issue[] = [];

  issues.push(
    ...findDuplicates(
      machine.parameters.map((parameter, index) => ({
        id: parameter.name,
        path: pointer('stateMachine', 'parameters', index, 'name'),
      })),
      'unitdef.parameter.duplicate',
      'parameter',
    ),
  );
  const parameterTypes = new Map(machine.parameters.map((parameter) => [parameter.name, parameter.type]));

  // States and blend trees share one namespace, because a transition names
  // either without saying which -- so a blend tree called `run` and a state
  // called `run` would make `to: "run"` ambiguous rather than merely confusing.
  issues.push(
    ...findDuplicates(
      [
        ...machine.states.map((state, index) => ({
          id: state.id,
          path: pointer('stateMachine', 'states', index, 'id'),
        })),
        ...machine.blendTrees.map((tree, index) => ({
          id: tree.id,
          path: pointer('stateMachine', 'blendTrees', index, 'id'),
        })),
      ],
      'unitdef.node.duplicate',
      'state or blend tree',
    ),
  );

  const stateById = new Map(machine.states.map((state) => [state.id, state]));
  const treeIds = new Set(machine.blendTrees.map((tree) => tree.id));
  const nodeIds = new Set([...stateById.keys(), ...treeIds]);

  machine.blendTrees.forEach((tree, index) => {
    const at = pointer('stateMachine', 'blendTrees', index);
    const type = parameterTypes.get(tree.parameter);
    if (type === undefined) {
      issues.push(
        error(
          'unitdef.parameter.undeclared',
          `${at}/parameter`,
          `blend tree "${tree.id}" reads "${tree.parameter}", which is not a declared parameter`,
        ),
      );
    } else if (type !== 'float' && type !== 'int') {
      issues.push(
        error(
          'unitdef.parameter.type',
          `${at}/parameter`,
          `blend tree "${tree.id}" blends on "${tree.parameter}", which is a ${type}; a blend needs float or int`,
        ),
      );
    }
    let previous = Number.NEGATIVE_INFINITY;
    tree.thresholds.forEach((threshold, thresholdIndex) => {
      if (threshold.value <= previous) {
        issues.push(
          error(
            'unitdef.blendTree.order',
            `${at}/thresholds/${thresholdIndex}/value`,
            `threshold ${threshold.value} is not above the previous ${previous}`,
          ),
        );
      }
      previous = threshold.value;
    });
  });

  machine.transitions.forEach((transition, index) => {
    const at = pointer('stateMachine', 'transitions', index);
    if (transition.from !== '*' && !nodeIds.has(transition.from)) {
      issues.push(
        error('unitdef.transition.from', `${at}/from`, `"${transition.from}" is not a state or blend tree`),
      );
    }
    if (!nodeIds.has(transition.to)) {
      issues.push(error('unitdef.transition.to', `${at}/to`, `"${transition.to}" is not a state or blend tree`));
    }

    const source = stateById.get(transition.from);
    if (source?.category === 'terminal') {
      issues.push(
        error(
          'unitdef.transition.terminal',
          `${at}/from`,
          `"${transition.from}" is terminal, and a terminal state has no exit`,
        ),
      );
    }
    // A locking state is the whole reason the category exists: it refuses to be
    // left until recovery ends. A transition out of one marked interruptible
    // says the opposite, and one of the two has to be wrong.
    if (source?.category === 'locking' && transition.interruptible) {
      issues.push(
        error(
          'unitdef.transition.locking',
          `${at}/interruptible`,
          `"${transition.from}" is locking, so the transition to "${transition.to}" may not be interruptible`,
        ),
      );
    }

    const condition = parseCondition(transition.condition);
    if (condition.kind === 'invalid') {
      issues.push(error('unitdef.condition.parse', `${at}/condition`, condition.reason));
    } else {
      const name = conditionParameter(condition);
      if (name !== null) {
        const type = parameterTypes.get(name);
        if (type === undefined) {
          issues.push(
            error('unitdef.parameter.undeclared', `${at}/condition`, `"${name}" is not a declared parameter`),
          );
        } else if (condition.kind === 'compare' && type !== 'float' && type !== 'int') {
          issues.push(
            error(
              'unitdef.condition.type',
              `${at}/condition`,
              `"${name}" is a ${type}; compare against a number needs float or int`,
            ),
          );
        } else if (condition.kind === 'flag' && type !== 'bool' && type !== 'trigger') {
          issues.push(
            error(
              'unitdef.condition.type',
              `${at}/condition`,
              `"${name}" is a ${type}; used bare it must be a bool or a trigger`,
            ),
          );
        }
      }
    }
  });

  issues.push(
    ...findDuplicates(
      machine.actionTimings.map((timing, index) => ({
        id: timing.actionId,
        path: pointer('stateMachine', 'actionTimings', index, 'actionId'),
      })),
      'unitdef.action.duplicate',
      'action',
    ),
  );

  machine.actionTimings.forEach((timing, index) => {
    // The three phases are non-negative by schema and the total is their sum, so
    // "the active window falls inside the action" is true by construction. What
    // is *not* free is a zero-length action: it divides through every derived
    // number, and an action nobody can be in is not a timing anyone meant.
    if (actionTotalMs(timing) <= 0) {
      issues.push(
        error(
          'unitdef.action.empty',
          pointer('stateMachine', 'actionTimings', index),
          `action "${timing.actionId}" has no duration; wind-up, active and recovery are all zero`,
        ),
      );
    }
  });

  return { value: hasErrors(issues) ? null : unit, issues };
}

// --- the three documents together --------------------------------------------

/**
 * The checks that need all three documents resolved: whether every reference
 * lands, and whether any clip is being rescaled past its bound.
 *
 * Takes documents rather than paths so it runs identically in CI, on the server
 * and in the browser. Whoever resolved `skeletonRef` and `clipLibRef` into these
 * objects is also who knows what a relative path means.
 */
export function validateUnitBundle(bundle: UnitBundle): readonly Issue[] {
  const { unit, skeleton, clipLib } = bundle;
  const machine = unit.stateMachine;
  const issues: Issue[] = [];

  // A unit may not ship against a rig nobody has measured. The skeleton's own
  // validation calls this a warning -- writing the contract down early is the
  // point -- but binding a unit to it is where that stops being harmless.
  if (skeleton.bindPose === null) {
    issues.push(
      error(
        'bundle.skeleton.provisional',
        pointer('skeletonRef'),
        `skeleton "${skeleton.id}" is provisional (no measured bind pose); a unit cannot be validated against it`,
      ),
    );
  }

  const clipById = new Map(clipLib.clips.map((clip) => [clip.id, clip]));
  const treeIds = new Set(machine.blendTrees.map((tree) => tree.id));

  /** Resolves a clip reference, reporting it if it lands nowhere. */
  const resolveClip = (ref: string, path: string, context: string): Clip | null => {
    const clip = clipById.get(ref);
    if (clip) return clip;
    issues.push(
      error(
        'bundle.clipRef.unknown',
        path,
        `${context} names clip "${ref}", which is not in clip library "${clipLib.id}"`,
      ),
    );
    return null;
  };

  machine.states.forEach((state, index) => {
    const at = pointer('stateMachine', 'states', index);
    // A state may name a blend tree instead of a clip -- that is how a
    // locomotion state gets a speed-driven pose -- so a tree id is a hit, not a
    // dangling reference.
    if (treeIds.has(state.clipRef)) return;
    const clip = resolveClip(state.clipRef, `${at}/clipRef`, `state "${state.id}"`);
    if (!clip) return;

    const ratio = stretchRatio(state.timeScale);
    if (ratio > unit.maxTimeScale) {
      issues.push(
        error(
          'bundle.timeScale.exceeded',
          `${at}/timeScale`,
          `state "${state.id}" plays clip "${clip.id}" at ${state.timeScale}x, a stretch of ${ratio.toFixed(2)}x against a limit of ${unit.maxTimeScale}x. Past this it needs a different clip, not more stretching.`,
        ),
      );
    }
    if (state.loop && !clip.loop) {
      issues.push(
        warning(
          'bundle.loop.mismatch',
          `${at}/loop`,
          `state "${state.id}" loops but clip "${clip.id}" is not authored as a looping clip`,
        ),
      );
    }
  });

  machine.blendTrees.forEach((tree, index) => {
    // A state's `clipRef` is resolved as a blend tree first and a clip second,
    // so a tree sharing a clip's name silently shadows it -- the state plays a
    // blend where the author wrote a single clip, and nothing anywhere says so.
    if (clipById.has(tree.id)) {
      issues.push(
        error(
          'bundle.blendTree.shadowsClip',
          pointer('stateMachine', 'blendTrees', index, 'id'),
          `blend tree "${tree.id}" has the same id as a clip in "${clipLib.id}"; a state naming it would get the tree and never the clip`,
        ),
      );
    }
    tree.thresholds.forEach((threshold, thresholdIndex) => {
      resolveClip(
        threshold.clipRef,
        pointer('stateMachine', 'blendTrees', index, 'thresholds', thresholdIndex, 'clipRef'),
        `blend tree "${tree.id}"`,
      );
    });
  });

  machine.actionTimings.forEach((timing, index) => {
    const at = pointer('stateMachine', 'actionTimings', index);
    const clip = resolveClip(timing.clipRef, `${at}/clipRef`, `action "${timing.actionId}"`);
    if (!clip) return;

    const rate = timeScaleFor(timing, clip.durationMs);
    const ratio = stretchRatio(rate);
    if (ratio > unit.maxTimeScale) {
      const total = actionTotalMs(timing);
      issues.push(
        error(
          'bundle.timeScale.exceeded',
          `${at}/clipRef`,
          `action "${timing.actionId}" runs ${total}ms against clip "${clip.id}" at ${clip.durationMs}ms -- a ${ratio.toFixed(2)}x stretch, over the ${unit.maxTimeScale}x limit. The timing is authoritative, so this needs a different clip.`,
        ),
      );
    }

    const windows = phaseWindows(timing);
    const eventsByName = new Map(clip.events.map((event) => [event.name, event]));
    for (const [phase, eventName] of Object.entries(timing.eventMap)) {
      const event = eventsByName.get(eventName);
      if (!event) {
        issues.push(
          error(
            'bundle.event.unknown',
            `${at}/eventMap/${phase}`,
            `action "${timing.actionId}" maps "${phase}" to event "${eventName}", which clip "${clip.id}" does not have`,
          ),
        );
        continue;
      }
      // Only the three phase names are checkable; anything else is a free-form
      // label the game reads and this file has no opinion about.
      if (!isPhaseKey(phase)) continue;
      const window = windows[phase];
      if (!inWindow(event.normalizedTime, window)) {
        issues.push(
          error(
            'bundle.event.window',
            `${at}/eventMap/${phase}`,
            `event "${eventName}" is at ${event.normalizedTime} in clip "${clip.id}", outside the ${phase} window ${window[0].toFixed(3)}..${window[1].toFixed(3)}`,
          ),
        );
      }
    }
  });

  return issues;
}
