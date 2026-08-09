/**
 * Getting a family's skeleton document, one way or another (spec 115).
 *
 * Export needs one and would not proceed without it, which meant a brand-new rig
 * family could not be exported at all: the route looked for
 * `assets/units/<family>.skeleton.json`, did not find one, and refused. The only
 * way past was to hand-write a document describing a rig nobody had measured --
 * which is exactly what `biped.skeleton.json` is, provisional since spec 107 and
 * carrying a comment promising that the first real rig would fill it in. Nothing
 * could. There was no code that could read a rig.
 *
 * Now there is, so this is the promise kept. Three cases, and the third is the
 * one that matters:
 *
 *  - **No document.** Measure the rig and write one. A new family costs nothing
 *    extra and needs no hand-authoring.
 *  - **A provisional document** (`bindPose: null`). Fill it in from the measured
 *    rig, keeping everything already decided -- the comment, the canonical
 *    height, the bone budget, the sockets. The contract was written down by a
 *    person; only the measurement was missing.
 *  - **A measured document.** Never overwritten, and the new rig is *checked
 *    against* it. This is the shared-skeleton rule as a fact rather than a hope:
 *    unit two of a family reuses unit one's clips, so unit two arriving with a
 *    different bone list is not a variation, it is a clip set about to drive
 *    bones that are not there.
 *
 * Node-only, because it reads and writes files. The deciding is all in
 * `src/units/skeleton-from-rig.ts`, which is pure.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { meshHeight, splitGlb } from '../../units/glb-read.js';
import { formatIssue, hasErrors } from '../../units/issues.js';
import { compareToFamily, skeletonFromRig } from '../../units/skeleton-from-rig.js';
import { validateSkeleton } from '../../units/validate.js';
import type { Skeleton } from '../../units/types.js';
import type { Job } from './types.js';

export interface FamilyRequest {
  readonly job: Job;
  readonly unitsDir: string;
  /** Relative to `assets/units/`, e.g. `biped2.skeleton.json`. */
  readonly skeletonRef: string;
  readonly canonicalHeight: number;
}

export interface FamilyResult {
  /** The document export should validate against, or null when there is none. */
  readonly doc: Skeleton | null;
  /** The path written, relative to `assets/units/`, or null if nothing was. */
  readonly wrote: string | null;
  /** Why there is no document, in words a person can act on. */
  readonly problem: string | null;
  /**
   * What brings this mesh to the family's canonical height, or undefined when
   * there was no rig to measure.
   *
   * Measured here because this is the one place that already has both halves of
   * the division open: the family's canonical height and the rigged `.glb`.
   */
  readonly importScale?: number | undefined;
}

/** The factor, or undefined when either side of the division is missing. */
function scaleFor(rigPath: string | null, canonicalHeight: number): number | undefined {
  if (rigPath === null || !existsSync(rigPath)) return undefined;
  const height = meshHeight(splitGlb(new Uint8Array(readFileSync(rigPath))));
  return height > 0 ? canonicalHeight / height : undefined;
}

export function resolveFamilySkeleton(request: FamilyRequest): FamilyResult {
  const { job, unitsDir, skeletonRef, canonicalHeight } = request;
  const path = join(unitsDir, skeletonRef);

  const existing = existsSync(path) ? validateSkeleton(JSON.parse(readFileSync(path, 'utf8')) as unknown) : null;
  if (existing && existing.value === null) {
    return {
      doc: null,
      wrote: null,
      problem:
        `assets/units/${skeletonRef} does not validate, so nothing can be exported against it: ` +
        existing.issues.map(formatIssue).join('; '),
    };
  }
  const established = existing?.value ?? null;

  // A measured document is the contract. Handed straight back, unread rig or
  // not -- but the rig is read anyway, below, to say whether it fits.
  const rigPath = job.artifacts.riggedGlb;
  if (established !== null && established.bindPose !== null) {
    const check = rigPath === null ? null : compare(rigPath, established, canonicalHeight, skeletonRef);
    if (check !== null) return check;
    return {
      doc: established,
      wrote: null,
      problem: null,
      importScale: scaleFor(rigPath, established.canonicalHeight),
    };
  }

  if (rigPath === null || !existsSync(rigPath)) {
    return {
      doc: null,
      wrote: null,
      problem:
        `there is no measured skeleton at assets/units/${skeletonRef} and this job has no rigged .glb to measure ` +
        'one from. Export a job that completed the rig stage, or write the document by hand.',
    };
  }

  const derived = skeletonFromRig(splitGlb(new Uint8Array(readFileSync(rigPath))), {
    id: established?.id ?? job.skeletonId,
    source: `${job.unitId}.glb`,
    // Everything already decided is kept. A provisional document is a decision
    // missing a measurement, not a placeholder to be replaced.
    canonicalHeight: established?.canonicalHeight ?? canonicalHeight,
    ...(established?.boneBudget === undefined ? {} : { boneBudget: established.boneBudget }),
    ...(established?.sockets === undefined ? {} : { sockets: established.sockets }),
    comment:
      established?.$comment ??
      `The ${job.skeletonId} rig family, measured from job ${job.id}'s rig. Written by the Studio export ` +
        '(spec 115); regenerating a unit does not rewrite it, because the family contract is fixed once measured.',
  });

  if (derived.skeleton === null || hasErrors(derived.issues)) {
    return {
      doc: null,
      wrote: null,
      problem: `could not measure a skeleton off this job's rig: ${derived.issues.map(formatIssue).join('; ')}`,
    };
  }

  const validated = validateSkeleton(derived.skeleton);
  if (validated.value === null) {
    return {
      doc: null,
      wrote: null,
      problem:
        `the skeleton measured off this rig does not validate, so it is not written: ` +
        validated.issues.map(formatIssue).join('; '),
    };
  }

  writeFileSync(path, `${JSON.stringify(derived.skeleton, null, 2)}\n`, 'utf8');
  return {
    doc: validated.value,
    wrote: skeletonRef,
    problem: null,
    importScale: derived.measuredHeight > 0 ? scaleFor(rigPath, validated.value.canonicalHeight) : undefined,
  };
}

/** Null when the rig fits the family, a refusal when it does not. */
function compare(
  rigPath: string,
  established: Skeleton,
  canonicalHeight: number,
  skeletonRef: string,
): FamilyResult | null {
  if (!existsSync(rigPath)) return null;
  const derived = skeletonFromRig(splitGlb(new Uint8Array(readFileSync(rigPath))), {
    id: established.id,
    source: 'comparison',
    canonicalHeight,
  });
  if (derived.skeleton === null) return null;

  const issues = compareToFamily(established, derived.skeleton);
  if (!hasErrors(issues)) return null;
  return {
    doc: null,
    wrote: null,
    problem:
      `this rig does not match the "${established.id}" family recorded in assets/units/${skeletonRef}, and the ` +
      `family's clips are what this unit would be animated with: ${issues.map(formatIssue).join('; ')}`,
  };
}
