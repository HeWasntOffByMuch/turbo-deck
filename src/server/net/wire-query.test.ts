/**
 * `?wire=` (spec 147). A debug knob, so a typo must cost a default rather than
 * a black screen -- which means every one of these cases is a real one.
 */

import { describe, expect, it } from 'vitest';
import { formatWire, parseWire, MAX_DELAY_TICKS, MAX_JITTER_TICKS } from './wire-query.js';
import { PERFECT_WIRE } from './unreliable.js';

describe('parseWire', () => {
  it('is a perfect wire when nothing asks otherwise', () => {
    expect(parseWire(null)).toEqual(PERFECT_WIRE);
    expect(parseWire(undefined)).toEqual(PERFECT_WIRE);
    expect(parseWire('')).toEqual(PERFECT_WIRE);
  });

  it('reads all four fields', () => {
    expect(parseWire('delay:6,jitter:3,loss:0.02,dup:0.01')).toEqual({
      delayTicks: 6,
      jitterTicks: 3,
      loss: 0.02,
      duplicate: 0.01,
    });
  });

  it('defaults the fields that are missing', () => {
    expect(parseWire('loss:0.5')).toEqual({ delayTicks: 0, jitterTicks: 0, loss: 0.5, duplicate: 0 });
  });

  it('ignores junk rather than throwing it all away', () => {
    // The whole point: one mistyped field must not cost the other three.
    expect(parseWire('delay:6,nonsense,loss:banana,dup:0.5,unknown:9')).toEqual({
      delayTicks: 6,
      jitterTicks: 0,
      loss: 0,
      duplicate: 0.5,
    });
  });

  it('clamps rather than trusting', () => {
    const wild = parseWire(`delay:9999,jitter:-4,loss:5,dup:-1`);
    expect(wild.delayTicks).toBe(MAX_DELAY_TICKS);
    expect(wild.jitterTicks).toBe(0);
    expect(wild.loss).toBe(1);
    expect(wild.duplicate).toBe(0);
    expect(parseWire('jitter:9999').jitterTicks).toBe(MAX_JITTER_TICKS);
  });

  it('takes whole ticks, since the wire counts in them', () => {
    expect(parseWire('delay:6.9,jitter:2.9')).toMatchObject({ delayTicks: 6, jitterTicks: 2 });
  });

  it('is case and space insensitive on the keys', () => {
    expect(parseWire(' Delay:3 , LOSS:0.1')).toMatchObject({ delayTicks: 3, loss: 0.1 });
  });

  it('round-trips through its own format', () => {
    const conditions = { delayTicks: 6, jitterTicks: 3, loss: 0.02, duplicate: 0.01 };
    expect(parseWire(formatWire(conditions))).toEqual(conditions);
  });
});
