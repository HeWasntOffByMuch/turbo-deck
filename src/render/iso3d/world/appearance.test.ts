import { describe, expect, it } from 'vitest';
import { appearanceOf, displayName, PLAYER_CRITTER, PLAYER_FIGURE } from './appearance.js';
import { ALL_MONSTERS } from '../../../server/data/monsters.js';
import { ALL_ABILITIES } from '../../../server/data/abilities.js';
import { EntityKind } from '../../../server/net/protocol.js';
import { CRITTER_IDS, CRITTERS } from '../../critters/index.js';

describe('appearanceOf', () => {
  it('gives every monster in the table a rig and its own radius', () => {
    for (const monster of ALL_MONSTERS) {
      const look = appearanceOf({ kind: EntityKind.Monster, typeId: monster.id });
      expect(look.rig).toBe('monster');
      expect(look.radius).toBe(monster.radius);
      expect(look.showsHealth).toBe(true);
    }
  });

  it('sizes a projectile from the ability that threw it', () => {
    for (const ability of ALL_ABILITIES) {
      if (!ability.projectile) continue;
      const look = appearanceOf({ kind: EntityKind.Projectile, typeId: ability.id });
      expect(look.rig).toBe('projectile');
      expect(look.radius).toBe(ability.projectile.radius);
      expect(look.showsHealth).toBe(false);
    }
  });

  it('draws players as players', () => {
    const look = appearanceOf({ kind: EntityKind.Player, typeId: '' });
    expect(look.rig).toBe('player');
    expect(look.radius).toBeGreaterThan(0);
  });

  /**
   * The wire carries no species for a player, so `PLAYER_CRITTER` is the only
   * thing standing between the play view and a rig it cannot build. A rename in
   * `critters/` has to fail here rather than at the first frame.
   */
  it('names a species the critter table actually has (spec 081)', () => {
    expect(CRITTER_IDS).toContain(PLAYER_CRITTER);
    expect(CRITTERS[PLAYER_CRITTER]).toBeDefined();
    expect(PLAYER_CRITTER).toBe('cow');
  });

  it('starts the cow at the figure spec 081 asked for', () => {
    expect(PLAYER_FIGURE).toEqual({ bodyScale: 0.7, strideScale: 1.3 });
  });

  /**
   * Totality is the point: a monster added on the server must not be able to
   * throw halfway through a frame and take the whole view down with it.
   */
  it('still returns something for an id it has never heard of', () => {
    for (const kind of [EntityKind.Player, EntityKind.Monster, EntityKind.Prop, EntityKind.Projectile]) {
      const look = appearanceOf({ kind, typeId: 'nothing.like.this' });
      expect(look.radius).toBeGreaterThan(0);
      expect(look.typeId).not.toBe('');
    }
  });

  it('survives an empty type id', () => {
    const look = appearanceOf({ kind: EntityKind.Monster, typeId: '' });
    expect(look.typeId).not.toBe('');
    expect(look.radius).toBeGreaterThan(0);
  });
});

describe('displayName', () => {
  it('names what the tables know and falls back to the id', () => {
    expect(displayName({ kind: EntityKind.Monster, typeId: 'grazer' })).toBe('Grazer');
    expect(displayName({ kind: EntityKind.Projectile, typeId: 'bolt.arcane' })).toBe('Arcane Bolt');
    expect(displayName({ kind: EntityKind.Monster, typeId: 'wyrm' })).toBe('wyrm');
  });
});
