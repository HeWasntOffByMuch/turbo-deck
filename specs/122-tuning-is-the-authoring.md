# 122 — Tuning is the authoring

## Problem

Forty effects exist and the only way to change one is to edit a TypeScript file
and reload. That is not a tuning loop: a spark's drag or a flame's turbulence is
a number nobody can pick correctly in the abstract, and the feedback delay is
what decides how many times you try.

The arc's acceptance criterion says adding an effect is editing config in one
place. This spec makes *editing* it a loop you can actually run — and makes the
tuning the authoring rather than a throwaway preview, by writing the edited
definition back out as JSON.

## Shape

A sixth tab, on the existing shell (`main.ts`), built the way the Studio tab is.

**Pure** (`src/render/iso3d/studio/`), tested in Node:

```ts
// vfx-fields.ts -- what an emitter *has*, as data.
type FieldKind = 'number' | 'range' | 'enum' | 'boolean' | 'curve' | 'gradient' | 'vec3';
interface FieldSpec {
  readonly path: string;          // 'speed', 'turbulence.amplitude'
  readonly label: string;
  readonly kind: FieldKind;
  readonly min?: number; readonly max?: number; readonly step?: number;
  readonly options?: readonly string[];
}
const EMITTER_FIELDS: readonly FieldSpec[];
function readField(emitter: Emitter, path: string): unknown;
function writeField(emitter: Emitter, path: string, value: unknown): Emitter;

// curve-edit.ts -- the arithmetic of dragging a keyframe.
function curveToPixels(curve, box, valueRange): readonly Point[];
function pickKey(curve, box, valueRange, px, py, radius): number;   // -1 for none
function moveKey(curve, index, t, value): Curve;                     // clamped, re-sorted
function addKey(curve, t, value): Curve;
function removeKey(curve, index): Curve;                             // never empties

// vfx-json.ts -- the export, and the round trip that makes it authoring.
function effectToJson(effect: EffectDefinition): string;
function effectFromJson(text: string): { effect: EffectDefinition } | { error: string };
```

**DOM/three** (`studio/vfx-view.ts`): the browser list, the preview viewport
(reusing the game's own `RetroPass` and `createViewControls`, like `preview.ts`
does), the generated parameter panel, the curve and gradient editors, and the
debug overlay.

**A stress harness** (`scripts/stress-vfx.ts`): 50 simultaneous combat effects
plus 200 ground decals, driven headlessly, reporting real numbers.

## Invariants tested

- **The field table covers the emitter.** Every optional and required field of
  `Emitter` that a person would tune appears in `EMITTER_FIELDS` exactly once,
  asserted against the type's own keys so a new field fails the test rather than
  being silently un-editable.
- **`readField`/`writeField` round-trip** every field kind, including nested
  paths, and `writeField` never mutates its input.
- **Curve editing keeps a curve valid**: keys stay sorted, `t` stays in [0, 1],
  removing never leaves an empty curve, and a moved key that crosses a neighbour
  re-sorts rather than corrupting the order.
- **Pixel mapping round-trips**: a key converted to pixels and picked at those
  pixels returns that key, at several box sizes.
- **JSON round-trips.** Every effect in the shipped registry survives
  `effectFromJson(effectToJson(e))` unchanged, so the export really is the
  authoring format and not a lossy dump.
- **A malformed document is refused with a message**, never a partial effect.
- **The exported JSON compiles**: the round-tripped registry produces the same
  batch count and no dangling sub-effects.
- **The debug readout reports what it claims**, including the culled and
  degraded counts, which are the two numbers nothing else surfaces.

## Out of scope

- Persisting edits back into `library.ts` source. Export writes JSON to the
  clipboard and to a download; turning that into a committed file is a person's
  decision and a git diff, which is the same rule the map editor follows.
- Editing the *effect-level* fields beyond priority and cull distance.
- Authoring new sprite sheets. They are generated, and a new one is code.
- Unit blood staining, still deferred (`docs/vfx-plan.md` §5d).
