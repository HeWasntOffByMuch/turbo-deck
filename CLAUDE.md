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
| `npm run balance` | Fight the twelve build presets through the real sim and print what each one actually did (spec 147) |
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
docs/            durable direction that outlives one spec. vfx-plan.md, ui/, and
                 reward-philosophy.md (spec 158) -- the rules future loot,
                 progression, encounter and feedback work is decided against:
                 world-embedded rewards over reward cards, contrast between
                 quiet and rare, and the existing combat vocabulary reused
                 rather than re-invented. Labelled throughout as **Current
                 rule** / **Implemented** / **Future direction** / **Not yet
                 implemented**, because the risk with a document like that is a
                 direction reading as a backlog item and getting built as a side
                 effect of something else.
schemas/         JSON Schema (draft-07) for the three unit documents and the weapon
                 document (spec 140), committed
                 and validated against in CI. additionalProperties is false
                 throughout, so a typo'd key in a hand-edited file is an error with
                 a pointer at it rather than a field that silently does nothing.
maps/            the world, as a map document (spec 072). arena.json is what the
                 server loads at boot and streams to clients, what the Play tab
                 imports, and -- since spec 176 -- what the Map editor tab opens;
                 regenerate it with `npx tsx scripts/bake-map.ts`, or edit it in
                 the editor -- which since spec 177 writes this file directly,
                 through a `POST /api/map` the dev server answers and a build
                 has not got, so "save over it" stopped being four steps a
                 person does by hand and a download nobody could tell had
                 landed. That last clause was documented
                 here for a hundred specs and was not true: the editor baked its
                 own world from `viewSeed()`, which falls back to the clock, so
                 it opened a different world every session and nothing placed in
                 it -- a marker least of all -- had anywhere to arrive. Nobody
                 could see it while the shipped map *was* the generated world
                 (`bake-map.ts` defaults to seed 1, and the arena was seed 1 with
                 no parts); spec 165 grew the map and the coincidence went with
                 it. Checked in so the world reviews as a diff.
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
                 against the body beside it. A weapon also names its own
                 **socket**, which is how the recurve bow (spec 165) goes in the
                 left hand while both swords go in the right -- an inventory slot
                 says what a thing is worn in, and which hand a model is held in
                 is a fact about the model. grip.ts is the arithmetic and states
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
                 posture.ts is the third thing beside those two (spec 163): a
                 stated edit to the posture a *bought* clip is played in, one
                 angle per bone and constant over the clip, so the stride and
                 the timing and the bob survive by construction and only the
                 body's carriage moves. It exists because `run` came out of the
                 retarget with the chest 30 degrees forward of standing and the
                 gaze 54 below the horizon, against an idle and a walk at -18 --
                 a character whose face is only visible while it is standing
                 still. Three rules. **Every correction turns about one shared
                 world axis**, the body's pitch axis, which is what makes a
                 chain of them compose by *adding the degrees* and lets each be
                 computed against the uncorrected pose and still be exact once
                 its ancestors have moved -- the same commuting-rotations
                 argument the pig's hip counter-turn rests on. **The axis comes
                 from the parent's animated frame, never its bind one**, which
                 is the one thing `pose.ts`'s `turnQuat` cannot give: at bind
                 the two agree and 30 degrees into a lean they do not, and the
                 bind-frame version arrives as a pitch mixed with a roll.
                 And **the applied table is recorded in the file** it was
                 applied to, in `animations[0].extras.posture`, because there is
                 no source document behind a bought clip and a correction
                 measured against its own last output bends the body further
                 every time it is regenerated. `npx tsx
                 scripts/straighten-run.ts --write` is the edit and prints the
                 two numbers it moved; `npx tsx scripts/preview-run-posture.ts`
                 is the picture, and it reads that same record so it draws the
                 retarget against the correction whichever state the bytes are
                 in -- without that it silently applied the posture twice the
                 moment the file was written.
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
                 pig-shot.ts is the bow beside it (spec 164): seven poses over
                 1150ms with the arrow leaving at 800, which is `ranged.shot`'s
                 wind-up, so the same rule holds -- the frame the picture shows
                 the string let go and the frame the arrow exists are the same
                 frame. It exists because the Hunting Bow is a level-1 weapon
                 and the pig answered every shot with the sword chop. Three
                 things in it invert the swing on purpose. **The release is a
                 velocity discontinuity**: a raise must be one movement, but a
                 draw is pulled, held still while it is aimed, and let go
                 instantly, so the anchor is arrived at and left at opposite
                 speeds -- in a swing that is a dead beat and a whip, in a shot
                 it is the aim and the loose. **The body does not unwind**,
                 because what sends an arrow is back tension rather than
                 rotation; only the string hand travels. And **the stance never
                 moves** -- every key holds the same hips and the sword's own
                 guard legs, shared as an object rather than copied, so a foot
                 cannot slide by construction and none of `plant-foot.ts` is
                 needed. `npx tsx scripts/aim-bow.ts` is the solver and its
                 improvement over aim-blade.ts is that **the elbow is derived
                 rather than wished for**: an author states the hand and a
                 *roll* -- how far round the shoulder-to-hand axis the elbow
                 sits -- and the only elbow consistent with the linkage is
                 computed, so a pose that does not close is impossible to write
                 rather than visible later. What it prints is the fold, because
                 the fold is what decides whether an arm reads: on this rig a
                 hand closer than 0.156 to its own shoulder is past 120 degrees,
                 which is why the string hand goes outboard round the ribs
                 instead of straight to the anchor, and why the anchor is behind
                 the ear rather than at the jaw.
                 `npx tsx scripts/make-pig-shot.ts` writes the committed bytes
                 and `npx tsx scripts/preview-shot.ts` photographs them, drawing
                 a **string** between the two hands rather than a bow: there is
                 no bow mesh, a proxy invented in a preview is a prop the game
                 does not have, and what the bar is for is measurement -- a draw
                 *is* the distance the hands get apart, and it prints that
                 distance per frame beside the picture because a thumbnail of a
                 pig cannot settle whether the string hand went back.
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
                 Since spec 166 it also has a `cancelAction`, which is the
                 counterpart to the trigger that started an attack: a one-shot
                 otherwise runs to the end of its clip whatever the sim does, so
                 a wind-up the player *withdrew* from -- the decision this whole
                 game is built on -- was still drawn as a completed blow, impact
                 event and all, a quarter of a second after being refunded. It
                 cross-fades rather than cutting, it is called *before* the tick
                 is stepped so the events left in the clip never fire, and it
                 refuses to leave a `locking` state, because not being
                 interruptible is that category's whole reason to exist.
                 Since spec 168 there is a `revive` beside it, for the same
                 reason in the other direction: a death state is `terminal` and
                 a terminal state has **no exit**, which is the right rule for a
                 corpse and is exactly why a body cannot get up on its own. A
                 respawn keeps the entity -- the server heals and moves the body
                 it already has, so the renderer keeps the same machine -- so
                 `dead` going back to false reached a machine incapable of
                 acting on it, and a respawned player ran, swung and shot around
                 the arena drawn as the last frame of the clip they fell in.
                 Getting up is therefore a *command* rather than a condition,
                 the way cancelling is: a transition out of a terminal state is
                 the thing that category exists to forbid. It comes back to the
                 entry state and lets the ordinary transitions take it from
                 there, and it **cuts rather than fading**, because every other
                 part of a respawn is a cut -- the position arrives as a
                 `Teleport` correction, which spec 067 snaps -- and a pose easing
                 up off the floor at the spawn point draws a body getting up
                 from a fall that happened somewhere else. Held by `driveUnit`
                 as a *level* on every living tick rather than as an edge off
                 `previous`, since a dropped frame would otherwise cost a whole
                 session.
                 Two rules about the *fade* live there too (spec 167). Going
                 back to the state a fade is in the middle of leaving is a
                 **reversal** and keeps that state as the thing it fades from,
                 rather than the half-arrived one -- otherwise a body three
                 quarters through drawing a bow is drawn entirely standing still
                 for one frame, which is what a jerk between two shots turned
                 out to be: 47.5 degrees of bone movement in one tick, against
                 19.3 for the loose the draw is *meant* to snap through. It only
                 happens where a clip is exactly as long as its cast, because
                 then the return to idle and the next attack land on top of each
                 other. And `poses` names **each clip once**, because a reversal
                 is how two playheads on one clip arise and `applyPoses` keys its
                 actions by clip id, so a second sample would silently overwrite
                 the first. `npx tsx scripts/probe-shot-loop.ts` is the
                 instrument -- a real server, a real client, shooting on a loop
                 -- and it reports the pose as well as the mix, because a tidy
                 mix can still jerk if the clip time under it jumps.
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
                 Since spec 172 that vocabulary has one more word in it, and it
                 is the one the note on `placeOn` used to say did not exist:
                 letting go over the **world** puts the thing on the ground.
                 What counts as the world is a null hit test through the layer
                 stack -- the empty half of a window is not it, because
                 releasing there has always meant "keep hold of it" and turning
                 that into a discard would make the one gesture that gets rid of
                 something the easiest one to do by accident. Read on the
                 *press*, because that is the half gameplay acts on, and
                 consumed, so the button that drops an item does not also order
                 the player to walk over to where it landed. The press is also
                 the *aim*: `view.ts` reads the point being offered to the
                 interface at that instant rather than the cursor's last known
                 position, since `UiLayer.toUi` is deliberately the one
                 conversion between UI pixels and canvas ones and a stale
                 cursor would throw the item somewhere nobody clicked.
                 One more rule of the same kind, from spec 147's sheet: **a
                 hidden tab still has rectangles in it**. A tab switched away is
                 hidden and never destroyed -- that is what makes a tab keep what
                 you left in it -- so its rows keep `visible` true and keep the
                 rect they were last arranged into, and any hover that hit-tests
                 a *list of rows* gets three tabs stacked at the same
                 coordinates. Only the ancestor chain says which tab a row is in.
                 The framework's own `hitTest` is the obvious answer and is the
                 wrong one for text: `Label` is deliberately pointer transparent,
                 so a screen whose rows are bare labels goes silent under it.
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
                 Since spec 147 a window is *resizable* and its placement
                 outlives the tab: core/layout-store.ts is a third versioned
                 document over the same injected `StorageLike`, holding where
                 every window is, how big, whether it was open and in what
                 order. Both halves had been finished since spec 124 and neither
                 was ever plugged in -- every window was registered with a bare
                 title, and nothing outside its own test imported the store, so
                 a complete set of green tests sat beside a game that opened
                 every window in its default place every session. Three rules
                 came out of connecting them. **The grip has to beat its own
                 content to the hit test**: it is 7px square in a corner whose
                 content box is inset by 4, and the router sends every drag to
                 whichever widget took the press, so what was left as the entire
                 resize handle was a 4-pixel band and the scroll view owned the
                 rest. **The restore waits for a viewport that is not the 1x1
                 placeholder** -- `UiLayer` measures its frame before the tab is
                 laid out, and `applyLayout` correctly re-clamps against
                 whatever it is handed, so restoring against 1x1 stacks every
                 window at the origin at its minimum size and writes that back:
                 the saved arrangement destroyed by the act of restoring it.
                 **A window the server opens never comes back open**, because
                 the shop and the trade table are not choices the player made
                 and a restored trade window has no trade in it. The write is a
                 trailing debounce on a signature of the placements, so a drag
                 costs one `setItem` when it stops rather than one per frame
                 while it moves, and `saveLayout` cannot throw -- it is called
                 from inside the frame, where a browser refusing the write would
                 otherwise take the render loop rather than one preference.
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
                 from a loaded map document, never from the world generator --
                 and since spec 176 from *the* document, `maps/arena.json`, the
                 one the server boots from. map-source.ts is where that is
                 decided and the only place it may be: it holds the same `?raw`
                 module the Play tab plays, and `openEditorMap` answers both
                 halves of the question at once -- which map, and what a save of
                 it comes back called, since "save over it" is a copy when the
                 download is named `arena.json` and a rename somebody has to get
                 right when it is named after a seed. A generated world stays
                 behind `?map=generated`, because looking at what a seed produces
                 before `bake-map.ts` commits it is a real thing to want; what it
                 is not is the default, since a default that is *nearly* the
                 game's world is worse than one that plainly is not. `?seed=`
                 deliberately does not switch sources -- it is session-wide and
                 answers which generated world rather than whether -- so a
                 harness pinning a seed for the Play tab cannot take the editor
                 off the map as a side effect. `EditorScene` now *requires* the
                 document it edits: the fallback to the generator was one line,
                 and one line is what this cost.
                 map-write.ts is the other end of the same loop (spec 177): a
                 download is not a saved map, it is the first of four steps with
                 nothing confirming any of them, and the autosave saying
                 "autosaved" while the file on disk was untouched is the same
                 lie from the other side. The browser half returns four outcomes
                 rather than ok/failed, because "there is no dev server here"
                 (a built page -- use the download), "the server said no", and
                 "nothing answered" have three different fixes and one message
                 for all three names none of them. `scripts/dev-map-write.ts` is
                 the disk half, `apply: 'serve'` so a build has no such endpoint,
                 with every rule about *which* path may be written pure and
                 tested -- a bare `.json` name resolved under `maps/` and checked
                 by its resolved parent, since a prefix test passes
                 `maps-elsewhere/`. The body goes through `parseMap` before
                 anything is written and the write is a rename, so the map the
                 server boots from cannot be replaced by something that will not
                 load or by half a file. The rule that had to be measured rather
                 than reasoned: **the write must not hot-reload the page**.
                 `maps/arena.json` is a `?raw` module in the graph, so writing it
                 made Vite reload the tab -- three seconds after the click the
                 page went blank and came back on the Play tab, re-streaming 169
                 chunks, with the editor rebuilt from disk. For a write the
                 editor *made* that is backwards, since the newest copy is the
                 one in the tab; so the plugin swallows the reload for its own
                 writes only, invalidating the module without announcing it so a
                 later reload by hand still reads the new bytes.
                 tools.ts holds the one thing 176 and 177 both missed, because
                 neither was about the panel (spec 178): of the five marker
                 kinds only `spawner` has a reader anywhere, and the strip
                 presented all five identically with an always-live monster
                 dropdown under them. `spawn` and `spawner` differ by two
                 letters, `spawn` was the default, and picking a monster and
                 pressing the wrong one of the pair produces a map that saves
                 correctly, boots correctly and has an empty arena. So the
                 stored kind does not move -- it is a byte on the wire -- and
                 the *button* says `monster`, the dropdown is **disabled**
                 rather than merely present when its kind is not armed (shown
                 and live are different claims, and the layout argument for
                 showing it always still holds), a `Does` row says
                 `nothing reads it yet` for the four that are sockets with
                 nothing plugged in, and placing one reports what it made:
                 `placed spawner-2: grazer`.
                 camera.ts, brush.ts, paint.ts, scatter.ts, markers.ts, parts.ts
                 and history.ts are pure and tested headlessly; view.ts, cursor.ts and
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
                 paint.ts is the material brush (spec 179), and it is beside
                 brush.ts rather than inside it because brush.ts is what a stroke
                 does to the *height* array and every one of its four tools reads
                 and writes heights. What it exists to fix is that a material used
                 to be a consequence and never a choice: the only thing writing one
                 after the bake was `refreshMaterials`, which *derives* it, so a
                 dirt path had to be a ramp steep enough for `dirtSlope` to catch
                 and sand had to be dropped near the water. Three decisions in it.
                 **Water is not paint** and the palette is five rather than six --
                 a material says what ground is made of, `water` says where it sits
                 relative to the flood line, and painting either direction is a lie
                 the renderer draws: the quad is at `layer.waterLevel`, so water on
                 high ground is a surface buried under the terrain carrying it, and
                 sand on a lake bed is a dry hole in a lake. It is refused on the
                 *stored* material as well as on the level, because those disagree:
                 `classify` measures a sample height and the guard measures the
                 mean of four jittered corners, and only checking the level
                 repainted five cells of a lake. **The soft edge is dithered**,
                 since one material per cell forbids a blend (spec 043's hard
                 boundaries are the art direction) -- and the threshold is hashed
                 off the cell's own coordinates rather than drawn per frame, which
                 is the whole design: under a per-frame roll a rim cell at weight
                 0.1 fills in with probability 1 - 0.9^60 after a second of holding
                 the brush still, so the feathered edge survives only as long as
                 you keep moving. Hashed off the cell, holding still changes
                 nothing, painting twice is idempotent, and a boundary you go back
                 over does not creep outward -- the same shape spec 125's rock
                 erosion has. And the footprint is the distance to the **segment**
                 the cursor swept rather than a stamp per frame, which is what
                 makes a stroke a function of where the cursor went rather than of
                 the frame rate; the height brush cannot have that property,
                 because it integrates a rate over `dtSeconds` and this has no rate
                 to integrate. A repaint carries its own stroke flag in view.ts: it
                 is the first edit here that changes the document without moving
                 anything, so it owes a re-mesh and a revision and none of the nav
                 re-bake, prop rebuild or marker refresh -- walkability is ground,
                 solidity and the water line, a prop's colour comes from its own
                 part rather than from what it stands on, and a marker sits at a
                 height.
                 `npx tsx scripts/preview-parts.ts` drives the tools in a real
                 browser, since the drag and the commit live in view.ts, and
                 `npx tsx scripts/probe-map-editor.ts` is the one that asks
                 whether any of it is wired to anything: it places a spawner on
                 the shipped map and reads it back out of the *file the browser
                 downloaded*, because a marker the editor draws and does not save
                 is exactly the bug 176 turned out to be -- every rule about
                 saving a marker green in Node, beside a tab that called none of
                 them on the map anybody plays. Since 177 it runs twice -- over
                 `dist/`, where the write button must *say* there is no dev
                 server rather than look like a failed save, and over a real
                 dev server, where it has to change the file on disk. The second
                 half backs the map up and puts it back, because there is no way
                 to check that a button writes the map without writing it.
                 `npx tsx scripts/preview-paint.ts` is the same for the material
                 brush, and everything in it is measured off the **pixels**,
                 because the way this feature fails is "the store changed and the
                 ground did not". Two things in it were learned by getting them
                 wrong. Reading each pixel as whichever `TERRAIN_COLORS` entry it
                 is nearest found dirt perfectly and lost snow completely -- lit,
                 graded and quantized, near-white lands closer to `rock` than to
                 `snow` -- so it measures *change* instead, which has nothing to be
                 wrong about and is the sharper instrument anyway: a cell either
                 took the paint or it did not, which is precisely what the dithered
                 edge is made of. And the editor is not a still -- the trees sway,
                 about 9000 pixels of a 936x799 view a second -- so each state is
                 sampled twice and only the pixels both frames held still are
                 counted, the aim is *found* rather than guessed (a fixed fraction
                 of the viewport landed on a tree, whose canopy sways and whose
                 shadow is too dark to change visibly, and read as a stroke 58%
                 solid in its own middle), and the mouse is parked over the panel
                 for every measurement, since the cursor ring is a ~120px circle
                 the frame before it did not have and was the whole of the residue
                 an undo appeared to leave behind. The geometry is taken from the
                 largest *connected* mass rather than from every changed pixel,
                 because a stroke is one mass and a leaf caught at the same phase
                 in both frames of one pair and a different one in the next is
                 not: a handful of those in the window's corners dragged the
                 95th-percentile radius from 89px to 185px, which put two of the
                 four coverage bands outside the stroke entirely and reported a
                 dithered edge as a dead one. Area is robust to specks and a
                 radius is not. And it clears `AUTOSAVE_KEY` before the page
                 loads, or a run measures what the *previous* run left behind --
                 the aim is chosen the same way every time, so the second run
                 pressed snow onto ground the first had already painted snow and
                 would have reported a working brush as doing nothing. What it
                 reports is the coverage *profile* rather than an absolute figure
                 in the middle, because the middle is not all paintable -- a
                 prop's shadow is too dark to read either way and ground under the
                 flood line is refused outright and correctly -- so a threshold
                 there would be a fact about where the trees are. 79% -> 71% ->
                 59% -> 28% out from the centre is the dither, and a
                 cookie-cutter circle cannot make that shape.
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
                 Where a player's attack speed comes from is the **weapon**,
                 since spec 174: 091 took the cadence off it and 144 rebuilt the
                 socket without plugging anything in, which left four rows in
                 `data/items.ts` authoring an `attackSpeedPct` that reached
                 nothing for eighty specs -- the Keen Longsword's stated defining
                 feature inert, and the maul and the bow keeping their damage
                 without ever paying the drawback they were priced against. What
                 makes it a weapon *speed* rather than a cadence is that one
                 factor divides all three spans, so a quick weapon shortens the
                 wind-up and the backswing along with the wait; a weapon that
                 only came round again sooner would make the pause the stat
                 rather than the blow. Two things did **not** move with it:
                 spec 147's commitment that nothing an *attribute* writes reaches
                 `baseAttackTimeTicks` or the three inputs, so the fast stat
                 still cannot become the damage stat, and monsters, which author
                 BAT per row beside their own `NO_ATTACK_SPEED` as they already
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
                 leaves each bag individually plausible.
                 Two rules from spec 170, both about *which side of the table
                 you are on*. `setOffer` accepts an offer from the **inviting
                 side only** while a trade is still an invitation, and leaves
                 the stage alone: an empty request asks "do you want to trade?"
                 with no goods and no reason to say yes, but advancing on the
                 first item would put the invitee at a table they never agreed
                 to sit at and `respond` -- which only runs at `offered` --
                 could then never fire. And `exchangeProblem` is `swap` minus
                 the stage check, so the same arithmetic answers "would this go
                 through" for a table nobody has accepted yet; the server runs
                 it on every publish and sends a **per-player** warning that
                 disables Accept. It names a *side* rather than describing one,
                 because the single reason string `swap` returned went to both
                 players and could only ever be true for one: the player whose
                 own bag was the problem was told "their bag is full", after
                 both had accepted, which is the one moment neither of them can
                 do anything about it.
                 Spec 171 is the other end of the same idea: **an offer is
                 resolved late everywhere except at the moment it stops being an
                 offer.** The `done` message is published after `applyTrade` has
                 written both bags, so resolving slot indices there reads a bag
                 that has moved on -- and since `addToInventory` fills the first
                 free slot, which is the one your own offer just emptied, each
                 side was credited with what it *received*. The ending came back
                 as the trade reversed. `swap` carries out what it took, and the
                 terminal message uses that; every other publish still resolves
                 late, because for a live table that is the duplication defence.
                 A cancellation resolves too and is right to -- nothing was
                 written, so the bag it reads is the one the offer was made
                 from. data/ holds
                 the ABILITIES, SKILLS, ITEMS and MONSTERS tables (spec 062):
                 content is data, and an entity only ever stores an id.
                 `sim/aggro.ts` is whether one body has business with another
                 (spec 163), and it exists because until it did, the entire
                 aggro system was one line in `blow.ts` -- `targetId ??
                 attacker.id` -- and one proximity scan spec 076 deleted for
                 being nothing but a radius. What a row authors now is a
                 **temperament**, and it is a discriminated union so that a
                 body only carries a number the behaviour it chose actually
                 reads: `skittish` runs from a blow, `defensive` answers one,
                 `territorial` notices you and holds an authored alert before
                 committing, `ferocious` commits on sight and answers a blow
                 landed on a neighbour. `aggroRange` and `passive` are gone --
                 two fields for one idea, neither able to say what the body did
                 about it, one of them unread for eighty specs.
                 Three rules in it are worth knowing. The mind is **beside** the
                 body, not folded into it: `AggroValue` is a second pair of
                 fields in `activity`'s shape, because a monster holding still
                 during its alert and a monster holding still with nothing to do
                 are the same `Idle` and the whole feature is that they are not
                 the same thing. The herd's call is driven off the tick's `hit`
                 **events** rather than a per-tick scan for an ally who looks
                 angry, which is what bounds it -- a rallied body was not itself
                 hit, so it raises no call of its own and the shout carries
                 exactly one hop per actual blow, where the scan version
                 cascades through any overlapping pair of ranges for as long as
                 a fight lasts. And a **fleeing body is exempt from the leash**,
                 the one place this bends spec 076: the leash stops a body being
                 *dragged* off its anchor, and a body sprinting away under its
                 own power that got dropped at the boundary would turn round and
                 walk home through the thing chasing it. Leaving an alert is an
                 answer rather than a tidy-up -- a player who backs out of the
                 notice range before the clock runs out is let go, because a
                 pause the player cannot act on is not a decision. Nothing of
                 this rides the wire: the tell is the body turning to face you
                 and standing still, and facing already replicates.
                 `loot.ts` and `sim/loot.ts` are what a kill leaves behind
                 (spec 158), and the two of them draw one line: **the item is
                 decided when the body falls and its presentation unfolds
                 afterwards.** `data/loot.ts` holds two tables that are
                 deliberately separate questions -- what drops (probability) and
                 how loudly it announces itself (a reveal clock and cue *names*,
                 never assets) -- so a balance change and a presentation change
                 are visibly different diffs. Rarity is a property of the
                 `ItemDefinition`, not of a drop: two copies of the same sword
                 are the same tier forever, since a per-drop rarity would only
                 mean something if two copies could differ in what they *do*,
                 which needs affixes, which 154 does not build. `sim/loot.ts`
                 stamps three ticks at the drop and derives the phase from two
                 of them -- nothing marks itself revealed, so nothing can reveal
                 twice, and the server, the client and a test all answer "how
                 far has this got" from the same comparison.
                 Both ends of the *throw* are authoritative too: the drop's
                 replicated position is where it landed, scattered from a seeded
                 draw, and `origin` on the wire is where the body fell. The arc
                 between them is drawn and never simulated -- which is what makes
                 "two players watching the same kill watch the same throw" a
                 fact rather than a hope about two `Math.random` calls.
                 The decision the wire rests on is that a drop's `typeId` is
                 **empty and stays empty**: the entity record goes to every
                 client in interest range on first sight, and what an unrevealed
                 drop is must not, so the item rides a `LootDrop` of its own
                 with `defId` absent -- absent from the frame rather than
                 flagged on it, so there is no path by which a client could draw
                 it early. What *is* sent up front is the tier, because the
                 anticipation cue is tier-shaped and playing it needs one; that
                 is the "notice" step, and the payoff is what is withheld.
                 Two rules that are not obvious from the types. **Picking a drop
                 up mid-reveal is legal and served at once** -- anticipation is
                 presentation and never a lock on the player's hands, and the
                 pending reveal simply never happens. And `pickUpDrop` removes
                 the entity *before* it awaits the grant, which is what makes
                 "one drop, one stack" a property of the code rather than of the
                 timing; a full bag puts it back, at the same id, because a
                 refusal that ate the loot would be the worst bug this feature
                 could have. Taking one is bent at *both* ends, because the
                 two sides measure the reach from different instants: the client
                 asks from its **prediction** and the server checks against the
                 last input it **applied**. So `pickupLead` floors the client's
                 margin at a broadcast interval -- a measured round trip of zero
                 left the order asking from exactly the distance the server
                 refuses past, which made every pickup on a good connection one
                 refusal and a retry -- and the server's own check allows for its
                 input backlog, bounded by `MAX_REWIND_TICKS`.
                 A player can put one there too (spec 172), and it is an
                 **action that needs facing**: the press carries the world point
                 the cursor was over, the body turns to it at its own rate, and
                 only then does the item leave the bag. Not a cast -- no cost,
                 no cooldown, no wind-up, no backswing, nothing rooted and no
                 `CastState`, because every one of those would put a cast bar
                 over a body putting a potion down. What it borrows is the one
                 part of a cast that is about aiming: `CastPhase.Turning`'s rule
                 that a committed action waits for the heading it committed to.
                 `ServerEntity.dropAim` is that aim and `resolveFacing` reads it
                 directly under the cast, so the turn is the same turn every
                 other player watches. It outranks the *input* rather than being
                 outranked by it, which is where it parts company with a cast: a
                 step withdraws from a blow because there is a cost to refund,
                 and there is nothing to refund here, so a player who asked to
                 put something down and then walked off still asked. The queue
                 lives on the `Connection` rather than in the sim, because what
                 a drop takes out of a bag is behind an async store the sim
                 cannot reach -- and it is a queue rather than a slot so that
                 emptying four things at one spot is one turn and four drops.
                 Three bounded ways it ends other than by landing, all of them
                 refusals that leave the item in the bag: the body dies, the
                 queue passes `MAX_PENDING_DROPS`, or the heading does not
                 arrive inside `DROP_TURN_TIMEOUT_TICKS` -- which a body that
                 cannot turn at all never would. The aim is a **direction and
                 not a destination**: the reach is the server's constant, so
                 clicking the horizon and clicking two paces away drop the same
                 distance away, and an aim on top of the body has no direction
                 in it and leaves the heading standing (`headingToward`).
                 Both ends predict the turn -- `steerFacing` on the client and
                 `moveIntent`'s `dropAim` in the renderer -- because a client
                 never adopts the server's facing after the first seed, so
                 without it the local player would be the one person who cannot
                 see their own body come round.
                 It differs from a kill's drop in the two ways the presentation
                 is *about*:
                 `makeDroppedItem` gives it **no owner**, since a thing somebody
                 discarded is not being protected from anybody, and **no
                 reveal** at any tier, since the reveal withholds an identity
                 from somebody who does not know it and the person who emptied
                 their own bag does. It also draws nothing from `state.rng`:
                 `throwLanding` is the body's facing and a constant reach, where
                 a kill's `scatterLanding` is two seeded draws -- a landing
                 nobody chose has to come from somewhere, and one that was aimed
                 must not, or opening a bag would shift every roll in the world
                 after it. Everything else is inherited whole, the arc included,
                 because `origin` is the body's own position and the client
                 already knows how to draw a throw between two replicated
                 points. `removeFromSlot` is the container half, beside
                 `applyMove` and separate from it because a move has a target
                 and this has none; the client predicts it through the same
                 in-flight list a move replays through, which is the one thing
                 `pickUp` deliberately does not do -- a drop reads a slot this
                 client can see, a pickup reads a range check and an identity it
                 may not have been told. `npx tsx scripts/probe-drop.ts` is the
                 half no headless test can reach, and the measurement in it that
                 makes it honest is the **Escape control**: a cell drawn empty
                 is either an item on the ground or an item still in hand, since
                 a carry empties the cell it came from, so the probe cancels
                 with Escape and requires the cell to *stay* empty -- having
                 first measured on the same build that Escape does put a carry
                 back. Every wait in it is a *poll*, and that is not tidiness:
                 this environment paints the page at about five frames a second
                 under software GL and the bag's readout is published from the
                 frame, so a fixed 200ms wait is less than one frame and reads
                 the state before the click it is checking. It reported a
                 working drop as a failure exactly once, which is how that is
                 known.
                 `admin:triggerEvent 'drop'`/`'reveal'` and the live
                 `lootRevealScale` are the developer path, so a presentation is
                 tuned without farming for one -- and none of the three can
                 change what the item is.
                 Since spec 147 `skills.ts` is the *attuned* tree -- six columns
                 of six, gated on the attribute you actually built -- and spec
                 056's branch-locked Might/Finesse/Arcane tree is gone: a system
                 whose premise is that unusual combinations should be
                 discoverable cannot also have three columns that permanently
                 foreclose each other, and keeping both meant two skill systems
                 where one would do. A save holding the old rows loads with them
                 dropped and the points handed back. Beside it are the rest of
                 the progression tables -- six attributes, eighteen milestones,
                 fifteen pairs -- and `scaling.ts`, which is every coefficient
                 the six scale by in one object, so a balance pass is a diff of
                 one file. Three curve shapes and only three, because a number
                 should be understandable from its shape: `linear` for the
                 quantities where twice the investment is twice the value,
                 `softCap` for the ones an unbounded specialist would break, and
                 `reciprocal` -- `1/(1+attr*per)`, floored -- for every "less of
                 a thing", because it cannot reach zero and 0.5 means *half*
                 where "-50%" invites the question of whether two of them is
                 -100%. All three are measured from the *starting* attribute
                 rather than from zero: a coefficient on the raw value meant a
                 brand-new character already carried five points of every scale,
                 so every authored number in `abilities.ts` described somebody
                 who does not exist.
                 The attributes replace spec 056's four, which were four
                 coefficients -- a sheet with four sliders on it that all mean
                 "slightly more" asks the player *how much* rather than *how*.
                 The rule the design is reviewed against, and the one the tests
                 in `progression-tables.test.ts` enforce rather than trust: every
                 attribute viable when heavily invested in, and every one of the
                 fifteen pairs producing an interaction that is not "both numbers
                 are big". A pair with no row fails CI.
                 The pairs are also **never named on the character sheet**, and
                 that is a rule with a test behind it in two places: naming them
                 would turn fifteen things to discover into fifteen things to
                 build toward, and the question the sheet exists to ask is "how
                 do I want to solve problems" rather than "which of the fifteen
                 am I". They are live in the sim; a player finds out by having
                 one. What the sheet *does* say is what each attribute changes
                 next, and one short line per stat row -- and where something is
                 a socket with nothing plugged into it yet, that line says so in
                 as many words rather than describing a number that never moves.
                 The structural commitment is one line in `attackTimingFor`:
                 **Agility scales the attack point and the backswing and nothing
                 it writes reaches `baseAttackTimeTicks`.** A high-Agility
                 character attacks exactly as often as anybody else and spends far
                 less of each cycle rooted, which makes "the fast stat must not
                 become the mandatory damage stat" a property of the module graph
                 rather than a number somebody keeps retuning.
                 The derivation runs one way and stops (`player/progression.ts`,
                 `player/derived.ts`): allocation plus held grants settles the
                 attributes, those decide which milestones and pairs are met, and
                 only then do their grants feed the traits. A milestone therefore
                 cannot unlock a milestone -- the graph is acyclic *by
                 construction* rather than by nobody having yet written the loop,
                 and it costs one thing, which is that an item granting +5
                 Strength can open a Strength milestone while a synergy granting
                 the same could not. No synergy grants an attribute and a test
                 says so.
                 `sim/poise.ts` is the mechanic Strength spends and Constitution
                 resists, and the number that keeps it a mechanic rather than a
                 removal is the two-second immunity after a break: without it two
                 attackers hold a third permanently. Hyper-armour is the other
                 half and its rule is stated once -- **protection applies only
                 while the body is committed to something**, never while idle and
                 never merely because Strength was invested in, and it is capped
                 below 1 because a wind-up nothing can answer would make the
                 readable commitment this whole game is built on unreadable.
                 Its `staggered` predicate is what makes a break cost anything
                 (spec 173), and it is one function because it is asked in three
                 places: the movement pass roots the legs on it, `startCast`
                 refuses the hands on it, and `blow.ts` reads the same state for
                 Strength's execute bonus. Until 173 none of that existed -- the
                 flag was written and read twice in the whole server, so a
                 staggered body walked at full speed and ended its own stagger
                 early by casting through it, because a commit writes
                 `activity: Casting` over `Stunned`. Every poise test in the tree
                 passed throughout, because all of them called
                 `applyPoiseDamage` directly and asked about the pool.
                 Two rules came out of wiring it, and the first was learned by
                 writing the wrong thing first. **A staggered intent is pinned,
                 never nulled**: a null intent is how the movement pass says "no
                 request arrived", and `casters` is built from exactly that, so
                 nulling it hid the body's *cast request* along with its
                 movement -- the swing was not refused, it was never considered,
                 and the client sat out `PREDICTED_CAST_TIMEOUT_TICKS` on every
                 blow it tried to throw. Spec 080's rule covers a stagger too:
                 a request that cannot be honoured still gets an answer. So the
                 movement is zeroed and the *facing* is pinned to where the body
                 already points, which is also the one thing that separates this
                 root from a cast's -- a caster keeps steering (spec 067 holds
                 the aim live to the commit and that is the feature), where a
                 body that kept tracking you through its own stagger would read
                 as unaffected. And **the onset cannot be predicted**: spec 067's
                 `selfRoot` works because the client knows it pressed the button,
                 and nobody knows they are about to be hit, so one round trip of
                 discarded movement is the accepted cost -- bounded because
                 `activity` is replicated and the client stops the moment it sees
                 it, and masked because it lands on the same frame as spec 145's
                 chunk and 146's kick. What the client *can* close is the asking:
                 `target.ts` holds the standing order while `selfStaggered`, which
                 took one measured fight from 146 refusals to two.
                 `world/stagger-flinch.ts` is the reaction, and it is the channel
                 that needs no authored content -- a decaying rock on the drawn
                 yaw, in the same vocabulary as 146's kick and restarted by every
                 break for the same reason, because a break is a contact and not
                 a measurement. The window is replicated and the *start* is
                 observed, so a client that reconnects mid-stagger never invents
                 a contact nobody watched. `unit-driver.ts` also raises a
                 `stagger` trigger for a rig that declared one; none has yet, so
                 that channel is silently waiting for a clip.
                 `world/stun-icon.ts` is the mark beside the reaction -- a swirl
                 over the head, in `hud.ts`'s existing per-body holder -- and it
                 is **stateless**, which is the whole difference from the flinch
                 next to it. A flinch is a *contact* and needs an edge somebody
                 watched, so it keeps a track and refuses to fire for a body
                 that walked into view already broken; a swirl is a *state*, and
                 a body that is stunned is stunned whoever was looking. So there
                 is no map and nothing to prune, and the phase runs off the
                 replicated `activityUntilTick` rather than an observed start,
                 which is what makes every client draw the same angle on the
                 same tick with nothing replicated for it. It fades over a fixed
                 *count* of ticks rather than a fraction, because a fraction
                 needs the window's length and the function is handed only its
                 end.
                 What the client half got wrong first is worth keeping: only
                 `autoAttack` was taught about the stagger, and its two
                 neighbours were not. `moveIntent` kept asking for a *heading*
                 while the server pinned the body's own -- worse than a
                 mispredicted step, because a `Correction` carries a position
                 and no facing at all, so a predicted turn is an error nothing
                 ever corrects. And `castOrder` gates on `rooted`, which is "a
                 cast is in progress" -- but a break *clears* the cast it
                 interrupted, so `rooted` is false for the entire window and a
                 standing order chased and cast straight through it. Both now
                 take `staggered` as their own field, and the `moveIntent`
                 branch is *first*, ahead of a held key, since the key is the
                 one branch a player is actively driving.
                 `sim/statuses.ts` is one small timer map and everything the
                 progression needs to remember between ticks goes in it, because
                 twelve mechanics as twenty-four entity fields is twenty-four
                 places for an expiry to be forgotten. Expiry is a comparison and
                 never a sweep, so reading a stale entry cannot produce a live
                 effect. `sim/blow.ts` is one blow with all of it applied, in one
                 order, written once -- and the line in it that must not move is
                 that **crit is rolled before the weak point and always**: the Rng
                 is threaded through the whole sim and a body that draws a
                 different number of values changes every fight after it.
                 What the tests found and what it was worth: `applyDamage`
                 multiplied every blow by `spellPower` and read `attackDamage`
                 nowhere at all, so Strength's damage coefficient had been
                 decorative since spec 062 -- derived, replicated, printed on the
                 sheet, reaching nothing. `traits.weaponPower` is that number
                 turned into a multiplier a basic attack is actually multiplied
                 by, derived *from* `attackDamage` so there is still one number
                 meaning "how hard do I hit".
                 `sim/metrics.ts` and `npm run balance` are the instrumentation,
                 and the thing to know about them is what the table is *not* for:
                 six builds with the same damage per second is not evidence of
                 balance, it is evidence that five of them were tuned into the
                 sixth. Read the *shape* of a row instead -- Strength high on
                 staggers, Agility lowest on rooted time and health per kill,
                 Perception highest on weak-point rate -- and treat a row that
                 looks like somebody else's as the finding. The harness measures
                 a stationary duel, so it under-reports Agility's repositioning
                 and Intelligence's geometry by construction; that is a limit to
                 read around rather than tune against.
                 player/levels.ts is what a level *is* (spec 154), and it is four
                 numbers rather than one: the level, the two point budgets it
                 earned, and the experience not yet spent on the next one. Named
                 for the level rather than for the edit so it sits beside
                 `progression.ts` without either name suggesting it does the
                 other's job -- this file is a level and what a level hands out,
                 that one is what an allocation amounts to. Pure, and the only
                 place any of the four is written, because the failure mode of an
                 admin edit is not a wrong number -- it is a record that says
                 something the game's own rules call impossible, which nothing
                 downstream would notice. Three rules, each of them the fix for
                 the version without it. Both budgets are **re-derived** from the
                 resulting level rather than nudged by a delta: grant 5 levels,
                 spend the points, reset the level, and a delta leaves the points
                 gone. A level that cannot pay for what it is holding **gives it
                 back** -- the tree cleared, the attributes returned to their
                 starting spread, each independently of the other, since twelve
                 points of skills at level 1 is not a character. And experience is
                 **clamped into its own level's band**, or `setLevel 1` on a
                 level-20 character is somebody who re-levels on their next kill.
                 That second rule covers *two* currencies since spec 147 gave
                 levelling a second one, and it has to:
                 `reconcileAttributePoints` correctly clamps the unspent count to
                 `earned - spent`, which is zero for a level-1 character holding a
                 level-40 spread -- left there, the allocation stands forever and
                 the reset only looked like it worked.
                 `MAX_PLAYER_LEVEL` is the first level cap this game states, and
                 it bounds an *edit* rather than declaring an endgame -- the
                 derived stats are linear in the level, so an unclamped
                 `addLevels 1000000` is a body with ten million health. Nothing in
                 the sim reads it. `grantExperience` is now this function with one
                 mode fixed instead of its own copy of the level-up loop, so a
                 monster's award and an admin's grant cannot come to different
                 answers -- including about that cap, which a second loop ignored.
                 `npm run server`, and `npm run server:bots` for load.
src/server/admin-client/  the admin console (spec 154): one static HTML file, no
                 bundler and no dependency, speaking the same binary protocol by
                 hand so there is nothing to build before an operator can use it.
                 The shape it is built around is **a selection, not a form per
                 action**: the player table is polled at 1Hz and one row is
                 selected, and every action reads that selection. Before 153 the
                 table and the actions were two unconnected halves of the same
                 page -- you read an id off the table and retyped it into one of
                 three unlinked boxes, per action, correctly, or you moderated
                 the wrong person. The selection is held by `playerId` rather than
                 by row, so the poll that lands a second later cannot move it,
                 and an action with nothing selected is refused in the page
                 instead of sent with an empty id. `admin:listPlayers` stopped
                 writing an audit entry to make the poll possible -- the log is
                 for decisions, and asking who is online is not one.
                 `npx tsx scripts/probe-admin-console.ts` is the only thing that
                 can check any of it: the page's codec is hand-written, so it is
                 not the server's codec and no test in the suite imports it.
                 The probe stands up a real server, attaches real bots, clicks
                 the real buttons and reads the numbers back off the real DOM.
                 Two things in it were learned by getting them wrong: it runs
                 `node_modules/.bin/tsx` in its own process group rather than
                 `npx tsx`, because `npx` is a wrapper and a SIGTERM to it leaves
                 the grandchild holding the port -- and it *refuses* a port that
                 already answers, because the run after a failed one connected to
                 the previous run's leaked server, same port and same secret, and
                 reported every check green while measuring older code.
src/render/iso3d/world/ the Play tab (spec 063, spec 057's stage 3): the isometric
                 world drawn from GameClient.view() and nothing else. interpolate.ts
                 (20Hz deltas to a pose per frame), intent.ts, target.ts (the
                 right-click attack order, spec 072), cast.ts, appearance.ts,
                 projectile-shape.ts and trail.ts (an arrow's and a shuriken's
                 silhouettes, and the streak a thrown star leaves, spec 087)
                 unit-catalog.ts, unit-driver.ts and unit-lod.ts (spec 111: which
                 monsters are drawn from an authored unit, the pure function from
                 replicated facts to machine commands -- handed a snapshot and not
                 the GameClient, so animation has nothing it *could* call. Since
                 spec 164 that snapshot carries the **ability id**, because a
                 body has more than one basic attack and they do not look alike:
                 a sword coming over the shoulder and a bow being drawn are the
                 same `Casting` activity on the wire, so one `attack` trigger
                 could only ever pick one of them. Which animation an ability
                 gets is read off **what it sends** -- a projectile whose look is
                 an arrow is drawn with a bow -- rather than off a list of ids to
                 keep in sync with the content table, and an ability with no clip
                 authored for it keeps the swing, because a wrong animation is
                 worse than a generic one. A unit whose document declares no
                 `shoot` parameter falls back the same way, since a silently
                 dropped trigger is a body standing perfectly still through its
                 own attack. Since spec 166 the snapshot also carries how much
                 of the cast is **left** -- `endTick - tick`, which the cast bar
                 already reads -- because that is the one thing that separates a
                 cast which *finished* from one that was *called off*, and both
                 end with the cast simply gone. A cancellation is read off the
                 cast list rather than off the activity: the list is predicted,
                 so a withdrawal lands on the frame the player asked for it,
                 while the activity is replicated and a round trip behind, and a
                 bad connection is exactly when a withdrawal matters most. The
                 margin that decides "finished" is a *sampling* margin -- a
                 frame at 20fps drains three ticks, so a cast ending on schedule
                 was last seen with a few left -- and it errs toward leaving an
                 attack alone, which is what everything did before. Closing that
                 loop also turned up a case `startedCasting` had always got
                 wrong and nobody could see: a withdrawal followed straight away
                 by another attack, where the cast list goes windup / nothing /
                 windup while the replicated activity never moves. It used to be
                 invisible because the withdrawn swing played on and the second
                 attack was drawn by the first one's leftovers -- and
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
                 ground-decal.ts (an indicator laid on the ground rather than
                 over it, spec 153: the aim's shape, its range ring and the
                 telegraph a committed cast draws. Each used to be one flat
                 horizontal mesh placed at `ground(centre) + lift`, which is
                 right at exactly one point of itself and wrong everywhere else
                 the moment the ground is not level -- a 420-unit range ring near
                 a hill was two hundred units inside it. A transform cannot
                 express "and follow the hill", so the mesh's transform is never
                 touched and its *vertices* are world-space and placed on the
                 heightfield, rebuilt only when the shape changes and rewritten
                 in place every frame. Three things it holds that were each
                 learned by getting them wrong. **What gets buried is an edge,
                 not a vertex** -- a vertex placed exactly on the ground was
                 always fine, and the straight line to the next one is what cuts
                 under the bump in between, so a vertex takes the highest of five
                 samples half a step around it, plus a fraction of the local
                 spread, which is zero on the flat and leaves a level-ground
                 indicator exactly where the old one was. What no sampling can
                 catch is a **crease**, because a fold is a line and five points
                 can straddle a line -- but what a crease costs is set by the
                 step and the fold and by *nothing about the indicator*, which is
                 the whole improvement, since the flat mesh was wrong in
                 proportion to its own size. And **`heightAt` costs 5.6us a
                 call**: it jitters four corners, evaluates two triangle planes
                 and searches the ring of neighbours when a point lands outside
                 its nominal cell, so one 140-unit disc is 1100 vertices and 35ms
                 a frame. `SampledGround` memoizes it on a lattice at the
                 sampling step and blends between -- a cursor moving three units
                 a frame asks about the cells it was already in, so the cost
                 settles at a few dozen fresh samples a frame and 0.42ms.
                 Invalidated whenever a chunk streams in, because a height
                 sampled over ground that had not arrived is a height that has to
                 be thrown away.
                 Since spec 164 the two rings under a *body* -- the attack target
                 ring and the aim's unit ring -- are decals too. 153 had left them
                 on flat meshes on the grounds that they are small, and that
                 priced the wrong quantity: how far a flat mesh is buried is its
                 half-width times the **gradient** under it, and only the
                 half-width had been counted. On the arena's steepest ground a
                 ring at radius 30 was 34 units into the hill -- five times its
                 own thickness, so the uphill half was not dimmer, it was absent,
                 and `depthWrite: false` made the failure clean rather than
                 obvious. It also brought out the one thing 153's arithmetic could
                 not do, because nothing it converted was small enough to need it:
                 **tessellation has two lower bounds.** Deriving segment count
                 from size is exactly right for following the ground and says
                 nothing about whether a circle still looks round -- a 420-unit
                 range ring gets 240 segments out of the ground rule alone, and a
                 body ring gets eighteen against the twenty-four the flat
                 `RingGeometry` was authored with. So `MAX_SEGMENT_ANGLE` is the
                 second bound, stated as an *angle* rather than a minimum count,
                 since a count is wrong for a sector: a 90-degree cone floored at
                 24 segments pays four times over for curvature it has not got.
                 It binds below about 44 units of radius and the ground rule binds
                 above, so every number in 153's acceptance table still describes
                 the code. `npx tsx scripts/preview-aim.ts` is the picture
                 and the acceptance numbers, over the arena's real steepest
                 ground and against the terrain triangles the renderer actually
                 draws -- rasterised in software, because what is being looked at
                 is a shape rather than something that happens over time),
                 order-mark.ts (how high a *placed* mark goes so it never enters
                 the ground, spec 175, and the other answer to the question
                 ground-decal.ts answers by following the hill: the cross a click
                 leaves is small and gone in a third of a second, so it is laid
                 over the ground rather than draped on it. The clearance takes the
                 **highest** ground within the mark's own reach rather than the
                 ground under its middle, because a click at the foot of a bank
                 has ordinary ground under its centre and a wall a few units away.
                 There is no camera in the file, and that is the whole return on
                 laying the mark flat: `ORIENT.ground` sends a stroke's arch along
                 world up and a stroke's arch is never negative, so nothing is
                 below its own origin from any seat, and a plane at
                 `max(ground) + margin` clears everything under it *by
                 construction* -- no gradient term, no sampling fudge, nothing to
                 be right about between the samples. The upright version this
                 replaced owed a second length for how far it hung below itself
                 and a camera vector to scale that by. What it costs is the other
                 side of the same coin: on a hillside the mark sits on the ground
                 at its uphill edge and floats over the downhill one by whatever
                 the ground fell across it, which for a mark this size is a couple
                 of units on anything walkable),
                 action-bar.ts, xp-bar.ts, pool-bars.ts and death.ts (the bottom
                 band, spec 164 -- everything the HUD grew along the edge of the
                 frame, each pure and each about one number). action-bar.ts is
                 what the bar *holds*: four empty slots and the vial, replacing
                 the nine-entry `HOTBAR` that had been every ability in the
                 table laid out in authoring order since spec 062 -- a debug
                 affordance that survived into the shipped interface. The
                 emptiness is the feature: a slot with nothing in it is a place
                 a skill will go, which is a thing an interface can show and a
                 nine-wide list of everything cannot. `abilityForSlot` is the
                 only way a slot index becomes an ability, so a key and a button
                 cannot come to different answers and neither can cast out of a
                 slot that holds nothing -- and the bar is built *once* in
                 view.ts and handed to both, because a bar built twice is two
                 answers about what is in slot 3. `?slots=` fills them, in the
                 same register as `?seed=` and `?wire=` and for a stated reason:
                 with the bar empty every ability but the auto-attack and the
                 flask is unreachable from the shipped page, and the browser
                 harnesses that check the aim, the cooldown refusal and the
                 ground telegraph had nothing left to press. Deleting those
                 checks would have been the change quietly taking the coverage
                 with it. The vial can never be one of them.
                 xp-bar.ts measures against the server's own
                 `experienceForLevel` rather than a copy of the curve, because
                 the strip and the character sheet disagreeing about how far
                 along somebody is is the kind of bug nobody reports -- they
                 just stop trusting the bar. pool-bars.ts holds one judgement:
                 **an unknown maximum is not a maximum of zero**, or the opening
                 frames of every session paint an empty health bar over a player
                 at full health -- and its health bar is the *same bar
                 mechanically* as the one over a body, read through spec 145's
                 `HealthFlashes`, so the white chunk a blow leaves and the kick
                 it lands with are the ones already on screen rather than a
                 second implementation to keep in step. Two departures with
                 reasons: the pool gets a `HealthFlashes` of its own, because
                 sharing the floating bars' would make the chunk depend on
                 whether the camera happened to be looking at the player, and the
                 kick moves the whole two-bar block, because half a group
                 flinching reads as a layout bug. Resource has no chunk -- the
                 chunk marks what a blow *took*, and nothing takes resource off
                 you.
                 The whole band is drawn in the game's own 5x7 face
                 (`pixel-font.ts`), which is not a style choice so much as three
                 constraints: the face has one case and a fixed symbol set, so a
                 character with no glyph draws as a solid block and every string
                 the band can produce is asserted drawable; a label is *drawn*
                 rather than typeset, so nothing reflows and a glyph a pixel
                 taller than its track is silently clipped, which is why each
                 size is a scale in `hud-layout.ts` and each fit is a sum; and no
                 name in the ability table fits a 46px square at any scale, so a
                 filled slot on a phone draws an icon -- the answer the compact
                 HUD already gives for the weapon switch and the window buttons.
                 The two things still set in the browser's type are the developer
                 readout (which is debug output four harnesses parse) and the
                 compact aim hint, which is a 75-character *sentence*: this face
                 is for shouts and quantities, and a sentence in it reads worse
                 rather than better. death.ts returns null rather than
                 `{ dead: false }`, since a shape that can be present and false
                 is a shape with an extra way to be wrong, and it says nothing
                 for a body that is not in the replicated set at all -- what a
                 reconnect looks like for a frame or two, and where guessing
                 "dead" would put a respawn button in front of a live player.
                 `npx tsx scripts/probe-bottom-hud.ts` is the half no headless
                 test can see: the real `createHud` over a fabricated view in a
                 real browser, reading the boxes back off the DOM. It exists
                 because none of the three questions can be reached in a real
                 session without a fight -- the strip only moves when something
                 dies, the overlay only appears when you lose, and the button
                 only after that.
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
                 (`mount-presentation.test.ts`). Since spec 147 it also owns the
                 saved layout: held until there is a viewport worth applying it
                 against, written back on a trailing debounce measured in the
                 `nowMs` it was handed, and flushed by ui-layer.ts when the tab
                 goes away. `npx tsx scripts/probe-window-layout.ts` is the half
                 that only exists in a browser, and the half that was wrong for
                 three specs -- it drags the real title bar and the real grip,
                 reads the boxes back off `data-ui-frames`, reloads the tab and
                 requires the same numbers. Everything the feature decides is
                 asserted in Node; what it could not say is whether any of it
                 was connected to anything.
                 Since spec 169 it also owns the trade table's *ending*, and the
                 rule is that the mount reads `view.trade ?? view.endedTrade`:
                 the server forgets a trade the instant it is over, so by the
                 time there is a reason to show, the live field is already null
                 -- a window reading only that froze on its last live frame and
                 offered a Cancel button for a trade nobody was in. **Closing is
                 what dismisses the ending**, and it lives in `close` and
                 `closeTopmost` rather than in the Close button, because Escape
                 and the title bar shut a window without pressing anything --
                 the same shape the shop's `onVendor('')` already has, and
                 without it the mount re-opened the ending on the very next
                 frame. This is also the one window that is **re-placed when its
                 content changes shape**: every other screen is roughly one
                 size, and the trade table opens holding an invitation and then
                 grows a bag grid, which left Accept 77 pixels below its own
                 window's bottom edge and the trade unfinishable without
                 resizing by hand. `npx tsx scripts/probe-trade.ts` is the only
                 thing that could find either -- two tabs, two players, one
                 server, the real shift-right-click and the real buttons, with
                 both bags counted afterwards because a swap that duplicated the
                 bow leaves each side individually plausible.
                 Since spec 170 **closing a live trade cancels it**, because
                 leaving the table is what closing means and the alternative is
                 a player sitting in a trade they cannot see and cannot start
                 another one from -- before it the mount re-opened the window
                 every frame a trade was live, so Escape and the title bar did
                 nothing at all. What that needs is `tradeLeft`, and it is an
                 **id rather than a flag**: the cancel takes a round trip, the
                 trade stays live and replicated throughout it, and a flag was
                 cleared by the very re-open it existed to prevent),
                 loot-drop.ts (how a drop looks while it is still withholding
                 itself, spec 158 -- the three.js half is `iso3d/drop-rig.ts`,
                 beside the other rigs, and this is everything it is told: the phase is a comparison against two ticks
                 the server sent and the flare is a curve through them, so there
                 is no timer anywhere in scene.ts and no answer that differs by
                 frame rate or by who reconnected halfway through. The label is
                 **null** until the reveal rather than a placeholder -- a made-up
                 name is a lie the player reads as a fact, and "???" is the
                 interface announcing that it is hiding something, which is the
                 opposite of noticing an object. A common drop's curve is flat at
                 the dimmest value in the table, since `restFlare === peakFlare`
                 there, which makes "ordinary loot is quieter than everything
                 else at *every* instant" true by construction rather than by two
                 curves happening not to cross.
                 Three curves beside the flare and each answers a different half
                 of "what is the reveal actually doing". `tossAt` is the arc, a
                 parabola between two replicated points over a fixed span.
                 `heartbeatAt` is the pulse a rare-or-better drop has and a
                 common one does not -- two beats a second, the smaller behind
                 the bigger, phased off `spawnTick` so every client beats
                 together. And `tierMixAt` is the one that had been missing: it
                 is **zero until the reveal tick**, so an unrevealed drop is
                 drawn in the neutral colour ordinary loot wears. Colouring a
                 drop by its tier from the first frame -- which is what the first
                 cut did -- answers the exact question the reveal exists to ask,
                 and leaves a feature that only delays a *brightness*. What is
                 legible early is that something is unusual (the swell);
                 never how unusual, and never what. The same correction was
                 needed in all three channels: the flare used to start at the
                 tier's own `restFlare`, so a rare drop's halo was fourteen
                 times a common one's on the landing tick and an exceptional's
                 thirty-four -- an unrevealed drop now rests at exactly what
                 ordinary loot rests at and runs up to one shared peak, with
                 only the flash *at* the reveal tier-scaled. The pulse is
                 withheld and phased off the reveal. And no cue that fires
                 before the reveal names a tier, because a tier in `cues.spawn`
                 is the rarity leaking out through the audio the moment anybody
                 authors one. The curve all three ride has one shape rule --
                 **it never decreases** -- so half a second of quiet (the throw
                 finishes inside it) is followed by a climb to a shared hidden
                 peak and then a second climb to the tier's own rest, and
                 nothing deflates at the moment the payoff is meant to land.
                 Taking one pops it -- grown and faded over `POP_TICKS`, which
                 needs the rig to outlive the entity, since the drop is gone the
                 instant it is picked up and a rig disposed on the same frame
                 has nothing left to animate. It grows rather than shrinking
                 because enlarging while fading reads as *taken* and shrinking
                 reads as *lost*. **Whether to pop at all is derived rather than
                 announced**: there are two ways a drop leaves and the client
                 tells them apart from the spawn tick and the shared lifetime,
                 so the pop plays for every observer with no message carrying
                 it, and the margin runs one way -- a missed pop on an unwatched
                 expiry costs nothing, a pop on an item that quietly rotted
                 would be a lie about a reward.
                 `npx tsx scripts/preview-loot.ts` is the picture, and the
                 reason it exists is that the first cut of this feature passed
                 every test it had and did almost nothing on screen -- the
                 label was computed and drawn by nobody, the tier colour was
                 baked into the rig's constructor, and no cue was authored. One
                 row per tier, one column per sampled tick, through the real
                 presenter and the real rig, rasterised in software because what
                 is being looked at is a *sequence* and this environment paints a
                 real page at a few frames a second. Two things it draws that the
                 game does not: the origin as a cross and the landing as a ring,
                 so a drop that failed to travel would sit on the ring in the
                 first column. Cues are names emitted into the
                 vfx system and an unauthored one is *silence*, deliberately --
                 `addEffect`'s fallback ring under every potion that ever drops
                 is exactly the noise the restrained-presentation rule exists to
                 prevent),
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
                 nothing in this directory's pure half imports the rig module.
                 The shape and colours are the rig's own `MechAppearance` rather
                 than a shape this file invents, which is what makes the movement
                 sandbox's chip honest -- the panel's colour wells write into the
                 same type, so what is tuned there is what gets pasted back here)
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
                 assertion, and since spec 158 it drives a drop's reveal beside
                 the machines and the eased yaw -- the compared state carries the
                 drop's authoritative identity on every tick, because a reveal
                 implemented as client state would be a client deciding when an
                 item becomes real: the same seed and inputs twice, once with the
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
                 size whatever holds it. The pig's `weapon.main`
                 calibration was found by sweeping candidates through the
                 offscreen rasteriser: `npx tsx scripts/preview-weapon.ts`
                 photographs the real mesh at the real pose, `SWEEP=` puts four
                 candidate rotations side by side in one strip, and `CLIP=shoot`
                 poses the draw instead of the swing -- which matters as much as
                 the numbers, because a calibration is exact at one pose and
                 approximate everywhere else. `weapon.off` was *solved* instead
                 (spec 165): `npx tsx scripts/solve-socket.ts` states where the
                 weapon's own axes should point in the body's axes and answers in
                 one matrix multiply, `pivot = boneᵀ · target`, because a sweep is
                 slow and only ever answers "which of these four". Its reportable
                 half is worth as much as the solve -- run with no `WANT` it
                 prints where each axis currently goes -- and it was checked
                 against the sword's known-good numbers before being trusted with
                 a new socket: the blade at the guard comes back "forward and 20
                 degrees up", which is what `aim-blade.ts` says it authored.
                 Since spec 165 the Play tab actually *uses* all of this. It had
                 not: `scene.ts` built a `UnitRig`, never called `setSockets` and
                 never built a `WeaponRig`, so every player was drawn
                 empty-handed while holding a sword -- a complete format with
                 green tests either side of a game that called none of it.
                 `world/weapon-look.ts` is the table saying which model an
                 equipped item is drawn with, and its rule is that **an item with
                 no row draws empty hands**: the maul and the stars have no mesh,
                 and drawing the maul as the knotted stick would be a lie the
                 player reads as a fact about their gear. Only the *local*
                 player's weapon is drawn, because only the local player's
                 equipment is on the wire.
                 Two things make the mount a per-frame call rather than an event.
                 The body's mesh and the weapon's mesh are independent fetches
                 and `attach` needs a bone, so it is retried until it takes; and
                 the wanted model id is written before the load starts and
                 re-checked after it resolves, so a bow that arrives after the
                 player has switched back is disposed rather than drawn. Whatever
                 is held is dropped *unconditionally* when a load lands, because
                 two loads of the same weapon can be in flight at once -- switch
                 away and back inside one fetch and both carry the same id, so
                 both pass the staleness test, and assigning over the first
                 leaves it attached to the bone with nothing left holding a
                 reference to detach it.
                 `npx tsx scripts/probe-held-weapon.ts` is the only thing that can
                 see any of that: it drives the shipped build, clicks the real
                 weapon switch and reads `data-held-weapons`, which is published
                 from **what is attached** rather than from what was wanted, so a
                 weapon fetched and hung on nothing reads as absent.
src/render/iso3d/movement.ts, debug-view.ts  the two tuning sandboxes (specs
                 032/033/035/046, back since 066): one unit, no game, so a gait,
                 a cloth solve or a turn rate can be watched in isolation.
                 Since spec 152 it also drives the *shipped* small spider, loaded
                 from the same look table the arena draws it from, so what gets
                 tuned is the enemy in the game rather than a lookalike rebuilt
                 from memory. The mechs share one tuning object -- that is what
                 makes the panel's mech section one set of sliders rather than
                 one per unit -- so a third mech with different numbers has to
                 *load* them, the same thing C already does with the archetype
                 presets. A preset's tuning and its appearance carry separate ids
                 because they change on different picks: spider and walker have
                 always differed in colour and never in tuning, so moving between
                 those two must still leave a dragged slider alone. Reset follows
                 the active chip rather than the bare defaults, or the button
                 quietly turns the small spider into a mech.
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
                 Since spec 152 that panel is **lil-gui**, which the map editor
                 has always used: no second UI framework in the tree, and no
                 hand-written sliders, number fields, colour wells or folder
                 chevrons. What did not move is the row *data* -- a `TuningGroup`
                 is a plain description with no lil-gui in it, the same split
                 `editor/tools.ts` keeps from `editor/panel.ts`, which is what
                 makes the mech, robe and critter tables readable on their own.
                 Two things changed shape rather than being translated. The unit
                 picker is a dropdown, because the chips were one flex row across
                 a 300px panel and the roster had already grown past what that
                 could hold -- the last chip was being clipped mid-word. And the
                 critter's coat is a free colour with the twelve kept as presets:
                 the swatch grid existed because the derivation that keeps a
                 critter legible is only *guaranteed* in the mid-value band those
                 twelve occupy, but that argument is about the surface a player
                 customises through, and this is the tab whose whole job is
                 trying the thing to see what it does. The guarantee is a note in
                 the tip now rather than a fence.
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
