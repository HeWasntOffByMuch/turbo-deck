import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { pointIntensity } from './player-lights.js';
import type { LightRequest } from './light-residency.js';
import { WorldLights, WORLD_LIGHT_DEFAULTS } from './world-lights.js';

/**
 * Spec 248. Everything here is about the two costs the pool exists to avoid,
 * and both are invisible in a screenshot: a light count that changes recompiles
 * every material in the scene, and a shadow map rebuilt per frame re-renders the
 * world six times.
 */

const OPTIONS = { ...WORLD_LIGHT_DEFAULTS, activateRadius: 1000, releaseRadius: 1400 };
const ORIGIN = { x: 0, z: 0 };

function light(key: string, x: number, shadow = false): LightRequest {
  return { key, x, y: 30, z: 0, color: 0xffcc88, brightness: 2, radius: 400, shadow, revision: 0 };
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

describe('the world light pool (spec 248)', () => {
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
    pool.update([light('a', 10, true), light('b', 20), light('c', 30)], ORIGIN);
    sample();
    pool.update([light('a', 5000, true)], ORIGIN);
    sample();
    pool.update([], ORIGIN);
    sample();
    expect([...counts]).toEqual([OPTIONS.slots]);
    expect([...hidden]).toEqual([true]);
  });

  it('never changes which slots cast, whatever is assigned', () => {
    const { scene, pool } = fresh();
    const casting = (): boolean[] => pointLightsIn(scene).map((one) => one.castShadow);
    const before = casting();
    expect(before.filter(Boolean)).toHaveLength(OPTIONS.shadowSlots);
    pool.update([light('fire', 10, true), light('orb', 20)], ORIGIN);
    expect(casting()).toEqual(before);
    pool.update([], ORIGIN);
    expect(casting()).toEqual(before);
  });

  it('writes the request onto the slot it assigned', () => {
    const { scene, pool } = fresh();
    pool.update([light('fire', 120, true)], { x: 100, z: 0 });
    const lit = pointLightsIn(scene)[0];
    expect(lit?.position.x).toBe(120);
    expect(lit?.distance).toBe(400);
    expect(lit?.intensity).toBeCloseTo(pointIntensity(2, 400));
    expect(pool.heldKeys()[0]).toBe('fire');
  });

  it('parks a slot at nothing rather than taking it off the scene', () => {
    const { scene, pool } = fresh();
    pool.update([light('fire', 10, true)], ORIGIN);
    pool.update([], ORIGIN);
    const parked = pointLightsIn(scene)[0];
    expect(parked?.intensity).toBe(0);
    expect(parked?.visible).toBe(true);
    expect(pool.heldKeys()[0]).toBeNull();
  });

  /**
   * The bake is the expensive thing in the system, so this is the assertion the
   * whole design is for: it happens once when a slot changes hands, and not
   * again while nothing has changed.
   */
  it('bakes a shadow map once per assignment and not again', () => {
    const { pool } = fresh();
    const fire = light('fire', 10, true);
    pool.update([fire], ORIGIN);
    expect(pool.bakingThisFrame()).toBe(true);
    for (let frame = 0; frame < 10; frame++) {
      pool.update([fire], ORIGIN);
      expect(pool.bakingThisFrame()).toBe(false);
    }
  });

  it('bakes again when the ground under a light has changed', () => {
    const { pool } = fresh();
    pool.update([light('fire', 10, true)], ORIGIN);
    pool.update([light('fire', 10, true)], ORIGIN);
    expect(pool.bakingThisFrame()).toBe(false);
    // The map's churn counter moved: a chunk arrived, or was let go, so what was
    // baked is a picture of ground that is no longer what is there.
    pool.update([{ ...light('fire', 10, true), revision: 1 }], ORIGIN);
    expect(pool.bakingThisFrame()).toBe(true);
  });

  it('bakes at most one map a frame', () => {
    const { pool } = fresh();
    const village = [light('f1', 10, true), light('f2', 20, true)];
    pool.update(village, ORIGIN);
    expect(pool.heldKeys().filter((key) => key !== null)).toHaveLength(2);
    // Both were assigned, and only one of them was baked.
    expect(pool.bakingThisFrame()).toBe(true);
    pool.update(village, ORIGIN);
    expect(pool.bakingThisFrame()).toBe(true);
    pool.update(village, ORIGIN);
    expect(pool.bakingThisFrame()).toBe(false);
  });

  it('never bakes for a light that does not cast', () => {
    const { pool } = fresh();
    pool.update([light('orb', 10), light('orb2', 20)], ORIGIN);
    expect(pool.bakingThisFrame()).toBe(false);
    expect(pool.heldKeys().filter((key) => key !== null)).toHaveLength(2);
  });

  /**
   * The property the hysteresis buys, seen from the other end: a body pacing
   * across the midpoint of two fixtures must not re-bake a cube map every step.
   */
  it('bakes nothing while a walk crosses the boundary between two fixtures', () => {
    const { pool } = fresh();
    const pair = [light('left', -300, true), light('right', 300, true)];
    pool.update(pair, ORIGIN);
    pool.update(pair, ORIGIN);
    pool.update(pair, ORIGIN);
    let bakes = 0;
    for (let step = 0; step < 60; step++) {
      pool.update(pair, { x: Math.sin(step) * 60, z: 0 });
      if (pool.bakingThisFrame()) bakes++;
    }
    expect(bakes).toBe(0);
  });

  it('takes its lights off the scene when it is disposed', () => {
    const { scene, pool } = fresh();
    pool.dispose();
    expect(pointLightsIn(scene)).toHaveLength(0);
  });
});
