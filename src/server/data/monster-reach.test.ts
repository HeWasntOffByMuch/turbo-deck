/**
 * A monster has to be able to reach what it is walking at (spec 186).
 *
 * Since blocking arrived there are two distances in every melee approach and
 * nothing in the type system makes them agree. A monster closes until its
 * centre is `STANDOFF_FRACTION * (range + targetRadius)` from its target, and
 * it is refused any step that would put it closer than the two bodies are wide.
 * If the second is larger than the first, the monster stops where it is told to
 * and is *still* out of range: it stands in front of the player for ever,
 * holding a sword, swinging at nothing.
 *
 * That is invisible from every other angle. The row validates, the monster
 * spawns, it paths correctly, it faces you, and it never attacks -- and the
 * cause is the interaction of two numbers written in two different files. So it
 * is asserted here rather than discovered in a playtest, in the same spirit as
 * the attribute-pair table: a row that cannot work fails CI.
 */

import { describe, expect, it } from 'vitest';

import { SERVER_PLAYER_RADIUS } from '../config.js';
import { abilityById } from './abilities.js';
import { MONSTERS } from './monsters.js';

/** Kept in step with `world.ts`, which is the only other place it appears. */
const STANDOFF_FRACTION = 0.8;

describe('every monster that attacks', () => {
  it('stops inside its own reach rather than outside it', () => {
    for (const monster of MONSTERS.values()) {
      const swing = abilityById(monster.stats.basicAttackId);
      if (!swing) continue;
      if (monster.stats.moveSpeed <= 0) continue;

      const reach = (swing.range + SERVER_PLAYER_RADIUS) * STANDOFF_FRACTION;
      // The closest a blocked body can get: the two radii touching.
      const touch = monster.radius + SERVER_PLAYER_RADIUS;
      expect(
        reach,
        `${monster.id} stops at ${touch.toFixed(1)} but only reaches ${reach.toFixed(1)}`,
      ).toBeGreaterThan(touch);
    }
  });

  it('leaves room for the approach slot inside that reach', () => {
    // The ring a pack stands on is placed `SLOT_ARRIVE_EPS` inside the reach so
    // a body that stops short of its slot can still swing. That only works
    // while the ring is still outside the touching distance.
    const SLOT_ARRIVE_EPS = 10;
    for (const monster of MONSTERS.values()) {
      const swing = abilityById(monster.stats.basicAttackId);
      if (!swing || monster.stats.moveSpeed <= 0) continue;
      const ring = (swing.range + SERVER_PLAYER_RADIUS) * STANDOFF_FRACTION - SLOT_ARRIVE_EPS;
      expect(ring, `${monster.id}'s approach ring falls inside its own target`).toBeGreaterThan(
        monster.radius + SERVER_PLAYER_RADIUS,
      );
    }
  });
});
