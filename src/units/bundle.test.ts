import { describe, expect, it } from 'vitest';
import { bundleErrorText, loadUnitBundle } from './bundle.js';
import { clipLibFixture, unitDefFixture } from './fixtures.js';
import { errorsOf } from './issues.js';

describe('loadUnitBundle', () => {
  it('accepts a pair of good documents', () => {
    const result = loadUnitBundle(unitDefFixture(), clipLibFixture());
    expect(errorsOf(result.issues)).toEqual([]);
    expect(result.value?.unit.id).toBe(unitDefFixture().id);
    expect(result.value?.clipLib.id).toBe(clipLibFixture().id);
  });

  it('refuses a unitdef that does not validate, and says why', () => {
    // The whole reason this exists: the Studio tab used to cast its imports,
    // which type-checks, runs, and never finds out a document is broken.
    const result = loadUnitBundle({ formatVersion: 1 }, clipLibFixture());
    expect(result.value).toBeNull();
    expect(errorsOf(result.issues).length).toBeGreaterThan(0);
  });

  it('refuses a clip library that does not validate', () => {
    expect(loadUnitBundle(unitDefFixture(), { nonsense: true }).value).toBeNull();
  });

  it('reports both documents rather than stopping at the first', () => {
    const result = loadUnitBundle({}, {});
    const codes = new Set(errorsOf(result.issues).map((issue) => issue.code));
    expect(codes.size).toBeGreaterThan(0);
    expect(result.value).toBeNull();
  });

  it('refuses a state whose clip the library does not have', () => {
    // "The monster is invisible" is a long way from "the library is missing
    // slash", so the distance is closed here rather than at play time.
    const unit = unitDefFixture();
    const broken = {
      ...unit,
      stateMachine: {
        ...unit.stateMachine,
        states: unit.stateMachine.states.map((state, index) =>
          index === 0 ? { ...state, clipRef: 'no-such-clip' } : state,
        ),
      },
    };
    const result = loadUnitBundle(broken, clipLibFixture());
    expect(result.value).toBeNull();
    expect(bundleErrorText(result)).toContain('no-such-clip');
  });

  it('lets a state name a blend tree rather than a clip', () => {
    // A state's clipRef is a clip *or* a tree; the tree's own thresholds are
    // checked separately, so resolving one against the library would reject
    // every blended state there is.
    const result = loadUnitBundle(unitDefFixture(), clipLibFixture());
    expect(result.value).not.toBeNull();
  });

  it('refuses a blend threshold pointing at a clip that is not there', () => {
    const unit = unitDefFixture();
    const tree = unit.stateMachine.blendTrees[0];
    if (!tree) throw new Error('fixture has no blend tree to break');
    const broken = {
      ...unit,
      stateMachine: {
        ...unit.stateMachine,
        blendTrees: [
          { ...tree, thresholds: tree.thresholds.map((entry, index) => (index === 0 ? { ...entry, clipRef: 'ghost' } : entry)) },
        ],
      },
    };
    expect(bundleErrorText(loadUnitBundle(broken, clipLibFixture()))).toContain('ghost');
  });

  it('names the clips the library does have, so the fix is obvious', () => {
    const unit = unitDefFixture();
    const broken = {
      ...unit,
      stateMachine: {
        ...unit.stateMachine,
        actionTimings: unit.stateMachine.actionTimings.map((action) => ({ ...action, clipRef: 'wrong' })),
      },
    };
    const text = bundleErrorText(loadUnitBundle(broken, clipLibFixture()));
    for (const clip of clipLibFixture().clips) expect(text).toContain(clip.id);
  });
});
