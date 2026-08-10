import { describe, expect, it } from 'vitest';
import { blowSeed, effectsForBlow, type CombatFacts } from './vfx-wire.js';

function facts(overrides: Partial<CombatFacts> = {}): CombatFacts {
  return {
    attackerId: 1,
    targetId: 2,
    damage: 10,
    killed: false,
    critical: false,
    blocked: false,
    damageType: 'physical',
    x: 100,
    y: 20,
    z: 200,
    fromX: 60,
    fromZ: 200,
    bleeds: true,
    ...overrides,
  };
}

describe('effectsForBlow', () => {
  it('draws blood from something that bleeds', () => {
    const played = effectsForBlow(facts(), 500);
    expect(played.map((request) => request.id)).toEqual(['hit_blood']);
  });

  it('draws the death effect on a killing blow', () => {
    expect(effectsForBlow(facts({ killed: true }), 500)[0]?.id).toBe('death_blood');
  });

  it('draws sparks off something that does not bleed', () => {
    const played = effectsForBlow(facts({ bleeds: false }), 500);
    expect(played.map((request) => request.id)).toEqual(['hit_metal_spark']);
  });

  it('draws sparks and no blood off a block', () => {
    // A blow that was stopped did not open anything.
    const played = effectsForBlow(facts({ blocked: true }), 500);
    expect(played.map((request) => request.id)).toEqual(['hit_metal_spark']);
  });

  it('never plays more than two effects for one blow', () => {
    for (const blocked of [false, true]) {
      for (const bleeds of [false, true]) {
        for (const killed of [false, true]) {
          expect(effectsForBlow(facts({ blocked, bleeds, killed }), 1).length).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('throws the spray away from the attacker', () => {
    // The property the whole directional splat exists for.
    const fromLeft = effectsForBlow(facts({ fromX: 0, fromZ: 200, x: 100, z: 200 }), 1)[0];
    expect(Math.cos(fromLeft?.rotation ?? 0)).toBeCloseTo(1, 5);

    const fromRight = effectsForBlow(facts({ fromX: 200, fromZ: 200, x: 100, z: 200 }), 1)[0];
    expect(Math.cos(fromRight?.rotation ?? 0)).toBeCloseTo(-1, 5);

    const fromBehind = effectsForBlow(facts({ fromX: 100, fromZ: 0, x: 100, z: 200 }), 1)[0];
    expect(Math.sin(fromBehind?.rotation ?? 0)).toBeCloseTo(1, 5);
  });

  it('picks a bearing rather than NaN when the two are stacked', () => {
    const played = effectsForBlow(facts({ fromX: 100, fromZ: 200, x: 100, z: 200 }), 1)[0];
    expect(Number.isFinite(played?.rotation ?? Number.NaN)).toBe(true);
  });

  it('makes a critical louder in the same language, not different', () => {
    const plain = effectsForBlow(facts(), 1)[0];
    const critical = effectsForBlow(facts({ critical: true }), 1)[0];
    expect(critical?.id).toBe(plain?.id);
    expect(critical?.scale ?? 0).toBeGreaterThan(plain?.scale ?? 0);
  });

  it('makes a block smaller', () => {
    const blocked = effectsForBlow(facts({ blocked: true }), 1)[0];
    const open = effectsForBlow(facts({ bleeds: false }), 1)[0];
    expect(blocked?.scale ?? 0).toBeLessThan(open?.scale ?? 0);
  });

  it('gives the two effects of one blow different seeds', () => {
    // Otherwise the spark and the blood draw the same numbers and land in
    // exactly the same pattern, which reads as one effect drawn twice.
    const played = effectsForBlow(facts({ blocked: true, bleeds: true }), 1);
    const seeds = new Set(played.map((request) => request.seed));
    expect(seeds.size).toBe(played.length);
  });
});

describe('blowSeed', () => {
  it('is a function of where and when, not of the client', () => {
    // The stains persist, so a locally-drawn seed would give two players
    // permanently different ground.
    const a = blowSeed(facts(), 900);
    const b = blowSeed(facts(), 900);
    expect(a).toBe(b);
  });

  it('differs for two blows in the same place at different times', () => {
    expect(blowSeed(facts(), 900)).not.toBe(blowSeed(facts(), 901));
  });

  it('differs for two blows at the same time in different places', () => {
    expect(blowSeed(facts({ x: 100 }), 900)).not.toBe(blowSeed(facts({ x: 400 }), 900));
  });

  it('differs for two targets hit at once by a blast', () => {
    expect(blowSeed(facts({ targetId: 2 }), 900)).not.toBe(blowSeed(facts({ targetId: 3 }), 900));
  });

  it('stays a 32-bit integer', () => {
    for (let tick = 0; tick < 200; tick++) {
      const seed = blowSeed(facts({ x: tick * 977, z: tick * 131 }), tick);
      expect(Number.isInteger(seed)).toBe(true);
      expect(Math.abs(seed)).toBeLessThanOrEqual(2 ** 31);
    }
  });
});
