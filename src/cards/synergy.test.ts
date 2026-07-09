import { describe, expect, it } from 'vitest';
import type { SpellSpec } from '../shared/spell-spec.js';
import { resolveSynergies } from './synergy.js';

/** Narrow the first resolved spec or fail loudly. */
function first(specs: SpellSpec[]): SpellSpec {
  const spec = specs[0];
  if (!spec) throw new Error('expected at least one spec');
  return spec;
}

describe('resolveSynergies', () => {
  it('resolves a lone card to its base spec', () => {
    expect(resolveSynergies(['attack'])).toEqual([{ kind: 'cone', range: 72, arcCosSq: 0.5, damage: 12 }]);
  });

  it('fuses two identical cards into the stronger tier', () => {
    const spec = first(resolveSynergies(['fireBlast', 'fireBlast']));
    expect(spec.kind).toBe('cone');
    if (spec.kind === 'cone') expect(spec.damage).toBe(34); // > the base 16
  });

  it('turns two blaze auras into three explosions at the player', () => {
    const spec = first(resolveSynergies(['blazeAura', 'blazeAura']));
    expect(spec).toMatchObject({ kind: 'pointAoe', origin: 'player', count: 3 });
  });

  it('makes three dashes deal damage where one does not', () => {
    const one = first(resolveSynergies(['dash']));
    const three = first(resolveSynergies(['dash', 'dash', 'dash']));
    if (one.kind !== 'dash' || three.kind !== 'dash') throw new Error('expected dash specs');
    expect(one.damage).toBe(0);
    expect(three.damage).toBeGreaterThan(0);
    expect(three.distance).toBeGreaterThan(one.distance);
  });

  it('emits one spec per distinct card for a mixed window', () => {
    const specs = resolveSynergies(['attack', 'dash']);
    expect(specs).toHaveLength(2);
    expect(specs.map((s) => s.kind)).toEqual(['cone', 'dash']);
  });

  it('is independent of the order copies were played', () => {
    const a = resolveSynergies(['attack', 'dash', 'attack']);
    const b = resolveSynergies(['attack', 'attack', 'dash']);
    expect(a).toEqual(b);
    // grouped: attack x2 (fused) then dash x1
    const cone = first(a);
    if (cone.kind !== 'cone') throw new Error('expected cone');
    expect(cone.damage).toBe(26);
  });

  it('clamps counts above the highest tier', () => {
    // A fourth dash is no stronger than the three-dash fusion.
    expect(resolveSynergies(['dash', 'dash', 'dash', 'dash'])).toEqual(resolveSynergies(['dash', 'dash', 'dash']));
    // A third attack is still the two-copy fusion (attack has no third tier).
    expect(resolveSynergies(['attack', 'attack', 'attack'])).toEqual(resolveSynergies(['attack', 'attack']));
  });
});
