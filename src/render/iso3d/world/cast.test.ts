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
      endTick: 1000 + heavy.recoveryTicks,
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

  it('drains through recovery, and says the decision is made', () => {
    expect(heavy).not.toBeNull();
    if (!heavy) return;
    const cast = { abilityId: heavy.id, phase: CastPhaseValue.Recovery, releaseTick: 200, endTick: 240 };

    expect(castBar(cast, 200, heavy).progress).toBeCloseTo(1, 9);
    expect(castBar(cast, 220, heavy).progress).toBeCloseTo(0.5, 9);
    expect(castBar(cast, 240, heavy).progress).toBeCloseTo(0, 9);
    expect(castBar(cast, 210, heavy).cancellable).toBe(false);
  });

  it('stays inside 0..1 however far off the tick is', () => {
    expect(heavy).not.toBeNull();
    if (!heavy) return;
    for (const phase of [CastPhaseValue.Windup, CastPhaseValue.Channel, CastPhaseValue.Recovery]) {
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
