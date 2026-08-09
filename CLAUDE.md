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
schemas/         JSON Schema (draft-07) for the three unit documents, committed
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
src/units/       the unit authoring format and its validator (spec 107): the three
                 JSON documents a unit is made of -- skeleton.json (one rig family,
                 mixamo bone contract, canonical height), cliplib.json (clips for a
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
src/render/      the client: a tab shell over the play view, the two tuning
                 sandboxes and the map editor
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
                 transport-agnostic session the renderer draws from. data/ holds
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
                 how often a distant body's pose is applied; the machine itself is
                 never throttled, because its events are authored on frame indices)
                 pixel-font.ts (a 5x7 glyph table, since nothing may be fetched)
                 and touch.ts (taps and pinches, spec 093 -- bounded by distance
                 and never by time, because an event's stamp measures the
                 renderer's load rather than the finger), hud-layout.ts and
                 icons.ts (how big the HUD is on a finger and what the weapon
                 switch draws, spec 094 -- the sizes are a sum, so "eight buttons
                 still fit across a phone" fails in Node rather than in a
                 screenshot)
                 are pure and tested headlessly; scene.ts, shot.ts, hud.ts and
                 view.ts are the three.js/DOM half. `npx tsx scripts/preview-world.ts`
                 photographs the real page into .claude/screenshots/world-*.png,
                 and `npx tsx scripts/preview-shots.ts` flies the real ShotRig
                 through a real arc into .claude/screenshots/shots.png.
                 `npx tsx scripts/preview-units.ts` puts authored units in the
                 real arena (`?units=grazer:mannequin`) and asserts a skinned
                 body with 25 bones is being posed -- the half of spec 111 that
                 only exists once a browser has fetched a .glb and skinned it.
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
src/render/iso3d/view-controls.ts, menu-group.ts, settings-menu.ts  the Play
                 tab's settings (specs 033/034/107): six buttons in the top-right
                 corner -- view, day and night, player lights, retro filter, hike
                 look and the weather -- each with a popover of its own and its
                 own Reset. menu-group.ts is the rule that only one is open at a
                 time, and is pure and tested headlessly because it is a state
                 machine rather than a document; settings-menu.ts is the button,
                 the popover and the heading the panels share. The widgets
                 themselves are the state: nothing is persisted and every session
                 opens at defaults.
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
src/render/iso3d/movement.ts, debug-view.ts  the two tuning sandboxes (specs
                 032/033/035/046, back since 066): one unit, no game, so a gait,
                 a cloth solve or a turn rate can be watched in isolation. The
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
