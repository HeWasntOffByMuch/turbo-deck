import { describe, expect, it } from 'vitest';
import {
  clampToSpec,
  EMITTER_FIELDS,
  fieldGroups,
  readField,
  UNEDITED_KEYS,
  writeField,
} from './vfx-fields.js';
import {
  addKey,
  addStop,
  autoRange,
  curveToPixels,
  gradientToPixels,
  moveKey,
  moveStop,
  pickKey,
  pickStop,
  pixelToCurve,
  removeKey,
  removeStop,
  setStopColor,
  type Box,
} from './curve-edit.js';
import { effectFromJson, effectToJson } from './vfx-json.js';
import { EFFECTS } from '../vfx/registry.js';
import { compileRegistry } from '../vfx/compile.js';
import type { Emitter } from '../vfx/types.js';
import type { Curve, Gradient } from '../vfx/curve.js';

const BOX: Box = { x: 10, y: 20, width: 200, height: 100 };

function sampleEmitter(): Emitter {
  const effect = EFFECTS.find((candidate) => candidate.id === 'hit_metal_spark');
  const emitter = effect?.emitters.find((candidate) => candidate.id === 'shower');
  if (!emitter) throw new Error('fixture missing');
  return emitter;
}

// --- the field table ---------------------------------------------------------

describe('EMITTER_FIELDS', () => {
  it('covers every key of Emitter exactly once, or names it as deliberately unedited', () => {
    // The check that makes a new field in the format fail a test rather than
    // being silently un-tunable -- which is invisible until somebody goes
    // looking for a slider that was never generated.
    const covered = new Set(EMITTER_FIELDS.map((field) => field.path.split('.')[0] as string));
    for (const key of UNEDITED_KEYS) covered.add(key);

    // Every key any shipped emitter actually uses.
    const used = new Set<string>();
    for (const effect of EFFECTS) {
      for (const emitter of effect.emitters) {
        for (const key of Object.keys(emitter)) used.add(key);
      }
    }
    const missing = [...used].filter((key) => !covered.has(key));
    expect(missing, `not editable and not declared unedited: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no duplicate paths', () => {
    const paths = EMITTER_FIELDS.map((field) => field.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('gives every numeric field a range to clamp against', () => {
    for (const field of EMITTER_FIELDS) {
      if (field.kind !== 'number' && field.kind !== 'range') continue;
      expect(field.min, field.path).toBeTypeOf('number');
      expect(field.max, field.path).toBeTypeOf('number');
      expect(field.max ?? 0).toBeGreaterThan(field.min ?? 0);
    }
  });

  it('gives every enum its options', () => {
    for (const field of EMITTER_FIELDS) {
      if (field.kind !== 'enum') continue;
      expect(field.options?.length ?? 0, field.path).toBeGreaterThan(1);
    }
  });

  it('puts every field in exactly one group', () => {
    const grouped = fieldGroups().flatMap((group) => group.fields);
    expect(grouped.length).toBe(EMITTER_FIELDS.length);
    expect(new Set(grouped.map((field) => field.path)).size).toBe(EMITTER_FIELDS.length);
  });
});

describe('readField and writeField', () => {
  it('reads a plain field', () => {
    expect(readField(sampleEmitter(), 'blend')).toBe('additive');
  });

  it('reads a nested field', () => {
    expect(readField(sampleEmitter(), 'collision.restitution')).toBeCloseTo(0.35, 5);
  });

  it('returns undefined for a missing branch rather than throwing', () => {
    expect(readField(sampleEmitter(), 'turbulence.amplitude')).toBeUndefined();
    expect(readField(sampleEmitter(), 'nope.nope.nope')).toBeUndefined();
  });

  it('round-trips every field kind', () => {
    const emitter = sampleEmitter();
    for (const [path, value] of [
      ['drag', 3.5],
      ['blend', 'alpha'],
      ['worldSpace', false],
      ['collision.friction', 0.9],
      ['turbulence.amplitude', 120],
      ['lifetimeTicks', [4, 9]],
    ] as const) {
      const written = writeField(emitter, path, value);
      expect(readField(written, path), path).toEqual(value);
    }
  });

  it('never mutates its input', () => {
    // Particles already in the air read their emitter every tick, so an in-place
    // write would change what a running effect is doing halfway through.
    const emitter = sampleEmitter();
    const before = JSON.stringify(emitter);
    writeField(emitter, 'drag', 99);
    writeField(emitter, 'collision.friction', 0.1);
    writeField(emitter, 'turbulence.amplitude', 500);
    expect(JSON.stringify(emitter)).toBe(before);
  });

  it('creates a missing branch on the way to a nested field', () => {
    const written = writeField(sampleEmitter(), 'turbulence.frequency', 0.05);
    expect(readField(written, 'turbulence.frequency')).toBe(0.05);
  });

  it('deletes a field when written undefined', () => {
    const written = writeField(sampleEmitter(), 'drag', undefined);
    expect(readField(written, 'drag')).toBeUndefined();
    expect('drag' in (written as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe('clampToSpec', () => {
  const spec = { path: 'drag', label: 'Drag', kind: 'number' as const, min: 0, max: 8 };

  it('holds a value inside its range', () => {
    expect(clampToSpec(spec, -5)).toBe(0);
    expect(clampToSpec(spec, 99)).toBe(8);
    expect(clampToSpec(spec, 3)).toBe(3);
  });

  it('turns a typed-in NaN into the minimum rather than poisoning the sim', () => {
    expect(clampToSpec(spec, Number.NaN)).toBe(0);
  });
});

// --- curve editing -----------------------------------------------------------

describe('curve editing', () => {
  const curve: Curve = { keys: [[0, 0], [0.5, 10], [1, 0]] };
  const range = { min: 0, max: 10 };

  it('round-trips a key through pixels', () => {
    for (const box of [BOX, { x: 0, y: 0, width: 50, height: 20 }, { x: 5, y: 5, width: 400, height: 300 }]) {
      const points = curveToPixels(curve, box, range);
      points.forEach((point, index) => {
        expect(pickKey(curve, box, range, point.x, point.y, 6), `${box.width}x${box.height} key ${index}`).toBe(index);
      });
    }
  });

  it('inverts pixels back to the curve', () => {
    const points = curveToPixels(curve, BOX, range);
    curve.keys.forEach(([t, value], index) => {
      const point = points[index] as { x: number; y: number };
      const back = pixelToCurve(BOX, range, point.x, point.y);
      expect(back.t).toBeCloseTo(t, 5);
      expect(back.value).toBeCloseTo(value, 5);
    });
  });

  it('picks nothing when the click is far away', () => {
    expect(pickKey(curve, BOX, range, 500, 500, 6)).toBe(-1);
  });

  it('picks the nearest of two close keys, not the first', () => {
    // Two keys near each other used to hand back whichever was earlier, so one
    // was undraggable and the other moved when you grabbed either.
    const tight: Curve = { keys: [[0.5, 5], [0.52, 5]] };
    const points = curveToPixels(tight, BOX, range);
    const second = points[1] as { x: number; y: number };
    expect(pickKey(tight, BOX, range, second.x, second.y, 20)).toBe(1);
  });

  it('keeps keys sorted when one is dragged past its neighbour', () => {
    // `sampleCurve` walks keys assuming they ascend, so an unsorted curve
    // samples as garbage rather than as something merely odd.
    const moved = moveKey(curve, 0, 0.9, 4);
    const times = moved.keys.map(([t]) => t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(moved.keys).toHaveLength(3);
  });

  it('clamps a dragged key into the box and its range', () => {
    const moved = moveKey(curve, 1, 5, 999, range);
    const key = moved.keys.find(([, value]) => value === 10);
    expect(key?.[0]).toBe(1);
    for (const [t, value] of moved.keys) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(range.max);
    }
  });

  it('ignores a move on an index that does not exist', () => {
    expect(moveKey(curve, 9, 0.5, 1)).toBe(curve);
    expect(moveKey(curve, -1, 0.5, 1)).toBe(curve);
  });

  it('adds a key in the right place and says where it landed', () => {
    const { curve: next, index } = addKey(curve, 0.25, 7);
    expect(next.keys).toHaveLength(4);
    expect(next.keys[index]).toEqual([0.25, 7]);
    const times = next.keys.map(([t]) => t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('removes a key but never the last one', () => {
    // An empty curve is not representable -- `compileCurve` substitutes a
    // fallback -- so deleting the last key would silently reset the field.
    expect(removeKey(curve, 1).keys).toHaveLength(2);
    const single: Curve = { keys: [[0, 1]] };
    expect(removeKey(single, 0)).toBe(single);
  });

  it('picks a range that contains the curve', () => {
    const auto = autoRange({ keys: [[0, 2], [1, 8]] });
    expect(auto.min).toBeLessThanOrEqual(0);
    expect(auto.max).toBeGreaterThan(8);
  });

  it('gives a flat curve a range with height', () => {
    const auto = autoRange({ keys: [[0, 3], [1, 3]] });
    expect(auto.max).toBeGreaterThan(auto.min);
  });
});

// --- gradient editing --------------------------------------------------------

describe('gradient editing', () => {
  const gradient: Gradient = { stops: [[0, 'sparkHot'], [1, 'sparkEmber']] };

  it('round-trips a stop through pixels', () => {
    const points = gradientToPixels(gradient, BOX);
    points.forEach((point, index) => {
      expect(pickStop(gradient, BOX, point.x, 8)).toBe(index);
    });
  });

  it('keeps stops sorted when one is dragged past another', () => {
    const moved = moveStop(gradient, 0, 0.9);
    const times = moved.stops.map(([t]) => t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('recolours a stop without moving it', () => {
    const recoloured = setStopColor(gradient, 1, 'icePale');
    expect(recoloured.stops[1]).toEqual([1, 'icePale']);
    expect(recoloured.stops[0]).toEqual(gradient.stops[0]);
  });

  it('adds and removes, but never empties', () => {
    expect(addStop(gradient, 0.5, 'fireBody').stops).toHaveLength(3);
    expect(removeStop(gradient, 0).stops).toHaveLength(1);
    const single: Gradient = { stops: [[0, 'sparkHot']] };
    expect(removeStop(single, 0)).toBe(single);
  });
});

// --- the JSON round trip -----------------------------------------------------

describe('effectToJson and effectFromJson', () => {
  it('round-trips every effect in the shipped registry unchanged', () => {
    // The property that makes the export an authoring format rather than a dump:
    // what you tuned is what you get back.
    for (const effect of EFFECTS) {
      const parsed = effectFromJson(effectToJson(effect));
      if ('error' in parsed) throw new Error(`${effect.id}: ${parsed.error}`);
      expect(JSON.parse(JSON.stringify(parsed.effect)), effect.id).toEqual(JSON.parse(JSON.stringify(effect)));
    }
  });

  it('produces a registry that still compiles', () => {
    const rebuilt = EFFECTS.map((effect) => {
      const parsed = effectFromJson(effectToJson(effect));
      if ('error' in parsed) throw new Error(parsed.error);
      return parsed.effect;
    });
    const registry = compileRegistry(rebuilt);
    expect(registry.danglingSubEffects).toEqual([]);
    expect(registry.batches.length).toBe(compileRegistry(EFFECTS).batches.length);
  });

  it('refuses a document that is not JSON', () => {
    const result = effectFromJson('{nope');
    expect('error' in result && result.error).toContain('not valid JSON');
  });

  it('refuses an effect with no emitters rather than returning a partial one', () => {
    // A definition missing an emitter compiles fine and draws nothing, which is
    // the worst possible outcome: it looks like a tuning problem.
    const result = effectFromJson(JSON.stringify({ id: 'x', priority: 2, emitters: [] }));
    expect('error' in result).toBe(true);
  });

  it('names the palette colour it does not know', () => {
    const source = EFFECTS[1];
    if (!source) throw new Error('fixture missing');
    const broken = JSON.parse(effectToJson(source)) as Record<string, unknown>;
    const emitters = broken['emitters'] as Record<string, unknown>[];
    (emitters[0] as Record<string, unknown>)['color'] = { stops: [[0, 'notAColour']] };
    const result = effectFromJson(JSON.stringify(broken));
    expect('error' in result && result.error).toContain('notAColour');
  });

  it('refuses a bad priority', () => {
    const result = effectFromJson(JSON.stringify({ id: 'x', priority: 9, emitters: [{ id: 'e' }] }));
    expect('error' in result).toBe(true);
  });

  it('refuses an emitter missing a required curve', () => {
    const result = effectFromJson(
      JSON.stringify({
        id: 'x',
        priority: 2,
        emitters: [
          {
            id: 'e',
            shape: { kind: 'point' },
            emission: { kind: 'burst', count: 1 },
            lifetimeTicks: [1, 2],
            speed: [0, 0],
            alpha: { keys: [[0, 1]] },
            color: { stops: [[0, 'sparkHot']] },
            render: 'billboard',
            blend: 'additive',
          },
        ],
      }),
    );
    expect('error' in result && result.error).toContain('size');
  });

  it('keeps an absent optional field absent rather than writing undefined', () => {
    const source = EFFECTS[1];
    if (!source) throw new Error('fixture missing');
    const parsed = effectFromJson(effectToJson(source));
    if ('error' in parsed) throw new Error(parsed.error);
    const emitter = parsed.effect.emitters[0] as unknown as Record<string, unknown>;
    // `exactOptionalPropertyTypes` is on: writing `undefined` is not omitting.
    for (const key of Object.keys(emitter)) expect(emitter[key], key).not.toBeUndefined();
  });
});
