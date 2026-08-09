/**
 * The structural half of validation (spec 107): the committed JSON Schemas in
 * `schemas/`, compiled and run.
 *
 * The schemas are imported rather than read from disk, for two reasons. They
 * have to work in the browser -- the Studio tab validates a document it is about
 * to write, and there is no filesystem there -- and importing them means a
 * schema that stops parsing fails the typecheck rather than the test run.
 *
 * `additionalProperties: false` throughout is deliberate and is most of this
 * layer's value: a typo'd key in a hand-edited unitdef is an error with a
 * pointer at it, rather than a field that silently does nothing and a tuning
 * session spent wondering why.
 *
 * What a JSON Schema *cannot* say -- that a `clipRef` resolves, that bones are
 * ordered parent-first, that a clip is not stretched past its bound -- lives in
 * `validate.ts` beside this. Neither half is sufficient alone.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import cliplibSchema from '../../schemas/cliplib.schema.json' with { type: 'json' };
import skeletonSchema from '../../schemas/skeleton.schema.json' with { type: 'json' };
import unitdefSchema from '../../schemas/unitdef.schema.json' with { type: 'json' };
import { error, type Issue } from './issues.js';

export type DocumentKind = 'skeleton' | 'cliplib' | 'unitdef';

export const SCHEMAS: Readonly<Record<DocumentKind, object>> = {
  skeleton: skeletonSchema,
  cliplib: cliplibSchema,
  unitdef: unitdefSchema,
};

/**
 * ajv ships as CommonJS, so what a default import lands on differs between the
 * bundler and Node. Reaching through `.default` when it is there is the standard
 * shim, and doing it once here keeps it out of every call site.
 */
function interop<T>(mod: T): T {
  const maybe = mod as unknown as { default?: T };
  return maybe.default ?? mod;
}

const AjvCtor = interop(Ajv);
const applyFormats = interop(addFormats);

/**
 * Compiled lazily and cached: compilation is the expensive part and the Studio
 * tab revalidates on every keystroke in a timing field.
 */
const compiled = new Map<DocumentKind, ValidateFunction>();

function validatorFor(kind: DocumentKind): ValidateFunction {
  const existing = compiled.get(kind);
  if (existing) return existing;
  // `allErrors` because a report that stops at the first problem turns fixing a
  // hand-written file into one round trip per typo.
  const ajv = new AjvCtor({ allErrors: true, strict: true });
  applyFormats(ajv);
  const fn = ajv.compile(SCHEMAS[kind]);
  compiled.set(kind, fn);
  return fn;
}

/** Compiles every schema, so a malformed one is a test failure and not a surprise. */
export function compileAllSchemas(): void {
  for (const kind of Object.keys(SCHEMAS) as DocumentKind[]) validatorFor(kind);
}

function messageFor(kind: DocumentKind, err: ErrorObject): string {
  // ajv words `additionalProperties` as "must NOT have additional properties",
  // which does not say *which* one. The offending key is in `params`, and
  // naming it is the difference between a useful error and a scavenger hunt.
  if (err.keyword === 'additionalProperties') {
    const extra = (err.params as { additionalProperty?: string }).additionalProperty;
    return `unknown field ${extra === undefined ? '' : `"${extra}" `}in ${kind} document`;
  }
  if (err.keyword === 'required') {
    const missing = (err.params as { missingProperty?: string }).missingProperty;
    return `missing required field "${missing ?? '?'}"`;
  }
  return err.message ?? 'failed schema validation';
}

/**
 * Runs `doc` against the committed schema for `kind`.
 *
 * Every issue is an error: there is no such thing as a structurally
 * half-acceptable document, and a warning here would mean a reader downstream
 * had to cope with a shape the types say cannot happen.
 */
export function validateAgainstSchema(kind: DocumentKind, doc: unknown): readonly Issue[] {
  const validate = validatorFor(kind);
  if (validate(doc)) return [];
  return (validate.errors ?? []).map((err) =>
    // `instancePath` is already an RFC 6901 pointer, which is exactly what an
    // Issue wants -- no translation, and it lines up with the pointers the
    // semantic layer builds by hand.
    error(`schema.${err.keyword}`, err.instancePath, messageFor(kind, err)),
  );
}
