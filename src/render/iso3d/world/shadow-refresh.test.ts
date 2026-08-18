/**
 * The four things that invalidate a shadow map, one test each -- and the one
 * that must not.
 *
 * The test that matters most is the last: a world standing still must reach zero
 * rebuilds, because that is the entire claim. Every other test here exists to
 * make sure that zero was not bought by missing a change.
 */

import { describe, expect, it } from 'vitest';

import { MoverTally, ShadowRefresh, type ShadowInputs } from './shadow-refresh.js';

function inputs(over: Partial<ShadowInputs> = {}): ShadowInputs {
  return {
    sunX: 0.3,
    sunY: 0.9,
    sunZ: 0.3,
    targetX: 100,
    targetZ: 200,
    radius: 900,
    geometry: 1,
    movers: 0,
    ...over,
  };
}

describe('when the shadow map has to be redrawn', () => {
  it('builds on the first frame, whatever the state is', () => {
    expect(new ShadowRefresh().needed(inputs())).toBe(true);
  });

  it('does not redraw a scene that has not changed', () => {
    const refresh = new ShadowRefresh();
    refresh.needed(inputs());

    for (let frame = 0; frame < 600; frame++) {
      expect(refresh.needed(inputs())).toBe(false);
    }
    expect(refresh.stats).toEqual({ rebuilds: 1, frames: 601 });
  });

  it('redraws when the sun moves', () => {
    const refresh = new ShadowRefresh();
    refresh.needed(inputs());
    expect(refresh.needed(inputs({ sunY: 0.8 }))).toBe(true);
  });

  it('redraws when the shadow camera follows the player', () => {
    // The half the phrase "only when the sun moves" leaves out: `applySun`
    // copies the view target into the light every frame, so walking moves the
    // volume the map covers under a sun that has not moved at all.
    const refresh = new ShadowRefresh();
    refresh.needed(inputs());
    expect(refresh.needed(inputs({ targetX: 140 }))).toBe(true);
  });

  it('redraws when the zoom changes the frustum', () => {
    const refresh = new ShadowRefresh();
    refresh.needed(inputs());
    expect(refresh.needed(inputs({ radius: 1200 }))).toBe(true);
  });

  it('redraws when geometry is added', () => {
    // A streamed chunk, a rebuilt prop region, a caster group hidden.
    const refresh = new ShadowRefresh();
    refresh.needed(inputs());
    expect(refresh.needed(inputs({ geometry: 2 }))).toBe(true);
  });

  it('redraws when a caster moves', () => {
    const refresh = new ShadowRefresh();
    refresh.needed(inputs({ movers: 10 }));
    expect(refresh.needed(inputs({ movers: 11 }))).toBe(true);
  });

  it('ignores the float noise a settled camera follow leaves behind', () => {
    // The follow is exponential, so the target creeps in the last decimal for a
    // long time after the player has stopped. A bare inequality would call that
    // a change and rebuild every frame -- which is the behaviour this replaces.
    const refresh = new ShadowRefresh();
    refresh.needed(inputs());
    expect(refresh.needed(inputs({ targetX: 100.0001, targetZ: 199.9998 }))).toBe(false);
  });

  it('still fires once a creep adds up to something visible', () => {
    // Compared against what the map was *built* from rather than against last
    // frame, so a drift under the epsilon accumulates instead of creeping past
    // unnoticed one frame at a time.
    const refresh = new ShadowRefresh();
    refresh.needed(inputs());
    let x = 100;
    let fired = false;
    for (let frame = 0; frame < 100; frame++) {
      x += 0.01;
      if (refresh.needed(inputs({ targetX: x }))) fired = true;
    }
    expect(fired).toBe(true);
  });
});

describe('the mover signature', () => {
  const sign = (add: (t: MoverTally) => void): number => {
    const tally = new MoverTally();
    tally.reset();
    add(tally);
    return tally.signature;
  };

  it('is the same for a body that has not moved', () => {
    const a = sign((t) => t.add(10, 2, 30, 1.5));
    const b = sign((t) => t.add(10, 2, 30, 1.5));
    expect(a).toBe(b);
  });

  it('changes when a body moves', () => {
    expect(sign((t) => t.add(10, 2, 30, 1.5))).not.toBe(sign((t) => t.add(11, 2, 30, 1.5)));
  });

  it('changes when a body turns on the spot', () => {
    // What a player does most, and it moves the shadow without moving the body.
    expect(sign((t) => t.add(10, 2, 30, 1.5))).not.toBe(sign((t) => t.add(10, 2, 30, 1.9)));
  });

  it('changes when a body dies and is squashed', () => {
    expect(sign((t) => t.add(10, 2, 30, 1.5, 1))).not.toBe(sign((t) => t.add(10, 2, 30, 1.5, 0.6)));
  });

  it('changes when a body leaves the world', () => {
    // Two bodies whose remaining positions sum the same as one would slip past a
    // bare sum, so the count is folded in.
    const two = sign((t) => {
      t.add(10, 2, 30, 0);
      t.add(0, 0, 0, 0);
    });
    expect(two).not.toBe(sign((t) => t.add(10, 2, 30, 0)));
  });

  it('does not notice interpolation noise', () => {
    // A replicated body's drawn position changes in the last decimal on every
    // frame; a signature that saw that would never let a rebuild be skipped.
    expect(sign((t) => t.add(10, 2, 30, 1.5))).toBe(
      sign((t) => t.add(10.0001, 2.00007, 29.99993, 1.50002)),
    );
  });

  it('resets between frames', () => {
    const tally = new MoverTally();
    tally.add(10, 2, 30, 1.5);
    const first = tally.signature;
    tally.reset();
    tally.add(10, 2, 30, 1.5);
    expect(tally.signature).toBe(first);
  });
});

describe('a world at rest', () => {
  it('costs one rebuild for the whole session', () => {
    // The claim the feature is for: camera locked, nothing moving, the day/night
    // cycle off. Ten seconds of frames, one draw of the map.
    const refresh = new ShadowRefresh();
    const tally = new MoverTally();
    for (let frame = 0; frame < 600; frame++) {
      tally.reset();
      tally.add(120, 14, 340, 2.1);
      tally.add(300, 9, 80, 0.4);
      refresh.needed(inputs({ movers: tally.signature }));
    }
    expect(refresh.stats.rebuilds).toBe(1);
  });
});
