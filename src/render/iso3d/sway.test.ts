import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildPropField, maxCanopyTiltReach, speciesHeight, treeVariant, TREE_SPECIES } from './props.js';
import { bakeBend, bendWeight } from './sway.js';
import { maxTipDisplacement, WIND, WIND_LIMITS } from './wind.js';
import { WIND_UNIFORMS, windTimeUniform } from './wind-uniforms.js';
import type { Prop } from '../../terrain/vegetation.js';

/**
 * The tree sway, checked as far as it can be without a GPU (spec 074).
 *
 * What the vertex shader *computes* is arithmetic and lives in `wind.test.ts`.
 * What this covers is everything around it that is just as capable of breaking
 * the effect and would leave no trace in either: an attribute that never got
 * baked, a shadow material that never got the patch, a bounding sphere that was
 * left at its rigid size so the whole batch pops out at the edge of the frame.
 * Each of those looks like "the sway is broken" and none of them is in the
 * shader.
 */

/** A stand of trees, at ground level, laid out along the wind. */
function stand(count: number, spacing: number): Prop[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: 'tree' as const,
    x: WIND.dirX * spacing * i,
    y: WIND.dirZ * spacing * i,
    scale: 1,
    rotation: 0,
    tint: 0.5,
  }));
}

/** Every instanced batch under a group. */
function batches(group: THREE.Object3D): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  group.traverse((child) => {
    if (child instanceof THREE.InstancedMesh) out.push(child);
  });
  return out;
}

describe('the baked bend weight', () => {
  it('is 0 at the foot of the tree and 1 at the crown', () => {
    expect(bendWeight(-64, 64, 128)).toBe(0);
    expect(bendWeight(64, 64, 128)).toBe(1);
  });

  it('clamps rather than running past either end', () => {
    // A tier whose cone tops out above the species height (an authoring slip,
    // or a species retuned without this being revisited) must not produce a
    // weight over 1 -- the quadratic would amplify it into a lean the bounding
    // sphere was never inflated for.
    expect(bendWeight(200, 64, 128)).toBe(1);
    expect(bendWeight(-200, 64, 128)).toBe(0);
  });

  it("puts a part's whole span on one continuous curve", () => {
    // The trunk's top and the first tier's base are different geometries at the
    // same height, and they have to agree or the tree kinks where they meet.
    const height = 128;
    expect(bendWeight(0, 40, height)).toBeCloseTo(bendWeight(-20, 60, height), 12);
  });

  it('bakes one weight per vertex, monotone with height', () => {
    const geometry = new THREE.ConeGeometry(20, 30, 7);
    bakeBend(geometry, 50, 128);
    const bend = geometry.getAttribute('aBend');
    const position = geometry.getAttribute('position');
    expect(bend.count).toBe(position.count);
    for (let i = 0; i < position.count; i++) {
      for (let k = 0; k < position.count; k++) {
        if (position.getY(i) < position.getY(k)) {
          expect(bend.getX(i)).toBeLessThanOrEqual(bend.getX(k));
        }
      }
    }
  });
});

describe('a batch of trees', () => {
  const field = buildPropField(stand(6, 200), () => 12);
  const all = batches(field.group);
  const swaying = all.filter((m) => m.geometry.getAttribute('aBend'));

  it('draws the trees the scatter asked for', () => {
    expect(all.length).toBeGreaterThan(0);
    expect(swaying.length).toBe(all.length);
  });

  it('carries the wind attributes on every batch', () => {
    for (const mesh of swaying) {
      const base = mesh.geometry.getAttribute('aWindBase');
      const tune = mesh.geometry.getAttribute('aWindTune');
      expect(base).toBeDefined();
      expect(tune).toBeDefined();
      expect(base.count).toBe(mesh.count);
      expect(tune.count).toBe(mesh.count);
    }
  });

  it('samples the wind at the tree base, not at the part', () => {
    // The failure this exists for is canopy shear: a trunk and the four cones
    // above it evaluating the wind at four different points and tearing apart.
    // Every batch a tree appears in must write the *same* origin for it.
    const byTree = new Map<string, Set<string>>();
    for (const mesh of swaying) {
      const base = mesh.geometry.getAttribute('aWindBase');
      for (let i = 0; i < base.count; i++) {
        const key = `${Math.round(base.getX(i))},${Math.round(base.getZ(i))}`;
        const seen = byTree.get(key) ?? new Set<string>();
        seen.add(`${base.getX(i)},${base.getY(i)},${base.getZ(i)}`);
        byTree.set(key, seen);
      }
    }
    expect(byTree.size).toBe(6);
    for (const origins of byTree.values()) expect(origins.size).toBe(1);
  });

  it('stands the wind origin on the ground, not at the part offset', () => {
    // heightAt was 12 for every tree above. A batch that wrote the *cone's*
    // origin here would bend about a point a hundred units up the trunk, which
    // pins the crown and swings the base.
    for (const mesh of swaying) {
      const base = mesh.geometry.getAttribute('aWindBase');
      for (let i = 0; i < base.count; i++) expect(base.getY(i)).toBe(12);
    }
  });

  it('gives neighbouring trees different phases', () => {
    const phases = new Set<number>();
    for (const mesh of swaying) {
      const tune = mesh.geometry.getAttribute('aWindTune');
      for (let i = 0; i < tune.count; i++) phases.add(tune.getY(i));
    }
    expect(phases.size).toBeGreaterThan(1);
    // ...but only slightly: a large spread would dissolve the travelling wave
    // into noise, which is the opposite of what it is for.
    for (const phase of phases) expect(Math.abs(phase)).toBeLessThanOrEqual(0.25);
  });

  it('scales amplitude by the trunk against the crown', () => {
    for (const mesh of swaying) {
      const tune = mesh.geometry.getAttribute('aWindTune');
      for (let i = 0; i < tune.count; i++) {
        expect(tune.getX(i)).toBeGreaterThan(0.9);
        expect(tune.getX(i)).toBeLessThan(1);
      }
    }
  });

  it('bends its shadows with it', () => {
    // The sun's shadow map and the torch's cube map are drawn with materials of
    // their own. Without these the trees dance over shadows that stand still.
    for (const mesh of swaying) {
      expect(mesh.customDepthMaterial).toBeDefined();
      expect(mesh.customDistanceMaterial).toBeDefined();
      const patched = [mesh.material as THREE.Material, mesh.customDepthMaterial, mesh.customDistanceMaterial];
      for (const material of patched) {
        expect(material).toBeTruthy();
        expect(typeof material?.onBeforeCompile).toBe('function');
        expect(material?.customProgramCacheKey?.()).toBe('wind-sway');
      }
    }
  });

  it('splices the bend in after the instance transform, in both chunks', () => {
    // Before the instance matrix the vertex is not yet anywhere in the world, so
    // there is no base to swing about; after modelViewMatrix it is in eye space
    // and the wind direction means nothing. There is one correct seam and this
    // pins it -- in the view chunk *and* the world chunk, since the second is
    // what shadows are measured against.
    //
    // Fed the shader in the state three.js actually hands it over in: with the
    // `#include` directives still *unresolved*. An earlier version of this test
    // helpfully expanded them first, and so agreed with a patch that matched
    // nothing at all in the real shader -- which links, draws, and leaves the
    // forest standing perfectly still. That is the bug this shape catches.
    const mesh = swaying[0] as THREE.InstancedMesh;
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: [
        '#include <common>',
        'void main() {',
        '#include <begin_vertex>',
        '#include <project_vertex>',
        '#include <worldpos_vertex>',
        '}',
      ].join('\n'),
      fragmentShader: '',
    };
    (mesh.material as THREE.Material).onBeforeCompile?.(shader as never, null as never);

    const lines = shader.vertexShader.split('\n').map((l) => l.trim());
    const index = (needle: string): number => lines.findIndex((line) => line === needle);
    const bendView = index('mvPosition.xyz = windBend( mvPosition.xyz );');
    const bendWorld = index('worldPosition.xyz = windBend( worldPosition.xyz );');
    expect(bendView).toBeGreaterThan(index('mvPosition = instanceMatrix * mvPosition;'));
    expect(bendView).toBeLessThan(index('mvPosition = modelViewMatrix * mvPosition;'));
    expect(bendWorld).toBeGreaterThan(index('worldPosition = instanceMatrix * worldPosition;'));
    expect(bendWorld).toBeLessThan(index('worldPosition = modelMatrix * worldPosition;'));
    // No directive may survive the patch unexpanded, or the line it was supposed
    // to carry went nowhere.
    expect(shader.vertexShader).not.toContain('#include <project_vertex>');
    expect(shader.vertexShader).not.toContain('#include <worldpos_vertex>');
    // ...and it reads the one shared clock and the one shared wind, by
    // reference rather than by value. Copying any of them here is how a tree
    // ends up leaning into weather the water has never heard of.
    expect(shader.uniforms['uWindTime']).toBe(windTimeUniform);
    for (const [name, uniform] of Object.entries(WIND_UNIFORMS)) {
      expect(shader.uniforms[name]).toBe(uniform);
    }
  });

  it('leaves room in its bounds for the lean', () => {
    for (const mesh of swaying) {
      expect(mesh.boundingSphere).not.toBeNull();
      const rigid = new THREE.InstancedMesh(mesh.geometry, mesh.material, mesh.count);
      for (let i = 0; i < mesh.count; i++) {
        const matrix = new THREE.Matrix4();
        mesh.getMatrixAt(i, matrix);
        rigid.setMatrixAt(i, matrix);
      }
      rigid.computeBoundingSphere();
      const grown = (mesh.boundingSphere?.radius ?? 0) - (rigid.boundingSphere?.radius ?? 0);
      // Against the strongest wind the panel allows (spec 075), not the
      // default: the bounds are written once and the slider moves later.
      //
      // Bracketed by the species rather than pinned to one, because a batch is
      // per species and the three are different heights -- so the right answer
      // for a stand of pines is smaller than for a stand of firs, and asserting
      // either one alone passes for the wrong reason.
      //
      // The ceiling carries the lobed canopy's tilt as well (spec 077). A slab
      // is inflated for two motions, not one: the trunk's lean carries its
      // origin downwind and the tilt about that origin then throws its rim
      // further still, and a sphere sized for only the first takes the whole
      // batch off screen the moment that rim leaves it.
      const heights = TREE_SPECIES.map(speciesHeight);
      const floor = maxTipDisplacement(WIND, Math.min(...heights), WIND_LIMITS.maxStrength);
      const ceiling =
        maxTipDisplacement(WIND, Math.max(...heights), WIND_LIMITS.maxStrength) + maxCanopyTiltReach();
      expect(grown).toBeGreaterThanOrEqual(floor - 1e-6);
      expect(grown).toBeLessThanOrEqual(ceiling + 1e-6);
    }
  });

  it('draws the group at the origin, which is what makes the bend world-space', () => {
    // The splice above treats "after instanceMatrix" as world space. That is
    // only true while the prop field's group carries no transform of its own.
    expect(field.group.matrix.equals(new THREE.Matrix4())).toBe(true);
    expect(field.group.position.lengthSq()).toBe(0);
  });
});

describe('props that are not trees', () => {
  it('are left exactly as they were', () => {
    const bushes: Prop[] = [{ kind: 'bush', x: 0, y: 0, scale: 1, rotation: 0, tint: 0.4 }];
    const field = buildPropField(bushes, () => 0);
    for (const mesh of batches(field.group)) {
      expect(mesh.geometry.getAttribute('aBend')).toBeUndefined();
      expect(mesh.customDepthMaterial).toBeUndefined();
    }
    field.dispose();
  });
});

describe('the species a tree grows', () => {
  it('bakes a bend weight that reaches the top of whichever species it is', () => {
    // The weight is measured against the species height, not the part, so each
    // species reaches 1 at its own crown rather than the shorter ones topping
    // out partway up because they happen to be shorter.
    for (const species of TREE_SPECIES) {
      const props: Prop[] = [{ kind: 'tree', x: 0, y: 0, scale: 1, rotation: 0, tint: 0.5 }];
      // treeVariant is a hash of position, so a species is picked rather than
      // asked for; walk until this one turns up.
      let found = false;
      for (let i = 0; i < 400 && !found; i++) {
        const prop = { ...props[0], x: i * 37, y: i * 53 } as Prop;
        if (treeVariant(prop).species !== species) continue;
        found = true;
        const field = buildPropField([prop], () => 0);
        let top = 0;
        for (const mesh of batches(field.group)) {
          const bend = mesh.geometry.getAttribute('aBend');
          for (let k = 0; k < bend.count; k++) top = Math.max(top, bend.getX(k));
        }
        // The tallest tier of a full-grown tree reaches the crown exactly; a
        // sapling that drew fewer tiers stops short, which is correct.
        expect(top).toBeGreaterThan(0.6);
        expect(top).toBeLessThanOrEqual(1);
        field.dispose();
      }
      expect(found).toBe(true);
    }
  });
});
