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
| `npm run spec:next` | The number a new spec takes, read from **every branch** rather than from `specs/` (spec 266). `specs/` holds only what has merged, and 105 of the 319 specs on `main` share a number with another one because every session read it anyway. Also prints who holds what, including branches sitting on a number `main` already uses — nine of them the day it was written |
| `npm run check:specs` | The same report with an exit code, and what CI gates on: a branch may not **introduce** a duplicate number. The 48 already on `main` are reported and never failed on — renumbering them would break every `spec NNN` reference in the tree |
| `npm run validate:units` | Validate every authored unit document in `assets/units/` |
| `npm run validate:items` | Validate every weapon document in `assets/items/`, against its own mesh |
| `npm run bake:units` | The offline model build: gate tri counts, hash every asset, write `assets/units/manifest.json` |
| `npm run bake:audio` | The offline sound build (spec 229): production WAVs in `assets/audio/raw/`, game-ready `.ogg` out into `public/audio/`, plus the manifest the SFX tab's picker reads. **Discovers** rather than being told -- every audio file under the source tree is baked, at the name `bakedNameFor` derives from where it sits -- and is **incremental**, so dropping in one take costs one ffmpeg call. `-- --force` re-encodes; `-- --prune` deletes outputs with no source, which nothing else ever does (the sources are gitignored, so an uninvited tidy-up would delete the whole committed library on a fresh clone). Measured on the delivered library: **51.56 MB to 1.36 MB**. Wants ffmpeg, and is the only thing in the repo that does |
| `npm run audio:report` | Which sound hooks exist, which are silent, and which baked clips nothing references (spec 229). `--strict` for an exit code |
| `npm run build && npx tsx scripts/probe-audio.ts` | Whether any of the audio framework is wired to anything (spec 229). Walks, swings and casts in the shipped page and reads what the engine says **started a voice** -- not what a call site asked for. It found the bug that made every once-only sound silent: the catalog lands before the first click, so the whole warm ran against a context that did not exist yet. Runs twice, `probe-map-editor.ts`'s shape: once over `dist/`, where Save must *say* there is no dev server, and once against a real `npx vite`, where a file chosen in the tab has to reach `assets/audio/raw/`, be encoded, be offered by the picker, be assigned, and land in the catalog on disk |
| `npm run balance` | Fight the twelve build presets through the real sim and print what each one actually did (spec 147) |
| `npm run audit:progression` | Every specialization tier at every attribute value it can be bought at, and whether the purchase reaches anything the sim reads (specs 241, 244). `--all` lists the working ones too |
| `npx tsx scripts/probe-stance.ts` | Whether the pig is standing on anything (spec 245). Reads the committed combat clips -- not the pose table -- for where the pelvis sits along its own support span, how far each toe is off the ground the **idle** rests on, and each knee's bend and which way it points. `idle` is printed beside them as the control, and that is the whole instrument: every number is relative, so a probe without one cannot tell a stance that is planted from one measured against itself |
| `npx tsx scripts/plant-foot.ts` | Solve that stance rather than author it (specs 143, 245): state where each foot is on the floor and how far the heel is off it, and get the six angles per leg that put it there |
| `npx tsx scripts/preview-lance.ts` | What the Warden's beam looks like on the arena's real ground (spec 262), in both phases, with a player standing in it and one beside it. Rasterised in software for `preview-aim.ts`'s reason -- what is being judged is a *shape* -- with `preview-fixtures.ts`'s transcription of three's own `getDistanceAttenuation` in it, so the pool of red light the beam throws is the one the frame throws. It prints the numbers a thumbnail hides, all of them **in retro colour bands**, which is the unit that decides whether a mark survives the quantize at all: what fraction of the frame the beam paints and how far it moves the colour there, and -- everywhere it does *not* paint -- how much ground its light reaches and by how much. That second pair is the whole instrument since the beam stopped painting the ground: the same sheet reports a hard band and a lit pool identically if it only looks where the beam is |
| `npx tsx scripts/probe-warden.ts` | What the Warden is doing, tick by tick (spec 262): the state it is in, the body its lance is committed to, where that lance points against where the body does, the state's own clock, both Guard pools and every pulse that lands. It exists because the encounter *is* timing, which is the one thing a pass/fail test says nothing about -- `warden.test.ts` asserts that stepping aside works, and only this says whether stepping aside is a half-second decision or a two-second one. `--strafe` reacts once the beam is live, `--orbit` never stops moving, `--at N` fights it from further out. On the shipped numbers one beam costs a body that stands still all **eight** of its pulses and a body that moves **two** -- and the gap widens with range rather than closing, because a lane sweeps its tip faster the further out you are: at 400 units the same reaction costs six |
| `npx tsx scripts/probe-already-casting.ts` | Where `alreadyCasting` comes from in an ordinary fight (spec 264). Drives the shipped loop against a real server over a delayed wire -- `autoAttack` deciding the swings, `startAim` deciding the presses -- and counts every refusal by reason beside the phase the caster's **own** cast was in when the press was made. It has to run both halves at once, which is why no existing harness could have found this: `auto-attack-wire.test.ts` swings and asserts the refusals are `staggered` and nothing else, and that still holds. Add the presses and thirteen of them were refused thirteen times, a third during a *follow-through*. `--now` is the control, sending on the press as `castNow` did; `--no-press` is the swings-only half |
| `npx tsx scripts/probe-walkability.ts` | The angle a body actually walks up, at four speeds and three approaches, against the angle the router refuses and the ground the shipped map has (spec 228) |
| `npx tsx scripts/preview-weapon-scaling.ts` | Every weapon's scaling letters, the coefficient budget they add up to, and what spec 216's migration moved at five builds |
| `npx tsx scripts/preview-afflictions.ts` | Run the seven afflictions through the real pass and print the curve each one actually is (spec 190) |
| `npx tsx scripts/preview-crowd.ts` | Draw the five crowd scenarios through the real tick, with the acceptance numbers (spec 187) |
| `npx tsx scripts/preview-afflictions-vfx.ts` | Photograph the seven afflictions' paint through the judging rig, with the crispness numbers (spec 215) |
| `npx tsx scripts/probe-afflictions.ts` | The same paint in the shipped Play tab, measured against a control frame (spec 215) |
| `npx tsx scripts/probe-aura.ts` | Whether the aura ring is really on the ground in the shipped Play tab, and only when something carries a field (spec 223) |
| `npx tsx scripts/preview-unit-plate.ts` | The two overhead shapes side by side -- a player's plate and a monster's bar -- photographed at four times life size, with every box measured (spec 257). A plate is 84x16 CSS pixels and every way it fails is a way a stylesheet fails: a row negotiated down to nothing by a flex parent, a level box the digits spill out of, a ring creeping back around them. All of those are visible in a rectangle, which is why it reads the boxes as well as taking the picture |
| `npm run build && npx tsx scripts/probe-living-ground.ts` | Whether the grass is alive in the shipped page, and only the grass (spec 252). Defines **its own footprint** rather than measuring a crop somebody chose: with the weather clock stilled, the pixels that change when the panel's Ground detail goes to zero *are* the pixels the layer reaches, so its mean colour answers "did it stay on grass" and every later number is counted inside it. Reports the tones that ground holds with the layer off against with it on, because a modulation the retro pass rounds away adds no tones at all -- which is exactly how spec 074's streak shipped invisible |
| `npx tsx scripts/bench-crowd.ts` | What the crowd pass costs, against what a whole tick costs |
| `npx tsx scripts/bench-tick-scale.ts` | What a tick costs against how much world there is *elsewhere*, at fixed residency. Flat is the invariant (spec 206) |
| `npx tsx scripts/check-shore.ts` | Where the world stops, and whether a player could see it (spec 210). `--strict` for an exit code |
| `npx tsx scripts/bench-grow.ts` | What a grow costs, whole-world against partial. Flat is the invariant (spec 209) |
| `npx tsx scripts/probe-editor-ground.ts` | Whether the editor's ground window really meshes and evicts, in a browser (spec 212) |
| `npx tsx scripts/probe-editor-props.ts` | Whether the editor's deferred prop field really puts the trees back (spec 211) |
| `npx tsx scripts/bench-editor.ts` | What *opening the map editor* costs, stage by stage, across world sizes (spec 211). `bench-map.ts` measures the server; this measures the one caller that still wants the mesh |
| `npx tsx scripts/preview-structures.ts` | Photograph the village props -- hut, well, and four of them round a square -- with a body-sized block for scale (spec 224), plus a grave and a row of them (spec 263). The grave is the one prop here whose risk runs *opposite* to the sign's: it has to be unmistakably shorter than the person looking at it and still read from the game's own bearing, so the block it is drawn beside is the measurement rather than a courtesy |
| `npm run build && npx tsx scripts/probe-structures.ts` | Place a hut, a well, a sign and a grave in the real editor and read them back out of the saved file (specs 224, 260, 263). The sign is the one placed kind with a field of its own, so it is the one whose panel row can be shown for the wrong kind or wired to nothing -- and neither failure is visible in a screenshot, because a board placed with an empty message looks exactly like one placed with the right message. The grave is the opposite case and earns a step for it: it has **nothing** of its own, so every part of being placeable is derived, and the whole feature is a button nobody wrote and geometry nobody dispatched to -- both silent. It is also why `placed()` derives its pattern from `PLACED_KINDS` instead of listing the kinds: written by hand it printed `said nothing` for a grave that really had been placed, which is exactly what one that had **not** been placed prints |
| `npm run build && npx tsx scripts/probe-sign.ts` | Whether a sign on the map is marked, walked to, read and closed in the shipped page (spec 260). **It puts the sign there itself**, backing up `maps/arena/` and restoring it -- there is none on the shipped map, and a probe that needed somebody to have placed one first is a probe nobody runs. Written before the game server starts, because with `?server=` the client's terrain comes off the wire, so what the page draws is whatever that process read from disk. The sign is found with the cursor (`data-crosshair` reading `sign` is the game's own answer to "that is something you can read"), and the **walk is measured** rather than assumed: `SIGN_READ_RADIUS` is under a hundred units, so a run that opened the bubble without moving has not seen the order at all and would go on passing after it was removed |
| `npx tsx scripts/preview-fixtures.ts` | Photograph the three light fixtures **and what they light** (spec 250). The rasteriser has three's own `getDistanceAttenuation` in it, so the pool on the ground is the one the game throws -- and it prints the number a picture is bad at: the ground is not facing the light, so what a designer sets is scaled by the grazing angle, and the three read out to 41-47% of their reach at night against 29-30% by day |
| `npx tsx scripts/preview-day-night.ts` | What the day/night cycle actually does (spec 264). A `preview-` rather than a `probe-` because what is being judged is a **schedule**: a thumbnail of a sunset says nothing about whether the sunset takes four seconds or forty, and forty is the whole question. Four sheets -- the segment table with the hours-per-second rate that falls out of it, the four seams with the rate either side of each as a ratio, a whole cycle walked through the real `worldClockAt` and the real `skyAt`, and the acceptance numbers. The pair worth reading is on the seams sheet: a piecewise clock can only show a kink where its rate jumps, and beside each ratio it prints **how fast the colour was moving there** -- so day->dusk speeding up 4.89x reads as 0.000005 to 0.000256 of a channel per frame, which is a large multiple of nothing. The last sheet answers the question the segment names cannot: the Day and Night *phases* are 10m00s and 2m00s, and the *sun* is up 10m43s and down 2m47s, because dawn and dusk divide their 45s each between light and dark |
| `npm run build && npx tsx scripts/probe-day-night.ts` | Whether the world clock is wired to anything (spec 264). Every rule about the cycle is asserted in Node and all of it would go on passing beside a `scene.ts` that never called `resolveSkyHours` -- and that failure is **invisible**, because a scene still lit by `FIXED_DAYLIGHT` looks correct, just permanently mid-afternoon, which is the bug the spec exists to fix. So it drives the shipped `dist/` past the title screen and asks the three things a green suite cannot: that the default is the *world's* clock and says `pinned` nowhere, that `?clock=` reaches the frame (`data-world-clock` is published from the clock the frame **drew with**, so a pin that parsed and reached nothing reads as absent), and -- the only one that matters -- that the picture is actually darker, measured off the canvas. Night comes out at **0.44x** noon. Its first cut sampled the canvas with `drawImage` and read `0.0000` at every hour: this renderer builds its context without `preserveDrawingBuffer`, so there is nothing left in the drawing buffer once the frame is composited. Every check passed except the one that mattered, and that one failed *identically* at noon and midnight, which is what measuring nothing looks like when the comparison is a ratio. It screenshots, like `probe-exempt.ts` |
| `npx tsx scripts/probe-world-lights.ts` | Whether the fixtures on the shipped map are actually lit in the Play tab (spec 250). Reads `data-world-lights`, whose `lit=` is the **pool's own held slots** -- so one refused or dropped reads as absent -- against an `offered=` this script checks against the map file it read itself |
| `npx tsx scripts/light-the-square.ts` | Put a fire and three lamps in the town square of `maps/arena` (spec 250), where the shopkeepers stand. `place-npc.ts`'s script one system over and for its reason: these have to agree with `data/vendors.ts`, which the editor cannot see. Prints what it would do; `--write` does it. Idempotent, and it **refuses** a spot with no ground, one inside an existing prop, or one inside a shopkeeper's wander disc |
| `npx tsx scripts/place-npc.ts` | Put every friendly NPC's spawner into `maps/arena` at the spot its shop is measured from (specs 246, 245). Prints what it would do; `--write` does it. Idempotent -- a marker already there is moved rather than duplicated. The editor is still the tool for *placing* markers; this exists because a shopkeeper's spot has to agree with a constant in `data/vendors.ts`, so "exactly there" is the operation and a script saying so is reviewable where a dragged marker is not |
| `npx tsx scripts/make-reference-unit.ts` | Regenerate the reference unit in `assets/units/dev/` |
| `npm run build` | Production build of the renderer (Vite) |
| `npm run dev` | Dev server for the renderer, for actually playing the game |
| `npm run server` | The authoritative server, plus the admin console. Opens and migrates `data/game.db` itself (spec 226); there is no database to start. Runs as `node --import tsx`, so it is **one** process rather than a `tsx` supervisor in front of the real one -- the wrapper cost a second runtime and swallowed signal bursts before the shutdown handler saw them |
| `npx tsx scripts/db-status.ts` | What is in `data/game.db`: schema version, row counts, and which migrations have run (spec 226). Never prints a token or a hash |
| `npm run build && npx tsx scripts/probe-shop.ts` | Talk to a merchant and open its shop in the shipped page (spec 249). Runs against a **real `npm run server`** rather than the in-tab loopback, which is the whole point: the two bugs it was written for -- a window sized before its stock arrived, and a stale shop answer landing on a window that had just opened -- are both invisible over a loopback, where every answer lands before the next frame is drawn. It finds the merchant with the cursor (`data-crosshair` reading `bubble` is the game's own answer to "that is somebody you can talk to"), right-clicks it **once** from wherever it was spotted, presses a reply, and measures the window's **box** as well as its openness -- because "open" and "readable" are two claims and the bug shipped green against the first one. That single click is spec 257's own assertion: the probe used to order its own walk between attempts, and doing that now would hide exactly the feature it is checking, so it measures the ground the body covered off `data-self-at` instead |
| `npm run build && npx tsx scripts/probe-production-client.ts` | Whether the page that ships is the game rather than the workbench (spec 254). Everything that spec *decides* is pure and asserted in Node, and this is the half no headless test can reach -- the **wiring**, which is what this repo keeps rediscovering: `visibleTabs` had a complete test file for sixty specs while spec 176 found the editor saving into a world nothing could load, and `layout-store.ts` passed every one of its own tests while nothing in the shipped build imported it. Runs twice, `probe-map-editor.ts`'s shape: once with no query, where every bench, popover and readout must be **gone**, and once with `?client=workbench`, where all of them must come back. The second pass is what makes the first mean anything -- every check in it is an *absence*, so a page that failed to mount, or a tab label misspelled in the probe's own list, scores a flawless zero on the first pass alone. It also checks the hidden meter is still publishing `data-fps-*`, since that is what made the default safe to move, and since spec 255 the **front door**: the shipped page must open on the title screen, `?client=workbench` must not, and Start must take it away -- an `inset:0` element left behind eats every click of the game underneath it, which is the failure `loading-overlay.ts` names |
| `npm run build && npx tsx scripts/probe-account.ts` | Claim a guest character through the shipped page and read the database back to check the account owns *that* character (spec 226) |
| `npm run server:bots` | Headless bot clients, for load and for watching prediction. Each mints its own guest character over `POST /api/auth/guest` first (spec 226), since a gated server refuses a `Hello` with no session token -- so a run leaves that many disposable players in the database |

CI (`.github/workflows/ci.yml`) runs typecheck + lint + test on every push
and must be green before merging.

## Spec-first workflow

Every feature gets a short markdown spec in `specs/` **written and committed
before its implementation**. Use `specs/000-template.md` as the starting
point. A spec should be short: problem statement, data/API shape, the
invariants that will be tested, and explicit out-of-scope notes. Specs are
numbered in build order; implementation PRs/commits should reference the
spec they implement.

### Picking the number

**Never read `specs/` to find the next number.** Run `npm run spec:next`, and
take what it says. Then write the spec, commit it on its own, and **push it
before you start building.**

Those are two rules and they are the same rule: `specs/` holds only what has
**merged**, and this repo runs 184 branches at once, so a number that looks free
in the working tree is a number several other sessions are also looking at.
`spec:next` reads every ref instead — a pushed branch has published its claim,
and reading all of them costs half a second. Pushing early is your half of that
bargain; until you push, your claim is invisible to everybody else, and the
window in which somebody takes your number is the whole time you spend building
rather than the minute it takes to push a markdown file.

The cost of not doing this is measured rather than hypothetical: **105 of the
319 specs on `main` share a number with another spec** (spec 266). Spec 254 is
two different specs, 139 is four, and every `spec NNN` reference to a contested
number — in this file, in the specs, in the source comments — is ambiguous. When
you meet one, disambiguate by slug; they are not being renumbered, because the
references pointing at them outnumber the files.

If you do collide — you will occasionally, since a session that has picked a
number and not pushed cannot be seen — **run `npm run spec:next` again and take
that number.** Do not renumber to "one past the one I hit". That is read off
`main`, which is the same view that caused the collision, so two sessions
colliding on the same day pick the same replacement: it is why `main` has two
spec 257s, and how 263 and 264 each came to hold two. `npm run check:specs` is
the gate, and CI runs it — a branch cannot merge while it duplicates a number
`main` already uses.

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
docs/            durable direction that outlives one spec.
                 progression-model.md (spec 244) is the progression **economy and
                 structure**: one pool spent on either an attribute point or a
                 specialization tier, six tracks with six thresholds each, what is
                 automatic and what is bought, the whole conversion table for the
                 thirty-six old skills, why the fifteen authored pair synergies
                 were removed and what replaced them, and what a fresh local save
                 now holds. Read it before touching progression; it is the
                 companion to the next one, which is about what a *number* may do
                 rather than about what a *point* buys.
                 progression-and-scaling.md (specs 238-242) is the rules
                 progression and combat-scaling work is decided against: what an
                 ability is allowed to scale with and in what order the three
                 addends of a blow are summed, the two progression rules (**every
                 purchased tier does something where it can be bought**, and
                 **progression does not move backwards**), the status taxonomy
                 the sim reads, and Second Wind's consumed state with its reset
                 rule. The parts worth knowing before touching any of it: damage
                 is `base + own letters + a fraction of the weapon`, summed once,
                 with everything below that point a multiplier -- so
                 double-counting is a structural impossibility rather than
                 something to be careful about; Spell Power multiplies what
                 Intelligence buys and nothing else, its own Intelligence term
                 having been removed so an Intelligence ability is not quadratic
                 in Intelligence; an affliction's rate, cadence and length are its
                 own row's whole, and the only thing an applier moves is one
                 snapshotted multiplier derived from *that ability's* letters;
                 and a capability is a flag rather than a number a layer reduces,
                 because inferring one from the number a skill *lowers* is how
                 three purchasable skills came to switch off the mechanic they
                 improve. vfx-plan.md, ui/, and
                 reward-philosophy.md (spec 158) -- the rules future loot,
                 progression, encounter and feedback work is decided against:
                 world-embedded rewards over reward cards, contrast between
                 quiet and rare, and the existing combat vocabulary reused
                 rather than re-invented. Labelled throughout as **Current
                 rule** / **Implemented** / **Future direction** / **Not yet
                 implemented**, because the risk with a document like that is a
                 direction reading as a backlog item and getting built as a side
                 effect of something else.
                 mechanics-vocabulary.md (spec 191) is the other half of that
                 idea, for words rather than for rewards: one controlled term per
                 concept with the code that owns it, a grammar for every number a
                 player is shown, and the Technical Description standard every
                 skill, sigil, item and status description is written to. The
                 rule it exists to enforce is that **a description is derived
                 from the row the sim reads**, never authored beside it --
                 `data/description.ts` is the one writer, so "two designers
                 describing the same mechanic write the same lines" is a fact
                 about the module graph rather than a habit. Its last section is
                 an open-questions register, and that is not a to-do list: it is
                 where a mechanic whose behaviour is *unclear* goes, because the
                 standard's first rule is that an unclear line is omitted rather
                 than guessed. Applying it found three things wrong in the
                 tables, including an ability comment and two flavour lines
                 claiming a lobbed shot flies over what is in its way when
                 `sim/world.ts` says an arc "buys nothing mechanical" and
                 `projectileHits` has no height term in it at all.
assets/audio/    the sound library (spec 229). `sfx.json` is the **catalog** -- one
                 entry per sound event that has files behind it, holding the
                 variants and whatever a person tuned by ear. Committed, so a mix
                 change reviews as a diff the way `maps/arena.json` makes the
                 world review as one; written by the SFX tab through a
                 `POST /api/sfx` the dev server answers and a build has not got.
                 The decision the whole framework rests on is the split it makes
                 with `src/render/audio/events.ts`: **the event set is code and
                 the assignment of files to events is data.** Gameplay says
                 `audio.play('combat.hit.flesh', at)` and a typo is a build
                 error; which `.ogg` that turns into is this file, and nothing in
                 gameplay reads it. So adding a sound to a skill is an edit in a
                 tool, and adding a *kind* of moment to the game is a row in the
                 vocabulary plus one call site.
                 Two numbers in an entry are worth knowing because neither is
                 a preference. **`volume` reaches 4x**, and the ceiling is set by
                 the library rather than by taste: the bake deliberately does not
                 normalise -- loudness relative to the rest of the game is a mix
                 decision and the mix lives here -- and that assumes this file
                 can express the range the takes span. Measured across the
                 delivered 74 the source levels differ by about **14 dB**, so at
                 the old 2x (+6 dB) ceiling the three arrow takes were
                 unreachably quiet whatever anybody typed into the tab: they
                 started, panned and played at about -38 dB, which is not a
                 sound. And **`ref` is a property of the ability's reach**, not a
                 constant -- 140 is melee, and a bow reaches 420, so an arrow
                 landing at the edge of the range it was shot over lost another
                 10 dB for being far away when what it is, is the thing the
                 player just did.
                 An entry stores `variants` and **only the fields that differ
                 from `SOUND_DEFAULTS`**, which is not tidiness: a file where
                 every entry restates `"rolloff": 1` is a file nobody reads, and
                 a default written into forty entries is a default that can never
                 be changed again. An event with **no entry at all** is silent,
                 and that is the honest encoding of "nobody has assigned a file
                 to this yet" -- not an error, not a warning, and deliberately
                 not a placeholder beep.
                 `raw/` is the production takes and is **gitignored**, for the
                 reason `.studio/` is: 51.56 MB of 96kHz 24-bit stereo WAV is the
                 raw intermediate rather than the deliverable, and what gets
                 committed is what the bake writes. They live on the
                 `raw-audio-files` branch; `git checkout raw-audio-files --
                 assets/audio` brings them back.
                 What decides where a take ends up is `src/render/audio/paths.ts`
                 and it is one module because **three places have to agree**: the
                 bake writes the file, the dev server decides where an upload may
                 land, and the SFX tab predicts the URL so it can assign the take
                 the instant the bake finishes. If they ever drifted the failure
                 would be an import that succeeds, a bake that succeeds, and a
                 variant pointing at a URL that 404s the first time somebody
                 swings a sword. The name is the source tree's own structure,
                 slugged -- so a folder is a folder and adding a sound is adding a
                 file. `BAKED_NAMES` is a **rename map for the delivered 74
                 alone**, and it is not tidiness either: those paths are
                 referenced by `sfx.json`, so a dropped row would re-derive a
                 different perfectly valid name and take the sound out of the game
                 with every test green. Everything since goes through derivation.
                 That map is what the bake's own table used to be, and moving it
                 here is the whole change: adding a sound was a **code edit**,
                 which is exactly the friction the events/catalog split exists to
                 remove -- it is absurd for the *file* half to have it when the
                 *assignment* half does not.
public/audio/    what the bake writes, and vite's `publicDir` -- so one tree is
                 served in dev and copied verbatim into `dist/`, at the same
                 `/audio/...` URL in both. 74 clips, 1.36 MB, 48kHz Vorbis, and
                 **mono for anything spatial**: a `PannerNode` downmixes a stereo
                 buffer before it pans it, so stereo would be twice the bytes for
                 a stereo image that is discarded and replaced. `manifest.json`
                 beside them is the index the SFX tab's picker reads -- written by
                 the bake rather than globbed by vite, because a `publicDir` file
                 is copied verbatim and never enters the module graph, so
                 `import.meta.glob` cannot see one and a static host offers no
                 directory listing.
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
                 recipes/shore.json is the one a coastline is grown from
                 (spec 210), and the number worth knowing is its **depth**: the
                 shipped map has 212 walkable chunks within two of undeclared
                 space and **not one chunk of sea**, so its whole perimeter is
                 ground ending at nothing, with the sim's wall at exactly the
                 same place. A strip `n` chunks deep gives `n - 1` rows of true
                 sea, because `bakePart` eases the recipe in over a skirt where
                 it meets existing ground -- so a shore is grown
                 `MAP_CHUNK_REQUEST_RADIUS + 1` deep, measured: 3 clears an
                 edge, 4 and 5 buy nothing.
                 recipes/ are the feature lists parts are grown from (spec 083) --
                 `npx tsx scripts/grow-map.ts --recipe maps/recipes/<n>.json
                 --rect minCx,minCz,maxCx,maxCz --seed N` adds one to the map
                 rather than regenerating it -- and since spec 209 it reads only
                 the regions the bake reaches rather than the world. Spec 204 had
                 made a grow *write* only what it touched and it still opened
                 everything to get there: 6.9s on a 12,960-chunk map to change
                 one region, of which 1,691ms was joining every region, 1,234ms
                 `growMap` over the whole store and 3,990ms re-splitting all of
                 it. **35ms now, and flat** -- the whole-world path is a function
                 of how big the map is and this one of how big the *part* is.
                 What made it possible is that the code already said how far a
                 bake reaches: `bakePart`'s stitch walks out `SKIRT_CELLS`
                 looking for a corner the store holds, which is 4 cells against
                 28 per chunk, so the read is the rectangle plus one chunk and
                 `bakeReadBorder` derives that rather than typing it. Everything
                 else `growMap` wants is manifest-level.
                 The merge rule is one sentence and is what makes it exact rather
                 than approximately right: **the part's regions are authoritative
                 for what is in them, the previous manifest for everywhere else.**
                 That covers a chunk that moved between regions and one that
                 stopped existing, not just the append case -- and it means the
                 border regions a part only *read* come back byte-identical, so
                 writing them again is a no-op rather than a special case. The
                 one thing it cannot express is a region emptied *entirely*,
                 since a part that produces no region for a coordinate is saying
                 nothing about it rather than "it is gone"; that cannot arise
                 from growing, and it is a test rather than a hope.
                 Two things moved with it. `RegionEntry` gained a `cells` count,
                 because the unfilled-rim warning needs each chunk's
                 `cols x rows` -- a chunk on a flank can be short -- and
                 coordinates without sizes could not answer it; it is not hashed
                 into `mapId`, so adding it left every region file and the world's
                 identity untouched. And `writeSplit` stopped deciding staleness
                 by what it was handed to write, which was the same thing while
                 every write was the whole world and **deletes the entire map**
                 the first time it is handed the three regions a grow changed:
                 the manifest is the only thing that makes a region reachable, so
                 the manifest is the only thing that can say a file is not.
                 Spec 220 is the two things that rule was still getting wrong.
                 **A region is a square of the world, so it holds every layer in
                 it** -- it was written one layer to a file, and the format has
                 always promised layers (`heightAt` maxes over them, the mesher
                 skirts them, the wire carries them, `probe-rock.ts` builds a
                 three-layer world) with the editor's Rock and Stair tools the
                 way you make one. The arena's ground covers everything, so every
                 tier collided with it and `splitMap` threw: from the panel that
                 was "Save to maps/" answering `not a map document`, the map
                 unsaveable until the tier was undone, and the download it points
                 at instead unable to be split back. Layers go into a region file
                 in document order and `joinMap` picks its layer **by id** rather
                 than taking `layers[0]` -- which would hand one layer the other's
                 chunks silently, since chunks are chunks either way. Each layer's
                 entry names the shared file: the `hash` is the *file's*, because
                 that is what says the bytes have not drifted, and the `cells` are
                 that layer's *own*, because that is what an unfilled rim is
                 measured against. A one-layer map is byte-identical, so no
                 committed map file moved.
                 And **which files a save made unreachable is a question about the
                 document, not about a disk**: `writeSplit` asked it with
                 `path.join('r', name)` against `regionPath`'s `r/name`. A region
                 path is a *key* -- the manifest names it and both ends compare it
                 as a string -- so the two agree on POSIX, and on Windows nothing
                 matched, every region file went into the stale set, and the last
                 three lines of every save deleted the whole map: a manifest naming
                 224 regions over an empty directory. CI is Linux, so nothing in
                 the tree could see it. The decision is `staleRegionFiles` in
                 `regions.ts` now, and lint refuses `node:*` under `src/terrain/`
                 -- the rule that directory has stated since 204 and could not
                 enforce. A recipe is the only place natural
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
                 vegetation.ts also holds the **buildings** (spec 224): a
                 timber hut under a straw roof, and a well. They are `PropKind`s
                 and nothing else, which is the whole design -- a structure is
                 written into the map document, streamed, collided against,
                 batched per region and taken out by the eraser without one line
                 of any of those asking what kind a prop is. What they are *not*
                 is painted: a tree is scattered by density and a fence laid
                 along a path, and a building goes in one spot turned to face a
                 square, so the editor gives them a press-to-place tool of their
                 own. `HOUSE_PLAN` is the load-bearing number, here beside the
                 kinds for the reason `FENCE_TILE_LENGTH` is: the renderer builds
                 the walls from it and `FOOTPRINT_BASE` derives the collider from
                 it, and two files disagreeing about a hut's plan is a building
                 somebody can stand inside or an invisible wall around one. The
                 collider is the plan's **circumradius**, and the cost is stated
                 rather than hidden -- a rectangle is not a circle, so the choice
                 is between a body that stops about two of its own radii short of
                 a flat wall and a body that can stand in a corner, and erring
                 wide is the fence's own answer to the same question. A well is
                 already a circle, so that one is exact.
                 Since spec 260 there is a **sign** beside them, and it belongs
                 in that list for the list's one membership test: it goes in one
                 spot somebody chose, turned to face the road it is read from,
                 so it is placed rather than painted. What it adds is a
                 **string** -- `Prop.text`, absent by default like `light`, so no
                 committed map gained a key and no `mapId` moved -- and
                 `signText` is the one answer to "what does this say", read by
                 the editor deciding whether it has anything to place, the client
                 deciding whether to offer it, and the bake deciding what to
                 store. Blank, whitespace-only and absent are one state at all
                 three, and a message on a hut is inert rather than an error,
                 which is the rule a `light` on one already follows. Its collider
                 is the **post and only the post**: the board is a metre of air
                 at chest height that a body walks under, and blocking its span
                 would be an invisible wall either side of a stick -- and would
                 put the reach a player has to get inside *behind* the thing they
                 are reading. It is also the one prop field a person is expected
                 to hand-edit: `maps/arena.json` is committed so the world
                 reviews as a diff, and a sentence is the one thing in a prop
                 record that reads as a sentence rather than a coordinate.
                 Since spec 263 there is a **grave** beside it -- a grey
                 headstone on a plinth over a mound of turned earth -- and it is
                 the first member of that list that is not something a village
                 *built*, which changes nothing about how it is placed and is the
                 point: it passes the same membership test, going in one spot
                 somebody chose and turned to face the path it is walked up to
                 from, so a graveyard is a layout rather than a distribution.
                 Two things about it are decisions rather than defaults.
                 `GRAVE_PLAN.stoneHeight` is **44 against a body's 56**, and
                 that bound is the design: a marker taller than the person
                 reading it stops being a grave and becomes a monument, which is
                 a different prop with a different reason to exist. And the
                 collider is the **headstone and only the headstone**, which is
                 the sign's rule applied to the other half of an object -- a
                 mound is loose earth a stride high, and a circle wide enough to
                 cover the plot would take a body and a half of walkable ground
                 out of the world around every grave, which in a graveyard is
                 most of the graveyard. Its three palette tones are new rather
                 than borrowed for one stated reason: every stone in that palette
                 is deliberately *warm* limestone, tuned so a wall belongs to the
                 ground it stands on, and a grave marker is the one piece of
                 stonework here that has to read as cold against it.
                 The mound runs *into* the plinth rather than up to it, because
                 `rockGeometry` knocks every vertex inward by up to half its
                 roughness -- so earth laid exactly against the base comes out
                 several units short of it, and a grave with daylight between the
                 stone and the soil reads as two props that happen to be near
                 each other. Found by looking at `preview-structures.ts`'s sheet
                 and pinned by the test that now fails when the overlap is
                 removed.
                 Since spec 250 it also holds the **light fixtures**: a campfire,
                 a street lamp on a stake, and a standing torch. The same
                 argument one system further along -- a fixture is written into
                 the map document, streamed, collided against, batched per region
                 and taken out by the eraser without one line of any of those
                 asking what kind a prop is -- and they share the buildings'
                 press-to-place tool for the buildings' reason: a lamp is not
                 *painted*, it goes in one spot somebody chose.
                 What a fixture adds is two numbers, and they are optional.
                 `FIXTURE_LIGHTS` authors a colour, a brightness, a reach and the
                 height the flame sits at; `Prop.light` overrides only the two a
                 level designer sets. **Absent is the row**, which is what makes
                 placing forty of them and then deciding they are all too dim one
                 edit here rather than forty in a map document -- and what keeps
                 the whole feature a change nobody's map noticed, since a fixture
                 at its defaults writes no key, so no committed region file's
                 bytes moved and no `mapId` did.
                 **Nothing here casts a shadow**, and that is a decision about
                 how it looks rather than about what it costs. Spec 250 built
                 bake-once cube maps and measured them free -- rendered on the
                 frame a light takes a slot and never again, one lookup per lit
                 fragment and no draw calls after that -- and then took them out
                 anyway: a point light a body's height off the ground throws
                 every trunk, post and body near it outward in a hard radial fan,
                 and four fixtures round a square throw four of those across each
                 other. It reads as broken lighting rather than as evening in a
                 village, and being free does not make it look better.
                 A campfire's **fire is paint rather than geometry** (spec 250):
                 the prop is a ring of stones, four charred logs and a bed of
                 embers, and `fire_camp` in `vfx/brush.ts` is played at the
                 middle of it by `world/fire-vfx.ts`. The cone that used to
                 stand there was the honest first answer and is the wrong one
                 for one reason -- a fire is the only prop in this file whose
                 subject *moves*, so a static solid can only ever be a picture
                 of one instant of it -- and it fought the paint rather than
                 sitting under it.
                 `fixtureLight` is the one answer to "does this glow, and how",
                 with three callers -- the worker composing a region, the editor
                 drawing its ghost, the panel offering the sliders -- for the
                 reason `footprintRadius` is one: a ring the editor draws and a
                 light the renderer hangs are the same fixture, and two files
                 deriving it separately agree until one is edited. An override
                 arrives from a document somebody may have hand-edited, so it is
                 clamped rather than trusted; a number that is *not a number* is
                 not a number too big, so that one falls back to the row instead
                 of being clamped into range.
                 `height` is the field that decides more than `brightness` does,
                 and the reason is one sentence: **the ground is not facing the
                 light.** `brightness` is illuminance at half reach on a surface
                 that is, so what lands on flat ground is scaled by
                 `height / hypot(height, d)` -- a tenth for a flame a body's
                 height up seen from two hundred units, half for one carried
                 twice as high. Two fixtures at the same brightness therefore
                 light the ground quite differently, which is why the campfire's
                 light sits mid-flame rather than in its embers and why
                 `preview-fixtures.ts` prints that number rather than only
                 drawing the picture.
src/sim/         shared geometry (Vec2/Rect/Circle/WorldColliders) plus the pure
                 collision and pathfinding helpers the server collides against.
                 slope.ts is how steep ground is (spec 228), and it is one file
                 because it used to be four numbers -- 0.45, 0.55, 0.6 and 0.8 --
                 two of them under comments claiming agreement with a constant
                 they did not equal, and the one a designer could *see* reaching
                 nothing at all. Before it there was no maximum walkable angle:
                 `isWalkable` compared a rise against `MAX_STEP_HEIGHT`, which is
                 a height **per tick**, so the angle it enforced was that height
                 divided by how far the body had travelled -- 69 degrees at
                 `MOVE_SPEED_HARD_MAX` and **88.4 for a grazer**, the slower body
                 walking up the steeper hill, with a player going up 83.9 degrees
                 head-on and 89.5 by leaning into it. The router meanwhile
                 refused between 67.4 and 73.6 depending on which way the hill
                 faced, because one threshold was applied over a 10-unit run and
                 a 14.14-unit one; and the editor baked a third answer at 28.8,
                 condemning 7.93% of the shipped map where the game refused
                 0.06%.
                 The fix is that **there are two questions and they were one
                 rule**. `MAX_STEP_HEIGHT` is the *jump*: the biggest lip a body
                 gets over, unchanged at 24, still exactly what refuses a tier
                 edge and permits a stair riser -- read as a height it is
                 direction-independent, and reading it as a slope is the whole of
                 where the anisotropy came from. `MAX_WALK_SLOPE` is the
                 *ground*, and being a property of the ground alone it is the
                 same answer at every speed and from every approach, which is
                 what a maximum walkable angle has to mean to be worth stating.
                 Measured after: 67.4 degrees in all twelve cells of the probe's
                 table, and 0.0 degrees of swing across seven aspects.
                 **There is no climb band**, and that is a decision rather than
                 an omission. The first cut had a second threshold with a
                 reduced-pace scramble between the two; a pace is a movement
                 state, a movement state wants an animation, and there is neither
                 one nor a plan for one -- so ground is walked at full speed or it
                 is refused, and `NAV_STEEP`, `NAV_STEEP_COST` and `CLIMB_PACE`
                 went with it.
                 The threshold is `MAX_STEP_HEIGHT / NAV_CELL_SIZE` -- one nav
                 cell of run against one whole step of rise, the steepest ground
                 still describable as a sequence of steps at the resolution
                 routes are planned in, and exactly what the router already
                 refused along a grid axis, so the shipped map's routing is
                 preserved rather than tightened. **It is loose, and this game's
                 own stairs are why.** The line that would mean something is
                 `classify.ts`'s `rockSlope` (0.8, 38.7 degrees), so that "you
                 can walk on it" and "it looks like ground rather than rock"
                 would be one number -- which `editor/nav.ts` has claimed since
                 spec 053 and which no number in the tree was. `bakeStair`
                 forbids it: measured through this very function the steepest
                 flight the generator will build reads **1.50, 56.3 degrees**,
                 because a riser is a whole `MAX_STEP_HEIGHT` over about a cell
                 of run. A stair the sim refuses is not a stair. Bringing the
                 limit down means cutting gentler flights -- more risers over a
                 longer run -- which is a change to `minStairRun` and to every
                 map holding a stair, so it is written down as the follow-up
                 rather than done.
                 Two rules in the measurement itself, each learned by writing the
                 other one first. **It has to span a fixed distance, and that is
                 provable rather than a preference**: a stair is flat treads with
                 short steep risers, and over the game's own baked stair a riser
                 is a gradient of 2.64 over eight units while the flight is 0.6,
                 so from one (rise, run) pair a riser and a smooth 69-degree
                 hillside are the same reading. Nor does an allowance separate
                 them: at 155 units a second it has to sit between 2.7 and 10.5,
                 and at a grazer's 40 between 0.6 and 2.7, and those windows do
                 not overlap. And **it is the gentler side of each axis, never
                 the average**, because a plateau's rim is a *crease* and
                 `ground-decal.ts` already names why sampling cannot see one -- a
                 central difference across a rim averages flat ground with a
                 cliff, so a body on a level plateau is refused a body's width
                 short of its own edge, an invisible wall guarding a drop the
                 jump rule was never going to let it step off anyway.
                 `SLOPE_BASELINE` is `PLAYER_RADIUS` and was measured at both
                 ends against that same stair: at a body's radius the flight
                 reads 0.89, at 24 it reads 2.38 and at 32, 1.79 -- a flight is
                 40 units wide, so samples reaching further than a body do not
                 land on the stair and a walkway comes back as steep as the drop
                 beside it.
                 In the router steepness is a property of the **cell** rather
                 than of a step across it, marked `NAV_BLOCKED` rather than given
                 a grade of its own, so the component flood knows a hillside
                 walls one place off from another exactly as it already knows a
                 lake does and nothing that reads a cell value changed. It is a
                 pass of its own after `gradeNavCells` and **never per tile**,
                 because a cell's slope is read from neighbours
                 `SLOPE_BASELINE` away and a tile clamped at its own rim answers
                 with the wrong ones -- the same reason `labelComponents` runs
                 over the assembled window or nowhere. Graded per tile it
                 disagreed with the world grid on 2,821 cells, which
                 `nav-tiles.test.ts` is built to catch and did. The other thing
                 that pass got wrong is worth keeping: clamping the two sample
                 offsets *independently* divides by zero in the corner, `0 / 0`
                 is NaN, `NaN <= limit` is false, and so every cell along a
                 grid's own rim came back too steep to stand on -- on ground that
                 was perfectly flat, in silence. The reach shortens
                 symmetrically now and a cell with no room on both sides is left
                 alone.
                 On `maps/arena` it refuses 0.03% of the ground, against the
                 0.06% the router already refused -- so what moved is that the
                 number is an angle, not what is reachable.
                 `npx tsx scripts/probe-walkability.ts` is the instrument, and it
                 caught its own fixture being wrong twice: a ramp with a *foot*
                 in it measures the crease rather than the hill and reported 77
                 degrees where the rule enforces 67.4, and a success criterion
                 counting ground *gained* reports the approach angle rather than
                 the slope, since at 85 degrees off the fall line a body barely
                 advances uphill however legal the ground is.
                 avoidance.ts is how two bodies get past each other (spec 187):
                 ORCA, van den Berg et al.'s reciprocal collision avoidance,
                 RVO2's 2D solver transcribed rather than invented. Each
                 neighbour contributes one half-plane of velocities safe with
                 respect to it over the next second; the answer is the velocity
                 nearest the wanted one satisfying all of them, found with a
                 small linear program. Worth transcribing rather than replacing
                 with a repulsion force for two properties, both about what it
                 does *not* do. **It does not oscillate**: a repulsion force
                 reacts to where a neighbour *is*, so two bodies swerve, stop
                 overlapping, swerve back, and shudder down the corridor -- where
                 a half-plane is built from where the neighbour is *going*, and
                 each body assumes the other is solving the same problem and
                 takes exactly half the correction, so one swerve settles the
                 pair. **It does not stop**: the answer is the *nearest* safe
                 velocity rather than a brake, so a body that can go round goes
                 round; slowing down is what it does when there is nowhere to go.
                 That last case is `linearProgram3` -- the relaxation that runs
                 when no velocity satisfies every neighbour at once, finding the
                 one that minimises the worst violation rather than refusing to
                 move, and the single most important function in the file for a
                 dense crowd. What it deliberately does not know about is walls:
                 static obstacles are the nav grid's job and `slideCircle`'s, and
                 ORCA obstacle lines would be a third description of the world's
                 geometry. The failure mode of omitting them is a body that hugs
                 a wall rather than one that walks through it. If they are ever
                 added, `linearProgram3` must be given `numObstLines` and must
                 seed its projection with them -- obstacle constraints are hard
                 where agent constraints are relaxable.
                 neighbours.ts is who is near enough to matter: a hashed uniform
                 grid over body positions, rebuilt each tick by counting sort
                 into flat typed arrays. Rebuilt rather than maintained because
                 every body moves every tick; hashed rather than dense over the
                 world because the map is grown by editing a document and has no
                 extent this module should have an opinion about; and a cell is
                 exactly the search radius wide, so a query is always the 3x3
                 block and never a loop whose length depends on the radius.
                 Results come back in bucket order then insertion order, which is
                 deterministic and is *not* anything a reader would recognise --
                 so `crowd.ts` re-sorts by distance and breaks ties on entity id,
                 because the linear program's answer can depend on the order its
                 half-planes arrive in.
                 nav-tiles.ts is nav that is not sized by the map (spec 205).
                 `createNavGrid` allocates over `colliders.bounds` -- the whole
                 world rectangle -- so route planning cost what the *map* was
                 rather than what was near anybody: 3.08 M cells per body radius
                 and five radii today, 246 M cells and 2.2 GB at the 4x target,
                 and `warmRouting` spending it all at boot. Making terrain lazy
                 does not help, because a lattice is a function of the rectangle
                 alone. So the lattice is cut into **tiles**, built on demand and
                 dropped when nothing is near them, and a **window** -- the
                 rectangle a route is searched in -- is assembled by copying
                 tiles into the flat arrays `findPath` already walks. Measured:
                 `bench-map`'s `navWindow` column is flat while the world grows
                 sixteenfold, where the `navWarm` it replaced tracked the world.
                 A tile is an **interest chunk**, and that is the one number in
                 it that had to be chosen rather than derived: `NAV_CELL_SIZE` is
                 10 and a *map* chunk is 616 units, so 61.6 cells, and tiles of
                 61.6 do not tile a lattice of whole cells -- while an interest
                 chunk is 400, exactly 40, and is already what `activeChunks` and
                 `isSimulated` count in. So a `ChunkKey` is already a tile key.
                 A tile holds heights and one graded `cells` array per radius, and
                 deliberately **no components**: ground sampling is 86% of what a
                 grid costs and is radius-independent, so heights are shared by
                 every radius, while connectivity is not a tile-local property at
                 all and labelling happens over the assembled window or nowhere.
                 Copied rather than looked up per cell, because A* reads
                 neighbours in its innermost loop and that would be a tile lookup
                 on every expansion of every route to save a memcpy that happens
                 when residency changes. Cached at the *tile* rather than at the
                 window because `HEIGHT_CACHE` never evicts -- harmless while
                 there is one grid shape per ground, and one entry per place
                 anybody has ever stood the moment the window moves.
                 Two rules keep a window honest about being one, and the first
                 was got backwards first. **A point outside is refused rather
                 than clamped**: `cellOf` clamps, which is right for a world grid
                 -- outside is a body that walked past the edge of the ground,
                 and `bounds` is explicitly not the play area -- and silently
                 turns "there is no way to my target" into "there is a way to
                 this other spot" for a window, which is the failure
                 `routeToward` already names when it refuses to hand a ring point
                 to `findPath`. **A component touching the edge is never a
                 pocket**, because its true size is unknown and judging it small
                 makes `freeCellNear` refuse a corridor that merely enters at a
                 corner. What the spec asked for and does *not* happen is
                 blocking the window's rim: A* cannot leave a window whatever the
                 rim says, a tile is graded knowing the colliders that reach into
                 it so there is no unsampled ground inside one, and worse, a
                 blocked outer ring is a ring no component can contain -- so the
                 pocket rule could never have fired. The two rules cancelled, and
                 the tests written for them are the only reason that is a
                 correction rather than a bug.
                 `gradeNavCells` came out of `createNavGrid` for this: a tile and
                 a world grid go through **one description of what blocks a
                 body**, which is what makes "a window is the grid the old
                 builder would have made" a claim about one function rather than
                 about two agreeing. It is asserted directly, while that builder
                 is still there to compare against -- same cells, same heights
                 exactly, same route for 49 pairs of points.
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
                 pig-cast.ts is the third of them (spec 231): six poses over
                 1250ms with the hands drawn in to the chest, a coil that creeps
                 for 460ms, and both arms thrown forward at 850. It exists
                 because every spell in the game was drawn as a sword chop --
                 `attackTriggerFor` had two answers and neither was a cast --
                 and the one thing that makes it different from the other two is
                 the reason the fix was not simply a third clip. **It is
                 shared.** `slash` was authored for `melee.slash` and `shoot`
                 for `ranged.shot`, so each one's own beat *is* that ability's
                 wind-up and today's playback rate is already right; every
                 spell in the table casts through this one, and their wind-ups
                 differ by nearly two to one. So its release
                 is rebased per cast by `unit-driver.ts`'s `clipStretch`, and
                 `CAST_RELEASE_MS` was **derived rather than chosen**: the pig's
                 `maxTimeScale` is 2, which put it in `[0.5 * 1400, 2 * 500]`,
                 and the point in that window minimising the worst stretch is
                 the geometric mean, 837 -- 850 being the nearest value on the
                 50ms grid the other two clips are on, and a whole 60Hz sample
                 of a 1250ms clip.
                 Spec 231 then removed both of the rows that fixed those ends,
                 and the number **did not move**, which is the more useful half
                 of the story: what is asserted is the *bound* -- every spell
                 within `maxTimeScale` of the release, comfortably at 1.55x --
                 rather than the optimum, because pinning the optimum means
                 re-authoring a committed `.glb` every time a spell is added or
                 removed, for a change in the worst stretch nobody can see. The
                 four spells left are the sigil ones.
                 Two things in it were learned by getting them wrong, and both
                 are about the *recovery* rather than the cast. **A cast's hands
                 travel further coming home than going out**, because the push
                 starts from the chest and is already half way -- so at the
                 swing's 200ms settle the recovery came back four times faster
                 than the extension, which reads as the body being yanked. Two
                 things fix it together: 400ms of recovery, and a `ready` pose
                 with the hands already up in front rather than where the idle
                 actually leaves them (measured, at `up: 0.058`) -- the one
                 place this file knowingly spends part of its 60ms entry blend,
                 which is what `pig-shot.ts`'s own bow-ready stance already
                 spends. And **the extension is short**: `focus` sits at 720
                 rather than half way, so the release is 130ms and eight frames,
                 near enough the swing's own six. The long readable part of a
                 commitment is the coil; the release is a snap. Everything else
                 is borrowed whole -- `STRIKE_GUARD_LEGS` in every key, so a
                 foot cannot slide by construction, and the strike's rule that
                 the frame the picture lands and the frame the spell lands are
                 the same frame.
                 `scripts/aim-cast.ts` solves its arms and `scripts/arm-solve.ts`
                 is the solver, which is `aim-bow.ts`'s lifted out of it rather
                 than copied: two clips wanted the same descent, and a second
                 copy would be a second set of weights to keep in step. The
                 extraction is behaviour-preserving to the character -- run
                 `aim-bow.ts` and it still prints the numbers committed in
                 `pig-shot.ts`. `npx tsx scripts/make-pig-cast.ts` writes the
                 bytes and `npx tsx scripts/preview-cast.ts` photographs them,
                 and unlike the shot it draws **no bar between the hands**: a
                 draw *is* the distance the hands get apart, so there the bar is
                 a measurement, and a cast holds nothing -- at full extension the
                 hands are a fifth of a body apart and a bar between them is a
                 staff this game has not got. It prints two distances instead,
                 because a cast is two movements, and samples the key times as
                 well as the even step: two of the six authored poses sit between
                 multiples of 50, and the first cut of the strip had neither of
                 them in it.
                 stance.ts is what a stance *is*, as the four things that can be
                 wrong with one (spec 245): where the pelvis sits along the
                 support span from rear ankle to leading toe, and per leg the
                 bend, how far the knee sits off the straight line from hip to
                 ankle, and how much of that offset points **forward**. One
                 description with three callers -- `plant-foot.ts` solves against
                 it, `probe-stance.ts` reads the committed clips through it,
                 `pig-strike.test.ts` asserts on it -- for the reason `pose.ts`
                 is one description of the body's axes: a solver and a test each
                 measuring "is this knee bent backwards" their own way agree
                 until one is edited.
                 That last number is the one it exists for. **`bend` is unsigned**
                 and so cannot tell a knee from the same angle folded the wrong
                 way, which is the whole of "the knees bend backwards"; and a leg
                 solved by pinning two points genuinely has the freedom to get it
                 wrong, since the leg may still swivel about the line between
                 them. It is a *fraction* rather than a distance because the
                 offset is itself set by the bend -- a nearly straight leg has
                 almost none -- so a length would be a demand for a bend as well
                 as for a direction.
                 What it found: the guard all three combat clips stand in put the
                 pelvis **157%** along its own span, past the leading toe, with
                 both feet 0.03 above the ground the idle rests on and the rear
                 knee locked at 10.4 degrees while bracing. One mechanism behind
                 all three -- positive `lateral` carries a hanging limb
                 *backwards*, so `leftLeg: { lateral: 30 }` bought its knee bend
                 by driving the ankle back and up rather than by the knee
                 travelling forward over a planted foot. On this rig those are
                 the same currency: both legs are straight in bind and stand
                 exactly as tall as they are long, and the root may not translate,
                 so **knee bend and foot height are one quantity** and the bend
                 had been paid for out of the balance.
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
src/server/persistence/  SQLite, and the seam it sits behind (spec 226). Nothing
                 in `sim/`, `world/`, `player/` or `data/` knows this directory
                 exists: spec 056 wrote `DataStore` and said a real store would
                 be "a new class implementing the same shape, and no caller
                 changes", and `SqliteDataStore` is that class -- the claim held,
                 and not one file under those four moved to make it work.
                 `node:sqlite` rather than a native dependency, which is the one
                 decision here worth arguing over and comes down to what
                 `npm install` costs: the driver ships with the runtime, so there
                 is nothing to compile and nothing to start. The price is a floor
                 of Node 22.5 (`engines` says so) and an experimental-feature
                 warning on first use, written down in `index.ts` rather than
                 suppressed. WAL, foreign keys, a 5s busy timeout and
                 `synchronous = NORMAL` are set per connection in `sqlite.ts`,
                 each with its reason beside it -- foreign keys especially, since
                 SQLite enforces them only when asked and half this schema's
                 integrity claims are foreign keys.
                 `migrations.ts` is the schema as a numbered list and
                 `migrate.ts` runs it: each migration in its own transaction, the
                 applied set in `schema_migrations` so a shell can answer "what
                 has this database had done to it", and `PRAGMA user_version`
                 mirroring the highest applied version because that is the one
                 piece of schema state a person can read in one line. A database
                 from a *newer* build is refused rather than downgraded -- there
                 is no down-migration and inventing one silently is worse than
                 saying so.
                 The rule that decides what is a column and what is JSON:
                 **a field is a column when something other than the player asks
                 about it.** Currency, level and experience are what an economy
                 audit queries and what a CHECK can defend; everything else --
                 the bag, the worn gear, the attribute spread, the position -- is
                 one document in `players.data`, because none of it is queried
                 across players and all of it is written together. Normalising a
                 24-slot fixed array into 24 rows buys nothing: the atomicity a
                 trade needs comes from the transaction that writes **both
                 players' rows**, not from the granularity of either.
                 `autosave.ts` is the other half of that, and it is the behaviour
                 change rather than the database. `PlayerManager.recalculate`
                 used to end in `store.savePlayer` -- an equip, an unequip, a
                 purchase and a spent skill point all funnelled through it, which
                 is free against a Map and a synchronous disk write against a
                 database -- while *position*, the fastest-changing persistent
                 field there is, was written only at logout. Now a mutation marks
                 a player dirty and this is the only thing that turns dirty into
                 a write. Four rules, each a test: a successful save clears the
                 mark **only if the record has not moved since the snapshot that
                 was written** (identity comparison, because records are replaced
                 rather than mutated, so an edit landing during the await stays
                 dirty); a **failed** save does not clear it, which is the
                 failure mode that matters, since a clean flag over an unwritten
                 change is a save never attempted again; saves for one player
                 never overlap; and two passes never run at once. The clock is
                 injected and the driver is the caller's, so a test drives it by
                 calling `flush()` and never waits for a timer -- and the *dirty
                 marking* lives in `player/`, which is deterministic core and may
                 not read a clock, so **when** to flush is this directory's
                 question and **what** is that one's.
                 What does *not* wait for the loop is anything that moves value:
                 `applyTrade` and the shop settle write immediately. A trade is
                 **persist, then commit** -- both records in one transaction, and
                 only assigned to memory if it lands. The opposite order leaves a
                 failed write with the exchange true in memory and false on disk,
                 so a crash before the next flush un-does half a trade both
                 players watched happen, and which half depends on which record
                 the loop reached first. Judgement rather than a rule applied
                 everywhere: an equip neither creates nor destroys anything and
                 can ride the autosave.
                 `shutdown.ts` is the sequence, out here rather than in
                 `index.ts` so that "runs once" and "cannot hang" are properties
                 with tests instead of two lines nobody can exercise without
                 killing the test runner. What a forced termination costs is
                 documented rather than assumed: up to one autosave interval of
                 position and progression per player, and **never** a trade or a
                 purchase. Verified against a real `kill -9` -- committed
                 transactions survive and `PRAGMA integrity_check` says `ok`.
src/server/auth/  accounts, sessions, guests and claiming (spec 226). An internal
                 module rather than a server: a class the game server
                 constructs, holding repositories, with no port of its own.
                 The three concepts it keeps apart are the design, and they are
                 separate because the interesting cases are exactly where they
                 do not line up: an **account** is who somebody is, a **player**
                 is game progression, a **session** authenticates one client. A
                 guest is a player and a session with no account. A claim is an
                 account arriving *under* a player that already exists. And
                 logging into an existing account while playing as a guest is two
                 players and one person -- a question no design that conflated
                 them can even ask.
                 **Nothing below this directory learns about a password or a
                 login.** What leaves is an `AuthenticatedIdentity` -- ids and a
                 display name -- so game systems operate on stable identifiers,
                 and `net/auth-gate.ts` is all `server.ts` imports, which is what
                 keeps that half portable enough to run in a browser tab.
                 The gate is an **injected capability, exactly like
                 `adminVerifier`**. Supplied (`index.ts`), a `Hello` must carry a
                 session token and the `playerId` on the frame is *ignored* --
                 which is the whole of "credentials cannot be forged merely from
                 knowing a player id". Omitted, the client names itself, which is
                 this server's original behaviour and the right answer for the
                 three callers with nobody to authenticate against: the in-tab
                 single-player server, the bot harness, and the tests. One
                 ordering in `hello` is load-bearing and was got wrong first: the
                 gate resolves **before** the player id is validated, because a
                 real client's first `Hello` carries an empty one -- it does not
                 have an id and is not supposed to invent one -- so validating
                 first refused exactly the clients doing the right thing.
                 `passwords.ts` is scrypt from `node:crypto`: RFC 7914,
                 memory-hard, in the standard library, so no native build and no
                 third implementation of "hash a password" in the tree. The
                 encoded form is self-describing (`scrypt$N$r$p$salt$hash`), so
                 raising the cost later leaves every existing hash verifiable --
                 `verify` reads the parameters out of the stored string rather
                 than assuming today's -- and comparison is `timingSafeEqual`,
                 never `===`, because a byte-at-a-time comparison of a hash is a
                 byte-at-a-time oracle for it. `tokens.ts` is the other half and
                 the difference is the input: a password is low-entropy and
                 guessable so hashing it has to be *slow*, where a 256-bit random
                 token has nothing to guess, so its only job is that a stolen
                 database is not a set of working credentials -- sha256, because
                 a token lookup happens on every connection and scrypt there
                 would be 100ms of the handshake. What is stored is the hash;
                 the token is returned once and never written down.
                 A claim is one transaction and cannot happen twice, and that is
                 two mechanisms rather than one: `attachToAccount` carries an
                 `account_id IS NULL` guard **in its WHERE clause** (a
                 check-then-write is two statements with a gap; this is one
                 statement whose own answer says whether it won), and
                 `players.account_id` is `UNIQUE`. A refusal throws, which rolls
                 back the account row inserted above it -- so a failed
                 registration leaves the guest player exactly as it was, still
                 unowned and still playable.
                 The conservative half: **logging into an existing account never
                 merges and never deletes.** It loads that account's own player;
                 the guest character is untouched, its session still valid, and
                 `retainedGuestPlayerId` reports it so the UI can say what is not
                 coming with them. An automatic progression merge is deliberately
                 not invented.
                 `http.ts` is the surface -- `POST /api/auth/{guest,register,
                 login,logout,session}` -- and it is HTTP rather than six new
                 wire messages for three reasons: the handshake already has to
                 happen before a socket is useful so there is no ordering to
                 invent, `curl` is a debugging tool a developer has on day one
                 where a binary frame needs a harness, and the `Hello` frame
                 stays one field wider instead of six messages heavier. An
                 unknown login is verified against a **dummy hash** so it costs
                 the same as a real one -- the generic error message is only half
                 the defence against an account-existence oracle, and the timing
                 is the other half. Its headers are deliberately **open** to any
                 origin, and the reason is that nothing here is authenticated by
                 an ambient credential: there is no cookie, every request carries
                 its bearer token explicitly, so a hostile page can make a
                 browser send a request and cannot make it send somebody else's
                 token. `Access-Control-Allow-Credentials` is absent for that
                 reason and must stay absent if a cookie is ever added. The
                 socket beside it already accepts any origin -- `WebSocketTransport`
                 checks none -- so locking the HTTP half down would have
                 protected nothing and broken `?server=` pointing anywhere, which
                 is the whole shape of this client.
                 What CORS **cannot** do is the case that shipped broken: with a
                 bare `?server` the client dials its own origin, so in
                 development the sign-in request goes to *vite* and never leaves
                 it. That needs an `/api/auth` entry in `vite.config.ts`'s
                 `server.proxy`, and its target is `httpOriginOf(GAME_SERVER)`
                 rather than the variable -- `http-proxy` picks its transport
                 with `target.protocol === 'https:'` while defaulting the port
                 with `/^https|wss/`, so a `wss:` target sends **cleartext to
                 port 443**. The conversion is the client's own function,
                 imported rather than repeated, so the proxy target and the URL
                 the browser builds cannot disagree; `dev-proxy.test.ts` asserts
                 that relationship, and re-imports the config under a stubbed
                 `GAME_SERVER` because CI never sets one and the default is the
                 one value that is right by accident.
                 `pathnameOf` is the other thing a socket found and no test had:
                 `request.url` is the target verbatim, and RFC 9112 allows
                 absolute-form, which `startsWith('/api/auth/')` declines -- a
                 correct request, refused, with the endpoint sitting right
                 there. And `index.ts`'s request chain has a `.catch` now,
                 because it had none and was fired with `void`: a malformed
                 `Host` header makes the studio router's `new URL` throw before
                 its own try/catch, and one such **unauthenticated** request
                 killed the process. Both verified against raw sockets.
                 `src/ui/screens/account.ts` is where a player reaches any of it
                 (spec 226), and until it existed the claim was a feature nobody
                 could press: a guest's character is claimable by one POST, and
                 every playtester stayed anonymous and one cleared browser away
                 from losing everything. Pure like every screen, with two stated
                 departures. It **holds the draft**, because what somebody is
                 half way through typing is not something a server knows or
                 should -- the account itself still arrives through `setAccount`
                 and is never inferred from a button having been pressed. And its
                 **validation is injected**: `world/account-model.ts` runs the
                 server's own `validateLogin`/`validatePassword` against the
                 draft, so a greyed-out button and a refused request cannot
                 disagree about what a legal login is. The one rule the screen
                 adds is that the two password fields match, which is a fact
                 about a form -- there is one password on the wire.
                 The line it exists to get right is the warning under Sign in.
                 `AuthService.login` never merges and never deletes, so the guest
                 character genuinely is still there; but the **browser holds one
                 token and signing in replaces it**, so from where the player is
                 sitting that character stops being reachable. A warning that
                 said "it stays where it is" would be true about the database and
                 a lie about their evening, so it says so plainly and names the
                 alternative -- which is why Register is the tab that opens first.
                 `TextField.masked` is the one widget change, and it is a
                 *painting* rule only: `text` still answers what was typed and
                 the caret still counts real characters, because a mask that
                 reached the value would be a second, lossy copy of it. `*`
                 rather than a bullet, since this font has a fixed symbol set and
                 a missing glyph draws as a solid block.
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
                 eleven (the HUD, the bag, the sheet, the shop, the keybindings,
                 the trade table, the options window, its display page, the
                 chat, the action bar and the selected-unit readout);
                 input/ is the actions, the control map and the two preferences
                 that
                 outlive a session -- the bindings and the interface scale, each
                 a versioned document over an injected `StorageLike` that never
                 throws, because a corrupt preference must cost defaults rather
                 than a black screen.
                 Since spec 189 a `Chord` names a **control** rather than a key,
                 and the mouse is in it. Spec 125 deferred this with one line --
                 "the chord type has no button field yet" -- and the cost was not
                 a few missing bindings: the window listed the skillbar and the
                 debug readout while the four things a player does all session
                 were `if (event.button === 2)` in `world/view.ts`, with no id, no
                 label and no row. The type still has no button field, because
                 nothing between `chordOf` and the index ever opened `code` --
                 `chordKey` joins it into a string, `chordsEqual` compares the
                 join, `reindex` keys on it, `readChord` takes any non-empty
                 string, `actionsForCode` compares with `===`, and only `keyLabel`
                 and `UNBINDABLE` look inside. So `code` carries `MouseRight` and
                 `WheelUp` beside `KeyW`, and the persistence, the index, the
                 conflict report and the release path cost nothing and needed no
                 version bump. What decides whether a code is a pointer one is
                 `POINTER_CODES`, a **closed table** rather than a `Mouse` prefix,
                 for the reason `naming.ts` is a table: a heuristic is a second,
                 invisible answer that every boundary has to re-derive, and it has
                 nowhere to put the label. The version deliberately does not move
                 -- an older build reading a profile with `world.order` in it
                 skips an override naming an action it has never heard of and
                 keeps every other binding, where a bump to 2 would make
                 `migrateBindings` throw the whole document away, so trying this
                 build and going back would cost a player every keyboard rebind
                 they had ever made. Five rows cover the seven verbs, and the
                 arithmetic is the design: pick up / attack / walk are **one**
                 press whose meaning is read off what is under the cursor (spec
                 070), and refusing a pending aim is the same shape one level up,
                 so `world.order` is one action with four readings exactly as it
                 was one branch with four -- five since spec 260, which added
                 *read a sign* and is the first of them that acts on something
                 the server has never heard of. Three bindings a player could put
                 on three different buttons is not a preference, it is a broken
                 order. The labels avoid every word `keyLabel` already makes:
                 `Right` alone is taken -- it is what `ArrowRight` comes back as
                 -- so the pointer says `Right Click`;
                 Since spec 251 a window has an **X in its title bar**, and
                 the interesting part is that nothing had to be invented for it:
                 `closable`, `onClose` and `requestClose()` have been on
                 `UiWindow` since spec 124 with `requestClose` reaching no caller
                 anywhere in the tree, and `icon:close` has been in the atlas
                 since 123 drawn by nothing. Escape and whichever key opened a
                 window were the only ways to shut one, and neither is visible.
                 Its geometry is **derived rather than authored**, from the two
                 numbers that already set the bar: a square as tall as the body
                 font, its right edge inset by the same `padding` the title's
                 left edge is. Centring falls out of the first -- the bar is
                 `font.height + padding`, so a square of the font's own height
                 leaves exactly half the padding above and below, which is what
                 the `heavy` frame's 2px border occupies -- so the X clears the
                 accent edge on all four sides with no third constant to keep in
                 step. The same length is reserved out of the title's clip and
                 out of `minWidthFor`, or spec 147's floor ("a window is never
                 narrower than its own name") would stop meaning what it says the
                 moment the name ran under the button.
                 Three rules, and two of them are about **where a press goes**,
                 because this is the only control in the framework that lives
                 inside a drag handle. It **swallows the press**: the router
                 already sends the *gesture* to whichever widget took it, but
                 `onEvent` runs on the bubble walk afterwards and
                 `UiWindow.onEvent` would record a drag origin from a press it
                 never took -- and nothing clears that, since `dragEnd` goes to
                 the button, so the next press landing on the window's own
                 padding band drags it from a stale origin. The comment on that
                 method has claimed since 124 that "the close button takes the
                 press first"; this is what makes it true. And **its rest colour
                 is the title's**: the window's focus picks between `normal` and
                 `focused` exactly as the name beside it does, because a dim X on
                 a focused window's accent bar reads as disabled rather than as
                 quiet -- hover and pressed beat both, and are the only two
                 states that draw chrome at all, a box around the X at rest being
                 a second frame inside the one bold thing the interface is
                 allowed.
                 The third is one level out and is where the real bug would have
                 been. **`WindowManager.close` is not the whole of closing.**
                 `register` aims a window's `onClose` at the manager, which is the
                 whole story for the gallery and half of one in the game:
                 `UiScreens.close` tells the server to stop sending a vendor's
                 stock and cancels a live trade. So `registerWindow` re-points
                 `onClose` at that method, and the X, Escape and the key that
                 opened the window are one close with one set of consequences --
                 without it the X would shut the trade window with the trade
                 still on, which is exactly the state spec 170 closed for Escape.
                 What this deliberately does **not** reach is anything that is
                 not a `UiWindow`: the chat log, the action bar, the
                 selected-unit readout and the dialogue bubble are docked
                 furniture with no title bar, and the Play tab's six settings
                 popovers and every `lil-gui` panel in the editor, the sandboxes,
                 the Studio tab and the SFX tab are not built on this framework
                 at all.
                 Since spec 198 a `TabPanel` scrolls its **own body**: each
                 tab's content is wrapped in a scroller when it is built, so the
                 strip is that scroller's *sibling* and **a tab strip is never
                 inside the thing it scrolls**. That is a fact about the widget
                 tree rather than a rule a screen has to remember, and it exists
                 because whether a tabbed screen scrolled used to be the mount's
                 decision -- and neither answer it can give keeps the tabs
                 reachable. Wrapped in one `ScrollView`, which is what the mount
                 does to every screen, reading the bottom of the character
                 sheet's skill tree scrolled the tab headers clean off the top of
                 the window and there was no way back to Attributes without
                 scrolling up first. *Un*wrapped, which is how the options window
                 is registered, a keybinding category with more rows than the
                 window is tall met `Linear.shareSpace`'s overflow branch instead
                 -- every row shrunk toward nothing, no bar, and the rows at the
                 bottom unreachable rather than merely off screen. It costs
                 nothing where nobody wanted it: a `ScrollView` offered an
                 unbounded height measures to its content, so a panel inside
                 somebody else's scroller still scrolls nothing and behaves
                 exactly as it did. One scroller **per tab** rather than one for
                 the body, because spec 124's rule reaches the offset too -- the
                 comment that rule is written under names "a scroll position" as
                 one of the things nobody thinks of as state, and a shared
                 scroller clamps a long tab's offset against a short tab's
                 content the moment you switch. Two consequences worth knowing.
                 A screen that pins a band *above* the strip has to hand the
                 wheel down (`CharacterScreen.onEvent` into `wheelBody`), since a
                 notch over the heading has nothing above it that scrolls and a
                 window that scrolls everywhere except its own top inch reads as
                 a broken wheel. And a hit test against a tab's rows has to be
                 inside `bodyViewport()`: a row scrolled out of the body keeps
                 the rectangle it was last arranged into, which is the same class
                 of bug `showing()` was written for, one level out.
                 Since spec 199 `combat.stop` is a control rather than a row.
                 It had been listed under Combat, bound to `X`, rebindable and
                 saved since spec 125 and reached **nothing** -- spec 183's
                 finding one tab over, and for the same reason: every action that
                 was not a move, a slot, a window or the cancel fell off the end
                 of `decideControlDown`. It ships on `Space` now and drops
                 everything a body is committed to in one press: the wind-up, the
                 standing attack order, the walk over to a drop, the walk over
                 to somebody to talk to (spec 257), a pending aim, a confirmed
                 one, the click-to-move order and its route, and whatever is
                 held. The id does not move, because a stored profile
                 references it; the label does, because "Stop" beside "Cancel
                 cast" does not say which is which. Three rules. It is
                 **unconditional** -- Escape asks whether anything is committed to
                 and reaches for the menu when nothing is (spec 135), and one
                 control that sometimes opens a window is enough. **Nothing new
                 crosses the wire**, because stopping is the *absence* of a
                 request: `moveIntent` yields (0,0) and the server stops the body,
                 and the one thing that does need saying is already
                 `CancelCast`. And **a control still physically down is disarmed
                 until it is let go**, which is the rule the feature does not work
                 without and the one no test in this tree could have found: a held
                 key repeats `keydown` at the platform's own rate and `onKeyDown`
                 has never read `event.repeat`, so every repeat put `move.north`
                 straight back in `held` and the walk somebody asked to stop
                 resumed on its own half a second later. It catches the stop's own
                 key first -- Space held down fires once rather than sending
                 `cancelCast` thirty times a second. `npx tsx
                 scripts/probe-stop.ts` is the half no headless test can see, and
                 the measurement that makes it honest is that it checks the
                 browser *marked* its synthesised presses as repeats before
                 believing what it measured from them: a stop that "held" against
                 events that were never repeats is evidence of nothing. It reads
                 `data-orders` (what has been asked for, in a fixed vocabulary, so
                 a missing word is a specific drop that did not happen) beside
                 `data-self-at` (whether the body is actually still moving), and
                 needs both -- a stop that cleared the bookkeeping and left the
                 legs running is the failure worth catching, and the first
                 attribute alone would report it as a pass;
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
                 chat.ts is the ninth and the only one that is not a window
                 (spec 189): docked bottom-left in the `hud` layer, no title
                 bar, never dragged, nothing in the layout store, because it is
                 furniture that is always there rather than something the player
                 opened. It exists because the chat protocol was finished at
                 both ends and neither end had a caller -- `GameClient.say` and
                 `GameClient.onChat` had none anywhere in the tree, so the
                 `System` line the server sends on every death and every admin
                 broadcast were encoded, framed, sent, decoded and handed to an
                 empty listener list.
                 Three rules, and the first is the one that decided its whole
                 shape. **It wipes rather than fades**, and it sits on the one
                 plate in this framework that blends. Leaving is a clip, the way
                 a window arrives (spec 133): computed while painting, anchored
                 at the bottom so the oldest line goes first and the one
                 somebody is still reading goes last. It costs no layout, and
                 `animate` answers reduce-motion centrally by snapping. A
                 fade-to-nothing has nothing to fade *into* -- the UI canvas is
                 cleared to transparent, so the background a departing log would
                 dissolve towards is not a colour anything here can name.
                 The plate is the framework's **only** blend, and the reason it
                 is allowed is that the exception is measured rather than
                 waived. `budget.test.ts` refuses a translucent quad because a
                 source-over is the one operation `raster.ts` and a browser
                 canvas round differently: a canvas stores premultiplied 8-bit
                 and `getImageData` unpremultiplies, so a straight-alpha colour
                 over a transparent pixel comes back rounded where `raster.ts`
                 writes it through untouched. At 0.62 this plate came back
                 `rgb(27,24,39)` in Chromium against `rgb(28,25,39)` in the
                 rasterizer -- which is what `preview-ui-gallery.ts` reported
                 before the number was chosen. But the round trip is lossy only
                 for *some* alphas, and `PLATE_ALPHA` is one of the values where
                 `round(round(c * a / 255) * 255 / a) === c` holds on every
                 channel of `panelSunken`, so both backends agree byte for byte
                 and the comparison stays **exact**. A tolerance would have
                 hidden every future blending mistake along with this one; a
                 chosen constant hides nothing, and `budget.test.ts` asserts the
                 property so a change to either end of it fails in `npm test`.
                 The fix if it ever does is a neighbouring alpha, never a looser
                 check. One plate for the whole surface, drawn by the screen
                 rather than by the scroller and the field separately, because
                 two would overlap where they meet and the seam would be a third
                 colour -- so those two are drawn chromeless, the field keeping
                 the frame and focus ring that say "you can type here" and
                 losing only its fill. Every glyph stays opaque: what is
                 see-through is the backing and nothing else.
                 And **nothing is drawn when nothing has been said** -- not the
                 lines, not the scroller, not the plate. An empty plate over the
                 world is a black bar announcing that the chat exists, which is
                 the opposite of furniture. That decision is taken *before* the
                 "have the lines changed" early-out, because an empty list is the
                 one case that matches what is already shown: `sameLines` is true
                 from the first frame, so a visibility settled after it is a
                 decision never taken.
                 **The field pushes `textEntry`**, which is what makes a typed
                 `1` a one rather than a cast. That context has existed since
                 spec 123 to justify `TextField` and nothing had ever pushed it:
                 `setFocused` had no caller either. Which means a press landing
                 anywhere else has to close the chat -- focus moves on its own,
                 the field pops the context only when it is *told* it lost
                 focus, and a stranded push swallows every key in the game from
                 then on, the same failure a stranded keybinding capture used to
                 cause.
                 And **colour comes out of the nineteen that exist**: `focus`
                 for a speaker's name, `text` for what they said, `textDim` for
                 a death notice, `accent` for an operator's broadcast. The cap
                 is against *invented* colour and a channel is not a new thing
                 in the world -- it is three tones already doing what they mean.
                 The mount adds two of its own. Up and Down are asked directly
                 rather than routed, because `TextField` swallows every key it
                 is given and answers the arrows it cares about itself, so a
                 routed `ArrowUp` reaches the field and stops -- the same reason
                 a keybinding capture is asked from the one place that sees
                 every key. And **the wheel is only taken while the field is
                 open**: the wheel is camera zoom in the Play tab, and a log
                 that took it whenever the cursor happened to be bottom-left
                 would break zoom in one corner of the screen with nothing drawn
                 there to explain why.
                 dialogue.ts is the bubble (spec 246), furniture in the same
                 register as those two -- no title bar, never dragged, nothing in
                 the layout store, because it is not something the player opened.
                 What makes it different is that it is **anchored to a body**, so
                 `DialogueDock` places it at a *point* where `Anchor` places at
                 one of nine sides; the mount hands in that point each frame and
                 nothing here knows what a world position is or how one becomes a
                 pixel.
                 It shares two of the neighbours' rules and inverts the third.
                 **Nothing is drawn when nobody is speaking**, settled before the
                 has-anything-changed early-out, which is the trap `chat.ts`
                 names and `selected-unit.ts` repeats. Its **width is fixed**,
                 `selected-unit.ts`'s reason one step further: this box is centred
                 on a moving body, so a width following its content would move
                 *both* edges every time a character was revealed, and a bubble
                 that grows while you read it is worse than one sometimes wider
                 than it needs to be. And the **pointer does not pass through** --
                 a readout is something you look at *through* and a bubble with
                 replies in it is something you press, so a click on a reply
                 cannot also be a click on the world, by the panel being opaque to
                 the hit test rather than by anything remembering to swallow an
                 event. Its dock still is transparent, or the empty
                 three-quarters of the frame would eat every click meant for the
                 ground.
                 The replies are rebuilt **only when the list changes**, since a
                 screen tearing down four buttons a frame loses the hover state on
                 the one under the cursor between the press and the release; and
                 they are withheld entirely while the line is still typing,
                 because a reply that could be pressed before its question had
                 finished being asked is a reply to something unread.
                 action-bar.ts and selected-unit.ts are the two screens spec 192
                 added, and both are the chat's kind of furniture: docked in the
                 `hud` layer, no title bar, never dragged, nothing in the layout
                 store. The bar is five `SkillSlot`s -- the widget written for
                 the job in spec 128 and mounted nowhere but the gallery for
                 sixty specs, while the shipped bar was five `<button>`s of
                 inline `cssText` with their own borders, their own dimming and
                 their own cooldown shade. Two implementations is two answers to
                 "what does a slot on cooldown look like", and the shipped one
                 was the one nothing could test: `hud-layout.test.ts` could
                 assert the *sum* of the boxes and no test in the tree could
                 assert what was drawn in one. There are five golden frames of
                 it now, which is five more than the bar has ever had.
                 The one thing about it that is not simply "the framework's own
                 slot" is that **its size is told rather than chosen**, and the
                 reason is worth knowing because it is the trap: a bag cell is a
                 thing you look at and these are **tap targets**, and the
                 interface scale is picked by two different constraints at the
                 two ends of the range -- a phone's by how many device pixels a
                 finger covers, a desktop's by how much has to fit on screen.
                 There is no single number of UI pixels that is right at both:
                 20 is a row of 20 CSS-pixel squares on a desktop, and 40 is
                 107 CSS pixels tall on a 390-pixel phone. So `ACTION_SLOT_CSS`
                 lives in `hud-layout.ts` beside `MIN_TAP_PX`, which is the file
                 that has always stated how big a thing a finger must hit, and
                 `ui-layer.ts` converts it -- the one place the two kinds of
                 pixel meet. The conversion is re-applied on every resize, since
                 the scale is what it turns on.
                 That the bar left the DOM is also why `HudLayout` no longer has
                 a `slot`: `centredClearance`, `poolClearance` and `poolBottom`
                 take the bar's **measured** box instead, pushed back across as
                 CSS pixels, because a second calculation of the bar's width on
                 the DOM side would be a second description of this one -- the
                 mistake that put the chat log on the weapon switch. `poolBottom`
                 clamps at the floor for the state that box has before the
                 interface has laid itself out once: centring on nothing would
                 put the pool block over the experience strip.
                 What is centred is the **bar**, and the pools hang off its
                 left: the slots are what an eye goes to and what everything else
                 centred on screen lines up with -- the experience strip that
                 spans the frame, the death overlay, the loading bar -- so
                 centring the whole band instead puts the slots visibly right of
                 the frame's own middle. `POOL_TO_BAR_GAP` is the space *beside*
                 the block and is its own number: sharing `poolGap`, which is the
                 space *inside* it, had the two hugging.
                 A slot has a **tooltip**, which the DOM buttons carried as a
                 `title` and a canvas has no way to: it is the framework's own
                 `Tooltip` in the same layer as the bag's, composed through spec
                 191's `describeAbility` rather than a sentence written for the
                 bar, with each line keeping the *tone* that vocabulary gave it
                 -- `src/ui/` turns a tone into a colour without ever learning
                 what one means. An empty slot says nothing, because "no skill
                 assigned" is a box that pops up to state what a player can see.
                 The bar's box carries a **`bottom`** as well as a size, and that
                 is the fix for the one thing the DOM half could not be right
                 about on its own. It knows what the frame's floor holds -- the
                 experience strip -- and the interface adds its own margin above
                 that, so a pool block placed at `bottomEdge` sat eight pixels
                 below the row it was meant to be centred on. Measured and handed
                 over, like the width, for the reason the width is: a second
                 description of somebody else's layout is the mistake that put
                 the chat log on the weapon switch.
                 Two more the first cut had, both of the same kind -- a rule that
                 held for wide buttons and not for squares. Every slot drew
                 `item:unknown`, because `abilityIconFor` had no row for spec
                 188's four skills or for the flask, so the first thing a player
                 with sigils equipped saw was five identical question marks; the
                 four skills are authored sprites now and the flask takes
                 `item:potion`, being a *thing* rather than a skill. No golden
                 could have caught that -- a golden names its sprites by hand --
                 so `action-bar-model.test.ts` asserts the mapping, which is
                 where a table lookup belongs. And the vial's charge count sat
                 bottom-right against a bottom-left key label: `3/3` is 17 font
                 pixels and a key is 5, which fits 46 and does not fit the 23 a
                 chunky interface scale converts one into, so the badge moved to
                 the top-right -- empty in every state -- and the side is floored
                 at `SLOT_SIDE`.
                 selected-unit.ts is the readout in the opposite corner, and its
                 four rules are the chat's and the stun swirl's over again.
                 **Nothing is drawn when nothing is selected** -- settled before
                 the has-anything-changed early-out, because an empty selection
                 is the one state that matches what is already on screen, which
                 is exactly the trap an empty chat log falls into. **The eight
                 status rows are shown and hidden**, never created, so a fight
                 costs field writes. **The pointer passes straight through**,
                 everywhere: the world is underneath and a readout that took a
                 click would be a hole in the game in one corner of the screen.
                 And **the fade is `textDim` rather than an opacity**, because
                 nothing in this framework blends. Its width is fixed, which is
                 the one thing it overrides `measureSelf` for: anchored to the
                 *right* edge, a width that followed the longest row would slide
                 its left edge inward every time a status expired, and a readout
                 that moves while you are reading it is worse than one that is
                 sometimes wider than it needs to be.
                 `world/chat-log.ts` is the client state beside it -- a capped
                 scrollback, a ring of the lines this player sent, and the one
                 timestamp `revealAt` measures. Pure, and stamped with the
                 frame's time rather than a clock of its own, for the reason
                 `error-log.ts` gives: a line arrives on a network callback,
                 outside the frame loop, and a frame is a few milliseconds
                 against a ten-second quiet window.
                 Nothing is echoed locally, because `broadcastMessage` sends to
                 every connection with a player on it and the sender is one of
                 them.
                 `npx tsx scripts/probe-chat.ts` is the half no headless test
                 can see: two tabs, two players, one real server, and a line
                 typed in one turning up in the other. It found the layout bug
                 every green test had missed -- the log drawn straight over the
                 weapon switch, because `setSafeBottom` had been *derived* from
                 the pool bars, which sit lower and further right than the thing
                 actually in that corner. It is measured off `data-hud-bottom`
                 now -- *plus* a margin, since clearing something by nothing is
                 still sitting on it -- and the probe reports which furniture it
                 found lowest, because its own first cut measured the pool bars
                 and passed while the log sat on the switch beside them: a
                 clearance check against the wrong thing is worse than none,
                 since it reads as evidence. Its walk check is every direction
                 rather than one, for the same reason in miniature: a body
                 pressed into one of the arena's trees reports a working
                 keyboard as a broken one, and it did exactly that once.
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
                 Since spec 188 the bag has a **skill row** under the grid: the
                 four `skill1..skill4` equipment slots, laid out four across in
                 key order, which is the same four the action bar draws along
                 the bottom of the screen. Under the bag rather than beside the
                 paperdoll on purpose -- the paperdoll is a column of worn
                 things beside a body, and these want to look like the bar they
                 mirror -- and the cells share **one** list with the worn ones,
                 indexed by equipment ordinal, so a `SlotRef` means the same
                 thing whichever group it landed in and a drag into the skill
                 row cannot address a helmet. `ContainerView.skillSlots` is the
                 second list handed in; the screen still renders what it is
                 given and decides nothing about how many slots there are.
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
                 Since spec 185 an item also *says* what it is, and the colour it
                 says it in is the one it was lying in the grass: the three tier
                 colours moved out of `drop-rig.ts` into the palette, and the drop
                 reads them back, so the bag and the ground cannot drift and a
                 test in `drop-rig.test.ts` fails if they do. That took the
                 palette cap from 16 to 19, which is the cap doing its job rather
                 than being waived -- it is against *invented* colour, and these
                 three are the world's own. Three rules came out of drawing it.
                 The tier goes **behind** the icon rather than on it: the sprites
                 carry their own colour, so tinting an orange trinket gold and
                 grey gives two oranges nobody can tell apart, where a wash on a
                 near-black cell is the same three bytes whatever the icon is
                 made of. That wash is **composited into an opaque colour before
                 it is drawn**, with the rasterizer's own `over`, because nothing
                 in this framework blends -- a source-over is the one operation
                 the software backend and a browser canvas round differently, and
                 `budget.test.ts` refuses one at draw time. And **common is not
                 washed at all**, which is the whole contrast: ordinary loot looks
                 exactly as it did, so the mark means "this one is not ordinary"
                 rather than announcing which of three tiers everything is -- the
                 same argument `restFlare` settles on the ground, where a common
                 drop's curve is flat at the dimmest value there is. A `Tooltip`
                 now takes lines as well as prose, wrapped **per line** so a long
                 name folds without swallowing the stat under it, and what a line
                 is worth saying is decided outside `src/ui/`: the view-model hands
                 over a *tone* -- good, bad, dim, the item's own tier -- and this
                 layer says what a tone looks like. The one line decided here
                 rather than there is `Requires level N`, because it is the only
                 thing about an item that depends on who is holding it.
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
src/render/audio/  the audio framework (spec 229), and the one place in this repo
                 that owns an `AudioContext`. It exists because every seam an
                 audio system plugs into was already cut and connected to
                 nothing: `src/ui/core/sound.ts` declared a `SoundSink` and a
                 closed `UiSoundId` vocabulary in spec 133 and nothing ever
                 assigned the sink, so every widget in the game emitted into
                 `SILENT`; `server/data/loot.ts` authors four cue **names** under
                 the words *"the renderer decides what a name sounds and looks
                 like"* and `playCue` dropped all four; `vfx/types.ts` has had
                 `SoundSpec { cue, on }` on every emitter since spec 121,
                 compiled and fired at three sites into a `VfxHooks.sound` that
                 `scene.ts` did not supply, with the comment *"a sink today;
                 there is no audio system to wire it to"*; and `onCastStarted`
                 has carried the ability id, the phase and all three ticks since
                 spec 144 with **no listener in the shipped renderer**. Four
                 finished halves of four features.
                 The split is `src/ui/render/`'s, one layer up: everything is
                 pure except `engine.ts`. `events.ts` is the vocabulary -- a
                 closed table of 57 rows, each naming a moment that **already
                 happens** in this game, with a bus, a section, a placement and a
                 sentence saying what fires it. There is no `player.jump` because
                 nothing jumps and no per-monster voice because the roster is
                 seven rows. `catalog.ts` is the document format, `variants.ts`
                 is which take at what pitch, `mix.ts` is the per-bus levels over
                 an injected `StorageLike`, and `sink.ts` is the `Audio`
                 interface plus a `SILENT_AUDIO` -- which is what `npm test`
                 runs, so `presentation-only.test.ts` drives the whole layer in
                 Node with no `AudioContext` anywhere.
                 Four decisions are worth knowing.
                 **The listener sits at the player, not the camera.** This camera
                 is orthographic and parks a *constant* 6,000 units from its
                 focus -- only the two orbit angles are reachable from a slider
                 -- so across the visible frame its distance to a source varies
                 by under 7%. A camera-mounted listener gives every sound in the
                 game identical attenuation and collapses every pan angle onto
                 the view axis. Two systems here already hit that and rebased
                 onto the focus: `inkOrigin` says so in as many words, and the
                 animation LOD's comment records every unit in the game reading
                 as maximally distant. The *orientation* is the camera's bearing
                 flattened onto the ground plane, and that is not an
                 approximation of the camera's own basis -- `camera.up` is never
                 assigned, so the camera's right vector is exactly horizontal at
                 every elevation and `forward x up` reproduces it exactly. What
                 it buys is that the Height slider's 10-to-85 degrees cannot
                 start re-mapping altitude into depth. Read from
                 `camOffsetCurrent` rather than `camera.position`, because
                 `applyPixelSnap` moves the camera onto the virtual pixel lattice
                 for the draw and sub-pixel jitter in a pan is the same hazard
                 picking is deliberately kept off the snapped matrix for.
                 **`maxDistance` is a cull, not a fade.** The Web Audio `inverse`
                 model clamps distance into `[ref, max]` and never reaches zero,
                 so a source at the far edge plays forever at a small non-zero
                 gain and forty of them is a wash of noise from things nobody can
                 see. Culling at the moment a voice would have been allocated is
                 what makes the range mean what a designer thinks it means, and
                 it costs nothing -- one decision, once, and a sound already
                 playing is never cut so there is no boundary artefact.
                 **There is no voice pool**, and that is a fact about the API
                 rather than a shortcut: `AudioBufferSourceNode` is single-use by
                 spec and is designed to be cheap to allocate for that reason.
                 What exists instead is a voice **cap**, the distance **cull**,
                 and a per-event **cooldown** -- because the thing that actually
                 goes wrong is `skill.whirlwind` resolving against eight bodies
                 on one tick, and eight copies of one recording starting on the
                 same sample are not eight sounds, they are one sound about 2.5x
                 as loud with a comb filter across it. The extension point is
                 stated rather than left to be guessed: if the cap ever starts
                 refusing sounds a player wanted, the fix is priority (refuse the
                 *furthest* live voice and steal its slot), not a pool.
                 And **randomness and time are arguments**. `variants.ts` takes a
                 `Random`, the throttle takes a `nowMs`. The sim's own rule for a
                 weaker but real reason: nothing here can change a game outcome,
                 but "a footstep never repeats immediately" is exactly the kind of
                 claim that is true in the three cases somebody tried by hand and
                 false in the fourth -- and the mapping that makes it true
                 (`drawn >= previous ? drawn + 1 : drawn`, over a draw from
                 `count - 1`) is one character away from a version that returns
                 the previous index outright.
                 `engine.ts` creates **nothing** at mount: a browser refuses to
                 let a page make noise before an interaction, and a context built
                 anyway starts `suspended` and stays there in a way that is
                 invisible until a playtester says there is no sound. So the
                 context is built by the first `resume()`, which the Play tab
                 arms off the first real input, and a `play` before that is
                 dropped rather than queued -- a queue would empty itself into
                 the first click as a burst of everything that happened while the
                 page was silent. A cache miss is likewise dropped rather than
                 played late, and `warm` exists so the buses that fire in the
                 first ten seconds never take that path: a hit that arrives 200ms
                 after the blow is worse than one that did not arrive.
                 `dialogue-voice.ts` and `dialogue-sound.ts` are the procedural
                 speech (spec 246), and they are the one thing in this directory
                 that is **generated rather than fetched** -- so they sit either
                 side of the same line every other pair here does. *Which* letter
                 makes a noise, at what pitch, after what pause is arithmetic and
                 is asserted in Node; the four synthesis engines are transcribed
                 from `procedural_mumble_4voices.html` in the register
                 `sim/avoidance.ts` transcribes RVO2, because that file is what
                 the voices are defined *by* and a version written from its prose
                 would be a fifth voice sounding like none of them.
                 `planLine(text, voice, seed)` answers when every character
                 appears and which of them speak, and the rules it encodes are
                 the handoff spec's: a word start always speaks, a long enough
                 gap speaks, a vowel speaks on a shorter gap, and punctuation is
                 **timing and never a sound** -- a full stop that spoke would put
                 a vocal event on the beat the voice is meant to have stopped on.
                 Consonants modify the *resonance* and never add an attack, which
                 is that spec's one instruction written from experience: hard
                 attacks on T/K/C/P/S turn a voice into repeated `tsk`.
                 Two things are hashed rather than drawn, and both had to be for
                 the same reason `crowd.ts`'s `symmetryBreak` is: a plan built
                 from `Math.random` is a plan no test can hold. The pitch wobble
                 is hashed off **speaker + line id**, which the handoff spec
                 itself suggests, so a line spoken twice is the same performance
                 and two lines are two. The one place `Math.random` survives is
                 the *contents* of the breath noise buffer, which has no
                 perceptible identity to keep stable and nothing asserted about
                 it.
                 Two numbers were **measured rather than derived** and the
                 formulas that looked right were wrong. The mean gap between
                 vocal events has to be taken off a real line: one sound every
                 `density` characters says Warm Murmur does not overlap, and over
                 actual text it does -- 156ms between beats against a 160ms
                 event, which is the property that makes it read as murmuring
                 rather than as a row of separate noises. And a density bias only
                 shows in **long words**: in short-word text nearly every sound
                 is a word start, so soft and nasal tie and a test on the wrong
                 sentence reports a working bias as none.
                 `SpeechVoices` holds the two rules a bare function cannot: the
                 **cap** (four, the spec's own figure, for the case density
                 cannot cover) and the **cut** -- because nothing here stops
                 itself, and "no leftover dialogue audio after the conversation
                 closes" needs somewhere that can reach a sounding voice. The cut
                 is a 15ms ramp rather than a jump to zero, since a step in the
                 waveform is a click and closing a bubble mid-word would
                 otherwise be *louder* than letting it finish.
                 What there is **no** of is a schedule: every voice starts at
                 `currentTime` the moment the reveal reaches its character, so
                 there is never a pending sound to cancel. That is a stronger
                 guarantee than the playback token the handoff spec suggests --
                 skipping a line cannot produce a burst because there is nothing
                 queued to release -- and the token is kept for the sounds that
                 have already started.
                 `DIALOGUE_GAIN` is why "make dialogue louder" is one edit
                 rather than four: the levels in `VOICE_PRESETS` are the
                 reference file's verbatim, tuned against *each other* by ear, so
                 a lift applied per engine would quietly re-balance the four. It
                 is 2.5 because the reference plays into `context.destination`
                 and this plays into a **bus** -- `level x bus(0.8) x
                 master(0.7)` is 0.56 before anything else, so merely matching
                 the reference takes about 1.8.
                 `sink.ts`'s `speech(bus)` is the one hole in that otherwise
                 closed surface, and it is shaped so it is not a hole in the
                 *mix*: what comes back is a **bus gain node**, never
                 `context.destination`, so a mumble is scaled by master and
                 silenced by mute like every file the catalog plays. A sixth
                 bus, `voice`, was written and taken out again -- `BUSES` is the
                 *sound event* vocabulary and `events.test.ts` asserts every bus
                 appears in the SFX tab's tree in mixer order, so a bus that can
                 never hold a catalog event is an empty folder and a slider with
                 nothing behind it. A Dialogue level is a follow-up wanting a
                 mixer that separates "a bus of events" from "a level".
src/render/iso3d/sfx/  the SFX tab (spec 229), the seventh in the shell: a tree
                 down the left, one event's editor on the right, and a Save that
                 writes `assets/audio/sfx.json`. Hand-rolled DOM, which is the
                 idiom `studio/view.ts` and `studio/vfx-view.ts` use for a
                 *form*; `lil-gui` is the other one in this repo and is right for
                 a wall of sliders over a viewport and wrong here, because half
                 of this tab is an ordered list with per-row buttons and lil-gui
                 has no row of that shape. `model.ts` is the pure half -- what
                 the tree is, what a filter matches, what an edit does to the
                 document -- and every edit returns a **new** catalog rather than
                 mutating one, because the engine is handed the catalog and holds
                 resolved copies of it.
                 It edits a document rather than the running game, and says so:
                 the Play tab reads the catalog once at mount, so a change is
                 heard after a reload. What it does have is its own engine, so
                 Preview and *Play event* are the real decode and the real
                 variant-and-pitch draw -- tuning against something that flatters
                 is the failure `studio/preview.ts` names, which moves numbers in
                 the wrong direction and does it convincingly.
                 `POST /api/sfx` is `apply: 'serve'` like `POST /api/map`, so a
                 built page has no such endpoint and Save falls back to a
                 download -- and the four outcomes are told apart, because "there
                 is no dev server here", "the server said no" and "nothing
                 answered" have three different fixes and one message for all
                 three names none of them. The body goes through `parseCatalog`
                 before anything is written and the write is a rename, so the
                 file the game boots from cannot be replaced by something that
                 will not load or by half a document. There is no *name* on that
                 wire at all -- the catalog is one document with one home, which
                 is a stronger guarantee than any traversal check: a parameter
                 that does not exist cannot be abused.
                 Since the same spec it also **imports**, which is what makes
                 adding a sound a thing a person does in a tool rather than in a
                 terminal: choose or drop files on the editor pane and they are
                 written under `assets/audio/raw/`, baked, and assigned as
                 variants of the selected event, in one gesture. Three steps, and
                 they are three only from the inside. `POST /api/sfx/import` takes
                 the bytes **as the body** rather than as multipart -- a multipart
                 parser is a dependency and a boundary to get right for a form
                 with one field, and `fetch(url, { body: file })` sends a `File`
                 as its bytes with no ceremony -- and `POST /api/sfx/bake` calls
                 `bakeAudio` **in process**, so "ffmpeg is not installed" is a
                 sentence in the status line rather than an exit code and a log
                 somebody has to go and read. Both are registered *before*
                 `/api/sfx`, because vite matches middleware by prefix and that
                 one would otherwise swallow them and try to parse a `.wav` as a
                 catalog.
                 The folder is **derived from the event id** rather than asked
                 for, and shown rather than hidden: somebody importing three takes
                 for one event should not have to invent a folder, nor remember
                 where they put the last one. Every segment is slugged, so
                 traversal cannot escape the source root whatever is sent -- and a
                 segment with no alphanumeric in it is **refused anyway**, because
                 the difference between neutralising an attempt and refusing it is
                 that one of them quietly writes junk somewhere harmless and the
                 other says what it thought it was doing. A rebake of the picker
                 is cache-busted with a version query, since `manifest.json` is a
                 `publicDir` file with no hash in its name: without it you can bake
                 a file and be handed the manifest from before it existed, which
                 reads exactly like a bake that silently did nothing. And only
                 URLs the manifest **actually lists** are assigned, so a take
                 ffmpeg refused does not become a variant pointing at nothing.
                 `dragover` is cancelled because without `preventDefault` the
                 browser's own default wins, navigates the tab to the file, and
                 takes every unsaved edit on the page with it.
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
                 What those four facts cannot do is separate a phone in
                 desktop-site mode from a **small touchscreen desktop**, and
                 that is a limit rather than an oversight: both report a
                 hardware touch count, a fine primary pointer and a frame under
                 `HANDHELD_MAX_SHORT_SIDE`. A Steam Deck in SteamOS desktop mode
                 is the second one -- a 1280x800 panel is under 620 once the
                 browser's chrome and any display scale are off it -- so a
                 machine with a keyboard attached got the phone frame, and with
                 one tab left `showsTabButtons` draws no tab strip, which puts
                 the Studio and the map editor out of reach of the page
                 entirely. Moving the threshold is the repair that looks
                 obvious and is wrong: 620 was chosen against a real photograph
                 of a real phone, and every number above it restores the bug
                 spec 141 closed. So spec 230 makes the answer **sayable**
                 instead -- `?frame=desktop` and `?frame=phone`, in the register
                 `?seed=` and `?perf=noworker` already are. Three rules. It is
                 applied in `isHandheldDevice` rather than inside `isHandheld`,
                 because an override is a *person's answer* and `DeviceFacts` is
                 what the hardware says -- and because every caller comes
                 through that one function, so the rule that the tab bar, the
                 HUD and the fullscreen button must agree holds without any of
                 them learning an override exists. It goes **both ways**, since
                 forcing the compact frame is how that layout gets looked at
                 without a phone in your hand. And an unrecognised value
                 **defers** rather than picking a side, so a misspelling costs
                 the flag and not the frame.
                 iso3d/world/title-overlay.ts is the front door (spec 255),
                 and it is DOM for `loading-overlay.ts`'s reason one file over:
                 `src/ui/` has six methods and `drawSprite` takes a rectangle in
                 the theme atlas, so the framework cannot draw a painting and is
                 not going to -- `docs/ui/00-architecture.md` says the client has
                 zero image assets in as many words. What it is *not* is a second
                 font: the two words are `pixelTextSvg`, the game's own 5x7 face,
                 the one the death banner and the respawn button are already set
                 in.
                 **`z-index: 35` is the load-bearing number.** Over the world
                 canvas and the DOM HUD, deliberately *under* the interface
                 canvas at 40, and under the loading overlay at 50. The first
                 half is what makes Options work -- a framework window is drawn
                 on the canvas above, so it opens over the title art, and that
                 canvas is `pointer-events:none` so the menu underneath still
                 takes its own clicks. The second orders the boot with no state
                 machine in it: load, then title, then play.
                 The art is two drop-in files under `public/` (`docs/title-art.md`),
                 resolved through `withBase` because Pages serves from
                 `/turbo-deck/` and a root-relative URL there is a 404 (spec 153).
                 **Neither is required**, and the fallbacks are chosen so the
                 screen is never *wrong*, only plainer: a missing background
                 leaves the colour under it, and a missing logotype is replaced
                 by the wordmark in the game's own face rather than by a
                 broken-image glyph -- a title screen with no title on it being
                 the worse of the two failures.
                 Two of its boxes are **reserved rather than sized by what is
                 in them**: an `<img>` has no height until its bytes arrive, and
                 the menu is taller than the progress line it replaces, so a
                 column centred on its own content was laid out three times and
                 the logotype moved at the moment somebody was looking at it.
                 Fixed heights with `object-fit:contain` inside reserve the space
                 without this file knowing the art's aspect ratio, so a logotype
                 of any shape drops in and nothing moves. Start **fades** rather
                 than cutting, and the element is still removed at the end of it,
                 which is `loading-overlay.ts`'s rule and not a tidy-up: a
                 half-transparent `inset:0` overlay is a hole in the world where
                 START used to be.
                 What it costs is written down rather than hidden: the world
                 behind it is mounted and running, which is what it already did
                 at that point in the mount, so a player who leaves the menu open
                 is a body standing in the spawn village. Pausing it is a
                 follow-up with its own decisions -- what a paused loopback does
                 to a socket, and what a *remote* server does about a body whose
                 client has stopped asking for anything.
                 iso3d/client-build.ts is the same question about the *build*
                 rather than about the device (spec 254), and it exists because
                 the page deployed to Pages was the workbench: seven tab
                 buttons across the top of the world, eight tuning popovers down
                 the opposite corner, a diagnostic readout over the grass and a
                 frame-time graph beside it, all on before the first frame is
                 drawn. Every rule needed to hide them had been written for a
                 phone a hundred specs earlier -- `ShellTab.game`,
                 `HudLayout.showsTuningMenus`, `HudLayout.showsReadout` -- and
                 all three were reachable only through `isHandheldDevice()`.
                 So this is `device.ts`'s shape deliberately: two pure rules and
                 one cached reader over them, because the tab shell, the
                 settings corner and the HUD have to agree or the page is a
                 workbench in one corner and a game in another.
                 The decision is `import.meta.env.PROD` rather than a `VITE_*`
                 variable set in the deploy workflow, and that is the load-bearing
                 half: **the thing CI builds is the thing that ships**, so
                 `deploy-pages.yml` needed no change at all and there is no way
                 to deploy the bench by forgetting something. `?client=workbench`
                 is the way back on a built page -- which is what every harness
                 driving `dist/` passes, and what a developer poking at their own
                 build types -- and `?client=game` goes the other way, so the
                 shipped frame can be looked at without building. An unrecognised
                 value **defers**, the rule above it.
                 Three consequences, each at the one line that already decided
                 it: `visibleTabs`'s parameter is `gameOnly` rather than
                 `compact`, because the filter now has two reasons and two
                 filters could disagree about which tabs are the game;
                 `tuningMenusShown` sits beside `readoutShown` in
                 `hud-layout.ts`, where the first half of that rule was already
                 written down; and `readoutWanted` opens at `showsWorkbenches()`
                 rather than at `true` -- **started rather than forbidden**, so
                 `debug.toggleStats` still reaches it and a player who is asked
                 for numbers can produce them.
                 The frame-time meter is the fourth thing on screen and is
                 deliberately **not** part of that answer, because it is a
                 persisted preference rather than a frame. A build that decided
                 it would be wrong twice over: `writeField` re-serialises the
                 whole document, so a player who changed the interface scale
                 would have the bench's default stamped into their profile and
                 get the meter in the shipped client ever after -- and a build
                 that could overrule the box would be a setting that does not
                 stick. So `DEFAULT_SHOW_FPS` is `false`, one meaning in both
                 builds, and *Show frame rate* on the Display page is what
                 either kind of user presses.
                 That is only safe because the meter stopped publishing its own
                 numbers conditionally: `fps-overlay.ts` **always writes its
                 `data-fps-*` attributes and only ever hides the pixels**, which
                 is the rule `hud.ts` has kept for the readout since spec 094
                 (*"hidden, never silenced"*). Three probes read those
                 attributes and worked only because the preference happened to
                 default on, so a developer who unticked the box broke
                 `probe-frame-cost`, `probe-sim-cost` and `probe-world-lights`
                 in silence. It reverses spec 165's "`stats()` is only computed
                 when somebody is looking": the probes are somebody looking, and
                 they cannot tick a checkbox.
                 What is deliberately *not* done is code-splitting the benches
                 out of the bundle. `Tab.mount` has taken a promise since spec
                 203 so a dynamic import would work, but `check:bundle` sums
                 every emitted chunk rather than the entry, so it would measure
                 the same bytes and buy nothing the ceiling can see.
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
                 tools.ts is the settings object every lil-gui row is bound to,
                 and the one rule it has is a hard one: **every field holds a
                 real value, because `gui.add` refuses one that is not.** It
                 logs `gui.add failed`, hands back `undefined`, and the
                 `.name()` on the end of the chain throws -- so panel
                 construction stops where it stands and the editor never gets a
                 frame. Spec 250 shipped exactly that: the two fixture-light
                 sliders were seeded `null` for "the kind's own row", the
                 default armed structure is a hut, a hut has no light, and the
                 Map editor tab opened black on every boot with a half-built
                 panel beside it. `null` was buying nothing --
                 `fixtureOverride` already writes no override for a number equal
                 to the kind's row -- so the fields are numbers. What catches
                 the next one is a test over **every** field rather than those
                 two, because nothing under `editor/` builds a panel outside a
                 browser: this class of bug is silent in Node and fatal in the
                 tab.
                 tools.ts also holds the one thing 176 and 177 both missed,
                 because
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
                 Placing was still the *whole* vocabulary until spec 222, along
                 with erasing: correcting a spawner meant erasing it and placing
                 another, which comes back with a different id, since
                 `nextMarkerId` reuses the lowest free number and the whole set
                 can shuffle. The `select` mode is the third verb -- click a
                 marker, and its kind, its monster or label, its respawn time,
                 its leash and a Delete button are the panel; drag it and it
                 moves.
                 **The pick is against the billboards, not the ground**, and
                 that is the decision the tool turns on. A marker's disc floats
                 `STEM_HEIGHT` above the point it marks, so the ground under a
                 cursor aimed at a disc is metres from the marker -- 129 units
                 at the editor's own pitch, measured -- and *how far* depends on
                 the camera's elevation, which means no ground radius is right
                 at every angle. Aiming at the picture is exact at all of them,
                 with a ground pick inside `SELECT_PICK_RADIUS` as the fallback
                 so a click that missed the disc and landed by the stem still
                 names the obvious thing.
                 Three rules past that. **The selection is an id, never a
                 reference**: the store hands back fresh marker objects on every
                 `markers()` call and re-files a moved one into a different
                 chunk, so anything held is stale the moment something is
                 edited -- the rule the admin console's player table already
                 follows. A selection whose marker has gone (erased, or taken
                 back by an undo) is *noticed* rather than announced, in
                 `refreshMarkers`, because that is the one function every path
                 that changes the marker set already calls. **The select tool's
                 fields are its own**, separate from the marker tool's placement
                 defaults, since what I am about to place and what I have
                 selected are two questions -- and `selectionFrom` /
                 `patchFromSelection` are inverses, asserted over every kind, so
                 selecting a marker and committing untouched is a no-op. And
                 **`patchMarker` drops a spawner's numbers the moment the kind
                 changes** to one that cannot read them: `parseMap` refuses that
                 document, so keeping them would produce a map that saves and
                 will not load.
                 `MapChunkStore.updateMarker` is one primitive rather than
                 three, because editing and moving are the same write -- a
                 marker lives in the chunk that contains it, so changing its
                 point can change which chunk owns it. It removes before it
                 inserts and puts the marker back when the insert is refused,
                 since an edit that ate the marker on its way to a point outside
                 the map is the worst bug this could have.
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
                 structure.ts is the buildings tool (spec 224), and it is the only
                 prop tool here with no `Rng` in it at all. The scatter is
                 *seeded* because where a stroke lands is random and a seeded
                 stroke is one a test can assert on; a building is not random,
                 which is the stronger claim -- it goes where the cursor is, at
                 the panel's size and facing, one per press. That is the marker
                 tool's gesture rather than the scatter's, and for the marker's
                 stated reason: dragging would leave a street of forty huts under
                 one stroke. Three things it deliberately does not do. It does
                 **not** check crowding, because the spacing rule exists to stop
                 a density brush piling props on one spot and a single press
                 cannot; a well belongs next to the houses round it, and a tool
                 that refused there would make the one arrangement this feature
                 is for impossible to build. It does **not** clear what is under
                 it -- a place tool that silently deleted the well you set down a
                 moment ago is a worse surprise than a tree through a roof, and
                 the eraser is one mode button away. And a refusal is **said out
                 loud**, the way the marker tool's "no ground there" is, because
                 a click that does nothing with no word about why is
                 indistinguishable from a tool that does not work. The cursor
                 ring is the building's own `footprintRadius`, so what the ring
                 draws and what the collider blocks are the same circle rather
                 than two numbers that agree until one is edited.
                 Since spec 260 it also places a **sign**, and the message is a
                 panel field read at the press, the way `structureYaw` and the
                 two fixture sliders are: a `Message` row shown for the one kind
                 that reads it and hidden for the rest, since unlike spec 178's
                 monster dropdown this is a box with a perfectly plausible
                 sentence in it and nowhere for that sentence to go. It is the
                 one row here **not** re-seeded when the armed kind changes --
                 the light sliders are, because a blank slider cannot be dragged
                 and a lamp post showing a campfire's brightness is a panel lying
                 about what pressing now would place, where a message has no row
                 to come from and is the one field in this panel that costs
                 something to *type*. A blank sign is **refused** rather than
                 placed, because `signMarks` drops one and the crosshair never
                 offers one, so putting one down is a tool that appears to work
                 and produces scenery -- scenery the eraser's radius then makes a
                 nuisance to take back. What was placed is said out loud, quoted,
                 for the reason a fixture's brightness is: a board with the wrong
                 words on it looks identical to one with the right words on it
                 until somebody walks up to it.
                 What this deliberately does **not** do is let a placed sign be
                 edited, and the reason is structural rather than a matter of
                 effort: **a prop has no identity** -- a `Prop` is an anonymous
                 record in a chunk's list -- so "select this one and change its
                 message" is prop ids in the map format rather than a panel row,
                 and spec 222's rule for the marker tool (*the selection is an
                 id, never a reference*) is exactly what cannot be satisfied.
                 Correcting a sign is erase-and-place, which is the deal every
                 other prop's scale, facing and brightness already gets -- or an
                 edit to `maps/arena.json`, which is the one place a sentence in
                 a prop record is honestly editable by hand.
                 structure-ghost.ts is the building itself, drawn before it is
                 put down (spec 225), and it is here rather than in `cursor.ts`
                 because a footprint circle cannot say which way a hut faces or
                 how far its eaves reach -- so laying out a village with the ring
                 alone was place, look, undo, adjust, place again. Three rules.
                 **It is the thing, not a stand-in**: the geometry comes from
                 `buildPropField`, the same function every prop in the map goes
                 through, so a box roughed out for the preview cannot drift from
                 the hut it is previewing. **Following the cursor is a transform,
                 never a rebuild** -- a prop's placement is exactly
                 `T(x, ground, z) . R(yaw) . S(scale)` over its parts' local
                 offsets, which is what `buildRegionInstances` composes term for
                 term, so one prefab built at the origin and moved is the same
                 geometry for the cost of a matrix. That equivalence is asserted
                 vertex for vertex rather than reasoned about, and it is the one
                 test in this directory allowed to import three.js: get the
                 transform order wrong and it still looks like a hut, just one
                 somewhere else. And **the translucency is safe only because
                 materials are not shared** -- `props.ts` makes one per batch, so
                 a ghost's are its own; the same edit against a shared material
                 would turn every tree in the world see-through, in the editor,
                 for whoever happened to arm this tool.
                 The gesture moved with it: a building lands on the **release**,
                 and the drag between the two is its size, because every other
                 radius here is dragged out under the cursor and
                 `structureScale` was a number set beforehand in units of
                 nothing. The drag distance *is* the footprint radius, clamped
                 and stepped by the same three constants the panel's slider is
                 built from -- so the two controls cannot disagree about which
                 sizes exist, and a drag cannot write a number into that slider
                 nobody could have set it to. A press with no drag still places
                 at the panel's size, so a plain click is what it always was.
                 Two numbers in it are derived rather than chosen, and both
                 exist to take a step out of the gesture: sizing engages at the
                 *smallest ring*, so the first size a drag can ever produce is
                 the minimum and it climbs continuously from there -- a threshold
                 picked independently would jump from whatever the panel said
                 straight to the minimum, which reads as the building collapsing
                 rather than as a size being set; and the step is a **count of
                 steps to the unit** rather than a width, because
                 `Math.round(r / 0.05) * 0.05` is `1.1500000000000001` and that
                 is the number the panel would then display.
                 `npx tsx scripts/probe-structures.ts` is the half no headless
                 test can reach, and it is the reason any of the above is known
                 to be wired to anything: one more entry in a mode array cannot
                 fail a typecheck and cannot fail a headless test, so every rule
                 about a structure could be green in Node beside a `view.ts`
                 that calls none of them -- which is exactly what spec 176 found
                 for markers. It drives the shipped build, arms the tool, presses
                 three times and checks the **file that came out**, because a
                 building the editor draws and does not save is the bug. Since
                 spec 250 it counts what it *added* rather than asserting the map
                 had none to begin with: that was true while the arena was empty
                 ground and stopped being true the moment spec 247 gave the
                 shopkeepers a village to stand in -- three huts and a well, none
                 of them anything to do with this probe, and four checks failing
                 to say so. Its size tolerance is derived from
                 `STRUCTURE_SCALE_STEP` for a related reason: it was 0.06 against
                 a step of 0.05, so a drag that reached exactly one step above
                 the default matched every hut on the map and reported a working
                 feature as broken. What it
                 got wrong first is worth keeping: panel rows are **not uniquely
                 named** -- the fence's tile size and a building's size are both
                 `Size`, correctly, since neither is on screen while the other is
                 -- so a lookup across every `.lil-controller` answers questions
                 about the wrong tool, and reported a working panel as a hidden
                 one. A row is found by its folder and its label, and a folder in
                 this build is itself a `.lil-gui` with its own `.lil-title`;
                 there is no `.lil-folder` to ask for. Since spec 225 it also
                 reads `data-ghost` mid-gesture, which is the half a saved file
                 cannot answer: a tool that ignored the drag and sized the
                 building at the release would leave exactly the same document
                 as one that grew it under the cursor the whole way. Two things
                 in that half were learned by getting them wrong. Every wait is
                 a **poll**, because a building now lands on the release and this
                 environment paints the editor at about five frames a second --
                 waited out with a constant, the probe read the status line
                 before the placement, moved the facing slider before it, and
                 reported three huts placed at one facing as a broken slider.
                 And the "no ground under the cursor" case is staged at the
                 **corner** of a zoomed-out view: the middle stays meshed however
                 far you zoom, because the keep window grows around what was
                 already there, so hovering it reported a working refusal as a
                 preview that would not go away. It is checked as a round trip --
                 gone, then back -- since "the ghost is hidden" on its own is
                 also what a broken ghost looks like.
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
                 ground-residency.ts is which ground is meshed (spec 212), and
                 it is the other half of the editor's boot: `map.chunks` plus
                 `buildTerrainMeshFromChunks` was 4.9s on the shipped map and
                 ~73s of the ~148s projected at the 4x target, and nothing was
                 ever dropped -- `TerrainMeshHandle.remove` exists for spec 085's
                 part removal and spec 208 borrowed it for the *client*, while
                 the editor called it from nowhere on the boot path. The mesh
                 opens **empty** now and `pumpGround` meshes what the camera
                 frames from the pivot outward, dropping what it has panned away
                 from: measured in a browser on the shipped map, 20 chunks of
                 810 at the open, 39 zoomed out, 25 back in. The editor's whole
                 open is 9.4s to ~197ms, and 84% of what is left is `parse` --
                 which spec 207 named as the next thing and 204's split made
                 possible.
                 The keep window is **derived, not chosen**, the way spec 208
                 derives keep from request: the one thing eviction must not do is
                 fight the fill. It is the chunk-space **bounding box of what is
                 in view grown by two chunks**, rather than the world-unit pad
                 the spec asked for -- a chunk has no single world size, since
                 flank chunks are short, and `store.chunksInRect` already owns
                 the question. That also makes the no-oscillation rule hold by
                 construction: owed is inside the view, the view is inside its
                 own box, the box is inside the padded one. Asserted anyway over
                 every camera position, because "by construction" is a claim
                 about code somebody can edit.
                 Three things differ from 208 and each was learned rather than
                 assumed. **"A pan out and back holds what it started with" is
                 false here and should be** -- that property holds on the client
                 because its request radius fills the band inside the keep
                 radius, where this fill meshes only what is *in view* and keeps
                 wider, so held converges on (ever meshed within the keep box).
                 What must not happen is that going round again adds more, and
                 that is what is asserted. **Nothing beside a dropped chunk needs
                 re-meshing**: there the store loses the chunk so its neighbours'
                 aprons go stale, here the store is untouched and only what is
                 *drawn* changes, so a chunk's mesh is a pure function of the
                 store whichever neighbours happen to be on the graph. So
                 eviction runs **unbudgeted** -- it can never drop what the same
                 frame wants, and deferring it holds memory to save nothing. And
                 residency is **per layer**, because the rock tiers are layers
                 with their own chunk grids and one window over all of them would
                 let the ground's view evict a tier.
                 The consequence worth knowing is picking: `pickTargets` is the
                 terrain meshes, so ground with no mesh cannot be raycast.
                 Everything in view is meshed, so it only bites during fill-in,
                 and `pickPlane` is the stated fallback -- a tool that refuses a
                 null pick must go on refusing rather than acting at the flat
                 plane's height, or a stroke over ground that has not arrived
                 writes at the wrong altitude.
                 `npx tsx scripts/probe-editor-ground.ts` reads `data-ground`,
                 whose `meshed` is counted off `pickTargets` rather than off the
                 ledger, so a window that meshed nothing and believed otherwise
                 reads as broken. `probe-map-editor.ts` is the picking half and
                 needed no change: it places a marker by clicking the ground and
                 reads it back out of the saved file, which is exactly what fails
                 if a window leaves a hole under the cursor.
                 prop-residency.ts is which trees arrive next (spec 211), and it
                 exists because `buildPropField` composed every region in the
                 world before the editor could draw a frame -- **half** of
                 everything opening the editor costs, at every world size
                 `bench-editor.ts` measures, and 4.5s on the map we ship. Spec
                 207 named `buildChunks` as the editor's next problem and it is
                 under a third; nothing had measured the rest. The field is
                 built `deferred` now and `pumpProps` composes regions nearest
                 the camera's **pivot** first, so the trees you are looking at
                 arrive before the far corner of the map -- 4,153ms to 1ms at
                 the open. It is the pivot rather than the rectangle the camera
                 frames because this camera *orbits*: its footprint is not
                 axis-aligned, and a rect standing in for it would be an
                 approximation of a value used only to sort. The seam was
                 already there and unused from here -- `adoptRegion` and
                 `buildRegionInstances` are spec 181's, built for the Play tab.
                 What does **not** move with them is the composition itself: the
                 Play tab's props are immutable once streamed, so a worker can
                 hold a copy, and the editor's change under every tool, so a
                 worker's copy of them would be a second description of the
                 document. Paced rather than moved.
                 Two things in it were learned by getting them wrong. **The
                 budget cannot bound the frame**, and pretending otherwise would
                 be the comment lying: one region is 55ms to compose (median
                 over the shipped map's 72, 77ms at the worst), `FrameBudget` is
                 checked *after* a unit of work and nothing here can subdivide a
                 region, so the pump does exactly one region a frame. What that
                 buys is still the feature -- the first region lands in 55ms
                 where the eager field took 4.5s to land anything, and the tab
                 pans and paints throughout -- and the fix if a bounded frame is
                 ever wanted is a smaller region, which spec 195 chose for the
                 *Play tab* on a real GPU and left `?props=` to re-ask. And
                 **`held` is not a subset of the regions that exist**: an edit
                 marks every region its rectangle touched, empty ones included,
                 so `held.size >= regions.size` can be true with regions still
                 owed -- written as the size comparison it obviously wants to
                 be, the fill stops dead after a stroke near the edge of the map
                 and the trees never arrive, silently. `propRegionsPending`
                 counts instead, and the test pins the trap rather than the
                 happy case. The grid itself moved to `prop-regions.ts`, which
                 is `props.ts` minus three, so the pure half can key a region
                 without a second copy of the arithmetic.
                 `npx tsx scripts/probe-editor-props.ts` is the half no headless
                 test can see, and the reason it exists is that every rule above
                 is green in Node beside a frame loop that might call none of
                 them -- an editor that opens instantly and draws no trees ever
                 passes all of them. It reads `data-props`, published from what
                 is **attached to the scene graph** rather than from what was
                 asked for, so a region composed into batches that never reached
                 the group reads as absent.
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
                 Since 222 it also selects a spawner, changes its monster, its
                 respawn time and its leash, and reads the block back out of the
                 file -- and two things in that half were learned by getting them
                 wrong. **Every assertion polls `data-selected`** rather than
                 waiting a fixed few hundred milliseconds: this environment paints
                 at about five frames a second under software GL and that
                 attribute is published from the frame, so the first cut reported
                 three working edits as failures, each with the right answer in
                 its own detail line, because the detail was read a moment later
                 than the assertion. And **an empty patch of ground is searched
                 for rather than guessed at**: the shipped map is covered in
                 spawners, a fixed coordinate lands on one, and "the selection did
                 not clear" is what "the selection moved to the marker under the
                 second click" looks like. `panelRow` skips rows with no client
                 rects, which is what tells the marker tool's Monster dropdown
                 from the select tool's, since only the armed mode's folder is
                 shown -- and is what that helper should have been doing all
                 along, a hidden row being one nobody can use.
                 Spec 250 extended that first rule to the two reads that were
                 still constants -- the marker count and the readout after a
                 placement -- because the flake had got worse than a wrong
                 answer: two consecutive runs failed on *different* checks and
                 passed the other, which is the worst version of the bug, since a
                 green run is not evidence of anything if a red one is not
                 either. `markerCountUntil` and `readoutUntil` are the polls, and
                 both return what they last saw rather than throwing, so a
                 genuine failure is still reported as the number that was there.
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
                 Boot **meshes nothing** (spec 207). `loadMap` used to build
                 every chunk's mesh data eagerly -- a jittered world position and
                 a normal per corner, 54 million height lookups over a 4x map --
                 and `buildWorldFromDocument` reads `world` and `props` and never
                 touches it: `TerrainChunk` is what something *draws*, and the
                 only caller that wants it is the map editor. So the whole of a
                 server boot went into arrays discarded on the next line: 32.4s
                 of 34s at 12,960 chunks. `LoadedMap.chunks` is a memoized getter
                 now -- the same snapshot, taken at first read instead of at load
                 -- and `buildWorldFromMap` goes 32,402ms to 731ms at the 4x
                 target and 1,810ms to 34ms at today's size. Asserted by
                 **counting** rather than by timing, since a clock in the suite is
                 a test about the container it runs in.
                 That replaced a designed phase rather than completing one: the
                 plan called for a `ChunkSource` with asynchronous budgeted
                 acquisition and three residency states, and measuring said boot
                 was a wasted eager computation rather than a residency problem --
                 with heap at 0.26 GB rather than the 2.0 GB projected before spec
                 204 took `nav` out of the format. It is deferred with the reading
                 that would bring it back written down: `bench-map`'s `heap` past
                 ~1 GB at the target size, or its `build` past ~2s. What the
                 change does *not* fix is the **editor's** boot -- `buildChunks`
                 still costs 30.7s at 4x when it is called, and the editor calls
                 it, which is a different problem because the editor genuinely
                 wants the mesh.
                 Since spec 208 a client **forgets** what it walked past. Nothing
                 on the map path removed anything: `MapChunkCache` had `accept`
                 and no counterpart, `StreamedMap` never called
                 `MapChunkStore.removeChunk`, and terrain geometry is disposed by
                 `TerrainMeshHandle.remove` -- which exists for spec 085's part
                 removal and had no caller here. Driven around a circuit of the
                 shipped map, a real cache held **392 chunks against a 25-chunk
                 request window**, and stopped at 392 only because a circuit
                 revisits its own ground. `MAP_CHUNK_KEEP_RADIUS` is
                 `MAP_CHUNK_REQUEST_RADIUS + 2`, **derived rather than chosen**,
                 because the one thing eviction must not do is fight the
                 streamer: requested inside 2 and dropped outside 4, a chunk
                 between them is held and unasked, so a player crosses 1,232
                 units past the edge of what they are streaming before anything
                 goes and the same distance back before it is asked for again.
                 That there is no position where one pass drops what the next
                 asks for is asserted over every position *in* a chunk rather
                 than over the middle, since a boundary bug is a bug about where
                 in the chunk you are standing. An evicted chunk returns to "not
                 held, not in flight, not absent" -- the state `deny` already
                 puts a temporarily-refused one in -- so `wanted` re-raises it
                 with no new state and no new path; `absent` is deliberately
                 *not* cleared, because ground the server says does not exist
                 still does not and re-asking each lap is a request storm.
                 Four layers let go, and the renderer finds out by
                 **reconciling** against the cache's held list rather than by
                 being told: a message saying "these went" is a second
                 description of the same fact, and one that can be dropped,
                 leaving geometry drawn over ground nothing holds. The worker
                 keeps a `StreamedMap` of its own and gets an `evict` request,
                 without which it would hold every chunk of the session on the
                 thread nobody is watching -- half the memory the eviction was
                 for. Dropping one chunk re-meshes the four beside it, because a
                 chunk's apron is built from its neighbours: the mirror of what
                 an arrival does, in the other direction.
                 Since spec 215 the client also forgets the **trees** on that
                 ground. Spec 208 evicted terrain at four layers and said prop
                 regions were the same question one level up; one level up had
                 no answer at all, because `PropFieldHandle` could adopt a
                 region or dispose the whole field and nothing in between. A
                 lawnmower over the shipped map left **72 regions and 1,124
                 shadow-casting meshes drawn over 4 regions' worth of ground**.
                 The rule is derived rather than chosen: **a region is drawn
                 because a chunk under it is held, so it is dropped when none
                 is** -- which is what makes it unable to fight the streamer by
                 construction, where terrain had to derive a keep radius to buy
                 the same guarantee. One predicate, two callers
                 (`world/prop-residency.ts`): the drop pass, and the adopt path,
                 where a region asked for on one frame and evicted on the next
                 would otherwise be hung on the graph *behind* the drop pass
                 with nothing left to take it down.
                 What that exposed is the half worth knowing about, because
                 shipping the drop alone made the game worse and the report was
                 "went south, then north again and chunks didn't re-appear".
                 **Dropping a region is only half a cache**, and the thing that
                 puts it back was already broken:
                 `ChunkIngest.takePropRects` hands a region back once its ground
                 has been quiet for `settleMs` and either its ground is complete
                 or it has waited `incompleteHoldMs`, and both halves had
                 failed. The completeness rule fires **zero** times -- a
                 2200-unit region needs a 4x4 block of 616-unit chunks and the
                 request window has been 5x5 and unaligned since spec 202
                 narrowed the radius, so what spec 180 wrote as "the common
                 case" now never happens -- which leaves the backstop deciding
                 everything, and it was measured from the region's *last* touch,
                 so every arrival pushed its own deadline out and a body that
                 kept moving never reached it. Invisible before eviction,
                 because a region drawn once was drawn forever; with eviction it
                 is a world that strips itself as you walk and takes fourteen
                 seconds of standing perfectly still to fill back in. So **the
                 incomplete-hold clock is a deadline, not a quiet period**: a
                 region keeps two stamps, the last touch for the settle and the
                 first for the backstop, and nothing restarts the second until
                 the region is handed back. That the completeness rule is dead
                 is written down in spec 215 with its measurement rather than
                 repaired, because repairing it means asking "is every chunk of
                 this region *inside the request window* held", which changes a
                 rule spec 180 stated.
                 `npx tsx scripts/probe-walk-back.ts` is the half no headless
                 test could see -- the shipped page, a real worker, a real scene
                 graph, the body moved by admin teleport because the keep radius
                 is a minute of walking -- and it reads `data-prop-regions`
                 against `data-chunks-held`: the ground was bounded and complete
                 the whole way while the trees went to **zero** and came back to
                 three.
                 The same probe found the third one, one system over: the
                 **nav grid was keyed on the held chunk count** at both of its
                 gates -- `streamed.size - sizeWhenLastAsked >= 8` to decide a
                 rebuild is worth it, and `generation: streamed.size` to order
                 the replies. A count is a version only for a client that never
                 lets go, and bounded at 35 by the keep window it is neither: the
                 trigger stops firing and every later grid is refused as stale,
                 so a client routes and predicts collision against the grid built
                 over its spawn point for the session. Measured over sixteen
                 chunk-crossings: **one request, two grids**, `gen` stuck at 35
                 from the second leg on -- which reads as pathfinding that works
                 until you go anywhere. `StreamedMap.revision` is what both
                 questions were always about: **churn**, one up per insert *and*
                 one per removal, so it only ever grows and a chunk let go counts
                 as the change to the ground it is. Same walk after: fourteen
                 grids, `gen` 25 to 155, none refused. It arrived with spec 208
                 rather than with 215, and nothing caught it because every test
                 in the tree drives a client that grows.
                 `data/day-night.ts` is what time it is (spec 264), and it is
                 the half spec 047 said would need a spec of its own: that one
                 built the whole cycle -- the sun's arc, the nine-key colour
                 ramp, the terminator fade -- and drove it from a slider in a
                 tuning panel, which spec 254 then hid in the shipped build. So
                 the game people play had no day and no night, only a permanent
                 mid-afternoon; and a clock in a panel is a **per-client** clock,
                 which is the one thing a shared cycle cannot be.
                 **The clock is a pure function of the tick, and nothing crosses
                 the wire.** The client already holds one -- `estimatedTick` is
                 the server's clock re-synced to every delta with half the round
                 trip added -- so both ends compute the same hour from the same
                 number, and the feature costs no message, no protocol version
                 and no state to persist, replicate or forget to clear. It is the
                 pattern the loot reveal's phase, the stun swirl's angle and the
                 affliction beat already use, and spec 215 states it outright:
                 *the beat is derived, not sent*. What it costs is one round
                 trip's worth of hour, which at the fastest the clock ever runs is
                 under a hundredth of an hour on a 200ms connection.
                 Ten minutes of day and two of night are **not expressible under
                 one rate** -- `advanceTimeOfDay` is linear in `dt`, so day and
                 night are each half a cycle whatever the day length -- so the
                 cycle is four segments with a rate each: Day 07:30-16:30 in
                 600s, Dusk 16:30-19:48 in 45s, Night 19:48-04:30 in 120s, Dawn
                 04:30-07:30 in 45s. 24 hours, 810 seconds, 48,600 ticks, every
                 count an integer, so the phase is integer arithmetic on the tick
                 with no drift to accumulate over a session.
                 **The boundaries are `SKY_KEYS` entries**, and that is the point
                 rather than a coincidence: the ramp already has keys at 4.5, 7.5,
                 16.5 and 19.8, so the segments *are* its own structure and a
                 seam -- the one place a piecewise clock can show a kink, because
                 the rate jumps there -- always lands on a keyframe and never
                 mid-transition. Two of the four seams do step by about 5x, and
                 both sit at the ends of the long daylight stretch where the
                 colour is barely moving: measured through the real ramp,
                 day->dusk speeds up 4.89x at a point where the sky is moving
                 0.000005 of a channel per frame. The largest step the whole
                 cycle takes between two frames is 0.0066 of a retro colour band.
                 Day and night are authored **independently**, so 600 and 120 are
                 exactly the ten minutes and the two minutes and moving one does
                 not silently move the other or eat the sunrise. The cycle is
                 therefore 13m30s rather than 12m, which is stated rather than
                 hidden -- and measured against the *horizon* instead of the
                 segment names the sun is up 10m43s and down 2m47s, since dawn
                 and dusk divide their 45s each between light and dark. Dawn spans
                 a real sunrise (04:30 to 07:30 crosses the horizon at 06:00), and
                 it is the same 45s as dusk because asymmetry would need a reason
                 and there is not one: what makes it the payoff for a short night
                 is that it is 45 seconds against night's 120.
                 **Tick 0 is the first tick of Day**, which is why the table is
                 authored starting at Day -- the cycle's own order from its own
                 epoch, so there is no offset constant to keep in step. A fresh
                 server opens in morning light with the full ten minutes ahead of
                 it, and every harness that boots a server and photographs it
                 inside a minute is photographing daylight. The cost is that the
                 game no longer opens on spec 045's tuned 15:00 framing; with the
                 clock always running that is an hour the world passes through
                 rather than the hour it sits at.
                 **`worldClockAt(tick)` is the whole hook surface**, and every
                 pass in the sim already has the tick in hand. Deliberately not a
                 `ServerWorldState` field, a `StepContext` member or a
                 `ServerSimEvent`: each would be a socket sitting un-plugged in a
                 dozen places -- a field to persist and replicate, a context
                 member every test fixture has to supply, a `switch` arm in every
                 consumer -- to say something derivable from a number those
                 callers were handed anyway. `phaseBeganAt` is the edge for a
                 mechanic that wants to act once at nightfall, and being a
                 comparison rather than a fired event there is nothing to forget
                 to raise. It memoizes its last answer on the tick, which is pure
                 by construction since the tick is its only input.
                 `darkness` is the hook that is a *number*: 0 through Day,
                 smoothstepped up across Dusk, 1 through Night, smoothstepped down
                 across Dawn. Deliberately **not** derived from the sky's light
                 intensity -- that is presentation, tuned by eye and free to be
                 retuned, and this is a gameplay quantity with a stated shape; a
                 mechanic reading the ramp would be a rule that moves when
                 somebody adjusts a colour. There is deliberately **no
                 `isNight`**, because it would mean two different things -- the
                 Night *phase* (19:48-04:30) and the sun being *down*
                 (18:00-06:00) -- and a caller would get whichever the author
                 happened to pick; `phase` and `sunUp` are each unambiguous.
                 **No game rule reads any of it yet**, which is what the spec asked
                 for rather than an omission: the renderer's sky is the consumer
                 that proves the path end to end. The obvious next one is spec
                 250's fixtures, which burn at a constant intensity, so a lamp is
                 lit at noon.
                 net/ is the binary wire format (see net/PROTOCOL.md), sim/ is the
                 deterministic tick, world/ is chunking and zones, player/ derives
                 stats from ids and levels, state/ is the swappable DataStore,
                 admin/ is the token-gated admin namespace, client/ is the
                 transport-agnostic session the renderer draws from.
                 Since spec 246 a body can be **friendly**, and that is one line
                 rather than a system: a fifth `Temperament` with no numbers on
                 it, and a refusal in `isHostile` -- which is the only thing in
                 the sim that answers "may this body damage that one", so nothing
                 swings at it, no blast catches it, it never turns up in
                 `nearestQuarry` and it never acquires a target. It stays
                 `kind: Monster` because everything else about it already works:
                 it comes off a `spawner` marker, wanders through `sim/idle.ts`,
                 is moved by `resolveMovement`, replicates, streams and is drawn.
                 `Prop` is scenery that does none of that, which is why it was
                 not the answer despite already being excluded from `isHostile`.
                 `isFriendlyMonster` in `data/monsters.ts` is the **one** answer
                 to "is this type friendly", because three trees need it: the sim
                 wraps it as `aggro.ts`'s `isFriendly`, `appearanceOf` reads it to
                 withhold a health bar and to make a right-click mean *talk*, and
                 a test picking something to fight has to skip one. By type id
                 rather than by entity, which is what lets the client answer it
                 with no bit on the wire.
                 `ServerEntity.conversationWith` is the claim that stops a
                 merchant wandering off mid-sentence, read by `monsterIntent`
                 *before* the leash and before the idle plan. The plan underneath
                 is untouched and resumes at the epoch it would have reached
                 anyway, since `postAt` is a function of the tick rather than of
                 a stored goal -- so a conversation costs the sim one field and
                 nothing to unwind. An entity id rather than a boolean, because
                 "is somebody talking to it" and "is it *you*" are two questions
                 and only the second can refuse a second player.
                 `Talk`/`Conversation` are one message each (spec 246) and an id
                 of 0 ends one, `OpenVendor`'s own convention -- so a client
                 leaving cannot be a client that forgot to say so. The release is
                 **reconciled rather than announced**: `sweepConversations` asks
                 once per broadcast whether each is still holdable, so walking
                 out of range, either body dying, the NPC despawning and somebody
                 else claiming it are three lines rather than four events, and a
                 release path added later cannot forget to fire one. Nothing
                 about what is *said* crosses: `data/npcs.ts` and
                 `data/dialogue.ts` are tables both ends were built from, so
                 sending a script would be replicating a file the client has.
                 `data/npcs.ts` is keyed by the MONSTERS row id and is **one**
                 table read from both ends -- the server takes `talkRadius` and
                 `vendorId`, the client takes the name, the voice and the script
                 -- because a name authored in two places is a name that
                 disagrees with itself. Where an NPC *stands* is deliberately not
                 in it: a body comes off a spawner marker like every other body,
                 so moving a shopkeeper is a map edit. What that costs is the one
                 coupling this feature has: a vendor's reach is measured from a
                 **fixed point** and its owner walks, so the three `*_HOME`
                 constants in `data/vendors.ts` have to agree with markers in a
                 document they cannot see -- and `world/npc-placement.test.ts`
                 asserts the worst case off the shipped map rather than leaving
                 it a comment. That reach is derived (`talkRadius + wander radius
                 + a margin`) rather than chosen.
                 Since spec 247 **every** shop is one of these, and the removal
                 is the more interesting half of that spec. `vendor.quartermaster`
                 and `vendor.armourer` were invisible coordinates near the spawn
                 that a player walked onto and pressed `KeyV` at -- which was the
                 honest answer while `data/vendors.ts`'s own header was still
                 true that "there is no map yet that says where a town is". Two
                 ways to open a shop is two answers to *whose* stock is on
                 screen, and the proximity one got worse as the world filled up:
                 those two stand 89 units apart so their circles already
                 overlapped, and spec 246 had to add a `byProximity` flag purely
                 to keep Rell's four-times-wider reach from swallowing both. A
                 flag whose whole job is to hide a row from a search is the
                 search asking to be deleted.
                 What decided the shape is that **removing the key alone would
                 have taken four items out of the game**: `KeyV` is the only
                 caller of `nearestVendorTo` and that is the only thing that ever
                 names those two rows, so deleting the binding orphans them --
                 and `staff.emberwood`, `helm.plated`, `chest.scale` and
                 `shield.oak` are in no loot table anywhere. So the two shops got
                 bodies, which is what 244 built the machinery for and what
                 `shopkeeper(id, name)` in `data/monsters.ts` is: three rows that
                 differ in an id and a name, because everything a shopkeeper's
                 body *is* is the same and everything it *sells* lives elsewhere.
                 Their stock, markups and sell fractions did not move. Where they
                 stand was **measured** rather than chosen -- every candidate
                 scored for prop collisions and walkable slope over its whole
                 wander disc -- and they sit 210 to 220 apart against two wander
                 radii of 180, which is a test rather than a number in a comment.
                 `showShopFor(vendorId)` is now the only way a shop opens, and
                 `UiScreens.show` no longer special-cases one.
                 net/transport-ws.ts pings (spec 197), and the reason is the one
                 thing spec 157 could not have known: it moved the heartbeat off
                 `requestAnimationFrame` onto a wall-clock `setInterval` because
                 "a browser clamps it to about a second when hidden but never
                 stops", and that is true for five minutes. Chrome throttles a
                 page hidden and silent past that to **one timer firing a
                 minute**, and an open socket does not exempt it -- so a
                 ten-second `CONNECTION_TIMEOUT_TICKS` dropped anybody who went
                 to read their email. The heartbeat that survives is the one the
                 page is not holding: RFC 6455 makes answering a ping the
                 *endpoint's* job, so a browser pongs from its network stack with
                 no JavaScript running at all. `Channel.onAlive` is how that
                 reaches `lastSeenTick`, and it is **optional** on purpose --
                 `transport.ts` is "the smallest thing both implementations can
                 honestly provide", a loopback channel has no wire to prove
                 anything about, and an absent member says so where a required
                 one would make it lie. It is also *better* evidence than the
                 application ping it backs up: that one proves the tab's
                 JavaScript is running, this proves the socket is, and the case
                 the timeout exists for -- a dead router, a suspended phone, no
                 `close` -- answers neither.
                 What that leaves the client's interval doing is the visible
                 case and the reconnect ladder, and the ladder had the same bug
                 in miniature (`render/iso3d/world/keepalive.ts`): it advanced by
                 a *constant* 30 ticks per firing, which is 60 a second only if
                 something is really firing twice a second. At the hidden tab's
                 1s clamp the ladder took 79 seconds against a 30-second resume
                 grace; under the intensive throttle its first rung landed a
                 minute out, past the point where there was a body left to resume
                 into. It converts the gap it actually got now, so the ladder is
                 the same number of seconds however often the timer fires -- and
                 a long gap delivered in one step is safe by construction, since
                 `ReconnectingChannel.deliver` opens at most one attempt per call
                 and its rung advances on a *failed attempt* rather than on the
                 clock. The other half is that `visibilitychange` is finally
                 listened to: coming back to the tab is the one moment the cause
                 of an outage is known to be gone, and it was the one moment the
                 client did nothing, waiting out the timer that was the problem.
                 world/nav.ts and world/nav-residency.ts are which window a body
                 routes in (spec 205), over `src/sim/nav-tiles.ts`. The obvious
                 answer -- one window over the bounding box of every active chunk
                 -- is the bug in a different hat, because two players ten
                 thousand units apart have a bounding box the size of the world;
                 so the active set is cut into **connected clusters** and each
                 gets its own window, with merging and splitting both being
                 "recompute when the set changes". Affordable for the same reason
                 the labelling is: the set changes when somebody crosses a chunk
                 boundary, every few seconds at walking speed. Eight-connected,
                 since chunks meeting at a corner are two paces apart and
                 splitting them would put two windows over one fight.
                 The padding is **derived, not chosen**: a window has to hold both
                 ends of every route, and of the three goals `routeToward` is
                 given two reach past the body asking -- `walkHome` at
                 `LEASH_RADIUS` and `flee` at `FLEE_DISTANCE`. Unpadded,
                 `walkHome`'s route is refused, and that is not graceful
                 degradation but the loss of spec 076's stated feature: a monster
                 led round a wall comes back round it rather than pressing into
                 it. Padding rather than clamping the goal into the window, for
                 the reason `routeToward` gives about ring points.
                 `nav.ts` is a cache and one invalidation rule, and the rule is
                 the whole file: **windows are dropped whenever the active set
                 changes, tiles are kept while anything wants them.** Different
                 questions -- a tile is expensive (its ground is sampled) and
                 stays correct wherever the players go, while a window is cheap
                 to reassemble and is only correct *as* a window, because its
                 component labels describe a rectangle and the rectangle moved.
                 The active set is compared by **content**, since
                 `activeChunks()` hands back its live set and rebuilds it
                 whenever any player changes chunk -- so neither identity nor
                 size tells "unchanged" from "rebuilt", and getting that wrong
                 throws away every window on a tick somebody crossed a boundary
                 somewhere else entirely.
                 Tiled nav is switched on by **measuring the world**, not by a
                 flag: below one window the window is the world and the tiling is
                 pure overhead, which is every sandbox, every headless test and
                 the loopback tab -- so they keep routing exactly as they did,
                 through `navGridFor`.
                 The determinism argument is that a window is a pure function of
                 its rectangle and its tiles and a tile of where it is, so the
                 only way a cache could feed wall-clock into the sim is if what
                 is *held* changed what is *answered*. Asserted both ways: byte
                 for byte at the cache, and as a real walled-off fight replayed
                 to bit-identical state on a fresh nav and on one already walked
                 round the far side of the map. That test carries a **control**,
                 and the control earned its place at once -- the first fixture
                 put the monster 400 units from a 300-unit notice range, so
                 nothing engaged, nav was never asked, and both replays passed as
                 two identical recordings of nothing happening.
                 What a *fast* body does to all of that is spec 214, and the
                 three things it found are one shape: every rule about which
                 ground the client gets, and when, was keyed on something that
                 quietly stops being true when a body moves fast. (The fourth
                 thing the same report turned up -- a `PredictStep` built from
                 the first `Stats` and never rebuilt, so a player who equipped
                 anything carrying `moveSpeed` kept predicting the speed they had
                 before it -- is `PredictionBuffer.setStep` and
                 `gear-speed.test.ts`, and was not about chunks at all.)
                 **The serve window is one chunk wider than the ask window.**
                 `MAP_CHUNK_SERVE_RADIUS` is derived rather than judged -- the
                 client asks from `prediction.drawn`, which the sim keeps within
                 `correctionThreshold` of the server's position plus at most
                 `MAX_EASED_OFFSET` of undecayed visual offset, under a hundred
                 units against 616-unit chunks, and a disagreement smaller than a
                 chunk moves an index by at most one. Measured at the *same*
                 radius the whole leading-edge column came back `OutOfRange`
                 whenever the two straddled a boundary, and spec 208 made that
                 cost more rather than less: at radius 2 a refused column is a
                 fifth of everything the client holds, where at 6 it was a
                 thirteenth. It sits between the two radii 208 derived and
                 disturbs neither. Nothing a client *claims* enters that
                 arithmetic, so the guard is unchanged.
                 **The request order follows the body.** `wanted` ranked by how
                 far away ground is, which is right for a standing player and
                 wrong for a running one -- the chunk directly ahead at the edge
                 of the window sat in the same ring as the ones behind and beside
                 it. It ranks by distance to the *walk* now (the segment from the
                 body to where it will be in `CHUNK_LEAD_SECONDS`, clamped so
                 ground behind projects onto the body) and then by distance to
                 the body, so the corridor comes forward whole and is served
                 outward from the feet rather than from the horizon; the ground
                 being stood on is the only chunk that scores zero on both. With
                 no lead the segment is a point, both keys collapse to the old
                 one, and a standing player's stream is byte for byte what it was
                 -- and the candidates still come from the window around the
                 body, so this reorders a request stream and cannot widen one.
                 The lead is a *duration* rather than a distance, so it scales
                 with the body: half a chunk at walking speed, most of the window
                 at `MOVE_SPEED_HARD_MAX`, which is the rule working rather than
                 overreaching -- a body that crosses the window in two seconds
                 should be asking for its far edge. It comes from the direction
                 the last input *asked* for rather than a differenced velocity:
                 it is what the body is committed to, it is known on the tick it
                 is made, and a correction easing in underneath does not smear
                 it.
                 And **one lost message may not wedge the load**, which is the
                 half that matches "no loaded trees, and navigation broken from
                 that point on". `ChunkIngest` is a promise in two halves --
                 `offer` when ground lands, `complete` when its triangles come
                 back -- and nothing ever failed the second: `map-worker-core`
                 drops a reply for a layer it cannot mesh or a chunk that will not
                 build, `view.ts` skips `complete` when the scene refuses the
                 adopt, nothing re-offers, and nothing aged the queue out. Offer
                 two chunks, complete one, wait sixty seconds of total quiet, and
                 the other's prop regions are *still* `inFlight` -- their trees
                 never drawn for the session -- with `pending` still above zero,
                 which is the count the load gate and the first nav grid both
                 wait on. `meshTimeoutMs` sweeps it, and sweeping is the right
                 repair rather than a shrug: what a settled region needs is that
                 the **store** has its ground, and the store had it at insert --
                 the mesh is the picture, not the data the trees stand on. So the
                 region stays dirty and rebuilds from the store, which is exactly
                 what an arriving reply would have caused, and the region is
                 deliberately *not* touched, since a sweep is the one moment the
                 ground has demonstrably stopped moving. Two more of the same
                 kind in `view.ts`: `navRequested` is a one-in-flight latch and a
                 latch with no way out is a wedge, so it re-arms after
                 `NAV_REPLY_TIMEOUT_MS` (`navGeneration` already refuses a stale
                 grid that lands late); and every chunk taken out of
                 `pendingInserts` is forwarded to the worker rather than only
                 those that dirtied something here, because the two stores are
                 the same world only for as long as they are fed the same chunks.
                 `src/render/iso3d/world/fast-run.test.ts` is the end-to-end half
                 -- a real server over the shipped map, a real client, a real
                 `RoutePlanner`, at `MOVE_SPEED_HARD_MAX` -- and it asserts the
                 two things that would show the reported symptoms: a tick spent
                 standing on ground the map declares and the client has not been
                 sent, and a refusal on the edge the body is running toward.
                 sim/attack-timing.ts is how long an attack takes, in every sense
                 of the question (spec 144), and the only place any of it is
                 worked out. The idea it exists to hold is that the **attack
                 interval and the attack animation are two spans that start
                 together and end apart**: an interval from the wind-up's first
                 tick, an attack point partway through it where the blow becomes
                 real, and a backswing after that which a *player* may walk out
                 of once it has been committed to for long enough (spec 258; spec
                 221 roots monsters through theirs). One factor -- `(1 + attackSpeed/100) * mult * slowMult`,
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
                 Since spec 258 the follow-through has a boundary of its own, and
                 it exists because Agility's tree was pulling against itself:
                 half of it *shortened* the phase (the attribute's own reciprocal
                 `backswingScale`, Quick Recovery, every Flow stack) and the other
                 half paid you for walking out of one, so each point spent shrank
                 the window the rest of the tree is played in. Underneath both,
                 `cancelBackswing` succeeded unconditionally -- escaping a
                 follow-through was already free and instant for everybody, with
                 nothing to buy and nothing to be good at.
                 Spec 254 had taken apart the tightest loop of that a spec
                 earlier -- Mobile Offense used to pay in Flow and Flow shortened
                 the follow-through, so the reward for leaving one was a shorter
                 one, and it buys active-ability cooldown now -- and named the
                 rest of it in passing: a shorter backswing is *fewer ticks in
                 which `cancelBackswing` can be reached at all*. That window is
                 what this one is about, and the gate sits above the payout, so
                 an early walk-out earns neither the cooldown nor the Flow.
                 So `AttackTiming` carries a `backswingCancelTicks` and
                 `cancelCast` **refuses** a voluntary walk-out before it. Agility
                 buys that boundary rather than the length: nothing it writes
                 touches `baseAttackBackswingTicks` any more, and the phase a
                 fresh character has is the phase a specialist has -- they differ
                 in how early they may leave it. **Agility controls commitment;
                 it does not erase it.**
                 The threshold is a **fraction**, and that is what makes it one
                 number rather than a table: attack speed divides the backswing,
                 and a fraction is invariant under that division, so a hasted
                 body's cancel point moves with its own animation for free. It is
                 resolved at the commit into `cast.timing`, beside the interval
                 and the attack point and for their reason -- so Flow won by
                 *this* cancel pays for the *next* follow-through, which is the
                 loop the tree describes rather than a buff that reaches
                 backwards into the swing it came from.
                 Stacking is **subtractive and clamped once**: base, less the
                 attribute, less Quick Recovery, less Flow per stack, held at a
                 floor. Subtractive because the threshold is already a fraction of
                 a phase -- two sources of "a tenth sooner" have to be a fifth
                 sooner -- and clamped at the end rather than per source, so no
                 purchase is silently cancelled by another having reached the
                 bound first. The shipped maxima come to 0.41 of the 0.45 between
                 base and floor, so **nothing in the tree reaches the floor**,
                 which is the state a guard should be in rather than a ceiling the
                 tree is priced against.
                 An **interrupt is exempt**, and that is the definition rather
                 than an exception: the gate is about a decision the player is
                 making, and dying or having your guard broken is neither. Both
                 arrive as `Interrupted` from `blow.ts` and `poise.ts`, so the
                 things meant to knock a body out of a swing still do, on any
                 tick. An ability with no follow-through has no cancel point at
                 all, so a channel behaves exactly as it did.
                 The client **mirrors** the rule rather than being told it
                 (`ClientView.selfCommitted`), and it has to: the server settles a
                 withdrawal on the very tick the input carrying it lands, so a
                 client that waited to be told would ask to move, be refused, and
                 walk locally against a server standing still -- a correction on
                 every tick of the refusal. It rebuilds the cancel tick from the
                 *replicated* release and end ticks and its own replicated Flow
                 stacks, and is allowed to be a tick **late** and never early:
                 late costs a tick, early costs exactly that correction. Two
                 paths rather than one, and the second is the worse failure:
                 `sendInput` must not predict the *walk*, and
                 `GameClient.cancelCast` -- the stop key -- must not drop the
                 *cast*, because a cast lives in the client's own map and arrives
                 as an event rather than in a delta, so nothing puts one back.
                 Dropped early it is not a round trip of error, it is a body that
                 reads as free locally for the whole rest of the phase.
                 The other thing that spec had to fix is one the *window* only
                 made visible: **a press has to stop the walk.** Asking to move
                 is how a body withdraws (spec 079) and a withdrawal outranks a
                 commit on the same tick (spec 092), so a held direction refused
                 the cast before it began -- measured over a real loopback, 173
                 swings asked for and **173 refused as `withdrawn`, none
                 started**. Survivable while a follow-through could be left on
                 its first tick and a stop-start rhythm once it could not.
                 `castNow` already cleared the *move order*; a held key is not
                 one. `swingHold` in `world/intent.ts` is the rest, and it is an
                 **edge** rather than a level, which is the whole of what makes
                 it safe: the directions already down when the button went down
                 stop asking, one pressed *after* the commit still withdraws, a
                 released key drops out so re-pressing it withdraws, and the
                 hold ends at the **attack point** rather than at the end of the
                 cast -- past which a held direction is the walk-out of the
                 follow-through rather than a withdrawal, so a player who holds
                 a direction through their own swing leaves on the first tick
                 the cancel point allows with no second press. Only the explicit
                 press sets the edge; a standing attack or cast order does not,
                 because there a held key means what `moveIntent` has always
                 said it means -- grabbing WASD is taking manual control back.
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
                 **A swing that began in reach lands** (spec 221), and the two
                 halves of that were separate bugs. Withdrawing by walking is a
                 *player* rule now: `monsterIntent` asks to move whenever its
                 target is past standoff with no regard for a live cast, so the
                 movement pass read a chase as a withdrawal and a monster
                 cancelled its own blow -- measured on a spider, a wind-up ending
                 `Cancelled` 12 ticks into 30 with **neither a hit nor a miss**,
                 and a backswing broken out of 12 ticks into 24, both on the tick
                 the player crossed standoff. Guarded at the one line in
                 `world.ts` rather than at `closing`, because that is one branch
                 of five -- fleeing, idling, walking home and a target dying
                 mid-wind-up all reach it by their own routes -- and what keeps
                 the body still is the root that was already there. Death and a
                 poise break still knock a monster out of a swing: both cancel
                 directly as `Interrupted`, from `blow.ts` and `poise.ts`.
                 Underneath it, `landOnTarget` stopped measuring range at the
                 release. Spec 070 measured it there on the argument that
                 checking earlier makes a wind-up unreadable from the other side;
                 that readability lives in the wind-up being long enough to
                 *withdraw* from, which it still is, and asking at the release
                 meant a completed swing could quietly amount to nothing.
                 `CastState.targetInReach` is the answer taken once, at the tick
                 the wind-up *begins* -- at the wind-up rather than at the commit
                 because a body turns first (spec 065) and the turn is not the
                 swing, which is why `windupStartTick` is re-stamped at alignment
                 and the reach is re-stamped beside it. Two things decided its
                 home. It is stamped in `advanceCast`, which runs on the same
                 tick as `startCast`, because what is to hand *there* is
                 `attempt.targetX/Y` -- the position the **client claimed** --
                 and with the release no longer measuring anything, a reach taken
                 from a claim is a reach a client could simply assert; the
                 candidates `advanceCast` is handed are the server's own, rewound
                 to what this attacker was looking at (spec 149). And the flag
                 has to be *remembered* rather than replaced by a refusal at the
                 commit, because `melee.slash` is `direction`-targeted and
                 `startCast`'s range gate only runs for `point` and `unit` -- a
                 body three times its reach away can legally be named, and
                 without the stamp that would be a hit at any distance. What
                 still misses: a dead target, and one gone from `candidates`
                 altogether, which is the natural bound on "unconditional".
                 The rewind's job moved with it rather than going away -- it
                 decides whether the swing was allowed to *begin* holding its
                 target, where it used to decide where the target was at the
                 release -- and `world/position-history.test.ts` is timed against
                 the wind-up now. `sim/attack-reach.test.ts` is the rest, and
                 every rule in it was checked by putting the bug back: each
                 mutation fails exactly the test written for it, including the
                 turning one, whose first cut asserted a miss and so passed on
                 the default with the alignment re-stamp deleted.
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
                 off the summaries: same attacks, same cadence, a body rooted for
                 the whole follow-through or only up to its cancel point.
                 `--agility[=n]` is the other instrument (spec 258) and prints the
                 four-build follow-through table instead of a timeline -- nothing,
                 Quick Recovery, Flow, both -- with every number measured off a
                 real fight rather than off `attackTimingFor`, since a table
                 computed from the function the rule is written in would agree
                 with itself whatever the sim did. At Agility 60 the movement
                 freedom runs 10t to 17t while the follow-through stays 24t and
                 the next attack stays due on the same tick in all four rows.
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
                 Since spec 237 **every ability in that table is reachable by
                 somebody**, and it is a test rather than a habit: an item grants
                 it as an active skill, an item or a monster names it as a basic
                 attack, or it is one of the two the game reaches for directly --
                 `BASIC_ATTACK_ID` (bare hands, and every melee monster) and the
                 flask, identified by its `chargeCost` rather than by its id,
                 because that id lives in the renderer and a second copy of it in
                 the test is the drift the test exists to catch.
                 What it caught was spec 062's own starting set, still sitting
                 there: **nine of twenty-five rows granted by nothing** -- one per
                 `AbilityKind`, written to exercise the kinds end to end and
                 explicitly "not to be balanced" -- which spec 188 superseded when
                 it moved what a player casts onto sigils and which nobody
                 removed. Seven went (`melee.heavy`, the three bolts,
                 `ground.quake`, `self.mend`, `channel.drain`); two stayed,
                 because an item table cannot see what reaches them. They were not
                 harmless: not being `skill: true` they were castable by any
                 client that named one, and two of them out-damaged every real
                 skill, so they were what `npm run balance` had been measuring the
                 twelve builds with -- the harness reads the sigils now, and the
                 magic rows in that table dropped by half when it did.
                 Two things the removal exposed and did not fix. `kind: 'channel'`
                 has **no rows**, so the whole channel path in `sim/abilities.ts`,
                 `client/combat.ts` and `data/description.ts` is live and
                 unreachable from content; taking it out means removing a member
                 from the middle of `CastPhaseValue`, which renumbers the two after
                 it, so it is a protocol change and wants its own spec. And
                 `attackTimingFor` sends a non-basic ability's `cooldownTicks`
                 through `resolveAttackTiming` as though it were a Base Attack
                 Time, which clamps it to `MAX_ATTACK_INTERVAL_SECONDS` -- a
                 constant whose own comment says "nothing in the content reaches
                 either bound", true of BAT and false here: **twelve of the
                 fourteen non-basic rows are over five seconds, so every one of
                 them is really on a five-second cooldown.** Scorched Earth's
                 authored 24s is 5s. It was invisible while the ability those
                 tests drove was `melee.heavy`, whose cooldown was inside the
                 bound; `abilities.test.ts` asserts the clamped value and names it
                 now, so it is written down rather than assumed.
                 `data/weapon-scaling.ts` is **what a weapon scales with**
                 (spec 216), and it exists because until it did, every weapon in
                 the game scaled the same way and the way was Strength: the two
                 attribute terms were written into `attackDamage` in
                 `player/stats.ts`, so the maul, the Hunting Bow and the
                 Emberwood Staff all bought damage from the same stat and nothing
                 a designer could write in `data/items.ts` changed it. Swinging
                 the staff -- a row granting +3 Intelligence and spell power --
                 was a Strength act.
                 A weapon now authors one letter per attribute,
                 `None -> E -> D -> C -> B -> A -> S`, over Strength, Agility and
                 Intelligence and those three only. `ScalingGrade` is *ordinal*
                 rather than a letter union, the `StatusId` const-object pattern,
                 because every operation a grade has is step arithmetic and
                 clamping; the letters are `GRADE_LETTERS` and are a display
                 concern.
                 Four rules, and the first is the one the feature does not work
                 without. **One rate for all three attributes.** Strength used to
                 buy 0.6 damage a point and Agility 0.15, a four-to-one gap
                 sitting *underneath* the grades -- an `A` in Agility would have
                 been worth less than an `E` in Strength, and no letter anybody
                 could write would have balanced the two. So
                 `SCALING.weaponScaling.damagePerPoint` is shared and the
                 **grade** is the whole differentiation. It is `2/3` because
                 `2/3 * 0.9` is exactly `0.6`: grade `A` reproduces the Strength
                 rate this replaced, so migrating a weapon to `A` moved a
                 Strength build's damage by nothing at all. An independent
                 constant rather than one derived from `A`, or retuning `A` would
                 be silently cancelled by the rate it was chosen against.
                 **The coefficients live in `SCALING` and nowhere else.**
                 `data/scaling.ts` already states its reason to exist -- a
                 balance pass is a diff of that file and nothing else -- so
                 deciding `S` is worth 1.30 is one edit that reaches every `S`
                 weapon in the game. A weapon row stores the *letter*, and the
                 tooltip draws the letter it was authored with rather than
                 inferring one back out of a number. `coefficientOf` is the only
                 reader, and it switches on the ordinal so a corrupt row answers
                 `none` rather than `undefined`.
                 **`effectiveScaling` is the single resolver**, and both the
                 damage and the tooltip go through it -- which is what makes "what
                 the number does" and "what the player is told" the same sentence
                 rather than two implementations that agree until one is edited.
                 It returns a new object and never touches the base, which is the
                 property the modifier design rests on: an amulet raising Agility
                 a grade must not write into `data/items.ts`, because taking it
                 off would need the row restored from somewhere and there is
                 nowhere. Removing a modifier restores the effective scaling
                 because the base was never moved.
                 And **a modifier is a step, generic and summed**: three flat
                 fields on `StatModifier` beside the six attribute grants, added
                 by `sumModifiers` with everything else, so a ring at +1, an
                 amulet at +2 and a debuff at -1 are a net +2 clamped **once** --
                 rather than three clamps in a row, which answer differently near
                 the ends of the ladder. `S + 1` is `S`, `None - 1` is `None`, and
                 there is no `S+` and no `F`. A step also *lifts* a `None`, which
                 is deliberate: a modifier that could not create scaling would
                 make "raise a grade" mean two different things.
                 What did **not** move is spec 147's split: `resolveBlow` still
                 chooses between `weaponPower` and `spellPower` on
                 `ability.basicAttack`, so a weapon's letters reach a swing and an
                 ability still scales with Intelligence's spell power. And
                 monsters have no weapon row, so `AuthoredStats` cannot author
                 scaling at all and `withTraits` fills in `NO_WEAPON_SCALING`.
                 The two resolved fields ride `EffectiveStats` and the `Stats`
                 message, and both are needed rather than one: the grades answer
                 "what does the weapon I am holding scale with", and the steps are
                 what the bag needs to answer the same question about a weapon it
                 is only *hovering*. Re-deriving those steps from the client's own
                 copy of the equipment would be the second modifier
                 implementation the whole spec exists to prevent -- and would miss
                 the milestones and synergies that side cannot see.
                 `npx tsx scripts/preview-weapon-scaling.ts` is the balance
                 instrument: the roster, the coefficient budget each weapon's
                 letters add up to (which is the number a balance pass actually
                 reads, because breadth has to be paid for or a three-letter
                 weapon is simply better than a one-letter one), and what the
                 migration moved at five builds. `explainScaling` is the same
                 arithmetic taken apart term by term, for answering "why did that
                 hit for 70" during development; nothing in production reads it.
                 `data/weapon-scaling.ts` also holds **what a weapon hits
                 for** (spec 217), because a weapon having damage of its own is
                 the other half of it having scaling of its own. A row authors a
                 `{ min, max }` and that *is* the basic attack: before it, a
                 swing was `ability.damage * weaponPower`, so the number setting
                 how hard every sword in the game hit was a field on
                 `melee.slash` -- shared with every monster on the map.
                 Three findings, and they were one finding. **A weapon had no
                 damage of its own**, so "this sword hits for 1 to 3" was not
                 expressible. **Every melee monster hit for exactly 14**:
                 `monsterTraits` spreads `NEUTRAL_TRAITS`, whose `weaponPower` is
                 1, so a monster's blow was `melee.slash.damage` and the
                 `attackDamage` its row authored reached nothing but its stagger
                 power -- the Ravager's 24 and the Grazer's 6 landed identically,
                 and the Training Dummy authored 0 and hit for 14. And **the
                 numbers were an order of magnitude too big to read**: a fresh
                 character hit a 24-health Grazer for 26.3 and deleted it.
                 `EffectiveStats.weaponDamageMin`/`Max` is the resolved range,
                 with the attribute term, the flat bonuses and the percentage
                 already folded into **both ends** -- so a wide weapon stays wide
                 and `resolveBlow` rolls and is done. `attackDamage` survives as
                 the **midpoint**, which is what the character sheet shows and
                 what a stagger's power is sized off; `TraitStats.weaponPower` is
                 gone, its one production reader having stopped reading it.
                 A monster's range is `min = max =` its authored `attackDamage`,
                 filled in by `withTraits`, which is the whole of the second bug.
                 **The draw is one `nextInt`, before the crit roll, and only for
                 a basic attack.** Conditioning on the ability's own
                 `basicAttack` flag is safe where conditioning on a *chance*
                 would not be: it is a property of the row, fixed for an id, so
                 two replays of the same inputs draw the same count. The Rng draw
                 count is protocol, so this moved every seeded combat sequence in
                 the tree once, deliberately.
                 The scaling baseline moved with it: spec 216's attribute term is
                 measured through `above()` now, the rule `data/scaling.ts`
                 already applies to every other scale, so a character who has
                 spent nothing gets nothing from scaling and the Worn Sword's
                 `1-3` is exactly what a fresh character hits for.
                 What the rescale reached, and why each: health and monster
                 damage **divide by four**; ability damage, DoT rates and
                 `HEAVY_ABILITY_DAMAGE` divide by **seven**, measured against
                 `npm run balance` rather than chosen -- at a quarter,
                 Intelligence sat at 13 kills against Strength's 5 where main had
                 9 against 8, because abilities had kept their power against
                 health while weapons lost a third of theirs. The **poise**
                 economy divides by four alongside health and had to: a monster's
                 guard is `maxHealth * monsterPoiseFraction` floored at
                 `minPoise`, so quartering health alone put every monster in the
                 game on the floor. `data/restoration.ts` needed no change at
                 all, because every number in it is a fraction of a pool.
                 Two things in the **harness** were measuring a character nobody
                 plays, and both were invisible until the table went strange.
                 `bestReady` compares each ability against the basic attack's
                 damage, read off the ability row -- which is 0 now -- so every
                 build stopped swinging and the weak-point column went to zero
                 across all twelve; it reads `stats.attackDamage`. And the
                 presets fought in `EMPTY_EQUIPMENT`, which used to be worth 14 a
                 swing and is now a 1-2 punch, so they wear `STARTER_EQUIPMENT`
                 -- the same worn sword for all twelve, a control rather than a
                 variable.
                 The one row that did **not** divide by four is the Grazer, which
                 divided by eight: being hit sends it running for two and a half
                 seconds, it used to die to the first blow that landed, and at a
                 quarter it took three hits, fled three times and could not be
                 caught. Prey that cannot be caught is scenery with a loot table.
                 `data/description.ts` is what those tables *say* (spec 191) --
                 the one writer for every player-facing Technical Description,
                 composing a row into a target, its effects in the row's own
                 order, its costs, its timings and its notes. Derived rather
                 than authored, so a retune is described correctly with nothing
                 to remember, and `GRANT_LABELS` names each field of a
                 `StatModifier` once so an item and a passive skill cannot
                 disagree about what `attackSpeedPct` is called. Two rules keep
                 it honest and both are tested. **Nothing derivable may be
                 authored**: a `StatusVisual` carries one authored sentence
                 because what a condition *does* lives in `sim/blow.ts` and
                 `SCALING` and there is no field here to read it from, and
                 everything around it -- the stacking rule, the refresh rule,
                 whether a count is drawn -- is composed. And **a field with no
                 label draws no line at all**, which is what lets three trait
                 keys that cannot become a signed quantity reading correctly in
                 English fall back to their row's own sentence rather than get
                 an invented number; the test asserts that list exactly, so a
                 fourth gap fails rather than passing quietly. `description`
                 on a row is flavour and only flavour -- a mechanical claim
                 there is a second copy of a rule with nothing keeping it true,
                 and two of them were already false when the standard was
                 written.
                 **Active skills** are the fourth thing an `AbilityDefinition`
                 can be (spec 188), and the point of them is how little is new:
                 a skill is `targeting + casting + costs + cooldown + effects`
                 and every one of those five was already a system here. So the
                 row gains four optional fields -- `castAngleDeg` (the brief's
                 castAngle, which is spec 065's turn-before-the-wind-up with the
                 tolerance made the row's to name), `costs` (health and guard,
                 beside the pool cost and the flask charge that already
                 existed), `area` (a shape, for the landing that picks by
                 geometry rather than by naming a body) and `effects` -- and
                 every row written before it leaves all four absent and behaves
                 exactly as it did. `data/skill-effects.ts` is the vocabulary:
                 three small unions and one tuning block, no behaviour.
                 `sim/skill-effects.ts` is the resolver, and it is the file to
                 read to see whether the claim is true -- **there is no case in
                 it that implements a mechanic.** Damage is `resolveBlow` with
                 the row's damage swapped, so a skill's blow gets crit, weak
                 points, armour, adaptation, shields, poise and the whole
                 aftermath rather than a second damage path; guard is
                 `applyPoiseDamage`; a stun is `stagger`, which came out of
                 `blow.ts` for this and is now the one place a stagger's
                 consequences live; a status is `applyStatus`; a heal is
                 `applyHealing`. An effect that needed its own arithmetic would
                 be a mechanic living in the skill system instead of in the
                 system it belongs to, which is the thing the spec exists to
                 avoid. `sim/skill-area.ts` is the geometry beside it -- circle
                 at the caster or at the aim, cone, line -- and a fourth shape
                 is a member of one union and a case in one switch.
                 The one rule in the resolver that is not simply a hand-off:
                 **a stun is not a guard break and is not rate-limited like
                 one.** `staggerImmune` stops a *break* being repeatable, which
                 it has to, because every basic attack carries poise; a skill's
                 stun is gated by a readable cast time, a cost and a cooldown in
                 seconds, which is stricter. Reading the window made Stunning
                 Blow land three different ways from one row -- its own
                 `poiseDamage` runs first, so on a body whose guard it broke it
                 stamped the window a line before the `stun` read it: 1.4s
                 against a ravager (guard 49, unbroken by 30), the target's own
                 0.5s against a grazer (guard 20, always broken), and nothing at
                 all against a body already inside somebody else's window. So
                 the stun ignores the window and still stamps it, and
                 `isResolute` still refuses it -- that one is an *earned*
                 defence rather than a global guard. Stuns also do not stack:
                 `stagger` writes `tick + ticks`, so a second replaces the first
                 in both directions and a short stun on a long one shortens it.
                 Three rules the design turns on. **A skill is an item**: four
                 `skill1..skill4` entries on `EquipSlot`, an
                 `ItemDefinition.activeSkillId` in the same shape a bow already
                 uses to name `ranged.shot`, and `slot: 'skill'` as a *family*
                 so one row fits any of the four. That is what makes dropping,
                 trading, carrying, wearing and persisting a skill free: they
                 are `applyMove`, `MoveItem`, `Equipment` and the loot tables,
                 untouched. `StatusId.Slowed` is the first entry in the status
                 map a *skill* applies rather than a build earning, and it is
                 the one part of this that needed the wire: `moveScaleOf` is
                 read by `resolveMovement`, and a slow the owner's client did
                 not know about would be a client predicting full speed against
                 a server walking at 60% -- one drift correction a tick for two
                 and a half seconds, which is exactly what spec 067's nudges are
                 not for. Spec 173 accepted one round trip of that for a
                 stagger's onset *because* `Activity` is replicated and the
                 client stops the moment it sees it; a slow has no such tell, so
                 `EntityField.MoveScale` is a byte fraction on the delta beside
                 `Poise`. That is the *number*; the **mark** is spec 186's, and
                 `Slowed` is a row in `STATUS_VISUALS` like any other condition
                 -- the two halves ride different fields because a watcher needs
                 to know a body is slowed and only the mover's own predictor
                 needs to know by how much. It rides the **input** into the predictor rather than
                 being baked into it when the predictor is built, so a replay
                 after a correction walks each buffered input at the speed that
                 applied when it was made.
                 **The caster has to be carrying it**:
                 `EffectiveStats.skillAbilityIds` is derived off the four slots
                 the way `basicAttackId` is derived off the main hand, and
                 `startCast` refuses a `skill: true` ability that is not in it.
                 That is the first ownership check the ability system has ever
                 had -- `STARTING_ABILITIES` was exported and read by nothing
                 for a hundred and twenty specs, so any client could send
                 `ground.quake` on its first tick. Spec 231 removed both: the
                 list, and the nine rows it named that no sigil, weapon or
                 monster ever reached. And **a swap costs
                 something**: `player/skill-slots.ts` refuses a move that would
                 empty a slot whose skill is on cooldown (checked over *both*
                 ends, since swapping something in empties a slot as surely as
                 dragging the old one out), and `server.ts` holds the move in a
                 queue for `SKILL_SWAP.durationTicks` the way spec 172's drop
                 queue holds a throw, with the swapper carrying an *existing*
                 status while it waits. The client deliberately does **not**
                 predict a swap -- every other container edit is drawn on the
                 frame it was released, and a swap drawn early would put a
                 button on the bar that the server refuses for a second and a
                 half.
                 What it draws instead is the **commitment**, and that is the
                 whole of `ActivityValue.Swapping`: the first cut made a swap
                 take a second and a half and showed none of it, which is a
                 delay rather than a cost. The state rides the field `activity`
                 already rides, so every client sees it and nothing new is
                 replicated, and it is a *claim on the body* -- walking away
                 drops it in the movement pass exactly as asking to move
                 withdraws from a wind-up, a break writes `Stunned` over it, a
                 cast writes `Casting`. `serveSwaps` watches for the claim going
                 away rather than listing the causes, so a fifth cause arriving
                 later cannot silently fail to cancel anything. One ordering in
                 it is load-bearing: `expireActivity` drops the claim on the tick
                 `activityUntilTick` is reached and that pass runs *after* the
                 sim in the same tick, so the claim is checked only while the
                 clock is still running -- checked first, every swap is given up
                 on the tick it was due to land.
                 `world/skill-swap-view.ts` is the presentation, pure and shared
                 by all three surfaces so one commitment cannot be drawn at three
                 depths. The split between them is the information rule rather
                 than an omission: the bag marks its two cells (red leaving,
                 green arriving -- two *hues*, because at twenty pixels a cell
                 the only difference a player can see is hue and two warm tones
                 read as one mark applied twice) and the bar says the word
                 (`EQUIPPING`/`SWAPPING`/`REMOVING`), both off the owner-only
                 `PendingSkillSwap` that rides on `Inventory`; the body says
                 only *that* a change is happening, off the replicated activity.
                 Which slot and which direction are facts about a bag and a bag
                 is its owner's business; that somebody is busy is a fact about
                 the world.
                 The other thing 184 shipped broken and this fixed: a cell
                 accepts a **family**, not a slot name. `ItemSlot.acceptsSlot`
                 compared a sigil's `skill` against the cell's `skill1` and
                 refused every drop the server would have taken -- so nothing
                 could be equipped and nothing said why, because an unlit cell
                 *is* the refusal. `SlotDescriptor.accepts` is handed in from
                 `inventory-model.ts` through `slotFamily`, because `src/ui/` may
                 not import the server's rule and a screen with its own copy of
                 it is a second answer to "will this cell take this".
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
                 There is a fifth `AggroValue` since spec 248, and it is what
                 makes the leash mean something: **`Returning`**, a body that
                 broke its leash and is walking home. Before it, all three of
                 "gives up, goes home, heals on the way" were true and the walk
                 was still farmable, because none of them was a *claim on the
                 body*. It stayed a legal target, so it was shot in the back the
                 whole way. `restore`'s `InCombat` gate is re-stamped by every
                 blow, so the recovery that exists to close pull-and-reset was
                 switched off by exactly the attacks worth closing it against.
                 And the leash dropped the target two lines above `notice`,
                 which handed it straight back on the same tick -- so a
                 ferocious body kited past its leash with the player still
                 standing there never took a step homeward at all, and the
                 measurable behaviour of the leash was an oscillation.
                 The state pairs with `ServerEntity.returnStart` exactly as
                 `Fleeing` pairs with `fleeGoal`, and it is the one thing in
                 `idle.ts` that is a **snapshot rather than a derivation**:
                 "regenerate to full along the route" is a line between two
                 points, and both of them -- how far out it gave up, and on what
                 health -- are gone the moment the body takes its first step.
                 Two of the three refusals cost nothing, which is why it is a
                 state and not a flag: `notice` and `rally` already require
                 `Calm`, so neither needed a line. The third is one line in
                 `isHostile`, refused at both ends, the shape spec 246 gave a
                 friendly body -- and that one line is the whole of the
                 invulnerability, because every damage path in the sim filters
                 its candidates through that function. Nothing swings at it, no
                 blast catches it, an affliction already burning on it stops
                 pulsing, and it swings at nothing.
                 Three things about it were each learned by writing the other
                 version first. It is entered **above `settle` and `notice`**
                 rather than inside `idle`, because those are what hand the
                 target back -- entered below them, the return is a state the
                 body reaches only when nobody is watching it. `goHome` is
                 **idempotent**, because `monsterIntent` asks every tick a body
                 is out past its leash and a span re-snapshotted each time is a
                 ramp that restarts from where it has got to: a body that walks
                 the whole way home and heals nothing. And the ramp is a
                 **floor** on health rather than a value -- the straight line
                 home is not the route, so a body going round a rock or shoved
                 outward by the crowd closes less ground this tick than last,
                 and a bare lerp takes health back off a body that cannot be
                 hurt. What a detour costs is a pause, never a reversal.
                 The entry condition is "beyond its leash with nobody left to
                 fight", one sentence covering the leash break, a flight that
                 ended out past the leash and a target that died out there; the
                 exit is arriving on its own ground, which sets health to full.
                 Nothing about it crosses the wire -- `aggro` is not replicated
                 and this does not start -- so what another client sees is a body
                 sprinting home with its health climbing, `conversationWith`'s
                 own answer to the same question. A mark over the head is the
                 stated follow-up and wants the status system's expiry model,
                 which an event-ended state has not got.
                 How far that leash reaches, and how long a kill stays dead, are
                 the spawner's own since spec 222. Both were global constants
                 answering a per-spawner question -- one `spawnIntervalTicks` for
                 the whole map and one `LEASH_RADIUS` for every body on it, so a
                 boss and a rabbit came back on the same clock and were leashed
                 alike -- and a `spawner` marker now carries an optional block
                 saying either. Nested rather than two more optionals beside
                 `label`, so `parseMarker` can refuse the block on a kind that
                 cannot read it, which is the rule `Temperament` and `Idle` are
                 unions for; **seconds rather than ticks**, because a map document
                 is read by a person and `spawnPointsFrom` is the one boundary
                 that converts; and absent rather than a written-in default, so a
                 default that moves reaches every map that did not override it.
                 An absent or empty block writes nothing, so no committed map file
                 moved and no `mapId` did either.
                 Two rules hold it to what it is. The marker's clock is a
                 **base, not an escape from the live control**: `spawnRateMultiplier`
                 still scales it and still stops it dead at 0, which is how the
                 admin console halts repopulation without a restart, so a spawner
                 that could opt out would make that button a lie. And the leash is
                 **capped at `LEASH_RADIUS`, derived rather than chosen**:
                 `NAV_WINDOW_PAD_TILES` is `ceil(max(LEASH_RADIUS, FLEE_DISTANCE)
                 / CHUNK_SIZE)`, so a nav window is assembled exactly wide enough
                 to hold both ends of a route home from the global reach, and a
                 body leashed past it would hand `routeToward` a goal outside its
                 own window -- which `nav-tiles.ts` refuses rather than clamps. A
                 document may make a monster *tighter* and may not make it looser
                 than the routing was sized for; raising the ceiling is one
                 constant and the padding follows it for free, which is why that
                 test asserts against the derivation rather than against 800.
                 Nothing new crosses the wire, because the overlay's countdown is
                 already `readyAtTick - tick`. What is deliberately still global
                 is **how many bodies a spawner holds**: `SpawnerState.entityId`
                 is one id and it is replicated as `SpawnerStates`, so a count is
                 a change to the sim's spawner state, the wire and the overlay --
                 a feature rather than a property of the marker in front of you.
                 Since spec 213 a flight also **commits to somewhere**.
                 `fleeFrom` used to re-derive "directly away from my attacker"
                 every tick from the attacker's *current* position, which is
                 stable only while the attacker is slower than its quarry -- and
                 no player is. A player at 155 closing on a grazer at 40
                 overshoots *through* the fleeing body every frame, so the away
                 vector flipped sign at 60Hz: measured off a real `step`, the
                 velocity alternated +40, -40, +40, -40 and the body oscillated
                 between two coordinates two thirds of a unit apart for the rest
                 of its flight. It never dropped its target and never left
                 `Fleeing` early -- the one temperament whose entire behaviour is
                 *leaving* simply could not leave, which from outside is
                 indistinguishable from having given up. `ServerEntity.fleeGoal`
                 is that commitment: written by `provoke`, which is the one
                 moment the attacker's position is the right one to measure from,
                 cleared by `calm` and `engage`, and moved by exactly two events
                 -- the goal is reached, or a fresh blow lands. "Hit it again and
                 it bolts anew" is a rule a player reads off the screen; a
                 heading re-derived every 16ms is not.
                 `sim/idle.ts` is the other ninety-nine percent of a monster's
                 life (spec 213), and before it there was no answer at all: a
                 body with no target stood on the exact coordinate its spawner
                 put it on forever, and `walkHome` returned one to its anchor
                 carrying whatever damage had been done on the way out -- which
                 is pull-and-reset, wide open, with the leash itself doing the
                 work. One function and one call site, so coming home, milling
                 about, walking a beat and recovering are one answer rather than
                 four: the walk home a broken leash started, then home if it has
                 merely been dragged off its ground, then the plan its row
                 authors, recovering throughout. `beyondLeash` lives here since
                 spec 248 rather than in `world.ts`, because the leash stopped
                 being only a reason to drop a target: it is the one thing that
                 starts a walk home, and the walk home is this file's.
                 A row authors that plan as a second union beside `Temperament`
                 rather than a fifth member of it, because the two are
                 independent questions -- a temperament is how a body meets a
                 *player*, this is what it does when there is none, and the
                 ravager ignores you and still grazes. Folding them together
                 would be five temperaments becoming fifteen. Same authoring
                 rule, which is why both are unions: **a row only names a number
                 the behaviour it chose actually reads**, so a sentinel has no
                 radius and a wanderer has no post count. Absent means
                 `DEFAULT_IDLE`, filled in by `withTraits` exactly as `traits`
                 is, so "all units wander" is a property of the default rather
                 than of five rows each remembering to say so -- and the one row
                 that declares `sentinel` is the training dummy, which would
                 otherwise be a training dummy you had to chase.
                 Three rules. **Nothing draws from the `Rng`**: a spot is a hash
                 of `(entity id, epoch)` through `shared/hash.ts`, the precedent
                 `crowd.ts`'s `symmetryBreak` set and for the reason stated
                 there -- the sim's draw *count* is load-bearing, and a field of
                 monsters sampling the PRNG sixty times a second would move every
                 combat roll in the world. `idle.test.ts` asserts that as a
                 property: the `Rng` state after twenty seconds with six
                 wandering monsters equals the state after twenty seconds with
                 none. **So there is no new entity state for any of it** -- where
                 a body is headed is a pure function of its id and the tick, and
                 a goal that is derived cannot be persisted wrong, expire wrong,
                 or be forgotten to be cleared when a fight starts. The epoch is
                 offset by a per-body hashed phase and a patrol's direction and
                 start angle are hashed too, so a herd does not step off together
                 and two sentries do not orbit as a formation. And **arriving is
                 not marked anywhere**: the goal does not move until the plan's
                 own clock turns it over, so a body that has reached it simply
                 stands there -- *that standing is the dwell*, and "pick a spot,
                 hang out on it, move on" needs nothing counting the hanging out.
                 Recovery is the fourth thing and is deliberately **not** part of
                 that order, because it is not a place: it is gated on
                 `StatusId.InCombat` rather than on arriving home, so the rule
                 stays one sentence -- *a monster nobody is fighting recovers* --
                 instead of a special case bolted to the leash. Linear rather
                 than a percentage of what is missing, since a curve that
                 approaches full without reaching it leaves the exploit intact at
                 the tail. It is also the one place in the sim that asks for
                 *less* than a body's full speed: `IdleGoal.pace` is a magnitude
                 on the intent vector, which `resolveMovement` already honours
                 and `applyCrowd` already round-trips exactly, because a field of
                 monsters sprinting between random points reads worse than a
                 field of statues. Coming home is the exception at full pace --
                 a body dawdling through the distance a leash just measured would
                 be catchable for the whole return trip, which is the exploit
                 arriving by the other door.
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
                 last input it **applied**. So `approachLead` floors the client's
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
                 Since spec 244 progression is **one pool and six tracks**, and
                 `docs/progression-model.md` is the standing description of it.
                 `specializations.ts` is the thirty-six mechanics a milestone
                 makes purchasable -- six per attribute, gated on the attribute
                 you actually built, bought a *tier* at a time out of the same
                 `unspentProgressionPoints` an attribute point comes from. That
                 shared pool is the whole design: a point pushes a track further
                 or deepens something the track already unlocked, and **spending
                 on a specialization never raises the attribute**, so reaching
                 the next milestone always costs points spent on the track. It
                 was two currencies until 244, and the comment on
                 `PersistedPlayer` defended the split -- a point that can be
                 either makes every specialization compete with a stat -- which
                 is a real hazard whose price was that the player never made the
                 decision the system is about. The award schedule is the two
                 summed rather than either kept (6 + 4/level against 5 + 3 and
                 1 + 1), so a level-20 character holds the same 82 points they
                 always did: a conversion, deliberately not a rebalance.
                 They were "skills" and the rename is not tidiness -- that word
                 already meant the four **active abilities** a character equips
                 (`skill1..skill4`, `activeSkillId`, `SkillSlot`), which are a
                 different system with a different UI and are untouched.
                 `tracks.ts` is the assembler both the sheet and the audit read:
                 six nodes per attribute at 10/20/25/35/40/50, each carrying
                 either an automatic milestone or the specializations it unlocks.
                 No threshold moved and no mechanic was invented. All eighteen
                 milestones share a name with a specialization the track unlocked
                 earlier and *deepen* it, which `MilestoneDefinition.deepens`
                 records rather than leaving the sheet to print one name twice.
                 What is **gone** is `synergies.ts` and its fifteen authored
                 two-attribute bonuses. They were content nobody asked to be
                 surprised by, present because a test required all fifteen to
                 exist, and whether the mechanics already compose was untestable
                 while the authored layer was in the way. Three tests assert the
                 absence now -- in the tables, in the resolution over all fifteen
                 pairs, and in the client view. The systemic interactions are
                 untouched and are the point: Strength pressures Guard,
                 Perception reads openings, Wisdom stretches the pool. If
                 playtesting says that is not enough, synergies come back
                 deliberately, with content behind them, in a spec of their own.
                 Spec 056's branch-locked Might/Finesse/Arcane tree went at 147,
                 for a related reason: a system whose premise is that unusual
                 combinations should be discoverable cannot also have three
                 columns that permanently foreclose each other. Beside these are
                 the rest of the progression tables -- six attributes, eighteen
                 milestones -- and `scaling.ts`, which is every coefficient
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
                 attribute viable when heavily invested in. The fifteen pairs
                 used to have a rule of their own -- each producing an authored
                 interaction, with a pair missing a row failing CI -- and spec
                 244 inverted it: what fails CI now is a pair contributing a
                 modifier that neither half contributes alone. The design rule
                 became *every pair should be capable of an interesting build
                 through the systems, and no pair needs a bespoke bonus.*
                 They are still **never named on the character sheet**, and that
                 is still a rule with a test behind it: naming them would turn
                 things to discover into things to build toward, and the question
                 the sheet exists to ask is "how do I want to solve problems".
                 What the sheet *does* say is what each attribute changes
                 next, and one short line per stat row -- and where something is
                 a socket with nothing plugged into it yet, that line says so in
                 as many words rather than describing a number that never moves.
                 The structural commitment is one line in `attackTimingFor`:
                 **Agility scales the attack point and the follow-through's cancel
                 point, and nothing it writes reaches `baseAttackTimeTicks`.** A
                 high-Agility character attacks exactly as often as anybody else
                 and spends far less of each cycle rooted, which makes "the fast
                 stat must not become the mandatory damage stat" a property of the
                 module graph rather than a number somebody keeps retuning. Since
                 spec 258 it does not reach `baseAttackBackswingTicks` either --
                 the phase is the same length for everybody, and what Agility buys
                 is the tick it may be walked out of.
                 The derivation runs one way and stops (`player/progression.ts`,
                 `player/derived.ts`): allocation plus held grants settles the
                 attributes, those decide which milestones are met, and only
                 then do their grants feed the traits. A milestone therefore
                 cannot unlock a milestone -- the graph is acyclic *by
                 construction* rather than by nobody having yet written the loop,
                 and it costs one thing, which is that an item granting +5
                 Strength can open a Strength milestone while a *milestone*
                 granting the same could not. No milestone grants an attribute
                 and a test says so. Hop 2 is milestones and nothing else since
                 spec 244.
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
                 `world/spawn-presentation.ts` is what a body's **arrival**
                 looks like (spec 263), and it is the flinch's shape one event
                 earlier: a `read` per body per frame, an offset added to the
                 drawn transform, `forget`/`retain` for its own bookkeeping, and
                 nothing it returns reaching a decision. Until it existed nothing
                 in this game arrived -- a monster was a coordinate that did not
                 have a body on it and did on the next frame, and a player who
                 pressed Respawn was standing on the pad between one frame and
                 the next.
                 There are **two presentations and no more**, and the split is a
                 fact about the *rigs* rather than a list of type ids.
                 `MechRig` is the only rig here with **world-locked feet** --
                 `stabilise` draws each leg from a hip carried through
                 `carriage.matrix` to a foot that is independent of it -- so it
                 is the only one that can plant its feet while the body they
                 carry is still underground. The spider and the Warden share
                 that rig, so they share the **burrow**; a critter's legs are
                 sine-driven bone rotations of one skeleton with no plant to
                 hold, and an authored unit would need a clip nobody has
                 authored, so everything else gets the **poof**.
                 `MechRig.burrow` is the whole rig change: one public number,
                 0..1, subtracted from the carriage *outside* the sway clamp
                 (that clamp is sized for a chassis bobbing on its suspension and
                 this is a body height), with `hiddenDepth` beside it as a
                 **getter** for `openingWorld`'s reason -- how tall a mech is, is
                 `(BODY_Y + half the body) * sizeScale * bodySize`, and a caller
                 carrying its own copy would bury the spider correctly and leave
                 the Warden's turret in the grass the first time somebody
                 retuned it. At 0 it draws what it drew before, joint for joint,
                 which `rigs-burrow.test.ts` asserts against a lockstep control
                 rather than trusting that a term multiplied by zero is zero.
                 The one thing the **server** had to add is `spawnTick`: the tick
                 a body was created, riding the `Spawn` field. `EntityField.Spawn`
                 is set "the first time an entity enters this client's interest
                 set", which is the same delta for a monster made a moment ago
                 and one the player has walked toward for a minute -- so an
                 arrival drawn off that bit alone would poof every body on the
                 map as you approached it. It is `LootDrop.spawnTick`'s decision
                 verbatim and for its stated reason, on the field whose own
                 comment is "sent once": four bytes per body per client, nothing
                 per tick. **A respawn is deliberately not a spawn tick** --
                 `respawn` heals and moves the body it already has, so no body is
                 created and the field is not re-sent -- and the client reads the
                 dead-to-alive edge it watched instead, which is
                 `stagger-flinch.ts`'s rule (*the window is replicated, the start
                 is observed*) with the same consequence: a client that turns up
                 after somebody else's respawn draws nothing, which is right.
                 **No gameplay timing moved.** There is no spawn state on
                 `ServerEntity` and this adds none: a body is targetable, can
                 move and can attack on exactly the tick it always could. The
                 presentation **yields** instead -- a body that dies or commits
                 to a cast settles on that frame, so nothing is ever drawn
                 swinging from under the ground. Walking is deliberately not a
                 commitment, because a monster's idle plan sets off on its second
                 tick and a rule that yielded to it would be a rule under which
                 the emergence never plays at all.
                 Interruption costs nothing to unwind, and that is structural
                 rather than careful: `scene.ts` writes the whole position and
                 the whole `burrow` every frame -- the rule `rotation.z = flinch.pitch`
                 beside it already follows -- so a settled body reads `SETTLED`,
                 whose offsets are zero, and there is no state to put back.
                 The staging has one number that was **measured rather than
                 chosen**, and `preview-emergence.ts` is what measured it. A leg
                 has a fixed reach, so how far a knee can arch above the ground is
                 what is left after spanning from a sunken hip to a planted foot
                 -- and at a drop deep enough to hide the body outright there is
                 almost none. Photographed at the full depth every leg came out
                 *straight*: the spider's knees cleared the ground by about a unit
                 and the Warden's did not clear it at all, so the stage whose
                 entire job is *legs, no body yet* drew nothing on the larger
                 body. `DIG_DROP` is 0.78 for that, and what it costs is that the
                 body's top edge breaks the surface during the dig instead of
                 staying under it -- the better picture anyway, since a thing
                 clawing out of a hole is not invisible. What it cannot fix is
                 recorded rather than papered over: the Warden's reach is 60
                 against a 34-unit foot offset and a body 56 tall, so there is
                 **no** drop at which its body is hidden and any part of its leg
                 is above ground. It is a box on short legs and it heaves up with
                 its shoulders and knees together; the staging is tuned to the
                 spider, which can lead with its legs.
                 The two effects are `brushPoof` and `brushDirt` in
                 `vfx/brush.ts`, both one-shots (so nothing owes a stop) and both
                 on mesh shapes and blends the registry **already batches** --
                 `brush-blot`, `brush-dab` and `brush-flick` in `alpha` -- so
                 `library.test.ts`'s 25-batch ceiling did not move. The dirt is
                 the one effect in that file with a *shape over time*: a hit is
                 an instant and digging is a job, so it is `emission: 'ramp'`,
                 the one emission kind whose rate is a curve, peaking a third of
                 the way in where the feet are through and ending at exactly zero
                 -- a ramp that stopped short would leave its last marks born on
                 the final tick and still airborne after the body was standing.
                 Neither invents a colour: `dustSnow`/`dustPale`/`smokeLight` and
                 `dustEarth`/`paintBrown`/`paintSoot` were all already there.
                 `npx tsx scripts/preview-emergence.ts` is the instrument, and the
                 thing that makes it one rather than a screenshot is that **it
                 draws the ground**: being underground here is not a material or a
                 clip plane, it is the terrain being in front of you, so a preview
                 without an opaque floor would show the whole rig hanging in the
                 air at every phase and prove nothing. It prints what fraction of
                 the body and of the legs is above the ground at each phase, and
                 the knee's height against the body's top -- which is the number
                 readability actually turns on, since a leg with no slack left is
                 drawn straight and a straight leg from a sunken hip is almost
                 entirely buried however far out its foot is.
                 `world/status-marks.ts` is that same swirl generalised to the
                 rest of the progression (spec 186), and it is built to the
                 stun icon's three rules on purpose, because they were the right
                 ones and a second answer to "how does a timed state get drawn"
                 is a second thing to keep in step. **Stateless**, so a body
                 that walks into view already Exposed is marked -- there is no
                 start to have missed, which is exactly what separates a *state*
                 from the flinch's *contact*. **A stale entry is refused on
                 read**, the same comparison `statusOf` makes in the sim, which
                 is what makes correctness independent of whether the delta
                 saying "it fell off" has arrived. And **the fade is a count of
                 ticks**, since the function is handed an end and not a length
                 -- more clearly right here than there, because these windows
                 vary from a 1.2s Flow to a several-second Adaptation and a
                 fraction would fade the long one for seconds. Order is by wire
                 index rather than by arrival, for the reason `AURA_ORDER` is
                 fixed: a mark must not slide along the row because something
                 else was applied. Colour is by `kind` and by nothing else --
                 eight colours over a head is a legend rather than a picture,
                 and "is that good for them or bad for them" is the question a
                 player asks first. The thing that keeps it from shipping dark:
                 almost every row is milestone-gated, so a fresh character could
                 have gone on seeing an empty row forever with nobody noticing
                 the wire was wrong. `Vulnerable` is written on *commit*, for
                 anybody who swings at anything, and a test asserts a mark
                 appears from one ordinary swing.
                 `admin:triggerEvent 'status'` is the developer path beside it,
                 in the same register as spec 158's `'drop'` and `'reveal'` and
                 for the same reason -- it writes only into `statuses` and draws
                 nothing from `state.rng`, so it can no more change an outcome
                 than the real thing can.
                 `npx tsx scripts/probe-status-marks.ts` is the half no headless
                 test can see, and it earned its place immediately: every Node
                 assertion passed while the row drew a line of **specks**. The
                 per-body holder is a fixed 52px -- the health bar's width -- so
                 eight 13px marks left in flow are flex items in a box too small
                 for them, and flex's answer is to shrink them to 3px each. What
                 is drawn, in what order, in what colour: all true, all
                 unreadable. The row is `width:max-content` and re-centred with
                 half-shifts so it is never in that negotiation, and the probe
                 measures the marks' actual boxes rather than their presence.
                 It also asserts the health bar **does not move** when the row
                 appears, which is the whole reason a bottom-anchored holder may
                 grow at the top at all -- the cast bar had to be taken out of
                 flow for exactly this.
                 `world/affliction-vfx.ts` is what a *body* says about the same
                 thing (spec 215), and it exists because a mark over the head is
                 the wrong shape of information for an affliction: an affliction
                 is the one damage here that stays on a body after the thing
                 that did it walked away, and until this the only difference
                 between four seconds of fire and ten seconds of rot was which
                 thirteen-pixel glyph sat in a row of glyphs. So the seven get
                 painted, in the spec 158-162 vocabulary, and three sockets that
                 had been waiting with comments naming this work got filled:
                 `auras.ts`'s *"the day a status list is replicated, `aurasFor`
                 gains a branch"* (spec 186 replicated it; `aurasFor` and
                 `AuraTracker` had no caller outside their own test for
                 seventy-five specs), `EmitterShape`'s `{ kind: 'mesh' }` --
                 *"the surface of whatever the effect is attached to ... what
                 makes a **burning-unit** definition safe to preview in
                 isolation"*, with no burning-unit definition and no `surface`
                 hook, so in the game it had never resolved to anything but a
                 point -- and `scene.ts`'s attach hook, *"the effects that need
                 a socket, a burning unit, arrive with the fire work"*.
                 The decision the whole thing turns on: **the beat is derived,
                 not sent**. `WireStatus` carries an *absolute* `expiresAtTick`
                 and `data/damage-over-time.ts` is shared code, so
                 `elapsed = tick - (expiresAtTick - dotDurationTicks(row))`
                 recovers the entire schedule -- the same rule `loot-drop.ts`'s
                 reveal phase and `stun-icon.ts`'s swirl already are. Every
                 client beats together, nothing new crosses the wire, and the
                 paint lands on the frame the damage number does, which is the
                 whole difference between "there is a green haze on that thing"
                 and "that thing is being poisoned". It is a **count** rather
                 than "is this tick a pulse tick", and that half is
                 load-bearing: a frame drains several ticks -- three at 20fps,
                 and this environment paints a real page at about five -- so the
                 modulo version skips most beats and *all* of them on a slow
                 frame, where counting what has landed and firing on the
                 increase is frame-rate independent by construction, and fires
                 **once** for a frame that drained three, because a beat is a
                 beat and not a quantity. One stated limit: the sim measures
                 elapsed from `appliedAtTick`, which a refresh does not move,
                 and the client has only the expiry, which it does -- so after a
                 refresh the phase can sit up to one interval off. The *cadence*
                 stays exact, the offset is under half a second on every row,
                 and it is accepted rather than fixed with a protocol change.
                 That split is `auras.ts`'s own line -- *"a hit happens; a poison
                 lasts"* -- with an affliction being the first thing here that
                 is both: the **cling** is a state, started once and stopped
                 once and drawn for a body that walked into view already
                 burning; the **beat** is an event and needs an edge, the way
                 `stagger-flinch.ts` does and for the same reason.
                 `vfx/brush.ts` gained the two builders. Four things about the
                 vocabulary decided their shape rather than taste.
                 **`worldSpace: false` is the whole of "it clings"** -- the
                 compiled default is `true` and attaching an effect moves only
                 the emission *origin*, so a mark born on a walking body and
                 left in world space is a mark the body walks out of. **The
                 shape choice is the orientation choice**: `brush-blot` is
                 `tumble`, world space, so the cling turns with the body's own
                 volume, while `brush-slash` and `brush-flick` are
                 `cardVelocity` and always face the camera, which is what a beat
                 must do; `brush-mark` is `ground` and is the one brush shape
                 that cannot go on a body at all. **`fizzle`, never `retract`**
                 for anything held long enough to be watched -- spec 161's rule,
                 and this is the case it was written about. And **`alpha`,
                 nothing additive**, which matters more here than anywhere else
                 in the file because a cling is many overlapping marks on one
                 body *by construction*: the one arrangement where a translucent
                 mark is guaranteed to cross another and make a third colour in
                 neither of them.
                 Every length is in **body radii**: the driver plays with
                 `scale` set to the footprint radius and the `surface` hook
                 answers in the same units, and `system.ts` multiplies both the
                 shape's local coordinates and the size curve by it -- so one
                 authored definition lands on a spider and on a player at the
                 right place *and* the right size. Speed and gravity are not
                 scaled, which is correct, because gravity is gravity.
                 Severity is **two tiers and more paint, never brighter paint**:
                 the count is already drawn over the head, so what the paint owes
                 is severity, brightness is what the beat says, and one signal
                 meaning two things is a legend nobody can read. Frostbite
                 crosses on *elapsed* rather than stacks, since its ramp is that
                 row's whole design; Burn and Shock get no heavy tier at all,
                 because neither stacks and neither ramps and a louder version
                 would be a picture of a state that never happens.
                 The driver does its own diff rather than using `AuraTracker`,
                 and the reason is specific: **`play` returns 0 on refusal** --
                 unknown id, over budget, beyond `cullDistance` -- and a tracker
                 that records *ids* cannot say "wanted, asked for, did not
                 start", so committing a refused id leaves a body silently
                 unmarked for the rest of its life. Holding **handles** makes a
                 refusal mean "not started yet". The obligation that comes with
                 that: on despawn **nothing stops itself** -- the attach hook
                 answers false, the instance stays where it last resolved, and a
                 `durationTicks: 0` effect hangs in the air forever holding one
                 of 128 slots -- so `forget` is called from the sweep that knows
                 a body has left, never inferred from an absence. Nothing in
                 this game had ever held a persistent attached effect, so this
                 is the pattern rather than a use of one. The other half of the
                 same problem is **eviction**, and it was found by reading
                 `claimInstance` rather than by anything failing: a full instance
                 pool does not refuse, it takes the lowest-priority furthest
                 instance, hands the slot over and bumps its generation, so every
                 handle to it goes stale where it sits. A cling is priority 1 and
                 therefore the first thing in the game to go -- correctly, since
                 the fight in front of you matters more than paint on a body
                 across the arena -- and a driver that went on believing its
                 handle would leave that body unpainted for the rest of its life,
                 silently, and only in the crowded fight that caused the
                 pressure. `isLive` is asked every step and a dead handle is "not
                 started".
                 The palette gained two ramps, and each had to be unmistakable
                 against the neighbour it would otherwise read as: Corrosion is a
                 *chemical* green pushed toward chartreuse against Poison's leaf,
                 because two greens read as one affliction at two intensities and
                 that is exactly backwards; Decay is the only **desaturated**
                 ramp in the table, since what it does is suppress healing and it
                 should look like colour draining rather than colour landing.
                 `presentation-only.test.ts` drives it beside the machines, the
                 eased yaw and the drop's reveal, and it is worth having there
                 for one reason past the others: an affliction is the first thing
                 a client works out the *schedule* of for itself, so the obvious
                 way to get it wrong is to let that derivation reach back into
                 something.
                 `world/aura-vfx.ts` is the ring beside that paint (spec 223),
                 and it is the first thing in this game that has ever played an
                 aura. Spec 124 built the sigil -- three generated meshes,
                 `uOrient` on the mesh batch for it, `hardStop` on the effect
                 format for it -- and spec 121's `aurasFor` has carried a status
                 parameter and the sentence *"the day a status list is
                 replicated, this gains a branch and nothing else in the renderer
                 changes"* since it was written. Spec 186 replicated them and
                 nothing came back to collect, so for a hundred specs the whole
                 path was reachable from the Studio tab and from nowhere else,
                 with a complete green suite beside it the entire time. The branch
                 is `AuraFacts.fields` -- status **ids** rather than a kind,
                 because a field already names its own ring in
                 `data/aura-fields.ts` beside the radius that ring is drawn at, so
                 the mapping is a table lookup and not a rule. The other four
                 facts the mount states `false` rather than leaving to a default:
                 `aura_selected` would be a second answer to what `targetRing`
                 already draws, and the rest are a look change with their own
                 decision to make.
                 That radius is **imported into `vfx/library.ts` rather than
                 retyped**, which is the one thing about the ring worth arguing
                 over: it is not decoration around the mechanic, it is where the
                 fire is, and a player who cannot tell which bodies are inside it
                 cannot play the skill. Two literals that have to agree is the
                 drift `ground-decal.ts` exists to refuse one level down.
                 The driver is built to `affliction-vfx.ts`'s three rules because
                 the machinery and the failure modes are the same, and it cannot
                 use `AuraTracker` for the reason that file states at length:
                 **`play` returns 0 on refusal**, and a tracker recording *ids*
                 cannot tell "asked for, did not start" from "started" -- which
                 for a ring is worse than for a cling, since a missing one is not
                 missing paint, it is a hazard nobody can see. So it holds
                 handles, asks `isLive` every frame (a full instance pool
                 *evicts* rather than refusing and bumps the slot's generation),
                 and **owes a stop**: an aura particle is given `HELD` ticks --
                 ten minutes -- so one left on a despawned body holds a slot for
                 the session.
                 `npx tsx scripts/probe-aura.ts` is the half no headless test can
                 see, and on this feature that is not a formality: it reads
                 `data-auras`, published from the driver's own held set rather
                 than from the statuses that asked for a ring, so one refused by
                 the budget or evicted by the pool reads as absent. Its **control**
                 is worth as much as its measurement -- a probe whose "after" is
                 right and whose "before" was never checked cannot tell a working
                 driver from one that puts a ring under everything.
                 `admin:triggerEvent 'field'` and `?field=` are the developer path,
                 in the same register as spec 215's `'affliction'` and for its
                 stated reason: the alternative is farming a level-6 exceptional
                 sigil every time somebody wants to look at the ring.
                 `sim/crowd.ts` and `sim/attack-slots.ts` are what a tick does
                 to a body because of the bodies around it (specs 187, 227). Until they
                 existed nothing on the server knew that two units were in the
                 same place: `resolveMovement` is handed `{ world, terrain,
                 config }` and has never once looked at another entity, so a herd
                 walked as one point and a pack chasing a player converged into a
                 single stack. (`src/sim/collision.ts`'s `resolveOverlaps` was the
                 closest thing to a fix and had no caller anywhere -- a survivor
                 of the single-player sim spec 062 deleted.)
                 crowd.ts is two halves, deliberately different in kind, and the
                 difference is why neither alone is enough. `solveAvoidance` runs
                 **before** anybody moves and is a *velocity* rule, so it is
                 invisible until a body is on a collision course and never fights
                 the body's own intent. `resolveCrowding` runs **after** everybody
                 has moved and is a *position* rule, so it works on bodies that
                 are not moving at all -- what a spawn, a stagger, a wall or a
                 body with no legal velocity leaves behind -- but it is exactly
                 the rule that shudders if you lean on it, which is why it is a
                 fraction of the overlap per tick and a safety net rather than the
                 mechanism.
                 Three fields carry the policy and the last two are separate
                 questions: `pinned` (not solved for, everybody else takes the
                 whole avoidance against it), `bumps` (in the overlap pass at
                 all), `pushLimit` (how far it may be displaced in a tick). A
                 player is pinned *and* does not bump, and both are stated limits
                 rather than simplifications -- their movement is predicted on
                 their own machine (spec 067), so deflecting it here would cost a
                 correction every tick a monster came near; and shoving bodies
                 aside by walking into them is a design decision with consequences
                 for every reach and chase in the game, which this is not. The
                 push cap is a fraction of the body's own **speed**, and that was
                 learned the hard way: capped at a fraction of its *radius* it was
                 eleven units a tick for a grazer -- six hundred a second against
                 a walking speed of forty -- so a player walking into one
                 bulldozed it across the map faster than it could run, and it
                 could not be caught. Every number was small and the product was
                 absurd, which is the same failure `turn-swing.ts` exists to
                 catch.
                 `symmetryBreak` gives each body a constant tenth of a degree of
                 asymmetry hashed off its id, because *exact* mirror symmetry is
                 the one configuration reciprocal avoidance is bad at and a game
                 spawns bodies on grids and marches them in ranks. Hashed rather
                 than drawn, since the sim's `Rng` draw *count* is load-bearing;
                 and applied as a rotation by `atan(slope)` built from `Math.sqrt`
                 rather than from `Math.cos`/`Math.sin`, which ECMAScript permits
                 an implementation to approximate differently -- a
                 replay-divergence hazard hiding inside a constant nobody would
                 ever look at again.
                 attack-slots.ts is where a target's attackers stand, and it
                 exists because avoidance alone cannot fix a pack: avoidance
                 answers "how do I not walk into you", and the problem when twelve
                 bodies chase one player is that everybody genuinely wants the
                 same place. So each attacker takes a **bearing** on its target
                 and aims at that bearing at its own standoff **while it closes**,
                 stopping when it is in reach, wherever on the way that happens.
                 The ring is an approach preference and never a destination --
                 marching to an exact standing position is what makes a pack of
                 animals look like a drill squad, and what makes them shuffle
                 forever when the target moves.
                 Spec 187 cut the ring into evenly spaced *slots* instead and
                 handed one to each attacker, and spec 227 replaced that with
                 angular separation because a lattice has to decide its own
                 granularity and every answer it can give is wrong for somebody.
                 It was cut once per target for the **widest body on it** -- it
                 has to be, since a spider's ring is seventeen slots and a
                 ravager's is six, and two sets of angles that do not line up
                 stack the pair on exactly the ground the ring exists to keep them
                 off -- so **one ravager joining twelve spiders took the count
                 from 17 to 6 and left seven of the thirteen with no slot at all**,
                 aiming at the quarry's centre. Twenty stalkers were ten slots and
                 ten denied. Its angles were in the world frame, so a body
                 approaching from the west was snapped up to `pi / count` off its
                 own bearing -- 30 degrees with a ravager in the fight -- whether
                 or not anybody else was there, which is a lone monster sidling.
                 The bearing a body is given now is the bearing it already has,
                 and bearings are moved **only where two of them are closer than
                 the two bodies can actually stand**. Four things follow, and each
                 is something the lattice could not do. One attacker is left
                 exactly where it was aiming, and so are two arriving from
                 opposite sides. An attacker that dies does not re-shuffle the
                 survivors, because a gap only ever grows. A body standing in its
                 place keeps it, so **there is no hysteresis to hold on the
                 entity** -- `ServerEntity.attackSlot` is gone, and holding still
                 is a fixed point rather than a property the assignment has to be
                 careful to preserve. And the granularity is per pair rather than
                 per target, so nothing is coarsened by the biggest body present.
                 `requiredGap` is that pair rule, and it is the law of cosines
                 between the two rings the bodies are on rather than a sum of the
                 angles they each subtend. That is worth an `acos` for the two
                 answers a sum cannot give: **zero**, when the rings are far
                 enough apart that no bearing can make the bodies touch -- a
                 slinger at 252 units and a stalker at 68 are never in each
                 other's way, and separating them makes the slinger sidle for
                 nothing -- and **pi**, when they overlap even facing away, where
                 no ring can help. On equal rings it reduces to the chord formula
                 `slotCount` divided a turn by, so nothing about a pack of one
                 species is re-derived.
                 The placement is a **cumulative pass, not a relaxation**, and
                 that is the one thing here that had to be measured rather than
                 reasoned about. The obvious version -- sweep the ring pushing
                 each crowded pair apart by half its shortfall, a dozen times --
                 is what the abandoned branch this is taken from wrote, and it is
                 diffusion: information travels one body per pass, so the passes
                 grow with the *square* of the bodies. From the worst start there
                 is, every body arriving on one bearing, a ring filled to capacity
                 was still short of the room it wanted by **22% of the gap at nine
                 bodies and 64% at fifty-seven**, after eight passes each. Cutting
                 the circle at the pair with the most room to spare -- which
                 always exists, since the slacks sum to `TAU - wanted` -- turns it
                 into a chain, and a chain settles exactly in three O(n) passes:
                 push every shortfall forward, pull the far end back in if the
                 chain outgrew the circle, and turn the whole ring back so the
                 average body has not moved. That last step is free, since every
                 constraint is on a *difference* of bearings, and it is what makes
                 a pair sharing a bearing part about it rather than one of them
                 being pushed round behind the other for having sorted first.
                 A body that has **stopped is a wall**: it holds its true bearing
                 at its true distance, and the body closing onto it takes the
                 whole correction. That is spec 187's "somebody else's
                 reservation is as good as a claim" in this geometry, and pinning
                 at the *actual* distance is what lets the pair rule tell a body
                 standing in reach from one loitering three hundred units out.
                 There is **one ring and no queue**, and the version with a second
                 one further out was written and measured before it was dropped:
                 `standoff + k * step` is past `monsterIntent`'s `closing` test,
                 which asks whether a body is inside *its own reach* rather than
                 whether it arrived where it was sent -- so an outer-ring body
                 walks to a point it can never register as reaching and stands
                 there twitching at an aim it is already on. `converge` went from
                 18 of 20 bodies ending within reach to **9 of 20**, the other
                 eleven parked outside the fight, and `gate`'s jitter p95 from
                 0.025 to 0.193. A ring too small for its pack shares itself out
                 instead -- every gap shrinks by the same factor -- and `crowd.ts`
                 resolves the density that leaves, which is what this game has
                 avoidance for. Standing a pack back so it never shoves was the
                 abandoned branch's premise, not this one's.
                 The board is still **rebuilt every tick, never released by
                 event**, since a body leaves a fight in half a dozen ways no
                 release covers -- it dies, it is dragged past its leash, it loses
                 interest, its chunk stops being simulated -- and it is planned
                 for every target *before* the movement pass, because angular
                 separation is a question about a target's whole crowd: the answer
                 for the third attacker depends on the first two, so asking them
                 one at a time would make it depend on creation order. What it
                 costs is stated rather than hidden: the placement is about 0.5us
                 per attacker per tick, and a whole tick with a hundred bodies
                 conjured onto one quarry went 1.40ms to 1.55ms -- under a
                 hundredth of a frame, against `converge` ending with **no two
                 bodies touching at all** where the lattice had them touching on
                 19.7% of body-frames.
                 The ring aim only applies where the straight line to the target
                 is clear, and that is not a simplification either: a ring point
                 is a place nobody has checked, so it can be inside the wall the
                 target is standing behind, and handing one to `findPath` turns
                 "there is no way to my target" into "there is a way to this other
                 spot" -- which parks a body against a palisade instead of
                 pressing at the gate, and quietly retires the retry cadence spec
                 073 put on hopeless searches.
                 The pass they hang off restructured the tick: the movement loop
                 decided and moved each body before the next was asked anything,
                 which is the one shape reciprocal avoidance cannot be built in --
                 a body that has already moved is one its neighbours avoid in the
                 wrong place, and one that has not is one whose velocity is a tick
                 stale. It is three passes over the same list in the same creation
                 order now -- decide, solve, move -- plus the overlap pass after.
                 `ServerEntity` gained `velocity`, which is what the body
                 *actually* travelled at rather than what it asked for, so a body
                 pressed into a tree tells its neighbours it is going nowhere.
                 Nothing is replicated and nothing is asked of the client.
                 `npx tsx scripts/preview-crowd.ts` is the picture and `npx tsx
                 scripts/bench-crowd.ts` the cost; both share
                 `scripts/crowd-scenarios.ts` with `sim/crowd.test.ts`, so a panel
                 that looks wrong and a green test cannot both be true. The
                 shipped map cannot field these crowds -- twelve spawners, one
                 monster each, five self-initiating attackers at the tightest
                 cluster -- so the bodies are placed, which is what an admin
                 conjuring a fight does.
                 `sim/statuses.ts` is one small timer map and everything the
                 progression needs to remember between ticks goes in it, because
                 twelve mechanics as twenty-four entity fields is twenty-four
                 places for an expiry to be forgotten. Expiry is a comparison and
                 never a sweep, so reading a stale entry cannot produce a live
                 effect. Since spec 190 an entry also carries `sourceId` and
                 `appliedAtTick` -- who put it there, and when it *first* landed,
                 kept across a refresh -- because a status can now kill, and
                 because a periodic effect wants a phase rather than a countdown.
                 `data/damage-over-time.ts` and `sim/damage-over-time.ts` are the
                 afflictions (spec 190), and the thing to know about them is that
                 **a pulse is not a blow**. Every point of damage in this game
                 used to arrive at the instant a blow landed; the only thing that
                 repeated was a channel, which is caster-bound. An affliction is
                 the other shape -- it stays on the body after the thing that did
                 it has walked away -- so it needed a rule of its own, and running
                 one through `resolveBlow` sixty times a second would have rolled
                 a crit each time (**the Rng draw count is protocol**), held
                 `RecentlyHit` open for the whole duration and denied Perfect Exit
                 with it, stacked Adaptation against an ability that does not
                 exist, and re-provoked a body the applying blow had already
                 provoked. So a pulse is short and honest: shield, then health,
                 then the `hit` event, and **no armour** -- an affliction is
                 already inside, and being the answer to a body you cannot get
                 through is a role worth having. It draws nothing from the Rng at
                 all.
                 The table is one row per affliction and the three numbers it
                 authors are the three a designer thinks in: how hard
                 (`damagePerSecond`), how lumpy (`intervalTicks`) and how long
                 (`pulses`). Everything else is derived, and one derivation is
                 load-bearing: `dotDurationTicks` is `pulses * interval` **plus
                 one tick**, because a pulse fires on `elapsed % interval === 0`
                 and `statusOf` refuses an entry at `tick >= expiresAtTick`, so an
                 exact multiple silently loses its last pulse and "eight pulses of
                 4.5" means seven. Stated once in the derivation rather than seven
                 times in seven hand-authored durations.
                 Past the rate, each row carries at most one **rider**, and a
                 rider is a reader in the system it belongs to rather than
                 arithmetic here: Bleed's exertion is the *replicated* `activity`
                 (`Moving` or `Casting`), so "stop moving and it hurts less" is a
                 fact anybody watching can see; Corrosion's armour is
                 `StatusId.Sundered`, so there is one armour-reduction reader in
                 `blow.ts` and not two, and it is written **once when the
                 affliction lands** rather than per pulse -- per pulse re-stamped
                 a shared status thirty times a fight, and since `applyStatus`
                 refreshes a clock rather than extending it, each stamp *shortened*
                 a longer Sundered somebody else had applied; Corrosion's guard is
                 the pool written directly and clamped at zero, so it can never
                 break, because an affliction that staggered once a second for six
                 seconds is a removal -- and authored against *regeneration*
                 rather than against the pool, since a monster gets 6 guard a
                 second back and the first cut took exactly 6, cancelling it
                 precisely and doing nothing whatsoever to a stationary body; Decay's suppression is `healingScaleOf`,
                 read at the three places health goes up that are not `applyHealing`
                 -- resting is deliberately not a fourth, since a pulse stamps
                 `InCombat` and `advanceRest` already refuses outright while that
                 is live, which is stronger than any multiplier.
                 Burn's *spread* and Shock's *chain* are one field with two radii,
                 because "how does an affliction reach the body next to it" is one
                 question and a second propagation system would be two answers to
                 it. On a pulse it passes **what is left of itself** to the nearest
                 body hostile to its *source* that is not already carrying it --
                 measured against the source, so a player's fire spreads through
                 the pack and can never turn round and catch the player. That one
                 sentence is also the bound: a hop is only taken on a pulse, so
                 every generation is strictly shorter than the last and the chain
                 burns out by construction, with no generation counter, no hop
                 limit and nothing to tune. Nearest wins and ties break on entity
                 id, the rule `crowd.ts` already uses, so nothing is drawn.
                 The pass is `3c` in the tick, between the projectiles and the
                 kill credit, which is the one correctly bracketed slot:
                 everything that can apply an affliction has run, and
                 `creditDeaths` is driven off this tick's `died` events, so a
                 pulse that kills has to have said so first.
                 Three of `resolveBlow`'s side effects a pulse must *not*
                 inherit, and each was got wrong first. **Hostility is re-asked
                 every pulse**, because `isHostile` between two players needs
                 both of them standing in a pvp zone and every blow and shot is
                 measured where both bodies are when it lands -- an affliction
                 is the first damage here that outlives its own delivery, so it
                 is the first that could carry a wilderness fight over a
                 safe-zone line. **A pulse does not shout**: the `hit` event
                 carries a `periodic` flag and `rally` skips it, since that
                 function's whole bound is one hop per actual blow and a poison
                 ticking twenty times would drag a nest across the map for ten
                 seconds. Spec 219 gave that flag a wire bit
                 (`CombatFlag.Periodic`) for the same reason one level out:
                 **a pulse is not drawn as a blow either.** It was sim-only on
                 the argument that a client draws a floating number the same way
                 whatever caused it -- true of the number and false of the
                 picture, since everything `effectsForBlow` produces is aimed
                 *along* the blow and a pulse's attacker walked off seconds ago.
                 So eight beats of a Poison were eight brush hits thrown down
                 eight bearings that described nothing. The number still rides
                 and the health bar still moves; what a pulse loses is the blow's
                 picture, and what it already has is its own
                 (`world/affliction-vfx.ts`). And **death drops the cast** -- the one thing
                 `resolveBlow` does on a kill that is easy to leave out, and not
                 cosmetic: a player's entity survives death, the cast pass
                 refuses a corpse, and `respawn` rewrites eleven fields without
                 touching `cast`, so a wind-up somebody died in came back with
                 them and landed from the spawn pad on their first living tick,
                 at the coordinates they had aimed at before dying.
                 Reaching one is a single effect verb, `{ kind: 'applyDot',
                 dotId }`, and the absence of the other fields is the design: no
                 duration, no rate, no stacks. **The row is the affliction,
                 whole** -- one whose numbers depended on which skill landed it is
                 one the player carrying it cannot reason about. What does vary is
                 the applier, whose `spellPower` is captured into `magnitude` the
                 way Exposed already captures the exposer's coefficient.
                 Two landings had been dropping `ability.effects` on the floor
                 since spec 188 and both are closed here, because a poison dart is
                 a ranged skill: a projectile's impact resolves in `world.ts` and
                 called `applyDamage` directly (both the direct hit and the
                 burst), and `landSelf` read `healing` and `healingFraction` and
                 nothing else. Both go through the exported `applyToTarget` now,
                 so a projectile skill and a melee one cannot come to different
                 answers about what a row does. `aimShape` was the third of the
                 same kind and had never read `ability.area` at all, so the one
                 ability kind that *is* a shape was the one kind you could not see.
                 `data/aura-fields.ts` and `sim/aura-field.ts` are the affliction
                 that is somewhere rather than on somebody (spec 223). Every
                 landing this game has resolves **once** -- a body, a point, a
                 shape, a flight -- and an affliction, the one thing that outlives
                 its own delivery, is carried by whoever it was put on. Nothing
                 could say *this ground is dangerous while I am standing on it*,
                 which is a question about time and position together and so one a
                 landing cannot answer. A field is `a reach + an affliction + a
                 linger`, all three of them systems that already exist, so the
                 table authors no rate, no cadence and no length: those are
                 `data/damage-over-time.ts`'s to say whole, and spec 190's rule
                 that every Burn in the game is the same Burn is exactly what
                 makes "step out and it goes out shortly" a sentence a player can
                 reason about. What a field *is* to the sim is a **boon its
                 carrier wears**, applied by an ordinary `applyStatus` effect off
                 a `self` skill -- `landSelf` has run `applyEffects` since 190, so
                 the ability system needed nothing.
                 The pass re-lays the affliction **every tick** a body is inside,
                 and the two properties that fall out of that are the feature:
                 standing in it never runs out, because `applyStatus` keeps
                 `appliedAtTick` across a refresh so the pulses keep their own
                 cadence rather than being ticked forever into the future; and
                 stepping out leaves exactly the linger, so the fire goes out a
                 second later wherever you went. Both halves of that were got
                 wrong first and both live in `fieldLanding`, lifted out of the
                 pass so a test asserts the decision rather than its own copy of
                 it. **It never puts out a bigger fire**: `applyStatus` refreshes
                 a clock in *both* directions -- the mistake 190 records making
                 with Corrosion's Sundered -- so a body carrying four seconds of
                 Burn from an Ember Toss that walked into a one-second field would
                 have had three of them cancelled by the fire it was standing in,
                 and the window is the larger of the two. **It never stacks with
                 itself**, because a rule re-applied sixty times a second reaches
                 a stacking affliction's ceiling in `maxStacks` ticks -- and a flat
                 cap of one would cut a five-dart Poison down the moment its
                 carrier walked past, so the ceiling handed on is
                 `max(1, what is already there)`.
                 It runs as **3c**, between the movement passes and the affliction
                 pass, which is the one correctly bracketed slot: every body has
                 finished moving so the positions are this tick's, and `pulsesOn`
                 needs `elapsed > 0` so a body that steps in cannot also take a
                 pulse for having done so. It draws **nothing from the Rng** and
                 raises no events -- what it does is lay an affliction, and the
                 pass below is what reports one -- and hostility is re-asked every
                 tick, which matters more here than anywhere: a field is *live*, so
                 a carrier who walked into a safe zone with one up would otherwise
                 go on burning whoever was standing there.
                 What lands goes through `landDot`, which came out of
                 `damage-over-time.ts` for this so that the three ways an
                 affliction can arrive -- applied whole, passed on by a spread,
                 laid by a field -- are one description instead of three. That
                 closed a divergence already in the tree: `spread` wrote its own
                 `applyStatus` and skipped Corrosion's `Sundered` rider, invisible
                 only because no row that spreads has one.
                 `data/status-visuals.ts` is which of those a player may see
                 (spec 186), and it exists because that map is deliberately
                 wider than anything anybody should be shown: some of what it
                 remembers is a condition -- Flow building, a target left
                 Exposed -- and some is bookkeeping, a 0.2s window Perfect Exit
                 reads or an inverted "your comeback has been spent". The rule
                 is one sentence: **the wire carries the conditions somebody
                 could point at, not the timers the sim keeps for itself**, and
                 absent is the default -- `visualFor` answers null for anything
                 with no row, so a status added to the sim is invisible until
                 somebody decides it should not be. Eight rows ride, four
                 `StatusId`s and every internal family (`dmg:`,
                 `exposed.bounty`, the restoration keys) do not. Two things in
                 it are load-bearing. `wire` is **append-only**, because it is
                 the number that crosses in place of the string and renumbering
                 a row silently re-labels every mark on a client that has not
                 been rebuilt. And `adapted` is the one entry that is not an id
                 the sim ever writes: adaptation is per ability, so the packer
                 folds every `adapt:<ability>` into it keeping the largest stack
                 -- a mark over a head cannot name the ability, and what is left
                 is still true. `magnitude` does not ride at all, on the same
                 argument that made poise a fraction: the picture says *that* a
                 body is Exposed, never by how much.
                 Three things inside a tick used to be sized by **what the
                 world contains** rather than by what is near anybody, and spec
                 206 is all three. With one player and 49 chunks active on every
                 row, a tick went from 102us to 7,492us as the world's spawn
                 point count went from 14 to 12,800 -- residency identical
                 throughout. It is flat now, and 32us at the far end.
                 The biggest one had nothing to do with residency and was
                 already expensive at today's size: **`segmentClear` walked
                 every collider in the world**, all 28,919 of them, at 84us a
                 call. Spec 192 built `ColliderIndex` precisely because
                 "`pushOutOfObstacles` and `circleBlocked` used to test every
                 circle in the world"; it indexed those two and left this one --
                 which is what `pathClear` is and what aggro's line of sight is,
                 so every routing monster paid for every tree on the map every
                 tick. Off the index it is 1.27us, and the query is the
                 segment's **bounding box** rather than a walk down the cells it
                 crosses: a long diagonal over-fetches, and a few dozen circles
                 against 28,919 is not worth a second query shape. Safe in the
                 deterministic core because the answer is "did anything hit",
                 which is order-independent -- exactly the property
                 `pushOutOfObstacles` does *not* have, and why `circlesNear`
                 promises ascending original order and `circlesInRect` does not.
                 `nearestQuarry` is handed the **players**, gathered once by
                 `playersOf` at the top of the tick, rather than walking the
                 whole entity map once per noticing monster. The gathered list
                 keeps the entity map's insertion order, because the tie rule is
                 a strict `<` and reordering it is a different answer on a tie.
                 And `runSpawners` visits only the spawn points in active
                 chunks, through an index memoized on the point list -- built
                 per tick it would be the walk it replaces. The resident points
                 are then **sorted back into authored order**, which is not an
                 optimisation: a spawn takes the next entity id, so visit order
                 decides which body gets which id, and ids are replicated;
                 sorting makes the result independent of the order
                 `activeChunks` happens to iterate in, which is a `Set`'s
                 insertion order and nobody's intended contract. Its population
                 cap is counted **once per tick** from the live entity map
                 rather than once per spawner. Not from
                 `ChunkManager.populationOf`, which the plan proposed and which
                 has no caller anywhere in the tree: that index is maintained by
                 `chunks.track`/`remove`, which run *after* `step()` returns, so
                 inside a tick it holds the previous tick's occupancy and would
                 still be counting a body the sweep a few passes above
                 `runSpawners` has already buried.
                 `sim/blow.ts` is one blow with all of it applied, in one
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
                 (20Hz deltas to a pose per frame -- since spec 253 played back
                 on a **clock this client runs**, because an arrival is not one:
                 the old ramp was zeroed by each delta landing on a socket
                 callback, so it carried the wire's jitter plus a frame of
                 quantisation and was restarted from a position it had not
                 finished walking to. Measured on an ordinary connection, one
                 frame in ten drew a walking body standing still and one in ten
                 drew it at nearly twice its speed, with the mean perfectly
                 correct throughout -- which is why nothing that measured a
                 position ever caught it. A body is drawn *at a time* now, over
                 the **tick span** of the two samples the head sits between, so
                 a stall that delivers three deltas at once plays back over the
                 time nine ticks are worth rather than the fifty milliseconds
                 three deserve. `PLAYBACK_DELAY_TICKS` is derived rather than
                 chosen -- one whole interval is what guarantees a bracketing
                 pair when a delta is a full interval late, and the extra half
                 is what centres the head so jitter has the same headroom early
                 and late -- and what it costs is stated rather than hidden:
                 remote bodies are 50ms further behind than they were, which is
                 presentation only, since spec 221 made reach the answer taken
                 server-side at the tick a wind-up begins. One clock for the
                 whole wire rather than one per body, so an arrow and what it is
                 flying at never disagree about when now is. Three rules were
                 each learned by writing the version without them: the head is
                 only ever set **forward**, since a head past its target is what
                 "the server has nothing to say" looks like and setting it back
                 replays the body's last movement for as long as the wire stays
                 quiet; its lead is bounded by the same number that forgives a
                 stall, or an unbounded lead is an unbounded recovery; and it
                 follows the wire **back down**, because `newestTick` left to
                 grow only parks the head in the future of a server that
                 restarted and every remote body goes back to the 20Hz stutter
                 for good, for the players who reconnected alone),
                 intent.ts, target.ts (the
                 right-click attack order, spec 072), cast.ts, appearance.ts,
                 projectile-shape.ts and trail.ts (an arrow's and a shuriken's
                 silhouettes, and the streak a thrown star leaves, spec 087)
                 dialogue.ts and dialogue-driver.ts (a conversation, spec 246).
                 The first is the controller the handoff spec recommends and the
                 fences here require: `src/ui/` may not import `render/audio/`,
                 so a bubble cannot be the thing scheduling sounds, and a sound
                 layer owning the reveal would be deciding what a screen shows.
                 So **one thing owns the text reveal and the vocal events it
                 triggers**, time is an argument, and the sink is injected --
                 which is what makes "skipping emits no backlog" and "closing
                 mid-word speaks nothing further" assertions rather than
                 something somebody has to listen for.
                 The two-stage confirm is the spec's: while typing, a press
                 reveals the rest of the line and the characters it skipped past
                 **do not speak**, because the cursor moves without going through
                 `update`; once the line is whole it ends the conversation if
                 there are no replies, and does nothing if there are -- advancing
                 past a question would be choosing on the player's behalf. A
                 reply's `go` is a line **id** rather than a nested line, which is
                 the whole reason asking who somebody is does not cost the chance
                 to shop and nothing has to remember that it was asked.
                 The driver is the four things a conversation is joined to, and
                 the rule it is built around is that **the server decides whether
                 one exists**: `ClientView.conversationEntityId` is the entire
                 trigger, so the player walking away, either body dying, the NPC
                 despawning and the socket dropping all arrive as it going back
                 to 0 and none of them needs a case. The client never opens a
                 bubble on the press, because the answer is what decides whether
                 the body stops walking and a bubble over something still ambling
                 away is worse than a moment's wait.
                 What the press does instead, since spec 257, is arm an order:
                 `driveTalk` in view.ts walks over and *then* asks, through the
                 same `approachOrderFor` the drop's walk goes through. Before it,
                 talking was the one reading of `world.order` that could not
                 close its own range -- the client sent a `Talk` from wherever
                 the player happened to be standing, `talkableFor` refused it
                 past `talkRadius`, and spec 246 made that refusal **silent** on
                 the stated grounds that every reason a conversation cannot start
                 is something the player can see. Which they all are, except this
                 one: from across the square the click did nothing at all, with
                 no walk, no bubble and no word about why. `scripts/probe-shop.ts`
                 had to order its own walk between attempts and said so in a
                 comment.
                 It re-aims at the body every tick rather than at the point
                 that was clicked, because a merchant wanders right up until the
                 claim lands -- and its ask is **bounded and closes in**: at most
                 `TALK_MAX_ASKS`, each from a standoff one power of
                 `TALK_STANDOFF_FRACTION` tighter than the last. Nothing tracks a
                 `Talk` in flight and there is no clock, because the exponent is
                 the throttle: the standoff after an ask is *inside* where the
                 body is standing, so the next one cannot be sent until it has
                 walked further in, and the last is sent from about a body's
                 width away -- where a refusal is one walking was never going to
                 fix.
                 That is the drop's **one order, one request** deliberately
                 loosened, and the browser is what loosened it. The first cut was
                 that rule exactly, every Node test passed, and
                 `probe-shop.ts` then measured what `approachLead` alone buys on
                 a 130-unit radius against a real server: an ask at a drawn gap
                 of 122 refused for range and one at 100 granted, same build,
                 consecutive runs. Under one-ask-per-order a refusal *is* a click
                 that did nothing, which is the failure the whole spec exists to
                 remove. The lesson generalises past this order: **`approachLead`
                 is the client's lead over the server, and it is the whole margin
                 only when the thing being approached does not move.** A drop
                 does not. A merchant does -- it is a remote body, drawn
                 `PLAYBACK_DELAY_TICKS` behind (spec 253) and wandering the whole
                 time -- so the margin here is a fraction of the reach, floored
                 by the lead rather than being it.
                 `SpeechSink` beside it is built to `affliction-vfx.ts`'s and
                 `shot-vfx.ts`'s rules because the failure modes are the same:
                 the **stop is owed** (nothing in the synth stops itself), and
                 the output is **re-asked every call** rather than cached --
                 there is no `AudioContext` until the first user gesture, and a
                 null cached at mount is an NPC silent for the session.
                 Since spec 260 the same bubble reads a **sign**, and the
                 interesting part is how little it costs. A sign is a prop, so
                 the sim has never heard of it: there is no `Talk`, no
                 `Conversation` and no claim, which is not a shortcut but what a
                 sign *is* -- spec 246 put a conversation on the server because
                 it is a claim on a body that would otherwise wander off
                 mid-sentence, and a board nailed to a post is not going
                 anywhere, holds nothing and sells nothing. Two players read the
                 same sign at once and neither is refused. `world/sign.ts` is the
                 whole of it and is pure: which post the cursor named, how close
                 the body has to get, and what the bubble is handed.
                 Three things were widened rather than duplicated, which is the
                 measure of whether this belonged here at all. `DialogueSession`
                 takes a **`DialogueSpeaker`** -- `NpcDefinition` minus the two
                 fields a conversation never reads -- so a sign is one line, no
                 replies, no vendor, and a synthetic NPC row would have been
                 three lies to buy a type. `rayBodyDistance` in `hover.ts` takes
                 a **`RayLike`** and a **`RayVolume`** rather than three's own
                 classes, so the cylinder test that answers "is the cursor on
                 that spider" answers "is the cursor on that board" in Node --
                 and the placeholder `Object3D` a sign would otherwise have had
                 to invent stopped existing. And `DialogueDriver` answers a
                 **`DialogueFocus`** rather than a body id, because there are two
                 kinds of speaker now and a mount searching `view.entities` would
                 find one and silently draw nothing for the other.
                 The pick is the marker tool's finding one tab over: **a sign's
                 board is not where a sign is filed**, so the volume is tested
                 first and the ground footprint second -- at this camera's pitch
                 the ground under a cursor aimed at a board is metres from the
                 post, and how many metres depends on the elevation the player
                 has the Height slider at. The pick volume is the *board* where
                 the collider is the *post*, which is the one place those two
                 numbers are deliberately different: a signpost the cursor could
                 only name by its stick is a signpost nobody clicks.
                 It is **two bands**, and both of the reasons are the same
                 sentence from opposite ends: the board is seven times wider
                 than the stick holding it up, so one cylinder sized for the
                 board would claim a column of empty air either side of every
                 post from the ground up -- and every unit of that is ground a
                 click can no longer walk to, which is the price `hover.ts`
                 records paying once and reversing. The ground footprint is the
                 **post's** radius for the same reason: the patch of earth a
                 sign occupies is the patch its post stands on, and claiming
                 what the board overhangs would take a stride of walkable ground
                 out of the game around every signpost on the map.
                 Every band is measured from a **sampled** ground height, and
                 that is the one thing this shipped wrong. The first cut took
                 the base as zero and wrote it down as a stated approximation;
                 the arena's ground is hundreds of units up, so the whole column
                 sat underneath the sign -- the board answered nothing at all,
                 and a ray that passed through the buried column on its way down
                 answered `sign` over open ground. Hovering the thing did
                 nothing and the field near it was live. `SignIndex` samples
                 `WorldScene.groundAt` when it rebuilds, which is the same
                 answer the bubble's anchor is projected through, so the volume
                 a cursor names and the point a bubble hangs over cannot
                 disagree about where a sign is standing -- and it rebuilds on
                 the store's revision, which is the tick a sign and the ground
                 under it both arrive on, because they are the same chunk.
                 What the probe was doing meanwhile is worth keeping: it swept
                 the frame until *something* read `sign`, found the patch of
                 ground, and reported a pass. It measures the mark against the
                 **bubble's own anchor** now -- 0 pixels below it when the
                 volume is right, 96 when the base is assumed to be zero.
                 **No sound**, and that is `SILENT_SPEECH` rather than a voice at
                 zero: a sink that can start a sound owes a way to stop one, and
                 the cheapest thing that cannot go wrong is one that never
                 starts. A voice row is still authored, because `planLine` reads
                 it to decide *when* each character appears -- which is the
                 reveal a player watches.
                 What ends one is the one thing the server would otherwise have
                 done, so the driver does it: a sign's bubble is **released by
                 range**, reconciled every frame against the reader's predicted
                 position rather than raised as an event, which is
                 `sweepConversations`' own shape and its reason -- every way a
                 reader can stop reading is the same check rather than a path
                 some later change can forget. The *same* radius that opened it,
                 spec 246's rule in as many words, and it cannot flicker because
                 nothing reopens a bubble on its own. The reader's position is a
                 **required** parameter of `update` even though a body
                 conversation never reads it: a sign has no server to release
                 it, so this is the only thing that does, and an argument a
                 caller can leave out is one a caller will.
                 `bubbleAnchor` is where the bubble points, and it is a named
                 function because the rule was wrong and the wrongness was
                 invisible -- a bubble that has quietly fallen back to its
                 no-anchor placement is still a bubble, sitting somewhere
                 plausible, saying the right words. **Whether the speaker is on
                 screen is asked at their feet; where the bubble goes is asked
                 at the lift.** The lift is in *world* units, so zooming in
                 magnifies it: at the span a conversation frames itself at, the
                 point a body's headroom above the ground is 400 pixels up in an
                 800-pixel frame, and judging *that* point on screen dropped the
                 anchor for a speaker standing in the middle of the view -- which
                 put their bubble at the bottom of the screen, because centred
                 and low is what a null anchor gets. Spec 246's rule is
                 unchanged and is what the feet are for; what a lifted anchor off
                 the top means is only that `placement` clamps it, which is what
                 that function has always done with one.
                 The camera is a `WorldScene.setDialogueFraming` push and
                 nothing more: the focus point becomes the midpoint of the two
                 bodies and the half-width is taken down, both through the ease
                 the camera has *always* used to follow a body -- so "smoothly
                 reframes" and "smoothly restores" are one mechanism rather than
                 two, and clearing it restores exactly. It may only ever pull the
                 camera **in**, never out, which is what keeps it from
                 overriding the Zoom slider rather than decorating it: somebody
                 playing zoomed right in would otherwise have the game jump away
                 from them the moment they said hello. Nothing is written into
                 `ViewControls`, so the player's own settings are untouched.
                 shot-vfx.ts (the paint a shot flies with, spec 218: `SHOT_ART`
                 says which effect each `ProjectileLook` carries, and the driver
                 beside it starts one when a projectile comes into view and stops
                 it when it leaves. Built to `affliction-vfx.ts`'s three rules
                 because the machinery is the same and so are the failure modes
                 -- it holds a **handle** rather than an id, since `play` returns
                 0 on refusal and a driver recording ids cannot tell "asked for,
                 did not start" from "started"; it asks `isLive` every frame,
                 since a full instance pool *evicts* rather than refusing and
                 bumps the slot's generation; and the **stop is owed**, made from
                 the despawn sweep that already knows a body has left, because
                 nothing in the particle system stops itself and a
                 `durationTicks: 0` effect hangs in the air forever holding one
                 of 128 slots. A shot lives a second and a half, so that last one
                 is a leak that would run at the rate of the shooting. Only the
                 ember carries paint: an arrow and a star ARE their mesh, and an
                 orb already reads as lit from within.
                 Three things fell out of wiring it. `scene.addEffect` now plays
                 an authored effect at **scale 1** -- the `max(0.25, radius / 40)`
                 it replaces could not have worked, because `scale` multiplies a
                 mark's size and *not* its speed, so an explosion played at a
                 quarter is quarter-sized marks thrown at full-sized velocities;
                 and a quarter is what every direct hit got, since the radius on
                 that message is the *shot's* collision radius against a nominal
                 40. Changing it was free because the branch had never run: the
                 server can send 46 effect ids and the registry held none of
                 them, so `ranged.ember.impact` is the first authored effect any
                 ability in this game has ever drawn -- and the painted
                 explosion, four presets and `brushExplosionRequest`, had had no
                 caller since spec 159. And `WEAPON_SWITCH` narrowed to the
                 starting kit: two tests had asserted since spec 126 that every
                 entry is level 1 and in the player's bag, and both held by
                 coincidence until a rare level-4 staff named an attack and
                 turned up as a fourth button that equips nothing. The staff's
                 own `damage` moved with it, from the `{1, 2}` spec 217 gave the
                 weakest row in the table -- authored when *"hitting somebody
                 with it is the fallback rather than the plan"* -- to a `{2, 5}`
                 between the bow and the keen sword, because since 217 that
                 range **is** what an Ember Shot hits for)
                 sky-source.ts (whose clock the sky follows, spec 264).
                 `carried-light.ts`'s shape one system along, and it holds that
                 module's rule for that module's reason -- **the panel wins where
                 it is asking for something, and the game decides where it is
                 not** -- because two things drive this sun now and one of them is
                 not in the tab at all. `view-controls.ts` states its settings and
                 this decides; a panel that answered a `SkyState` outright would
                 be the panel deciding for the game.
                 The `Day/night cycle` checkbox opens **ticked** since 263, which
                 reverses a decision rather than drifting from one: it opened
                 unticked because the cycle was a toy whose clock lived in that
                 panel, and the clock is the server's now. `Override the clock`
                 beside it takes it back and drives the sky from the `Time`
                 slider, which is spec 047's behaviour byte for byte -- and is
                 what keeps the panel useful for the thing it is for, looking at
                 an hour on purpose. Unticking the cycle still hands the sun to
                 the manual `Direction`/`Elevation` sliders, which is what it has
                 always meant and what spec 033 built them for. A panel with no
                 Sky section is not a panel asking for a cycle, so `lighting`
                 gates it: the sandboxes and the Studio preview keep the single
                 fixed light they have had since spec 045.
                 `?clock=15`, `?clock=night` pins the hour, in the register of
                 `?seed=` and `?field=`, and it is needed rather than convenient:
                 a sky that moves is a sky no harness can photograph twice, which
                 is why `probe-living-ground.ts` already stills the weather clock.
                 It resolves to a **cycle tick**, so a pin is a real `WorldClock`
                 with a phase and a darkness rather than a second path; an
                 unrecognised value **defers** (`device.ts`'s rule, so a
                 misspelling costs the flag and not the frame); and it pins **what
                 this client draws and nothing else**, since the honest line for a
                 shared cycle is that one player cannot make it night for
                 everybody. `data-world-clock` is published from the clock the
                 frame actually drew with rather than from the tick, which is the
                 only way to tell a working pin from one that parsed and reached
                 nothing.
                 carried-light.ts (what the player is holding, and what that
                 means for the two lights the scene already owns, spec 250).
                 Pure, and worth being a module because **two things now decide
                 one light**: the tuning panel spec 047 built, and the game. The
                 rule is one sentence -- *the panel wins where it is asking for
                 something, and the game decides where it is not* -- and both its
                 switches are off by default, so a player who has never opened it
                 has the whole say and one who has gets exactly what spec 047
                 tuned, down to the shadow switches. A **carried** torch casts no
                 shadow, and that is a decision rather than a default: a
                 shadow-casting point light is six cube faces of the whole scene
                 every frame, and this one moves every frame, so there is no
                 version of it that could be paid for once. Nothing in the world
                 casts either since spec 250's follow-up, but for a different
                 reason -- a fixture's could have been frozen and was, and it was
                 taken out for how it looked.
                 What separates the two carried lights is what the wire carries.
                 A torch is **equipment**, replicated for its owner only (spec
                 165's reason for drawing one body's weapon), so nobody else sees
                 it; a conjured light is a **status**, replicated to everybody,
                 so a remote body's orb takes a pool slot like a fixture -- and
                 the player's own stays the dedicated orb, because that is the
                 one the panel drives and the one spec 118 measures at arm's
                 length.
                 audio-wire.ts, footsteps.ts and audio-driver.ts (what the
                 Play tab hears, spec 229). The wire is `vfx-wire.ts`'s shape and
                 sits beside it for its reason: handed plain facts, answers what
                 to play, and no `if` in it changes a game outcome. The one thing
                 harder than the picture is that a blow's wire message carries
                 **no ability id and no damage type** -- which is why
                 `view.ts:1547` has hardcoded `damageType: 'physical'` since spec
                 121 and five of the six `DAMAGE_EFFECTS` rows have been
                 unreachable ever since. Audio solves it from the other end: the
                 element comes from `onEffect`, whose `effectId` is
                 `${ability.id}.impact` and is the only place an ability id
                 reaches the client at impact time. So a blow makes the sound of
                 a blow and an elemental ability makes its element's sound on its
                 own message, a fraction of a tick apart -- against widening the
                 combat frame by a byte for a presentation problem.
                 Since spec 229's follow-up a footstep also asks **what the
                 ground is made of**: one row per entry in `TERRAIN_MATERIALS`,
                 read through `MapChunkStore.materialAtWorld`, which answers the
                 **baked** material. `classify.ts`'s `worldMaterialAt` is the
                 trap and is deliberately not it -- that one re-derives from
                 height and slope with `region: 'default'`, so it reports a
                 hand-painted dirt path as grass and painted snow as rock, which
                 is right for scattering vegetation over a generated world and
                 wrong for asking what a body is standing on in a map somebody
                 edited. All six rows ship **unassigned**, and the fallback is
                 what makes that safe: `footstepEvents` returns an ordered
                 preference and the driver plays the first one the catalog has
                 files for, so every surface resolves to `player.footstep` today
                 and walking sounds exactly as it did. `null` from the store is
                 *"I do not know"* rather than "no surface" -- the ordinary state
                 for ground a streaming client has not been sent -- and falls to
                 the plain footstep, because a body walking into un-arrived
                 ground should sound like a body walking rather than like
                 nothing.
                 `footsteps.ts` is a distance accumulator rather than an
                 animation event, and the choice is forced twice over. The event
                 machinery is complete and has no consumer -- `driveUnit` returns
                 `readonly FiredEvent[]` and `scene.ts` calls it as a bare
                 statement -- but `walk` and `run` in the shipped clip library
                 carry `events: []`, and only the *player* is an authored unit at
                 all: every monster draws with a MechRig or a CritterRig and has
                 no machine, so an event-driven footstep would be a footstep for
                 one body in the game. Worse, locomotion clips do **not** scale
                 their rate with speed (`setActionRate` is one-shots only), so a
                 stride is a fixed 1.19s at the walk threshold and 1.30s at the
                 run one -- about 40 units of ground per footfall at one end and
                 100 at the other, and an event-driven step would slide against
                 the ground exactly as the pace changed. Distance cannot. The
                 stride is 48, taken from `rigs.ts`'s own `STRIDE_LEN` rather
                 than invented, and two refusals are load-bearing: a jump over
                 `MAX_FRAME_UNITS` is a correction snap and resets rather than
                 banking thirty strides, and a stunned or dead body banks nothing
                 because `resolveCrowding` is still shoving it around.
                 `audio-driver.ts` is pure -- it takes the `Audio` *interface* --
                 which is what lets the whole layer be driven in Node against a
                 recorder. It holds both kinds of sound `auras.ts` names in one
                 sentence: a **hit** needs an edge, and a stagger has no wire
                 event at all (`poiseBroken` never crosses), so it gets
                 `StaggerFlinches`' previous-read track for that file's stated
                 reason -- the window is many ticks long and firing on each of
                 them is a machine gun. A **state** needs a handle, and the three
                 rules spec 215 and 218 learned are not optional here either:
                 handles rather than ids (`hold` returns 0 on refusal, and a
                 driver recording ids cannot tell "asked for, did not start" from
                 "started"), `isLive` every frame (a full pool *evicts* rather
                 than refusing and bumps the slot's generation), and the stop is
                 **owed** -- made from the sweep that knows a body has left,
                 never inferred from an absence.
                 What the *interface* emits is the other half, and it needed one
                 small change to a socket that had been open since spec 133:
                 `Widget.sounds` is set on **one** node -- `UiRoot` sets it on
                 its content -- and every descendant finds it by walking `parent`,
                 which is the same "only the ancestor chain knows" rule a tab's
                 rows already live by. `Button.sounds` used to be a field
                 defaulting to `SILENT`, which is the same guard-free emission
                 with one difference that mattered: nothing ever assigned it. The
                 alternative -- hand the sink to every screen and have each pass
                 it to every button it builds -- is one chance per widget to
                 forget, across eleven screens with lazily-built tabs.
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
                 own attack. Spec 230 is the third answer and the one place
                 that rule bends, because there is nothing mechanical to read:
                 `skill.whirlwind` and `skill.rimeTouch` are both an `area`
                 circle on the caster's own feet, both `targeting: 'self'`, both
                 damage in a radius, and one is a blade going all the way round
                 while the other is cold coming off the ground. **Whether a body
                 focuses or swings is a fact about the picture**, so the row says
                 so in `castLook` -- an authored field in the register
                 `ProjectileLook` is already in, which keeps the half of the rule
                 that was load-bearing: a fact read off the content table rather
                 than a list of ids kept in sync with it.
                 `clipStretch` is the other half and is what a *shared* clip
                 costs. `attackRate` is `authoredWindup / span`, which is the
                 whole answer for a clip authored for one ability -- the swing
                 and the draw, whose own beat *is* that ability's wind-up -- and
                 says nothing at all for one every spell goes through. Multiplied
                 by `clipRelease / authoredWindup` it telescopes to
                 `clipRelease / span`, which is the sentence the spec is about:
                 the frame the hands come forward is the tick the sim resolves
                 the spell, whatever the ability is and whatever a status did to
                 its wind-up. Two terms rather than one because the first is
                 measured off the **wire** and the second off the **table**, and
                 only the wire can see a modifier. It is handed the *trigger*
                 rather than deriving one, because `triggerFor` may have fallen
                 back to the swing on a unit with no focus state -- and a body
                 drawing `slash` has to be driven at exactly the rate it is
                 driven at today. Since spec 166 the snapshot also carries how much
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
                 both corner rows" fails in Node rather than in a screenshot.
                 Since spec 227 that includes the **account button**, bottom-left
                 above the weapon switch: the same box, border and caption face
                 as the three window buttons in the opposite corner, drawn by one
                 `buildSystemStyleButton` so "the same style" is a fact about one
                 function rather than two copies. Its label is the state --
                 `REGISTER` for a guest, the account's own name once signed in --
                 which is the one thing that made it more than a fourth entry in
                 `SYSTEM_BUTTONS`, and `accountButtonCaption` is the arithmetic:
                 a name that fits is drawn whole, one that does not falls back to
                 its **first word** (the default name is the login, and a login
                 has no spaces, so this only fires on a name somebody typed one
                 into), and only a single over-long word is cut, with a full stop
                 so it reads as a shortening. `ADA LOVELA` was the version
                 without the middle rule. Clicking it goes through the same
                 `openHandler` the three window buttons use, so a button and a
                 key cannot come to mean different things, and it lights up while
                 its window is open off the same one list),
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
                 frames. Its wrapped clock has to be **seeded from the first
                 real stamp** rather than started at zero, or the load it is
                 waiting on never finishes: a page is a
                 second or two old before it draws a frame, so a timeline
                 starting at 0 hands the first callback a stamp *behind* any
                 baseline the page already took, and the world stops streaming
                 with chunks held at 0. What is scaled is the gap between
                 stamps, never the origin, so slowing the flinch down is
                 unaffected),
                 player-plate.ts (how big a player's overhead plate is and how
                 big the parts inside it are, spec 257. Pure; `hud.ts` owns the
                 elements, the division `health-bar.ts` beside it already has.
                 There are **two overhead shapes** now: a monster keeps spec
                 145's bar unchanged, and a player gets a level box, a health row
                 and a guard row, all inside one frame. `PLATE_WIDTH` and
                 `PLATE_HEIGHT` are **summed from the parts** rather than typed
                 beside them, because the holder is sized from the totals and the
                 rows are laid out from the parts, so two numbers that had to
                 agree are one number that cannot disagree.
                 **Neither row is subdivided**, and the marks that were there
                 first are worth recording. Health was marked every
                 `healthPerSegment(maxHealth)` points on a step that doubled
                 rather than capping, and guard in quarters; the argument was
                 that an unmarked bar can only be read as "about half". Against
                 this game's health totals it does not survive contact -- a fresh
                 character is around 40 health, so marks every ten of it are
                 three lines nobody would ever act on, and quarters on a row that
                 is *already* a fraction are a fraction cut into fractions. They
                 went **with their arithmetic** rather than being switched off,
                 which is the rule spec 250 set when it took the fixture shadows
                 out: a socket with nothing plugged into it is what this repo
                 keeps rediscovering a hundred specs later.
                 The **level box holds the number and nothing else**. It carried
                 a 1px ring in the health fill's colour, which said what the fill
                 beside it was already saying and spent two pixels of a fifteen-
                 pixel box on saying it -- and those two pixels are the
                 difference between a level a player can read over a body and one
                 they have to lean in for. `PLATE_LEVEL_PX` is what the box holds
                 without them: two digits (`MAX_PLAYER_LEVEL` is 60) at a
                 monospace advance of about 0.6em, which is also the face the name
                 above the plate is set in.
                 Two rules the plate reverses on purpose. The guard row is drawn
                 **whether or not it is dented**, because on a plate it is a row
                 of the frame and an empty-looking one says the body has no guard
                 rather than all of it -- spec 147's rule still stands for a
                 monster, and `probe-health-flash.ts` is told which shape it is
                 looking at rather than having the rule loosened for both. And the
                 local player's **own name** is drawn, which spec 145 withheld on
                 the grounds that you know who you are: right about a bar, wrong
                 about a nameplate, since one missing its name on exactly one body
                 in the world reads as a hole rather than as restraint. No new
                 colour anywhere -- self-green and other-red are the one
                 distinction the floating bar already made.
                 `npx tsx scripts/preview-unit-plate.ts` is the picture and the
                 measurement, at four times life size because a plate is 84x16
                 CSS pixels: every way this fails is a way a stylesheet fails --
                 a row negotiated down to nothing by a flex parent, a level box
                 the digits spill out of, a ring creeping back around them -- and
                 all of those are visible in a rectangle, which is why it reads
                 the boxes as well as taking the photograph),
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
                 crosshair.ts (what the pointer *is* over the world, spec 200:
                 four marks, authored as a 9x9 table of `#` in `pixel-font.ts`'s
                 register and rendered as crisp rects -- which is why the art is odd-sided, since what a
                 crosshair marks is its centre pixel and an even box has none.
                 The **small** one -- a centre dot and the four arm tips -- says
                 a click would act on the body under the pointer; the **full**
                 one says a skill is armed and the next click places it. The
                 **bubble** (spec 246) says the body under the pointer can be
                 talked to, and it is the one of the three that is a *picture
                 rather than a reticle*: the other two say where the click lands
                 and this says what it does, which is not something four arms
                 can encode. Its blank top and bottom row are not padding --
                 the mark is centred on the pointer like the other two, so what
                 has to sit on the box's middle is the bubble's body rather than
                 the whole drawing including its tail.
                 The **question mark** (spec 260) says the thing under the
                 pointer is a sign you can read, and it is the bubble's argument
                 one prop over -- deliberately *not* the bubble itself, since a
                 sign says one thing, says it to everybody and cannot be asked
                 anything back, so a mark promising a conversation would promise
                 the wrong thing about a board on a post. It is also the one of
                 the four that wins on **precedence** rather than on clarity: the
                 other three are answers about a *body* and this is an answer
                 about a *prop*, so unlike every pair above it the two really can
                 both be true -- a merchant standing in front of a signpost is an
                 ordinary thing for a village to contain. `issueOrder` ranks them
                 the same way, so what lights up is what the click does.
                 Everywhere else the page's own arrow stands, because a mark that
                 is always on says nothing by being on.
                 They are **drawn in the page** rather than handed to CSS as
                 cursor images, and that is the whole lesson of this spec. The
                 first two cuts were a `cursor: url(...) 11 11` data URI, and on
                 a real machine the mark landed four to seven pixels up and left
                 of the point it was marking -- about *half* the hotspot -- with
                 the pointer provably still. It took a phone recording of the
                 screen to see at all, because neither a headless screenshot nor
                 OBS captures what the compositor draws for a cursor; and the
                 first fix, assigning the style inside the input event rather
                 than in the frame, changed nothing. A hotspot is applied between
                 the style and the glass by a layer that also has a device scale
                 and a page zoom to apply, and CSS cannot ask what it did.
                 Drawn, the mark is placed from the pointer position the game
                 already tracks, in the coordinate space everything else on that
                 layer is placed in -- so there is no hotspot to be right about,
                 and a probe can finally *measure* where the mark went, which is
                 the check that matters and the one a cursor image made
                 impossible. It costs a frame against a composited cursor, so it
                 is placed from the pointer event as well as from the frame.
                 `worldCursor` says `none` exactly where `worldMark` draws
                 something, derived from it rather than deciding twice: a hidden
                 cursor with nothing drawn is a pointer the player cannot find.
                 The order is the order of commitment -- an armed skill beats a
                 body and beats the drop's pointer (spec 158), since its click
                 *places* the aim rather than doing anything to what is
                 underneath -- and what counts as a body is `attackable`'s
                 answer, the same predicate the right-click attack order reads,
                 so the mark and what the button does cannot disagree. Nothing is
                 drawn while the pointer is over the interface or off the canvas,
                 since `cursor` is already null there: a button keeps the arrow
                 that says it is a button, and no hidden cursor is left over a
                 window. `npx tsx scripts/probe-aim-cursor.ts` is the measurement
                 -- the mark's own rectangle against the point the pointer was
                 moved to, in every state -- and its first run caught two things
                 at once: an unsized holder, whose absolutely-positioned children
                 are out of flow and so reported a zero rectangle eleven pixels
                 up and left of the truth, and the deliberate rule above about
                 the interface),
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
                 Since spec 188 the four slots are no longer empty by
                 construction: `actionBarFor(equipment)` reads them off the
                 player's four `skill1..skill4` equipment slots, so the bar is a
                 *view of the equipment* and there is no second list to keep in
                 step -- which is exactly what makes the four cells under the
                 bag and the four along the bottom of the screen the same four.
                 It is pushed into the HUD every frame rather than remembered,
                 for the reason the window buttons are pushed: the equipment is
                 the state, and a bar that kept its own copy would be a second
                 opinion about what the player is carrying. `?slots=` still
                 exists and **overrides** the equipped skills rather than being
                 the only way to fill a slot -- a harness that wants
                 `ground.quake` on the bar should not have to loot a sigil for
                 it first. (That row is gone since spec 237; the switch is not,
                 and it is the only way to put a skill on the bar without one --
                 though the *server* still refuses a `skill: true` ability that
                 is not in a slot, so `?slots=` now fills the bar rather than
                 the hands.)
                 Since spec 196 none of that is DOM: the row is
                 `src/ui/screens/action-bar.ts` on the interface canvas, the
                 plan is pushed into the mount rather than into `hud.ts`, and a
                 slot draws an **icon** rather than a name -- every other slot in
                 the game is a square with a sprite in it, and no name in the
                 table fits at any size that face has there. `barNameOf` and its
                 authored `shortName` survive as `AbilityView.name`, the
                 ability's name-where-space-is-tight handed to the widget for
                 whatever names a slot next, and `action-bar-model.test.ts` keeps
                 them honest now that `hud-layout.test.ts` has no slot to measure
                 a name against.
                 xp-bar.ts measures against the server's own
                 `experienceForLevel` rather than a copy of the curve, because
                 the strip and the character sheet disagreeing about how far
                 along somebody is is the kind of bug nobody reports -- they
                 just stop trusting the bar. Since spec 184 it is purple rather
                 than gold, and the recolour is the smaller half of that spec:
                 experience now has *two* places it is shown -- the strip and a
                 number that floats off a kill -- and one colour to learn is
                 what makes them read as the same fact. Gold had to go because
                 the number is over a body, where gold is already a cast that
                 can still be called off and a floating gold number is a
                 critical hit; a strip at the frame's own edge could get away
                 with sharing a hue and a number cannot.
                 xp-gain.ts is the other half (spec 184), and it exists because
                 **the server never says "you earned 12"**: experience arrives
                 as a whole `Stats` message with a level and a count in it,
                 replacing whatever was there, so a gain is a difference -- and
                 the difference is not the subtraction it looks like, since a
                 level-up moves the count backwards. A kill taking somebody from
                 5 short of level 2 to 3 into it earned 8, and the raw counts
                 differ by minus the whole level; `cumulativeExperience` is the
                 monotonic number two readings can honestly subtract. Two rules
                 beside it, each the fix for the version without it. The
                 **first reading only establishes the baseline**, because the
                 first `Stats` carries a whole character and a client that
                 reported a gain on connect would throw a session's worth of
                 experience across the screen of somebody who has just logged
                 in. And a **backwards move reports nothing and re-baselines**
                 -- an admin reset is not a negative reward, and leaving the old
                 baseline would swallow every real gain until it had all been
                 earned back. Where the number *goes* is a join view.ts makes
                 rather than a fact on the wire: nothing links a `Stats` to the
                 kill that caused it, so a kill by the local player remembers
                 the anchor its damage number was already given and the frame
                 that sees the total move spends it there; a grant with no kill
                 behind it falls back to the player's own body, which is the
                 only other place a number about the player could honestly go.
                 The *path* is the third piece and lives in damage-popup.ts as a
                 second trail, sharing spec 096's one field, one capacity, one
                 projection and one expiry. It needs to be distinguishable
                 because the pair is spawned on the same tick, on the same body,
                 from the same anchor. The first cut swept the reward out to the
                 side on an ease-out, which separated it perfectly and looked
                 wrong: **nothing in this game leaves a body at 45 degrees**,
                 and reading the pair meant following two marks going different
                 ways. So a reward is stacked **under** the blow, in the blow's
                 own lane, rising at the blow's own rate -- one column, nothing
                 to follow -- and earns its own moment by *outliving* the number
                 above it, by `XP_EXTRA_LIFE` (half a second at 60fps). What
                 makes that a column rather than two things that happen to line
                 up is that `XP_RISE` is **derived and not authored**:
                 `NUMBER_RISE * XP_LIFE / NUMBER_LIFE`, so the two share a rate
                 and only the time differs -- a rate of its own has them
                 converge or separate, which is the diagonal's problem in
                 another direction. It reads the lane counter without consuming
                 one, so a kill's reward cannot shift where the next blow on
                 that body draws its number, and successive rewards on one group
                 step down through `XP_STACK` gaps rather than piling up. The
                 text is `+N XP` and stays labelled: the colour and the column
                 say "this is not damage" and neither of them says what it *is*,
                 and a purple number under a white one is a second quantity
                 whose identity is the whole point. The label costs three times
                 the width of the count alone, which was measured rather than
                 assumed and is why this is the smallest text of the pair, at
                 half a critical's scale.
                 `npx tsx scripts/probe-xp-popup.ts` is the half no headless
                 test can see, over spec 164's `hud-probe.html` rig: it lands a
                 real blow and earns a real reward at one point and measures the
                 pair off the DOM, reading the purple out of the SVG rather than
                 out of the constant -- a number that reached the page in the
                 damage palette fails there.
                 pool-bars.ts holds one judgement:
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
                 Since spec 229 that arithmetic is `ClientView.selfDead` and
                 death.ts is the mapping onto it, for the reason `selfStaggered`
                 is published rather than recomputed: **the legs need the same
                 answer**, and an overlay saying you are dead while the body
                 walks off is exactly the disagreement that module was written
                 against, one level up.
                 Which it was doing. `moveIntent` had no death rule at all, so a
                 player who died holding a move order watched their own body get
                 up and walk to it -- measured over a loopback, **155 units in
                 one second**, a full second at `MOVE_SPEED`, while every other
                 client watched the corpse lie where it fell. The server was
                 never wrong: `stepWorld`'s movement pass steps past a body at
                 zero health *before* it reads an intent. That is also the whole
                 of why it persisted, and the thing worth remembering here -- a
                 `Correction` is the only thing that pulls a mispredicted
                 position back, and the server emits one out of the movement
                 pass, so **the one case that never enters that pass is the one
                 case nothing corrects.** Every other mispredict in this client
                 is bounded by a round trip; this one was bounded by how far the
                 order was, and stood until the respawn teleport.
                 Three rules close it, and the first is the load-bearing one.
                 **The rule is at the legs**, `moveIntent`'s `dead`, ranked above
                 `staggered` and so above a held key and every aim: there are
                 six doors into a destination -- a key, a move order, a chase,
                 an aim's approach, a pickup walk, a walk over to somebody to
                 talk to -- and being dead is a fact about the body rather than
                 about any of them, so one branch holds whichever door somebody
                 finds next. (`autoAttack` and `approachOrderFor` keep the death
                 rules they have had since specs 080 and 158, because they also
                 decide whether to *ask the server for something*, which a rule
                 at the legs cannot cover.)
                 **`sendInput` zeroes the components too**, exactly as it already
                 does for a stagger, so the cover is every *caller* rather than
                 every call site -- the bot harness and the tests build an input
                 themselves and never reach `moveIntent`. The input is still
                 sent: spec 080's rule that a request gets an answer is what the
                 cast pass needs in order to refuse a corpse's swing.
                 And **the orders are dropped at the death**, or the bug simply
                 arrives through the other door -- the order outlives the body,
                 so a player put back on the spawn pad sets off for where they
                 died without asking. `stopEverything` (spec 199) was split
                 rather than copied, and the difference between its two callers
                 is one stated thing: a stop is a **press**, so it disarms the
                 keys physically down through it, and a death is not, so a player
                 still holding a direction when they get back up is expressing it
                 at that moment rather than having expressed it before they died.
                 `issueOrder` refuses while dead for the same reason in the other
                 direction, which is what lets the drop be an *edge* rather than
                 a level: with nothing able to arm an order while the body is
                 down, the set the death emptied stays empty, and a level would
                 mean `cancelCast` on every tick of every death.
                 `server/client/death-prediction.test.ts` is the measurement,
                 over a real loopback, and it reads the **wire** as well as the
                 prediction -- "stopped predicting" and "stopped claiming" are
                 two facts and only the second is what the server is protected
                 by. Its last case is a control, because every other assertion in
                 it is an absence and a client that had simply stopped sending
                 anything would pass all of them.
                 `npx tsx scripts/probe-bottom-hud.ts` is the half no headless
                 test can see: the real `createHud` over a fabricated view in a
                 real browser, reading the boxes back off the DOM. It exists
                 because none of the three questions can be reached in a real
                 session without a fight -- the strip only moves when something
                 dies, the overlay only appears when you lose, and the button
                 only after that.
                 selection.ts and action-bar-model.ts are the two view-models
                 spec 196 added, out here for the reason every other one is:
                 `src/ui/` may not reach the sim, so the replicated facts and the
                 content tables become plain rows on this side of the fence --
                 including *what a line is worth saying*, which is the division
                 the item tooltip already keeps. selection.ts is what the mini
                 HUD is handed, and the whole reason it is a module rather than
                 four lines in `view.ts` is that its statuses come from
                 **`statusMarks`** -- the same function the marks over the head
                 are built from, so the corner panel and the body are two views
                 of one list rather than two answers about whether something has
                 expired. `StatusMark` gained `ticksLeft` for it: a count rather
                 than seconds, for the reason `FADE_TICKS` is one.
                 What selects a body is the **left button**, and it is one
                 action with two readings in exactly the shape `world.order`
                 already has: with an aim pending it commits to it, with none it
                 names what is under the cursor, and a click on nothing clears
                 it. Two bindings a player could put on two different buttons is
                 not a preference. The id does not move -- `world.confirmAim` is
                 what a stored profile references and spec 189 is explicit that a
                 rename is a binding silently discarded -- only the label, which
                 is `Select / aim` rather than `Select / confirm aim` because the
                 longer one measures 139px against a 114px column and
                 `keybindings.test.ts` catches it: the face is drawn rather than
                 typeset, so a clipped label fails in silence. Nothing about a
                 selection is replicated and the server is never told; it is a
                 camera decision rather than a game one, and deliberately not an
                 attack order either, since a readout that also started a fight
                 would make looking at a body dangerous.
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
                 approach.ts (go and stand next to a thing, then ask for it,
                 specs 158/236/256. Three of the four readings of `world.order`
                 are the same sentence with a different verb on the end -- walk
                 until the server would agree we are close enough, then send one
                 request -- and this is that sentence, lifted out of the drop it
                 was written for once a conversation wanted it whole. It was
                 already not only about a drop: `driveCastOrder` takes
                 `approachLead` for spec 236's margin and says in a comment that
                 it is taking the pickup's answer rather than inventing a second
                 one.
                 What is deliberately **not** in it is the reach, because that is
                 three different comparisons in three different files on the
                 server -- `PICKUP_RANGE` plus a body radius, an ability's range,
                 an NPC's `talkRadius` measured centre to centre and added to by
                 nothing -- so each caller states the server's own number and
                 this decides what to do about it.
                 `approachLead` is the margin, and the half worth knowing is what
                 it does **not** describe: it is this client's own lead over the
                 server, so a target that walks -- a wandering merchant -- adds a
                 drift of its own, bounded by that body's pace over spec 253's
                 playback delay. A couple of units against a margin measured in
                 tens, and what it costs when it does bite is one refused
                 request; correcting for it would mean replicating a monster's
                 move speed to say something the broadcast-interval floor already
                 covers),
                 press-queue.ts (a press that waits for the swing, spec 262. Of
                 the four things that can ask for a cast, three hold while the
                 body is committed -- `autoAttack` and `castOrder` both take
                 `rooted`, `staggered` and `pending`, and a confirmed aim is held
                 as an `AimOrder` until the swing ends -- and the fourth, a
                 hotbar press, was gated on the cooldown and nothing else. A
                 `'none'` gesture is `targeting: 'self'`, so the press *is* the
                 commitment and went straight out mid-swing: measured through
                 the shipped loop, **thirteen presses and thirteen
                 `alreadyCasting`**, a third of them made during a
                 *follow-through*, where the blow has already landed and the
                 refusal is a lie. It did not self-limit either, because a
                 refusal stamps no cooldown, so the local gate never closed. The
                 five self-casts are the flask everybody carries plus Whirlwind,
                 Rime Touch, Scorched Earth and Conjure Light -- which is to say
                 the things a player mashes in a fight.
                 **There is no expiry, and that is derived rather than skipped**:
                 each of the three gates is already bounded by machinery that
                 exists -- `rooted` by the cast's own `endTick`, `staggered` by
                 the replicated `activityUntilTick`, `pending` by
                 `PREDICTED_CAST_TIMEOUT_TICKS` -- so a fourth bound would be a
                 number to keep in step with all of them, and it would be the one
                 deciding how long a press lives. What ends one early is what
                 already ends every other order: the stop key, Escape, death, and
                 the next press. Starvation is prevented by the **order the frame
                 loop drains them in** rather than by a timeout, which needed one
                 more thing to be true: the drivers all read one `view` taken at
                 the top of the frame, so a request sent by the first is not in
                 the `awaitingCast` the rest read, and two requests on one frame
                 is the server taking the first and refusing the second.
                 Two rules were put there by the measurement rather than by
                 reasoning, and both replaced one refusal with another until they
                 were. **Ready is re-asked at the send** -- with the queue in and
                 nothing else, `alreadyCasting` disappeared and `onCooldown` took
                 its place, because a *second* press made during the first one's
                 wind-up is still ready by `startAim`'s reading and waited that
                 whole cast out to be refused at the end of it; dropped instead
                 and silently, which is `castOrder`'s own rule (*"in reach, and
                 not ready: the order is dropped rather than parked"*), since
                 **what a press waits for is the body, never the timer**. And the
                 **swing hold moved to the send**: spec 258's edge is consumed on
                 the frame it is raised and carried forward only while
                 `casting && !committed`, which is the *previous* swing, so
                 raised at the press it is gone before the cast it belongs to has
                 started and a player walking on WASD is back to 258's own
                 measurement of every press refused as `withdrawn`. It carries
                 the set it was made with rather than re-reading it, which is the
                 difference between two right answers and one -- a direction held
                 **at the press** is one the press means to stop, and one pressed
                 **after** it is a withdrawal (spec 079), which is exactly what
                 the player is asking for by pressing it. Only the *explicit*
                 press raises it; `driveCastOrder` and `driveAutoAttack` still do
                 not, which is 258's rule unchanged),
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
                 through a real arc into .claude/screenshots/shots.png. That one
                 photographs the *mesh* and since spec 218 the ember's column on
                 it is deliberately incomplete, because an ember is the one shot
                 whose mesh is half its collision radius and whose silhouette is
                 the paint: the whole picture is `preview-brush-vfx.ts`'s third
                 sheet, `brush-shot.png`, which needed the judging rig to learn
                 to *move* -- a trail is laid down between ticks, so `step`
                 carries the flight one tick at a time, and a rest-against-speed
                 row is the one comparison that fails while every other tile
                 looks right.
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
src/render/iso3d/props.ts's instance half  where every prop stands, composed on
                 the worker (spec 181). A region rebuild was 32.7ms and one
                 dropped frame every time; the frame pays 1.0ms of it now, and
                 that took two changes because neither was enough alone -- the
                 worker leaves 16.5ms and the sharing leaves 20ms, against a
                 16.7ms frame. `buildRegion` called `treeParts`, `bushParts` and
                 `fenceParts` **per region**, each building `BufferGeometry`
                 from scratch and welding it again: memoized, 32.7ms to 18.5ms.
                 `buildRegionInstances` then takes the matrix and colour
                 arithmetic off the thread: 18.5ms to 1.0ms.
                 The geometry *object* still cannot be shared, and the reason is
                 the feature that made the per-region rebuild look necessary:
                 `applySway` writes `aWindBase` and `aWindTune` -- one entry per
                 tree -- onto `mesh.geometry`, so ninety regions sharing one
                 geometry is ninety regions swaying around whichever was built
                 last. Each batch gets a **shell** instead: its own geometry over
                 the same `BufferAttribute` objects, which costs an object and
                 four assignments and does no vertex work. And a shell is
                 **stripped before it is disposed**, because three's
                 `onGeometryDispose` removes the GPU buffer of every attribute a
                 geometry holds -- disposing one as-is frees the shared ones and
                 makes every other region re-upload, a hitch caused by the very
                 rebuild this makes cheap. Both hazards were checked by putting
                 the bug back: exactly the two tests written for them failed and
                 the other nine passed, including equality against the path that
                 shipped -- which is the shape to expect, because sharing a
                 geometry does not move a single tree, it moves what the wind
                 does to them. `PROP_GROUPS` is the batch enumeration named once
                 so `(group, part)` means the same thing on both sides of the
                 boundary, and `adoptRegion` is the seam: `rebuildWithin` is that
                 with `buildRegionInstances` in front of it, so a field built
                 here and one built on the worker are the same field by
                 construction rather than by two implementations agreeing.
src/render/iso3d/terrain-arrays.ts, world/map-worker*.ts  the load, running
                 beside the frame rather than in it (spec 180). The measurement
                 the whole thing turns on: `terrainMesh.rebuild` is 2050ms across
                 a cold start of which **15ms is three.js** -- found by patching
                 `setAttribute` and `computeVertexNormals` and timing only those.
                 Everything else was a buffer of numbers being filled in, on the
                 one thread that also has to draw. So terrain-arrays.ts is that
                 mesher with no rendering library in it, and the worker owns a
                 `StreamedMap` of its own and answers in typed arrays; the
                 renderer keeps a store too, because `scene.ground(x, z)` is
                 asked mid-frame by every body, decal and effect and there is no
                 synchronous call across a thread. That is affordable only
                 because of the split spec 165 made for another reason --
                 `insertChunk` is 0.1ms and `buildChunk` is 3.4ms -- so the two
                 sides are not paying one bill twice. A chunk arriving while
                 walking cost the frame 23.6ms and costs 1.6ms.
                 Three rules, each of which was got wrong first. **Transfer only
                 what you allocated for this reply**: `footprint.materials` is a
                 reference to the store's own array and a nav grid's `heights`
                 is the per-cell height cache, so transferring either hands the
                 worker its own caches away -- which `postMessage` refused, on
                 the *second* grid. **Nothing three.js-shaped may be
                 reimplemented**: the walls' flat normals stay
                 `computeVertexNormals` on the geometry rather than being
                 replicated, and the colour transfer is three's `SRGBToLinear`
                 in three's own premultiplied form with a test against
                 `THREE.Color` rather than against the formula -- the extraction
                 is exact, 9.97M floats across 288 meshes identical element for
                 element. And **navigation moves on the remote path only**: a
                 loopback tab runs the sim, `routeToward` calls `navGridFor`
                 inside the tick, and a grid arriving when a worker happens to
                 finish is wall-clock input to a deterministic simulation.
                 map-worker-client.ts carries an in-process twin behind the same
                 interface, which is not a courtesy -- `npm test` runs in Node
                 where `Worker` does not exist, and a pipeline reachable only
                 from a browser is the state spec 165 spent four follow-ups
                 regretting. `?perf=noworker` is the same switch for a person.
                 `npx tsx scripts/bench-stream.ts` splits its rows by thread;
                 `npx tsx scripts/bench-walk.ts` counts what a *walk* costs, and
                 it had to be told two things before it would stop reporting
                 zero: a raw held direction walks into the first of 6942 trees
                 after 413 units, so it drives the renderer's own `moveIntent`
                 and `RoutePlanner`; and a walker that sets off during the load
                 drags the request window across the map before the gate opens,
                 which is a scenario no player can produce. On this map the
                 arena is 210 chunks against a 169-chunk request window, so the
                 gate opens holding four fifths of the world and only 26 more
                 chunks ever arrive -- which is why the prop-region completeness
                 rule measured 1.29x rather than the 2-4x it was reasoned to be.
                 `npx tsx scripts/probe-streaming.ts` (and `PERF=noworker`) is
                 the browser half, and it found the two bugs no headless test
                 could -- a worker never sent the map, so 169 chunks held and 0
                 drawn with every unit test green.
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
src/render/iso3d/vfx/brush.ts's brushFire  a fire that stands somewhere and keeps
                 burning (spec 250), and the first painted effect in this file
                 authored to be *watched* rather than glanced at.
                 Every other fire here is an event -- a shot crossing the frame,
                 a blast, a body that caught. This one is what a campfire prop is
                 made of, now that the prop is stones and charred timber and
                 nothing that moves, and two things follow. **It has to loop
                 invisibly**, so its three layers run at unrelated rates over
                 unrelated lifetimes and nothing in it is phased off anything
                 else. And **it has to cost nothing at distance**: what says
                 "there is a fire there" from across the arena is the fixture's
                 light, so this is `priority: 1` -- the first thing to yield
                 under instance pressure -- and culls well inside the light's own
                 reach.
                 Flames rise on an updraft and die young; **embers are the one
                 layer with gravity on them**, thrown up and falling back,
                 because an arc is the shape an eye reads as heat coming off
                 something and everything else here rises steadily; smoke is born
                 *above* the flame, drifts, spreads and goes dark.
                 Three of its numbers were paid for by
                 `preview-brush-vfx.ts`'s fire rows rather than chosen. The first
                 cut's flames rose about eighteen units and its marks were
                 fifteen long, so the "column" was one mark tall and read as a
                 puddle of fire; there was as much smoke as flame, which is
                 `brushShot`'s own finding one effect along, because against a
                 mid-green field a grey mark is a hole and an orange one is a
                 highlight; and the embers were **additive**, which is right for
                 a lick inside a fireball and wrong over open grass, where it is
                 not a warm spark but a yellow-green speck. The alpha version
                 both reads better and reuses a batch the table already has, so
                 the registry's draw-call ceiling never moved.
                 `world/fire-vfx.ts` is what plays it, built to
                 `affliction-vfx.ts`'s three handle rules for that file's stated
                 reasons -- `play` returns 0 on refusal, a full pool evicts
                 rather than refusing, and nothing stops itself. What is new is
                 the fourth thing, and it is why the driver exists: **a fire
                 stops because the ground it stands on stopped being drawn**, and
                 there is no event for that, so the whole list of fixtures on
                 held ground is reconciled every frame and an absence is the
                 signal. `FIXTURE_ART` says which kinds burn, in the register
                 `shot-vfx.ts`'s `SHOT_ART` is in: which effect a fixture carries
                 is art direction, so it lives beside the art rather than in the
                 map format.
src/render/iso3d/light-residency.ts, world-lights.ts  the lights standing in the
                 world (spec 250). The pair `player-lights.ts` and
                 `player-lighting.ts` already
                 are: a decision that is arithmetic, and the three.js that acts
                 on it. Spec 047 built a torch and a magic orb, spec 118 built
                 the shader patch that lights a body from a carried flame as
                 though it were farther away, and for a hundred and thirty specs
                 the only caller of any of it was a **checkbox in the tuning
                 panel**. Nothing in the world emitted light at all.
                 What makes a village affordable is one sentence: **nothing here
                 casts a shadow, and the number of lights never changes.**
                 three collects lights in `projectObject`, which returns
                 early on `object.visible === false`, and the count is part of
                 the program key -- so "add a `PointLight` per fixture in range"
                 is a *hitch* every time somebody walks past a campfire rather
                 than a slowdown. `castShadow` is in that same key. So the pool
                 is fixed: allocated at construction, never grown, never hidden,
                 `castShadow = false` written once and never touched, an idle
                 slot sitting at intensity 0 with a small reach. That is the
                 whole cost -- a lit square adds no draw calls at all, which is
                 what `probe-world-lights.ts` measures by sampling the frame's
                 count across it.
                 It **did** cast, briefly, and the round trip is worth knowing
                 because the argument that lost was right about the cost. A
                 fixture's cube map was rendered on the frame the light took a
                 slot and never again (`shadow.autoUpdate` off, `needsUpdate`
                 set once), which is a `samplerCube` and one lookup per lit
                 fragment and nothing per frame -- measured flat with four of
                 them lit. It is gone for how it *looked*: a point light a body's
                 height off the ground throws every trunk, post and body near it
                 outward in a hard radial fan, and four fixtures round a square
                 throw four of those across each other. What went with it -- the
                 casting prefix, the cube setup, the one-bake-a-frame queue, the
                 `revision` stamp that re-took a map when its ground streamed in
                 late, and the mask that kept moving bodies out of a frozen one
                 -- was **deleted rather than left switched off**, because a
                 socket with nothing plugged into it is what this repo keeps
                 rediscovering a hundred specs later. Putting it back is one
                 revert.
                 `light-residency.ts` is which fixtures get slots, and
                 **hysteresis is the whole of it**: a slot that flipped between
                 two fixtures at equal distance would pop a light on and off
                 every frame, the most visible thing in the system driven by the
                 cheapest possible indecision. A request is claimed inside
                 `activateRadius` and kept until past `releaseRadius`, and a slot
                 is only taken from a light already in it by a candidate nearer
                 by more than the margin. Spec 208's shape for map chunks and its
                 reason: **the thing that lets go must not fight the thing that
                 takes hold.**
                 A fixture is no longer the only thing that asks. Since spec 262
                 a **firing Warden** hangs three red lights along its beam and
                 offers them here like anything else, which is what makes that
                 weapon light the ground instead of painting a decal on it. The
                 decision is entirely about the program key: the count of lights
                 in a scene is part of it, so a beam with a pool of its own would
                 recompile every material in the scene at the moment the frame is
                 busiest. What it costs is that a beam is ranked on distance like
                 a lamp post and can lose -- firing into a lit village square can
                 leave it unlit -- and that is one-directional in the right
                 direction: a beam may go dark, and it can never cost a frame.
                 What the *player* carries is `world/carried-light.ts`, and it
                 exists because two things now decide one light. The rule is one
                 sentence -- **the panel wins where it is asking for something,
                 and the game decides where it is not** -- so every switch spec
                 047 tuned still does exactly what it did, and a player who has
                 never opened the panel gets a torch by carrying one. Nothing
                 the player carries casts either, which was true before the
                 fixtures stopped casting and for a reason of its own: a carried
                 light moves every frame, so there was never a version of it that
                 could have been baked.
                 The thing that could not be found in Node, and was not: three
                 **unrolls** the point-light loop, so `player-lighting.ts`'s two
                 injected declarations are emitted once per light *at the same
                 scope*. With one point light -- which is all this game had until
                 the pool -- that is one copy and it compiles; with two it is
                 `'turboToLight' : redefinition`, the player's material never
                 builds, and three logs a failed compile and carries on. Green
                 suite, unlit player. The injection is one block now, and
                 `player-lights.test.ts` pins both halves: that the loop is still
                 unrolled, and that what is substituted into it is braced.
                 `npx tsx scripts/probe-world-lights.ts` is the half that found
                 it, and `npx tsx scripts/preview-fixtures.ts` is the instrument
                 for the numbers -- which **measures rather than draws**, because
                 the number that decides whether a lamp reads is one a thumbnail
                 cannot show: the ground is not facing the light, so what a
                 designer sets is scaled by the grazing angle
                 `height / hypot(height, d)`, and a flame a body's height up
                 delivers a tenth of its own brightness at two hundred units
                 where one carried twice as high delivers half. That is why a
                 campfire's light sits mid-flame rather than in its embers.
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
src/render/iso3d/vfx-controls.ts  the seventh of those buttons (spec 121), and
                 the rule that came out of it is that **a setting is only as wide
                 as the thing it reaches** (spec 182). Its gore level was pushed
                 into `DecalField`, which owns the *stains*, and the stains are
                 the smaller half of what the row names -- the spatter is chosen
                 by `effectsForBlow`, which had never been told the setting
                 existed, so `Blood: Off` left every red brush mark coming off
                 every body and only swept up after them. `Less` was worse: no
                 code anywhere read level 1, so the middle button was a label.
                 Both halves were individually correct and individually tested,
                 which is exactly why a green suite sat beside a setting that did
                 not work, and the fix is that the level reaches *both* -- what a
                 blow throws (`vfx-wire.ts`) and what stays on the ground
                 (`decals.ts`, a fraction of the authored caps rather than a
                 second table). What `Off` does **not** do is draw nothing: a
                 body that would have bled falls through to the impact a
                 construct already draws, because a blow with no picture is a
                 fight that is harder to read than one with a quieter picture.
                 Effect detail was fine throughout and is unchanged; what it
                 lacked was any way to see that without playing the game. `npx
                 tsx scripts/probe-vfx-settings.ts` is that, and the thing worth
                 knowing about it is that **every check in it is an absence** --
                 no blood at Off, no pool at Less -- so a window in which nothing
                 was hit passes all of them. It measured exactly that first: one
                 window killed what it was fighting and the five after it watched
                 an empty field and reported green. So a window runs until it has
                 seen an impact effect and a window that never does is a failure,
                 and the evidence is the `hit_*` flash, which is what a bleeding
                 body falls back to at `Off` -- it survives the very setting being
                 measured.
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
src/render/iso3d/living-ground.ts, terrain-living.ts  what the grass surface is
                 made of (spec 252), and what the wind does to the *pattern*
                 rather than to the plane. A fourth patch on the terrain surface
                 material, in the register of the three already on it, and albedo
                 only -- nothing is displaced, nothing is instanced, the ground is
                 exactly the triangles the mesher emitted.
                 Four scales at once, which is the whole idea: macro colour
                 patches tens of metres across, brush strokes about a metre,
                 gust fronts and thin curved trails on the shared wind, and
                 sparse specks. Before it the ground's entire variation was spec
                 043's two authored greens at cell scale, so a meadow read as a
                 painted plane -- and everything the fix needed had been in that
                 fragment shader since spec 106 with nothing reading it together.
                 Applied **last and to the surface only**, and both halves matter.
                 A cut bank is earth, so the walls keep `TERRAIN_CLIFF_COLORS`.
                 And each of these patches splices in front of the ones applied
                 before it, so the last one applied is the first to run: this one
                 reads the raw vertex colour, and the rock blend, the detail, the
                 creases and the streak ride on top of what it produced. It
                 declares no varyings and has no vertex half at all, borrowing
                 `vWindWorld` and `vDetailNormal` from the two patches above.
                 **Which pixels it reaches needs no new data.** There is no
                 material id in the ground's vertex format, and adding one means
                 an attribute, a mesher change and a change to what the map worker
                 transfers -- but grass is the only material in `TERRAIN_COLORS`
                 whose green channel dominates both of the others, by a gap five
                 times the width of the window that tests for it. So the mask is a
                 chromaticity test on the albedo, asserted against `palette.ts`
                 itself, and retuning a material across the line fails in
                 `npm test` rather than in somebody's screenshot.
                 **Relative, never absolute.** The four authored colours are a
                 base and three tones stated against it, and what the shader adds
                 is `tone - base`. That is what preserves the per-cell mottling --
                 both grass tones take the same shift -- and it is why
                 `macroTone` is *signed*: `mix(toDark, toLight, 0.5)` is the
                 midpoint of two tones, which is zero only if a palette chosen for
                 how a moss and a sunlit green look happens to be symmetric in
                 linear space, and it has no reason to be.
                 Every knob is a uniform rather than a compiled-in constant, which
                 is the opposite of the choice `wind.ts` makes and deliberate: the
                 whole point of this layer is that it is tuned against a running
                 frame, so the weather panel grew a `Ground` section and the
                 direction and clock stay the shared ones. What is compiled in is
                 `LIVING_GROUND_SHAPE` -- the aspect ratios, elongations and
                 threshold widths that decide what *kind* of thing this is.
                 Three findings are worth more than the code, and all three are
                 the same shape: **a layer can be correctly wired, switched on,
                 and invisible.**
                 A mark smaller than half a retro colour band is not a subtle
                 mark, it is an absent one. Spec 074 records learning that once;
                 every one of the four scales here got it wrong the first time and
                 the gust worst -- it shipped at a fifth of a step and the probe
                 could not find it against four walking animals. Every amplitude
                 is measured against a band in **linear** space at the grass's own
                 brightness, through `srgbDecode`, and one test states the rule for
                 all four scales at once so the next one added cannot skip it.
                 `hash21` is **degenerate on the integer lattice** it is handed:
                 it opens with `fract(p * vec2(127.1, 311.7))` and `fract(0.1n)`
                 on integers is a ten-step staircase, so the noise built on it is
                 far more correlated than it looks and its distribution is biased
                 low -- p50 at 0.39 against a proper 0.50. On the gust that was
                 not a subtlety: whole screens saturated at one end of the front,
                 so the meadow pulsed as one instead of having a boundary cross
                 it, which is spec 074's own "the ground read as changing colour
                 rather than as having something cross it" arriving by another
                 door. `grassNoise` has its own trig-free hash (no `sin`, for
                 `bayer4`'s reason); `hash21` is left exactly alone, being the
                 water's and the streak layer's and what those looks were tuned
                 against. Fixing it also fixed the *strokes*, whose thresholds had
                 been set generously to let anything through at all and which came
                 back as marbled whorls the moment the field behaved -- so
                 `detailDensity` and `flowBend` came down with it.
                 And **the shared wind clock does not advance in a headless
                 page.** Measured: with this layer off, the weather at maximum
                 speed and the weather stilled change the same number of pixels
                 over six seconds, so the trees are not swaying either. It is why
                 `preview-world.ts` only ever asserts on wind *strength*, which is
                 a uniform, and it means "the fronts move with the clock" has to
                 be asserted over the transcribed field in Node, where a time is
                 an argument. A browser probe reports a working front as a broken
                 one, and very nearly did.
                 A second pass tuned it (same spec), and its findings are the
                 first ones' in different clothes -- a number chosen for how big
                 it is rather than for how it sits against the frame. The look
                 read as **fingerprints and brushed metal**, and four things were
                 wrong. **Density, not amplitude**: both micro tails at a 0.80 cut
                 marked nearly half the meadow and the strokes about as much
                 again, and a faint mark everywhere is a grain -- so the cuts went
                 up and the clump became a **gate**, outside which the stroke
                 field cannot reach its threshold from any value it takes.
                 **Curl is a wavelength, not an angle**: the stroke direction came
                 off the macro field, which swings its whole range about every two
                 hundred units -- the length of a few strokes, which is exactly
                 the condition for a whorl -- so it comes off a long-wavelength
                 `coarse` field now (~790 units), which lets the bend be *larger*
                 and read as arcs. **A structure wider than the frame is not a
                 structure**: scaling the gusts 2.5x put a third of frames wholly
                 inside one lobe, so the front stopped crossing the clearing and
                 started tinting it (surveyed: 4% of frames blanketed at the
                 original size, 42% at 380). And **a tint toward a tone shifts
                 hue where a multiplier cannot** -- mixing toward the light tone,
                 markedly redder than the base, turned the meadow yellow once the
                 fronts were that big, so the breath is multiplicative like
                 `GLSL_STREAK`'s. The same trap had caught the dry patches when
                 they were briefly moved onto the coarse field, and the panel
                 found it: zeroing the macro term took the ground's R/G from 0.95
                 back to 0.86 against 0.83 with the layer off.
                 The one place the band rule is deliberately inverted is the
                 strokes: **half a step at rest and a whole one at a gust's
                 crest**, where every other mark clears a step standing still.
                 That gap is the look -- calm in a screenshot, alive in motion --
                 and `gustReveal` is its other half, a front lowering the stroke
                 *threshold* as well as its brightness, so what passes is more
                 grass rather than the same grass lit harder.
                 What is deliberately **not** built is the forest-edge term. There
                 is no prop distance field in this renderer and building one is a
                 system of its own, so `grassShelterAt` returns 0.0 and
                 `uGrassShelter` ships at 0 -- with the colour arithmetic that
                 consumes it written and tested, so what lands the day there is a
                 field is a function body rather than a feature.
                 `npx tsx scripts/probe-shading.ts` stays the tool for "does it
                 link", and is what caught a constant this chunk declared
                 colliding with one the wind chunk already had: a fragment shader
                 that does not compile, on the ground materials only, in a
                 browser, with every test in Node green and the terrain drawing
                 nothing. `terrain-living.test.ts` asserts every name this
                 introduces is declared exactly once in the *assembled* shader, so
                 the next collision fails in a second rather than in a browser.
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
