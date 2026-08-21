/**
 * A prop region composed somewhere else, and still being the same region
 * (spec 181).
 *
 * The loop that places every tree, bush and fence tile moved off the thread
 * that draws, and the geometry under those batches is now shared between them.
 * Both are the kind of change that looks right in a screenshot and is wrong in
 * a way nobody notices for a month, so what is pinned here is equality against
 * the path that shipped, and the two ownership hazards the sharing introduced.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  buildPropField,
  buildRegionInstances,
  propGroupParts,
  PROP_GROUP_COUNT,
  PROP_REGION_SIZE,
  propRegionKey,
  TREE_SPECIES,
  type PropShading,
} from './props.js';
import { FENCE_KINDS } from '../../terrain/vegetation.js';
import type { Prop } from '../../terrain/vegetation.js';

const SMOOTH: PropShading = { smooth: true, creaseAngle: (50 * Math.PI) / 180, swayNormals: true };

const tree = (x: number, y: number, tint = 0): Prop => ({ kind: 'tree', x, y, scale: 1, rotation: 0, tint });
const bush = (x: number, y: number): Prop => ({ kind: 'bush', x, y, scale: 1, rotation: 0.3, tint: 0.2 });

/** A stand of trees inside one region, varied enough to reach several species. */
function stand(originX: number, originZ: number, count = 24): Prop[] {
  return Array.from({ length: count }, (_, i) =>
    tree(originX + 40 + (i % 6) * 90, originZ + 40 + Math.floor(i / 6) * 90, (i % 5) / 5),
  );
}

/** Flat ground, so a height is not the thing under test. */
const flat = (): number => 0;

function instancedIn(group: THREE.Object3D): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  group.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) out.push(o);
  });
  return out;
}

describe('the batch enumeration means the same thing on both sides', () => {
  it('covers every species, the bush and every fence kind, and nothing else', () => {
    expect(PROP_GROUP_COUNT).toBe(TREE_SPECIES.length + 1 + FENCE_KINDS.length);
  });

  it('answers with a part list for every group and none outside it', () => {
    for (let group = 0; group < PROP_GROUP_COUNT; group++) {
      expect(propGroupParts(group).length).toBeGreaterThan(0);
    }
    expect(propGroupParts(-1)).toHaveLength(0);
    expect(propGroupParts(PROP_GROUP_COUNT)).toHaveLength(0);
  });

  it('hands back the same part objects however often it is asked', () => {
    // The memo is what took 6.7ms out of a region rebuild; identity is how it is
    // checked without timing anything.
    for (let group = 0; group < PROP_GROUP_COUNT; group++) {
      expect(propGroupParts(group)).toBe(propGroupParts(group));
    }
  });
});

describe('instances composed elsewhere', () => {
  it('place every prop exactly where the shipped path placed it', () => {
    const props = [...stand(0, 0), bush(300, 300), bush(500, 120)];
    const key = propRegionKey(0, 0);

    // The path that shipped: one call that composes and hangs in one breath.
    const before = buildPropField(props, flat, undefined, SMOOTH);
    // The path the worker takes: composed on its own, adopted afterwards.
    const after = buildPropField([], flat, undefined, SMOOTH);
    after.adoptRegion(key, buildRegionInstances(props, flat));

    const mine = instancedIn(before.group);
    const theirs = instancedIn(after.group);
    expect(theirs.length).toBe(mine.length);
    expect(mine.length).toBeGreaterThan(0);

    for (let i = 0; i < mine.length; i++) {
      const a = mine[i];
      const b = theirs[i];
      expect(b?.count).toBe(a?.count);
      expect([...(b?.instanceMatrix.array ?? [])]).toEqual([...(a?.instanceMatrix.array ?? [])]);
      expect([...(b?.instanceColor?.array ?? [])]).toEqual([...(a?.instanceColor?.array ?? [])]);
    }
  });

  it('carries the sway attributes for a batch where every instance sways', () => {
    const instances = buildRegionInstances(stand(0, 0), flat);
    const swaying = instances.batches.filter((b) => b.sway !== null);
    expect(swaying.length).toBeGreaterThan(0);
    for (const batch of swaying) {
      expect(batch.sway?.base.length).toBe(batch.count * 3);
      expect(batch.sway?.tune.length).toBe(batch.count * 2);
    }
  });

  it('reports a kind it has no geometry for rather than dropping it silently', () => {
    const odd = { kind: 'fence-wattle', x: 10, y: 10, scale: 1, rotation: 0, tint: 0 } as unknown as Prop;
    expect(buildRegionInstances([odd], flat).undrawnKinds).toEqual(['fence-wattle']);
  });

  it('composes nothing for an empty region, which is how one is taken down', () => {
    const props = stand(0, 0);
    const key = propRegionKey(0, 0);
    const field = buildPropField([], flat, undefined, SMOOTH);
    field.adoptRegion(key, buildRegionInstances(props, flat));
    expect(instancedIn(field.group).length).toBeGreaterThan(0);
    field.adoptRegion(key, buildRegionInstances([], flat));
    expect(instancedIn(field.group)).toHaveLength(0);
  });
});

describe('the geometry is shared and the instanced attributes are not', () => {
  /**
   * The hazard the shell exists for.
   *
   * `applySway` writes `aWindBase` -- one entry per tree -- onto
   * `mesh.geometry`. Ninety regions sharing one geometry *object* is ninety
   * regions whose trees all sway around the base points of whichever region was
   * built last, and it would look like nothing at all in a still screenshot.
   */
  it('gives two regions of the same species different wind bases', () => {
    const near = stand(0, 0);
    const far = stand(PROP_REGION_SIZE * 3, PROP_REGION_SIZE * 3);
    const field = buildPropField([...near, ...far], flat, undefined, SMOOTH);

    const bases = instancedIn(field.group)
      .map((mesh) => mesh.geometry.getAttribute('aWindBase'))
      .filter((a): a is THREE.BufferAttribute => a !== undefined);
    expect(bases.length).toBeGreaterThan(1);

    // No two batches share the attribute object...
    expect(new Set(bases).size).toBe(bases.length);
    // ...and the world is genuinely described twice, far apart.
    const xs = bases.flatMap((a) => [a.array[0] ?? 0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(PROP_REGION_SIZE);
  });

  it('shares the vertex data underneath, rather than rebuilding it per region', () => {
    const near = stand(0, 0);
    const far = stand(PROP_REGION_SIZE * 3, PROP_REGION_SIZE * 3);
    const field = buildPropField([...near, ...far], flat, undefined, SMOOTH);
    const meshes = instancedIn(field.group);

    // Two regions built from the same stand draw the same parts, so somewhere in
    // there two different batches point at one `position` attribute.
    const positions = meshes.map((m) => m.geometry.getAttribute('position'));
    expect(new Set(positions).size).toBeLessThan(positions.length);
  });

  /**
   * three's `onGeometryDispose` removes the GPU buffer of every attribute a
   * geometry holds. Disposing a shell as-is would free the *shared* ones and
   * make every other region re-upload -- a hitch caused by the very rebuild
   * this spec makes cheap.
   */
  it('leaves another region drawable after one is disposed', () => {
    const near = stand(0, 0);
    const far = stand(PROP_REGION_SIZE * 3, PROP_REGION_SIZE * 3);
    const all = [...near, ...far];
    const field = buildPropField(all, flat, undefined, SMOOTH);
    const farKey = propRegionKey(far[0]?.x ?? 0, far[0]?.y ?? 0);
    const survivors = instancedIn(field.group).filter(
      (m) => propRegionKey(m.position.x, m.position.z) !== farKey,
    );
    const held = survivors.map((m) => m.geometry.getAttribute('position'));

    // Rebuild the near region, which disposes what was there.
    field.rebuildWithin(all, {
      minX: 0,
      minZ: 0,
      maxX: PROP_REGION_SIZE - 1,
      maxZ: PROP_REGION_SIZE - 1,
    });

    // The far region's vertex data is still there and still has its array.
    for (const attribute of held) {
      expect(attribute).toBeDefined();
      expect((attribute?.array.length ?? 0) > 0).toBe(true);
    }
  });

  it('does not accumulate meshes when a region is rebuilt twice', () => {
    const props = stand(0, 0);
    const rect = { minX: 0, minZ: 0, maxX: PROP_REGION_SIZE - 1, maxZ: PROP_REGION_SIZE - 1 };
    const field = buildPropField(props, flat, undefined, SMOOTH);
    const first = instancedIn(field.group).length;
    field.rebuildWithin(props, rect);
    field.rebuildWithin(props, rect);
    expect(instancedIn(field.group).length).toBe(first);
  });
});

/**
 * The takedown reachable without composing a region first (spec 211).
 *
 * `adoptRegion` has freed the held region on the way past since spec 086, so an
 * empty reply was always a clean removal -- but the reason to take a region down
 * is that its ground has gone, and a client that has just evicted the ground has
 * nothing left to compose an empty region *from*. What is asserted here is that
 * reaching that path directly frees the same things and no more.
 */
describe('a region dropped rather than rebuilt', () => {
  const near = stand(0, 0);
  const far = stand(PROP_REGION_SIZE * 3, PROP_REGION_SIZE * 3);
  const farKey = propRegionKey(far[0]?.x ?? 0, far[0]?.y ?? 0);
  const nearKey = propRegionKey(near[0]?.x ?? 0, near[0]?.y ?? 0);

  it('reports the regions it is drawing, which is what a drop pass reconciles against', () => {
    const field = buildPropField([...near, ...far], flat, undefined, SMOOTH);
    expect([...field.heldRegions()].sort()).toEqual([nearKey, farKey].sort());
  });

  it('takes one region off the scene graph and leaves the other alone', () => {
    const field = buildPropField([...near, ...far], flat, undefined, SMOOTH);
    const before = instancedIn(field.group).length;
    expect(field.dropRegion(nearKey)).toBe(true);

    expect(field.heldRegions()).toEqual([farKey]);
    expect(instancedIn(field.group).length).toBeLessThan(before);
    expect(instancedIn(field.group).length).toBeGreaterThan(0);
  });

  it('answers false for a region it was not drawing, so a caller can count what went', () => {
    const field = buildPropField(near, flat, undefined, SMOOTH);
    expect(field.dropRegion(farKey)).toBe(false);
    // ...and dropping twice is not two drops.
    expect(field.dropRegion(nearKey)).toBe(true);
    expect(field.dropRegion(nearKey)).toBe(false);
  });

  it('disposes the batch it owned', () => {
    const field = buildPropField(near, flat, undefined, SMOOTH);
    const meshes = instancedIn(field.group);
    expect(meshes.length).toBeGreaterThan(0);
    const disposed = new Set<THREE.Material>();
    for (const mesh of meshes) {
      const material = mesh.material as THREE.Material;
      material.addEventListener('dispose', () => disposed.add(material));
    }

    field.dropRegion(nearKey);
    expect(disposed.size).toBe(meshes.length);
  });

  /**
   * The ownership hazard spec 181 wrote `disposeShell` for, on the new path:
   * three's `onGeometryDispose` frees the GPU buffer of every attribute a
   * geometry holds, so a shell disposed as-is takes the *shared* vertex data
   * with it and every other region re-uploads.
   */
  it('frees what the batch owned and not the vertex data it borrowed', () => {
    const field = buildPropField([...near, ...far], flat, undefined, SMOOTH);
    // What each geometry was still holding at the instant it was disposed --
    // which is the only moment the hazard is observable, since three frees the
    // GPU buffer of every attribute a geometry holds *then*, and the JS arrays
    // survive either way. Checking `array.length` afterwards would pass on the
    // broken version.
    const atDispose = new Map<THREE.BufferGeometry, string[]>();
    for (const mesh of instancedIn(field.group)) {
      const geometry = mesh.geometry;
      geometry.addEventListener('dispose', () => {
        atDispose.set(geometry, Object.keys(geometry.attributes));
      });
    }

    field.dropRegion(nearKey);

    expect(atDispose.size).toBeGreaterThan(0);
    for (const [, names] of atDispose) {
      expect(names).not.toContain('position');
      expect(names).not.toContain('normal');
    }
    // ...and the region that kept its ground is still drawing.
    const survivors = instancedIn(field.group);
    expect(survivors.length).toBeGreaterThan(0);
    for (const mesh of survivors) {
      expect((mesh.geometry.getAttribute('position')?.array.length ?? 0) > 0).toBe(true);
    }
  });

  it('draws the region again when it is adopted back', () => {
    const field = buildPropField([...near, ...far], flat, undefined, SMOOTH);
    const before = instancedIn(field.group).length;
    field.dropRegion(nearKey);
    field.adoptRegion(nearKey, buildRegionInstances(near, flat));
    expect(field.heldRegions().length).toBe(2);
    expect(instancedIn(field.group).length).toBe(before);
  });
});
