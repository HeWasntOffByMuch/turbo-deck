import { describe, expect, it } from 'vitest';
import { previewFrame } from './vfx-frame.js';
import { EFFECTS } from '../vfx/registry.js';
import type { EffectDefinition } from '../vfx/types.js';

function effect(id: string): EffectDefinition {
  const found = EFFECTS.find((entry) => entry.id === id);
  if (!found) throw new Error(`${id} is not in the registry`);
  return found;
}

describe('the preview frame', () => {
  it('is deterministic, since the sim it measures is', () => {
    const a = previewFrame(effect('aura_telegraph'), 30);
    const b = previewFrame(effect('aura_telegraph'), 30);
    expect(a).toEqual(b);
  });

  it('holds the whole of the biggest aura', () => {
    // The report this exists for: a 110-unit sigil is 220 across, the preview's
    // box was a fixed 220 tall, and raising the camera cropped the far side.
    const frame = previewFrame(effect('aura_telegraph'), 30);
    expect(frame.span).toBeGreaterThan(220);
  });

  it('grows with the effect', () => {
    const small = previewFrame(effect('aura_selected'), 30);
    const large = previewFrame(effect('aura_telegraph'), 30);
    expect(large.span).toBeGreaterThan(small.span * 2);
  });

  it('aims at the effect rather than at a fixed height', () => {
    // A campfire's smoke column tops out well above its base, so the middle of
    // what is drawn is nowhere near the spawn point.
    const frame = previewFrame(effect('campfire'), 30);
    expect(frame.centreY).toBeGreaterThan(30);
  });

  it('leaves air around the effect rather than framing it edge to edge', () => {
    // A ring touching the edge of frame reads as cropped even when it is whole.
    const frame = previewFrame(effect('aura_shield'), 0);
    // The sigil is 74 units of radius, so 148 across.
    expect(frame.span).toBeGreaterThan(148 * 1.1);
  });

  it('frames every effect in the library without collapsing', () => {
    for (const entry of EFFECTS) {
      const frame = previewFrame(entry, 30, 90);
      expect(Number.isFinite(frame.span), entry.id).toBe(true);
      expect(Number.isFinite(frame.centreY), entry.id).toBe(true);
      expect(frame.span, entry.id).toBeGreaterThanOrEqual(40);
      // Nothing in the library is a kilometre across; a span that big means a
      // stray particle was measured rather than the effect.
      expect(frame.span, entry.id).toBeLessThan(1200);
    }
  });

  it('falls back to the spawn point when it never sees a particle', () => {
    // Zero ticks, because "an effect that emits nothing" is not reachable
    // through the definition: a burst fires `max(1, count * scale)` on purpose,
    // so that an effect degraded under pressure still says *something* happened.
    const delayed: EffectDefinition = {
      id: 'silent_test',
      priority: 0,
      emitters: [
        {
          id: 'none',
          shape: { kind: 'point' },
          emission: { kind: 'burst', count: 1, delayTicks: 500 },
          lifetimeTicks: [10, 10],
          speed: [0, 0],
          size: { keys: [[0, 4]] },
          alpha: { keys: [[0, 1]] },
          color: { stops: [[0, 'physicalBone']] },
          render: 'billboard',
          blend: 'alpha',
        },
      ],
    };
    expect(previewFrame(delayed, 42, 20)).toEqual({ span: 80, centreY: 42 });
  });
});
