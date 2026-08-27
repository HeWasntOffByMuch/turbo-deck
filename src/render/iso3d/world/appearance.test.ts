import { describe, expect, it } from 'vitest';
import { appearanceOf, bleedsFor, BLOODLESS_IDS, displayName, PLAYER_CRITTER, PLAYER_FIGURE } from './appearance.js';
import { ALL_MONSTERS, monsterById } from '../../../server/data/monsters.js';
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

  it('draws a thrown weapon as one and a conjured shot as an orb', () => {
    expect(appearanceOf({ kind: EntityKind.Projectile, typeId: 'ranged.shot' }).look).toBe('arrow');
    expect(appearanceOf({ kind: EntityKind.Projectile, typeId: 'ranged.star' }).look).toBe(
      'shuriken',
    );
    for (const id of ['bolt.arcane', 'bolt.lob', 'bolt.seek']) {
      expect(appearanceOf({ kind: EntityKind.Projectile, typeId: id }).look, id).toBe('orb');
    }
    // The staff's shot is the fourth look (spec 218), and the one that is mostly
    // paint: `shot.ts` draws half a collision radius of core and `shot_ember`
    // draws the rest of the silhouette.
    expect(appearanceOf({ kind: EntityKind.Projectile, typeId: 'ranged.ember' }).look).toBe('ember');
    // A row that says nothing draws as what every shot drew before spec 087.
    expect(appearanceOf({ kind: EntityKind.Projectile, typeId: 'nothing.like.this' }).look).toBe(
      'orb',
    );
  });

  it('gives a look only to things that are shots', () => {
    for (const kind of [EntityKind.Player, EntityKind.Monster, EntityKind.Prop]) {
      expect(appearanceOf({ kind, typeId: 'grazer' }).look).toBeNull();
    }
    for (const ability of ALL_ABILITIES) {
      if (!ability.projectile) continue;
      expect(appearanceOf({ kind: EntityKind.Projectile, typeId: ability.id }).look).not.toBeNull();
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

describe('what a body is made of', () => {
  /**
   * The bug this exists to make impossible.
   *
   * `view.ts` hardcoded `bleeds: true` at both fact sites, so every blow in the
   * game routed to `combat.hit.flesh` and `combat.hit.armored` was unreachable
   * -- a training dummy threw blood, and the only thing separating a sheep from
   * a shield was which files somebody happened to assign.
   */
  it('cuts an animal and strikes a construct', () => {
    expect(bleedsFor({ kind: EntityKind.Monster, typeId: 'sheep' })).toBe(true);
    expect(bleedsFor({ kind: EntityKind.Monster, typeId: 'grazer' })).toBe(true);
    expect(bleedsFor({ kind: EntityKind.Monster, typeId: 'dummy' })).toBe(false);
  });

  it('bleeds a player, whoever they are', () => {
    expect(bleedsFor({ kind: EntityKind.Player, typeId: 'player' })).toBe(true);
    expect(bleedsFor({ kind: EntityKind.Player, typeId: '', name: 'Ada' })).toBe(true);
  });

  /**
   * A deny list, so the default is flesh.
   *
   * That is the right way round for a bestiary of animals: a monster added
   * tomorrow is flesh unless somebody says otherwise, and forgetting a row
   * costs a sheep that sounds like a sheep rather than one that clangs.
   */
  it('bleeds a monster nobody has written a row for', () => {
    expect(bleedsFor({ kind: EntityKind.Monster, typeId: 'wyvern' })).toBe(true);
  });

  it('says no for everything a blow never lands on', () => {
    for (const kind of [EntityKind.Projectile, EntityKind.Prop, EntityKind.Mote, EntityKind.Drop]) {
      expect(bleedsFor({ kind, typeId: 'whatever' })).toBe(false);
    }
  });

  it('never claims a monster the game does not have', () => {
    // The deny list is by type id, and a typo in it is a construct that bleeds
    // with every test green. Every id named has to be a real row.
    for (const typeId of BLOODLESS_IDS) {
      expect(monsterById(typeId), typeId).toBeDefined();
    }
  });
});
