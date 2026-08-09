/**
 * How the studio panel words things (spec 109).
 *
 * Pure, and separate from the view, for one reason that is not tidiness: these
 * are the strings a person reads before deciding to spend money, and a label
 * that says `undefined` or a total that silently drops a "≥" is a real cost.
 * Here they can be asserted.
 *
 * The `Record` types are exhaustive over their unions rather than lookups with
 * a fallback, so adding a `Stage` or a `JobStatus` to spec 108 fails the
 * typecheck here instead of rendering as a blank cell.
 */

import type { JobStatus, Stage } from '../../../server/studio/types.js';

export const STAGE_LABELS: Readonly<Record<Stage, string>> = {
  imageToModel: 'Generate mesh',
  rigCheck: 'Rig check (free)',
  rig: 'Auto-rig',
  retarget: 'Retarget clips',
  download: 'Save files',
};

export const STATUS_LABELS: Readonly<Record<JobStatus, string>> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  blocked: 'Stopped',
  cancelled: 'Cancelled',
};

/**
 * Colours for a status.
 *
 * `blocked` is deliberately not red. Nothing went wrong and nothing was charged
 * -- a ceiling was reached, or the model cannot be rigged -- and painting that
 * the same colour as a failed paid call would make the two look alike in exactly
 * the situation where telling them apart matters.
 */
export const STATUS_COLORS: Readonly<Record<JobStatus, string>> = {
  queued: '#8a8aa0',
  running: '#6fa8dc',
  succeeded: '#7bc47f',
  failed: '#e06c75',
  blocked: '#e5c07b',
  cancelled: '#8a8aa0',
};

/**
 * Credits, with a marker when the API did not price every call.
 *
 * The marker is the point. A total built partly from calls that came back with
 * no `credits_consumed` is a lower bound, and showing it as a plain number would
 * be a confident answer to a question nobody can answer.
 */
export function formatCredits(credits: number, unreportedCalls = 0): string {
  const rounded = Number.isInteger(credits) ? String(credits) : credits.toFixed(2);
  return unreportedCalls > 0 ? `≥ ${rounded}` : rounded;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A short elapsed time, for "this step has been running for a while". */
export function formatDuration(ms: number): string {
  if (ms < 0) return '0s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** An ISO timestamp trimmed to what a person reads. Empty for a bad value. */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * How far a job has got, as a fraction.
 *
 * Counts skipped steps as done, so a unit reusing an established rig family
 * shows a full bar rather than one permanently stuck at four fifths.
 */
export function jobProgress(steps: readonly { readonly status: string }[]): number {
  if (steps.length === 0) return 0;
  const finished = steps.filter((step) => step.status === 'done' || step.status === 'skipped').length;
  return finished / steps.length;
}
