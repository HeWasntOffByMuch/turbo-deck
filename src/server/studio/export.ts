/**
 * Staging a finished job into the repository (spec 109).
 *
 * The rule this file is built around: **it will not invent a number.** A clip's
 * duration is read off the `.glb`, which needs a parsed model and is spec 110's
 * job. Until a caller supplies durations, the export copies the binaries and
 * writes no `cliplib.json` at all, and says so.
 *
 * That is not caution for its own sake. `additionalProperties: false` and a
 * `durationMs > 0` bound mean a made-up duration would *validate* -- the
 * document would look correct, CI would pass, and every action timing computed
 * against it would be scaled by a fiction. An absent file is a problem somebody
 * fixes; a plausible wrong one is a problem nobody looks for.
 *
 * Everything written here goes back through the spec 107 validator before the
 * response is built, so an export can never report success on a document the
 * build would reject.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { readNodeTree, splitGlb } from '../../units/glb-read.js';
import { writeGlbContainer } from '../../units/glb.js';
import { withoutRootMotion } from '../../units/root-motion.js';
import { validateClipLib, validateSkeleton, validateUnitBundle, validateUnitDef } from '../../units/validate.js';
import type { Clip, ClipLib, Issue, StateMachine, UnitDef } from '../../units/index.js';
import type { Job } from './types.js';

export interface ExportRequest {
  readonly job: Job;
  /** Where `assets/units/` lives. */
  readonly unitsDir: string;
  /** The skeleton document this unit is rigged to, already loaded and validated. */
  readonly skeletonRef: string;
  readonly skeletonDoc: unknown;
  readonly clipLibId: string;
  /** Read off the .glb by the caller. Absent means no cliplib is written. */
  readonly clips?: readonly Clip[] | undefined;
  /** Absent means no unitdef is written -- a unit with no states is not a unit. */
  readonly stateMachine?: StateMachine | undefined;
  readonly maxTimeScale: number;
  /**
   * The measured factor bringing this mesh to the skeleton's canonical height
   * (spec 115).
   *
   * Absent means "not measured", and the document then records 1 -- which is
   * honest and useless, since a generated rig arrives around 1.7 units tall in a
   * world whose bodies are 55.65. The caller measures it off the rigged `.glb`
   * with `meshHeight`; it is not computed here because this file does not read
   * binaries.
   */
  readonly importScale?: number | undefined;
  readonly nowIso: string;
}

export interface ExportResult {
  readonly unitDir: string;
  /** Repo-relative paths of everything written. */
  readonly written: readonly string[];
  /** What could not be written yet, and why, in words a person can act on. */
  readonly pending: readonly string[];
  readonly issues: readonly Issue[];
  readonly ok: boolean;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** The family's root bone, from the document that describes the family. */
function rootChainOf(skeletonDoc: unknown): string | null {
  const parsed = validateSkeleton(skeletonDoc).value;
  return parsed?.bones.find((bone) => bone.parent === null)?.name ?? null;
}

/**
 * A clip with its root translation removed, and the names of what went.
 *
 * The chain is resolved against the *clip's own* node tree rather than the
 * skeleton document, because the node carrying the travel is usually not a bone
 * at all -- `Root` under an `Armature`, neither of them skinned.
 */
function bakeClip(source: string, rootBone: string | null): { bytes: Uint8Array; removed: readonly string[] } {
  const bytes = new Uint8Array(readFileSync(source));
  if (rootBone === null) return { bytes, removed: [] };

  // A file this cannot read is copied through untouched. Refusing here would
  // turn "we could not parse one clip" into "the export produced nothing",
  // which is the wrong trade: the bake and the validator read these files too
  // and both say far more about *why* than this could.
  let glb;
  let nodes;
  try {
    glb = splitGlb(bytes);
    nodes = readNodeTree(glb);
  } catch {
    return { bytes, removed: [] };
  }

  const chain: string[] = [];
  let at = nodes.find((node) => node.name === rootBone) ?? null;
  for (let guard = nodes.length + 1; at !== null && guard > 0; guard -= 1) {
    if (at.name !== '') chain.push(at.name);
    at = at.parent === null ? null : (nodes[at.parent] ?? null);
  }
  if (chain.length === 0) return { bytes, removed: [] };

  const { json, removed } = withoutRootMotion(glb.json, chain);
  if (removed.length === 0) return { bytes, removed: [] };
  return { bytes: writeGlbContainer(json, glb.bin), removed: [...new Set(removed.map((c) => c.bone))] };
}

/**
 * Copies the job's binaries in and writes whatever documents it has the facts
 * for.
 *
 * The `.glb` files are copied rather than moved: the job's directory stays the
 * record of what was generated, and an export that went wrong should not have
 * consumed the only copy of something that was paid for.
 */
export function exportJob(request: ExportRequest): ExportResult {
  const { job, unitsDir, skeletonRef, skeletonDoc, clipLibId, clips, stateMachine, maxTimeScale, importScale, nowIso } =
    request;

  const unitDir = join(unitsDir, job.unitId);
  ensureDir(unitDir);

  /**
   * The skeleton reference as written *inside* the documents.
   *
   * Every ref in this format resolves against the directory of the document
   * holding it, which is right and is what makes a unit directory portable. But
   * the family's skeleton is shared by every unit of the family, so it lives at
   * the units root rather than inside any one of them -- and a bare
   * `biped.skeleton.json` written into `assets/units/pig/` therefore resolves to
   * `assets/units/pig/biped.skeleton.json`, which is nowhere.
   *
   * The caller's `skeletonRef` is relative to the units root, so from a unit's
   * own directory it is exactly one level up. Written that way rather than
   * copying the family document into each unit, which would give a shared
   * contract N divergent copies.
   */
  const skeletonRefFromUnit = skeletonRef.includes('/') ? skeletonRef : `../${skeletonRef}`;
  const written: string[] = [];
  const pending: string[] = [];
  const issues: Issue[] = [];
  const rel = (path: string): string => relative(unitsDir, path);

  const copyIn = (source: string | null, name: string): string | null => {
    if (source === null || !existsSync(source)) return null;
    const target = join(unitDir, name);
    copyFileSync(source, target);
    written.push(rel(target));
    return target;
  };

  const meshPath = copyIn(job.artifacts.riggedGlb ?? job.artifacts.meshGlb, `${job.unitId}.glb`);
  if (meshPath === null) {
    return {
      unitDir,
      written,
      pending: ['nothing to export: the job has no mesh on disk'],
      issues: [],
      ok: false,
    };
  }
  // The un-rigged mesh is kept alongside when both exist, because a rig that
  // came back wrong is diagnosed by comparing it against what was rigged.
  if (job.artifacts.riggedGlb !== null && job.artifacts.meshGlb !== null) {
    copyIn(job.artifacts.meshGlb, `${job.unitId}.unrigged.glb`);
  }

  // The root bone and everything above it: those position the body, and their
  // translation is baked out below. Everything under the root -- the pelvis
  // included -- poses the body, and a pelvis that bobs and shifts weight is the
  // animation doing its job, so it stays.
  const rootChain = rootChainOf(skeletonDoc);

  const clipDir = join(unitDir, 'clips');
  const clipSources = new Map<string, string>();
  const strippedClips: string[] = [];
  for (const [intent, source] of Object.entries(job.artifacts.clipGlbs)) {
    if (!existsSync(source)) continue;
    ensureDir(clipDir);
    const target = join(clipDir, basename(source));
    // Baked rather than copied. Stripping at import was always the plan and is
    // not enough on its own: the committed clip still carries the travel, so
    // `validate:units` fails on every generated clip and the asset in the
    // repository is not the thing the game plays.
    const baked = bakeClip(source, rootChain);
    writeFileSync(target, baked.bytes);
    if (baked.removed.length > 0) strippedClips.push(`${intent} (${baked.removed.join(', ')})`);
    clipSources.set(intent, `clips/${basename(source)}`);
    if (!written.includes(rel(target))) written.push(rel(target));
  }
  if (strippedClips.length > 0) {
    pending.push(
      `root motion was baked out of ${strippedClips.length} clip(s) -- ${strippedClips.join('; ')}. ` +
        'The server owns where a body is, so these play in place; the originals in .studio/ are untouched.',
    );
  }

  // --- the clip library -----------------------------------------------------
  let clipLibDoc: ClipLib | null = null;
  if (clips === undefined || clips.length === 0) {
    pending.push(
      'no cliplib.json: a clip needs its real duration, which is read off the .glb. Nothing here will guess one -- a made-up duration would validate and then silently rescale every action timing.',
    );
  } else {
    const doc: ClipLib = {
      $comment: `Generated by Studio export from job ${job.id}.`,
      formatVersion: 1,
      id: clipLibId,
      skeletonRef: skeletonRefFromUnit,
      clips,
    };
    const result = validateClipLib(doc);
    issues.push(...result.issues);
    if (result.value) {
      const path = join(unitDir, `${clipLibId}.cliplib.json`);
      writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      written.push(rel(path));
      clipLibDoc = result.value;
    }
  }

  // --- the unit definition --------------------------------------------------
  if (stateMachine === undefined) {
    pending.push('no unitdef.json: a unit needs a state machine, which is authored in the Preview tab.');
  } else {
    const unitDef: UnitDef = {
      $comment: `Generated by Studio export from job ${job.id}. Provenance below is what was actually charged.`,
      formatVersion: 1,
      id: job.unitId,
      meshRef: `${job.unitId}.glb`,
      skeletonRef: skeletonRefFromUnit,
      clipLibRef: `${clipLibId}.cliplib.json`,
      provenance: {
        tripoTaskIds: {
          imageToModel: job.steps.find((step) => step.stage === 'imageToModel')?.taskId ?? '',
          rigCheck: job.steps.find((step) => step.stage === 'rigCheck')?.taskId ?? '',
          rig: job.steps.find((step) => step.stage === 'rig')?.taskId ?? null,
          // Empty for every unit after the first of its family -- the visible
          // record of the shared-skeleton rule holding.
          retarget: job.establishesRigFamily
            ? job.steps.filter((step) => step.stage === 'retarget' && step.taskId !== null).map((step) => step.taskId ?? '')
            : [],
        },
        modelVersion: job.params.modelVersion,
        faceLimit: job.params.faceLimit,
        referenceImageSha256: job.referenceImageSha256,
        creditsSpent: job.creditsSpent,
        generatedAt: nowIso,
      },
      import: {
        normals: 'flat',
        targetTris: job.params.faceLimit,
        // Measured off the rigged .glb by the caller, never guessed. It falls
        // back to 1 when nothing measured it, which is honest and useless -- the
        // real factor is around thirty, and a unit exported at 1 is a body the
        // size of a coin. Spec 115 is what made the measurement possible.
        scale: importScale ?? 1,
        upAxis: '+Y',
      },
      maxTimeScale,
      stateMachine,
    };

    const result = validateUnitDef(unitDef);
    issues.push(...result.issues);
    if (result.value) {
      const skeletonResult = validateSkeleton(skeletonDoc);
      issues.push(...skeletonResult.issues);
      if (skeletonResult.value && clipLibDoc) {
        issues.push(
          ...validateUnitBundle({ unit: result.value, skeleton: skeletonResult.value, clipLib: clipLibDoc }),
        );
      }
      const path = join(unitDir, `${job.unitId}.unitdef.json`);
      writeFileSync(path, `${JSON.stringify(unitDef, null, 2)}\n`, 'utf8');
      written.push(rel(path));
    }
  }

  return {
    unitDir,
    written,
    pending,
    issues,
    ok: !issues.some((issue) => issue.severity === 'error'),
  };
}
