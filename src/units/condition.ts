/**
 * A transition's condition, parsed (spec 107).
 *
 * Deliberately a tiny grammar rather than an expression language. Three forms
 * cover what a transition actually needs, and every one of them can be shown in
 * a node graph as a single readable label:
 *
 *   exit              the source state finished
 *   moving            a bool or trigger parameter is set
 *   !moving           ...or is not
 *   speed >= 34       a float or int parameter against a literal
 *
 * The reason it stops there is that a condition nobody can render is a condition
 * the Studio tab's graph has to fall back to showing as raw text, and an
 * authoring format whose main surface cannot display half its own documents is
 * not finished. Anything needing `&&` should be two transitions or a parameter
 * the game sets.
 *
 * Parsing lives here rather than in the validator because the runtime evaluates
 * the same strings: one grammar, one parser, so a condition that validates
 * cannot fail to evaluate.
 */

export type ComparisonOp = '>' | '<' | '>=' | '<=' | '==' | '!=';

export type Condition =
  | { readonly kind: 'exit' }
  | { readonly kind: 'flag'; readonly parameter: string; readonly negated: boolean }
  | {
      readonly kind: 'compare';
      readonly parameter: string;
      readonly op: ComparisonOp;
      readonly value: number;
    }
  | { readonly kind: 'invalid'; readonly reason: string };

const FLAG = /^(!?)([a-zA-Z][a-zA-Z0-9_.-]*)$/;
const COMPARE = /^([a-zA-Z][a-zA-Z0-9_.-]*)\s*(>=|<=|==|!=|>|<)\s*(-?(?:\d+\.?\d*|\.\d+))$/;

export function parseCondition(condition: string): Condition {
  const text = condition.trim();
  if (text === '') return { kind: 'invalid', reason: 'empty condition' };
  if (text === 'exit') return { kind: 'exit' };

  const compare = COMPARE.exec(text);
  if (compare) {
    const [, parameter, op, literal] = compare;
    // Every group is present when the regex matched; the guards are here because
    // the compiler cannot know that, and throwing would be worse than reporting.
    if (parameter === undefined || op === undefined || literal === undefined) {
      return { kind: 'invalid', reason: 'malformed comparison' };
    }
    const value = Number(literal);
    if (!Number.isFinite(value)) {
      return { kind: 'invalid', reason: `"${literal}" is not a finite number` };
    }
    return { kind: 'compare', parameter, op: op as ComparisonOp, value };
  }

  const flag = FLAG.exec(text);
  if (flag) {
    const [, bang, parameter] = flag;
    if (parameter === undefined) return { kind: 'invalid', reason: 'malformed condition' };
    return { kind: 'flag', parameter, negated: bang === '!' };
  }

  return {
    kind: 'invalid',
    reason: `expected "exit", a parameter name, "!name", or "name <op> number"`,
  };
}

/** The parameter a condition reads, or null for `exit` and for a broken one. */
export function conditionParameter(condition: Condition): string | null {
  return condition.kind === 'flag' || condition.kind === 'compare' ? condition.parameter : null;
}
