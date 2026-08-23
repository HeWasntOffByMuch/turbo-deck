import { describe, expect, it } from 'vitest';
import { monsterCritterFor, monsterCritterIds } from './monster-critter.js';
import { ALL_MONSTERS, monsterById } from '../../../server/data/monsters.js';
import { CRITTERS, isCritterId } from '../../critters/index.js';

/**
 * The table that says which monsters are animals rather than machines, and the
 * two ways a row in it goes wrong quietly: naming a monster that does not exist,
 * and naming a species that does not. Either draws exactly nothing different and
 * says so nowhere.
 */
describe('monsterCritterFor', () => {
  it('answers for every monster, and names only monsters and species that exist', () => {
    for (const monster of ALL_MONSTERS) {
      expect(() => monsterCritterFor(monster.id), monster.id).not.toThrow();
    }
    for (const typeId of monsterCritterIds()) {
      expect(monsterById(typeId), typeId).not.toBeNull();
      const row = monsterCritterFor(typeId);
      expect(row, typeId).not.toBeNull();
      expect(isCritterId(row?.species ?? ''), `${typeId} -> ${row?.species}`).toBe(true);
    }
  });

  it('leaves every other monster on the mech rig it has always had', () => {
    for (const id of ['grazer', 'stalker', 'ravager', 'slinger', 'small_spider', 'dummy']) {
      expect(monsterCritterFor(id), id).toBeNull();
    }
    expect(monsterCritterFor('nothing.like.this')).toBeNull();
    expect(monsterCritterFor('')).toBeNull();
  });

  it('does not answer with something off Object.prototype', () => {
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(monsterCritterFor(id), id).toBeNull();
    }
  });

  it('never hands two bodies the same figure record', () => {
    // The rig is handed its tuning and keeps it, so one shared record would mean
    // resizing one sheep resized the flock.
    const first = monsterCritterFor('sheep');
    const second = monsterCritterFor('sheep');
    expect(first).not.toBeNull();
    expect(first?.figure).not.toBe(second?.figure);

    (first?.figure as Record<string, number>)['bodyScale'] = 9;
    expect(second?.figure.bodyScale).not.toBe(9);
    expect(monsterCritterFor('sheep')?.figure.bodyScale).toBe(second?.figure.bodyScale);
  });
});

describe('the sheep', () => {
  const row = monsterCritterFor('sheep');

  it('is drawn as the sheep species', () => {
    expect(row?.species).toBe('sheep');
    expect(CRITTERS[row?.species ?? 'pig'].name).toBe('Sheep');
  });

  it('is drawn at about the size the server collides it at', () => {
    // The species is authored at its own scale and the sim's radius is the one
    // that has to be matched -- a body drawn much smaller than its selection
    // ring is a cursor target with a gap in the middle of it, and one drawn
    // larger overhangs the ring the player is aiming at.
    const scale = row?.figure.bodyScale ?? 0;
    const species = CRITTERS['sheep'];
    const radius = monsterById('sheep')?.radius ?? 0;
    const halfWidth = Math.max(...species.parts.map((p) => p.size[2])) * 0.5 * scale;
    expect(halfWidth).toBeGreaterThan(radius * 0.5);
    expect(halfWidth).toBeLessThanOrEqual(radius);
  });

  it('gives back the ground a scaled-down leg stopped covering', () => {
    // Shrinking a body shortens its stride, and a stride shorter than the
    // distance actually travelled is a walk that skates.
    const { bodyScale, strideScale } = row?.figure ?? { bodyScale: 1, strideScale: 1 };
    expect(bodyScale).toBeGreaterThan(0);
    expect(strideScale).toBeGreaterThanOrEqual(1);
    expect(bodyScale * strideScale).toBeGreaterThanOrEqual(1);
  });
});
