import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { NORMAL_SPLICE, SPLICES } from './sway.js';

/**
 * Regression guards on how three.js lights and shades (spec 097, step 2).
 *
 * Three of step 2's requirements turned out to be satisfied already, by r160
 * rather than by anything in this repo: lighting is computed per fragment,
 * interpolated normals are normalized before use, and point-light falloff is
 * inverse-square with a window that reaches exactly zero at the radius. Nothing
 * here configures any of that.
 *
 * Which is the same reason `color-space.test.ts` exists. Each of these is a
 * default, and each would flip silently -- a `useLegacyLights = true` slipped in,
 * or a three upgrade rearranging a shader chunk. The frame would keep drawing,
 * and the numbers the edge and ink thresholds are tuned against would quietly
 * mean something else.
 *
 * These read three.js's own shader chunks rather than rendering anything, so they
 * run in the same headless `node` environment as everything else.
 */

describe('Lambert lighting is per fragment', () => {
  const frag = THREE.ShaderChunk['meshlambert_frag'] ?? '';
  const vert = THREE.ShaderChunk['meshlambert_vert'] ?? '';

  it('resolves the normal and accumulates light in the fragment shader', () => {
    // Not the vertex shader: `MeshLambertMaterial` was per-vertex long ago, and
    // "move lighting to per-fragment" is only already done because it is not any
    // more.
    expect(frag).toContain('#include <normal_fragment_begin>');
    expect(frag).toContain('#include <lights_fragment_begin>');
  });

  it('leaves the vertex shader accumulating no light of its own', () => {
    expect(vert).not.toContain('lights_lambert_vertex');
  });
});

describe('interpolated normals are normalized before use', () => {
  const begin = THREE.ShaderChunk['normal_fragment_begin'] ?? '';

  it('normalizes the varying', () => {
    // Interpolating two unit normals across a triangle gives something shorter
    // than unit in the middle, which reads as a dark band down a smooth surface.
    expect(begin).toContain('vec3 normal = normalize( vNormal );');
  });

  it('derives a face normal from the displaced position when flat-shaded', () => {
    // Why the wind sway has never needed to rotate its normals: flat shading
    // takes derivatives of the *interpolated view position*, which the sway has
    // already bent, so the lighting follows the bend without being told.
    expect(begin).toContain('#ifdef FLAT_SHADED');
    expect(begin).toContain('dFdx( vViewPosition )');
  });

  it('does not even write the varying while flat-shaded', () => {
    // The other half of the same fact, and the reason `swayNormals` is inert
    // until `smoothNormals` is on: there is nothing for it to affect.
    expect(THREE.ShaderChunk['normal_vertex']).toContain('#ifndef FLAT_SHADED');
  });
});

describe('point-light falloff', () => {
  it('is inverse-square with a window that reaches zero at the radius', () => {
    // Exactly what step 2 asks for, already: `1/d^2` windowed by
    // `saturate(1 - (d/r)^4)^2`, which is zero *at* the radius rather than
    // clipped near it -- so there is no cutoff ring where the torch ends.
    const lights = THREE.ShaderChunk['lights_pars_begin'] ?? '';
    expect(lights).toContain('float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );');
    expect(lights).toContain('distanceFalloff *= pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) );');
  });

  it('takes that branch by default, not the legacy one', () => {
    // The windowed form is behind `#ifndef LEGACY_LIGHTS`, and which side of that
    // a build lands on is decided by a renderer flag nobody sets here. r155
    // changed the default; this is what holds it.
    // Read off the prototype's descriptor rather than constructing a renderer,
    // which would need a canvas and a GL context.
    const descriptor = Object.getOwnPropertyDescriptor(THREE.WebGLRenderer.prototype, 'useLegacyLights');
    expect(descriptor?.get).toBeTypeOf('function');
    expect(descriptor?.get?.call({ _useLegacyLights: false })).toBe(false);
  });
});

describe('the sway splices still match the chunks they patch', () => {
  it('found somewhere to put the bend', () => {
    // `sway.ts` throws at module load if a splice matched nothing, so importing
    // it is most of this test. Asserting the shape as well means a splice that
    // starts matching the *wrong* line is caught too.
    for (const splice of SPLICES) expect(splice.source).toContain('windBend(');
  });

  it('rotates the normal while it is still in world space', () => {
    // After the instance matrix has been applied to it and before `normalMatrix`
    // takes it to view space -- the wind direction is a world-space vector, so
    // anywhere else the rotation would be about the wrong axis.
    const lines = NORMAL_SPLICE.source.split('\n').map((l) => l.trim());
    const instanced = lines.indexOf('transformedNormal = im * transformedNormal;');
    const bent = lines.indexOf('transformedNormal = windBendNormal( transformedNormal );');
    const toView = lines.indexOf('transformedNormal = normalMatrix * transformedNormal;');
    expect(instanced).toBeGreaterThanOrEqual(0);
    expect(bent).toBe(instanced + 1);
    expect(toView).toBeGreaterThan(bent);
  });
});
