# turbo-deck

Real-time action combat over an authoritative server: melee swings and skills
that wind up and can be withdrawn from, projectiles that travel and arc, and
abilities with a cost and a cooldown. Committing to a blow is the decision the
game is built on -- the wind-up is long enough to be read, and short enough to
matter.

## The one rule that governs everything

**Simulation and rendering are completely separate.**

- `src/server/` is the simulation, and since spec 062 it is the *only* one.
  Its pure half (`sim/`, `world/`, `player/`, `data/`) has zero rendering/DOM
  dependencies and runs identically in Node or a browser. Given `(seed,
  sequence of timed inputs)` it MUST produce bit-identical state on every run.
  `src/sim/` is now just the shared geometry and the collision/pathfinding
  helpers the server builds on.
- `src/render/` is a thin layer on top: it reads sim state and draws it, and
  captures input and feeds it into the sim as timed events. It contains no
  game rules. If you find yourself writing an `if` that changes game outcome
  inside `src/render/`, that logic belongs in the sim instead.
- Because of this split, the whole game is playable and testable headlessly
  in Node, with no browser or canvas — that's what makes it possible for an
  agent to verify changes without a screen.

## Determinism rules

- Never call `Math.random()`, read `Date.now()`, or otherwise touch
  wall-clock time or ambient nondeterminism inside the deterministic core.
- All randomness (shuffles, drawn RNG for effects, etc.) goes through a
  seeded PRNG (`src/shared/prng.ts`) that is passed into the sim explicitly
  as part of its constructor/init, never imported as a singleton.
- The sim runs on a **fixed timestep of 60 ticks/second**. It never reads
  real elapsed time to decide what happens; the render loop is responsible
  for translating real time into "how many ticks to advance," and feeds
  ticks/inputs to the sim one at a time.
- A test that replays the same seed and the same input sequence must get
  the same resulting state, every time, forever. This is the property that
  makes regressions detectable — treat any test that can't make this
  assertion as insufficient.

Most of this is mechanical, not honour-system. `eslint.config.js` fails the
build on `Math.random`, on `Date`/`performance`/DOM globals, and on importing
three.js, PixiJS, lil-gui or anything under `src/render/` — across the whole
deterministic core (`shared`, `sim`, `terrain`, and the pure half of `server`) and
the pure subtrees that live under `src/render/` anyway (`cloth/`, `critters/`,
and the headless half of the editor). `src/shared/` additionally may not import
its own siblings. Two rules a linter can't see are still on you: the PRNG must
be *passed in*, never imported as a singleton, and no `if` in `src/render/` may
change a game outcome.

## Running things

| Command | What it does |
|---|---|
| `npm test` | Run the Vitest suite once (server sim, protocol, integration) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run typecheck` | `tsc --noEmit` against the strict tsconfig |
| `npm run lint` | ESLint over the whole repo |
| `npm run validate:units` | Validate every authored unit document in `assets/units/` |
| `npm run validate:items` | Validate every weapon document in `assets/items/`, against its own mesh |
| `npm run bake:units` | The offline model build: gate tri counts, hash every asset, write `assets/units/manifest.json` |
| `npx tsx scripts/make-reference-unit.ts` | Regenerate the reference unit in `assets/units/dev/` |
| `npm run build` | Production build of the renderer (Vite) |
| `npm run dev` | Dev server for the renderer, for actually playing the game |
| `npm run server` | The authoritative server, plus the admin console |
| `npm run server:bots` | Headless bot clients, for load and for watching prediction |

CI (`.github/workflows/ci.yml`) runs typecheck + lint + test on every push
and must be green before merging.

## Spec-first workflow

Every feature gets a short markdown spec in `specs/` **written and committed
before its implementation**. Use `specs/000-template.md` as the starting
point. A spec should be short: problem statement, data/API shape, the
invariants that will be tested, and explicit out-of-scope notes. Specs are
numbered in build order; implementation PRs/commits should reference the
spec they implement.

## Branching

**The default branch is `main`. Branch from it, and merge back into it.**

A fresh clone will not have `main` locally until you fetch, so:

```sh
git fetch origin
git checkout -b <branch> origin/main
```

Basing a branch on stale history has bitten real work here before: one feature
branch landed 42 commits behind, against a flat world that had since become a
heightfield. The `SessionStart` hook reports how far behind `origin/main` the
current branch is, so that shows up at the top of the session rather than at
merge time.

## Commit conventions

- Small commits, one system per commit (e.g. "add the ability resolver", not
  "add abilities and the protocol and the play view").
- Write the spec in its own commit before the implementation commit that
  follows it.
- Commit messages describe *why*, not a changelog of files touched.

## Directory layout

```
specs/           spec markdown, one file per system, written before its code
schemas/         JSON Schema (draft-07) for the three unit documents and the weapon
                 document (spec 140), committed
                 and validated against in CI. additionalProperties is false
                 throughout, so a typo'd key in a hand-edited file is an error with
                 a pointer at it rather than a field that silently does nothing.
maps/            the world, as a map document (spec 072). arena.json is what the
                 server loads at boot and streams to clients; regenerate it with
                 `npx tsx scripts/bake-map.ts`, or edit it in the Map editor tab
                 and save over it. Checked in so the world reviews as a diff.
                 recipes/ are the feature lists parts are grown from (spec 083) --
                 `npx tsx scripts/grow-map.ts --recipe maps/recipes/<n>.json
                 --rect minCx,minCz,maxCx,maxCz --seed N` adds one to the map
                 rather than regenerating it. A recipe is the only place natural
                 language enters: an agent writes one, it is reviewed as JSON,
                 and nothing at runtime reads a model.
src/shared/      PRNG, spatial hash, world extent — dependency-free helpers
                 shared by the server, the geometry helpers and terrain
src/terrain/     pure, deterministic world data: heightfields, materials, chunks
                 and where the vegetation stands. No three.js, no DOM. Also the
                 map document (spec 048): map.ts bakes a world to JSON,
                 map-world.ts loads one back as array-backed terrain, and part.ts
                 grows an existing one by a chunk-snapped rectangle (spec 083),
                 stitching the join by copying shared corners exactly and easing
                 the recipe's field in over a short skirt.
src/sim/         shared geometry (Vec2/Rect/Circle/WorldColliders) plus the pure
                 collision and pathfinding helpers the server collides against
src/items/       held objects (spec 140). A weapon is a RIGID body, so it gets a
                 small document and explicitly none of the bind-pose, skinning,
                 retarget and family machinery src/units/ exists to manage for a
                 thing that deforms -- both supplied meshes confirm it, with no
                 skin, no animation and every node transform identity. What the
                 document carries is what the mesh cannot say about itself:
                 `grip.at` (the point that sits in the palm), `grip.point` (which
                 way the business end runs) and `grip.flat` (the blade's flat
                 normal, which fixes the roll `point` alone leaves free), plus a
                 `lengthWorld` -- a length rather than a scale factor, because
                 nobody can check a scale and anybody can hold a length up
                 against the body beside it. grip.ts is the arithmetic and states
                 canonical weapon space once: blade +Y, flat +Z, edge +X, origin
                 at the grip. Where a grip sits in a particular palm is a fact
                 about the *body*, so that half lives on the skeleton's socket as
                 `rotationDeg` -- euler degrees, because it is the one field in
                 the format somebody finds by dragging a slider, and one
                 calibration serves every weapon that rig ever holds.
                 `npm run validate:items`.
src/units/       the unit authoring format and its validator (spec 107): the three
                 JSON documents a unit is made of -- skeleton.json (one rig family,
                 its bone vocabulary, canonical height), cliplib.json (clips for a
                 skeleton, events in normalized time) and <unit>.unitdef.json (mesh,
                 provenance, import overrides and the state machine). Structure is
                 checked against the committed schemas in schemas/ with ajv; what a
                 JSON Schema cannot say -- reference resolution, bone ordering, the
                 time-scale bound -- is hand written beside it in validate.ts. Pure
                 and part of the deterministic core, because the Studio tab, the
                 export path, CI and the game's runtime all read these documents
                 through this one parser. The rule the format exists to enforce is
                 that gameplay timing is authoritative and the clip is rescaled to
                 fit, bounded in both directions. `npm run validate:units`.
                 pose.ts, clip-author.ts and pig-strike.ts are how a clip gets
                 *authored* rather than bought (spec 139). pose.ts is the body's
                 own axes, measured off the rig -- promoted out of mesh-check.ts,
                 because the extreme pose that predicts what a slash does to a
                 mesh and the real slash have to be in the same frame or the
                 prediction predicts nothing. Its fourth axis, `flex`, is the
                 hinge a bone actually has, taken from its *furthest* child: the
                 first child of a generated forearm is a twist bone sharing its
                 parent's origin, so "the child" measured from noise and every
                 elbow folded backwards. Its fifth, `twist`, is the roll about a
                 bone's own length -- a wrist turning the edge into a cut. Body
                 axes cannot express one, because a roll written in them is a
                 different rotation at every moment of a swing. clip-author.ts samples key poses into
                 rotation channels, and the rule that shapes it is that glTF's
                 LINEAR is the only interpolation glb.ts writes -- so the easing
                 that makes a strike read has to be baked into 60Hz samples,
                 because nothing downstream can add it back. clip-sample.ts is
                 the same reading for a clip this project *bought* rather than
                 wrote (spec 143) -- rotation channels out of a retargeted .glb,
                 returned as offsets against bind so `poseWorldMatrices` takes
                 either kind and a measurement need not care which it has. It
                 exists because a socket calibration is only exactly right at one
                 pose and nothing could sample the pose a body actually spends
                 its life in: `weapon.main` was solved against the swing's own
                 guard key, so the blade pointed forward for two frames of an
                 800ms clip and hung straight down the rest of the time.
                 pig-strike.ts is the
                 pig's swing itself: seven full-body poses over 800ms, contact at
                 500ms because that is `melee.slash`'s wind-up and the frame the
                 picture lands and the frame the damage lands are the same frame.
                 Its legs are the one part that is *solved* rather than authored
                 (spec 143). The pig stands on its left foot and the pelvis yaws
                 54 degrees over it, so authored by eye that foot skated a fifth
                 of the rig's height across the floor while planted flat -- the
                 most legible failure an animation has, because it is not a limb
                 reading badly, it is the whole body appearing to skate. Two
                 things move it and only one is a rotation: the pelvis *turning*
                 is cancelled exactly at the hip (both are rotations about the
                 body's up, and rotations about a shared axis commute, so the
                 counter-turn still means "world up" however far the pelvis has
                 gone), while the pelvis *carrying the hip joint* -- 0.115 off its
                 own axis -- cannot be cancelled by any rotation below it and is
                 the leg reaching for the ground. `npx tsx scripts/plant-foot.ts`
                 is that solve, and three things in it were each learned by
                 writing the version without them: it pins the ankle AND the toe,
                 because a foot free to spin on the spot is the same lie as one
                 that slides; it charges per degree of bend, because a leg is a
                 linkage and the unpenalised solve pinned the foot perfectly by
                 snapping the knee straight; and it anchors on the guard pose
                 rather than the key's current values, or each run measures its
                 own last output and running the solver twice is a change.
                 `npx tsx scripts/make-pig-strike.ts` writes the committed .glb;
                 `npx tsx scripts/preview-strike.ts` photographs it frame by
                 frame with a blade proxy in the hand, because a swing judged on
                 the arm alone is judged on the half of the silhouette that is
                 not the point -- but that proxy runs down the hand bone's own
                 +Y and predates `weapon.main`'s calibration, so it is evidence
                 about the arm and not about the grip.
                 `npx tsx scripts/preview-weapon.ts` is the one that puts the real
                 mesh through the real chain.
                 The rule the swing's wrist angles are subject to: **a hand pose
                 is not a portable number** (spec 143). What a blade does is the
                 hand's orientation composed with the socket's calibration, so
                 re-solving the socket silently re-aimed the blade at every pose
                 in the clip whose wrist was authored against the old one -- a
                 constant 105 degrees, which put the blade at the floor at the
                 top of the wind-up and swung it *up* through the strike. Every
                 test passed, because they all measure where the hand IS and the
                 arm still went over the shoulder; none measured what stuck out
                 of it. So `npx tsx scripts/aim-blade.ts` states the requirement
                 in the frame it is actually about -- where the blade points, in
                 the body's axes -- and solves the wrist for it, and only the
                 wrist, since a hand is a leaf bone and rotating it turns what
                 the hand carries and moves nothing else. Re-solve the socket
                 and re-run it. `npx tsx scripts/probe-blade.ts` is the
                 diagnostic beside it and samples every frame rather than the
                 keys, because what a player reports -- "it points at the ground
                 for a moment" -- is a statement about the frames *between*
                 keys, and the keys are the only thing anybody reads while
                 authoring.
                 Two rules the wind-up itself is subject to (spec 143). **A raise
                 is one movement**: the `rise` key is a pose the blade passes
                 through, eased `in` to it and `out` of it, because it used to be
                 a `dip` that arrived at zero velocity with the next segment
                 leaving from zero -- the blade held still 140ms, turned a
                 hundred degrees in 80, and held still another 160, which is a
                 dead beat, a whip and a dead beat, and reads as two raises. What
                 measures it is the *spread* -- when the raise is a tenth done and
                 when it is nine tenths done -- because counting humps in the rate
                 finds one either way and the fault was the stillness around it.
                 **The elbow raises the sword, not the torso**: the first version
                 abducted the shoulder 116 degrees with the elbow straight and
                 twisted the torso 81 to make up the difference, and a pig winding
                 up to chop looked like a pig turning round to leave. That
                 preference lives as weights in aim-blade.ts rather than as angles
                 in the clip, and the solver needs a *place for the hand* beside
                 the blade's direction (solved on aim alone it tucked the hand
                 inside the pig and left the strike no reach) and a grid of
                 starting points (an arm reaching a place has answers separated by
                 ridges a descent will not cross), and a place for the *elbow*, because a
                 blade direction and a hand position still leave the elbow free
                 to swing around the line between them like a door -- it went
                 inboard, 0.02 from the spine on a pig whose ribs reach 0.179,
                 and every other measurement was happy. The rule under all three:
                 **a chain has more freedom than the constraints on it, and what
                 is left unstated is not left alone**, it is decided by whatever
                 the strain term happens to prefer. Hand and elbow targets are a
                 linkage rather than two wishes -- upper arm 0.178, forearm 0.114
                 -- and a pair 0.071 apart is not a pose.
                 naming.ts is the two bone vocabularies and the one way to look a
                 bone up across them (spec 120). There are two in the tree
                 permanently: the reference mannequin is authored and
                 mixamo-named, and every *generated* rig is on the `tripo` spec,
                 because a rig built to the mixamo naming spec is refused by the
                 retarget -- the two specs are a choice between Tripo's animation
                 library and Mixamo's, and a game needs the clips. So `naming` is
                 a field that is detected off the bones and checked against them
                 by the validator, never assumed. The rule that makes it a table
                 rather than a heuristic: every consumer wants a bone's *role* --
                 the right hand, the left hip, the arm chain -- and none of them
                 want a string, so roles are named once and each vocabulary says
                 what it calls them. This existed as an assumption for a long
                 time and cost three silent failures on every unit we ship: the
                 pig derived no weapon sockets at all, its facing fell back to
                 the shape search with handedness unverifiable, and its bind pose
                 came back `unmeasured`. Each had been noticed separately and
                 written down as a shrug in a comment beside the code that gave
                 up. Adding a third vocabulary is a column in this file.
                 manifest.ts is what both ends agree on (spec 113): a sha256
                 over every asset, exchanged at connect, and a mismatch is a
                 refused connection -- a client on stale assets draws a fight
                 that is not the one being played and nothing looks wrong until
                 somebody notices. An *absent* client hash is allowed, because
                 the in-tab server and the bot harness share a process with what
                 they connect to. `npm run bake:units` writes it; decimation,
                 meshopt and KTX2 are deferred rather than faked, and
                 `builtStages` records what actually ran.
                 glb-read.ts, skin.ts and mesh-check.ts are the half that reads
                 the *vertices* (spec 115), because every other check here reads
                 a document and none of the ways a generated rig actually fails
                 are in a schema. The reader takes the binary chunk and refuses
                 what it cannot honestly decode; skin.ts is linear blend skinning
                 on the CPU and deliberately does not renormalize weights, since
                 a mesh that shrinks as it poses is the thing being looked for;
                 mesh-check.ts is weight sums, a second influence set the runtime
                 silently drops, joint indices, vertices bound to nothing or drawn
                 by nothing, degenerate triangles, whether the bind pose is a T/A
                 or somebody's idle, and what four extreme poses do to the body.
                 Two rules learned the hard way: pose axes are the *body's*,
                 measured off the hips, because "rotate the shoulder about Z"
                 assumes the mixamo arm axis and on a rig whose arms run along Z
                 it rolls each arm about its own length and scores a flawless zero
                 on a pose it never applied; and deformation is measured by area,
                 never by normal direction, because a triangle carried rigidly by
                 a bone that turns 100 degrees has a normal that turned 100
                 degrees and nothing about it inverted. Errors fail
                 `npm run bake:units`, deformation findings warn, and
                 `npx tsx scripts/preview-deform.ts` is the picture a person
                 decides from. skeleton-from-rig.ts turns a rigged .glb into a
                 family's skeleton document, which is what lets a new rig family
                 be exported at all and what finally fills in a provisional one;
                 compareToFamily is the shared-skeleton rule as a check, since the
                 family's one clip library animates every unit in it.
                 canonical-height.ts is the height a body is drawn at, in one
                 place rather than inside one hand-written asset.
                 scaffold.ts derives a first unitdef for a unit that has just
                 been generated (spec 112) -- a clip library over what was
                 actually retargeted, and a machine reaching only the states the
                 runtime can drive, with the action split out of the clip's own
                 length so the rate is 1.0 before anybody tunes it.
                 bundle.ts is the one way a unit is read (spec 111): the Studio
                 tab and the game both call loadUnitBundle rather than casting
                 their imports, so a broken document is refused at both ends
                 instead of at neither. root-motion.ts names translation on the
                 root bone, in a clip's glTF JSON for CI and in three.js track
                 names for the importer -- one rule, so the gate and the loader
                 cannot disagree about what counts.
                 facing.ts measures which way a unit actually points, off the
                 `.glb` bytes and with no GL context: the mesh's front (from
                 geometry alone), the rig's (ankle to toe), and the clip's (the
                 stance foot slides backwards under a body going forwards). It
                 exists because `forwardAxis` in a skeleton document is an
                 assertion and nothing measured it, so "faces the camera, walks
                 backwards" had four possible causes with four different fixes
                 and no way to tell them apart short of generating another unit.
                 `npx tsx scripts/probe-facing.ts --job <id>` runs it over a real
                 generation; the reference unit is the control, and the test
                 beside it introduces each of the four faults on purpose.
                 machine.ts is the state machine BOTH the Studio tab and the game
                 drive (specs 110-111) -- one machine, two callers, which is what
                 makes "the tool and the game read the same files" a fact about
                 the module graph rather than a promise. It advances in whole
                 60Hz ticks and fires events on integer frame crossing, walking
                 one tick at a time, so an overshooting step cannot skip an event
                 or fire one twice. glb.ts writes a .glb (glTF is JSON plus a
                 binary chunk; a writer for the subset we emit is smaller than
                 the argument for a dependency) and reference-unit.ts is the
                 mannequin it writes: a real skinned biped on the mixamo
                 contract, authored at ~1.7 units like a real rig so the ~32x
                 import scale is measured rather than invented. It exists so the
                 preview, the deformation checks and the screenshot baselines
                 have a subject before a credit is spent.
src/server/studio/  the unit authoring service (spec 108). Node-only, wired in from
                 src/server/index.ts and imported by nothing in the server's
                 portable half, because this is where the Tripo API key lives.
                 tripo.ts is the ONLY file that knows the API's paths and field
                 names, so the first real call corrects one file; everything
                 above it speaks TaskHandle/TaskResult. The half that decides
                 whether to spend -- cache.ts, confirm.ts, jobs.ts, ledger.ts,
                 pacing.ts, pricing.ts -- is pure, clock-injected and linted as
                 part of the deterministic core, and is driven end to end in
                 tests through a fake fetch. The interlocks: confirmation is a
                 server-issued one-shot token rather than a browser boolean,
                 ceilings are checked against spend-so-far plus the projection
                 before anything is sent, the job record is written BEFORE the
                 submit, a model URL is downloaded in the same handler that saw
                 it succeed (they expire in ~5 minutes) and never stored, and a
                 failed paid call is never retried *by the machine* -- nothing on
                 a timer picks one back up, but a person can retry it from the
                 stage that failed, priced at what is left rather than at the
                 job's original cost, because a retarget that dies on its third
                 clip must not cost a fresh mesh and rig to recover from.
                 A family's clip library can be handed back (spec 114): the first
                 job to succeed owned it forever, including when its clips were
                 the ones you would not ship, and the only escape was inventing a
                 second family name. Releasing is free and never touches what was
                 paid for; it changes the price of the *next* generation, which is
                 what the button says rather than saying "this is free".
                 family.ts is where a skeleton document comes from at export time
                 (spec 115) -- measured off the rig when there is none, filled in
                 when the one there is provisional, and never overwritten once it
                 has a bind pose, because from then on it is the contract the next
                 rig of the family is checked against.
                 jobs.json is rewritten
                 atomically; ledger.jsonl is append-only. State lives in
                 .studio/ and is gitignored.
src/ui/          the GUI framework (spec 123), and a top-level peer rather than a
                 subdirectory of src/render/ because layer 1 belongs to no engine.
                 core/ is layout, hit-testing, focus, event routing, the widget
                 tree, and since spec 133 motion and sound: a tween is a pure
                 function of the time it is handed rather than an animator with a
                 clock (an animator would make every golden a question about when
                 the test ran), and a sound is a *name* emitted into a sink, so
                 this layer never learns what a sound is. Reduce-motion rides on
                 the paint context beside the time and is checked inside
                 `animate` rather than at each call site, which is what lets it be
                 a property over the whole easing table instead of a claim each
                 widget has to remember. text/ is the two bitmap faces; theme/ is theme.json plus the
                 atlas authored as text; widgets/ is the nine; screens/ is the
                 eight (the HUD, the bag, the sheet, the shop, the keybindings,
                 the trade table, the options window and its display page);
                 input/ is the actions, the key map and the two preferences that
                 outlive a session -- the bindings and the interface scale, each
                 a versioned document over an injected `StorageLike` that never
                 throws, because a corrupt preference must cost defaults rather
                 than a black screen;
                 render/ is the only impure part. Everything else runs in Node.
                 Since spec 131 all but the HUD are in the Play tab, over
                 the world -- mounted by src/render/iso3d/world/ui-screens.ts,
                 which is where a screen meets a `GameClient` and the only place
                 that is allowed to. The HUD stays in the gallery: the DOM one
                 ships, and swapping it is a redesign rather than a mount.
                 Three rules the code rests on, all of them enforced rather than
                 honoured. **Time is an argument** -- `UiRoot.update(nowMs)`, and
                 nothing under src/ui/ may read `Date` or `performance`, which is
                 what makes an input-replay test exact rather than approximately
                 reproducible. **A widget cannot reach the sim** -- it may read the
                 content tables, as the HUD already does, but lint refuses it
                 `server/sim`, `world`, `player` and `state`, so the CLAUDE.md rule
                 that no `if` in the renderer changes an outcome is finally a fact
                 about the module graph. **No colour is spelled out** in a widget;
                 a hex literal there fails the build.
                 Since spec 137 the bag is a *pointer* surface: one press and
                 one release on a cell is the whole gesture vocabulary (left
                 takes a stack, right takes half, shift+right takes one,
                 shift+left wears it), a carry empties the cell it came from so
                 it can be put back, and dragging an item is gone. The rule that
                 came out of it and applies to every screen: **a press hands the
                 keyboard only to something that types**. Focus used to follow
                 every press, so an open window silently held the arrow keys,
                 Space and Enter -- four movement bindings and a cast -- and the
                 blue focus ring on a cell read as "active" when nothing was.
                 `focusOnPress` is false on `Widget` and true on `TextField`
                 alone; Tab still reaches everything focusable, because Tab is
                 not a key anybody plays with.
                 The UI has a *scale*, not a resolution: one UI pixel is always a
                 whole number of device pixels and the viewport is whatever the
                 window leaves, so it never reads the world's `lowRes` setting --
                 which is off by default and may go. A camera needs a fixed aspect
                 because it has to frame consistently; an interface does not.
                 Since spec 136 that scale is a *setting* on the options window's
                 Display tab, and `auto` -- the default -- is `autoUiScale`
                 unchanged. A chosen number is honoured outright rather than
                 clamped back against the auto rules: those exist to choose for
                 somebody who has not, and a preference that silently became a
                 different number would fail on exactly the screens somebody
                 would want to change it on.
                 render/ has three backends behind six methods. raster.ts is pure
                 software and is the golden-image oracle, which is what lets a
                 screen be compared byte for byte inside `npm test` with no GPU and
                 no browser -- every other visual check in this repo photographs a
                 browser and none of them run in CI. canvas2d.ts is what ships. A
                 WebGL one is deferred until the frame budget asks for it; the
                 measurement so far is 0.9ms against a 1.5ms budget.
                 Having two unrelated backends is not redundancy, it is the check:
                 `npx tsx scripts/preview-ui-gallery.ts` renders the same tree
                 through both and compares them pixel for pixel. It immediately
                 caught the thing offscreen testing never could -- a 2D canvas clip
                 only ever narrows, so recomputing the clip after each pop (which is
                 what raster.ts correctly does) left everything after the first
                 `popClip` quietly cropped in the browser and perfect in Node.
                 `npm run bake:ui-goldens` accepts a visual change; CI re-bakes and
                 requires no diff, like the unit manifest.
src/render/      the client: a tab shell over the play view, the two tuning
                 sandboxes and the map editor. iso3d/shell-tabs.ts is the one
                 decision in the shell worth failing a test over (spec 140): a
                 handheld is offered the tabs marked `game` and nothing
                 else, because five of the six are workbenches a finger cannot
                 drive, and with one tab left there are no tab buttons to draw.
                 The bar stays -- ui-layer measures it to know where the app's
                 chrome ends, and the fullscreen button lives in it.
                 iso3d/device.ts is what "handheld" means, and it is one file
                 because it used to be one media query in another (spec 141).
                 `(pointer: coarse)` describes the *primary* pointer and a
                 browser may answer "fine" about a touchscreen -- Chrome's
                 desktop-site mode does exactly that, deliberately, while
                 inflating the viewport to ~980px -- so a real phone loaded the
                 shipped build and got six tab buttons, seven tuning popovers and
                 the developer readout over the grass. The rule now reads four
                 facts and is pure, so every device is a row in a test rather
                 than something somebody has to be holding: no touch anywhere is
                 never handheld, a coarse primary pointer always is, and
                 otherwise touch plus a short side under 620 CSS px is. The
                 *short* side, so turning the phone over cannot change the
                 layout -- which is what still lets it be decided once at mount
                 with no resize listener. The browser half of that check has to
                 fake `maxTouchPoints`, because Chromium forces `pointer: coarse`
                 the moment touch emulation exists and will not reproduce the
                 device at all; what it is worth is the *wiring* -- point the
                 layout back at a media query and preview-touch says so.
src/render/cloth/ pure cloth simulation for the robed character (spec 046) --
                 solver, wind, patterns, colliders and figure metrics. No
                 three.js and no DOM, so it runs and is tested headlessly.
src/render/critters/ playable animal characters as pure data (spec 055): one
                 file per species (proportions, blocks, sockets, colours) over
                 the shared skeleton, plus the player coat palette. No three.js.
                 Adding an animal is a data file + one line in index.ts;
                 `src/render/iso3d/critter.ts` already knows how to build it.
                 `npx tsx scripts/preview-critters.ts` renders the real rig to
                 .claude/screenshots/critters.png to check it reads at 64px.
src/render/iso3d/studio/  the Studio tab (spec 109), the fifth entry in the tab
                 shell: ingest, generate, library, preview and export over the
                 spec 108 service. image-check.ts and plan.ts are pure and
                 tested headlessly -- the first measures what pixels can
                 actually answer about a reference image and leaves the rest as
                 a checklist, because a green tick that means nothing is how a
                 bad reference gets generated twice; the second derives whether
                 a generation establishes a rig family from the library rather
                 than from a checkbox, since that decision is money. api.ts
                 tells "no server", "no token" and "wrong token" apart, because
                 they have three different fixes. view.ts renders the projected
                 cost before the button that spends it exists.
                 preview.ts is the viewport (spec 110): the game's own RetroPass
                 and its cog, an isometric preset, a turntable and free orbit, and
                 a ground plane with a silhouette at the height a player is really
                 drawn -- a unit that is subtly the wrong size looks fine alone and
                 wrong beside something. The mixer is driven with update(0) after
                 each action's time is written from the machine's integer tick, so
                 the pose is a pure function of a tick count. Caveat worth knowing:
                 this is the same control-panel TYPE as Play's, not a shared
                 instance, so a switch has to be thrown in both places.
                 timeline.ts, timing-bar.ts and graph-layout.ts are the panels'
                 arithmetic, pure and tested; preview-panel.ts is the DOM over
                 them and writes every edit back through the server.
                 `npx tsx scripts/preview-library.ts` stands up a real
                 authoring server over a seeded job and clicks Preview on the
                 library card (spec 112) -- the clip lengths and the import scale
                 only exist once three has decoded a .glb, so the flow cannot be
                 checked anywhere else. It caught the object URLs being revoked a
                 moment before the loader asked for them.
                 `npx tsx scripts/preview-studio.ts` clicks all five tabs in a
                 real browser, since a fifth array entry cannot fail a typecheck
                 and cannot fail a headless test -- and it is the only thing that
                 can tell whether three's GLTFLoader accepts the .glb we write.
src/render/iso3d/editor/  the map editor tab (specs 049-052, 084). Renders only
                 from a loaded map document, never from the world generator.
                 camera.ts, brush.ts, scatter.ts, markers.ts, parts.ts and
                 history.ts are pure and tested headlessly; view.ts, cursor.ts and
                 marker-view.ts are the three.js scene; panel.ts is the lil-gui
                 surface. parts.ts adds and removes map parts (spec 084) through
                 the same bakePart the grow script uses, and history.ts records
                 created and deleted chunks, the layer's bounds and the parts list
                 so growth undoes like any other stroke, naming which chunks
                 went away so a commit costs the part and its ring rather than
                 the whole map (spec 085). The prop field invalidates by region
                 for the same reason (spec 086): props.ts groups props into
                 square batches for culling, and an edit rebuilds only the
                 batches over the ground it touched.
                 `npx tsx scripts/preview-parts.ts` drives the tools in a real
                 browser, since the drag and the commit live in view.ts.
src/server/      authoritative multiplayer server (specs 056-057, 062). Its sim runs on
                 the same fixed 60Hz timestep as src/sim/ and broadcasts deltas
                 every third tick (20Hz) -- one rate for the game, another for the
                 wire. It shares the pure helpers (prng, collision, terrain, world
                 extent) but not CombatState. sim/, world/, player/ and data/ are
                 pure and linted as part of the deterministic core; the transport
                 and admin halves are not.
                 Since spec 072 its world comes from maps/arena.json rather than
                 the generator, and terrain reaches clients as MapInfo plus the
                 MapChunks a player is standing near -- a seed cannot describe a
                 map somebody edited by hand.
                 net/ is the binary wire format (see net/PROTOCOL.md), sim/ is the
                 deterministic tick, world/ is chunking and zones, player/ derives
                 stats from ids and levels, state/ is the swappable DataStore,
                 admin/ is the token-gated admin namespace, client/ is the
                 transport-agnostic session the renderer draws from.
                 sim/attack-timing.ts is how long an attack takes, in every sense
                 of the question (spec 144), and the only place any of it is
                 worked out. The idea it exists to hold is that the **attack
                 interval and the attack animation are two spans that start
                 together and end apart**: an interval from the wind-up's first
                 tick, an attack point partway through it where the blow becomes
                 real, and a backswing after that which may be walked out of for
                 free. One factor -- `(1 + attackSpeed/100) * mult * slowMult`,
                 HoN's, where +100 is twice the rate -- divides all three, so
                 attacking faster shortens the swing rather than only the
                 standing still.
                 The attack point is a *boundary*, and `abilities.ts` has two
                 differently-named cancellations either side of it because the
                 outcomes have nothing in common: `cancelWindup` refunds
                 everything and the attack did not happen, `cancelBackswing`
                 returns the legs and nothing else because it already did.
                 Which is the whole feature -- skipping a follow-through buys
                 movement and can never buy a faster next attack, since the tick
                 governing the next one was written down at the attack point and
                 no cancellation path writes it again.
                 Two rules learned by getting them wrong first. The interval is
                 measured from `windupStartTick`, not from the commit: spec 065
                 turns the body before the swing begins, and counting the turn
                 against the cadence would make a body that had to come round
                 attack more slowly forever. And the timing is *snapshotted* on
                 the cast, so a buff landing mid-wind-up belongs to the next
                 attack -- recomputing per tick lets a haste buff at 90% of a
                 swing put the release in the past.
                 The same-tick ordering had to be picked rather than derived, and
                 `cancelWindup` picks it: movement runs before casts, so a
                 withdrawal on tick T is *seen* before the release T is about to
                 process, and the release tick belongs to the attack. The last
                 tick a withdrawal works on is `releaseTick - 1`, asserted from
                 both sides in `sim/attack-cancel.test.ts`.
                 Where a player's attack speed comes from is deliberately still
                 nowhere: spec 091 took the cadence off the weapon on purpose and
                 144 built over that rather than reversing it, so the stat is a
                 socket at zero and monsters author BAT per row as they already
                 did. `npx tsx scripts/probe-attack.ts --cancel=never|backswing`
                 prints the two timelines side by side, and the invariant reads
                 off the summaries: same attacks, same cadence, a body rooted 24
                 ticks per cycle or 1.
                 player/trade.ts and trades.ts are the first exchange with two
                 owners (spec 132), and the difference from the shop is not size:
                 its failure mode is *duplication* rather than a wrong number, so
                 the swap is one pure function returning four whole containers --
                 both sides computed and checked before either is written, so
                 there is no state in which one bag has been debited and the other
                 has not. An acceptance names a revision and every edit bumps it,
                 which turns the swap-it-at-the-last-instant scam into a
                 mechanical impossibility rather than a race worth timing; and an
                 offer names *slots*, resolved against the bag at swap time, so a
                 bag that changed underneath refuses the whole trade instead of
                 trading whatever is in that slot now. The property test counts
                 both players together, because a swap that duplicated a sword
                 leaves each bag individually plausible. data/ holds
                 the ABILITIES, SKILLS, ITEMS and MONSTERS tables (spec 062):
                 content is data, and an entity only ever stores an id.
                 `npm run server`, and `npm run server:bots` for load.
src/render/iso3d/world/ the Play tab (spec 063, spec 057's stage 3): the isometric
                 world drawn from GameClient.view() and nothing else. interpolate.ts
                 (20Hz deltas to a pose per frame), intent.ts, target.ts (the
                 right-click attack order, spec 072), cast.ts, appearance.ts,
                 projectile-shape.ts and trail.ts (an arrow's and a shuriken's
                 silhouettes, and the streak a thrown star leaves, spec 087)
                 unit-catalog.ts, unit-driver.ts and unit-lod.ts (spec 111: which
                 monsters are drawn from an authored unit, the pure function from
                 replicated facts to machine commands -- handed a snapshot and not
                 the GameClient, so animation has nothing it *could* call -- and
                 how often a body's pose is applied; the machine itself is
                 never throttled, because its events are authored on frame indices.
                 The LOD measures how big a body is *drawn*, in pixels of the
                 virtual raster, and never how far the camera is from it (spec
                 118): this camera is orthographic and parks 6000 units back for
                 near/far clearance, so a distance threshold put every unit in
                 the game -- the player included -- on a quarter-rate pose, and
                 the Studio preview looked perfect throughout because it never
                 consults the LOD at all. The driver also slews the blend
                 parameter rather than assigning it (spec 119), because a blend
                 tree is a pure function of its parameter and the sim has no
                 acceleration: a step from run to nothing swapped the pose in one
                 tick under a cross-fade that never saw it, which is why setting
                 off blended and stopping cut)
                 pixel-font.ts (a 5x7 glyph table, since nothing may be
                 fetched -- the digits since spec 065 and the capitals since
                 143, when the refusals started drawing words), error-log.ts
                 (the stack of refusals in the bottom-right corner, spec 143:
                 lifetime, coalescing, order and fade, pure, with hud.ts holding
                 nothing but the elements. The line before it was one shared
                 string at the top of the frame that a second refusal
                 overwrote, decayed by counting 120 *frames* -- two seconds at
                 60fps and five-sixths of one at 144. A message now lives in
                 milliseconds; the column's bottom is pinned so it grows
                 upward, newest at the bottom; and an identical text coalesces
                 with a count, because auto-attack refuses once a tick and
                 sixty lines a second is not a warning.
                 `npx tsx scripts/preview-refusals.ts` is the half no headless
                 test can see: it spends a real cast in a real browser, reads
                 the lines back off `data-text`, and measures them against the
                 window buttons -- which is how the first version was caught
                 drawing three lines of red across the Bag and Gear buttons,
                 having cleared one button's height where they are a column of
                 three)
                 and touch.ts (taps and two-finger gestures, specs 093/140 --
                 bounded by distance and never by time, because an event's stamp
                 measures the renderer's load rather than the finger; and two
                 fingers report what they did to their separation AND to their
                 midpoint in one breath, because a real gesture is a spread and a
                 slide at once and reporting one of them makes the other
                 unreachable -- a pure spread arrives with `dragX` at zero, a
                 pure swipe with `ratio` at one, and the swipe turns the camera),
                 hud-layout.ts and
                 icons.ts (how big the HUD is on a finger and what the weapon
                 switch and the window buttons draw, specs 094/140 -- the sizes
                 are a sum, so "eight buttons still fit across a phone, clear of
                 both corner rows" fails in Node rather than in a screenshot),
                 health-bar.ts (the white chunk a blow leaves on a floating bar,
                 spec 145: the fill is replicated health and is never delayed,
                 and the ground it gave up is held behind it for a beat so the
                 size of the blow is readable off the bar rather than only off
                 the number floating away from it. The decision in it is a
                 *throttle* -- the first blow of a burst opens the window and
                 every blow inside it grows the same chunk -- and it is a
                 leading-edge throttle rather than a debounce on purpose, since
                 under a debounce a body taking sustained fire holds a growing
                 white chunk that never resolves, which is the state that reads
                 as a bug. Time is an argument, and the argument is the *drawn*
                 tick the bodies under it are interpolated by, not a second
                 clock. Since spec 146 the same file also answers the *instant*
                 of contact -- a decaying oscillation that knocks the bar off its
                 anchor -- and the two rules are opposites on purpose: a chunk is
                 a measurement and merges across a burst, a kick is a contact and
                 every blow restarts it. `npx tsx scripts/probe-health-flash.ts`
                 is the half that only exists in a browser: it picks a fight on
                 the shipped page and samples both bands' widths off the real DOM
                 every frame, because a white band stacked behind an opaque track
                 passes every test in Node and draws nothing. The thing worth
                 knowing about it is that this environment paints about five
                 frames a second under software GL -- at any viewport size, since
                 it is the scene update that costs -- so a 200ms kick gets one
                 sample and reads as no kick at all. It runs the *page's* clock
                 slowed eightfold instead, by wrapping the animation frame the
                 renderer takes its elapsed time from: the same ticks and the
                 same events, spread over enough drawn frames to see. That also
                 got the picture, which two freezes could not -- pausing the
                 debugger halts the renderer and the capture never returns, and
                 pausing virtual time works but leaves the clock racing
                 afterwards, which silently starved the next measurement of
                 frames),
                 inventory-model.ts, character-model.ts and shop-model.ts (what
                 the bag, the sheet and the shop are handed -- `src/ui/` may not
                 reach the sim, so the replicated facts and the content tables
                 are turned into plain rows out here, and whether a button is
                 live is answered by running the *server's own* rule against the
                 client's copy so a greyed-out button and a refusal cannot
                 disagree), and ui-routing.ts and ui-screens.ts (the interface's
                 mount, spec 131: who hears an input, and the four screens, their
                 windows and what each is handed per frame). ui-screens.ts is
                 pure for one specific reason -- mounting an interface over the
                 sim gets the same assertion animation got, the same fight twice
                 with the screens driven and without, identical authoritative
                 state, and that is impossible if running it needs a canvas
                 (`mount-presentation.test.ts`),
                 and monster-look.ts (what a monster's rig is *built* with, spec
                 152, beside the appearance.ts that says which rig draws it:
                 body shape, colours and the tuning overrides. Every monster was
                 `new MechRig(typeId)` -- the defaults at size 1 in
                 `enemyColor`'s fallback, because that function still switches on
                 three sim type names no row in MONSTERS has used since spec 062
                 -- so four enemies shared one silhouette and there was nowhere
                 to say an enemy is small. The rule it holds is that **a sim
                 number has one home and it is not here**: `MechRigTuning` is the
                 rig's tuning minus `moveSpeed` and `turnRate`, the two fields
                 the rig itself has never read and that exist only because the
                 movement sandbox needed somewhere to hang its overrides, so a
                 look that could name them would be a second place to write down
                 how fast a monster moves. Pure, which is also why the merge onto
                 `defaultMechTuning()` happens in scene.ts rather than here:
                 nothing in this directory's pure half imports the rig module)
                 are pure and tested headlessly; scene.ts, shot.ts, hud.ts,
                 ui-layer.ts (the second canvas, the scale and one coordinate
                 conversion -- the whole impure half of the mount) and
                 view.ts are the three.js/DOM half. `npx tsx scripts/preview-world.ts`
                 photographs the real page into .claude/screenshots/world-*.png,
                 and `npx tsx scripts/preview-shots.ts` flies the real ShotRig
                 through a real arc into .claude/screenshots/shots.png.
                 `npx tsx scripts/preview-units.ts` puts authored units in the
                 real arena (`?units=grazer:mannequin`) and asserts a skinned
                 body with 25 bones is being posed -- the half of spec 111 that
                 only exists once a browser has fetched a .glb and skinned it.
                 `npx tsx scripts/preview-monsters.ts` is the contact sheet of
                 the roster (spec 152), built through the same look table and the
                 same MechRig scene.ts uses and rasterised in software. Two
                 things it does that preview-critters.ts does not, both for one
                 reason: **one world-space window for every cell**, because
                 auto-framing each subject on its own extent hides the only thing
                 a row of monsters is being asked -- whether the small one is
                 small -- and the collider drawn as a ring, since the drawn size
                 and the collider are authored in different files and nothing
                 forces them to agree.
                 `presentation-only.test.ts` beside them is the brief's
                 assertion: the same seed and inputs twice, once with the
                 animation layer driven and once without, and the authoritative
                 state must be identical.
                 `npx tsx scripts/preview-arcs.ts` plots what a shot's path
                 actually is, flown through the real step: one weapon at a
                 spread of distances, and the same shot over flat and broken
                 ground overlaid (spec 089).
                 `npx tsx scripts/preview-touch.ts` drives the built page in a
                 phone-shaped landscape viewport with real touch events over CDP
                 (spec 093), since the tap and the pinch only exist once a
                 browser is delivering pointer events. `fullscreen.ts` beside it
                 is the tab bar's fullscreen button -- DOM only, and absent on
                 anything that cannot go fullscreen or is not a coarse pointer.
src/render/iso3d/unit-rig.ts  a loaded authored unit, posed by a machine (spec
                 111). The three.js half of "the tool and the game read the same
                 files": load the .glb, strip root motion and say so, write a
                 pose. The root bone is found in the *loaded rig*, never taken
                 from a document -- three sanitises `mixamorig:Hips` to
                 `mixamorigHips` in its track names, so a name read from the
                 skeleton JSON matches nothing, strips nothing, and looks exactly
                 like a clean import. The reference unit could never catch that:
                 glb.ts writes rotation channels only, so its clips have no
                 translation to strip. `mixer.update(0)` always -- every action's time comes from
                 an integer tick, so the pose is a pure function of a tick count
                 and an event lands on the same frame at 30fps as at 144.
                 Since spec 118 there is a second rule beside the first: the
                 strip asks which *node* a track sits on, and a generated rig
                 has no reason to obey that convention -- the pig's auto-rig
                 baked the whole stride onto `Hip`, one node below the root,
                 where nothing was looking. So travel is also *measured*, on any
                 bone, and only the component along it is taken out; the bob and
                 the crouch are perpendicular to it and survive. The threshold is
                 a tenth of the rig's reach, the same rule
                 `npm run validate:units` applies offline to the same files.
                 `npx tsx scripts/probe-travel.ts` is the check that matters --
                 the real unit through the real loader, asking where the hips go
                 in world units. It fails a looping clip that ends somewhere else
                 AND one whose hips never move, since a correction that ate the
                 pose scores a perfect zero on the first test alone. No GL
                 context: nothing in it rasterises.
src/render/iso3d/turn-swing.ts  what a pivot does to a body's extremities (spec
                 139). The scene turns a body by yawing it about the point the
                 server put it on, so anything the pose holds away from that
                 origin travels on a circle -- and how violent a turn looks is a
                 product of two numbers that live nowhere near each other, the
                 turn rate in `CHARACTERS` and how far a pose reaches. Nothing
                 could see both at once, which is how a rate tuned for the cow
                 rig survived onto a pig whose run clip leans 36 degrees and puts
                 the snout 28 units in front of a 16-unit collider: every number
                 was individually defensible and their product was written down
                 nowhere. This module is that arithmetic, pure and tested; the
                 budget is a *ratio* against the body's own move speed, because a
                 snout that crosses the screen faster than the animal can run
                 does not read as a turn. `npx tsx scripts/probe-turn-swing.ts`
                 measures a real unit against it -- CPU-skinned vertex by vertex,
                 since a snout is geometry and no bone sits in it, and since
                 `Box3.setFromObject` on a `SkinnedMesh` reports this pig as 17.9
                 units tall when it is really 55.6. `npx tsx
                 scripts/preview-turnaround.ts` is the picture: the reversal
                 *stepped* through the real `turnToward` and rasterised in
                 software, because this environment paints the real page at about
                 a frame a second and a screencast of a 333ms turn returns one
                 frame captioned "the turn is over". The window is fixed in world
                 space and the collider ring is drawn, both for the same reason --
                 auto-framing each cell would hide the only thing being shown.
                 Since spec 142 it draws two rows, the rule and what is actually
                 drawn, and writes turnaround-rate.png beside them -- angular rate
                 against time, where the raw rule is a rectangle and the ease is a
                 trapezoid. Everything else here draws a heading, and a heading was
                 never what was wrong.
src/render/iso3d/turn-ease.ts  the drawn turn's beginning and end (spec 142).
                 `turnToward` is a step function on angular velocity: nothing, then
                 the full rate for every tick, then nothing. Spec 139 gated the
                 *peak* of the sweep that produces and this is the other half --
                 the onset, which is what reads as a whip-crack. The sim's rule does
                 not move, because it is also the client's prediction and easing it
                 would change when a cast commits; the ease goes on the drawn yaw at
                 the one line in `scene.ts` that computes it, with the standing
                 `interpolate.ts` has ("presentation, not state") and nothing but a
                 transform reading it. A trapezoidal profile with a braking curve --
                 never carry more speed than the remaining angle can absorb -- so
                 the ease-out is automatic, the landing exact, and there is no
                 easing curve to pick. The thing worth knowing: **the acceleration
                 is not a tuning constant.** It is fixed by how far the drawn
                 heading may trail the authoritative one, and the sim already
                 answered that -- `COMMIT_ALIGN_TICKS`, where three ticks of a
                 body's own turn "still counts as already facing it". Bounding the
                 visual lag by the sim's own tolerance gives `a = 10R` at 60Hz, and
                 makes the ramp `2 * COMMIT_ALIGN_TICKS / tickRate` = 100ms for
                 every body however fast it turns; nobody typed 100ms. It also
                 means a turn under twice the bound never reaches the full rate at
                 all, so the *small* turns -- a 10-degree correction peaks at 45% of
                 the rate, a 20-degree one at 64% -- are the ones it changes most,
                 which is right, because they were the ones spending every one of
                 their three ticks at a rate nothing about a body's mass justified.
                 What it does not do is lower the peak on a large turn: a reversal
                 still passes through the full rate, 139's gate and its 1.72x stand,
                 and this bounds the jerk rather than the peak. One rule was learned
                 by writing the wrong one first and having a test catch it: a jump is
                 told from a fast turn by how far the *authoritative heading itself*
                 moved, never by how far behind the drawn one is. The cap is only an
                 estimate -- a monster's rate can be raised by a modifier and a
                 remote player's is not replicated -- so a body turning faster than
                 believed builds an error no believed turn could produce, and the
                 error-based rule snapped mid-turn every single time it turned.
                 Judged per *tick* rather than per frame, too, or at 240fps the two
                 frames in three where the heading holds still make the third look
                 like a teleport. `world/turn-limits.ts` is where a body's rate comes
                 from: the wire for our own, the monster table for a monster, the
                 fastest base in `CHARACTERS` for a remote player, and nothing at all
                 for a projectile, whose facing is its path.
src/render/iso3d/retro.ts, retro-pass.ts  the retro filter (specs 038/102/138):
                 the scene drawn into a low-resolution buffer, then painted over
                 the canvas through a shader that grades it, quantizes every
                 channel to a handful of steps -- or onto a named palette -- and
                 dithers the band edges with a Bayer matrix. retro.ts is the
                 arithmetic, pure and tested headlessly, and the shader beside it
                 computes the same expression per channel.
                 Since spec 138 the pass takes a set of *objects* whose pixels
                 skip the quantize, and `WorldScene` names every player: the
                 pixel grid, the grade and the distance ink say where a body is
                 and an exempt body keeps all three, while the dither and the
                 quantize say what it is made of, so it keeps its colours. The
                 mask is rendered at the scene buffer's own resolution into a
                 target *sharing its depth attachment*, which is what makes it
                 one small draw rather than a second frame. Two rules follow:
                 only the owner may dispose that texture, and the mask pass
                 clears colour ONLY, since the depth it would clear is what
                 keeps the mask to pixels the body actually won. That depth test
                 is insurance rather than something the game exercises -- at the
                 default 27-degree camera nothing in the arena was ever observed
                 drawing in front of the player, and there is no fade-the-
                 occluder system here -- but "nothing occludes the player" is a
                 fact about today's map and props, not a rule anything enforces,
                 and a maskless-depth version would paint an unquantized
                 player-shaped hole through whatever stood in front.
                 The pass has no idea what a player is and must not learn --
                 `setExempt` takes objects because `WorldScene` is the only thing
                 that knows, which is also why every other caller (the probes,
                 the Studio preview, the wind rig) pays nothing.
                 `npx tsx scripts/probe-exempt.ts` drives the real Play tab with
                 a palette set, so "which pixels escaped the quantize" is an
                 equality test rather than a threshold, and reports the largest
                 *connected* run of them -- a mask has to be a body, so a count
                 is not enough. It measures each frame against the palette rather
                 than differencing two, because the world is live. It cannot
                 check the depth test, and deliberately does not try: nothing in
                 this arena draws in front of the player, so a broken depth test
                 renders the identical silhouette, and across 96 frames of
                 walking the blob never split and never lost a third of its area
                 -- that is the gait, not an occluder. `runExempt` in
                 shading-probe.ts settles it by building a wall instead of hoping
                 to walk behind one, and measures the *wall*, because a leaking
                 mask marks a pixel and the colour under it belongs to whatever
                 the scene drew there.
src/render/iso3d/view-controls.ts, menu-group.ts, settings-menu.ts  the Play
                 tab's settings (specs 033/034/107): six buttons in the top-right
                 corner -- view, day and night, player lights, retro filter, hike
                 look and the weather -- each with a popover of its own and its
                 own Reset. menu-group.ts is the rule that only one is open at a
                 time, and is pure and tested headlessly because it is a state
                 machine rather than a document; settings-menu.ts is the button,
                 the popover and the heading the panels share. The widgets
                 themselves are the state: nothing is persisted and every session
                 opens at defaults. None of them is built on a phone (spec 140):
                 they are tuning panels twenty rows deep, and the seven of them
                 pile into the corner of an 844x390 frame. ViewControls is still
                 *constructed* there -- the camera reads its sliders and `orbitBy`
                 writes them -- so the angle and the zoom span are also published
                 as `data-camera-orbit` and `data-camera-zoom`, because both
                 probes used to read them off inputs that a phone has not got.
src/render/iso3d/wind.ts, shore-sdf.ts  the weather (spec 074): one wind vector
                 read by the tree sway, the water and the streak layer over the
                 ground, plus the shore distance transform the water's bands step
                 on. Pure and tested headlessly -- the GLSL lives here as strings
                 with a TypeScript transcription beside it, because a shader
                 expression nobody can execute is where a typo lives forever.
                 sway.ts, water-material.ts, terrain-streak.ts and
                 wind-uniforms.ts are the three.js half -- the last of those owns
                 the uniform objects every weather material shares by reference,
                 and weather-controls.ts (spec 075, one of the six buttons in the
                 Play tab's corner) writes straight into them rather than being
                 polled.
                 `wind-probe.ts` plus
                 `src/render/wind-probe.html` are a dev-server-only measuring rig
                 (never in a build) driven by `npx tsx scripts/preview-wind.ts`,
                 which photographs the frame and reports the acceptance numbers.
src/render/iso3d/hike.ts, shading.ts, hike-buffers.ts  the stylized look (specs
                 097-106): hike.ts is the one settings object every step of the arc
                 is switched from -- HIKE_OFF is the frame before the arc started
                 and HIKE_DEFAULTS is what the tab opens at, which of the ten
                 steps is smooth normals and the distance ink -- plus the sRGB
                 transfer the passes mirror; shading.ts welds vertex normals across a crease
                 angle, rotates one to follow the wind's bend, and packs one
                 octahedrally into two bytes. Both pure and tested headlessly.
                 edges.ts finds outlines in those buffers: the depth term measures
                 deviation from the plane each neighbour lies in rather than a raw
                 difference, because a hillside at a glancing angle changes depth
                 fast with no edge present, and no single threshold survives that.
                 hike-buffers.ts and hike-edges.ts are the three.js halves: a second
                 geometry pass writing depth and view-space normals at the virtual
                 resolution, the blit that draws one of them on its own -- the only
                 way to see a depth texture at all, since a depth attachment cannot
                 be read back -- and the Roberts cross over both.
                 `npx tsx scripts/probe-shading.ts` checks all of it offscreen;
                 `npx tsx scripts/preview-outlines.ts` throws the switch in the
                 real page, because the outline pass once shipped with a correct
                 mask and a pass that cleared the canvas before blending it, and
                 every offscreen measurement was right while the screen was black.
                 `shading-probe.ts` plus `src/render/shading-probe.html` are a
                 dev-server-only rig (never in a build) driven by `npx tsx
                 scripts/probe-shading.ts`, which is the only thing here that can
                 tell whether a shader actually compiled -- it asserts on pixels
                 read out of the drawing buffer, because three.js logs a failed
                 compile and carries on, and because preview-trees.ts rasterises
                 in software and never makes a GL context at all.
src/render/iso3d/lobe.ts  the lobed canopy tree's shape (spec 077): the union of
                 circles a canopy slab's outline is, where the slabs sit, and the
                 trunk's taper to a single vertex. Pure and tested headlessly --
                 the silhouette is the whole species, so it is checked in Node.
                 `props.ts` turns it into buffers; `npx tsx scripts/preview-trees.ts`
                 photographs every tree the world grows to
                 .claude/screenshots/trees.png.
src/render/iso3d/weapon-rig.ts, unit-rig.ts's attach()  a weapon in a hand (spec
                 140). Three nodes, because three transforms answer to three
                 owners: the socket's pivot belongs to the skeleton, the align
                 belongs to the weapon document, and the mesh's own origin
                 belongs to whoever exported it. Parented, never copied -- a held
                 thing rides the pose through three's own graph, so there is no
                 per-frame code for it at all; reading the bone's world matrix
                 each frame would put the weapon on the renderer's clock while
                 the pose is on the machine's, and spec 118 throttles how often
                 that pose is applied. The pivot also undoes the host's import
                 scale, so `lengthWorld` is in world units and a sword is one
                 size whatever holds it. Both of the pig's socket calibrations
                 were found by sweeping candidates through the offscreen
                 rasteriser rather than derived: `npx tsx scripts/preview-weapon.ts`
                 photographs the real mesh at the real pose, and `SWEEP=` puts
                 four candidate rotations side by side in one strip.
src/render/iso3d/movement.ts, debug-view.ts  the two tuning sandboxes (specs
                 032/033/035/046, back since 066): one unit, no game, so a gait,
                 a cloth solve or a turn rate can be watched in isolation.
                 Since spec 140 the movement sandbox also drives an *authored*
                 unit -- one chip per entry in the manifest, so `authored:pig_a_pose_full`
                 is the generated body posed by its state machine and `pig` is
                 still the procedural critter. sandbox-attack.ts is a rehearsal
                 of a cast and says so: not a sim, no server sees it, and what it
                 reproduces exactly is the one rule that makes an animation
                 legible -- the timing is authoritative and the clip is rescaled
                 to fit it, via `timeScaleFor`. Drag the wind-up to 900ms and the
                 swing slows to land on it. sandbox-dummy.ts is something to hit,
                 flinching on the tick the blow lands, because "the blade looks
                 like it arrives about now" is not a claim anybody can make about
                 a number. Both pure and tested headlessly;
                 `npx tsx scripts/preview-sandbox-swing.ts` drives the real page. The
                 rig debugger adds a top+side split, slow-mo/single-step and the
                 joint and cloth overlays. Both drive sandbox-mover.ts -- a pure,
                 headlessly tested position/heading/move-order driver, NOT a
                 second sim -- through sandbox-input.ts, and share buildPanel().
scripts/         standalone scripts (e.g. the balance harness), run via tsx
.claude/         harness config: agents/ (the delegation policy, see below),
                 hooks/session-start.sh (branch-base check + dependency install),
                 settings.json, notes/ and screenshots/
```

## Delegation

The delegation policy lives in `.claude/agents/`, not here: each agent's
`description` decides when it gets reached for and its `model:` line picks the
tier, so the harness acts on it instead of hoping this file gets re-read.

| Agent | Reach for it when |
|---|---|
| `test-runner` | running `npm test`, `typecheck`, `lint`, `build` or `balance` — anything whose full output would otherwise land in context |
| `code-explorer` | tracing how an existing system works, or any question answered by reading across several files |
| `implementer` | the design is already settled and the work is "make it so" inside one module |
| `architect` | the change crosses sim/cards/game/render/terrain, touches the deterministic core, or needs a `specs/` entry written first |

Main context keeps the judgement calls: design decisions, cross-system changes,
and bugs whose cause is not yet located. Batch independent agent calls into a
single message so they run concurrently.

Where the output goes matters as much as who does the work:

- `.claude/notes/<area>.md` — cached architecture summaries. Read one before
  sending an agent to re-derive it. Tracked.
- `.claude/screenshots/` — visual checks (`npx tsx scripts/preview-critters.ts`
  writes here). Tracked, so they can be reviewed on the branch; pull an image
  into context only when something has actually gone wrong.
- `.claude/scratch/<task>.md` — disposable sifting and long reasoning.
  Gitignored, and not part of the record.
