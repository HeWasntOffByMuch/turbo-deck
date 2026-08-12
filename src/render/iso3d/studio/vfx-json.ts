/**
 * The export, and the round trip that makes tuning into authoring (spec 122).
 *
 * Pure -- no three.js, no DOM.
 *
 * The point of the round trip is stated as a test rather than as an intention:
 * every effect in the shipped registry survives `effectFromJson(effectToJson(e))`
 * unchanged. A preview that emits a lossy dump is a preview -- you tune in it,
 * paste the result, and discover the thing you tuned is not the thing you got.
 * A format that comes back identical is an authoring format.
 *
 * Validation is deliberately shallow-but-total: it checks that every field is
 * the *kind* it should be and refuses the whole document otherwise. It does not
 * try to be a schema language. What it must never do is return a partial effect,
 * because a definition missing an emitter compiles fine and draws nothing.
 */

import type { Curve, Gradient } from '../vfx/curve.js';
import { isPaletteKey, type PaletteKey } from '../vfx/palette.js';
import type { EffectDefinition, Emitter } from '../vfx/types.js';
import { BLEND_MODES, MESH_SHAPES, RENDER_MODES, SHAPE_KINDS } from './vfx-fields.js';

/**
 * Serialize an effect.
 *
 * `JSON.stringify` with a two-space indent and nothing clever: the format *is*
 * the definition, so a custom writer would be a second representation to keep in
 * step. Tuples come back as arrays and are read back as tuples.
 */
export function effectToJson(effect: EffectDefinition): string {
  return `${JSON.stringify(effect, null, 2)}\n`;
}

export type ParseResult = { readonly effect: EffectDefinition } | { readonly error: string };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown, where: string, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${where} must be a finite number`);
    return undefined;
  }
  return value;
}

function asPair(value: unknown, where: string, errors: string[]): readonly [number, number] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2 || value.some((entry) => typeof entry !== 'number')) {
    errors.push(`${where} must be a pair of numbers`);
    return undefined;
  }
  return [value[0] as number, value[1] as number];
}

function asCurve(value: unknown, where: string, errors: string[]): Curve | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || !Array.isArray(value['keys'])) {
    errors.push(`${where} must be a curve with a keys array`);
    return undefined;
  }
  const keys: (readonly [number, number])[] = [];
  for (const key of value['keys'] as unknown[]) {
    const pair = asPair(key, `${where} key`, errors);
    if (!pair) return undefined;
    keys.push(pair);
  }
  if (keys.length === 0) {
    errors.push(`${where} has no keys`);
    return undefined;
  }
  return { keys };
}

function asGradient(value: unknown, where: string, errors: string[]): Gradient | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || !Array.isArray(value['stops'])) {
    errors.push(`${where} must be a gradient with a stops array`);
    return undefined;
  }
  const stops: (readonly [number, PaletteKey])[] = [];
  for (const stop of value['stops'] as unknown[]) {
    if (!Array.isArray(stop) || stop.length !== 2 || typeof stop[0] !== 'number' || typeof stop[1] !== 'string') {
      errors.push(`${where} stop must be [time, paletteKey]`);
      return undefined;
    }
    if (!isPaletteKey(stop[1])) {
      // Named rather than silently defaulted: a typo'd colour is the failure
      // this whole "keys, never hex" arrangement exists to make impossible.
      errors.push(`${where} names no palette colour "${stop[1]}"`);
      return undefined;
    }
    stops.push([stop[0], stop[1]]);
  }
  if (stops.length === 0) {
    errors.push(`${where} has no stops`);
    return undefined;
  }
  return { stops };
}

function asEnum<T extends string>(value: unknown, options: readonly T[], where: string, errors: string[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !options.includes(value as T)) {
    errors.push(`${where} must be one of ${options.join(', ')}`);
    return undefined;
  }
  return value as T;
}

/**
 * Rebuild an emitter, field by field.
 *
 * Written out rather than cast, because a cast is exactly the bug this guards:
 * `JSON.parse(text) as Emitter` type-checks perfectly and hands the compiler a
 * document with a missing `size` curve, which then throws inside the tick loop
 * with a stack that points nowhere near the paste.
 */
function readEmitter(raw: unknown, index: number, errors: string[]): Emitter | undefined {
  if (!isObject(raw)) {
    errors.push(`emitter ${index} is not an object`);
    return undefined;
  }
  const where = `emitter ${index}`;
  const id = raw['id'];
  if (typeof id !== 'string' || id.length === 0) {
    errors.push(`${where} needs an id`);
    return undefined;
  }

  const shape = raw['shape'];
  if (!isObject(shape) || asEnum(shape['kind'], SHAPE_KINDS, `${where}.shape.kind`, errors) === undefined) {
    if (!isObject(shape)) errors.push(`${where}.shape is missing`);
    return undefined;
  }
  const emission = raw['emission'];
  if (!isObject(emission) || typeof emission['kind'] !== 'string') {
    errors.push(`${where}.emission is missing`);
    return undefined;
  }

  // Presence before shape. The helpers below treat "absent" as "optional and
  // absent" and stay quiet, which is right for `drag` and useless for `size`:
  // without this the whole emitter failed with "could not be read" and no clue
  // which field was missing, which is the least useful thing a paste can say.
  const required = ['lifetimeTicks', 'speed', 'size', 'alpha', 'color', 'render', 'blend'] as const;
  const absent = required.filter((key) => raw[key] === undefined);
  if (absent.length > 0) {
    errors.push(`${where} is missing ${absent.join(', ')}`);
    return undefined;
  }

  const lifetime = asPair(raw['lifetimeTicks'], `${where}.lifetimeTicks`, errors);
  const speed = asPair(raw['speed'], `${where}.speed`, errors);
  const size = asCurve(raw['size'], `${where}.size`, errors);
  const alpha = asCurve(raw['alpha'], `${where}.alpha`, errors);
  const color = asGradient(raw['color'], `${where}.color`, errors);
  const render = asEnum(raw['render'], RENDER_MODES, `${where}.render`, errors);
  const blend = asEnum(raw['blend'], BLEND_MODES, `${where}.blend`, errors);
  if (!lifetime || !speed || !size || !alpha || !color || !render || !blend) return undefined;

  // The optional half. Absent stays absent -- `exactOptionalPropertyTypes` is on,
  // and writing `undefined` into an optional field is not the same as omitting it.
  const out: Record<string, unknown> = {
    id,
    shape: { ...shape },
    emission: { ...emission },
    lifetimeTicks: lifetime,
    speed,
    size,
    alpha,
    color,
    render,
    blend,
  };
  const optionalNumbers = ['spreadRadians', 'gravity', 'drag', 'stretch', 'ribbonSpacing', 'ribbonTaper'] as const;
  for (const key of optionalNumbers) {
    const value = asNumber(raw[key], `${where}.${key}`, errors);
    if (value !== undefined) out[key] = value;
  }
  const optionalPairs = ['angularVelocity'] as const;
  for (const key of optionalPairs) {
    const value = asPair(raw[key], `${where}.${key}`, errors);
    if (value !== undefined) out[key] = value;
  }
  const optionalCurves = ['rotation', 'velocityScale'] as const;
  for (const key of optionalCurves) {
    const value = asCurve(raw[key], `${where}.${key}`, errors);
    if (value !== undefined) out[key] = value;
  }
  for (const key of ['turbulence', 'acceleration', 'offset', 'collision', 'subEmitters', 'light', 'sound', 'sprite'] as const) {
    const value = raw[key];
    if (value !== undefined) {
      if (!isObject(value)) {
        errors.push(`${where}.${key} must be an object`);
        return undefined;
      }
      out[key] = { ...value };
    }
  }
  // The mesh shape is checked rather than passed through, because an unknown
  // one is the spec-123 stub failure wearing a different hat: the batch is
  // built, nothing throws, and the effect comes out as flat quads.
  if (raw['mesh'] !== undefined) {
    const mesh = raw['mesh'];
    if (!isObject(mesh)) {
      errors.push(`${where}.mesh must be an object`);
      return undefined;
    }
    const shapeName = asEnum(mesh['shape'], MESH_SHAPES, `${where}.mesh.shape`, errors);
    if (!shapeName) return undefined;
    out['mesh'] = { shape: shapeName };
  }
  if (raw['worldSpace'] !== undefined) {
    if (typeof raw['worldSpace'] !== 'boolean') {
      errors.push(`${where}.worldSpace must be true or false`);
      return undefined;
    }
    out['worldSpace'] = raw['worldSpace'];
  }

  return out as unknown as Emitter;
}

/** Parse an effect. Either a whole effect or an error -- never a partial one. */
export function effectFromJson(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return { error: `not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (!isObject(raw)) return { error: 'the document is not an object' };

  const errors: string[] = [];
  const id = raw['id'];
  if (typeof id !== 'string' || id.length === 0) errors.push('the effect needs an id');

  const priority = raw['priority'];
  if (typeof priority !== 'number' || ![0, 1, 2, 3].includes(priority)) {
    errors.push('priority must be 0, 1, 2 or 3');
  }

  const rawEmitters = raw['emitters'];
  if (!Array.isArray(rawEmitters) || rawEmitters.length === 0) {
    errors.push('the effect needs at least one emitter');
    return { error: errors.join('; ') };
  }

  const emitters: Emitter[] = [];
  rawEmitters.forEach((entry, index) => {
    const emitter = readEmitter(entry, index, errors);
    if (emitter) emitters.push(emitter);
  });

  if (errors.length > 0) return { error: errors.join('; ') };
  if (emitters.length !== rawEmitters.length) return { error: 'one or more emitters could not be read' };

  const out: Record<string, unknown> = { id, priority, emitters };
  const cull = asNumber(raw['cullDistance'], 'cullDistance', errors);
  if (cull !== undefined) out['cullDistance'] = cull;
  const duration = asNumber(raw['durationTicks'], 'durationTicks', errors);
  if (duration !== undefined) out['durationTicks'] = duration;
  if (raw['hardStop'] !== undefined) {
    if (typeof raw['hardStop'] !== 'boolean') {
      errors.push('hardStop must be true or false');
    } else {
      out['hardStop'] = raw['hardStop'];
    }
  }
  if (errors.length > 0) return { error: errors.join('; ') };

  return { effect: out as unknown as EffectDefinition };
}
