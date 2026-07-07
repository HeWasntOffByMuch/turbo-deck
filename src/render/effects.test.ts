import { describe, expect, it } from 'vitest';
import { CARD_CATALOG } from '../cards/catalog.js';
import { ACTIVE_VFX, AoeEffect, PASSIVE_VFX, ProjectileEffect } from './effects.js';

describe('card VFX config coverage', () => {
  it('styles every passive kind in the catalog', () => {
    for (const def of CARD_CATALOG.values()) {
      if (def.kind !== 'passive') continue;
      expect(PASSIVE_VFX[def.passive.kind], `no aura for passive ${def.id}`).toBeDefined();
    }
  });

  it('styles every active card in the catalog', () => {
    for (const def of CARD_CATALOG.values()) {
      if (def.kind !== 'active') continue;
      const vfx = ACTIVE_VFX[def.id];
      expect(vfx, `no effect for active ${def.id}`).toBeDefined();
      expect(vfx?.radius).toBeGreaterThan(0);
      if (vfx?.kind === 'aoe') expect(vfx.castTicks).toBeGreaterThanOrEqual(0);
    }
  });

  it('marks projectile-tagged actives as projectiles', () => {
    for (const def of CARD_CATALOG.values()) {
      if (def.kind !== 'active' || !def.tags.includes('projectile')) continue;
      expect(ACTIVE_VFX[def.id]?.kind).toBe('projectile');
    }
  });
});

describe('transient effect lifecycles', () => {
  it('advances a projectile to its target and then dies', () => {
    const fireball = ACTIVE_VFX.fireball;
    if (!fireball) throw new Error('fireball VFX missing');
    const fx = new ProjectileEffect({ x: 0, y: 0 }, { x: 60, y: 0 }, fireball);
    // Alive while travelling the 60-unit gap (12/frame => ~5 frames) plus its burst.
    expect(fx.update()).toBe(true);
    let frames = 1;
    while (fx.update() && frames < 200) frames++;
    expect(frames).toBeLessThan(200); // terminates
    expect(frames).toBeGreaterThan(5); // travelled, then burst, before dying
  });

  it('keeps an AOE alive through its full windup before bursting out', () => {
    const vfx = ACTIVE_VFX.mend;
    if (!vfx) throw new Error('mend VFX missing');
    const fx = new AoeEffect({ x: 0, y: 0 }, vfx);
    for (let i = 0; i < vfx.castTicks; i++) {
      expect(fx.update(), `AOE died during windup frame ${i}`).toBe(true);
    }
    let frames = vfx.castTicks;
    while (fx.update() && frames < 500) frames++;
    expect(frames).toBeGreaterThan(vfx.castTicks); // burst happened after windup
    expect(frames).toBeLessThan(500);
  });
});
