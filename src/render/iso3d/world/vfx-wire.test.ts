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
  type GoreLevel,
  type PlayRequest,
} from './vfx-wire.js';
import {
  abilityById,
  ALL_ABILITIES,
  damageElementOf,
  damageElementOrdinal,
  DAMAGE_ELEMENTS,
  elementOfAbility,
} from '../../../server/data/abilities.js';
import { bleedsOf, monsterLookFor, monsterLookIds } from './monster-look.js';
import { REGISTRY } from '../vfx/registry.js';

/**
 * `effectsForBlow` at `Blood: Full`, which is what the panel opens at.
 *
 * A helper rather than a default argument on the function itself (spec 182):
 * every one of these tests is about a blow rather than about the setting, and
 * the setting is required precisely so the *game's* call site cannot go on not
 * passing it. The gore levels get their own describe below.
 */
function blow(facts: CombatFacts, tick: number, gore: GoreLevel = 2): readonly PlayRequest[] {
  return effectsForBlow(facts, tick, gore);
}

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
    periodic: false,
    ...overrides,
  };
}

describe('the contact point', () => {
  it('lands on the face the attacker is on, not inside the body', () => {
    // The attacker is at x = 60 and the target at x = 100, so the blow arrives
    // travelling +x and the contact is a body radius back along it.
    const played = blow(facts(), 500);
    for (const request of played) {
      expect(request.x).toBeCloseTo(100 - CONTACT_RADIUS, 5);
      expect(request.z).toBeCloseTo(200, 5);
    }
  });

  it('follows the blow round, whichever way it came from', () => {
    const played = blow(facts({ fromX: 100, fromZ: 260 }), 500);
    const first = played[0];
    expect(first?.x).toBeCloseTo(100, 5);
    expect(first?.z).toBeCloseTo(200 + CONTACT_RADIUS, 5);
  });

  it('lands on a chest rather than a pair of boots', () => {
    expect(blow(facts(), 500)[0]?.y).toBeCloseTo(20 + CONTACT_LIFT, 5);
  });

  it('falls back to the target at point blank rather than dividing by nothing', () => {
    // Two bodies stacked, which happens, and a normalize on a zero vector is how
    // a hit ends up at NaN and silently never draws.
    const played = blow(facts({ fromX: 100, fromZ: 200 }), 500);
    const first = played[0];
    expect(first?.x).toBe(100);
    expect(first?.z).toBe(200);
    expect(Number.isFinite(first?.rotation ?? NaN)).toBe(true);
  });
});

describe('effectsForBlow', () => {
  it('draws blood from something that bleeds', () => {
    const played = blow(facts(), 500);
    expect(played.map((request) => request.id)).toEqual(['blood_hit_brush']);
  });

  it('draws the death effect on a killing blow', () => {
    // The loud mark and the pool, in that order: the brush hit is the moment and
    // leaves nothing behind, `death_blood` is the stain that outlives it.
    const played = blow(facts({ killed: true }), 500).map((request) => request.id);
    expect(played[0]).toBe('blood_hit_brush_heavy');
    expect(played).toContain('death_blood');
  });

  it('draws the damage type off something that does not bleed', () => {
    const played = blow(facts({ bleeds: false }), 500);
    expect(played.map((request) => request.id)).toEqual(['hit_physical', 'impact_physical']);
  });

  it('gives each damage type its own flash', () => {
    // Over the table rather than a list written out here, or adding an element
    // leaves it untested by a test that looks like it covers everything.
    for (const damageType of DAMAGE_ELEMENTS) {
      const played = blow(facts({ bleeds: false, damageType }), 1);
      expect(played[0]?.id).toBe(DAMAGE_EFFECTS[damageType]);
    }
    // ...and they are all different, which a copy-paste table would fail.
    expect(new Set(Object.values(DAMAGE_EFFECTS)).size).toBe(DAMAGE_ELEMENTS.length);
  });

  it('throws debris only for the types that break something', () => {
    const withDebris = (damageType: CombatFacts['damageType']): string[] =>
      blow(facts({ bleeds: false, damageType }), 1).map((request) => request.id);
    expect(withDebris('physical')).toContain('impact_physical');
    expect(withDebris('ice')).toContain('impact_physical');
    expect(withDebris('fire')).not.toContain('impact_physical');
    expect(withDebris('arcane')).not.toContain('impact_physical');
  });

  it('draws no debris off a body that is already throwing blood', () => {
    // Otherwise one blow draws two kinds of debris at once.
    const played = blow(facts({ bleeds: true, damageType: 'physical' }), 1);
    expect(played.map((request) => request.id)).not.toContain('impact_physical');
  });

  it('draws the guard and nothing else off a block', () => {
    // A blow that was stopped opened nothing: no blood and no debris.
    const played = blow(facts({ blocked: true }), 500);
    expect(played.map((request) => request.id)).toEqual(['hit_block']);
  });

  it('adds the critical on top rather than replacing what happened', () => {
    const played = blow(facts({ critical: true }), 1).map((request) => request.id);
    expect(played).toContain('blood_hit_brush');
    expect(played).toContain('hit_critical');
  });

  it('never plays more than three effects for one blow', () => {
    for (const blocked of [false, true]) {
      for (const bleeds of [false, true]) {
        for (const killed of [false, true]) {
          for (const critical of [false, true]) {
            expect(blow(facts({ blocked, bleeds, killed, critical }), 1).length).toBeLessThanOrEqual(3);
          }
        }
      }
    }
  });

  it('throws the spray away from the attacker', () => {
    // The property the whole directional splat exists for.
    const fromLeft = blow(facts({ fromX: 0, fromZ: 200, x: 100, z: 200 }), 1)[0];
    expect(Math.cos(fromLeft?.rotation ?? 0)).toBeCloseTo(1, 5);

    const fromRight = blow(facts({ fromX: 200, fromZ: 200, x: 100, z: 200 }), 1)[0];
    expect(Math.cos(fromRight?.rotation ?? 0)).toBeCloseTo(-1, 5);

    const fromBehind = blow(facts({ fromX: 100, fromZ: 0, x: 100, z: 200 }), 1)[0];
    expect(Math.sin(fromBehind?.rotation ?? 0)).toBeCloseTo(1, 5);
  });

  it('picks a bearing rather than NaN when the two are stacked', () => {
    const played = blow(facts({ fromX: 100, fromZ: 200, x: 100, z: 200 }), 1)[0];
    expect(Number.isFinite(played?.rotation ?? Number.NaN)).toBe(true);
  });

  it('makes a critical louder in the same language, not different', () => {
    const plain = blow(facts(), 1)[0];
    const critical = blow(facts({ critical: true }), 1)[0];
    expect(critical?.id).toBe(plain?.id);
    expect(critical?.scale ?? 0).toBeGreaterThan(plain?.scale ?? 0);
  });

  it('makes a block smaller than an open blow', () => {
    const blocked = blow(facts({ blocked: true }), 1)[0];
    const open = blow(facts({ bleeds: false }), 1)[0];
    expect(blocked?.scale ?? 0).toBeLessThan(open?.scale ?? 0);
  });

  it('gives every effect of one blow a different seed', () => {
    // Otherwise the flash and the spray draw the same numbers and land in
    // exactly the same pattern, which reads as one effect drawn twice.
    const played = blow(facts({ bleeds: false, critical: true, damageType: 'physical' }), 1);
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
    expect(blow(heal(), 500).map((request) => request.id)).toEqual([HEAL_EFFECT]);
  });

  it('draws no blood whatever flags the message happens to carry', () => {
    // A heal event has no business being flagged killed, critical or blocked --
    // and the wire cannot stop one from being, so the sign has to win.
    for (const killed of [false, true]) {
      for (const critical of [false, true]) {
        for (const blocked of [false, true]) {
          for (const bleeds of [false, true]) {
            const played = blow(heal({ killed, critical, blocked, bleeds }), 3);
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
    const fromElsewhere = blow(heal({ attackerId: 9, fromX: 40, fromZ: 90 }), 7)[0];
    expect(fromElsewhere?.x).toBe(100);
    expect(fromElsewhere?.z).toBe(200);
    expect(fromElsewhere?.y).toBe(0);
    expect(fromElsewhere?.rotation).toBe(0);
  });

  it('is never louder for a flag that means nothing to it', () => {
    expect(blow(heal({ critical: true }), 1)[0]?.scale).toBe(
      blow(heal(), 1)[0]?.scale,
    );
  });

  it('is seeded by where and when, like every other effect', () => {
    // Two clients watching one heal see one picture.
    expect(blow(heal(), 500)[0]?.seed).toBe(blowSeed(heal(), 500));
  });

  it('treats a blow that did nothing as a blow, not as a heal', () => {
    // The test is the sign, not "not positive". A zero-damage hit is a hit.
    expect(blow(facts({ damage: 0 }), 1)[0]?.id).toBe('blood_hit_brush');
  });

  it('draws nothing at all for a heal that restored nothing (spec 219)', () => {
    // `-0`, which is what a flask drunk at full health used to send: the sign is
    // negative and the amount is zero, so there is a heal here and there is
    // nothing to say about it. Under `damage < 0` this fell into the blow path
    // and painted a brush hit on the drinker.
    for (const gore of [0, 1, 2] as const) {
      expect(effectsForBlow(heal({ damage: -0 }), 1, gore), `gore ${gore}`).toEqual([]);
    }
  });

  it('still refuses it when the message carries flags it has no business with', () => {
    for (const killed of [false, true]) {
      for (const critical of [false, true]) {
        for (const bleeds of [false, true]) {
          expect(blow(heal({ damage: -0, killed, critical, bleeds }), 3)).toEqual([]);
        }
      }
    }
  });

  it('tells the two zeroes apart by their sign and by nothing else', () => {
    // The pair that makes the rule readable: same everything, opposite signs of
    // the same zero, and one is a blow while the other is not an event.
    expect(blow(facts({ damage: 0 }), 1).length).toBeGreaterThan(0);
    expect(blow(facts({ damage: -0 }), 1)).toEqual([]);
  });
});

describe("an affliction's beat (spec 219)", () => {
  /** A pulse, which is a `hit` on the wire and is not a blow. */
  const pulse = (overrides: Partial<CombatFacts> = {}): CombatFacts =>
    facts({ periodic: true, ...overrides });

  it('draws no blow at all, whatever the message carries', () => {
    // The whole of it. Everything `effectsForBlow` produces is aimed along the
    // blow, and a pulse's attacker walked off seconds ago -- so eight beats of
    // a Poison drew eight brush hits down eight meaningless bearings.
    for (const gore of [0, 1, 2] as const) {
      for (const killed of [false, true]) {
        for (const critical of [false, true]) {
          for (const blocked of [false, true]) {
            for (const bleeds of [false, true]) {
              const played = effectsForBlow(
                pulse({ killed, critical, blocked, bleeds }),
                7,
                gore,
              );
              expect(played, JSON.stringify({ gore, killed, critical, blocked, bleeds })).toEqual([]);
            }
          }
        }
      }
    }
  });

  it('draws nothing for any damage type either', () => {
    // Not "no blood": no flash and no debris. A construct rotting is still an
    // affliction, and `hit_physical` plus `impact_physical` per beat is the same
    // failure in a different colour.
    for (const damageType of Object.keys(DAMAGE_EFFECTS) as (keyof typeof DAMAGE_EFFECTS)[]) {
      expect(blow(pulse({ bleeds: false, damageType }), 9), damageType).toEqual([]);
    }
  });

  it('lays no pool on a pulse that kills', () => {
    // `death_blood` is the one effect here that outlives the moment -- a stain
    // on the ground -- so a poison finishing somebody would leave the loudest
    // mark of the lot behind it.
    expect(blow(pulse({ killed: true }), 11, 2)).toEqual([]);
  });

  it('is the flag and not the damage that decides', () => {
    // The same blow, told apart by one bit. Nothing about a pulse's numbers
    // distinguishes it -- which is why the bit had to go on the wire.
    expect(blow(facts({ periodic: false }), 13).length).toBeGreaterThan(0);
    expect(blow(facts({ periodic: true }), 13)).toEqual([]);
  });
});

describe('the blood setting (spec 182)', () => {
  const ids = (overrides: Partial<CombatFacts>, gore: GoreLevel): string[] =>
    effectsForBlow(facts(overrides), 500, gore).map((request) => request.id);

  it('plays no blood at all at Off, and still draws the blow', () => {
    // The whole bug. `Off` reached the decal field, which owns the ground, so
    // every brush mark still came off the body and only the stains went away.
    for (const killed of [false, true]) {
      for (const critical of [false, true]) {
        const played = ids({ killed, critical }, 0);
        expect(played.length, JSON.stringify({ killed, critical })).toBeGreaterThan(0);
        for (const id of played) expect(id, id).not.toMatch(/blood/);
      }
    }
  });

  it('draws a bleeding body exactly like a construct at Off', () => {
    // Not "nothing": a blow with no picture is a fight that is harder to read
    // than one with the wrong picture, so it falls through to the impact the
    // damage type already has.
    for (const damageType of ['physical', 'fire', 'poison', 'ice', 'lightning', 'arcane'] as const) {
      expect(ids({ bleeds: true, damageType }, 0)).toEqual(ids({ bleeds: false, damageType }, 2));
    }
  });

  it('keeps the wound and drops the pool at Less', () => {
    // `death_blood` is the loud one, it is the one that lasts, and it is the one
    // that lays a 96-unit stain on the floor.
    const killing = ids({ killed: true }, 1);
    expect(killing).toContain('blood_hit_brush');
    expect(killing).not.toContain('death_blood');
    expect(killing).not.toContain('blood_hit_brush_heavy');
  });

  it('leaves an ordinary hit alone at Less', () => {
    expect(ids({}, 1)).toEqual(ids({}, 2));
  });

  it('is the spec-158 table at Full', () => {
    expect(ids({}, 2)).toEqual(['blood_hit_brush']);
    expect(ids({ killed: true }, 2)).toEqual(['blood_hit_brush_heavy', 'death_blood']);
  });

  it('never touches a block or a heal, whatever the level', () => {
    // Neither is blood, and a setting that silenced a heal would be a bug of its
    // own -- the number floating off a body is how a player reads a fight.
    for (const gore of [0, 1, 2] as const) {
      expect(ids({ blocked: true }, gore)).toEqual(['hit_block']);
      expect(ids({ damage: -14 }, gore)).toEqual([HEAL_EFFECT]);
    }
  });

  it('still never plays more than three effects, at any level', () => {
    for (const gore of [0, 1, 2] as const) {
      for (const blocked of [false, true]) {
        for (const bleeds of [false, true]) {
          for (const killed of [false, true]) {
            for (const critical of [false, true]) {
              const played = effectsForBlow(facts({ blocked, bleeds, killed, critical }), 1, gore);
              expect(played.length, `${gore}/${blocked}/${bleeds}/${killed}/${critical}`).toBeLessThanOrEqual(3);
            }
          }
        }
      }
    }
  });

  it('gives every effect of one blow a different seed, at every level', () => {
    for (const gore of [0, 1, 2] as const) {
      const played = effectsForBlow(facts({ critical: true, killed: true }), 1, gore);
      expect(new Set(played.map((request) => request.seed)).size).toBe(played.length);
    }
  });
});

describe('REDUNDANT_SERVER_EFFECTS', () => {
  it('names the self-heal abilities, which report themselves twice', () => {
    // Each one sends an Effect message *and* the negative-damage blow that
    // draws the heal, and the registry has no entry under an ability's own id
    // -- so drawing this one too puts the orange debug disc under the heal.
    expect(REDUNDANT_SERVER_EFFECTS.size).toBeGreaterThan(0);
    for (const id of REDUNDANT_SERVER_EFFECTS) {
      // Two shapes qualify, and both are "the blow already drew this" rather
      // than two exceptions: a self-heal's `.self`, and the `.impact` of a
      // projectile that struck a body (spec 229), which `world.ts` sends from
      // the same branch that raises the hit.
      const ability = ALL_ABILITIES.find(
        (entry) => `${entry.id}.self` === id || `${entry.id}.impact` === id,
      );
      expect(ability, `${id} names no ability`).toBeDefined();
      if (id.endsWith('.self')) {
        expect((ability?.healing ?? 0) + (ability?.healingFraction ?? 0), id).toBeGreaterThan(0);
        continue;
      }
      // A direct-hit projectile only: a burst happens whether or not it struck.
      expect(ability?.kind, id).toBe('projectile');
      expect(ability?.radius ?? 0, id).toBe(0);
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

/**
 * What a blow is made of, and who bleeds (spec 229).
 *
 * These are one group rather than two because the two facts were one bug: while
 * `bleeds` was a literal `true`, `effectsForBlow` could not reach
 * `DAMAGE_EFFECTS` at all -- it is consulted only in the else of the bleed
 * branch -- so five authored impact effects were unreachable and fixing the
 * damage type on its own would have changed precisely nothing.
 */
describe('what a blow is made of', () => {
  it('gives every element an effect that exists in the registry', () => {
    // The table is a `Record<DamageType, string>`, so a missing element fails to
    // compile; what this catches is the other half -- a row filled in with an id
    // nothing authored, which looks complete and silently plays nothing.
    for (const element of DAMAGE_ELEMENTS) {
      const id = DAMAGE_EFFECTS[element];
      expect(id, `no effect for ${element}`).toBeTruthy();
      expect(REGISTRY.byId.has(id), `${element} -> ${id} is not in the registry`).toBe(true);
    }
  });

  it('never draws two elements as the same picture', () => {
    const ids = Object.values(DAMAGE_EFFECTS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('takes an ability element from the affliction it lands', () => {
    // Asserted row by row against the affliction each skill actually carries,
    // rather than by re-deriving it -- a test that ran `elementOfAbility`'s own
    // logic back over the table would pass for any mapping at all.
    expect(elementOfAbility(abilityById('skill.emberToss'))).toBe('fire');
    expect(elementOfAbility(abilityById('skill.rimeTouch'))).toBe('ice');
    expect(elementOfAbility(abilityById('skill.arcLash'))).toBe('lightning');
    expect(elementOfAbility(abilityById('skill.poisonDart'))).toBe('poison');
    expect(elementOfAbility(abilityById('skill.acidSpray'))).toBe('corrosion');
    expect(elementOfAbility(abilityById('skill.blight'))).toBe('decay');
    // A cut is a cut: Bleed is the one affliction that is not elemental, which
    // is the whole reason the mapping is a table rather than "dots are magic".
    expect(elementOfAbility(abilityById('skill.rendingCut'))).toBe('physical');
  });

  it('is physical for a row with no affliction and no element', () => {
    expect(elementOfAbility(abilityById('skill.guardBreak'))).toBe('physical');
    expect(elementOfAbility(abilityById('melee.slash'))).toBe('physical');
    // Total, so an id off a newer server cannot throw inside the render loop.
    expect(elementOfAbility(null)).toBe('physical');
    expect(elementOfAbility(abilityById('no.such.ability'))).toBe('physical');
  });

  it('lets the affliction win over an authored element, so the two cannot disagree', () => {
    const ember = abilityById('skill.emberToss');
    expect(ember).toBeDefined();
    if (!ember) return;
    expect(elementOfAbility({ ...ember, element: 'arcane' })).toBe('fire');
  });

  it('round-trips every element through the wire ordinal', () => {
    for (const element of DAMAGE_ELEMENTS) {
      expect(damageElementOf(damageElementOrdinal(element))).toBe(element);
    }
    // Total in the direction that matters: a client reading an ordinal a newer
    // server invented draws what every blow drew before elements existed.
    expect(damageElementOf(200)).toBe('physical');
    expect(damageElementOf(-1)).toBe('physical');
  });

  it('draws blood and the element on a body that bleeds', () => {
    const out = blow(facts({ damageType: 'fire' }), 30);
    const ids = out.map((request) => request.id);
    expect(ids).toContain('blood_hit_brush');
    expect(ids).toContain(DAMAGE_EFFECTS.fire);
    // The cap this spec does not raise.
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('adds nothing extra for a physical blow on a body that bleeds', () => {
    // The regression that matters most: an ordinary sword hit on flesh has to
    // draw exactly what it drew before spec 229 touched anything.
    const ids = blow(facts({ damageType: 'physical' }), 30).map((request) => request.id);
    expect(ids).toEqual(['blood_hit_brush']);
  });

  it('draws no blood at all for a body that does not bleed', () => {
    for (const gore of [0, 1, 2] as GoreLevel[]) {
      const ids = effectsForBlow(facts({ bleeds: false, damageType: 'ice' }), 30, gore)
        .map((request) => request.id);
      expect(ids.some((id) => id.startsWith('blood_') || id === 'death_blood')).toBe(false);
      expect(ids).toContain(DAMAGE_EFFECTS.ice);
      expect(ids).toContain('impact_physical');
    }
  });

  it('stays inside three requests in every combination', () => {
    for (const bleeds of [true, false]) {
      for (const gore of [0, 1, 2] as GoreLevel[]) {
        for (const critical of [true, false]) {
          for (const killed of [true, false]) {
            for (const damageType of DAMAGE_ELEMENTS) {
              const out = effectsForBlow(
                facts({ bleeds, critical, killed, damageType }),
                30,
                gore,
              );
              expect(out.length, `${String(bleeds)}/${gore}/${damageType}`).toBeLessThanOrEqual(3);
            }
          }
        }
      }
    }
  });

  it('gives each request of one blow its own seed', () => {
    const out = blow(facts({ damageType: 'fire', critical: true }), 30);
    const seeds = out.map((request) => request.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});

describe('which bodies bleed', () => {
  it('bleeds by default, for a player and for a body with no row', () => {
    expect(bleedsOf(null)).toBe(true);
    expect(bleedsOf(undefined)).toBe(true);
    expect(bleedsOf('player')).toBe(true);
    expect(bleedsOf('no_such_monster')).toBe(true);
  });

  it('carries the field through a copied look rather than dropping it', () => {
    // `monsterLookFor` clones what it returns, and a clone that quietly loses a
    // field answers differently from the row it copied.
    for (const id of monsterLookIds()) {
      // Defaulted on both sides: the copy correctly preserves *absent*, and
      // absent is what means "true". What this catches is a copy that turned a
      // row's explicit `false` into an absent field.
      expect(monsterLookFor(id)?.bleeds ?? true).toBe(bleedsOf(id));
    }
  });
});

describe('a projectile that struck is not drawn twice', () => {
  it('refuses the dart impact the blow already draws', () => {
    expect(REDUNDANT_SERVER_EFFECTS.has('skill.poisonDart.impact')).toBe(true);
  });

  it('keeps a bursting projectile, which happens whether or not it struck', () => {
    expect(REDUNDANT_SERVER_EFFECTS.has('skill.emberToss.impact')).toBe(false);
  });
});
