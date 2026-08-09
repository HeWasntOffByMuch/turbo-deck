/**
 * Reading and writing the authored documents (spec 110).
 *
 * "Everything editable in this tab writes back to the JSON files through the
 * server. No hidden state that exists only in the browser session." This is that
 * road, and it has two rules.
 *
 * **Nothing is written that would not validate.** A dragged event marker or a
 * retuned wind-up goes through the spec 107 validator before it touches the
 * disk, so the tab cannot produce a file CI would reject -- and the failure
 * comes back as issues with JSON pointers rather than as a red build later.
 *
 * **The write is atomic.** Temp file, then rename, exactly as the job queue does
 * it. A crash mid-save on a tuning session leaves the previous document intact
 * rather than a truncated one, and a truncated unitdef is a unit that will not
 * load at all.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { validateClipLib, validateSkeleton, validateUnitDef } from '../../units/validate.js';
import type { Issue } from '../../units/index.js';

export type DocumentKind = 'skeleton' | 'cliplib' | 'unitdef';

export interface DocumentResult {
  readonly ok: boolean;
  readonly path: string;
  readonly issues: readonly Issue[];
}

/**
 * Resolves a request's path inside the units directory, or null.
 *
 * `..` is not filtered out of the string -- it is resolved and then the result
 * is checked to still be under the root, which is the only version of this check
 * that cannot be walked around with encoding tricks.
 */
export function resolveInside(unitsDir: string, requested: string): string | null {
  const root = resolve(unitsDir);
  const full = resolve(root, requested);
  if (full !== root && !full.startsWith(root + sep)) return null;
  if (!full.endsWith('.json')) return null;
  return full;
}

export function kindOfPath(path: string): DocumentKind | null {
  if (path.endsWith('.skeleton.json')) return 'skeleton';
  if (path.endsWith('.cliplib.json')) return 'cliplib';
  if (path.endsWith('.unitdef.json')) return 'unitdef';
  return null;
}

export function readDocument(unitsDir: string, requested: string): { doc: unknown } | { error: string } {
  const full = resolveInside(unitsDir, requested);
  if (full === null) return { error: 'that path is not a document under assets/units' };
  if (!existsSync(full)) return { error: `no document at assets/units/${requested}` };
  try {
    return { doc: JSON.parse(readFileSync(full, 'utf8')) as unknown };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function validate(kind: DocumentKind, doc: unknown): readonly Issue[] {
  switch (kind) {
    case 'skeleton':
      return validateSkeleton(doc).issues;
    case 'cliplib':
      return validateClipLib(doc).issues;
    case 'unitdef':
      return validateUnitDef(doc).issues;
  }
}

/**
 * Validates, then writes.
 *
 * In that order and never the other way round: a document written first and
 * checked second is a document that is already on disk when the check fails,
 * and the next reader gets the broken one.
 */
export function writeDocument(unitsDir: string, requested: string, doc: unknown): DocumentResult {
  const full = resolveInside(unitsDir, requested);
  if (full === null) {
    return {
      ok: false,
      path: requested,
      issues: [
        { severity: 'error', code: 'document.path', path: '', message: 'that path is not a document under assets/units' },
      ],
    };
  }
  const kind = kindOfPath(requested);
  if (kind === null) {
    return {
      ok: false,
      path: requested,
      issues: [
        {
          severity: 'error',
          code: 'document.kind',
          path: '',
          message: 'name it .skeleton.json, .cliplib.json or .unitdef.json so it can be validated',
        },
      ],
    };
  }

  const issues = validate(kind, doc);
  if (issues.some((issue) => issue.severity === 'error')) {
    return { ok: false, path: requested, issues };
  }

  mkdirSync(dirname(full), { recursive: true });
  const temp = `${full}.tmp`;
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  renameSync(temp, full);
  return { ok: true, path: relative(unitsDir, full).split(sep).join('/'), issues };
}

/** Every document under the units directory, as forward-slashed relative paths. */
export function listDocuments(unitsDir: string): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.json')) out.push(relative(unitsDir, full).split(sep).join('/'));
    }
  };
  walk(unitsDir);
  return out;
}
