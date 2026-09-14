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

  describe('the follow-through cancel point (spec 283)', () => {
    const backswing = 24;
    const bar = (phase: number, tick: number, pct: number | null = null) =>
      castBar(
        { abilityId: 'melee.slash', phase, startTick: 940, releaseTick: 1000, endTick: 1000 + backswing },
        tick,
        pct,
      );

    it('marks nothing in any phase but the follow-through', () => {
      // A wind-up may be withdrawn from on every tick of itself and a channel
      // has no follow-through, so a mark on either claims a boundary that does
      // not exist. Passed a fraction anyway, so this pins the phase rule rather
      // than the absence of an argument.
      expect(bar(CastPhaseValue.Turning, 1000, 0.5).cancelAt).toBeNull();
      expect(bar(CastPhaseValue.Windup, 980, 0.5).cancelAt).toBeNull();
      expect(bar(CastPhaseValue.Channel, 1010, 0.5).cancelAt).toBeNull();
    });

    it('marks nothing for a caller that does not know the fraction', () => {
      // Every body but the local player: this client holds nobody else's traits
      // or Flow stacks, and the default keeps every caller written before this
      // existed drawing exactly what it drew.
      expect(bar(CastPhaseValue.Backswing, 1010).cancelAt).toBeNull();
    });

    it('puts the mark on the tick the rule lands on, not on the raw fraction', () => {
      // `backswingCancelTicksFrom` rounds to a whole tick, so 0.5 of a 24-tick
      // phase is tick 12 and the mark is exactly half way. A fraction passed
      // straight through would agree here and disagree wherever it rounds.
      expect(bar(CastPhaseValue.Backswing, 1010, 0.5).cancelAt).toBeCloseTo(0.5, 9);
      // 0.54 of 24 is 12.96, which rounds to 13 -- so the mark sits at 13/24
      // rather than at 0.54.
      expect(bar(CastPhaseValue.Backswing, 1010, 0.54).cancelAt).toBeCloseTo(13 / 24, 9);
    });

    it('stays inside the bar for a fraction outside 0..1', () => {
      // The traits this is read off arrive from the wire, and clamping here is
      // cheaper than trusting `backswingCancelPointOf`'s own clamp to be the
      // only path a number can take to get here.
      expect(bar(CastPhaseValue.Backswing, 1010, -1).cancelAt).toBeGreaterThanOrEqual(0);
      expect(bar(CastPhaseValue.Backswing, 1010, 4).cancelAt).toBeLessThanOrEqual(1);
    });

    it('agrees with the rule that roots the legs: progress reaches the mark on the freeing tick', () => {
      // The one property worth asserting, because it is what makes the mark
      // honest rather than decorative. `game-client.ts` frees the body on the
      // first tick at or past `releaseTick + backswingCancelTicksFrom(span,pct)`,
      // and this walks the same span and checks the bar arrives there with it.
      const pct = 0.45;
      const freeAt = 1000 + Math.round(backswing * pct);
      const mark = bar(CastPhaseValue.Backswing, 1000, pct).cancelAt ?? -1;
      expect(bar(CastPhaseValue.Backswing, freeAt - 1, pct).progress).toBeLessThan(mark);
      expect(bar(CastPhaseValue.Backswing, freeAt, pct).progress).toBeGreaterThanOrEqual(mark);
    });
  });
});
