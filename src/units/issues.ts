/**
 * How a validation failure is reported (spec 107).
 *
 * Two severities, kept apart on purpose. "This rig has finger joints" and "this
 * state names a clip that does not exist" are both worth saying and only one of
 * them may fail a build -- collapsing them into one list means either CI goes
 * red over a style note or a broken reference ships as a warning nobody read.
 *
 * Every issue carries a **JSON pointer** into the document it came from, so the
 * Studio tab's pass/fail panel can point at the offending field and a terminal
 * run can be grepped. `code` is a stable machine-readable slug: tests assert on
 * it rather than on wording, so a clearer message is never a test change.
 */

export type Severity = 'error' | 'warning';

export interface Issue {
  readonly severity: Severity;
  /** Stable slug, e.g. `skeleton.parent.forward`. Tests assert on this. */
  readonly code: string;
  /** RFC 6901 JSON pointer into the document, e.g. `/bones/7/parent`. */
  readonly path: string;
  readonly message: string;
}

/**
 * The outcome of validating one document: the typed value when it is
 * structurally sound, plus everything worth saying about it.
 *
 * `value` is null exactly when there is at least one error, so a caller that
 * checks `value` cannot accidentally proceed on a broken document, and a caller
 * that only wants the report does not have to.
 */
export interface Result<T> {
  readonly value: T | null;
  readonly issues: readonly Issue[];
}

export function error(code: string, path: string, message: string): Issue {
  return { severity: 'error', code, path, message };
}

export function warning(code: string, path: string, message: string): Issue {
  return { severity: 'warning', code, path, message };
}

export function errorsOf(issues: readonly Issue[]): readonly Issue[] {
  return issues.filter((issue) => issue.severity === 'error');
}

export function warningsOf(issues: readonly Issue[]): readonly Issue[] {
  return issues.filter((issue) => issue.severity === 'warning');
}

export function hasErrors(issues: readonly Issue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

/**
 * Escapes one path segment into a JSON pointer token.
 *
 * Bone names and clip ids end up in pointers, and RFC 6901 gives `~` and `/`
 * meaning inside a token. Without this a bone called `a/b` would produce a
 * pointer that silently addresses something else.
 */
export function pointerSegment(segment: string | number): string {
  return typeof segment === 'number'
    ? String(segment)
    : segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function pointer(...segments: readonly (string | number)[]): string {
  return segments.length === 0 ? '' : `/${segments.map(pointerSegment).join('/')}`;
}

/** One line per issue, for a terminal run. */
export function formatIssue(issue: Issue): string {
  const where = issue.path === '' ? '<root>' : issue.path;
  return `${issue.severity === 'error' ? 'ERROR' : 'warn '} ${where}  [${issue.code}] ${issue.message}`;
}
