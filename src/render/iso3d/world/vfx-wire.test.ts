import { describe, expect, it } from 'vitest';
import {
  blowSeed,
  CONTACT_LIFT,
  CONTACT_RADIUS,
  DAMAGE_EFFECTS,
  effectsForBlow,
  HEAL_EFFECT,
  REDUNDANT_SERVER_EFFECTS,
  type CombatFacts,
} from './vfx-wire.js';
import { ALL_ABILITIES } from '../../../server/data/abilities.js';

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

describe('the contact point', () => {
  it('lands on the face the attacker is on, not inside the body', () => {
    // The attacker is at x = 60 and the target at x = 100, so the blow arrives
    // travelling +x and the contact is a body radius back along it.
    const played = effectsForBlow(facts(), 500);
    for (const request of played) {
      expect(request.x).toBeCloseTo(100 - CONTACT_RADIUS, 5);
      expect(request.z).toBeCloseTo(200, 5);
    }
  });

  it('follows the blow round, whichever way it came from', () => {
    const played = effectsForBlow(facts({ fromX: 100, fromZ: 260 }), 500);
    const first = played[0];
    expect(first?.x).toBeCloseTo(100, 5);
    expect(first?.z).toBeCloseTo(200 + CONTACT_RADIUS, 5);
  });

  it('lands on a chest rather than a pair of boots', () => {
    expect(effectsForBlow(facts(), 500)[0]?.y).toBeCloseTo(20 + CONTACT_LIFT, 5);
  });

  it('falls back to the target at point blank rather than dividing by nothing', () => {
    // Two bodies stacked, which happens, and a normalize on a zero vector is how
    // a hit ends up at NaN and silently never draws.
    const played = effectsForBlow(facts({ fromX: 100, fromZ: 200 }), 500);
    const first = played[0];
    expect(first?.x).toBe(100);
    expect(first?.z).toBe(200);
    expect(Number.isFinite(first?.rotation ?? NaN)).toBe(true);
  });
});

describe('effectsForBlow', () => {
  it('draws blood from something that bleeds', () => {
    const played = effectsForBlow(facts(), 500);
    expect(played.map((request) => request.id)).toEqual(['hit_blood']);
  });

  it('draws the death effect on a killing blow', () => {
    expect(effectsForBlow(facts({ killed: true }), 500)[0]?.id).toBe('death_blood');
  });

  it('draws the damage type off something that does not bleed', () => {
    const played = effectsForBlow(facts({ bleeds: false }), 500);
    expect(played.map((request) => request.id)).toEqual(['hit_physical', 'impact_physical']);
  });

  it('gives each damage type its own flash', () => {
    for (const damageType of ['physical', 'fire', 'poison', 'ice', 'lightning', 'arcane'] as const) {
      const played = effectsForBlow(facts({ bleeds: false, damageType }), 1);
      expect(played[0]?.id).toBe(DAMAGE_EFFECTS[damageType]);
    }
    // ...and they are all different, which a copy-paste table would fail.
    expect(new Set(Object.values(DAMAGE_EFFECTS)).size).toBe(6);
  });

  it('throws debris only for the types that break something', () => {
    const withDebris = (damageType: CombatFacts['damageType']): string[] =>
      effectsForBlow(facts({ bleeds: false, damageType }), 1).map((request) => request.id);
    expect(withDebris('physical')).toContain('impact_physical');
    expect(withDebris('ice')).toContain('impact_physical');
    expect(withDebris('fire')).not.toContain('impact_physical');
    expect(withDebris('arcane')).not.toContain('impact_physical');
  });

  it('draws no debris off a body that is already throwing blood', () => {
    // Otherwise one blow draws two kinds of debris at once.
    const played = effectsForBlow(facts({ bleeds: true, damageType: 'physical' }), 1);
    expect(played.map((request) => request.id)).not.toContain('impact_physical');
  });

  it('draws the guard and nothing else off a block', () => {
    // A blow that was stopped opened nothing: no blood and no debris.
    const played = effectsForBlow(facts({ blocked: true }), 500);
    expect(played.map((request) => request.id)).toEqual(['hit_block']);
  });

  it('adds the critical on top rather than replacing what happened', () => {
    const played = effectsForBlow(facts({ critical: true }), 1).map((request) => request.id);
    expect(played).toContain('hit_blood');
    expect(played).toContain('hit_critical');
  });

  it('never plays more than three effects for one blow', () => {
    for (const blocked of [false, true]) {
      for (const bleeds of [false, true]) {
        for (const killed of [false, true]) {
          for (const critical of [false, true]) {
            expect(effectsForBlow(facts({ blocked, bleeds, killed, critical }), 1).length).toBeLessThanOrEqual(3);
          }
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

  it('makes a block smaller than an open blow', () => {
    const blocked = effectsForBlow(facts({ blocked: true }), 1)[0];
    const open = effectsForBlow(facts({ bleeds: false }), 1)[0];
    expect(blocked?.scale ?? 0).toBeLessThan(open?.scale ?? 0);
  });

  it('gives every effect of one blow a different seed', () => {
    // Otherwise the flash and the spray draw the same numbers and land in
    // exactly the same pattern, which reads as one effect drawn twice.
    const played = effectsForBlow(facts({ bleeds: false, critical: true, damageType: 'physical' }), 1);
    const seeds = new Set(played.map((request) => request.seed));
    expect(seeds.size).toBe(played.length);
  });
});

describe('a heal (spec 157)', () => {
  /** The shape a heal actually arrives in: a hit against yourself, sign flipped. */
  const heal = (overrides: Partial<CombatFacts> = {}): CombatFacts =>
    facts({ attackerId: 2, targetId: 2, damage: -14, fromX: 100, fromZ: 200, ...overrides });

  it('draws the heal and never blood', () => {
    // The whole bug: healing travelled on the blow message and the table never
    // looked at the sign, so a mote picked up sprayed your own blood.
    expect(effectsForBlow(heal(), 500).map((request) => request.id)).toEqual([HEAL_EFFECT]);
  });

  it('draws no blood whatever flags the message happens to carry', () => {
    // A heal event has no business being flagged killed, critical or blocked --
    // and the wire cannot stop one from being, so the sign has to win.
    for (const killed of [false, true]) {
      for (const critical of [false, true]) {
        for (const blocked of [false, true]) {
          for (const bleeds of [false, true]) {
            const played = effectsForBlow(heal({ killed, critical, blocked, bleeds }), 3);
            expect(played.map((request) => request.id)).toEqual([HEAL_EFFECT]);
          }
        }
      }
    }
  });

  it('is drawn on the body and at its feet, whoever cast it', () => {
    // Not stepped back along a blow and not lifted to a chest: a heal has no
    // direction to carry, and it comes up out of the ground. `playEffect` adds
    // the terrain height, so a lift of zero is the feet.
    const fromElsewhere = effectsForBlow(heal({ attackerId: 9, fromX: 40, fromZ: 90 }), 7)[0];
    expect(fromElsewhere?.x).toBe(100);
    expect(fromElsewhere?.z).toBe(200);
    expect(fromElsewhere?.y).toBe(0);
    expect(fromElsewhere?.rotation).toBe(0);
  });

  it('is never louder for a flag that means nothing to it', () => {
    expect(effectsForBlow(heal({ critical: true }), 1)[0]?.scale).toBe(
      effectsForBlow(heal(), 1)[0]?.scale,
    );
  });

  it('is seeded by where and when, like every other effect', () => {
    // Two clients watching one heal see one picture.
    expect(effectsForBlow(heal(), 500)[0]?.seed).toBe(blowSeed(heal(), 500));
  });

  it('treats a blow that did nothing as a blow, not as a heal', () => {
    // The test is the sign, not "not positive". A zero-damage hit is a hit.
    expect(effectsForBlow(facts({ damage: 0 }), 1)[0]?.id).toBe('hit_blood');
  });
});

describe('REDUNDANT_SERVER_EFFECTS', () => {
  it('names the self-heal abilities, which report themselves twice', () => {
    // Each one sends an Effect message *and* the negative-damage blow that
    // draws the heal, and the registry has no entry under an ability's own id
    // -- so drawing this one too puts the orange debug disc under the heal.
    expect(REDUNDANT_SERVER_EFFECTS.size).toBeGreaterThan(0);
    for (const id of REDUNDANT_SERVER_EFFECTS) {
      expect(id.endsWith('.self'), id).toBe(true);
      const ability = ALL_ABILITIES.find((entry) => `${entry.id}.self` === id);
      expect(ability, `${id} names no ability`).toBeDefined();
      // Only an ability whose picture the blow already draws belongs here.
      expect((ability?.healing ?? 0) + (ability?.healingFraction ?? 0), id).toBeGreaterThan(0);
    }
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
