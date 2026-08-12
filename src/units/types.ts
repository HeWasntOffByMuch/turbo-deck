/**
 * The three authored documents a unit is made of (spec 107).
 *
 * These types mirror `schemas/*.schema.json` field for field. The schemas are
 * the contract -- they are what CI validates against and what a hand-edited file
 * is checked by -- and these are the shape a *validated* document has, handed
 * out by `validate.ts` and by nothing else. Nothing in the codebase should cast
 * a parsed JSON blob to one of these; that is what the validator is for.
 *
 * Everything is `readonly`, because an authored document is a fact about a file
 * on disk and not a mutable scratchpad. The Studio tab edits these by writing
 * the file and re-reading it, never by mutating a loaded object -- which is what
 * keeps "no hidden state that exists only in the browser session" true by
 * construction rather than by discipline.
 */

import type { NamingSpec } from './naming.js';

export type { NamingSpec };

/** An axis in the project's convention: up is +Y, forward is +X. */
export type Axis = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

export type Vec3 = readonly [number, number, number];
/** A quaternion in xyzw order, matching glTF's own ordering. */
export type Quat = readonly [number, number, number, number];

// --- skeleton.json -----------------------------------------------------------

export interface SkeletonBone {
  readonly name: string;
  /** The parent's name, or null for the single root. */
  readonly parent: string | null;
}

export interface SkeletonSocket {
  readonly id: string;
  readonly bone: string;
  readonly offset?: Vec3;
}

export interface BindBone {
  readonly name: string;
  readonly translation: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

export interface BindPose {
  /** The .glb the pose was measured out of. */
  readonly source: string;
  readonly bones: readonly BindBone[];
}

export interface Skeleton {
  /**
   * An optional note for whoever opens the file next. JSON has no comments and
   * every schema sets `additionalProperties: false`, so without a field for it
   * there is nowhere in an authored document to write down why a number is the
   * number it is. Carried on the type so a read-modify-write does not drop it.
   */
  readonly $comment?: string;
  readonly formatVersion: 1;
  readonly id: string;
  /**
   * The bone vocabulary this family's rigs are named in (spec 120). Detected
   * from the bones rather than assumed: generated rigs come back on the `tripo`
   * spec, the reference mannequin is mixamo-named, and both live in the tree at
   * once. See `naming.ts` for what each contract calls each bone.
   */
  readonly naming: NamingSpec;
  readonly upAxis: Axis;
  readonly forwardAxis: Axis;
  /** Floor to crown in **world** units. This project's world is not metric. */
  readonly canonicalHeight: number;
  readonly boneBudget: { readonly min: number; readonly max: number };
  /** Ordered: array order is canonical, and a parent precedes its children. */
  readonly bones: readonly SkeletonBone[];
  readonly sockets: readonly SkeletonSocket[];
  /** Null while provisional -- the contract written down before a rig exists. */
  readonly bindPose: BindPose | null;
}

// --- cliplib.json ------------------------------------------------------------

export interface ClipEvent {
  readonly name: string;
  /** 0..1. Normalized so rescaling a clip cannot move where the hit lands. */
  readonly normalizedTime: number;
}

export interface Clip {
  readonly id: string;
  /** Animation-only .glb: mesh data is stripped at bake time. */
  readonly source: string;
  /** Authored length. Never authoritative over an action timing. */
  readonly durationMs: number;
  readonly loop: boolean;
  /** Ascending by `normalizedTime`. */
  readonly events: readonly ClipEvent[];
}

export interface ClipLib {
  /**
   * An optional note for whoever opens the file next. JSON has no comments and
   * every schema sets `additionalProperties: false`, so without a field for it
   * there is nowhere in an authored document to write down why a number is the
   * number it is. Carried on the type so a read-modify-write does not drop it.
   */
  readonly $comment?: string;
  readonly formatVersion: 1;
  readonly id: string;
  readonly skeletonRef: string;
  readonly clips: readonly Clip[];
}

// --- <unit>.unitdef.json -----------------------------------------------------

export type StateCategory = 'loop' | 'oneshot' | 'locking' | 'terminal';
export type ParameterType = 'float' | 'int' | 'bool' | 'trigger';

export interface Parameter {
  readonly name: string;
  readonly type: ParameterType;
}

export interface State {
  readonly id: string;
  /** A clip id, or a blend tree id. Transitions address both in one namespace. */
  readonly clipRef: string;
  readonly loop: boolean;
  /** Authored playback rate; bounded by `maxTimeScale` in both directions. */
  readonly timeScale: number;
  readonly blendInMs: number;
  readonly category: StateCategory;
}

export interface BlendThreshold {
  readonly value: number;
  readonly clipRef: string;
}

export interface BlendTree {
  readonly id: string;
  readonly parameter: string;
  /** At least two, strictly ascending by `value`. */
  readonly thresholds: readonly BlendThreshold[];
}

export interface Transition {
  /** A state or blend tree id, or `'*'` for any state. */
  readonly from: string;
  readonly to: string;
  readonly condition: string;
  readonly durationMs: number;
  readonly interruptible: boolean;
}

export interface ActionTiming {
  readonly actionId: string;
  readonly windupMs: number;
  readonly activeMs: number;
  readonly recoveryMs: number;
  readonly clipRef: string;
  /** Phase name -> a clip event name. */
  readonly eventMap: Readonly<Record<string, string>>;
}

export interface StateMachine {
  readonly parameters: readonly Parameter[];
  readonly states: readonly State[];
  readonly blendTrees: readonly BlendTree[];
  readonly transitions: readonly Transition[];
  /** The source of truth for timing. Clips are rescaled to fit these. */
  readonly actionTimings: readonly ActionTiming[];
}

export interface TripoTaskIds {
  readonly imageToModel: string;
  readonly rigCheck: string;
  /** Null for a unit that reused the canonical rig rather than being rigged. */
  readonly rig: string | null;
  /** Empty for every unit after the first of its family. */
  readonly retarget: readonly string[];
}

export interface Provenance {
  readonly tripoTaskIds: TripoTaskIds;
  readonly modelVersion: string;
  readonly faceLimit: number;
  readonly referenceImageSha256: string;
  readonly creditsSpent: number;
  /** ISO 8601. Recorded data, not a clock any reader consults. */
  readonly generatedAt: string;
}

export interface ImportOverrides {
  readonly normals: 'flat' | 'smooth' | 'asAuthored';
  readonly targetTris: number;
  /** Brings the mesh to the skeleton's `canonicalHeight`. Large by design. */
  readonly scale: number;
  readonly upAxis: Axis;
}

export interface UnitDef {
  /**
   * An optional note for whoever opens the file next. JSON has no comments and
   * every schema sets `additionalProperties: false`, so without a field for it
   * there is nowhere in an authored document to write down why a number is the
   * number it is. Carried on the type so a read-modify-write does not drop it.
   */
  readonly $comment?: string;
  readonly formatVersion: 1;
  readonly id: string;
  readonly meshRef: string;
  readonly skeletonRef: string;
  readonly clipLibRef: string;
  readonly provenance: Provenance;
  readonly import: ImportOverrides;
  /** How far a clip may be rescaled in either direction before it is an error. */
  readonly maxTimeScale: number;
  readonly stateMachine: StateMachine;
}

/** The three documents that describe one unit, resolved together. */
export interface UnitBundle {
  readonly unit: UnitDef;
  readonly skeleton: Skeleton;
  readonly clipLib: ClipLib;
}
