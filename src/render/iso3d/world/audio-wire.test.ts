/**
 * What one moment sounds like (spec 229).
 *
 * Two halves, and both fail in silence, which is why they are asserted rather
 * than listened to.
 *
 * `soundsForBlow` is the one function here a fight calls sixty times a second,
 * and nearly every rule in it is a rule about *not* making a noise: a pulse is
 * not a blow, a heal is not a blow, a blocked blow opened nothing, and a
 * critical is the same contact louder rather than a different weapon. Each of
 * those is one missing `return` away from eight beats of a Poison sounding like
 * eight sword hits, or a flask drunk at full health sounding like being stabbed
 * -- and none of them shows up in a screenshot.
 *
 * The `ABILITY_ELEMENTS` half is the assertion `shot-vfx.test.ts` makes about
 * `SHOT_ART`, one system along: a key naming no ability is a sound that can
 * never play, and it reads exactly like a row that works. Same for the ids on
 * the other side -- the union already refuses a typo, so what is left to check
 * is that a one-shot is never a looping row, which the type cannot see and which
 * costs a held voice for the session.
 */

import { describe, expect, it } from 'vitest';
import {
  ABILITY_ELEMENTS,
  AFFLICTION_TICKS,
  elementOf,
  soundForAfflictionTick,
  soundForEffect,
  soundForProjectile,
  soundForWindup,
  soundsForBlow,
  type BlowFacts,
  type Element,
} from './audio-wire.js';
import { isSoundEventId, soundEvent } from '../../audio/events.js';
import { ABILITIES, ALL_ABILITIES, type ProjectileLook } from '../../../server/data/abilities.js';
import { ALL_DOTS } from '../../../server/data/damage-over-time.js';

function facts(overrides: Partial<BlowFacts> = {}): BlowFacts {
  return {
    damage: 10,
    killed: false,
    critical: false,
    blocked: false,
    periodic: false,
    bleeds: true,
    x: 100,
    y: 20,
    z: 200,
    onSelf: false,
    ...overrides,
  };
}

const ids = (blow: BlowFacts): readonly string[] => soundsForBlow(blow).map((request) => request.id);

/** A heal is the *sign*, never the amount -- which is the whole of the `-0` rule. */
const isHeal = (blow: BlowFacts): boolean => blow.damage < 0 || Object.is(blow.damage, -0);

/**
 * Every combination of flags one combat frame can carry, over the four damages
 * that mean different things: a heal, a heal that restored nothing, a blow that
 * did nothing, and an ordinary blow.
 */
function everyBlow(): BlowFacts[] {
  const out: BlowFacts[] = [];
  for (const damage of [-14, -0, 0, 9]) {
    for (const killed of [false, true]) {
      for (const critical of [false, true]) {
        for (const blocked of [false, true]) {
          for (const periodic of [false, true]) {
            for (const bleeds of [false, true]) {
              for (const onSelf of [false, true]) {
                out.push(facts({ damage, killed, critical, blocked, periodic, bleeds, onSelf }));
              }
            }
          }
        }
      }
    }
  }
  return out;
}

describe("an affliction's beat (the audio half of spec 219)", () => {
  it('makes no sound of contact at all, whatever the message carries', () => {
    // The whole of it. A pulse has no contact in it -- whoever applied the
    // Poison walked off five seconds ago -- so the blow vocabulary describes
    // nothing. What a pulse does have is its own row, fired by the driver that
    // already derives the beat.
    for (const blow of everyBlow()) {
      if (!blow.periodic) continue;
      expect(soundsForBlow(blow), JSON.stringify(blow)).toEqual([]);
    }
  });

  it('stays silent for a pulse that crits and kills', () => {
    // The three flags that would otherwise each add a sound of their own, on
    // one message. A poison finishing somebody would be the loudest moment in
    // the fight, played for a blow nobody struck.
    expect(soundsForBlow(facts({ periodic: true, killed: true, critical: true }))).toEqual([]);
    expect(soundsForBlow(facts({ periodic: true, killed: true, critical: true, onSelf: true }))).toEqual([]);
  });

  it('is the flag and not the damage that decides', () => {
    // The same blow, told apart by one bit -- which is why the bit had to go on
    // the wire in the first place.
    expect(ids(facts({ periodic: false })).length).toBeGreaterThan(0);
    expect(ids(facts({ periodic: true }))).toEqual([]);
  });
});

describe('a heal (spec 157)', () => {
  it('plays the heal and nothing from the blow vocabulary', () => {
    expect(ids(facts({ damage: -14 }))).toEqual(['elemental.heal']);
  });

  it('ignores every flag a heal has no business carrying', () => {
    // A heal event should never be flagged killed, critical or blocked -- and
    // the wire cannot stop one from being, so the sign has to win outright.
    for (const blow of everyBlow()) {
      if (blow.periodic || !(blow.damage < 0)) continue;
      expect(ids(blow), JSON.stringify(blow)).toEqual(['elemental.heal']);
    }
  });

  it('tells the two zeroes apart by their sign and by nothing else', () => {
    // `damage < 0` is false for `-0`, which is exactly what a heal that restored
    // nothing arrives as. Without the `Object.is` it falls through and plays a
    // sword hitting the person who drank the flask.
    expect(ids(facts({ damage: -0 }))).toEqual([]);
    expect(ids(facts({ damage: 0 }))).toEqual(['combat.hit.flesh']);
  });

  it('never lets a heal that restored nothing reach the blow path', () => {
    // The property under the pair above: whatever else the frame carries, `-0`
    // makes no sound of contact.
    for (const blow of everyBlow()) {
      if (!Object.is(blow.damage, -0)) continue;
      for (const id of ids(blow)) {
        expect(id, JSON.stringify(blow)).not.toMatch(/^combat\./);
        expect(id, JSON.stringify(blow)).not.toMatch(/^player\./);
      }
    }
  });
});

describe('a blocked blow', () => {
  it('plays the guard and nothing else', () => {
    // Nothing opened, so nothing about the body it landed on is audible.
    expect(ids(facts({ blocked: true }))).toEqual(['combat.hit.blocked']);
  });

  it('sounds the same off flesh, off a construct and off a critical', () => {
    for (const blow of everyBlow()) {
      if (blow.periodic || isHeal(blow) || !blow.blocked) continue;
      expect(ids(blow), JSON.stringify(blow)).toEqual(['combat.hit.blocked']);
    }
  });
});

describe('the contact', () => {
  it('gives every open blow exactly one contact sound, flesh or construct', () => {
    // Never both, which is what a `bleeds` check that pushes and then falls
    // through gives; and never neither, which is what one without an else
    // branch gives -- a construct being hit in silence.
    for (const blow of everyBlow()) {
      if (blow.periodic || blow.blocked || isHeal(blow)) continue;
      const contacts = ids(blow).filter(
        (id) => id === 'combat.hit.flesh' || id === 'combat.hit.armored',
      );
      expect(contacts, JSON.stringify(blow)).toHaveLength(1);
      expect(contacts[0], JSON.stringify(blow)).toBe(
        blow.bleeds ? 'combat.hit.flesh' : 'combat.hit.armored',
      );
    }
  });

  it('adds the critical beside the hit rather than instead of it', () => {
    // Replacing the hit would make a critical blow sound like a different
    // weapon, which is the same rule `vfx-wire.ts` states about `hit_critical`.
    for (const bleeds of [false, true]) {
      const played = ids(facts({ critical: true, bleeds }));
      expect(played[0]).toBe(bleeds ? 'combat.hit.flesh' : 'combat.hit.armored');
      expect(played).toContain('combat.hit.critical');
    }
  });

  it('carries the contact point on every request of one blow', () => {
    // One blow is one place. A request that lost the position plays at the
    // origin, which on this map is a corner of the arena.
    for (const request of soundsForBlow(facts({ critical: true, killed: true, onSelf: true }))) {
      expect(request.x).toBe(100);
      expect(request.y).toBe(20);
      expect(request.z).toBe(200);
    }
  });
});

describe('who fell', () => {
  it('plays your own hurt when the blow lands on you', () => {
    expect(ids(facts({ onSelf: true }))).toContain('player.hurt');
    expect(ids(facts({ onSelf: true }))).not.toContain('player.death');
  });

  it('plays your own death rather than an enemy death when you are the one who fell', () => {
    // The else-if: your death announced twice, once as yours and once as
    // somebody's, is two sounds for one event.
    const played = ids(facts({ onSelf: true, killed: true }));
    expect(played).toContain('player.death');
    expect(played).not.toContain('combat.death');
    expect(played).not.toContain('player.hurt');
  });

  it('plays the enemy death for a kill on anybody else', () => {
    const played = ids(facts({ killed: true }));
    expect(played).toContain('combat.death');
    expect(played).not.toContain('player.death');
  });

  it('says nothing about vitals for an ordinary blow on somebody else', () => {
    for (const blow of everyBlow()) {
      if (blow.periodic || blow.blocked || isHeal(blow) || blow.onSelf || blow.killed) continue;
      for (const id of ids(blow)) expect(id, JSON.stringify(blow)).not.toMatch(/^player\./);
      expect(ids(blow), JSON.stringify(blow)).not.toContain('combat.death');
    }
  });
});

describe('what one blow may cost the voice budget', () => {
  it('never asks for more than three sounds, for any message a fight can send', () => {
    // A voice budget is spent by the people fighting: one blow that fans out
    // into six sounds starves the next five blows, which is worse than any of
    // the six was good.
    for (const blow of everyBlow()) {
      expect(soundsForBlow(blow).length, JSON.stringify(blow)).toBeLessThanOrEqual(3);
    }
  });

  it('only ever names an event this build knows', () => {
    for (const blow of everyBlow()) {
      for (const request of soundsForBlow(blow)) {
        expect(isSoundEventId(request.id), request.id).toBe(true);
      }
    }
  });

  it('never fires a looping row as a one-shot', () => {
    // A loop is started and stopped by a driver holding a handle. Fired and
    // forgotten it is a voice held for the session, and the type cannot see it.
    for (const blow of everyBlow()) {
      for (const request of soundsForBlow(blow)) {
        expect(soundEvent(request.id)?.loop, request.id).toBeUndefined();
      }
    }
  });
});

describe('ABILITY_ELEMENTS', () => {
  it('names only abilities this game actually has', () => {
    // A key with a typo in it is a sound that silently never plays, and it looks
    // exactly like a row that works.
    for (const abilityId of Object.keys(ABILITY_ELEMENTS)) {
      expect(ABILITIES.has(abilityId), `${abilityId} names no ability`).toBe(true);
    }
    expect(Object.keys(ABILITY_ELEMENTS).length).toBeGreaterThan(0);
  });

  it('leaves an ability it has never heard of physical rather than undefined', () => {
    expect(elementOf('skill.somethingNobodyWrote')).toBe('physical');
    expect(elementOf('melee.slash')).toBe('physical');
  });

  it('files each element under an ability that really is one', () => {
    // The table read back the other way, so a row moved between elements fails
    // here rather than in somebody's ears.
    const representative: Readonly<Record<Element, string>> = {
      physical: 'melee.slash',
      fire: 'ranged.ember',
      ice: 'skill.rimeTouch',
      lightning: 'skill.arcLash',
      poison: 'skill.poisonDart',
      arcane: 'bolt.arcane',
    };
    for (const [element, abilityId] of Object.entries(representative)) {
      expect(elementOf(abilityId), abilityId).toBe(element);
    }
  });
});

describe('soundForWindup', () => {
  it('gives every ability in the game a wind-up this build knows', () => {
    // At the wind-up rather than at the contact: a swing is legible because it
    // takes half a second you can read, and one that makes no noise until it
    // lands is a swing with no tell.
    for (const ability of ALL_ABILITIES) {
      for (const isHeavy of [false, true]) {
        const id = soundForWindup(ability.id, isHeavy);
        expect(id, `${ability.id} winds up in silence`).not.toBeNull();
        expect(isSoundEventId(id ?? ''), `${ability.id} -> ${id}`).toBe(true);
      }
    }
  });

  it('draws the bow and throws the star, rather than swinging both', () => {
    // Both are `projectile` in the table, so `kind` cannot tell them apart.
    expect(soundForWindup('ranged.shot', false)).toBe('combat.bow.draw');
    expect(soundForWindup('ranged.star', false)).toBe('combat.throw');
    // ...and neither is a swing at either weight.
    expect(soundForWindup('ranged.shot', true)).toBe('combat.bow.draw');
    expect(soundForWindup('ranged.star', true)).toBe('combat.throw');
  });

  it('tells a light swing from a heavy one', () => {
    expect(soundForWindup('melee.slash', false)).toBe('combat.swing.light');
    expect(soundForWindup('melee.heavy', true)).toBe('combat.swing.heavy');
  });

  it('gives an elemental row its cast instead of a swing, never as well as', () => {
    // A fire staff that whooshed *and* ignited on one press is two attacks'
    // worth of sound for one attack.
    for (const abilityId of Object.keys(ABILITY_ELEMENTS)) {
      for (const isHeavy of [false, true]) {
        const id = soundForWindup(abilityId, isHeavy);
        expect(id, abilityId).toMatch(/^elemental\./);
        expect(id, abilityId).not.toMatch(/^combat\./);
      }
    }
  });
});

describe('soundForEffect', () => {
  it('answers nothing for a cast cue, which has already been heard', () => {
    // `${ability.id}.self` is the cast, and the cast fired at the wind-up.
    for (const ability of ALL_ABILITIES) {
      expect(soundForEffect(`${ability.id}.self`), ability.id).toBeNull();
    }
  });

  it('answers nothing for an effect id that is neither', () => {
    expect(soundForEffect('ranged.ember')).toBeNull();
    expect(soundForEffect('')).toBeNull();
    expect(soundForEffect('impact')).toBeNull();
  });

  it('answers nothing for an impact from an ability it has never heard of', () => {
    // The default is physical, and physical impact is the blow's own contact
    // sound -- which `soundsForBlow` has already played off the same moment.
    expect(soundForEffect('skill.somethingNobodyWrote.impact')).toBeNull();
    expect(soundForEffect('melee.slash.impact')).toBeNull();
  });

  it('gives each element its own impact, and they are all different', () => {
    // A copy-paste in the impact table is four elements landing with one sound,
    // which reads as an element that does not exist.
    const impacts = new Map<string, string | null>();
    for (const abilityId of Object.keys(ABILITY_ELEMENTS)) {
      const id = soundForEffect(`${abilityId}.impact`);
      expect(id, abilityId).not.toBeNull();
      expect(isSoundEventId(id ?? ''), `${abilityId} -> ${id}`).toBe(true);
      impacts.set(elementOf(abilityId), id);
    }
    expect(new Set(impacts.values()).size).toBe(impacts.size);
  });

  it('gives one ability one impact whichever way it is asked', () => {
    expect(soundForEffect('ranged.ember.impact')).toBe('elemental.fire.impact');
    expect(soundForEffect('skill.emberToss.impact')).toBe('elemental.fire.impact');
    expect(soundForEffect('skill.rimeTouch.impact')).toBe('elemental.ice.impact');
    expect(soundForEffect('skill.arcLash.impact')).toBe('elemental.lightning.impact');
    expect(soundForEffect('skill.acidSpray.impact')).toBe('elemental.poison.impact');
    expect(soundForEffect('ground.quake.impact')).toBe('elemental.arcane.impact');
  });
});

describe('soundForProjectile', () => {
  it('answers for the ember and for nothing else', () => {
    // An arrow and a star ARE their mesh -- shot-vfx.ts says the same about
    // their paint. A whistle following every arrow across the arena is a sound
    // per projectile per frame for something the eye is already tracking.
    const looks: readonly ProjectileLook[] = ['orb', 'arrow', 'shuriken', 'ember'];
    for (const look of looks) {
      expect(soundForProjectile(look), look).toBe(look === 'ember' ? 'elemental.fire.travel' : null);
    }
    expect(soundForProjectile('')).toBeNull();
    expect(soundForProjectile('fireball')).toBeNull();
  });

  it('answers with a row that actually loops', () => {
    // It is held for as long as the shot is in the air and stopped when it is
    // not, so a one-shot row here is a `stop` on a voice that already ended.
    const id = soundForProjectile('ember');
    expect(id).not.toBeNull();
    expect(soundEvent(id ?? '')?.loop).toBe(true);
  });

  it('is reachable from a look some ability really throws', () => {
    const thrown = new Set(
      ALL_ABILITIES.map((ability) => ability.projectile?.look).filter((look) => look !== undefined),
    );
    expect(thrown.has('ember')).toBe(true);
  });
});

describe('AFFLICTION_TICKS', () => {
  it('names every affliction the sim can apply, and only those', () => {
    // Keyed on the affliction's own id, so a row added to the DoT table is a row
    // here and in the catalog and nothing else -- and a key that matches no row
    // is a beat nothing will ever fire.
    const authored = ALL_DOTS.map((dot) => dot.id).sort();
    expect(Object.keys(AFFLICTION_TICKS).sort()).toEqual(authored);
  });

  it('gives each one a distinct event this build knows', () => {
    // Spec 215 gave each affliction a distinct picture; a shared tick would put
    // one sound under seven different things happening to a body.
    const played = Object.values(AFFLICTION_TICKS);
    for (const id of played) expect(isSoundEventId(id), id).toBe(true);
    expect(new Set(played).size).toBe(played.length);
  });

  it('stays silent for an affliction with no row rather than borrowing one', () => {
    expect(soundForAfflictionTick('nothing')).toBeNull();
    expect(soundForAfflictionTick('burn')).toBe('affliction.burn.tick');
  });
});
