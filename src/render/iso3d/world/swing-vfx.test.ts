/**
 * The sweep a melee swing paints (spec 230).
 *
 * Driven end to end against a recording player, the way `shot-vfx.test.ts` and
 * `affliction-vfx.test.ts` are: the driver is pure, so the whole feature is
 * exercised in Node with no canvas and no GL.
 *
 * What the tests are built around is that this fires on an **edge**. Every
 * interesting failure is a repeat or a miss -- a sweep painted twice because a
 * cast ran on through its backswing, or one painted for a body that walked into
 * view with the blade already fallen.
 */

import { describe, expect, it } from 'vitest';
import { abilityById } from '../../../server/data/abilities.js';
import { REGISTRY } from '../vfx/registry.js';
import {
  isMeleeAbility,
  SWING_ART,
  SwingVfx,
  swingAbilityIds,
  swingArtFor,
  swingSeed,
  type SwingBody,
  type SwingVfxPlayer,
} from './swing-vfx.js';

interface Played {
  readonly id: string;
  readonly rotation: number;
  readonly seed: number;
}

function recorder(known: readonly string[] = Object.values(SWING_ART)): {
  player: SwingVfxPlayer;
  played: Played[];
} {
  const played: Played[] = [];
  const set = new Set(known);
  return {
    played,
    player: {
      has: (id) => set.has(id),
      play: (id, options) => {
        played.push({ id, rotation: options.rotation, seed: options.seed });
        return played.length;
      },
    },
  };
}

function body(overrides: Partial<SwingBody> = {}): SwingBody {
  return {
    entityId: 7,
    x: 120,
    y: 14,
    z: -60,
    facing: 0.9,
    abilityId: 'skill.rendingCut',
    releaseTick: 100,
    ...overrides,
  };
}

describe('the swing table', () => {
  it('names only effects the registry holds', () => {
    for (const [abilityId, effect] of Object.entries(SWING_ART)) {
      expect(REGISTRY.byId.has(effect), `${abilityId} -> ${effect}`).toBe(true);
    }
  });

  it('names only melee abilities', () => {
    // A sweep on a projectile would be a blade swung at nothing.
    for (const abilityId of swingAbilityIds()) {
      expect(abilityById(abilityId), abilityId).toBeDefined();
      expect(isMeleeAbility(abilityId), abilityId).toBe(true);
    }
  });

  it('leaves Whirlwind out, because its own impact message draws it', () => {
    // `landArea` sends `skill.whirlwind.impact` at the caster's feet before its
    // target loop, so a row here as well would paint the turn twice.
    expect(SWING_ART['skill.whirlwind']).toBeUndefined();
    expect(REGISTRY.byId.has('skill.whirlwind.impact')).toBe(true);
  });

  it('answers null for an ability with no sweep, and for nothing at all', () => {
    expect(swingArtFor('melee.slash')).toBeNull();
    expect(swingArtFor('no.such.ability')).toBeNull();
    expect(swingArtFor(null)).toBeNull();
    expect(swingArtFor(undefined)).toBeNull();
  });
});

describe('SwingVfx', () => {
  it('paints once, on the release tick', () => {
    const { player, played } = recorder();
    const vfx = new SwingVfx(player);
    vfx.step([body()], 99);
    expect(played).toHaveLength(0);
    vfx.step([body()], 100);
    expect(played).toHaveLength(1);
    expect(played[0]?.id).toBe('swing_arc');
  });

  it('does not paint again while the same cast runs on', () => {
    // The failure this exists for: a melee cast lives through its backswing, so
    // it is still in the cast list for many frames after the blow landed.
    const { player, played } = recorder();
    const vfx = new SwingVfx(player);
    for (let tick = 100; tick < 130; tick += 1) vfx.step([body()], tick);
    expect(played).toHaveLength(1);
  });

  it('paints again for the next swing', () => {
    const { player, played } = recorder();
    const vfx = new SwingVfx(player);
    vfx.step([body({ releaseTick: 100 })], 100);
    vfx.step([body({ releaseTick: 160 })], 160);
    expect(played).toHaveLength(2);
  });

  it('draws nothing for a body first seen after its blade fell', () => {
    // A contact rather than a state: there is no release this client watched,
    // and drawing one would paint a blade that already landed.
    const { player, played } = recorder();
    const vfx = new SwingVfx(player);
    // The body arrives 20 ticks into its own backswing.
    vfx.step([body({ releaseTick: 100 })], 120);
    expect(played).toHaveLength(1);
  });

  it('aims the sweep along the drawn facing', () => {
    const { player, played } = recorder();
    const vfx = new SwingVfx(player);
    vfx.step([body({ facing: -2.4 })], 100);
    expect(played[0]?.rotation).toBe(-2.4);
  });

  it('gives Stunning Blow the louder sweep', () => {
    const { player, played } = recorder();
    const vfx = new SwingVfx(player);
    vfx.step([body({ abilityId: 'skill.stunningBlow' })], 100);
    expect(played[0]?.id).toBe('swing_arc_heavy');
  });

  it('draws nothing for an ability with no sweep', () => {
    const { player, played } = recorder();
    const vfx = new SwingVfx(player);
    vfx.step([body({ abilityId: 'melee.slash' })], 100);
    expect(played).toHaveLength(0);
  });

  it('draws nothing when the registry has never heard of the effect', () => {
    // A refusal rather than a throw inside the render loop.
    const { player, played } = recorder([]);
    const vfx = new SwingVfx(player);
    vfx.step([body()], 100);
    expect(played).toHaveLength(0);
  });

  it('lets a forgotten body swing again', () => {
    const { player, played } = recorder();
    const vfx = new SwingVfx(player);
    vfx.step([body()], 100);
    vfx.forget(7);
    vfx.step([body()], 100);
    expect(played).toHaveLength(2);
  });

  it('keeps two bodies apart', () => {
    const { player, played } = recorder();
    const vfx = new SwingVfx(player);
    vfx.step([body({ entityId: 1 }), body({ entityId: 2 })], 100);
    expect(played).toHaveLength(2);
    vfx.step([body({ entityId: 1 }), body({ entityId: 2 })], 101);
    expect(played).toHaveLength(2);
  });

  it('seeds from where and when, so two clients paint the same sweep', () => {
    expect(swingSeed(body())).toBe(swingSeed(body()));
    expect(swingSeed(body())).not.toBe(swingSeed(body({ releaseTick: 101 })));
    expect(swingSeed(body())).not.toBe(swingSeed(body({ x: 400 })));
  });
});
