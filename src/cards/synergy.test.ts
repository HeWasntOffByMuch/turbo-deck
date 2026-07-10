import { describe, expect, it } from 'vitest';
import type { SpellSpec } from '../shared/spell-spec.js';
import { empowerSpecs, resolveSynergies, type SpellCardPlay } from './synergy.js';
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
    expect(resolveSynergies(plays('attack'))).toEqual([{ kind: 'cone', range: 72, arcCosSq: 0.5, damage: 12, interrupt: true }]);
  });

  it('fuses two Fire Blasts into a longer, wider, harder cone', () => {
    const one = first(resolveSynergies(plays('fireBlast')));
    const two = first(resolveSynergies(plays('fireBlast', 'fireBlast')));
    if (one.kind !== 'cone' || two.kind !== 'cone') throw new Error('expected cones');
    expect(two.range).toBeGreaterThan(one.range);
    expect(two.arcCosSq).toBeLessThan(one.arcCosSq); // lower cos^2 = wider cone
    expect(two.damage).toBeGreaterThan(one.damage);
  });

  it('keeps two Blaze Auras an aura — just bigger and hotter (spec 022)', () => {
    const one = first(resolveSynergies(plays('blazeAura')));
    const two = first(resolveSynergies(plays('blazeAura', 'blazeAura')));
    if (one.kind !== 'aura' || two.kind !== 'aura') throw new Error('expected auras');
    expect(two.radius).toBeGreaterThan(one.radius);
    expect(two.pulseDamage).toBeGreaterThan(one.pulseDamage);
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
    expect(resolveSynergies(plays('attack'))).toEqual([{ kind: 'cone', range: 72, arcCosSq: 0.5, damage: 12, interrupt: true }]);
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
    // fused base 50, upgrades = (2-1)+(3-1) = 3 => x(1 + 0.4*3) = x2.2
    expect(spec.damage).toBe(Math.round(50 * 2.2));
  });
});

describe('adrenaline empower (spec 023)', () => {
  it('scales damage by +20% per point and leaves geometry alone', () => {
    const base = first(resolveSynergies(plays('fireBlast', 'fireBlast'))); // fused cone, damage 50
    if (base.kind !== 'cone') throw new Error('expected cone');
    const [empowered] = empowerSpecs([base], 3);
    if (!empowered || empowered.kind !== 'cone') throw new Error('expected cone');
    expect(empowered.damage).toBe(Math.round(base.damage * (1 + 0.2 * 3))); // +60%
    expect(empowered.range).toBe(base.range); // geometry untouched
    expect(empowered.arcCosSq).toBe(base.arcCosSq);
  });

  it('is a no-op at zero adrenaline', () => {
    const specs = resolveSynergies(plays('fireBlast', 'fireBlast'));
    expect(empowerSpecs(specs, 0)).toEqual(specs);
  });

  it('doubles a full bank of five', () => {
    const base = first(resolveSynergies(plays('fireBlast', 'fireBlast')));
    if (base.kind !== 'cone') throw new Error('expected cone');
    const [empowered] = empowerSpecs([base], 5);
    if (!empowered || empowered.kind !== 'cone') throw new Error('expected cone');
    expect(empowered.damage).toBe(Math.round(base.damage * 2)); // 1 + 0.2*5 = 2
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

  it('Burning Speed scales haste 30/42/45% and foe burn 3/8/9s by copies', () => {
    const one = first(resolveSynergies(plays('burningSpeed')));
    const two = first(resolveSynergies(plays('burningSpeed', 'burningSpeed')));
    const three = first(resolveSynergies(plays('burningSpeed', 'burningSpeed', 'burningSpeed')));
    if (one.kind !== 'burningSpeed' || two.kind !== 'burningSpeed' || three.kind !== 'burningSpeed') throw new Error('expected burningSpeed');
    expect([one.hasteMult, two.hasteMult, three.hasteMult]).toEqual([1.3, 1.42, 1.45]);
    expect([one.foeBurnDurationTicks, two.foeBurnDurationTicks, three.foeBurnDurationTicks]).toEqual([180, 480, 540]);
    expect(one.selfBurnDps).toBe(4);
  });
});
