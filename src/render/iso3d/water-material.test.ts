import { describe, expect, it } from 'vitest';
import { waterFragmentShader } from './water-material.js';

/**
 * The water shader is a *string* until a GPU sees it, so neither the type
 * system nor any amount of headless testing of what it computes will notice
 * that it does not compile (spec 073).
 *
 * It got shipped broken exactly once, and instructively: the art-direction
 * constants were substituted with a chain of `String.replace` calls, which take
 * a string pattern and replace the **first** occurrence only. Every constant
 * used twice compiled with its second use left as an undeclared identifier, and
 * the only thing that noticed was Chromium. What is checked here is the class of
 * mistake rather than that one instance: after substitution, every screaming-
 * case identifier in the source must be one the source itself declares.
 */

/** GLSL with comments stripped, so a word in prose is not read as an identifier. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

describe('the assembled water shader', () => {
  const source = code(waterFragmentShader());

  it('leaves no identifier undeclared', () => {
    const declared = new Set<string>();
    for (const [, name] of source.matchAll(/\bconst\s+\w+\s+([A-Z][A-Z0-9_]*)\s*=/g)) {
      if (name) declared.add(name);
    }
    // Everything three.js supplies or GLSL defines that legitimately screams.
    const provided = new Set(['WIND_CHUNK']);
    const used = new Set<string>();
    for (const [name] of source.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) used.add(name);

    const undeclared = [...used].filter((name) => !declared.has(name) && !provided.has(name));
    expect(undeclared).toEqual([]);
    // ...and the scan actually found something, or an empty list means nothing.
    expect(declared.size).toBeGreaterThan(4);
  });

  it('substitutes every use of a constant, not just the first', () => {
    // The specific regression. WIND_DIR is used three times across the wind
    // chunk and the streak layer, and SHORE_RANGE twice.
    expect(source).not.toMatch(/\bSHORE_RANGE_VALUE\b/);
    expect(source.match(/\bWIND_DIR\b/g)?.length ?? 0).toBeGreaterThan(2);
  });

  it('declares the wind chunk it was handed', () => {
    expect(source).toContain('uniform float uWindTime;');
    expect(source).toContain('float warpedField(');
    expect(source).toContain('float bayer4(');
    expect(source).toContain('float windStreak(');
  });

  it('bands with step and never with smoothstep', () => {
    // The whole look. A soft boundary anywhere in here is the one change that
    // would quietly turn four flat colours back into a gradient.
    expect(source).not.toContain('smoothstep');
    expect(source.match(/\bstep\(/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it('has nothing view-dependent in it', () => {
    // The camera angle is constant, so fresnel and reflection have one answer
    // and it is already in the palette. Anything that reads the eye vector here
    // is fill rate spent recomputing a constant.
    for (const banned of ['cameraPosition', 'viewMatrix', 'reflect(', 'refract(']) {
      expect(source).not.toContain(banned);
    }
  });
});
