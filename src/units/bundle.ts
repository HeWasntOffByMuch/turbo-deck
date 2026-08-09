/**
 * The one way a unit gets read (spec 111).
 *
 * The brief's rule is that the Studio tab and the game consume the exact same
 * files through the same parser. Until this existed that was true of the
 * *format* and false of the *reading*: the tab imported its JSON and cast it
 * with `as unknown as UnitDef`, which type-checks, runs, and means the tab is
 * the one caller that never finds out a document is broken. A cast is not a
 * parser. It is the absence of one, spelled in a way that passes CI.
 *
 * So both callers come through here. What it adds over calling the validators
 * directly is only that it is *one call* — which is the entire point, because a
 * boundary two callers can each choose to skip is not a boundary.
 *
 * Pure, and knows nothing about files. Paths, `fetch` and `?url` imports are the
 * caller's problem; this takes two parsed documents and hands back either a
 * bundle that is known good or the reasons it is not.
 */

import { errorsOf, hasErrors, type Issue } from './issues.js';
import type { ClipLib, UnitDef } from './types.js';
import { validateClipLib, validateUnitDef } from './validate.js';

export interface UnitBundleResult {
  /** Null when anything errored. Never a partly-validated document. */
  readonly value: { readonly unit: UnitDef; readonly clipLib: ClipLib } | null;
  readonly issues: readonly Issue[];
}

/**
 * Validates a unitdef and its clip library together.
 *
 * Deliberately *not* `validateUnitBundle`, which also wants a skeleton and
 * checks the bone contract. That check belongs to CI and to the export path,
 * which have the skeleton document on disk; a runtime that refused to draw a
 * unit because its skeleton file was not bundled would be enforcing an
 * authoring rule at the wrong end of the pipeline. What is checked here is what
 * the machine actually needs to run: that both documents are well formed, and
 * that every clip the state machine names exists in the library.
 */
export function loadUnitBundle(unitDoc: unknown, clipLibDoc: unknown): UnitBundleResult {
  const unit = validateUnitDef(unitDoc);
  const clipLib = validateClipLib(clipLibDoc);
  const issues: Issue[] = [...unit.issues, ...clipLib.issues];

  if (!unit.value || !clipLib.value) return { value: null, issues };
  issues.push(...missingClipRefs(unit.value, clipLib.value));

  return {
    value: hasErrors(issues) ? null : { unit: unit.value, clipLib: clipLib.value },
    issues,
  };
}

/**
 * Clip references the library cannot satisfy.
 *
 * An error rather than a warning, and checked here rather than left to fail at
 * play time: a state whose clip is missing draws nothing at all, and "the
 * monster is invisible" is a long way from "the library is missing `slash`".
 */
function missingClipRefs(unit: UnitDef, clipLib: ClipLib): readonly Issue[] {
  const have = new Set(clipLib.clips.map((clip) => clip.id));
  const trees = new Set(unit.stateMachine.blendTrees.map((tree) => tree.id));
  const issues: Issue[] = [];

  const want: { readonly ref: string; readonly path: string }[] = [
    ...unit.stateMachine.states.map((state, index) => ({
      ref: state.clipRef,
      path: `/stateMachine/states/${index}/clipRef`,
    })),
    ...unit.stateMachine.blendTrees.flatMap((tree, treeIndex) =>
      tree.thresholds.map((threshold, index) => ({
        ref: threshold.clipRef,
        path: `/stateMachine/blendTrees/${treeIndex}/thresholds/${index}/clipRef`,
      })),
    ),
    ...unit.stateMachine.actionTimings.map((action, index) => ({
      ref: action.clipRef,
      path: `/stateMachine/actionTimings/${index}/clipRef`,
    })),
  ];

  for (const { ref, path } of want) {
    // A state may name a blend tree instead of a clip; that is the tree's own
    // thresholds' problem, and they are in this list too.
    if (have.has(ref) || trees.has(ref)) continue;
    issues.push({
      severity: 'error',
      code: 'bundle.clipRef',
      path,
      message: `"${ref}" is not a clip in library "${clipLib.id}" (it has: ${[...have].join(', ')})`,
    });
  }
  return issues;
}

/** One line per error, for a console or a panel. */
export function bundleErrorText(result: UnitBundleResult): string {
  return errorsOf(result.issues)
    .map((issue) => `${issue.path || '/'} ${issue.message}`)
    .join('; ');
}
