import { describe, expect, it } from 'vitest';
import { WARDEN_LASER } from '../../../server/data/warden.js';
import { CastPhase } from '../../../server/sim/types.js';
import {
  BEAM_END_LIFT,
  BEAM_GLOW_HEIGHT,
  BEAM_GLOW_LIGHTS,
  BEAM_GLOW_RADIUS,
  CORE_FRACTION,
  SHAFT_FRACTION,
  beamGlowAt,
  beamGlowBrightness,
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

  it('sizes the shaft off the lane it is fired down, and the core inside that', () => {
    // Read off the row rather than pinned, so a retune of the mechanic moves the
    // picture with it. The shaft is narrower than the lane on purpose -- the
    // relationship a fireball has to its blast -- and since the ground decal
    // went, nothing draws the lane's own width at all: see the header, and the
    // note there about what that costs.
    const shaft = shaftAt(250);
    expect(shaft.width).toBeCloseTo(WARDEN_LASER.width * SHAFT_FRACTION, 5);
    expect(shaft.coreWidth).toBeCloseTo(WARDEN_LASER.width * CORE_FRACTION, 5);
    expect(shaft.width).toBeLessThan(WARDEN_LASER.width);
    expect(shaft.coreWidth).toBeLessThan(shaft.width);
  });

  it('paints nothing on the ground', () => {
    // The band under the beam is gone and what replaces it is light. Asserted as
    // an *absence* because that is the only way to catch it coming back through
    // some other door -- a look that grew a second ground field would be a decal
    // nobody meant to reinstate.
    const shaft = shaftAt(250);
    for (const key of Object.keys(shaft)) {
      expect(key.toLowerCase(), `${key} sounds like ground paint`).not.toContain('footprint');
    }
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
      for (const value of [shaft.opacity, shaft.coreOpacity]) {
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
    // The shaft does not, and neither does either width: what the shimmer must
    // never do is make the danger look like it is changing size.
    expect(new Set(looks.map((look) => look.opacity)).size).toBe(1);
    expect(new Set(looks.map((look) => look.width)).size).toBe(1);
    expect(new Set(looks.map((look) => look.coreWidth)).size).toBe(1);
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

describe('the beam lights the ground rather than painting it (spec 259)', () => {
  it('hangs its lights along the beam and never past either end', () => {
    const shaft = shaftAt(250);
    for (let i = 0; i < BEAM_GLOW_LIGHTS; i++) {
      const along = beamGlowAt(shaft, i);
      // Strictly inside: a light on the muzzle adds nothing to the brightest
      // thing in the frame, and one past the end lights ground the beam misses.
      expect(along, `light ${i}`).toBeGreaterThan(0);
      expect(along, `light ${i}`).toBeLessThan(shaft.length);
    }
  });

  it('spaces them evenly, so no stretch of the run is left dark', () => {
    const shaft = shaftAt(250);
    const gaps: number[] = [];
    for (let i = 1; i < BEAM_GLOW_LIGHTS; i++) {
      gaps.push(beamGlowAt(shaft, i) - beamGlowAt(shaft, i - 1));
    }
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0] ?? 0, 5);
    // And close enough together that their pools overlap rather than bead. Two
    // radii against one gap is the condition for the ground between two lights
    // being reached by both.
    expect(gaps[0] ?? 0).toBeLessThan(BEAM_GLOW_RADIUS);
  });

  it('flickers without ever going out', () => {
    // A flicker that reaches zero is a strobe, and the ground going dark is the
    // one thing it must not do to somebody trying to walk out of the beam.
    const values: number[] = [];
    for (let tick = 0; tick < 600; tick++) {
      for (let i = 0; i < BEAM_GLOW_LIGHTS; i++) values.push(beamGlowBrightness(i, tick));
    }
    const low = Math.min(...values);
    const high = Math.max(...values);
    expect(low).toBeGreaterThan(0);
    // Two thirds of the peak is the authored floor; a hair under it is the
    // sampling, since the trough need not land on a whole tick.
    expect(low / high).toBeGreaterThan(0.6);
    // And it really does move -- a light that flattened would be a beam that
    // merely glows -- stated as a fraction of the peak for the reason the next
    // test gives: the level is retuned against the retro pass, and a swing
    // written in absolute units is a claim that breaks when it should not.
    expect((high - low) / high).toBeGreaterThan(0.3);
  });

  it('lights each one out of step with the others, so it crackles rather than pulses', () => {
    // Lit together they are one lamp on a dimmer. What says "unstable" is that
    // the three disagree, on nearly every tick rather than on average.
    //
    // Measured as a *fraction* of what they are lit at, never as an absolute
    // gap: a level is a thing somebody retunes against the retro pass, and a
    // claim about phase that a retune can break is a claim in the wrong unit.
    // The first cut of this said `> 0.05` and failed the moment the brightness
    // came down.
    let apart = 0;
    let gap = 0;
    for (let tick = 0; tick < 600; tick++) {
      const first = beamGlowBrightness(0, tick);
      const last = beamGlowBrightness(BEAM_GLOW_LIGHTS - 1, tick);
      const rel = Math.abs(first - last) / ((first + last) / 2);
      gap += rel;
      if (rel > 0.05) apart++;
    }
    // Most of the time, and by a tenth on average. Not *always*: two sines with
    // a phase between them cross, and a rule that forbade them ever agreeing
    // would be a rule about a signal nothing can produce.
    expect(apart).toBeGreaterThan(350);
    expect(gap / 600).toBeGreaterThan(0.06);
  });

  it('has no beat to hear, because the periods never line up', () => {
    // One sine is a pulse. Three incommensurate ones have no shared period, so
    // the flicker never repeats inside anything a player would watch -- asserted
    // as the absence of an exact repeat over ten seconds of ticks.
    const seen = new Set<string>();
    for (let tick = 0; tick < 600; tick++) seen.add(beamGlowBrightness(0, tick).toFixed(6));
    expect(seen.size).toBe(600);
  });

  it('is the same flicker on every client, because the tick is an argument', () => {
    expect(beamGlowBrightness(1, 4242)).toBe(beamGlowBrightness(1, 4242));
  });

  it('hangs the lights high enough that the pool does not bead', () => {
    // The rule the height exists for, in the one form that is a rule rather than
    // a number: what a point light lands on flat ground with goes as
    // `1 / d^2`, and directly beneath it `d` *is* the height -- so a light near
    // the ground is a hot spot with darkness around it however its brightness is
    // set. Held against the reach rather than against the end lift, because that
    // is the ratio that decides whether three of them read as a line of light or
    // as three lamps.
    expect(BEAM_GLOW_HEIGHT / BEAM_GLOW_RADIUS).toBeGreaterThan(0.25);
    // And still under the reach, or they are lights beside the beam rather than
    // over it.
    expect(BEAM_GLOW_HEIGHT).toBeLessThan(BEAM_GLOW_RADIUS);
    expect(BEAM_GLOW_HEIGHT).toBeGreaterThan(BEAM_END_LIFT);
  });
});
