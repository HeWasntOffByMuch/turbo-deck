import { describe, expect, it } from 'vitest';
import { WARDEN_LASER } from '../../../server/data/warden.js';
import { CastPhase } from '../../../server/sim/types.js';
import { CORE_FRACTION, LOCK_ON_WIDTH, beamLookFor, type BeamCast } from './warden-beam.js';

const LOCK_ON: BeamCast = {
  abilityId: WARDEN_LASER.abilityId,
  phase: CastPhase.Windup,
  startTick: 100,
  releaseTick: 100 + WARDEN_LASER.lockOnTicks,
};
const FIRING: BeamCast = { ...LOCK_ON, phase: CastPhase.Channel };

describe('the lance, drawn (spec 259)', () => {
  it('draws nothing over a body that has no cycle, whatever it is casting', () => {
    expect(beamLookFor('ravager', FIRING, 200)).toBeNull();
    expect(beamLookFor('player', FIRING, 200)).toBeNull();
  });

  it('draws nothing over a Warden that is not aiming or firing', () => {
    expect(beamLookFor('warden', null, 200)).toBeNull();
    // Its melee swing is a cast like any other and is not a lance.
    expect(
      beamLookFor('warden', { ...LOCK_ON, abilityId: 'melee.slash' }, 200),
    ).toBeNull();
  });

  it('tells the two phases apart by width, not by brightness alone', () => {
    const aiming = beamLookFor('warden', LOCK_ON, 150);
    const firing = beamLookFor('warden', FIRING, 250);
    expect(aiming).not.toBeNull();
    expect(firing).not.toBeNull();
    if (!aiming || !firing) return;

    expect(aiming.firing).toBe(false);
    expect(firing.firing).toBe(true);
    // The rule the whole picture rests on: the retro pass quantizes brightness
    // and cannot quantize a shape, so a telegraph that differed from the blow
    // only in opacity would be a telegraph some frames do not show at all.
    expect(firing.width).toBeGreaterThan(aiming.width * 5);
    expect(aiming.width).toBe(LOCK_ON_WIDTH);
  });

  it('draws the beam at the width that actually damages', () => {
    // What you can see is what will hit you. Read off the row rather than
    // pinned, so a retune moves the picture with the mechanic.
    const firing = beamLookFor('warden', FIRING, 250);
    expect(firing?.width).toBe(WARDEN_LASER.width);
    expect(firing?.length).toBe(WARDEN_LASER.range);
    expect(firing?.coreWidth).toBeCloseTo(WARDEN_LASER.width * CORE_FRACTION, 5);
  });

  it('reaches as far while aiming as it will when it fires', () => {
    // The line has to promise the whole lane's reach: a pointer that stopped
    // short would say a player standing past its end was safe.
    expect(beamLookFor('warden', LOCK_ON, 150)?.length).toBe(WARDEN_LASER.range);
  });

  it('brightens as the lock-on settles, and never dims', () => {
    const at = (tick: number): number => beamLookFor('warden', LOCK_ON, tick)?.opacity ?? 0;
    const start = at(LOCK_ON.startTick);
    const middle = at(LOCK_ON.startTick + WARDEN_LASER.lockOnTicks / 2);
    const end = at(LOCK_ON.releaseTick);
    expect(middle).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(middle);
    // Still visibly weaker than the beam it precedes -- the pointer at its
    // brightest against the core at its dimmest, which is the comparison that
    // has to hold rather than the one that happens to on some tick.
    const cores = Array.from(
      { length: 60 },
      (_, tick) => beamLookFor('warden', FIRING, tick)?.coreOpacity ?? 0,
    );
    expect(end).toBeLessThan(Math.min(...cores));
  });

  it('clamps the ramp rather than running past either end', () => {
    // A cast whose ticks a client picked up late or is holding stale: neither is
    // a reason to draw an invisible line or an opacity a material rounds to one.
    const before = beamLookFor('warden', LOCK_ON, LOCK_ON.startTick - 90);
    const after = beamLookFor('warden', LOCK_ON, LOCK_ON.releaseTick + 90);
    expect(before?.opacity).toBe(beamLookFor('warden', LOCK_ON, LOCK_ON.startTick)?.opacity);
    expect(after?.opacity).toBe(beamLookFor('warden', LOCK_ON, LOCK_ON.releaseTick)?.opacity);
  });

  it('keeps every opacity inside what a material can express', () => {
    // The shimmer is a multiplier, and three accepts an opacity over one and
    // then draws it as one -- so an unclamped core would flatten at the top of
    // every cycle and the breathing would only ever be a dimming.
    for (let tick = 0; tick < 240; tick++) {
      const look = beamLookFor('warden', FIRING, tick);
      expect(look).not.toBeNull();
      if (!look) continue;
      expect(look.opacity).toBeGreaterThan(0);
      expect(look.opacity).toBeLessThanOrEqual(1);
      expect(look.coreOpacity).toBeGreaterThan(0);
      expect(look.coreOpacity).toBeLessThanOrEqual(1);
    }
  });

  it('breathes while it fires, and holds the lane steady while it does', () => {
    const looks = Array.from({ length: 60 }, (_, tick) => beamLookFor('warden', FIRING, tick));
    const cores = looks.map((look) => look?.coreOpacity ?? 0);
    const lanes = looks.map((look) => look?.opacity ?? 0);
    const widths = looks.map((look) => look?.width ?? 0);
    // The core moves.
    expect(Math.max(...cores) - Math.min(...cores)).toBeGreaterThan(0.05);
    // The outer band does not, and neither does the width: what the shimmer must
    // never do is make the danger zone look like it is changing size.
    expect(new Set(lanes).size).toBe(1);
    expect(new Set(widths).size).toBe(1);
  });

  it('is the same picture on every client, because the tick is an argument', () => {
    const a = beamLookFor('warden', FIRING, 4242);
    const b = beamLookFor('warden', FIRING, 4242);
    expect(a).toEqual(b);
  });

  it('draws the lock-on with no core, so the line is one line', () => {
    const aiming = beamLookFor('warden', LOCK_ON, 150);
    expect(aiming?.coreWidth).toBe(0);
  });

  it('draws a turning cast as a lock-on, not as nothing', () => {
    // `castAngleDeg: 360` means the shipped row never turns -- but a row that
    // did would still be aiming, and a phase this function did not recognise
    // would be a Warden with a live cast and no picture at all.
    const turning = beamLookFor('warden', { ...LOCK_ON, phase: CastPhase.Turning }, 150);
    expect(turning?.firing).toBe(false);
    expect(turning?.width).toBe(LOCK_ON_WIDTH);
  });
});
