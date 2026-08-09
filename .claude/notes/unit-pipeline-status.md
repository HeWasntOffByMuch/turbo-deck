# Unit authoring pipeline: what is done, what is not

Written 2026-08-09, at the end of the specs 107–115 run. The companion to
`unit-pipeline-audit.md`, which is the *pre-work* survey and is now history —
this is the state of the thing that got built.

The brief: **reference image in, animated unit wired to a gameplay state
machine out, with a Studio tab for driving it and tuning it by eye.**

Standing constraints, all still held:

- The API key is server-side only. Nothing in the bundle, no browser request to
  `openapi.tripo3d.ai`.
- No paid call without an explicit confirmation showing a projected cost.
- Only `.glb` reaches the client. Conversion is offline.
- No second post-process pass. Units go through what exists.
- No physics engine.
- Play and Editor keep working unchanged.
- A failed paid call is **never** retried by the machine.

---

## Done

### The format — spec 107

A unit is three JSON documents: `skeleton.json` (one rig family, mixamo bone
contract, canonical height), `cliplib.json` (clips for a skeleton, events in
normalized time) and `<unit>.unitdef.json` (mesh, provenance, import overrides,
state machine). Structure is checked against committed JSON Schemas with ajv;
what a schema cannot say — reference resolution, bone ordering, the time-scale
bound — is hand-written beside it in `validate.ts`. `npm run validate:units`.

The rule the format exists to enforce: **gameplay timing is authoritative and
the clip is rescaled to fit**, bounded in both directions.

### The authoring service — spec 108

`src/server/studio/`. Node-only, imported by nothing in the server's portable
half, because this is where the key lives. `tripo.ts` is the only file that
knows the API's paths and field names.

The half that decides whether to spend — `cache`, `confirm`, `jobs`, `ledger`,
`pacing`, `pricing` — is pure, clock-injected, linted as part of the
deterministic core, and driven end to end in tests through a fake fetch.

Interlocks: confirmation is a server-issued one-shot token, not a browser
boolean; ceilings are checked against spend-so-far plus the projection before
anything is sent; the job record is written *before* the submit; a model URL is
downloaded in the handler that saw it succeed (they expire in ~5 minutes) and
never stored; and a failed paid call is never picked up by anything on a timer.

### The Studio tab — spec 109

Fifth entry in the tab shell: ingest, generate, library, preview, export.
`image-check.ts` measures what pixels can actually answer about a reference
image and leaves the rest as a checklist, because a green tick that means
nothing is how a bad reference gets generated twice. `plan.ts` derives whether a
generation establishes a rig family from the library rather than from a
checkbox, since that decision is money. `api.ts` tells "no server", "no token"
and "wrong token" apart — three problems, three fixes.

### The preview — spec 110

The game's own RetroPass and cog, an isometric preset, a turntable, free orbit,
and a ground plane with a silhouette at the height a player is really drawn. The
mixer is driven with `update(0)` after each action's time is written from the
machine's integer tick, so the pose is a pure function of a tick count.
Timeline, timing bar and graph layout are pure and tested; the DOM writes every
edit back through the server.

The reference unit (`assets/units/dev/`) is a real skinned biped on the mixamo
contract at ~1.7 units, so the ~32x import scale is measured rather than
invented. It exists so the preview and the checks have a subject before a credit
is spent.

### The same machine in the game — spec 111

One `machine.ts`, two callers. `unit-driver.ts` is a pure function from
replicated facts to machine commands, handed a snapshot and **not** the
`GameClient`, so animation has nothing it *could* call. `unit-lod.ts` throttles
the mixer, never the machine, because events are authored on frame indices.
`presentation-only.test.ts` plays the same seed and inputs twice, with and
without the animation layer, and requires byte-identical authoritative state.

### Scaffold and export — spec 112

A first unitdef derived from what was actually retargeted: a clip library over
the clips that exist, and a machine reaching only the states the runtime can
drive. Action phases are split from the clip's own length so the rate is exactly
1.0 before anybody tunes it. Durations are **measured** off the loaded `.glb`,
never guessed — a made-up duration validates and then silently rescales every
action timing.

`scripts/preview-library.ts` stands up a real authoring server over a seeded job
and clicks Preview, because clip lengths and import scale only exist once three
has decoded a `.glb`.

### The bake and the manifest — spec 113

`npm run bake:units` walks `assets/units/`, gates triangle counts against the
declared `import.targetTris`, runs the mesh checks, hashes every file and writes
`assets/units/manifest.json`. The manifest is committed, so a roster change
reviews as a diff; CI re-bakes and fails on a stale one.

A sha256 over every asset is exchanged at connect and a mismatch is a refused
connection — a client on stale assets draws a fight that is not the one being
played, and nothing looks wrong until somebody notices. An *absent* client hash
is allowed, because the in-tab server and the bot harness share a process with
what they connect to.

**The game's roster is the contents of `assets/units/`**, discovered with
`import.meta.glob` and indexed by the manifest. Exporting a unit and re-baking is
the whole of adding one; no code changes. Every document goes through
`loadUnitBundle` on the way in, so a broken unit is refused with its reasons
rather than drawn wrong.

### Releasing a rig family — spec 114

Ownership of a family's clip library is derived: "no succeeded job of this family
claims it". The first job to succeed therefore closed the door forever, including
when its clips were the ones you would not ship, and the only escape was
inventing a second family name. `releaseFamily` clears the claim; the derivation
reopens on its own.

It does not touch a job that is not succeeded (that would reprice a retry), does
not touch `creditsSpent` or any task id, and does not delete clips. The button
warns about what the *next* generation buys rather than saying "this is free" —
free is true and useless.

### Reading the mesh — spec 115

Everything above validates a *document*. These read vertices, because the ways a
generated rig actually fails are not in a schema.

- `glb-read.ts` — the binary chunk: accessors, the skin, the node tree. Refuses
  what it cannot honestly decode (sparse, Draco, meshopt) rather than measuring
  compressed bytes and reporting the nonsense as findings.
- `skin.ts` — linear blend skinning on the CPU, deliberately **not**
  renormalizing weights, since a mesh that shrinks as it poses is the thing being
  looked for.
- `mesh-check.ts` — weight sums, a second influence set the runtime silently
  drops, joint indices, vertices bound to nothing, vertices no triangle draws,
  degenerate triangles, whether the bind pose is a T/A or somebody's idle, and
  what four extreme poses do to the body.
- `skeleton-from-rig.ts` + `server/studio/family.ts` — a family's skeleton
  document, measured off the rig. This is what lets a **new** rig family be
  exported at all, and what finally fills in a provisional one. Once a document
  has a bind pose it is never overwritten; the next rig is checked against it.

Errors fail the bake. Deformation findings warn, because a build should not be
the thing that decides an elbow is too lumpy — but it should be the thing that
noticed. `npx tsx scripts/preview-deform.ts` is the picture a person decides
from.

Two lessons worth keeping:

1. **Pose axes are the body's, measured off the hips.** "Rotate the shoulder
   about Z" assumes the mixamo arm axis; on a rig whose arms run along Z it rolls
   each arm about its own length and scores a flawless zero on a pose it never
   applied.
2. **Deformation is measured by area, never by normal direction.** A triangle
   carried rigidly by a bone that turns 100° has a normal that turned 100° and
   nothing about it inverted. The first draft reported the mannequin's entire
   head as inside out during a spine twist.

Two defects it caught immediately, both invisible before:

- The mannequin's arms were flat cards — `addLimb` never inflated Y, so 32 of its
  156 triangles drew nothing and the arms vanished edge-on.
- Export wrote `import.scale: 1`. Honest, since nothing had measured the mesh,
  and useless: every exported unit would have reached the game at 1/32 size.

---

## Not done

### Needs a dependency decision — blocked on a choice, not on work

`builtStages` in the manifest is honestly empty. Three stages are named and not
implemented, each because it needs a real library and a stage that passed bytes
through unchanged while adding its name would make the manifest lie:

| Stage | What it needs |
|---|---|
| Decimation to `import.targetTris` | A mesh simplifier. Today the count is *gated*, not reduced: a mesh outside ±10% of its declared target fails the bake. |
| meshopt compression | `meshoptimizer`, plus the decoder on the client side. |
| KTX2 textures | A transcoder, plus `KTX2Loader` wired into the unit loader. |
| Vertex splitting for flat shading | Writing geometry back out, which `glb-read.ts` does not do — it reads only. |

The first three are the reason `npm run bake:units` prints "no mesh stages ran".
When a dependency is chosen, each becomes a stage that appends to `builtStages`
and nothing else in the bake changes.

### Screenshot baselines

`preview-deform.ts` writes a picture. Making it a **diff gate** — committed
reference images compared pixel-wise — needs a stable rasteriser and is its own
spec. The numeric deformation checks are the gate today.

### Texture and material checks

A generated unit's texture is a picture, and nothing here can say whether it is
the right one. Out of scope deliberately.

### Multiple skinned primitives

`readSkinnedMesh` reads the first one and `skinnedPrimitiveCount` exists so the
bake can warn about the plural. A unit that is genuinely several skinned meshes
is a case nothing here has seen and nothing here handles.

### Open questions for the author, not for code

- `assets/units/biped.skeleton.json` is still provisional (`bindPose: null`), and
  that is now a state the pipeline can leave on its own: exporting a job whose rig
  completed fills it in. Nothing needs doing unless the canonical family should
  be something other than what the first export measures.
- There is no way to *delete* a job or its artifacts from the UI. Release changes
  ownership, not storage.
- The retarget price (`retargetPerCall`, default 25) is still unmeasured — pitched
  at the rig's price, which is the nearest thing to evidence there is. It becomes
  a real number after the first retarget. It is deliberately not lower: a
  projection that flatters is the one failure mode a cost estimate must not have.

---

## Where things live

| Path | What |
|---|---|
| `specs/107`…`115` | The specs, written before their implementations |
| `schemas/` | JSON Schema for the three unit documents |
| `assets/units/` | The roster, plus the committed manifest |
| `src/units/` | Format, validator, machine, mesh reader, checks — all pure |
| `src/server/studio/` | The authoring service. Node-only; the key lives here |
| `src/render/iso3d/studio/` | The Studio tab |
| `src/render/iso3d/world/unit-*.ts` | How the game draws an authored unit |
| `.studio/` | Job state and ledger. Gitignored |

## Commands

| Command | What |
|---|---|
| `npm run validate:units` | Validate every authored document |
| `npm run bake:units` | Gate tri counts, run the mesh checks, hash, write the manifest |
| `npx tsx scripts/make-reference-unit.ts` | Regenerate the dev mannequin |
| `npx tsx scripts/preview-deform.ts [unit.glb]` | Photograph the extreme poses |
| `npx tsx scripts/preview-library.ts` | Real server, real browser, library → preview |
| `npx tsx scripts/preview-studio.ts` | All five tabs mount in a real browser |
| `npx tsx scripts/preview-units.ts` | An authored unit in the real arena |
