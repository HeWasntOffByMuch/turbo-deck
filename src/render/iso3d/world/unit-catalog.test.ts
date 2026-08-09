import { afterEach, describe, expect, it } from 'vitest';
import { EntityKind } from '../../../server/net/protocol.js';
import { appearanceOf } from './appearance.js';
import { authoredUnitFor, authoredUnits, setAuthoredUnits } from './unit-catalog.js';

afterEach(() => {
  setAuthoredUnits({});
});

describe('authoredUnitFor', () => {
  it('is null for everything by default', () => {
    // The dev mannequin is a grey untextured figure. Shipping it into the arena
    // as a live enemy would be a worse default than the rig that is there.
    for (const kind of [EntityKind.Player, EntityKind.Monster, EntityKind.Prop, EntityKind.Projectile]) {
      expect(authoredUnitFor(appearanceOf({ kind, typeId: 'grazer' })), String(kind)).toBeNull();
    }
  });

  it('draws a monster from its authored unit once one is named', () => {
    setAuthoredUnits({ grazer: 'mannequin' });
    expect(authoredUnitFor(appearanceOf({ kind: EntityKind.Monster, typeId: 'grazer' }))).toBe('mannequin');
  });

  it('leaves every other monster alone', () => {
    setAuthoredUnits({ grazer: 'mannequin' });
    expect(authoredUnitFor(appearanceOf({ kind: EntityKind.Monster, typeId: 'ravager' }))).toBeNull();
  });

  it('ignores an entry naming a player, a prop or a projectile', () => {
    // A typo in a roster file must not put a mannequin where the arrow should
    // be: a projectile has no skeleton and a prop does not move.
    setAuthoredUnits({ player: 'mannequin', arrow: 'mannequin', rock: 'mannequin' });
    expect(authoredUnitFor(appearanceOf({ kind: EntityKind.Player, typeId: 'player' }))).toBeNull();
    expect(authoredUnitFor(appearanceOf({ kind: EntityKind.Projectile, typeId: 'arrow' }))).toBeNull();
    expect(authoredUnitFor(appearanceOf({ kind: EntityKind.Prop, typeId: 'rock' }))).toBeNull();
  });

  it('replaces the table rather than merging into it', () => {
    // Setting the table is describing the whole roster; a merge would make
    // "remove a unit" impossible to say.
    setAuthoredUnits({ grazer: 'mannequin' });
    setAuthoredUnits({ ravager: 'mannequin' });
    expect(authoredUnits()).toEqual({ ravager: 'mannequin' });
  });
});
