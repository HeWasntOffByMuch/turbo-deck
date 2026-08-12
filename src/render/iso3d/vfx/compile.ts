/**
 * Freezing a definition into something the update loop can read (spec 118).
 *
 * The authored format (`types.ts`) is shaped for a person: nested objects,
 * optional fields, keyframes in whatever order they were typed. The update loop
 * wants flat numbers and no branches on `undefined`. This is the one place the
 * two meet, and it runs **once**, at module load, so nothing downstream ever
 * pays for the convenience of the authoring format.
 *
 * It also resolves the two things that cannot be resolved inside a single
 * definition: sub-effect ids (which name *other* effects, so it takes two
 * passes) and batch keys (which are a property of the whole registry, since the
 * point of them is that effects share draw calls).
 */

import { compileCurve, compileGradient, constant, type Curve } from './curve.js';
import { SHAPE, type CompiledShape, type ShapeKind } from './shapes.js';
import { VFX_PALETTE } from './palette.js';
import type { Blend, EffectDefinition, Emitter, EmitterShape, RenderMode } from './types.js';
import type { FluidKind } from './splat.js';
import type { MeshShape } from './meshes.js';

export const EMISSION = { burst: 0, rate: 1, ramp: 2 } as const;
export const RENDER = {
  billboard: 0,
  stretched: 1,
  'axis-billboard': 2,
  'ground-quad': 3,
  ribbon: 4,
  mesh: 5,
} as const;
export const BLEND = { alpha: 0, additive: 1, 'dither-cutout': 2 } as const;

/** Which family of draw call a render mode belongs to. */
export const FAMILY = { quad: 0, ribbon: 1, mesh: 2 } as const;

export function familyOf(render: number): number {
  if (render === RENDER.ribbon) return FAMILY.ribbon;
  if (render === RENDER.mesh) return FAMILY.mesh;
  return FAMILY.quad;
}

export interface CompiledEmitter {
  readonly id: string;
  readonly shape: CompiledShape;

  readonly emissionKind: number;
  readonly burstCount: number;
  readonly delayTicks: number;
  readonly ratePerSecond: number;
  readonly rampCurve: Float32Array;
  readonly rampTicks: number;

  readonly lifeMin: number;
  readonly lifeMax: number;
  readonly speedMin: number;
  readonly speedMax: number;
  readonly spread: number;
  readonly gravity: number;
  readonly drag: number;
  readonly angMin: number;
  readonly angMax: number;
  readonly turbAmplitude: number;
  readonly turbFrequency: number;
  readonly accelX: number;
  readonly accelY: number;
  readonly accelZ: number;

  readonly sizeCurve: Float32Array;
  readonly alphaCurve: Float32Array;
  readonly colorGradient: Float32Array;
  readonly rotationCurve: Float32Array | null;
  readonly velocityScaleCurve: Float32Array | null;
  readonly stretch: number;
  readonly ribbonSpacing: number;
  readonly ribbonTaper: number;

  readonly render: number;
  readonly blend: number;
  readonly family: number;
  /** Index into the registry's batch table. One draw call per distinct value. */
  readonly batch: number;

  readonly sheet: string;
  /** The solid a mesh particle draws as, or '' for the quad families. */
  readonly meshShape: MeshShape | '';
  readonly frames: number;
  readonly spriteFps: number;
  readonly randomStartFrame: boolean;
  readonly spriteOnce: boolean;

  readonly hasCollision: boolean;
  readonly restitution: number;
  readonly friction: number;
  readonly maxBounces: number;
  readonly dieOnCollide: boolean;
  readonly decalFluid: FluidKind | null;
  readonly decalMin: number;
  readonly decalMax: number;
  readonly decalChance: number;
  /** Resolved in the second pass. -1 is "nothing". */
  onCollideEffect: number;
  onSpawnEffect: number;
  onDeathEffect: number;

  readonly hasLight: boolean;
  readonly lightR: number;
  readonly lightG: number;
  readonly lightB: number;
  readonly lightCurve: Float32Array;
  readonly lightRadius: number;
  readonly lightLeadOnly: boolean;

  readonly soundCue: string;
  /** 0 none, 1 start, 2 burst, 3 collide. */
  readonly soundOn: number;

  readonly offsetX: number;
  readonly offsetY: number;
  readonly offsetZ: number;
  readonly worldSpace: boolean;
}

export interface CompiledEffect {
  readonly id: string;
  readonly index: number;
  readonly priority: number;
  readonly cullDistance: number;
  readonly durationTicks: number;
  /** Stopping this effect kills its particles at once (spec 124). */
  readonly hardStop: boolean;
  readonly emitters: readonly CompiledEmitter[];
  /** True when any emitter emits forever -- what makes an effect need stopping. */
  readonly continuous: boolean;
}

export interface CompiledRegistry {
  readonly effects: readonly CompiledEffect[];
  readonly byId: ReadonlyMap<string, number>;
  /** One entry per distinct draw call: `family`, `blend`, `sheet`. */
  readonly batches: readonly {
    readonly family: number;
    readonly blend: number;
    readonly sheet: string;
    readonly meshShape: MeshShape | '';
  }[];
  /** Ids named as sub-effects that no definition provides. */
  readonly danglingSubEffects: readonly string[];
}

function compileShape(shape: EmitterShape): CompiledShape {
  switch (shape.kind) {
    case 'sphere':
      return { kind: SHAPE.sphere, a: shape.radius, b: shape.shell ? 1 : 0, c: 0 };
    case 'hemisphere':
      return { kind: SHAPE.hemisphere, a: shape.radius, b: shape.shell ? 1 : 0, c: 0 };
    case 'cone':
      return { kind: SHAPE.cone, a: shape.angle, b: shape.radius, c: 0 };
    case 'box':
      return { kind: SHAPE.box, a: shape.halfX, b: shape.halfY, c: shape.halfZ };
    case 'circle':
      return { kind: SHAPE.circle, a: shape.radius, b: shape.shell ? 1 : 0, c: 0 };
    case 'arc':
      return { kind: SHAPE.arc, a: shape.radius, b: shape.sweep, c: 0 };
    case 'mesh':
      return { kind: SHAPE.mesh, a: 0, b: 0, c: 0 };
    case 'point':
    default:
      return { kind: SHAPE.point as ShapeKind, a: 0, b: 0, c: 0 };
  }
}

function renderCode(render: RenderMode): number {
  return RENDER[render];
}

function blendCode(blend: Blend): number {
  return BLEND[blend];
}

function soundCode(on: 'start' | 'burst' | 'collide' | undefined): number {
  if (on === 'start') return 1;
  if (on === 'burst') return 2;
  if (on === 'collide') return 3;
  return 0;
}

const NO_RAMP: Curve = { keys: [[0, 0]] };

function compileEmitter(
  emitter: Emitter,
  batchOf: (family: number, blend: number, sheet: string, meshShape: MeshShape | '') => number,
): CompiledEmitter {
  const render = renderCode(emitter.render);
  const blend = blendCode(emitter.blend);
  const family = familyOf(render);
  const sheet = emitter.sprite?.sheet ?? '';
  const emission = emitter.emission;
  const light = emitter.light;

  const lightPacked = light ? VFX_PALETTE[light.color] : 0;

  return {
    id: emitter.id,
    shape: compileShape(emitter.shape),

    emissionKind: EMISSION[emission.kind],
    burstCount: emission.kind === 'burst' ? Math.max(0, Math.round(emission.count)) : 0,
    delayTicks: emission.kind === 'burst' ? Math.max(0, Math.round(emission.delayTicks ?? 0)) : 0,
    ratePerSecond: emission.kind === 'rate' ? Math.max(0, emission.perSecond) : 0,
    rampCurve: compileCurve(emission.kind === 'ramp' ? emission.perSecond : NO_RAMP),
    rampTicks: emission.kind === 'ramp' ? Math.max(1, Math.round(emission.overTicks)) : 0,

    lifeMin: Math.max(1, emitter.lifetimeTicks[0]),
    lifeMax: Math.max(1, emitter.lifetimeTicks[1]),
    speedMin: emitter.speed[0],
    speedMax: emitter.speed[1],
    spread: emitter.spreadRadians ?? 0,
    gravity: emitter.gravity ?? 0,
    drag: emitter.drag ?? 0,
    angMin: emitter.angularVelocity?.[0] ?? 0,
    angMax: emitter.angularVelocity?.[1] ?? 0,
    turbAmplitude: emitter.turbulence?.amplitude ?? 0,
    turbFrequency: emitter.turbulence?.frequency ?? 0.01,
    accelX: emitter.acceleration?.x ?? 0,
    accelY: emitter.acceleration?.y ?? 0,
    accelZ: emitter.acceleration?.z ?? 0,

    sizeCurve: compileCurve(emitter.size, 1),
    alphaCurve: compileCurve(emitter.alpha, 1),
    colorGradient: compileGradient(emitter.color),
    rotationCurve: emitter.rotation ? compileCurve(emitter.rotation) : null,
    velocityScaleCurve: emitter.velocityScale ? compileCurve(emitter.velocityScale, 1) : null,
    stretch: emitter.stretch ?? 0.02,
    ribbonSpacing: Math.max(0.5, emitter.ribbonSpacing ?? 6),
    ribbonTaper: Math.max(0, Math.min(1, emitter.ribbonTaper ?? 0.15)),

    render,
    blend,
    family,
    batch: batchOf(family, blend, sheet, emitter.mesh?.shape ?? ''),

    sheet,
    meshShape: emitter.mesh?.shape ?? '',
    frames: Math.max(1, emitter.sprite?.frames ?? 1),
    spriteFps: emitter.sprite?.fps ?? 0,
    randomStartFrame: emitter.sprite?.randomStart ?? false,
    spriteOnce: emitter.sprite?.once ?? false,

    hasCollision: emitter.collision !== undefined,
    restitution: emitter.collision?.restitution ?? 0,
    friction: emitter.collision?.friction ?? 0,
    maxBounces: emitter.collision?.maxBounces ?? 0,
    dieOnCollide: emitter.collision?.dieOnCollide ?? false,
    decalFluid: emitter.collision?.decal?.fluid ?? null,
    decalMin: emitter.collision?.decal?.size[0] ?? 0,
    decalMax: emitter.collision?.decal?.size[1] ?? 0,
    decalChance: emitter.collision?.decal?.chance ?? 0,
    onCollideEffect: -1,
    onSpawnEffect: -1,
    onDeathEffect: -1,

    hasLight: light !== undefined,
    lightR: ((lightPacked >> 16) & 0xff) / 255,
    lightG: ((lightPacked >> 8) & 0xff) / 255,
    lightB: (lightPacked & 0xff) / 255,
    lightCurve: compileCurve(light?.intensity ?? constant(0)),
    lightRadius: light?.radius ?? 0,
    lightLeadOnly: light?.leadOnly ?? true,

    soundCue: emitter.sound?.cue ?? '',
    soundOn: soundCode(emitter.sound?.on),

    offsetX: emitter.offset?.x ?? 0,
    offsetY: emitter.offset?.y ?? 0,
    offsetZ: emitter.offset?.z ?? 0,
    worldSpace: emitter.worldSpace ?? true,
  };
}

/**
 * Compile a whole registry.
 *
 * Two passes, because sub-effects name other effects: everything is compiled
 * first, then the ids are resolved to indices. An id that names nothing is
 * reported in `danglingSubEffects` rather than throwing -- a typo in one
 * definition should not take the whole table down, and a list a test can assert
 * is empty catches it earlier and more usefully than an exception at import time.
 */
export function compileRegistry(definitions: readonly EffectDefinition[]): CompiledRegistry {
  const batchKeys: string[] = [];
  const batches: { family: number; blend: number; sheet: string; meshShape: MeshShape | '' }[] = [];
  // The shape is part of the key: two solids cannot share a draw call, because a
  // draw call is one geometry.
  const batchOf = (family: number, blend: number, sheet: string, meshShape: MeshShape | ''): number => {
    const key = `${family}:${blend}:${sheet}:${meshShape}`;
    const existing = batchKeys.indexOf(key);
    if (existing >= 0) return existing;
    batchKeys.push(key);
    batches.push({ family, blend, sheet, meshShape });
    return batchKeys.length - 1;
  };

  const byId = new Map<string, number>();
  const effects: CompiledEffect[] = definitions.map((definition, index) => {
    const emitters = definition.emitters.map((emitter) => compileEmitter(emitter, batchOf));
    byId.set(definition.id, index);
    return {
      id: definition.id,
      index,
      priority: definition.priority,
      cullDistance: definition.cullDistance ?? Number.POSITIVE_INFINITY,
      durationTicks: definition.durationTicks ?? 0,
      hardStop: definition.hardStop ?? false,
      emitters,
      continuous: emitters.some((emitter) => emitter.emissionKind === EMISSION.rate),
    };
  });

  const dangling: string[] = [];
  const resolve = (id: string | undefined): number => {
    if (id === undefined) return -1;
    const found = byId.get(id);
    if (found === undefined) {
      if (!dangling.includes(id)) dangling.push(id);
      return -1;
    }
    return found;
  };

  definitions.forEach((definition, effectIndex) => {
    definition.emitters.forEach((authored, emitterIndex) => {
      const compiled = effects[effectIndex]?.emitters[emitterIndex];
      if (!compiled) return;
      compiled.onCollideEffect = resolve(authored.collision?.onCollide);
      compiled.onSpawnEffect = resolve(authored.subEmitters?.onSpawn);
      compiled.onDeathEffect = resolve(authored.subEmitters?.onDeath);
    });
  });

  return { effects, byId, batches, danglingSubEffects: dangling };
}
