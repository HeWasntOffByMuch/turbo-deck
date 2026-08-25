import { describe, expect, it } from 'vitest';
import { AURA_ORDER, AuraTracker, aurasFor, pixelsForWorld, ringsSeparated, type AuraFacts } from './auras.js';
import { EFFECTS } from '../vfx/registry.js';
import { ALL_AURA_FIELDS, SCORCHED_EARTH } from '../../../server/data/aura-fields.js';
import { StatusId } from '../../../server/sim/statuses.js';
import { RENDER_H, MAX_RENDER_W } from '../view-frame.js';

function facts(overrides: Partial<AuraFacts> = {}): AuraFacts {
  return {
    entityId: 1,
    casting: false,
    channelling: false,
    selected: false,
    telegraphing: false,
    healthFraction: 1,
    ...overrides,
  };
}

describe('aurasFor', () => {
  it('shows nothing on a unit with nothing happening to it', () => {
    expect(aurasFor(facts())).toEqual([]);
  });

  it('is a pure function of its facts', () => {
    const state = facts({ selected: true, channelling: true });
    expect(aurasFor(state)).toEqual(aurasFor(state));
  });

  it('draws the selected ring on the target', () => {
    expect(aurasFor(facts({ selected: true }))).toEqual(['aura_selected']);
  });

  it('draws a channel but not an ordinary wind-up', () => {
    // A ring that flashes on and off every swing is noise, not information.
    expect(aurasFor(facts({ casting: true }))).toEqual([]);
    expect(aurasFor(facts({ channelling: true }))).toEqual(['aura_channel']);
  });

  it('draws every status it is given', () => {
    const shown = aurasFor(facts({ statuses: ['poison', 'shield', 'buff'] }));
    expect(shown).toContain('aura_poison');
    expect(shown).toContain('aura_shield');
    expect(shown).toContain('aura_buff');
  });

  it('returns them in a fixed order, whatever order they arrived in', () => {
    // Two units with the same statuses must show the same picture, and a ring
    // must never change radius because something else was applied.
    const one = aurasFor(facts({ statuses: ['shield', 'poison', 'buff'] }));
    const other = aurasFor(facts({ statuses: ['buff', 'shield', 'poison'] }));
    expect(one).toEqual(other);
    const indices = one.map((id) => AURA_ORDER.indexOf(id));
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it('never repeats an aura', () => {
    const shown = aurasFor(facts({ statuses: ['poison', 'poison', 'poison'] }));
    expect(shown).toEqual(['aura_poison']);
  });

  it('names only effects the registry actually holds', () => {
    // The stub-table failure: a name that looks right and silently plays nothing.
    const known = new Set(EFFECTS.map((effect) => effect.id));
    for (const id of AURA_ORDER) expect(known.has(id)).toBe(true);
  });
});

describe('the field branch (spec 223)', () => {
  it('shows a field’s own ring for a body carrying it', () => {
    expect(aurasFor(facts({ fields: [StatusId.ScorchedEarth] }))).toEqual([
      SCORCHED_EARTH.auraEffectId,
    ]);
  });

  it('shows nothing for a status that is not a field', () => {
    // A client reading a newer server sees a status id it has a visual for and
    // no field row: the honest answer is no ring, never a stand-in one, because
    // this ring's radius is a claim about where a hazard is.
    expect(aurasFor(facts({ fields: [StatusId.Burn, 'not.a.field'] }))).toEqual([]);
  });

  it('keeps a field’s ring in AURA_ORDER beside the rest', () => {
    const shown = aurasFor(facts({ selected: true, fields: [StatusId.ScorchedEarth] }));
    expect(shown).toEqual(['aura_selected', SCORCHED_EARTH.auraEffectId]);
  });

  it('draws every field’s ring at the field’s own reach', () => {
    // The whole reason `library.ts` imports the table: the ring is not
    // decoration around the mechanic, it is where the fire is. Read back off the
    // compiled effect rather than off the call, so a future edit to either end
    // fails here.
    for (const field of ALL_AURA_FIELDS) {
      const effect = EFFECTS.find((row) => row.id === field.auraEffectId);
      expect(effect, field.auraEffectId).toBeDefined();
      const ring = effect?.emitters.find((emitter) => emitter.id === 'ring');
      expect(ring, `${field.auraEffectId} has no ring emitter`).toBeDefined();
      expect(ring?.size.keys[0]?.[1], field.auraEffectId).toBe(field.radius);
      // And it is in the order table, or it is authored and never asked for.
      expect(AURA_ORDER, field.auraEffectId).toContain(field.auraEffectId);
    }
  });
});

describe('AuraTracker', () => {
  it('starts each aura exactly once', () => {
    const tracker = new AuraTracker();
    expect(tracker.step(1, ['aura_poison'])).toEqual({ start: ['aura_poison'], stop: [] });
    expect(tracker.step(1, ['aura_poison'])).toEqual({ start: [], stop: [] });
    expect(tracker.step(1, ['aura_poison'])).toEqual({ start: [], stop: [] });
  });

  it('stops one when its condition ends, and leaves the rest alone', () => {
    const tracker = new AuraTracker();
    tracker.step(1, ['aura_poison', 'aura_shield']);
    expect(tracker.step(1, ['aura_shield'])).toEqual({ start: [], stop: ['aura_poison'] });
    expect(tracker.running(1)).toEqual(['aura_shield']);
  });

  it('stops everything when a unit goes clean', () => {
    const tracker = new AuraTracker();
    tracker.step(1, ['aura_poison', 'aura_buff']);
    const change = tracker.step(1, []);
    expect(change.start).toEqual([]);
    expect(change.stop).toEqual(['aura_poison', 'aura_buff']);
    expect(tracker.entities()).toEqual([]);
  });

  it('keeps two units apart', () => {
    const tracker = new AuraTracker();
    tracker.step(1, ['aura_poison']);
    expect(tracker.step(2, ['aura_poison'])).toEqual({ start: ['aura_poison'], stop: [] });
    expect(tracker.step(1, ['aura_poison'])).toEqual({ start: [], stop: [] });
  });

  it('hands back everything a despawned body owned', () => {
    // The orphan case: a unit dies mid-poison and its ring has to go with it.
    const tracker = new AuraTracker();
    tracker.step(7, ['aura_poison', 'aura_debuff']);
    expect(tracker.forget(7)).toEqual(['aura_poison', 'aura_debuff']);
    expect(tracker.forget(7)).toEqual([]);
    expect(tracker.entities()).toEqual([]);
  });

  it('costs nothing for a unit that never had one', () => {
    const tracker = new AuraTracker();
    expect(tracker.step(3, [])).toEqual({ start: [], stop: [] });
    expect(tracker.entities()).toEqual([]);
  });

  it('survives a long run of changing state without leaking', () => {
    const tracker = new AuraTracker();
    for (let i = 0; i < 500; i++) {
      const wanted = aurasFor(facts({ selected: i % 3 === 0, channelling: i % 5 === 0, statuses: i % 7 === 0 ? ['poison'] : [] }));
      tracker.step(1, wanted);
      expect(tracker.running(1)).toEqual(wanted);
    }
    tracker.forget(1);
    expect(tracker.entities()).toEqual([]);
  });
});

describe('readability at gameplay zoom', () => {
  // The frame is at most MAX_RENDER_W x RENDER_H, and the camera shows roughly
  // this many world units across at the default zoom.
  const VIEW_WIDTH = 900;

  /** The authored ring radii, read out of the library rather than restated. */
  const radii = new Map<string, number>();
  for (const effect of EFFECTS) {
    if (!AURA_ORDER.includes(effect.id)) continue;
    const ring = effect.emitters.find((emitter) => emitter.id === 'ring');
    // The middle keyframe is the pulse's peak, which is the radius to judge by.
    const keys = ring?.size.keys ?? [];
    const peak = Math.max(...keys.map(([, value]) => value));
    radii.set(effect.id, peak);
  }

  it('reads every authored aura', () => {
    expect(radii.size).toBe(AURA_ORDER.length);
  });

  it('draws every ring at least a few pixels across', () => {
    // A ring the frame cannot resolve is a ring nobody can act on.
    for (const [id, radius] of radii) {
      const pixels = pixelsForWorld(radius * 2, VIEW_WIDTH, MAX_RENDER_W);
      expect(pixels, `${id} is ${pixels.toFixed(1)}px across`).toBeGreaterThan(8);
    }
  });

  it('keeps the whole stack inside the frame', () => {
    // The outermost ring is the boss telegraph, and a telegraph taller than the
    // window is one the player cannot see the edge of.
    const widest = Math.max(...radii.values());
    expect(pixelsForWorld(widest * 2, VIEW_WIDTH, MAX_RENDER_W)).toBeLessThan(RENDER_H);
  });

  it('separates every neighbouring pair so two statuses read as two rings', () => {
    // The property that makes "stacking two statuses looks intentional" a fact
    // rather than an intention: at this resolution two rings a world unit apart
    // are the same pixel, and the player sees one smear whose colour is neither.
    const ordered = AURA_ORDER.map((id) => radii.get(id) ?? 0);
    for (let i = 1; i < ordered.length; i++) {
      const inner = ordered[i - 1] ?? 0;
      const outer = ordered[i] ?? 0;
      expect(
        ringsSeparated(inner, outer, VIEW_WIDTH, MAX_RENDER_W, 2),
        `${AURA_ORDER[i - 1]} (${inner}) and ${AURA_ORDER[i]} (${outer}) are too close`,
      ).toBe(true);
    }
  });

  it('stays separated even zoomed well out', () => {
    const ordered = AURA_ORDER.map((id) => radii.get(id) ?? 0);
    for (let i = 1; i < ordered.length; i++) {
      expect(ringsSeparated(ordered[i - 1] ?? 0, ordered[i] ?? 0, VIEW_WIDTH * 2, MAX_RENDER_W, 1)).toBe(true);
    }
  });
});

describe('pixelsForWorld', () => {
  it('scales with the frame and against the view', () => {
    expect(pixelsForWorld(100, 1000, 800)).toBeCloseTo(80, 6);
    expect(pixelsForWorld(100, 500, 800)).toBeCloseTo(160, 6);
  });

  it('refuses a degenerate view rather than dividing by zero', () => {
    expect(pixelsForWorld(100, 0, 800)).toBe(0);
  });
});
