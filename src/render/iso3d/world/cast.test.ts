import { describe, expect, it } from 'vitest';
import { castBar } from './cast.js';
import { abilityById } from '../../../server/data/abilities.js';
import { CastPhaseValue } from '../../../server/net/protocol.js';

const heavy = abilityById('skill.stunningBlow');

describe('castBar', () => {
  it('fills across the wind-up and is cancellable the whole way', () => {
    expect(heavy).not.toBeNull();
    if (!heavy) return;
    const windup = heavy.windupTicks;
    const cast = {
      abilityId: heavy.id,
      phase: CastPhaseValue.Windup,
      startTick: 1000 - windup,
      releaseTick: 1000,
      endTick: 1000,
    };

    expect(castBar(cast, 1000 - windup).progress).toBeCloseTo(0, 9);
    expect(castBar(cast, 1000 - windup / 2).progress).toBeCloseTo(0.5, 9);
    expect(castBar(cast, 1000).progress).toBeCloseTo(1, 9);
    expect(castBar(cast, 1000 - 1).cancellable).toBe(true);
  });

  it('advances on a fractional tick, so the bar is not drawn in 20Hz steps', () => {
    expect(heavy).not.toBeNull();
    if (!heavy) return;
    const cast = {
      abilityId: heavy.id,
      phase: CastPhaseValue.Windup,
      startTick: 100 - heavy.windupTicks,
      releaseTick: 100,
      endTick: 140,
    };

    const a = castBar(cast, 90).progress;
    const b = castBar(cast, 90.5).progress;
    expect(b).toBeGreaterThan(a);
  });

  // No shipped row is `kind: 'channel'` any more (spec 232), and this test does
  // not need one: `castBar` reads the *phase* off the cast and the ticks either
  // side of it, so what is under test is `CastPhaseValue.Channel` rather than
  // the ability's kind. The last case in this file always drove it that way.
  it('fills across a channel between its release and its end', () => {
    expect(heavy).not.toBeNull();
    if (!heavy) return;
    const cast = {
      abilityId: heavy.id,
      phase: CastPhaseValue.Channel,
      startTick: 500 - heavy.windupTicks,
      releaseTick: 500,
      endTick: 620,
    };

    expect(castBar(cast, 500).progress).toBeCloseTo(0, 9);
    expect(castBar(cast, 560).progress).toBeCloseTo(0.5, 9);
    expect(castBar(cast, 620).progress).toBeCloseTo(1, 9);
  });

  it('stays inside 0..1 however far off the tick is', () => {
    expect(heavy).not.toBeNull();
    if (!heavy) return;
    for (const phase of [CastPhaseValue.Windup, CastPhaseValue.Channel]) {
      const cast = { abilityId: heavy.id, phase, startTick: 60, releaseTick: 100, endTick: 140 };
      for (const tick of [-9999, 0, 99, 100, 139, 140, 99999]) {
        const bar = castBar(cast, tick);
        expect(bar.progress).toBeGreaterThanOrEqual(0);
        expect(bar.progress).toBeLessThanOrEqual(1);
      }
    }
  });

  it('does not divide by zero for an ability it cannot look up', () => {
    const cast = {
      abilityId: 'gone',
      phase: CastPhaseValue.Windup,
      startTick: 10,
      releaseTick: 10,
      endTick: 10,
    };
    const bar = castBar(cast, 10);
    expect(Number.isFinite(bar.progress)).toBe(true);
    expect(bar.progress).toBeGreaterThanOrEqual(0);
    expect(bar.progress).toBeLessThanOrEqual(1);
  });
});

describe('turning', () => {
  /**
   * Spec 065: while a body is turning into its blow, `releaseTick` is
   * provisional and the server re-stamps it at alignment. Filling a bar against
   * it would run the bar up and then reset it when the real wind-up starts.
   */
  it('shows an empty, cancellable bar whatever the provisional release says', () => {
    const cast = {
      abilityId: 'skill.stunningBlow',
      phase: CastPhaseValue.Turning,
      startTick: 60,
      releaseTick: 100,
      endTick: 140,
    };
    for (const tick of [0, 50, 99, 100, 200, 5000]) {
      const bar = castBar(cast, tick);
      expect(bar.progress).toBe(0);
      expect(bar.cancellable).toBe(true);
      expect(bar.turning).toBe(true);
    }
  });

  it('is the only phase that reports turning', () => {
    for (const phase of [CastPhaseValue.Windup, CastPhaseValue.Channel]) {
      const cast = { abilityId: 'skill.stunningBlow', phase, startTick: 60, releaseTick: 100, endTick: 140 };
      expect(castBar(cast, 100).turning).toBe(false);
    }
  });
});

describe('backswing', () => {
  /**
   * Spec 144: the follow-through is drawn, because the body is still rooted and
   * the player should see how much of it is left to walk out of -- but it is not
   * `cancellable`, because walking out of it refunds nothing. The two claims are
   * different and the renderer draws them differently.
   */
  it('fills from the attack point to the end, committed and not cancellable', () => {
    const cast = {
      abilityId: 'melee.slash',
      phase: CastPhaseValue.Backswing,
      startTick: 70,
      releaseTick: 100,
      endTick: 124,
    };

    expect(castBar(cast, 100).progress).toBeCloseTo(0, 9);
    expect(castBar(cast, 112).progress).toBeCloseTo(0.5, 9);
    expect(castBar(cast, 124).progress).toBeCloseTo(1, 9);
    expect(castBar(cast, 112).committed).toBe(true);
    expect(castBar(cast, 112).cancellable).toBe(false);
    expect(castBar(cast, 112).turning).toBe(false);
  });

  /**
   * The wind-up's length is the cast's own span, never `ability.windupTicks`.
   * A body at twice attack speed winds up in half the ticks, and a bar drawn
   * against the table would be half full when the blow landed.
   */
  it('draws a hasted wind-up against the ticks it was actually given', () => {
    const slash = abilityById('melee.slash');
    expect(slash).not.toBeNull();
    if (!slash) return;
    const hasted = Math.round(slash.windupTicks / 2);
    const cast = {
      abilityId: slash.id,
      phase: CastPhaseValue.Windup,
      startTick: 200,
      releaseTick: 200 + hasted,
      endTick: 200 + hasted + 12,
    };

    expect(castBar(cast, 200).progress).toBeCloseTo(0, 9);
    expect(castBar(cast, 200 + hasted / 2).progress).toBeCloseTo(0.5, 9);
    expect(castBar(cast, 200 + hasted).progress).toBeCloseTo(1, 9);
  });
});
