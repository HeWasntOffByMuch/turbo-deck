/**
 * The unit authoring format (spec 107).
 *
 * One import for everything that reads or checks an authored unit: the Studio
 * tab, the server's export path, the CI runner and the game's runtime all come
 * through here, which is what makes "the tool and the game read the same files
 * through the same parser" a fact about the module graph rather than a promise.
 */

export type {
  ActionTiming,
  Axis,
  BindBone,
  BindPose,
  BlendThreshold,
  BlendTree,
  Clip,
  ClipEvent,
  ClipLib,
  ImportOverrides,
  Parameter,
  ParameterType,
  Provenance,
  Quat,
  Skeleton,
  SkeletonBone,
  SkeletonSocket,
  State,
  StateCategory,
  StateMachine,
  Transition,
  TripoTaskIds,
  UnitBundle,
  UnitDef,
  Vec3,
} from './types.js';

export type { Condition, ComparisonOp } from './condition.js';
export { conditionParameter, parseCondition } from './condition.js';

export type { Issue, Result, Severity } from './issues.js';
export { errorsOf, formatIssue, hasErrors, pointer, warningsOf } from './issues.js';

export type { DocumentKind } from './schema.js';
export { compileAllSchemas, SCHEMAS, validateAgainstSchema } from './schema.js';

export type { PhaseWindows } from './timing.js';
export {
  actionTotalMs,
  DEFAULT_MAX_TIME_SCALE,
  eventTickIndex,
  inWindow,
  phaseWindows,
  stretchRatio,
  timeScaleFor,
  withinTimeScale,
} from './timing.js';

export { validateClipLib, validateSkeleton, validateUnitBundle, validateUnitDef } from './validate.js';

export type { UnitBundleResult } from './bundle.js';
export { bundleErrorText, loadUnitBundle } from './bundle.js';

export type { RootMotionChannel } from './root-motion.js';
export { rootMotionChannels, rootMotionMessage, rootMotionTrackNames } from './root-motion.js';
