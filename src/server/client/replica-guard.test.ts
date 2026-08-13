/**
 * What a replicated body's guard does after the first frame (spec 147).
 *
 * The bug this file exists for is a whole branch that was never written: the
 * first-sight path read `poise` and `shield` and the incremental path did not,
 * so a body's guard was whatever it happened to have when the client first saw
 * it and never moved again. Nothing on this side reads either field except the
 * bar, so a value frozen at spawn and a value tracking the server are the same
 * to every test that only asks whether the number arrived -- which is why this
 * one drives a *sequence* and asserts the value changed, rather than one delta
 * and asserts it is present.
 */

import { describe, expect, it } from 'vitest';
import { EntityField } from '../net/protocol.js';
import { ReplicatedWorld } from './replica.js';
import type { EntityDelta } from '../net/messages.js';

const SPAWN: EntityDelta = {
  id: 7,
  fields:
    EntityField.Spawn |
    EntityField.Position |
    EntityField.Health |
    EntityField.Poise |
    EntityField.Shield,
  kind: 1,
  typeId: 'grazer',
  position: { x: 0, y: 0, z: 0 },
  health: 24,
  maxHealth: 24,
  poise: 1,
  shield: 0,
  shieldUntilTick: 0,
};

describe('a replicated guard', () => {
  it('follows the server after first sight, rather than freezing at spawn', () => {
    const world = new ReplicatedWorld();
    world.apply(1, [], [SPAWN]);
    expect(world.get(7)?.poise).toBe(1);

    // A blow lands: the server sends poise alone, with no Spawn bit.
    world.apply(2, [], [{ id: 7, fields: EntityField.Poise, poise: 0.5 }]);
    expect(world.get(7)?.poise).toBe(0.5);

    // ...and the guard refills.
    world.apply(3, [], [{ id: 7, fields: EntityField.Poise, poise: 1 }]);
    expect(world.get(7)?.poise).toBe(1);
  });

  it('follows a shield too, and keeps its expiry', () => {
    const world = new ReplicatedWorld();
    world.apply(1, [], [SPAWN]);
    world.apply(
      2,
      [],
      [{ id: 7, fields: EntityField.Shield, shield: 30, shieldUntilTick: 400 }],
    );
    expect(world.get(7)?.shield).toBe(30);
    expect(world.get(7)?.shieldUntilTick).toBe(400);
  });

  it('leaves the guard alone on a delta that does not carry one', () => {
    // The other half of the rule: a field is applied when its bit is set and
    // never otherwise, or a position-only delta would quietly reset the bar.
    const world = new ReplicatedWorld();
    world.apply(1, [], [SPAWN]);
    world.apply(2, [], [{ id: 7, fields: EntityField.Poise, poise: 0.25 }]);
    world.apply(3, [], [{ id: 7, fields: EntityField.Position, position: { x: 5, y: 5, z: 0 } }]);
    expect(world.get(7)?.poise).toBe(0.25);
    expect(world.get(7)?.x).toBe(5);
  });
});
