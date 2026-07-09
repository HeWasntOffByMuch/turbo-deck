import { describe, expect, it } from 'vitest';
import type { SpellSpec } from '../shared/spell-spec.js';
import { resolveSynergies, type SpellCardPlay } from './synergy.js';
import type { SpellId } from './spells.js';

/** Level-1 plays from a list of ids. */
function plays(...ids: SpellId[]): SpellCardPlay[] {
  return ids.map((id) => ({ id, level: 1 }));
}

/** Narrow the first resolved spec or fail loudly. */
function first(specs: SpellSpec[]): SpellSpec {
  const spec = specs[0];
  if (!spec) throw new Error('expected at least one spec');
  return spec;
}

describe('resolveSynergies', () => {
  it('resolves a lone card to its base spec', () => {
    expect(resolveSynergies(plays('attack'))).toEqual([{ kind: 'cone', range: 72, arcCosSq: 0.5, damage: 12 }]);
  });

  it('fuses two identical cards into the stronger tier', () => {
    const spec = first(resolveSynergies(plays('fireBlast', 'fireBlast')));
    expect(spec.kind).toBe('cone');
    if (spec.kind === 'cone') expect(spec.damage).toBe(34); // > the base 16
  });

  it('turns two blaze auras into three explosions at the player', () => {
    const spec = first(resolveSynergies(plays('blazeAura', 'blazeAura')));
    expect(spec).toMatchObject({ kind: 'pointAoe', origin: 'player', count: 3 });
  });

  it('makes three dashes deal damage where one does not', () => {
    const one = first(resolveSynergies(plays('dash')));
    const three = first(resolveSynergies(plays('dash', 'dash', 'dash')));
    if (one.kind !== 'dash' || three.kind !== 'dash') throw new Error('expected dash specs');
    expect(one.damage).toBe(0);
    expect(three.damage).toBeGreaterThan(0);
    expect(three.distance).toBeGreaterThan(one.distance);
  });

  it('emits one spec per distinct card for a mixed window', () => {
    const specs = resolveSynergies(plays('attack', 'dash'));
    expect(specs).toHaveLength(2);
    expect(specs.map((s) => s.kind)).toEqual(['cone', 'dash']);
  });

  it('is independent of the order copies were played', () => {
    const a = resolveSynergies(plays('attack', 'dash', 'attack'));
    const b = resolveSynergies(plays('attack', 'attack', 'dash'));
    expect(a).toEqual(b);
    const cone = first(a);
    if (cone.kind !== 'cone') throw new Error('expected cone');
    expect(cone.damage).toBe(26);
  });

  it('clamps counts above the highest tier', () => {
    expect(resolveSynergies(plays('dash', 'dash', 'dash', 'dash'))).toEqual(resolveSynergies(plays('dash', 'dash', 'dash')));
    expect(resolveSynergies(plays('attack', 'attack', 'attack'))).toEqual(resolveSynergies(plays('attack', 'attack')));
  });
});

describe('upgrade levels (spec 019)', () => {
  it('leaves all-level-1 output identical to the 018 numbers', () => {
    expect(resolveSynergies(plays('attack'))).toEqual([{ kind: 'cone', range: 72, arcCosSq: 0.5, damage: 12 }]);
  });

  it('scales a group\'s damage by its total upgrades', () => {
    const spec = first(resolveSynergies([{ id: 'attack', level: 2 }]));
    if (spec.kind !== 'cone') throw new Error('expected cone');
    expect(spec.damage).toBe(Math.round(12 * 1.4)); // one upgrade => +40%
    expect(spec.range).toBe(72); // geometry unchanged
  });

  it('sums upgrades across copies in the same group', () => {
    const spec = first(resolveSynergies([
      { id: 'fireBlast', level: 2 },
      { id: 'fireBlast', level: 3 },
    ]));
    if (spec.kind !== 'cone') throw new Error('expected cone');
    // fused base 34, upgrades = (2-1)+(3-1) = 3 => x(1 + 0.4*3) = x2.2
    expect(spec.damage).toBe(Math.round(34 * 2.2));
  });
});

describe('new fire cards (spec 019)', () => {
  it('Basking Path is a dash that leaves a fire trail', () => {
    const spec = first(resolveSynergies(plays('baskingPath')));
    if (spec.kind !== 'dash') throw new Error('expected dash');
    expect(spec.trailPulseDamage).toBeGreaterThan(0);
    expect(spec.trailDurationTicks).toBeGreaterThan(0);
  });

  it('Conjure Flame arms cone casts with bonus damage', () => {
    const spec = first(resolveSynergies(plays('conjureFlame')));
    expect(spec).toMatchObject({ kind: 'empower', charges: 3 });
  });

  it('Fire Storm centres on the nearest foe to the cursor', () => {
    const spec = first(resolveSynergies(plays('fireStorm')));
    expect(spec).toMatchObject({ kind: 'pointAoe', origin: 'nearestEnemyToTarget' });
  });
});
