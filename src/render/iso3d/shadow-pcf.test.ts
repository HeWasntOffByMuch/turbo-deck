import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { installPoissonShadows, shadowRadiusFor } from './shadow-pcf.js';

/**
 * Imports three on purpose, so it is deliberately outside `PURE_RENDER`: what is
 * being checked here is a claim about *three's own shader chunk*, which is the
 * one thing a pure test could not look at.
 */

describe('installPoissonShadows', () => {
  it('splices the filter into the chunk every material includes', () => {
    installPoissonShadows();
    const chunk = THREE.ShaderChunk['shadowmap_pars_fragment'] ?? '';
    expect(chunk).toContain('float hikePoissonShadow(');
    // And the unfiltered branch now chooses, rather than always taking one tap.
    expect(chunk).toContain('shadowRadius > 0.0');
  });

  it('is idempotent, because applying it twice would not compile', () => {
    // A redefined GLSL function is a compile error, and three.js *logs* a failed
    // compile and carries on -- so a second install would leave the frame
    // rendering off a fallback with the note scrolled past. Cheap to guarantee,
    // impossible to notice.
    installPoissonShadows();
    installPoissonShadows();
    installPoissonShadows();
    const chunk = THREE.ShaderChunk['shadowmap_pars_fragment'] ?? '';
    const definitions = chunk.split('float hikePoissonShadow(').length - 1;
    expect(definitions).toBe(1);
  });

  it('leaves the other shadow paths alone', () => {
    installPoissonShadows();
    const chunk = THREE.ShaderChunk['shadowmap_pars_fragment'] ?? '';
    // The point-light path is a different function over a cube map and is out of
    // scope; the PCF branches are what three compiles for other shadow map types
    // and must still be there for anyone who switches one on.
    expect(chunk).toContain('float getPointShadow(');
    expect(chunk).toContain('SHADOWMAP_TYPE_PCF_SOFT');
  });
});

describe('shadowRadiusFor', () => {
  it('is zero when the feature is off, which three does not default to', () => {
    // `light.shadow.radius` starts at 1. Leaving it alone would soften every
    // shadow in the world with nothing switched on, so "off" has to be written.
    expect(shadowRadiusFor(false, 3)).toBe(0);
    expect(new THREE.DirectionalLight().shadow.radius).not.toBe(0);
  });

  it('passes the setting through when it is on', () => {
    expect(shadowRadiusFor(true, 2.5)).toBe(2.5);
  });

  it('refuses a negative radius, which would mirror the kernel', () => {
    expect(shadowRadiusFor(true, -4)).toBe(0);
  });
});
