# Authoring a brand-new rig family (not `biped`) — field-level map

Traced 2026-09-04 while spec 277 gave the radish raccoon a family of its own.
The three documents, the naming table, the bake, the state machine, the render
path and the clip-authoring call sequence, with the field names and the
validator rules that are *not* in the JSON schemas.

**What the state of the tree was when this was traced, and is no longer.** The
raccoon arrived with a `unitdef.json` naming a family nobody had written
(`biped_small`), so `validate-units.ts` failed on both refs, and `bake-units.ts`
failed the mesh itself on `mesh.bindpose.posed` -- elbows bent 69 degrees
against a straight 180, sides disagreeing by 58. Both were read as "regenerate
the model", and both were really the auto-rig: spec 277 replaced it with an
authored one, and the same gates pass on the same mesh. The measurements are
kept below where they are load-bearing for a rule, and the conclusion "the
staged mesh is a hard blocker" is not.

**`checkBindPose` is the gate that decides this** (`src/units/mesh-check.ts:356`): it raises `mesh.bindpose.posed` as an *error* rather than a warning, so a rest pose that is really somebody's idle fails the bake outright. A limb counts as extended past 150 degrees and the two sides may disagree by 4. An authored rig passes it by placing each middle joint exactly on the line between the chain's ends -- the raccoon's four limbs read 179.96 and 179.89 with 1.13 of asymmetry, against the auto-rig's 69 and 58.

Naming did detect cleanly though: `classifyBindPose` calls `detectNaming`
internally and got a confident answer (not `'unmeasured'`), so the raw rig's
bones already match the `tripo` vocabulary in `src/units/naming.ts` — no
third-vocabulary problem for this mesh.

## 1. The three documents

`src/units/types.ts` mirrors `schemas/*.schema.json` field-for-field;
`additionalProperties: false` everywhere.

**Skeleton** (`schemas/skeleton.schema.json`, `types.ts:65-92`) — required:
`formatVersion` (const 1), `id`, `naming` (`enum: ["mixamo","tripo"]` —
**no third value is legal in the document itself**), `upAxis`/`forwardAxis`
(`Axis = '+X'|'-X'|'+Y'|'-Y'|'+Z'|'-Z'`), `canonicalHeight` (world units,
>0), `boneBudget: {min,max}`, `bones: SkeletonBone[]` (`{name, parent:
string|null}`, array order = canonical order, parent must precede child),
`sockets: SkeletonSocket[]` (`{id, bone, offset?: Vec3, rotationDeg?: Vec3}`),
`bindPose: BindPose | null` (`{source, bones: BindBone[]}`,
`BindBone = {name, translation: Vec3, rotation: Quat(xyzw), scale: Vec3}`).
Optional: `$comment`.

**ClipLib** (`schemas/cliplib.schema.json`, `types.ts:96-125`) — required:
`formatVersion`, `id`, `skeletonRef`, `clips: Clip[]`
(`{id, source (must match /\.glb$/), durationMs (>0), loop, events:
ClipEvent[]}`, `ClipEvent = {name, normalizedTime: 0..1}`, events ascending).

**UnitDef** (`schemas/unitdef.schema.json`, `types.ts:215-233`) — required:
`formatVersion`, `id`, `meshRef` (`.glb`), `skeletonRef`, `clipLibRef`,
`provenance` (`Provenance`: `tripoTaskIds{imageToModel,rigCheck,rig:string|null,
retarget:string[]}`, `modelVersion`, `faceLimit`, `referenceImageSha256`
(`^[0-9a-f]{64}$`), `creditsSpent`, `generatedAt` ISO 8601), `import`
(`ImportOverrides`: `normals: 'flat'|'smooth'|'asAuthored'`, `targetTris`,
`scale` (>0, brings mesh to `canonicalHeight`), `upAxis`), `maxTimeScale`
(>1, default suggestion `DEFAULT_MAX_TIME_SCALE=2` in `timing.ts:32`),
`stateMachine` (see Q4).

### Beyond the JSON Schema — enforced by `src/units/validate.ts`, per document

- **Skeleton** (`validateSkeleton`, `validate.ts:63-234`): `boneBudget.min <=
  max`; **naming vs. bones**: `detectNaming(bones)` — error only on a
  *confident disagreement* (`detected !== 'unknown' && detected !==
  skeleton.naming`), code `skeleton.naming.mismatch` (line 90-101); bone
  count inside `boneBudget`; **parent-before-child** walked forward,
  catching forward refs + cycles + unknown parents in one pass; exactly one
  root (`parent: null`); no duplicate bone names; **finger-joint bones**
  (`/​(Thumb|Index|Middle|Ring|Pinky)\d/i`) → warning; **left/right symmetry
  by name** via `mirrorName` (`Left`/`Right` substring, or `^L_`/`^R_`
  prefix) — every sided bone needs its mirror or it's an error; every
  socket's `bone` must be a real bone name (not a role — literal string
  match); `bindPose === null` → warning `skeleton.provisional` ("no unit may
  ship against this skeleton until filled in"); if present, bind pose bones
  must cover every skeleton bone exactly (missing = error, extra = error).
- **ClipLib** (`validateClipLib`, line 259-299): no duplicate clip ids;
  per-clip events strictly ascending by `normalizedTime`, no duplicate event
  names.
- **UnitDef alone** (`validateUnitDef`, line 308-481, does NOT need the
  skeleton/cliplib): no duplicate parameter names; states+blendTrees share
  **one id namespace** (`unitdef.node.duplicate`); every blend tree's
  `parameter` must be a declared `float`/`int` param, thresholds strictly
  ascending; every transition's `from`/`to` must resolve to a state/tree id
  or `'*'`; **a transition out of a `terminal` state is an error**
  (`unitdef.transition.terminal`); **a `locking` state's outgoing transition
  may not be `interruptible: true`** (`unitdef.transition.locking`);
  condition parsed via `condition.ts`'s `parseCondition` and its parameter
  checked against the declared type (`compare` needs float/int, bare
  flag/`!flag` needs bool/trigger); no duplicate `actionId`s; an action
  timing with `windupMs+activeMs+recoveryMs === 0` is an error.
- **Bundle, needs all three docs** (`validateUnitBundle`, line 493-629):
  **skeleton must have a measured `bindPose`** or the whole bundle errors
  (`bundle.skeleton.provisional`) — this is where "provisional" stops being
  a mere warning; every `state.clipRef` / blend-tree threshold `clipRef` /
  action `clipRef` must resolve to a real clip **or** (for a state only) a
  blend-tree id; **the time-scale bound**: `stretchRatio(state.timeScale) >
  unit.maxTimeScale` is an error (`bundle.timeScale.exceeded`), same check
  for the *derived* rate `timeScaleFor(actionTiming, clip.durationMs)`; a
  blend-tree id colliding with a clip id is an error
  (`bundle.blendTree.shadowsClip` — resolution order is tree-first);
  `state.loop && !clip.loop` → warning; every `eventMap` value must be a
  real event on that clip, **and must fall inside the phase's normalized
  window** (`phaseWindows` in `timing.ts:84-96`, inclusive both ends) —
  `bundle.event.window`.
- **Not part of `validate.ts` at all** — a separate gate, `src/units/
  mesh-check.ts`, run only by `scripts/bake-units.ts` (never by
  `validate-units.ts`'s doc pass, though `validate-units.ts` does run
  `checkClipBinaries`/`checkTravel`/root-motion checks on the clip
  binaries): `classifyBindPose` + `checkBindPose` (T/A-pose shape, elbow/knee
  straightness, left-right asymmetry) and `checkDeformation` (volume ratio,
  pinched triangles at extreme poses) — **this is the bind-pose/deformation
  gate that actually failed on `radish_raccoon_2` above.**
- **Root motion / travel**, checked only by the *runner* (`scripts/
  validate-units.ts:99-191`) and the *loader* (`src/render/iso3d/unit-rig.ts`
  `stripRootMotion`/`correctTravel`), not by `src/units/validate.ts`: any
  translation channel on the root chain is an **error**
  (`runner.clip.rootMotion`); travel on ANY bone beyond
  `TRAVEL_FRACTION_OF_REACH (0.1) * rigReach` is a **warning**
  (`runner.clip.travel` — importer corrects it silently at load, so it's
  informational, not blocking).

## 2. Naming (`src/units/naming.ts`)

`NamingSpec = 'mixamo' | 'tripo'` (line 23) — closed union, matches the
schema enum exactly. `NAMING_SPECS = ['mixamo','tripo']` (detection order).

`BoneRole` (line 35-56) — 20 roles: `hips, spine, chest, neck, head,
left/rightUpLeg, left/rightLeg, left/rightFoot, left/rightToe,
left/rightShoulder, left/rightArm, left/rightForeArm, left/rightHand`.
Deliberately not exhaustive (no fingers, no pelvis-vs-hips distinction).

`VOCABULARY` (line 66-120) is a `Record<NamingSpec, Record<BoneRole,
string[]>>` — first-match-wins name lists per role, matched via
`boneKey(name)` (strips `mixamorig\d*[:_]?` / `tripo\d*::?` prefixes,
lowercases, strips non-alnum) then `===` or `.endsWith(want)`.
`SIGNATURE_ROLES` (line 130-138) = `[hips, spine, head, leftHand, rightHand,
leftFoot, rightFoot]` — **every one** must resolve (not a majority) before a
vocabulary is "claimed" by `detectNaming` (line 213-224); ties broken by
which resolves more of the *full* role table.

**Third vocabulary / unknown naming**: `detectNaming` returns `NamingSpec |
'unknown'` — `'unknown'` is a real return value but is **not a legal value
of the `naming` field in a document** (schema enum forbids it). The
validator's rule (`validate.ts:90-101`) only raises an error on a *confident
disagreement*; if detection is `'unknown'`, whatever the document declares
(`'mixamo'` or `'tripo'`) is accepted without complaint — so a genuinely
novel rig can validate cleanly by declaring itself as one of the two even
though none of its bones match. Adding a real third vocabulary is contained
to this one file (`NamingSpec` union, `NAMING_SPECS`, `VOCABULARY` table) —
but also needs the schema enum in `schemas/skeleton.schema.json:34`
(`"enum": ["mixamo","tripo"]`) widened, since that's a second, independent
gate on the same field.

**What breaks when a rig's bones don't actually match the declared
vocabulary** (verified in `facing.ts`, `skeleton-from-rig.ts`, `pose.ts`,
`mesh-check.ts` — all of which call `findRole`/`detectNaming` themselves,
independent of what the skeleton.json declares):
- **Weapon sockets**: `skeleton-from-rig.ts`'s `STANDARD_SOCKETS` (line
  46-56: `weapon.main`->rightHand, `weapon.off`->leftHand,
  `weapon.stow`->chest, `fx.cast`->rightHand, `fx.body`->chest,
  `anchor.head`->head) derives sockets via `findRole(boneNames, naming,
  role)` — a role that can't be found is **silently omitted** (no socket at
  all, not an error) — this is verbatim how the pig originally shipped with
  no weapon socket. Once sockets exist as literal `{id, bone}` pairs in the
  doc, the *validator* only checks `socket.bone` is a real bone name; it
  never re-derives from the role, so a hand-fixed socket always works
  regardless of naming.
- **Facing measurement** (`facing.ts` `rigFacing`, line 386-460): if its own
  `detectNaming(names)` is `'unknown'`, every name-based lookup short-
  circuits to null and it falls back to **structural** detection
  (`structuralBones` — two lowest leaf-chain tips = legs, by bind-pose
  height, no names needed) — degrades to a warning
  (`rig naming`/`rig forward`) rather than failing outright, as long as the
  structural search finds two leg chains that actually end in a foot-shaped
  segment (`FOOT_HORIZONTAL_FLOOR`).
- **Bind-pose measurement** (`mesh-check.ts` `classifyBindPose`, line
  282-288): returns `shape: 'unmeasured'` if its own `detectNaming` is
  `'unknown'` — a warning (`mesh.bindpose.unmeasured`), not an error; no
  structural fallback here.
- **Extreme-pose deformation checks** (`mesh-check.ts` `extremePoses`, line
  464-469): returns `[]` outright if naming is unknown — no deformation
  checking happens at all, silently (an empty `poses` array, not a failure).
- **Clip authoring** (`pose.ts` `bodyFrame`, `clip-author.ts` `keyRotations`):
  `bodyFrame` needs `leftUpLeg`/`rightUpLeg` (or falls back to
  `leftArm`/`rightArm`) resolvable via `findRole`; if neither pair resolves,
  `bodyFrame` returns `null` and **no pose can be authored on this rig at
  all** via `PoseTable`/`AuthoredClip` (used by `pig-strike.ts`-style hand
  authoring, not needed for a walk/idle-only unit built from retargeted
  mixamo-preset clips).

Net effect for a genuinely novel rig on neither vocabulary: locomotion (walk/
run retargeted the normal Tripo way) still works because `unit-rig.ts`'s
root-motion strip and `UnitMachine`/`unit-driver.ts` never touch bone names
at all — sockets, hand-authored combat clips (`pig-strike.ts` style), and
deformation warnings are what silently go missing.

## 3. Manifest / bake

`src/units/manifest.ts` is pure — `UnitManifest = {formatVersion:1, hash,
builtStages: string[], units: UnitManifestUnit[]}`,
`UnitManifestUnit = {id, family, entries: UnitAssetEntry[]}`,
`UnitAssetEntry = {path (relative to assets/units/, forward slashes), sha256,
bytes}`. `manifestHash`/`manifestBody` sort entries and JSON-quote paths
before hashing (`node:crypto` sha256 injected as `HashText`, so this stays
importable in a browser). `compareManifest`/`refusesConnection` — an *absent*
client hash is allowed (in-tab server, bots); a present-and-different one is
refused.

`scripts/bake-units.ts` (`npm run bake:units`): walks `assets/units/`
recursively for `*.unitdef.json` (`findUnitDefs`, line 64-72, sorted
`readdirSync`), for each one: validates via `validateUnitDef`; adds the
unitdef file itself, the mesh (`join(unitDir, unit.meshRef)`), the clip lib
(`resolve(unitDir, unit.clipLibRef)`), and every clip's `.glb`
(`resolve(dirname(clipLibPath), clip.source)`) to the hash-entry list — a
missing file at any of those is a `problems.push` (build fails, no manifest
written); runs `inspectMesh` (skinning + bind-pose + deformation checks —
errors fail, warnings print); **tri-count gate**: `triangleCount` reads
indices straight off the glTF JSON accessors (no full mesh decode) and
requires `abs(actual - import.targetTris) <= targetTris * TRI_TOLERANCE
(0.1)` — outside ±10% is a hard failure (this is a *gate*, not decimation —
`builtStages` is honestly `[]`, nothing shrinks the mesh). `family` in the
manifest row = `basename(unit.skeletonRef).replace(/\.skeleton\.json$/,'')`
(line 245) — i.e. derived from the **skeleton filename**, not from the
cliplib id. Writes `assets/units/manifest.json` only if zero problems.

`scripts/validate-units.ts` (`npm run validate:units`, the CI gate): walks
ALL `.json` under `assets/units/` (skips `manifest.json` explicitly, `NOT_A_
DOCUMENT`), dispatches by filename suffix (`.skeleton.json`/`.cliplib.json`/
`.unitdef.json`), runs the matching `validate*` function per file, then a
second cross-document pass resolving `skeletonRef`/`clipLibRef` and calling
`validateUnitBundle` + `checkClipBinaries` (root motion + travel on the
actual clip binaries) + a check that `clipLib.skeletonRef` (inside the
cliplib doc) resolves to the *same* skeleton file the unitdef points at
(`runner.skeleton.mismatch`). Warnings print, don't fail; only errors set
`process.exitCode = 1`.

**Discovery convention for a unit folder** (confirmed against the two real
committed units `pig_a_pose_full`/`fox_a_pose` plus the staged
`radish_raccoon_2`): a unit lives at `assets/units/<unitId>/<unitId>.unitdef.
json` + `<unitId>.glb` (+ optionally `<unitId>.unrigged.glb`, kept by
`src/server/studio/export.ts:170` purely for comparison, never referenced by
any unitdef). `skeletonRef` and `clipLibRef` inside the unitdef are resolved
**relative to the unit's own directory** by every consumer (`bake-units.ts`,
`validate-units.ts`, `src/render/.../unit-assets.ts`). The **family**
documents (skeleton + cliplib) conventionally live one level up, sibling to
every unit directory: `assets/units/<family>.skeleton.json` +
`assets/units/<family>.core.cliplib.json`, referenced from inside a unit as
`../<family>.skeleton.json` / `../<family>.core.cliplib.json` — this is
exactly what `export.ts:143` does automatically (`skeletonRefFromUnit =
skeletonRef.includes('/') ? skeletonRef : \`../${skeletonRef}\``) for
`skeletonRef`, but **not** for `clipLibRef`, which `export.ts:237` always
writes as a *bare* `${clipLibId}.cliplib.json` (no `../`) — i.e. **inside the
new unit's own folder** unless the id itself contains a `../` (which is how
`biped.core.cliplib.json` ended up promoted to the shared root: its
`clipLibId` was passed as `"../biped.core"`). This is exactly the state
`radish_raccoon_2.unitdef.json` is in right now: `skeletonRef` already
points one level up to a family file that must be created; `clipLibRef` is
still folder-local and would need editing (to `"../biped_small.core.
cliplib.json"`) if the intent is to share it the way `biped` is shared.

The render-side **family id** is a different derivation, from
`src/render/iso3d/world/unit-assets.ts:221`: `clipLib.id.replace(/\.core$/,
'')` — so the cliplib document's own `id` field must literally end in
`.core` (e.g. `id: "biped_small.core"`) for `familyAssets('biped_small')` to
resolve. This must agree with the manifest's `family` (derived from the
*skeleton filename*) — they're computed two different ways from two
different documents and nothing asserts they match except by convention.

## 4. The state machine (`src/units/machine.ts`)

Ticks at whole 60Hz steps (`DEFAULT_TICK_MS`), never a frame delta.
`category: StateCategory = 'loop'|'oneshot'|'locking'|'terminal'`
(`types.ts:129`):
- `loop`: never "finished" (`get finished`, line 562-566, returns false for
  `state.loop===true`), crossfades freely via ordinary transitions.
- `oneshot`: entering one from a `loop` state records `returnTo` (line
  640-645); on `exit` (finished with no matching transition) it auto-returns
  via `state.blendInMs` (line 629-633); `cancelAction()` is the explicit
  early-exit (spec 166) — cross-fades back over `blendInMs`, and **only
  works on a `oneshot`** (returns false otherwise).
- `locking`: `evaluateTransitions` (line 603-634) returns immediately unless
  `this.finished` — refuses **every** transition, including trigger-driven
  ones, until its own clip has run its course. The validator additionally
  forbids marking its outgoing transition `interruptible: true`.
- `terminal`: `evaluateTransitions` returns immediately, unconditionally —
  no exit exists in the document at all (validator refuses one). The only
  way out is the imperative `revive()` (line 369-378), which jumps straight
  back to `entryStateId` (**not** any authored transition) and is a no-op
  unless currently in a terminal state.

`entryStateId` (constructor, line 185-188) = `options.entryStateId ??
unit.stateMachine.states[0]?.id` — **the first element of the `states`
array**, not a magic id like `"idle"`. This is also what `revive()` returns
to.

`BlendTree` (`types.ts:148-158`): one float/int `parameter`, `>=2`
thresholds strictly ascending by `value`, each naming a `clipRef`.
`blendWeights` (line 74-94) clamps outside the threshold range (no
extrapolation) and linearly interpolates weight between the two bracketing
thresholds otherwise, returning 1 or 2 `PoseSample`s.

`Transition` (`types.ts:160-167`): `from` (state/tree id or `'*'`), `to`,
`condition` (parsed once via `condition.ts`'s tiny grammar: `exit` |
`name`/`!name` (bool/trigger) | `name <op> number` (float/int, ops `> < >=
<= == !=`)), `durationMs`, `interruptible` (only load-bearing on a `locking`
source, enforced by the validator).

`ActionTiming` (`types.ts:169-177`): `actionId, windupMs, activeMs,
recoveryMs, clipRef, eventMap: Record<phaseNameOrFreeform, clipEventName>`.
`startAction(actionId, override?)` (line 276-289) finds the **state** whose
`clipRef === action.clipRef`, computes `timeScaleFor(action, clip.
durationMs)` (`clipDuration / (windup+active+recovery)`), and enters that
state at that rate — this is the trigger-independent path used by e.g. the
movement sandbox's attack sliders; content-driven combat goes through
`trigger()` + a `from:'*' to:<state> condition:<paramName>` transition
instead (see `scaffoldStateMachine`, below).

### What `driveUnit` (`src/render/iso3d/world/unit-driver.ts:239-276`) needs, for a walk+idle-only monster

- **Parameters it writes every tick regardless**: `speed` (float, off drawn
  motion) and `dead` (bool). `UnitMachine.setParameter` silently no-ops if a
  name isn't declared in `stateMachine.parameters` — so these being absent
  from the document is *safe*, not fatal, just means the value is dropped.
- `revive()` is called every tick `!facts.dead` — harmless no-op unless
  `current.stateId`'s category is `terminal` (which a walk/idle-only machine
  need not have at all).
- **Triggers are never raised** unless `facts.activity` actually transitions
  into `Casting`/`Stunned` on the wire (`startedCasting`/`startedStagger`,
  line 334-372) — a monster whose server-side behaviour never casts or gets
  staggered will never have `machine.trigger(...)` called, so `attack`,
  `shoot`, `cast`, `stagger` need not be declared as parameters at all. (If
  they somehow were raised anyway, `UnitMachine.trigger` doesn't check
  declaration — harmless either way since nothing in the machine names them
  in a transition.)
- **No specific state or clip *ids* are required by `driveUnit`, `unit-
  driver.ts`, `machine.ts`, or `unit-rig.ts`** — `idle`/`locomotion`/`move`/
  `walk`/`run` are pure convention from `scaffold.ts` (see below), not
  reserved words. The only reserved *strings* anywhere in this path are the
  five `DRIVEN_PARAMETERS` keys (`speed, dead, attack, shoot, cast,
  stagger` — `unit-driver.ts:120-142`), because `driveUnit` writes to those
  parameter names literally.
- Minimal working shape (verbatim from `src/units/scaffold.ts:121-180`,
  which is exactly the "walk + idle" case, `blended` branch, no
  attack/death): parameters `[{name:'speed',type:'float'},
  {name:'dead',type:'bool'}]` (attack trigger param optional if unused);
  states `[{id:'idle', clipRef:'idle', loop:true, timeScale:1,
  blendInMs:150, category:'loop'}, {id:'locomotion', clipRef:'move',
  loop:true, timeScale:1, blendInMs:150, category:'loop'}]`; one blend tree
  `{id:'move', parameter:'speed', thresholds:[{value:0,clipRef:'idle'},
  {value:34,clipRef:'walk'},{value:150,clipRef:'run'}]}`; two transitions
  `speed > 5` / `speed < 5` (`MOVING_SPEED=5`), both `durationMs:150,
  interruptible:true`; `actionTimings: []`.

## 5. Drawing a monster as an authored unit

Two independent tables + one manifest-driven registry:

1. **`src/server/data/monsters.ts`** — the new monster type id must exist
   here (or reuse an existing one) so `monsterById(typeId)` gives
   `appearanceOf` (`src/render/iso3d/world/appearance.ts:191-204`) a real
   `radius` and `showsHealth`/friendliness answer. Sim-side, unrelated to the
   rig.
2. **`src/render/iso3d/world/unit-catalog.ts`** `DEFAULT_AUTHORED_UNITS`
   (line 45-64) — a plain `Record<typeId, AuthoredUnitId>`. Add
   `'raccoon_type_id': 'radish_raccoon_2'` (or whatever unit id the
   unitdef's own `id` field is). `authoredUnitFor(look)` (line 135-144) only
   ever fires for `look.rig === 'monster' | 'player'` and returns `null`
   (falls back to `MechRig`/`CritterRig`) if `authoredUnitAssets(id)` can't
   find it — i.e. **a missing bake is a safe fallback, not a crash**. No
   code-side wiring needed to *test* it though: `?units=<typeId>:radish_
   raccoon_2` (`unitsFromQuery`, line 100-119) overrides the table from the
   URL for exactly this purpose, and already validates the id against
   `authoredUnitIds()`.
3. **`assets/units/manifest.json` must actually list the unit** — i.e.
   `npm run bake:units` has to succeed first (it does not today; see the
   header). `src/render/iso3d/world/unit-assets.ts` builds its whole
   registry by iterating `MANIFEST.units` (line 145) and resolving every
   path via two `import.meta.glob`s (`**/*.glb` as `?url`, eager;
   `**/*.json`, eager) matched by **path suffix** (`lookup`, line 102-108) —
   so a unit not yet baked is invisible to the Play tab however the two
   tables above are edited, and conversely once baked, `?raw`/glob discovery
   needs no further code change (`npm run build`/dev server re-run to pick
   up the new glob matches).

`src/render/iso3d/unit-rig.ts` `UnitRig.load(assets, unitId)` (line 239-300):
loads `assets.meshUrl` via `GLTFLoader`, applies `model.scale.setScalar
(assets.importScale)` (the measured `unit.import.scale`, world units),
retextures every mesh to flat-shaded Lambert (`retexture`, line 73-88,
keeping the generator's own colour/map), finds the **root bone structurally**
off the loaded rig (`findRootBone`/`findRootChain`, line 98-139 — walks up
from the skin's actual root joint through every unskinned ancestor node,
e.g. `Armature`/`Root`/`Hip`; **does not read the skeleton document at
all**), snapshots the bind-pose local translations (`readRestPose`) before
any clip is applied, then per clip: loads the animation-only `.glb`, strips
root-chain translation tracks by exact node **name** match
(`stripRootMotion`), corrects residual travel on any other bone whose
translation track doesn't return to its start value
(`correctTravel`, threshold `TRAVEL_FRACTION_OF_REACH=0.1 * reach`), and
registers a paused, zero-weight `THREE.AnimationAction` keyed by clip id.
Sockets (`setSockets`, from the skeleton document's `sockets` array — the
only place `unit-rig.ts` reads the skeleton doc at all) are resolved by
literal bone **name**, and `attach()` parents an object under a pivot
(`socketPivot`, undoing `importScale`) hung off `model.getObjectByName
(socket.bone)`.

## 6. Clip authoring (`clip-author.ts` + `pose.ts` + `make-pig-strike.ts`)

Exact call sequence, verbatim from `scripts/make-pig-strike.ts`:

```
glb    = splitGlb(new Uint8Array(readFileSync(meshPath)))   // glb-read.ts
nodes  = readNodeTree(glb)                                   // GlbReadNode[]
naming = namingOf(nodes)                                     // pose.ts, wraps detectNaming
// fail if naming === 'unknown'
rig: PosedRig = { nodes, naming }                             // clip-author.ts:165-168
// sanity check: every BoneRole named anywhere in the AuthoredClip's keys
// resolves via boneNode(nodes, naming, role) -- else fail
document = authorClipDocument(myClip: AuthoredClip, rig, generatorString)  // GlbDocument
bytes    = writeGlb(document)                                 // glb.ts
writeFileSync(outPath, bytes)
```

`PosedRig = {nodes: readonly GlbReadNode[], naming: NamingSpec}`
(`clip-author.ts:165-168`) — just the mesh's own node tree plus its detected
vocabulary; it comes from reading **the mesh `.glb` itself**, never from the
skeleton document (`make-pig-strike.ts`'s own comment: "the rig is read from
the mesh, not from biped.skeleton.json... the difference is the bind
rotations").

`AuthoredClip` (`clip-author.ts:88-100`): `{id, durationMs, fps, keys:
PoseKey[]}`. `PoseKey = {label, atMs, ease: Easing, turns: PoseTable}`
(`Easing = 'linear'|'in'|'out'|'inOut'|'snap'`). `PoseTable =
Partial<Record<BoneRole, BoneTurns>>`, `BoneTurns =
Partial<Record<PoseAxis, number>>` (degrees), `PoseAxis =
'lateral'|'forward'|'up'|'flex'|'twist'` (`pose.ts:58`). Axes are always
composed in the fixed order `AXIS_ORDER = [lateral, forward, up, flex,
twist]` (`clip-author.ts:112`) regardless of object key order.

`authorClipDocument(clip, rig, generator): GlbDocument`
(`clip-author.ts:352-367`) — internally: `authorClip` samples `poseAt(clip,
rig, ms)` at `frameCount(clip)` evenly-spaced times (`Math.round(durationMs/
1000 * fps) + 1`, min 2), converts each sampled offset into a final rotation
via `finalRotations` (composes the offset **after** the bind rotation:
`quatMul(node.rotation, offset)`), and packs one `GlbChannel` per animated
bone (`{node: indexIntoThisDocsNodes, times: Float32Array(seconds),
rotations: Float32Array(quats)}`). The returned `GlbDocument` has `mesh:
null` and `joints: []` — **animation-only, no mesh, no skin**.

`writeGlb(document: GlbDocument): Uint8Array` (`glb.ts:214`) — writes a
standard-shape glTF binary carrying only `nodes` (name + parent index +
translation/rotation/scale) and `animations` (rotation-channel-only, LINEAR
interpolation — `clip-author.ts`'s header note: "glTF's LINEAR is the only
interpolation glb.ts writes, so the easing that makes a strike read has to
be baked into 60Hz samples").

**Node-index-to-skeleton-bone matching at load time is by NAME, not
index.** `GlbChannel.node` is an index into *this clip file's own* `nodes`
array (needed for it to be a valid standalone glTF document); once loaded
by three's `GLTFLoader`, the resulting `THREE.AnimationClip`'s tracks carry
**names** (`${node.name}.quaternion`, colon-sanitized the same way
`naming.ts`'s `boneKey` compensates for) — and `mixer.clipAction(clip)`
(`unit-rig.ts:287`, mixer built on the **mesh's** loaded model) resolves
those track names against the mesh's own skeleton via three's internal
`PropertyBinding`/`getObjectByName` traversal. This is exactly why a clip
file must be authored off (or share bone names with) the mesh it will be
applied to — `unit-rig.ts`'s big header comment and `findRootChain`'s
"three sanitises `mixamorig:Hips` to `mixamorigHips`... a name read from the
skeleton JSON matches nothing" are both about this same by-name binding.

## 7. Previewing (`preview-strike.ts`, `preview-deform.ts`)

**No shared rasterizer module** — both scripts (and `preview-trees.ts`, the
common ancestor) each define their **own** local, hand-copied software
rasterizer. `preview-strike.ts`'s own header says so outright: "The
rasteriser is the one from `preview-deform.ts`, which is the one from
`preview-trees.ts`, and it is copied for the reason those two say: there is
no GPU in a container." Each file has its own `Surface {positions:
Float32Array, indices: Uint32Array, colour: [r,g,b]}` (0..1 floats) and its
own `render(surfaces, viewDir, size, centre, span, background):
Uint8ClampedArray` — orthographic projection, per-triangle barycentric
rasterization with a `Float64Array` z-buffer, flat shading (`triangleNormal`
· light dir), linear-to-sRGB `encode`. `preview-strike.ts`'s `render`
(line 120-183) takes an array of `Surface`s (so it can composite a body mesh
+ a synthetic blade box in one pass); `preview-deform.ts`'s (not fully
copied above, but same shape) takes a single `positions`/`indices` pair per
call.

**The shared, reusable helper is `src/units/skin.ts`** — the "CPU-skin this
glb at this pose" logic, used identically by both preview scripts (and by
`mesh-check.ts`'s `checkDeformation`):
- `poseWorldMatrices(nodes: readonly GlbReadNode[], pose: PoseRotations):
  readonly (readonly number[])[]` — world matrix per node, with `pose`'s
  per-bone-name extra rotation composed **after** each bone's own local
  rotation, walked parent-first (memoized, cycle-guarded).
- `skinPositions(input: SkinInput, worldMatrices): Float32Array` —
  `SkinInput = {positions, joints: Uint32Array, weights: Float32Array,
  jointNodes: number[], inverseBind: number[][]}` — standard 4-bone linear
  blend skinning, **weights used exactly as authored, never renormalized**
  (deliberate — a mesh whose weights sum <1 shrinks, and that's a defect
  this exists to surface).
- `triangleNormal(positions, a, b, c): [number,number,number]` — unnormalized
  cross product for flat shading.
- `PoseRotations = ReadonlyMap<string, Quat>` — the same type
  `clip-author.ts`'s `poseAt`/`keyRotations` produce, so a pose computed
  from an `AuthoredClip` (`preview-strike.ts`) or from `mesh-check.ts`'s
  `extremePoses` (`preview-deform.ts`) feed the identical two functions.

Exact per-frame sequence in both scripts:
```
glb   = splitGlb(bytes); nodes = readNodeTree(glb)
mesh  = readSkinnedMesh(glb)                 // SkinnedMeshData | null
inverseBind = readInverseBindMatrices(glb)
pose  = poseAt(clip, {nodes, naming}, ms)     // strike: PoseRotations at time ms
        // -- or, for deform --  extremePoses(nodes)[i].rotations
world = poseWorldMatrices(nodes, pose)
posed = skinPositions({...mesh, inverseBind}, world)   // Float32Array positions
pixels = render(posed, mesh.indices, ...)     // local rasterizer -> PNG (pngjs)
```

`preview-deform.ts` additionally takes an optional CLI path
(`process.argv[2]`, defaults to the dev mannequin) — so it already works on
an arbitrary unit's rigged `.glb` with **no skeleton document needed at
all** (`extremePoses`/`classifyBindPose` both call `detectNaming` on the
raw node names themselves): `npx tsx scripts/preview-deform.ts assets/units/
radish_raccoon_2/radish_raccoon_2.glb` runs today, no family files required
— it's exactly what produced the elbow-angle finding at the top of this
note.

## Open questions for whoever builds this out

1. **The staged `radish_raccoon_2.glb` mesh fails the bind-pose gate as an
   error** (69° bent elbows). Either it needs regenerating from a squarer
   reference image, or the bind pose needs correcting before anything past
   `npm run bake:units` can work.
2. `radish_raccoon_2.unitdef.json`'s `import.scale: 55.75889869275895` is
   suspiciously close to but not exactly `DEFAULT_CANONICAL_HEIGHT = 55.65`
   (`src/units/canonical-height.ts`, the *player's* height) — whatever
   `canonicalHeight` gets written into the new `biped_small.skeleton.json`
   must be consistent with this already-recorded scale (`scale = canonical
   Height / measuredRigHeight`, via `skeleton-from-rig.ts`'s
   `DeriveOptions.canonicalHeight`), or the unitdef's `import.scale` will
   need regenerating to match whatever height is actually decided for a
   small woodland animal (56 world units is a full human/pig standing
   height, not obviously right for a raccoon).
3. `clipLibRef` in the staged unitdef is folder-local
  (`"biped_small.core.cliplib.json"`, no `../`) while `skeletonRef` already
  uses the shared-root convention (`"../biped_small.skeleton.json"`) — pick
  one placement for the new family's clip library and make the two refs
  consistent; nothing enforces they follow the same convention.
4. Whether `biped_small` clips are retargeted mixamo presets (walk/run/idle
   from the same source library `biped`'s clips came from) or hand-authored
   via `clip-author.ts`/`pose.ts` (`pig-strike.ts`-style) is undetermined
   from anything on disk — the currently-staged unitdef's lone `idle` state
   with empty `actionTimings`/`blendTrees`/`transitions` reads as a bare
   `scaffold.ts` stub with nothing retargeted yet.
