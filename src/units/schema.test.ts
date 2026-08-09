import { describe, expect, it } from 'vitest';
import skeletonDoc from '../../assets/units/biped.skeleton.json' with { type: 'json' };
import { clipLibFixture, skeletonFixture, unitDefFixture } from './fixtures.js';
import { compileAllSchemas, SCHEMAS, validateAgainstSchema, type DocumentKind } from './schema.js';
import { validateSkeleton } from './validate.js';

const KINDS: readonly DocumentKind[] = ['skeleton', 'cliplib', 'unitdef'];

describe('the committed schemas', () => {
  it('all compile', () => {
    // ajv in strict mode throws on a schema with an unknown keyword or a
    // mistyped one, so this is the check that a hand-edited schema is a schema.
    expect(() => compileAllSchemas()).not.toThrow();
  });

  it('each declare a draft and an id', () => {
    for (const kind of KINDS) {
      const schema = SCHEMAS[kind] as Record<string, unknown>;
      expect(schema['$schema']).toBe('http://json-schema.org/draft-07/schema#');
      expect(schema['$id']).toContain(`${kind}.schema.json`);
    }
  });

  it('accept the fixtures', () => {
    expect(validateAgainstSchema('skeleton', skeletonFixture())).toEqual([]);
    expect(validateAgainstSchema('cliplib', clipLibFixture())).toEqual([]);
    expect(validateAgainstSchema('unitdef', unitDefFixture())).toEqual([]);
  });
});

describe('the shipped biped skeleton', () => {
  it('validates, with provisional as its only complaint', () => {
    const result = validateSkeleton(skeletonDoc);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual(['skeleton.provisional']);
    expect(result.value).not.toBeNull();
  });

  it('is a mixamo biped with no finger joints', () => {
    const result = validateSkeleton(skeletonDoc);
    expect(result.value?.naming).toBe('mixamo');
    expect(result.value?.bones).toHaveLength(25);
    // Inside the 15..30 budget the checklist asks for, and no finger warning --
    // the warning is tested against a rig that has them, in validate.test.ts.
    expect(result.issues.some((issue) => issue.code === 'skeleton.fingers')).toBe(false);
  });
});

describe('formatVersion', () => {
  it('is required on every document type', () => {
    for (const kind of KINDS) {
      const fixture: Record<string, unknown> = {
        skeleton: { ...skeletonFixture() },
        cliplib: { ...clipLibFixture() },
        unitdef: { ...unitDefFixture() },
      }[kind] as Record<string, unknown>;
      delete fixture['formatVersion'];
      const issues = validateAgainstSchema(kind, fixture);
      expect(issues.map((issue) => issue.code)).toContain('schema.required');
    }
  });

  it('rejects a version this build does not know', () => {
    // A reader that guessed at version 2 would be reading fields that may have
    // changed meaning. Refusing is the only safe answer.
    const issues = validateAgainstSchema('skeleton', { ...skeletonFixture(), formatVersion: 2 });
    expect(issues.map((issue) => issue.code)).toContain('schema.const');
  });
});

describe('additionalProperties', () => {
  it('rejects a typo rather than ignoring it, and names the key', () => {
    // The whole point: `blendInMS` instead of `blendInMs` must not be a field
    // that silently does nothing and an evening spent wondering why.
    const unit = unitDefFixture();
    const states = unit.stateMachine.states.map((state) => ({ ...state }));
    const first = { ...states[0], blendInMS: 120 } as unknown as Record<string, unknown>;
    const broken = {
      ...unit,
      stateMachine: { ...unit.stateMachine, states: [first, ...states.slice(1)] },
    };
    const issues = validateAgainstSchema('unitdef', broken);
    expect(issues.map((issue) => issue.code)).toContain('schema.additionalProperties');
    expect(issues.some((issue) => issue.message.includes('blendInMS'))).toBe(true);
  });

  it('rejects an unknown key at the root of each document type', () => {
    for (const kind of KINDS) {
      const fixture = {
        skeleton: skeletonFixture(),
        cliplib: clipLibFixture(),
        unitdef: unitDefFixture(),
      }[kind];
      const issues = validateAgainstSchema(kind, { ...fixture, surprise: true });
      expect(issues.map((issue) => issue.code)).toContain('schema.additionalProperties');
    }
  });

  it('still allows $comment, so an authored file can explain itself', () => {
    expect(validateAgainstSchema('skeleton', { ...skeletonFixture(), $comment: 'why 55.65' })).toEqual([]);
    expect(validateAgainstSchema('cliplib', { ...clipLibFixture(), $comment: 'the core set' })).toEqual([]);
    expect(validateAgainstSchema('unitdef', { ...unitDefFixture(), $comment: 'the first grunt' })).toEqual([]);
  });
});

describe('schema issues', () => {
  it('carry a JSON pointer at the offending field', () => {
    const lib = clipLibFixture();
    const clips = lib.clips.map((clip) => ({ ...clip }));
    const broken = {
      ...lib,
      clips: [{ ...clips[0], durationMs: 0 }, ...clips.slice(1)],
    };
    const issues = validateAgainstSchema('cliplib', broken);
    expect(issues.map((issue) => issue.path)).toContain('/clips/0/durationMs');
  });

  it('report every problem rather than stopping at the first', () => {
    const issues = validateAgainstSchema('skeleton', { formatVersion: 1 });
    expect(issues.length).toBeGreaterThan(3);
  });
});

describe('paths', () => {
  it('insist a clip source and a mesh are .glb', () => {
    // Only .glb reaches the client; conversion is offline. A .fbx or an .obj in
    // a ref is a pipeline that skipped the bake.
    const lib = clipLibFixture();
    const clips = lib.clips.map((clip) => ({ ...clip }));
    const broken = { ...lib, clips: [{ ...clips[0], source: 'clips/idle.fbx' }, ...clips.slice(1)] };
    expect(validateAgainstSchema('cliplib', broken).map((i) => i.path)).toContain('/clips/0/source');
    expect(
      validateAgainstSchema('unitdef', { ...unitDefFixture(), meshRef: 'units/grunt.fbx' }).map((i) => i.path),
    ).toContain('/meshRef');
  });
});

describe('provenance', () => {
  it('is required in full, so an asset cannot lose what it cost', () => {
    const unit = unitDefFixture();
    for (const field of [
      'tripoTaskIds',
      'modelVersion',
      'faceLimit',
      'referenceImageSha256',
      'creditsSpent',
      'generatedAt',
    ]) {
      // Built by filtering rather than by `delete`, which the lint rules reject
      // on a computed key -- and which would be the only way to write this loop
      // over field names.
      const provenance = Object.fromEntries(
        Object.entries(unit.provenance).filter(([key]) => key !== field),
      );
      const issues = validateAgainstSchema('unitdef', { ...unit, provenance });
      expect(issues.map((issue) => issue.code), `missing ${field}`).toContain('schema.required');
    }
  });

  it('insists the reference image hash is a sha256', () => {
    // A short or upper-case hash would still be a string, and cache lookups
    // would miss it forever without ever saying so.
    for (const hash of ['', 'abc', 'A'.repeat(64), 'a'.repeat(63)]) {
      const unit = unitDefFixture();
      const issues = validateAgainstSchema('unitdef', {
        ...unit,
        provenance: { ...unit.provenance, referenceImageSha256: hash },
      });
      expect(issues.length, `hash ${hash}`).toBeGreaterThan(0);
    }
  });

  it('accepts a null rig task, for a unit that reused the canonical rig', () => {
    const unit = unitDefFixture();
    const issues = validateAgainstSchema('unitdef', {
      ...unit,
      provenance: {
        ...unit.provenance,
        tripoTaskIds: { ...unit.provenance.tripoTaskIds, rig: null, retarget: [] },
      },
    });
    expect(issues).toEqual([]);
  });
});
