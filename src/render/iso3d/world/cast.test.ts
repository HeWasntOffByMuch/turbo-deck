import { describe, expect, it } from 'vitest';
import { castBar } from './cast.js';
import { abilityById } from '../../../server/data/abilities.js';
import { CastPhaseValue } from '../../../server/net/protocol.js';

const heavy = abilityById('melee.heavy');
const drain = abilityById('channel.drain');

describe('castBar', () => {
  it('fills across the wind-up and is cancellable the whole way', () => {
    expect(heavy).not.toBeNull();
    if (!heavy) return;
    const windup = heavy.windupTicks;
    const cast = {
      abilityId: heavy.id,
      phase: CastPhaseValue.Windup,
      releaseTick: 1000,
      endTick: 1000,
    };

    expect(castBar(cast, 1000 - windup, heavy).progress).toBeCloseTo(0, 9);
    expect(castBar(cast, 1000 - windup / 2, heavy).progress).toBeCloseTo(0.5, 9);
    expect(castBar(cast, 1000, heavy).progress).toBeCloseTo(1, 9);
    expect(castBar(cast, 1000 - 1, heavy).cancellable).toBe(true);
  });

  it('advances on a fractional tick, so the bar is not drawn in 20Hz steps', () => {
    expect(heavy).not.toBeNull();
    if (!heavy) return;
    const cast = { abilityId: heavy.id, phase: CastPhaseValue.Windup, releaseTick: 100, endTick: 140 };

    const a = castBar(cast, 90, heavy).progress;
    const b = castBar(cast, 90.5, heavy).progress;
    expect(b).toBeGreaterThan(a);
  });

  it('fills across a channel between its release and its end', () => {
    expect(drain).not.toBeNull();
    if (!drain) return;
    const cast = { abilityId: drain.id, phase: CastPhaseValue.Channel, releaseTick: 500, endTick: 620 };

    expect(castBar(cast, 500, drain).progress).toBeCloseTo(0, 9);
    expect(castBar(cast, 560, drain).progress).toBeCloseTo(0.5, 9);
    expect(castBar(cast, 620, drain).progress).toBeCloseTo(1, 9);
  });

  it('stays inside 0..1 however far off the tick is', () => {
    expect(heavy).not.toBeNull();
    if (!heavy) return;
    for (const phase of [CastPhaseValue.Windup, CastPhaseValue.Channel]) {
      const cast = { abilityId: heavy.id, phase, releaseTick: 100, endTick: 140 };
      for (const tick of [-9999, 0, 99, 100, 139, 140, 99999]) {
        const bar = castBar(cast, tick, heavy);
        expect(bar.progress).toBeGreaterThanOrEqual(0);
        expect(bar.progress).toBeLessThanOrEqual(1);
      }
    }
  });

  it('does not divide by zero for an ability it cannot look up', () => {
    const cast = { abilityId: 'gone', phase: CastPhaseValue.Windup, releaseTick: 10, endTick: 10 };
    const bar = castBar(cast, 10, null);
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
      abilityId: 'melee.heavy',
      phase: CastPhaseValue.Turning,
      releaseTick: 100,
      endTick: 140,
    };
    for (const tick of [0, 50, 99, 100, 200, 5000]) {
      const bar = castBar(cast, tick, heavy);
      expect(bar.progress).toBe(0);
      expect(bar.cancellable).toBe(true);
      expect(bar.turning).toBe(true);
    }
  });

  it('is the only phase that reports turning', () => {
    for (const phase of [CastPhaseValue.Windup, CastPhaseValue.Channel]) {
      const cast = { abilityId: 'melee.heavy', phase, releaseTick: 100, endTick: 140 };
      expect(castBar(cast, 100, heavy).turning).toBe(false);
    }
  });
});
