# 107 — A unit is three files

## Problem

An authored unit is a mesh, a rig, a set of clips and a state machine, and only
the first three have a standard. glTF 2.0 covers the mesh, the skeleton and the
animation curves; nothing covers "idle crossfades to run over 120ms, the swing
locks you until recovery ends, and the hit lands 40% of the way in". Every
engine has invented that layer -- Unity Mecanim, Godot's AnimationTree, Unreal's
animation blueprints -- and they agree on the concepts: states, transitions,
blend trees, parameters, events. So we define ours, engine-neutrally, before
anything generates or consumes one.

The second problem is whose clock wins. A generated clip is however long the
generator felt like making it, and a wind-up is however long the fight needs it
to be. If the clip's length is allowed to decide, then re-generating an
animation silently re-tunes combat. **Gameplay timing is authoritative and the
clip is time-scaled to fit it** -- and because a clip dragged far enough stops
reading as the motion it was, that scaling is bounded and the bound is checked.

## Shape

Three JSON documents, each with an integer `formatVersion` and a JSON Schema in
`schemas/` that CI validates against. Assets themselves are `.glb`; no asset
format is invented here.

### `skeleton.json` — one per rig family

```ts
{
  formatVersion: 1,
  id: 'biped',
  naming: 'mixamo',          // the bone naming spec; not assumed to be the only one
  upAxis: '+Y', forwardAxis: '+X',
  canonicalHeight: 55.65,    // world units, floor to crown, for scale normalization
  boneBudget: { min: 15, max: 30 },
  bones: [{ name, parent: string | null }],   // array order IS the canonical order
  sockets: [{ id, bone, offset?: [x,y,z] }],
  bindPose: null | { source: string, bones: [{ name, translation, rotation, scale }] },
}
```

Parent-before-child, exactly one root, names unique. `bindPose: null` marks the
skeleton **provisional** -- the bone contract is written down but no rig has been
measured against it yet. Provisional is a warning on its own and an *error* for
any unitdef that references it, so the contract can be committed before the
first generation without a unit ever shipping against an unverified rig.

`canonicalHeight` is in world units, not metres. This project's world is not
metric: a player body is ~56 units tall and a terrain chunk is 616 across.

### `cliplib.json` — the clips available for a skeleton

```ts
{
  formatVersion: 1,
  id: 'biped.core',
  skeletonRef: string,
  clips: [{
    id, source: string /* .glb */, durationMs: number, loop: boolean,
    events: [{ name, normalizedTime /* 0..1 */ }],
  }],
}
```

Events are **normalized, never absolute**, so time-scaling a clip preserves its
markers -- which is the whole reason gameplay timing is allowed to rescale it.
Durations are milliseconds like every other time in this format, rather than
glTF's seconds, so nothing has to remember which unit a field is in.

### `<unit>.unitdef.json` — one per unit type

```ts
{
  formatVersion: 1,
  id: 'grunt',
  meshRef, skeletonRef, clipLibRef: string,
  provenance: {
    tripoTaskIds: { imageToModel, rigCheck, rig, retarget: string[] },
    modelVersion, faceLimit, referenceImageSha256, creditsSpent, generatedAt,
  },
  import: { normals: 'flat'|'smooth'|'asAuthored', targetTris, scale, upAxis },
  maxTimeScale: 2.0,       // configurable per unit; the default lives in code
  stateMachine: {
    parameters:  [{ name, type: 'float'|'bool'|'trigger'|'int' }],
    states:      [{ id, clipRef, loop, timeScale, blendInMs,
                    category: 'loop'|'oneshot'|'locking'|'terminal' }],
    blendTrees:  [{ id, parameter, thresholds: [{ value, clipRef }] }],
    transitions: [{ from, to, condition, durationMs, interruptible }],
    actionTimings: [{ actionId, windupMs, activeMs, recoveryMs, clipRef, eventMap }],
  },
}
```

`from: '*'` on a transition means any state. A state's `clipRef` may name a
blend tree, which is how a locomotion state gets a speed-driven blend.

### The validator — `src/units/`

Pure, no three.js, no DOM, no Node built-ins, so the same module validates in
CI, on the server and in the Studio tab. Two layers:

```ts
validateSkeleton(doc: unknown): Result<Skeleton>
validateClipLib(doc: unknown): Result<ClipLib>
validateUnitDef(doc: unknown): Result<UnitDef>
validateUnitBundle({ unit, skeleton, clipLib }): Issue[]   // cross-file
```

Structure comes from ajv against the committed schemas; everything a JSON Schema
cannot say -- reference resolution, ordering, the time-scale bound -- is hand
written beside it. A `Result` carries `errors` and `warnings` separately, each an
`Issue { path /* JSON pointer */, code, message }`, because "this rig has finger
joints" and "this state names a clip that does not exist" must not be the same
severity.

Time-scale maths lives in `src/units/timing.ts`:

```ts
actionTotalMs(t)  = windupMs + activeMs + recoveryMs
timeScaleFor(t, clipDurationMs) = clipDurationMs / actionTotalMs(t)  // playback rate
stretchRatio(a, b) = max(a/b, b/a)                                   // >= 1, both directions
```

The bound is two-sided on purpose. A clip crammed into a quarter of its length
reads as badly as one dragged out to four times it, and only bounding the drag
would let "make the wind-up snappier" quietly become a flicker.

## Invariants tested

Schema layer, per document type:
- A document missing `formatVersion`, or carrying an unknown one, is rejected.
- Every committed schema compiles, and every example document in the repo
  validates against its schema.
- Additional properties are rejected, so a typo'd key is an error and not a
  silently ignored field.

Skeleton:
- Exactly one root; every non-root parent names a bone that appears **earlier**
  in the list; no duplicate names; no cycles.
- Bone count outside `boneBudget` is an error; a bone whose name matches a
  finger joint is a warning, named as wasteful.
- Every `Left*` bone has a `Right*` counterpart and vice versa.
- Every socket names a bone that exists.
- `bindPose: null` warns; a unitdef referencing such a skeleton errors.
- `canonicalHeight` matches the height the renderer actually draws a player at
  -- asserted against `(cow.metrics.headY + headRadius) * PLAYER_FIGURE.bodyScale`
  so the two cannot drift apart silently.

Clip library:
- Clip ids unique; `durationMs > 0`.
- Every event `normalizedTime` is within 0..1 **inclusive** and events are in
  strictly ascending order.
- `skeletonRef` resolves.

Unit definition:
- Every `clipRef` in a state, a blend tree threshold or an action timing
  resolves to a clip in the referenced library.
- Every `transition.from`/`to` names a state or a blend tree, or is `'*'` for
  `from`; no transition leaves a `terminal` state; a transition leaving a
  `locking` state is not `interruptible`.
- Every parameter named by a blend tree or a transition condition is declared;
  blend tree thresholds are strictly ascending and there are at least two.
- Ids are unique across states and blend trees together, since transitions
  address both in one namespace.
- `stretchRatio` for every action timing against its clip, and for every
  explicit state `timeScale`, is within `maxTimeScale`; past it is an error that
  names the clip, the ratio and the limit.
- `windupMs + activeMs <= total`, all three non-negative, total > 0.
- An action timing's `eventMap` may only map to events the clip actually has,
  and an event mapped to the active window lands inside
  `[windup/total, (windup+active)/total]`.
- Provenance is present and complete: a unitdef with no reference image hash or
  no task ids is rejected, so an asset can never lose the record of what it cost.

Runner:
- `npm run validate:units` exits non-zero on any error, prints warnings without
  failing, and reports per-file rather than dying on the first problem.

## Out of scope

- Anything that reads a `.glb`. Every check here is on JSON; the rig-integrity,
  geometry and deformation checks in the validation checklist need a loaded mesh
  and land with the bake step.
- The Tripo service, the Studio tab, the runtime state machine. This spec's
  files exist before any of them and none of them are consumed here.
- Non-biped rig families. The format is deliberately not written around one
  skeleton -- `skeleton.json` is per rig family and `naming` is a field rather
  than an assumption -- but only one family is authored.
- Blend tree types beyond 1D. `parameter` + ascending `thresholds` is a 1D blend;
  2D directional blending would add a field and is not needed for a roster of
  units that walk and swing.
