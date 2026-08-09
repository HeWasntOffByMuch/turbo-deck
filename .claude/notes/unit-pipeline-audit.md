# Audit: what exists today, ahead of the unit authoring pipeline

Read of the tree at `c0c3dc4` (branch level with `origin/main`). No code changed.
This is the STEP 1 deliverable for the Tripo -> rigged unit -> state machine
pipeline; it records what is actually there so the plan that follows is not
guessing.

## 1. Renderer

- **three.js `0.160.1`**, `@types/three@0.160`. Imported as `import * as THREE
  from 'three'` in ~25 files under `src/render/` plus four `scripts/preview-*.ts`.
  No other 3D renderer is live. PixiJS is in `dependencies` but nothing under
  `src/` imports it -- it is a leftover of the 2D game.
- **GLTFLoader: present but unused.** `three/examples/jsm/loaders/GLTFLoader.js`
  ships in `node_modules`, with `@types/three/examples/jsm/loaders/GLTFLoader.d.ts`
  beside it. Nothing imports it. Same for `KTX2Loader`, `DRACOLoader`,
  `libs/meshopt_decoder.module.js` and `libs/basis/`.
- **SkeletonUtils: present but unused.** `three/examples/jsm/utils/SkeletonUtils.js`
  + typings. Nothing imports it.
- **AnimationMixer: not used anywhere.** Zero references to `AnimationMixer`,
  `AnimationClip`, `SkinnedMesh`, `Bone`, `.glb` or `.gltf` in `src/` or
  `scripts/`. There is no skinning in this project at all today.

**Everything animated is procedural, hand-built geometry.** `rigs.ts` (1648 lines)
assembles `BoxGeometry`/cones/icosahedra into `THREE.Group`s and poses them by
writing `.rotation` / `.position` from distance travelled. `humanoid.ts` has its
own bone hierarchy (`src/render/cloth/figure.ts` `BONE`, `BONE_COUNT`,
`boneRestLayout`, `bindInverse[]`) that is a *kinematic* rig for the cloth solver
-- real bind-inverse matrices, real world matrices, but no `THREE.Skeleton`, no
skinned mesh, no clips. Bodies are dressed by a `BodyDresser` callback that hangs
solid boxes off bones.

Consequence: glTF skinning is **greenfield**. Nothing to retrofit, nothing to
break, but also no existing loader/mixer/pooling machinery to lean on. The
existing `humanoid.ts` bone naming is *not* mixamo and should not be conflated
with the canonical skeleton we are about to define -- they are different rigs
serving different consumers (cloth vs. skinning).

## 2. Is there a unit/entity concept?

Yes, a well-developed one. The scene is nowhere near "terrain and props only".

- **Server side** (`src/server/sim/types.ts`): `ServerEntity` with
  `kind` (`Player | Monster | Prop | Projectile`), `typeId` (a content id into
  `src/server/data/{monsters,abilities,items,skills}.ts`), `position: Vec3`,
  `facing`, `health`, `level`, `stats`, `radius`, `activity`,
  `activityUntilTick`, `cast: CastState | null`, `cooldowns`, `path`,
  `projectile`. Entities are readonly records stepped by a deterministic
  `step()`.
- **An action enum already exists on the wire**: `ActivityValue = { Idle,
  Moving, Casting, Stunned, Dead }` plus `CastState { abilityId, startedTick,
  releaseTick, endTick, phase, targetX/Y, targetEntityId, nextPulseTick }` and
  `CastPhase = { Windup, Channel, Turning }`, `CastEndReason = { Released,
  Cancelled, Interrupted }`. This is *exactly* the "position, facing, and an
  action enum" STEP 6 asks the server to send, and it is already sent. No
  protocol change is needed to drive a client-side state machine -- which also
  means `PROTOCOL_VERSION` (currently 10) does not have to move for STEP 6.
- **Client side**: `GameClient.view()` returns a replicated `ClientView`;
  `src/render/iso3d/world/appearance.ts` is a pure, tested function mapping
  `(kind, typeId) -> { rig, typeId, radius, showsHealth, look }`, deliberately
  total so an unknown id still draws. `WorldScene.syncBodies()` pools rigs keyed
  on `appearance.typeId`.

`appearance.ts` is the natural seam: a unitdef-backed unit is a new `RigKind`
alongside `player | monster | projectile | prop`, and the pooling key is already
the right one.

## 3. View routing / adding a third tab

`src/render/iso3d/main.ts`, 117 lines, is the whole shell. A `Tab` is
`{ label, mount(container) -> ViewHandle, fullscreen? }`; there are already
**four** tabs (Play, Movement sandbox, Rig debug, Map editor), views are mounted
lazily on first activation and `start()`/`stop()`d on switch.

**Adding Studio is one array entry plus one `mountStudio` module.** No routing
layer, no history/URL state, no shared state between tabs. The `fullscreen: true`
flag is what Play and Map editor use to own the window; Studio wants that too.
Risk to the other tabs is essentially nil -- the only shared surfaces are the
tab bar's own CSS and `ViewHandle`.

One real caveat: tabs are never unmounted, only hidden and `stop()`ed. A Studio
tab holding a WebGL context alongside Play's means **two live contexts**. Play's
`WorldScene` already handles `webglcontextlost`/`restored`, but a browser
context limit (typically 8-16) is not the concern -- GPU memory is. Studio's
renderer should be created on first activation (which lazy mount gives us) and
should release its render targets in `stop()`.

## 4. Does the Node server do HTTP?

**Yes, but barely, and only in one file.** `src/server/index.ts` creates a
`node:http` server whose entire handler is: serve `admin-client/index.html` for
`/` and `/admin*`, 404 everything else. The `ws` server is attached to that same
HTTP server (`new WebSocketServer({ server: httpServer })`) so they share an
origin and a port (default 8787).

Two architectural facts that constrain where the Tripo layer can live:

1. **`src/server/index.ts` is deliberately the only file in `src/server/` that
   imports a Node-only module.** Its header says so explicitly, and the reason is
   that `GameServer` and everything under it gets bundled into a browser tab for
   single-player. So `node:fs`, `fetch`-to-Tripo, and the job store must sit in a
   Node-only subtree (`src/server/studio/`) that `index.ts` wires in and that
   *nothing* in the portable core imports. If `src/server/server.ts` ever pulls
   in the studio module, single-player stops building.
2. **There is already an auth mechanism**: `src/server/admin/auth.ts` mints and
   verifies HMAC tokens (`createHmacAdminVerifier`, `signToken`), secret from
   `ADMIN_SECRET` or a throwaway per boot. `/api/studio/*` spends real money and
   should reuse it rather than being open on localhost.

There is also **no route handling abstraction** -- the handler is a single
if/else on `request.url`. A small router is needed; `src/server/admin/router.ts`
exists but is a WebSocket admin-namespace message router, not HTTP.

## 5. Existing asset loading / caching

**There is essentially none, by design.** The repo has:

- `assets/FD_Dungeon_Free.png` -- a spritesheet from the dead 2D game. Not
  imported by anything under `src/`.
- No `public/` directory (though `vite.config.ts` points `publicDir` at
  `../../public`).
- Exactly two runtime asset imports in the whole client, both the same file and
  both compile-time: `import mapText from '.../maps/arena.json?raw'` in
  `world/view.ts` and `wind-probe.ts`.
- Zero `fetch()`, zero `new Image()`, zero `TextureLoader`. Textures that exist
  (`detail-texture.ts`, the Bayer matrix, the palette texture) are **generated
  procedurally in code** -- `pixel-font.ts`'s comment says "since nothing may be
  fetched", which reads as a standing preference.
- The one streaming path that exists is terrain: `MapInfo` + `MapChunk` over the
  binary WebSocket protocol, cached client-side by `client/map-cache.ts` and
  assembled by `client/streamed-map.ts`.

So: **a `.glb` fetch + cache layer is new work with no precedent to follow.** It
is also the first thing in this project that loads a binary blob over HTTP at
runtime, which means the dev-server story matters (see risks).

## 6. Per-frame update ordering and the fixed timestep

There are **two** fixed-timestep loops, and they are separate from render.

**Server, headless** (`src/server/loop.ts`, `TickLoop`): "the only part of the
server that reads a clock". Accumulator over `SERVER_TICK_MS` (16.67ms, 60Hz),
`MAX_CATCHUP_TICKS = 5`, re-entrancy guard, `onLag` callback when backlog is
dropped. Ticks are whole; the sim never sees elapsed time.

**Play tab** (`src/render/iso3d/world/view.ts:804` `frame(now)`), which is the
one that matters for STEP 6:

```
elapsed = now - last
accumulator = min(accumulator + elapsed, TICK_MS * MAX_CATCH_UP_TICKS)   // 10
while (accumulator >= TICK_MS) {
  accumulator -= TICK_MS
  server.tick()          // the in-tab server, single-player only
  client.advanceTick()   // the client's own estimated clock
  sendInput()
}
view = client.view()
... alpha = min(1, sinceDelta / DELTA_MS)          // 20Hz delta interpolation
    drawnTick = view.estimatedTick + accumulator/TICK_MS
scene.render(view, { dt: elapsed/1000, alpha, tick: drawnTick, ... })
hud.update(...)
requestAnimationFrame(frame)
```

Then inside `WorldScene.render` the order is: `resize` -> clamp `dt` to 50ms ->
`advanceWind(dt)` -> `observe(view)` -> `syncBodies(view, frame, dt)` ->
`carryTorch` -> move marker -> `syncTelegraphs` -> `ageEffects` -> `poofs` ->
camera follow -> `updateMatrixWorld` -> `syncHover` -> hike/prop shading ->
pixel snap -> `collectAnchors` -> buffer capture -> retro pass -> edge pass ->
unsnap.

Three notes that bear directly on STEP 6:

- **Rig posing today happens inside `syncBodies` on wall-clock `dt`, not on the
  tick.** Every existing rig's `update(dt, ...)` takes seconds. Moving skinned
  units onto the fixed step is therefore a deliberate departure from how the
  procedural rigs work, not a continuation of it. That is the right call
  (events must land identically at any framerate) but it means skinned units and
  procedural rigs will advance on different clocks. Worth being explicit about.
- **`server.tick()` in that loop only exists because Play is single-player
  in-tab.** Against a real socket there is no local sim tick -- only
  `client.advanceTick()` and `view.estimatedTick`. So the mixer must advance off
  the *client's* tick counter, not off `server.tick()`, or it will not work
  multiplayer.
- **`MAX_CATCH_UP_TICKS = 10`** caps how far one frame can advance. An event that
  should have fired in a dropped tick must still fire exactly once -- which is
  precisely the "fire on frame-index crossing, not wall-clock, and exactly once
  even if the step overshoots" requirement. The cap is where that gets tested.

## 7. Build setup

- **Vite 6**, `root: 'src/render'`, `outDir: '../../dist'`, `publicDir:
  '../../public'` (does not exist). Config is 8 lines: no plugins, no aliases, no
  proxy, no manual chunks.
- **TypeScript 5.7** in `--noEmit` mode only. Strict, plus
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
  `verbatimModuleSyntax`, `isolatedModules`, `resolveJsonModule`. `include` is
  `["src", "scripts", "vite.config.ts", "vitest.config.ts", "eslint.config.js"]`.
- **Vitest 3**, `environment: 'node'`, `include: ['src/**/*.test.ts']` --
  **tests outside `src/` are not run.** A validator that CI must enforce has to
  have its tests under `src/`.
- **Offline scripts exist and are a well-worn pattern**, run via `tsx`:
  `bake-map.ts`, `grow-map.ts`, and a dozen `preview-*.ts` / `probe-*.ts` that
  drive Playwright (`playwright@1.62`, Chromium available) or rasterise in
  software with `pngjs`, writing to `.claude/screenshots/` which is **tracked**.
  This is a ready-made harness for the screenshot-diff and extreme-pose
  validation in the checklist.
- **But: no offline script runs as part of `npm run build`.** `build` is bare
  `vite build`. `bake-map.ts` is invoked by hand.
- **CI** (`.github/workflows/ci.yml`) is `npm ci` -> `typecheck` -> `lint` ->
  `test`. Nothing else. Adding `validate:units` is one line.
- **Lint boundaries are enforced mechanically** (`eslint.config.js`):
  `DETERMINISTIC_CORE` = `src/shared`, `src/sim`, `src/terrain`, `src/cards`,
  `src/game`, `src/balance`, `src/server/{sim,world,player,data}` -- bans
  `Math.random`, `Date`, `performance`, DOM globals, `requestAnimationFrame`,
  and imports of `three`/`three/**`/`pixi.js`/`lil-gui`/`**/render/**`.
  `PURE_RENDER` is the same ban list applied to an **explicitly enumerated list
  of individual files** under `src/render/`. Any new pure module we want linted
  must be added to that array by hand -- it is not a glob.

## 8. Things the brief assumes that are not true

Flagging these now rather than at implementation time:

1. **STEP 7 says "feeds the existing offline model build"; there is no offline
   model build.** No decimation, no vertex splitting for flat shading, no
   meshopt, no KTX2, no manifest, no content hashing -- zero references anywhere
   in the repo. The only hit for any of those words is a comment in
   `critters/types.ts`. STEP 7 is build-it-from-scratch, not integrate-with.
   The `bake-map.ts` script is the closest structural precedent.
2. **"The manifest hash is exchanged with the server on client connect" does not
   exist.** The welcome message carries `PROTOCOL_VERSION` and `MapInfo`; there
   is no asset manifest concept. Adding a hash to the welcome **is** a wire
   change and does move `PROTOCOL_VERSION` to 11.
3. **480x270 is not what the game renders at by default.** Two modes coexist:
   the default is `internalRenderSize()` -- fixed `RENDER_H = 300` at the window
   aspect, capped at `MAX_RENDER_W = 760`, no letterbox. The 480x270 fixed
   virtual buffer is `hike.lowRes`, and *every one of the ten hike switches is
   off by default* (`DEFAULT_VIRTUAL_SIZE = '480x270'` only applies once `lowRes`
   is on). Likewise flat-shading normals (`smoothNormals`), the palette
   (`palette: null`), and the outline pass (`edges`) are all off by default.
   So "renders through the SAME pipeline as the game" is ambiguous and needs a
   decision: mirror the game's *shipped defaults*, or mirror the *target look*.
   My recommendation is that Studio reads the same `HikeSettings` object the Play
   tab's cog writes, defaulting to the target look (lowRes + flat + palette +
   edges on) with a visible note that Play ships them off -- that way it can
   never drift, and the "full-res inspection toggle" is just `lowRes: false`.
4. **The browser never talks to the Node server over HTTP today.** Play is a
   server *in the tab* over `LoopbackTransport`. `npm run dev` (Vite, :5173) and
   `npm run server` (:8787) are separate processes that never meet. Studio's
   `/api/studio/*` calls are cross-origin from the dev server. This needs a Vite
   `server.proxy` entry -- small, but it is the first coupling between the two
   dev processes and it will confuse anyone who runs `npm run dev` alone. Studio
   must degrade gracefully (a clear "start `npm run server`" banner) rather than
   throwing.
5. **World scale is not metric and is large.** `SERVER_PLAYER_RADIUS = 16`; the
   cow critter stands ~86 units and the player draws it at `bodyScale: 0.7`, so a
   player body is ~60 units tall. Terrain chunks are 616 units. A mixamo rig
   arrives ~1-2 units tall. The `canonicalHeight` in `skeleton.json` must be in
   **world units** (~60), and the import scale factor will be ~30-60x. Getting
   this wrong is the single most likely way the first unit shows up invisible or
   the size of a hill.
6. **`humanoid.ts` already has something called a bone hierarchy.** It is the
   cloth solver's rig, is not mixamo-named, and is not the canonical skeleton.
   Two things named "bones" in one renderer is a naming collision worth avoiding
   deliberately (`SkinBone` vs the existing `BONE`).

## 9. Risk register

| Risk | Why it bites | Mitigation |
|---|---|---|
| Tripo output is not actually mixamo-conformant | The entire shared-skeleton premise collapses; every unit needs its own clips | Bone-name/hierarchy assertion runs on the *first* rig before any retarget spend; treat a mismatch as a hard stop, not a warning |
| Paid calls fired from a re-render / double-submit | Real money | Confirmation is a server-side one-shot token, not a browser boolean; cache-by-hash checked server-side before submit |
| Job store lost on restart mid-task | Orphaned paid task | Persist before submit, not after; resume poll on boot |
| Model URL expiry (~5 min) | Paid asset lost | Download in the same handler on success; never return the URL |
| Two WebGL contexts (Play + Studio) | GPU memory, context loss | Lazy mount (already the shell's behaviour) + release targets on `stop()` |
| Skinned normals in the depth/normal prepass | `hike-buffers.ts` writes view-space normals with its own material override; a skinned mesh needs the skinning in *that* material too or outlines lag a frame / are wrong | This is a real, specific bug the checklist already names; needs `MeshNormalMaterial`-equivalent with `skinning` and the same wind/sway normal rotation |
| Mixer on the fixed step vs. rigs on `dt` | Two clocks in one scene | Accept and document; skinned units advance in the tick loop, procedural rigs stay on `dt` |
