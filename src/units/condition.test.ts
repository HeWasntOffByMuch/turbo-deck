import { describe, expect, it } from 'vitest';
import { conditionParameter, parseCondition } from './condition.js';

describe('parseCondition', () => {
  it('reads the exit condition', () => {
    expect(parseCondition('exit')).toEqual({ kind: 'exit' });
    expect(conditionParameter(parseCondition('exit'))).toBeNull();
  });

  it('reads a bare parameter as a flag', () => {
    expect(parseCondition('attack')).toEqual({ kind: 'flag', parameter: 'attack', negated: false });
    expect(parseCondition('!grounded')).toEqual({ kind: 'flag', parameter: 'grounded', negated: true });
  });

  it('reads a comparison, with or without spaces', () => {
    expect(parseCondition('speed >= 34')).toEqual({ kind: 'compare', parameter: 'speed', op: '>=', value: 34 });
    expect(parseCondition('speed>=34')).toEqual({ kind: 'compare', parameter: 'speed', op: '>=', value: 34 });
  });

  it('reads every comparison operator', () => {
    for (const op of ['>', '<', '>=', '<=', '==', '!='] as const) {
      expect(parseCondition(`speed ${op} 1`)).toEqual({ kind: 'compare', parameter: 'speed', op, value: 1 });
    }
  });

  it('reads negative and fractional literals', () => {
    expect(parseCondition('lean < -0.5')).toMatchObject({ value: -0.5 });
    expect(parseCondition('lean > .25')).toMatchObject({ value: 0.25 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseCondition('  exit  ')).toEqual({ kind: 'exit' });
  });

  it('does not read `>=` as `>` followed by junk', () => {
    // `>` is listed after `>=` in the alternation for exactly this reason; the
    // other order silently turns "speed >= 34" into "speed > =34" and fails on
    // the literal instead of parsing it wrong, which is nearly as bad.
    expect(parseCondition('speed >= 34')).toMatchObject({ op: '>=' });
    expect(parseCondition('speed <= 34')).toMatchObject({ op: '<=' });
  });

  it('rejects what it cannot render in a node graph', () => {
    for (const text of ['', '   ', 'speed > ', '> 34', 'speed && grounded', 'speed > abc', '1speed > 2']) {
      expect(parseCondition(text).kind).toBe('invalid');
    }
  });

  it('names the parameter a condition reads', () => {
    expect(conditionParameter(parseCondition('speed > 5'))).toBe('speed');
    expect(conditionParameter(parseCondition('!grounded'))).toBe('grounded');
    expect(conditionParameter(parseCondition('nonsense &&'))).toBeNull();
  });
});
