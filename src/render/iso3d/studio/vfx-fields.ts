/**
 * What an emitter *has*, as data (spec 122).
 *
 * Pure -- no three.js, no DOM.
 *
 * The parameter panel is generated from this table rather than hand-written.
 * Forty hand-written rows is forty places to forget one, and the failure is
 * invisible: a field that has no row is simply not tunable, and nobody notices
 * until they go looking for it. `vfx-fields.test.ts` asserts the table covers
 * `Emitter`'s own keys, so adding a field to the format fails a test instead.
 *
 * Paths are dotted because a few fields are nested one level (`turbulence.
 * amplitude`, `collision.restitution`). Deeper than that does not occur and is
 * deliberately not supported -- a format that needs arbitrary paths is a format
 * that has stopped being a table of numbers.
 */

import type { Emitter } from '../vfx/types.js';

export type FieldKind = 'number' | 'range' | 'enum' | 'boolean' | 'curve' | 'gradient' | 'vec3';

export interface FieldSpec {
  readonly path: string;
  readonly label: string;
  readonly kind: FieldKind;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly string[];
  /** One line, shown as the row's tooltip. */
  readonly tip?: string;
}

export const RENDER_MODES = ['billboard', 'stretched', 'axis-billboard', 'ground-quad', 'ribbon', 'mesh'] as const;
export const BLEND_MODES = ['alpha', 'additive', 'dither-cutout'] as const;
/** How a brush mark ends (spec 161). Ignored by every shape that is not one. */
export const STROKE_DECAYS = ['retract', 'fizzle'] as const;
export const SHAPE_KINDS = ['point', 'sphere', 'hemisphere', 'cone', 'box', 'circle', 'mesh', 'arc', 'fan'] as const;
export const EMISSION_KINDS = ['burst', 'rate', 'ramp'] as const;
/** The solids a `mesh` particle can be (spec 123). */
export const MESH_SHAPES = [
  'blob',
  'tongue',
  'rune-ring',
  'rune-ring-thin',
  'diamond',
  'shaft',
  'shard',
  'starburst',
  'chunk',
  'ring',
  // The brush marks (spec 158). Listed here as well as in `meshes.ts` because
  // this is the panel's dropdown and that is the cache's key; a shape missing
  // from one of the two is a shape that either cannot be authored or cannot be
  // drawn, and neither failure says so.
  'brush-slash',
  'brush-flick',
  'brush-dab',
  'brush-blot',
] as const;

/**
 * Every tunable field on an emitter, in the order the panel shows them.
 *
 * Grouped by what a person is thinking about rather than by the type's field
 * order: where it comes from, how it moves, what it looks like, what it does
 * when it lands.
 */
export const EMITTER_FIELDS: readonly FieldSpec[] = [
  // --- emission ---
  { path: 'shape.kind', label: 'Shape', kind: 'enum', options: SHAPE_KINDS, tip: 'The volume particles are born in.' },
  // The shape's own numbers, which the table has never carried -- so the one
  // thing a painted spatter is tuned by, how wide it throws, could be edited in
  // the JSON and nowhere else. Inert for a kind that has no such field, which is
  // this table's standing convention (see the note below).
  { path: 'shape.radius', label: 'Radius', kind: 'number', min: 0, max: 400, step: 0.5, tip: 'How wide the birth volume is.' },
  { path: 'shape.angle', label: 'Angle', kind: 'number', min: 0, max: 3.15, step: 0.01, tip: 'Half-angle, for cone and fan.' },
  { path: 'shape.rise', label: 'Rise', kind: 'number', min: -1.6, max: 1.6, step: 0.01, tip: 'Radians a fan is lifted out of the ground plane.' },
  { path: 'shape.sweep', label: 'Sweep', kind: 'number', min: 0, max: 6.3, step: 0.01, tip: 'Total angle an arc covers.' },
  // How many, which is the number a person reaches for first while tuning and
  // was the one field the panel would not move (spec 126). A row that does not
  // apply to the current kind is inert rather than hidden: the panel is
  // generated from a flat table, and a conditional row is a second mechanism
  // bought for one saved click.
  { path: 'emission.kind', label: 'Emit as', kind: 'enum', options: EMISSION_KINDS, tip: 'Burst fires once; rate runs forever; ramp runs a curve.' },
  { path: 'emission.count', label: 'Count', kind: 'number', min: 1, max: 200, step: 1, tip: 'Particles in a burst. The intensity knob.' },
  { path: 'emission.perSecond', label: 'Per second', kind: 'number', min: 0, max: 300, step: 0.5, tip: 'Particles a second, for rate.' },
  { path: 'emission.delayTicks', label: 'Delay', kind: 'number', min: 0, max: 240, step: 1, tip: 'Ticks before a burst fires.' },
  { path: 'emission.overTicks', label: 'Ramp over', kind: 'number', min: 1, max: 600, step: 1, tip: 'Ticks a ramp spends walking its curve.' },
  { path: 'lifetimeTicks', label: 'Lifetime', kind: 'range', min: 1, max: 400, step: 1, tip: 'Ticks. Each particle draws its own.' },
  { path: 'speed', label: 'Speed', kind: 'range', min: 0, max: 800, step: 1, tip: 'World units per second along the shape direction.' },
  { path: 'spreadRadians', label: 'Spread', kind: 'number', min: 0, max: 3.15, step: 0.01, tip: 'Cone half-angle on top of the shape.' },

  // --- motion ---
  { path: 'gravity', label: 'Gravity', kind: 'number', min: -2000, max: 2000, step: 10 },
  { path: 'drag', label: 'Drag', kind: 'number', min: 0, max: 8, step: 0.05, tip: 'Fraction of velocity shed per second.' },
  { path: 'acceleration.x', label: 'Accel X', kind: 'number', min: -800, max: 800, step: 5 },
  { path: 'acceleration.y', label: 'Accel Y', kind: 'number', min: -800, max: 800, step: 5 },
  { path: 'acceleration.z', label: 'Accel Z', kind: 'number', min: -800, max: 800, step: 5 },
  { path: 'turbulence.amplitude', label: 'Turbulence', kind: 'number', min: 0, max: 800, step: 5, tip: 'The most expensive field here -- roughly doubles a particle cost.' },
  { path: 'turbulence.frequency', label: 'Turb. scale', kind: 'number', min: 0.001, max: 0.3, step: 0.001 },
  { path: 'angularVelocity', label: 'Spin', kind: 'range', min: -12, max: 12, step: 0.1, tip: 'Radians per second.' },

  // --- look ---
  { path: 'size', label: 'Size', kind: 'curve', min: 0, max: 120 },
  { path: 'alpha', label: 'Alpha', kind: 'curve', min: 0, max: 1 },
  { path: 'color', label: 'Colour', kind: 'gradient' },
  { path: 'rotation', label: 'Rotation', kind: 'curve', min: -8, max: 8 },
  { path: 'velocityScale', label: 'Velocity scale', kind: 'curve', min: 0, max: 2 },
  { path: 'render', label: 'Render as', kind: 'enum', options: RENDER_MODES },
  { path: 'blend', label: 'Blend', kind: 'enum', options: BLEND_MODES },
  { path: 'mesh.shape', label: 'Solid', kind: 'enum', options: MESH_SHAPES, tip: 'Which solid, when rendering as a mesh. Ignored otherwise.' },
  { path: 'strokeDecay', label: 'Ends by', kind: 'enum', options: STROKE_DECAYS, tip: 'Retract pulls a brush mark back to its root; fizzle breaks it up where it lies.' },
  { path: 'stretch', label: 'Stretch', kind: 'number', min: 0, max: 0.4, step: 0.005, tip: 'Length per unit of screen speed, for stretched billboards.' },
  { path: 'ribbonSpacing', label: 'Ribbon spacing', kind: 'number', min: 0.5, max: 60, step: 0.5, tip: 'World units between trail samples. Distance, never time.' },
  { path: 'ribbonTaper', label: 'Ribbon taper', kind: 'number', min: 0, max: 1, step: 0.01, tip: "The tail's width as a fraction of the head's." },

  // --- placement ---
  { path: 'offset.x', label: 'Offset X', kind: 'number', min: -200, max: 200, step: 1 },
  { path: 'offset.y', label: 'Offset Y', kind: 'number', min: -200, max: 200, step: 1 },
  { path: 'offset.z', label: 'Offset Z', kind: 'number', min: -200, max: 200, step: 1 },
  { path: 'worldSpace', label: 'World space', kind: 'boolean', tip: 'Off follows the body it is attached to.' },

  // --- landing ---
  { path: 'collision.restitution', label: 'Bounce', kind: 'number', min: 0, max: 1, step: 0.01 },
  { path: 'collision.friction', label: 'Friction', kind: 'number', min: 0, max: 1, step: 0.01 },
  { path: 'collision.maxBounces', label: 'Max bounces', kind: 'number', min: 0, max: 8, step: 1 },
  { path: 'collision.dieOnCollide', label: 'Die on impact', kind: 'boolean' },
];

/**
 * Emitter keys the panel deliberately does not edit, and why.
 *
 * Named rather than merely absent, so the coverage test can tell "handled" from
 * "forgotten" -- which is the whole point of having a coverage test.
 */
export const UNEDITED_KEYS: readonly (keyof Emitter)[] = [
  // Identity, not a parameter.
  'id',
  // Sprite sheets are generated, so choosing one is picking from a fixed list
  // that lives with the textures rather than with the emitter fields.
  'sprite',
  // Sub-effects and the light are references to other things in the registry,
  // and picking one is a browser rather than a slider.
  'subEmitters',
  'light',
  'sound',
];

type Mutable = Record<string, unknown>;

/** Read a dotted path. Returns undefined for a missing branch rather than throwing. */
export function readField(emitter: Emitter, path: string): unknown {
  const parts = path.split('.');
  let node: unknown = emitter;
  for (const part of parts) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    node = (node as Mutable)[part];
  }
  return node;
}

/**
 * Write a dotted path, returning a new emitter.
 *
 * Never mutates. The panel edits a definition that the registry compiled from,
 * and an in-place write would change what a *running* effect is doing halfway
 * through -- particles already in the air read their emitter every tick.
 */
export function writeField(emitter: Emitter, path: string, value: unknown): Emitter {
  const parts = path.split('.');
  const clone = (node: unknown): Mutable => (node && typeof node === 'object' ? { ...(node as Mutable) } : {});

  const root = clone(emitter);
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    const next = clone(node[part]);
    node[part] = next;
    node = next;
  }
  const last = parts[parts.length - 1] as string;
  if (value === undefined) {
    // Rebuilt without the key rather than `delete`d. Same result, and it keeps
    // the object's shape stable for V8 -- and `exactOptionalPropertyTypes` means
    // "absent" and "present but undefined" are genuinely different here, so the
    // key really does have to go rather than be set to undefined.
    const kept: Mutable = {};
    for (const key of Object.keys(node)) if (key !== last) kept[key] = node[key];
    if (parts.length === 1) return kept as unknown as Emitter;
    // Re-attach the pruned leaf to its parent.
    let parent = root;
    for (let i = 0; i < parts.length - 2; i++) parent = parent[parts[i] as string] as Mutable;
    parent[parts[parts.length - 2] as string] = kept;
    return root as unknown as Emitter;
  }
  node[last] = value;
  return root as unknown as Emitter;
}

/** Clamp a numeric field to its spec's range. */
export function clampToSpec(spec: FieldSpec, value: number): number {
  const min = spec.min ?? Number.NEGATIVE_INFINITY;
  const max = spec.max ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value)) return min === Number.NEGATIVE_INFINITY ? 0 : min;
  return Math.min(max, Math.max(min, value));
}

/**
 * The specs, grouped for the panel, in table order.
 *
 * Split at the field each section *starts* with rather than at a row number.
 * The numbers were literals and had drifted -- the table has grown by rows since
 * they were written, so "Motion" began at `emission.delayTicks` and ended in the
 * middle of the accelerations. Nothing could see it: the coverage test asserts
 * that the groups partition the table, which four wrong-but-contiguous cuts do
 * perfectly. A name cannot drift when a row is inserted above it, and a name
 * that is renamed away fails that same partition test.
 */
export function fieldGroups(): readonly { readonly title: string; readonly fields: readonly FieldSpec[] }[] {
  const startOf = (path: string): number => EMITTER_FIELDS.findIndex((field) => field.path === path);
  const at = (from: number, to: number): readonly FieldSpec[] => EMITTER_FIELDS.slice(from, to);
  const motion = startOf('gravity');
  const look = startOf('size');
  const placement = startOf('offset.x');
  const landing = startOf('collision.restitution');
  return [
    { title: 'Emission', fields: at(0, motion) },
    { title: 'Motion', fields: at(motion, look) },
    { title: 'Look', fields: at(look, placement) },
    { title: 'Placement', fields: at(placement, landing) },
    { title: 'Landing', fields: at(landing, EMITTER_FIELDS.length) },
  ];
}
