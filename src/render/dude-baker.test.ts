import { describe, it, expect } from 'vitest';
import { bakeDude, seedFromName, SPRITE_W, SPRITE_H } from './dude-baker.js';
import { ENEMY_TYPES } from '../sim/enemies.js';
import { PLAYER_SKIN } from './spells/dudes.js';

const bytes = (a: Uint8ClampedArray): number[] => Array.from(a);
const PIXELS = SPRITE_W * SPRITE_H * 4;

function opaqueCount(rgba: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 3; i < rgba.length; i += 4) if ((rgba[i] as number) > 0) n++;
  return n;
}

describe('seedFromName', () => {
  it('is stable and case/character sensitive', () => {
    expect(seedFromName('Rook')).toBe(seedFromName('Rook'));
    expect(seedFromName('Rook')).not.toBe(seedFromName('rook'));
    expect(seedFromName('Rook')).not.toBe(seedFromName('Rook2'));
  });
});

describe('bakeDude', () => {
  it('is deterministic for a given seed (byte-identical both poses)', () => {
    const seed = seedFromName('Brawler');
    const a = bakeDude(seed);
    const b = bakeDude(seed);
    expect(bytes(a.idle)).toEqual(bytes(b.idle));
    expect(bytes(a.windup)).toEqual(bytes(b.windup));
  });

  it('produces well-formed 16x24 RGBA with only fully-opaque or fully-transparent pixels', () => {
    const dude = bakeDude(seedFromName('Rook'));
    expect(dude.width).toBe(SPRITE_W);
    expect(dude.height).toBe(SPRITE_H);
    for (const pose of [dude.idle, dude.windup]) {
      expect(pose.length).toBe(PIXELS);
      expect(opaqueCount(pose)).toBeGreaterThan(0);
      for (let i = 3; i < pose.length; i += 4) expect(pose[i] === 0 || pose[i] === 255).toBe(true);
    }
  });

  it('gives different identities different sprites', () => {
    const rook = bakeDude(seedFromName('Rook'));
    const brawler = bakeDude(seedFromName('Brawler'));
    expect(bytes(rook.idle)).not.toEqual(bytes(brawler.idle));
  });

  it('renders a distinct wind-up pose from idle', () => {
    const dude = bakeDude(seedFromName('Warden'));
    expect(bytes(dude.idle)).not.toEqual(bytes(dude.windup));
  });

  it('bakes a distinct skin for the hero and every enemy type (spec 011 art)', () => {
    const names = [PLAYER_SKIN, ...ENEMY_TYPES.map((t) => t.key)];
    const idles = names.map((n) => bytes(bakeDude(seedFromName(n)).idle));
    for (let i = 0; i < idles.length; i++) {
      for (let j = i + 1; j < idles.length; j++) {
        expect(idles[i], `${names[i]} vs ${names[j]} must differ`).not.toEqual(idles[j]);
      }
    }
  });
});
