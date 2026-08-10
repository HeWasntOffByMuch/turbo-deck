import { afterEach, describe, expect, it } from 'vitest';
import { EntityKind } from '../../../server/net/protocol.js';
import { appearanceOf } from './appearance.js';
import { authoredUnitIds } from './unit-assets.js';
import { authoredUnitFor, authoredUnits, setAuthoredUnits, unitsFromQuery } from './unit-catalog.js';

afterEach(() => {
  setAuthoredUnits({});
});

describe('authoredUnitFor', () => {
  it('draws the player from the generated unit by default, and nothing else', () => {
    // The default table has exactly one row. The player is the body somebody
    // looks at for hours, so it is the one that has to prove the format; every
    // other entity still falls through to the rig it always drew, which is the
    // property this seam exists to keep.
    expect(authoredUnitFor(appearanceOf({ kind: EntityKind.Player, typeId: 'player' }))).toBe('pig_a_pose_full');
    for (const kind of [EntityKind.Monster, EntityKind.Prop, EntityKind.Projectile]) {
      expect(authoredUnitFor(appearanceOf({ kind, typeId: 'grazer' })), String(kind)).toBeNull();
    }
  });

  it('falls back to the old rig when the named unit is not in this build', () => {
    // The default ships pointing at a generated unit. A checkout where that unit
    // has not been baked must still render a game rather than a hole.
    setAuthoredUnits({ player: 'no-such-unit' });
    expect(authoredUnitFor(appearanceOf({ kind: EntityKind.Player, typeId: 'player' }))).toBeNull();
  });

  it('draws a monster from its authored unit once one is named', () => {
    setAuthoredUnits({ grazer: 'mannequin' });
    expect(authoredUnitFor(appearanceOf({ kind: EntityKind.Monster, typeId: 'grazer' }))).toBe('mannequin');
  });

  it('leaves every other monster alone', () => {
    setAuthoredUnits({ grazer: 'mannequin' });
    expect(authoredUnitFor(appearanceOf({ kind: EntityKind.Monster, typeId: 'ravager' }))).toBeNull();
  });

  it('honours a player entry, and still ignores a prop or a projectile', () => {
    // A typo in a roster file must not put a mannequin where the arrow should
    // be: a projectile has no skeleton and a prop does not move. The player is
    // no longer in that company -- it has a skeleton and it moves.
    setAuthoredUnits({ player: 'mannequin', arrow: 'mannequin', rock: 'mannequin' });
    expect(authoredUnitFor(appearanceOf({ kind: EntityKind.Player, typeId: 'player' }))).toBe('mannequin');
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

describe('the roster is discovered, not listed (spec 113)', () => {
  it('finds every unit the manifest carries', () => {
    // The registry used to be five hardcoded imports naming one unit, which
    // meant the answer to "I exported a unit, now what" was "nothing". Adding
    // one is exporting it and re-baking; no code changes.
    expect(authoredUnitIds()).toContain('mannequin');
  });

  it('accepts a `?units=` naming a unit this build actually has', () => {
    expect(unitsFromQuery('?units=grazer:mannequin')).toEqual({ grazer: 'mannequin' });
  });

  it('refuses one that was never exported, rather than drawing the old rig', () => {
    // Almost always a typo, and silently falling back is how a typo survives.
    expect(unitsFromQuery('?units=grazer:no-such-unit')).toEqual({});
  });

  it('keeps the pairs it can resolve and drops the ones it cannot', () => {
    expect(unitsFromQuery('?units=grazer:mannequin,ravager:ghost')).toEqual({ grazer: 'mannequin' });
  });

  it('is empty without the switch, so the arena is unchanged', () => {
    expect(unitsFromQuery('')).toEqual({});
    expect(unitsFromQuery('?seed=7')).toEqual({});
  });
});
