import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { pointIntensity } from './player-lights.js';
import type { LightRequest } from './light-residency.js';
import { WorldLights, WORLD_LIGHT_DEFAULTS } from './world-lights.js';

/**
 * Spec 250. Everything here is about the cost the pool exists to avoid, and it
 * is invisible in a screenshot: a light count that changes recompiles every
 * material in the scene, and `castShadow` is in that same program key -- so the
 * count is fixed, and no slot casts, ever.
 */

const OPTIONS = { ...WORLD_LIGHT_DEFAULTS, activateRadius: 1000, releaseRadius: 1400 };
const ORIGIN = { x: 0, z: 0 };

function light(key: string, x: number): LightRequest {
  return { key, x, y: 30, z: 0, color: 0xffcc88, brightness: 2, radius: 400 };
}

function pointLightsIn(scene: THREE.Scene): THREE.PointLight[] {
  const out: THREE.PointLight[] = [];
  scene.traverse((node) => {
    if (node instanceof THREE.PointLight) out.push(node);
  });
  return out;
}

function fresh(): { scene: THREE.Scene; pool: WorldLights } {
  const scene = new THREE.Scene();
  return { scene, pool: new WorldLights(scene, OPTIONS) };
}

describe('the world light pool (spec 250)', () => {
  /**
   * The reason there is a pool at all. three collects lights in
   * `projectObject`, which returns early on `visible === false`, and the count
   * is part of the program key -- so a light that comes and goes recompiles
   * every material in the world as the player walks.
   */
  it('never changes how many lights are on the scene, or hides one', () => {
    const { scene, pool } = fresh();
    const counts = new Set<number>();
    const hidden = new Set<boolean>();
    const sample = (): void => {
      const lights = pointLightsIn(scene);
      counts.add(lights.length);
      for (const one of lights) hidden.add(one.visible);
    };
    sample();
    pool.update([], ORIGIN);
    sample();
    pool.update([light('a', 10), light('b', 20), light('c', 30)], ORIGIN);
    sample();
    pool.update([light('a', 5000)], ORIGIN);
    sample();
    pool.update([], ORIGIN);
    sample();
    expect([...counts]).toEqual([OPTIONS.slots]);
    expect([...hidden]).toEqual([true]);
  });

  /**
   * Nothing casts (spec 250), and that is asserted rather than assumed: a slot
   * that started casting would be six passes over the scene every frame for a
   * light that moves whenever the pool changes hands, and nothing else in this
   * file would notice.
   */
  it('never casts a shadow from any slot, whatever is assigned', () => {
    const { scene, pool } = fresh();
    const casting = (): boolean[] => pointLightsIn(scene).map((one) => one.castShadow);
    expect(casting().some(Boolean)).toBe(false);
    pool.update([light('fire', 10), light('orb', 20)], ORIGIN);
    expect(casting().some(Boolean)).toBe(false);
    pool.update([], ORIGIN);
    expect(casting().some(Boolean)).toBe(false);
  });

  it('writes the request onto the slot it assigned', () => {
    const { scene, pool } = fresh();
    pool.update([light('fire', 120)], { x: 100, z: 0 });
    const lit = pointLightsIn(scene)[0];
    expect(lit?.position.x).toBe(120);
    expect(lit?.distance).toBe(400);
    expect(lit?.intensity).toBeCloseTo(pointIntensity(2, 400));
    expect(pool.heldKeys()[0]).toBe('fire');
  });

  it('parks a slot at nothing rather than taking it off the scene', () => {
    const { scene, pool } = fresh();
    pool.update([light('fire', 10)], ORIGIN);
    pool.update([], ORIGIN);
    const parked = pointLightsIn(scene)[0];
    expect(parked?.intensity).toBe(0);
    expect(parked?.visible).toBe(true);
    expect(pool.heldKeys()[0]).toBeNull();
  });

  it('takes its lights off the scene when it is disposed', () => {
    const { scene, pool } = fresh();
    pool.dispose();
    expect(pointLightsIn(scene)).toHaveLength(0);
  });
});
