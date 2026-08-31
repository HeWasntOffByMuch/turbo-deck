import { describe, expect, it } from 'vitest';
import { WARDEN_LASER } from '../../../server/data/warden.js';
import { CastPhase } from '../../../server/sim/types.js';
import {
  BEAM_END_LIFT,
  CORE_FRACTION,
  SHAFT_FRACTION,
  beamLookFor,
  sightDotAt,
  sightDotCount,
  type BeamCast,
  type ShaftLook,
  type SightLook,
} from './warden-beam.js';

const LOCK_ON: BeamCast = {
  abilityId: WARDEN_LASER.abilityId,
  phase: CastPhase.Windup,
  startTick: 100,
  releaseTick: 100 + WARDEN_LASER.lockOnTicks,
};
const FIRING: BeamCast = { ...LOCK_ON, phase: CastPhase.Channel };

const sightAt = (tick: number): SightLook => {
  const look = beamLookFor('warden', LOCK_ON, tick);
  if (!look || look.kind !== 'lockOn') throw new Error('expected a sight');
  return look;
};
const shaftAt = (tick: number): ShaftLook => {
  const look = beamLookFor('warden', FIRING, tick);
  if (!look || look.kind !== 'firing') throw new Error('expected a shaft');
  return look;
};

describe('the lance, drawn (spec 259)', () => {
  it('draws nothing over a body that has no cycle, whatever it is casting', () => {
    expect(beamLookFor('ravager', FIRING, 200)).toBeNull();
    expect(beamLookFor('player', FIRING, 200)).toBeNull();
  });

  it('draws nothing over a Warden that is not aiming or firing', () => {
    expect(beamLookFor('warden', null, 200)).toBeNull();
    // Its melee swing is a cast like any other and is not a lance.
    expect(beamLookFor('warden', { ...LOCK_ON, abilityId: 'melee.slash' }, 200)).toBeNull();
  });

  it('tells the two phases apart by what they are made of, not by brightness', () => {
    // The rule the whole picture rests on: the retro pass quantizes brightness
    // and cannot quantize a shape, so a sight that differed from the shaft only
    // in opacity would be a telegraph some frames do not show at all. One is a
    // row of pixels and the other is a solid shaft, which no quantize can blur
    // together.
    expect(sightAt(150).kind).toBe('lockOn');
    expect(shaftAt(250).kind).toBe('firing');
    expect(sightDotCount(sightAt(150))).toBeGreaterThan(8);
  });

  it('aims down the line the beam will use, all the way to its end', () => {
    // The sight has to promise the whole lane's reach and the beam's own drop:
    // a pointer that stopped short would say a player past its end was safe, and
    // one that ran level would put the shot somewhere the beam does not go.
    const sight = sightAt(150);
    const shaft = shaftAt(250);
    expect(sight.length).toBe(WARDEN_LASER.range);
    expect(shaft.length).toBe(WARDEN_LASER.range);
    expect(sight.endLift).toBe(shaft.endLift);
    expect(shaft.endLift).toBe(BEAM_END_LIFT);
  });

  it('draws the footprint at the width that actually damages, and the shaft narrower', () => {
    // The relationship a fireball already has to its blast: what you can see is
    // smaller than the region it affects, and the mark on the ground states the
    // region. Read off the row rather than pinned, so a retune moves the picture
    // with the mechanic.
    const shaft = shaftAt(250);
    expect(shaft.footprintWidth).toBe(WARDEN_LASER.width);
    expect(shaft.width).toBeCloseTo(WARDEN_LASER.width * SHAFT_FRACTION, 5);
    expect(shaft.coreWidth).toBeCloseTo(WARDEN_LASER.width * CORE_FRACTION, 5);
    expect(shaft.width).toBeLessThan(shaft.footprintWidth);
    expect(shaft.coreWidth).toBeLessThan(shaft.width);
  });

  it('brightens as the lock-on settles, and never dims', () => {
    const start = sightAt(LOCK_ON.startTick).opacity;
    const middle = sightAt(LOCK_ON.startTick + WARDEN_LASER.lockOnTicks / 2).opacity;
    const end = sightAt(LOCK_ON.releaseTick).opacity;
    expect(middle).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(middle);
    // Still weaker than the shaft it precedes -- the sight at its brightest
    // against the core at its dimmest, which is the comparison that has to hold
    // rather than the one that happens to on some tick.
    const cores = Array.from({ length: 60 }, (_, tick) => shaftAt(tick).coreOpacity);
    expect(end).toBeLessThan(Math.min(...cores));
  });

  it('clamps the ramp rather than running past either end', () => {
    // A cast whose ticks a client picked up late or is holding stale: neither is
    // a reason to draw an invisible sight or an opacity a material rounds to one.
    expect(sightAt(LOCK_ON.startTick - 90).opacity).toBe(sightAt(LOCK_ON.startTick).opacity);
    expect(sightAt(LOCK_ON.releaseTick + 90).opacity).toBe(sightAt(LOCK_ON.releaseTick).opacity);
  });

  it('keeps every opacity inside what a material can express', () => {
    // The shimmer is a multiplier, and three accepts an opacity over one and
    // then draws it as one -- so an unclamped core would flatten at the top of
    // every cycle and the breathing would only ever be a dimming.
    for (let tick = 0; tick < 240; tick++) {
      const shaft = shaftAt(tick);
      for (const value of [shaft.opacity, shaft.coreOpacity, shaft.footprintOpacity]) {
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(sightAt(tick).opacity).toBeLessThanOrEqual(1);
    }
  });

  it('breathes while it fires, and holds the shaft steady while it does', () => {
    const looks = Array.from({ length: 60 }, (_, tick) => shaftAt(tick));
    const cores = looks.map((look) => look.coreOpacity);
    // The core moves.
    expect(Math.max(...cores) - Math.min(...cores)).toBeGreaterThan(0.05);
    // The shaft and the footprint do not, and neither does any width: what the
    // shimmer must never do is make the danger look like it is changing size.
    expect(new Set(looks.map((look) => look.opacity)).size).toBe(1);
    expect(new Set(looks.map((look) => look.footprintOpacity)).size).toBe(1);
    expect(new Set(looks.map((look) => look.width)).size).toBe(1);
    expect(new Set(looks.map((look) => look.footprintWidth)).size).toBe(1);
  });

  it('is the same picture on every client, because the tick is an argument', () => {
    expect(beamLookFor('warden', FIRING, 4242)).toEqual(beamLookFor('warden', FIRING, 4242));
    expect(beamLookFor('warden', LOCK_ON, 4242)).toEqual(beamLookFor('warden', LOCK_ON, 4242));
  });

  it('draws a turning cast as a sight, not as nothing', () => {
    // `castAngleDeg: 360` means the shipped row never turns -- but a row that
    // did would still be aiming, and a phase this function did not recognise
    // would be a Warden with a live cast and no picture at all.
    const look = beamLookFor('warden', { ...LOCK_ON, phase: CastPhase.Turning }, 150);
    expect(look?.kind).toBe('lockOn');
  });
});

describe('the sight is a scan, not a twinkle (spec 259)', () => {
  it('lays every dot on the line, and none of them past its end', () => {
    for (let tick = 0; tick < 90; tick++) {
      const look = sightAt(tick);
      for (let i = 0; i < sightDotCount(look); i++) {
        const along = sightDotAt(look, i);
        expect(along).toBeGreaterThanOrEqual(0);
        expect(along).toBeLessThan(look.length);
      }
    }
  });

  it('keeps them evenly spaced, which is what makes it read as an instrument', () => {
    const look = sightAt(30);
    const gaps: number[] = [];
    for (let i = 1; i < sightDotCount(look); i++) {
      gaps.push(sightDotAt(look, i) - sightDotAt(look, i - 1));
    }
    // Every gap is the spacing, bar the one where the pattern wraps.
    const even = gaps.filter((gap) => Math.abs(gap - look.spacing) < 1e-6);
    expect(even.length).toBeGreaterThanOrEqual(gaps.length - 1);
  });

  it('slides away from the head rather than flickering in place', () => {
    // A laser sight is a *scan*: which dots are lit is not information, and a
    // pattern that travels says the machine is doing something where a random
    // flicker says the picture is noisy. Measured on the first dot, which is the
    // one whose motion a player actually follows.
    const first = Array.from({ length: 8 }, (_, tick) => sightDotAt(sightAt(tick), 0));
    for (let i = 1; i < first.length; i++) {
      expect(first[i] ?? 0).toBeGreaterThan(first[i - 1] ?? 0);
    }
  });

  it('wraps rather than drifting off the end for good', () => {
    // The pattern has to travel forever out of a fixed number of points, or the
    // sight empties itself a few seconds into a lock-on that is only ever two.
    const spans = Array.from({ length: 400 }, (_, tick) => sightDotAt(sightAt(tick), 0));
    expect(Math.max(...spans)).toBeLessThan(sightAt(0).spacing * 1.001);
    expect(Math.min(...spans)).toBeLessThan(sightAt(0).spacing * 0.2);
  });

  it('is drawn at a fixed pixel size rather than in world units', () => {
    // The whole of "a single-pixel sight": the same dot at every distance and
    // every zoom, so the line reads as an instrument rather than as an object
    // with perspective on it.
    expect(sightAt(10).pixel).toBeGreaterThanOrEqual(1);
    expect(sightAt(10).pixel).toBeLessThanOrEqual(3);
  });
});
