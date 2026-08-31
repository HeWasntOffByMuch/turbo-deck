/**
 * Telling a refund from everything else a cooldown table does (spec 253).
 */

import { describe, expect, it } from 'vitest';

import { refundsBetween } from './cooldown-refund.js';

describe('refundsBetween', () => {
  it('reports an entry that went down, by how far', () => {
    expect(refundsBetween({ 'skill.arcLash': 600 }, { 'skill.arcLash': 528 })).toEqual([
      { abilityId: 'skill.arcLash', ticks: 72 },
    ]);
  });

  it('reports every ability one trigger paid, in a stable order', () => {
    const before = { 'skill.blight': 900, 'skill.arcLash': 600, 'skill.emberToss': 700 };
    const after = { 'skill.blight': 828, 'skill.arcLash': 528, 'skill.emberToss': 628 };
    expect(refundsBetween(before, after).map((r) => r.abilityId)).toEqual([
      'skill.arcLash',
      'skill.blight',
      'skill.emberToss',
    ]);
  });

  it('says nothing about an entry that did not move', () => {
    expect(refundsBetween({ 'melee.slash': 300 }, { 'melee.slash': 300 })).toEqual([]);
  });

  /** An ability that was just cast: its cooldown was stamped, not refunded. */
  it('says nothing about an entry that went up', () => {
    expect(refundsBetween({ 'skill.arcLash': 100 }, { 'skill.arcLash': 640 })).toEqual([]);
  });

  /**
   * The first table this client ever sees has nothing before it, so no id is in
   * both and nothing is reported -- which is the same rule `xp-gain.ts` needs a
   * whole baseline for, got for free here.
   */
  it('says nothing about the first table there is', () => {
    expect(refundsBetween({}, { 'skill.arcLash': 640, 'melee.slash': 300 })).toEqual([]);
  });

  /**
   * The three ways an entry legitimately vanishes -- it expired, the wind-up
   * that stamped it was withdrawn from (`cancelWindup` rebuilds the map without
   * the key), the body respawned -- must not read as a refund of everything
   * that was left on it.
   */
  it('says nothing about an entry that vanished', () => {
    expect(refundsBetween({ 'skill.arcLash': 640 }, {})).toEqual([]);
    expect(refundsBetween({ 'skill.arcLash': 640 }, { 'melee.slash': 12 })).toEqual([]);
  });
});
