# 063 — The iso renderer on the server (spec 057, stage 3)

## Problem

Spec 057 staged the move onto the server in four steps. Stages 1, 2 and 4 have
landed — 062 took the last of them early, deleting `src/game/session.ts` and
`src/sim/combat.ts` along with the card economy they served. Stage 3 is the one
still open, and 062 changed what it means.

057 wrote it as "`GameLoop` stops calling `stepGame` and starts reading
`GameClient.view()`". There is no `GameLoop` any more, and nothing calls
`stepGame` because there is no `stepGame`. What is left is the half of stage 3
that spec 062 explicitly deferred: the game is played on a **flat 2D canvas**
(`src/render/play/view.ts`), a stopgap that exists so wind-ups and projectiles
were testable before the art path caught up. The isometric renderer — terrain,
props, rigs, shadows, the retro filter, six specs of look — died with the tab
that mounted it and has drawn nothing since.

So stage 3 is now: **give the 3D view back, reading only from `GameClient`.**

## The part that is not just moving a renderer

The old iso scene owned the world. It called `createArenaWorld(seed)`, scattered
the vegetation, built the meshes, and then handed the colliders it had just built
*to the sim* (`scene.worldColliders()`). The renderer decided where the trees
were and the sim agreed afterwards. That is exactly backwards once the sim is on
the other end of a socket, and it cannot survive the move.

Today the two sides do not agree at all:

- `src/server/index.ts` builds terrain with `createArenaWorld(seed)` but passes
  `createWorldColliders(ARENA_OBSTACLES, [], WORLD_BOUNDS)` — an **empty**
  vegetation list. The server already walks through every tree in its own world.
- The in-tab server in `play/view.ts` passes no terrain at all, so it walks a
  flat plane, and no client could know otherwise.
- Nothing on the wire says which world this is. A client cannot build the ground
  it is standing on because it is never told the seed.

A 3D client that draws a forest the server does not collide against is a worse
bug than no 3D client: every tree becomes a place where prediction is corrected
for reasons the player cannot see.

The fix is one build, on both sides, from one number:

```ts
// src/server/world/build.ts -- pure, part of the deterministic core
interface BuiltWorld {
  readonly seed: number;
  readonly terrain: TerrainWorld;
  readonly props: readonly Prop[];
  readonly sampler: TerrainSampler;   // what the sim asks "how high is here"
  readonly colliders: WorldColliders; // arena walls + every prop's footprint
}
function buildWorld(seed: number): BuiltWorld;
```

`src/server/index.ts`, the in-tab server and the renderer all call it. The
renderer calls it for meshes and calls nothing else; the server calls it for
collision and height. Neither can drift because there is no second construction
to drift from.

The seed reaches the client the only way it honestly can — the server says it:

```ts
interface WelcomeMessage {
  // ...
  readonly worldSeed: number;   // new
}
```

`PROTOCOL_VERSION` goes 1 → 2. `GameClient` exposes it as `view().worldSeed`,
and the renderer builds its world when the welcome lands, not before.

## The rate mismatch, which is presentation

The sim runs at 60Hz and deltas go out at 20Hz (spec 057's whole rate split), but
frames are painted whenever the browser paints. Between two deltas a remote
entity has no new authoritative position, and snapping it three ticks at a time
is the classic 20Hz stutter.

Interpolation is the answer and it is **presentation, not state**: the replica
keeps holding exactly what the server said, and the renderer keeps a parallel
smoothed position it draws at. Nothing reads a smoothed position back into a rule
— there are no rules on this side of the wire — so the CLAUDE.md line holds.

```ts
// src/render/iso3d/world/interpolate.ts -- pure, no three.js, no DOM
class EntityMotion {
  observe(id: number, x: number, y: number, z: number, facing: number, tick: number): void;
  /** Where to draw it. `alpha` is fraction of a delta interval elapsed. */
  sample(id: number, alpha: number): DrawnPose | null;
  forget(id: number): void;
}
```

The local player is the exception and already solved: `GameClient` predicts it
every tick, so the renderer draws `view().self` directly and never interpolates
its own body.

## Shape

```
src/server/world/build.ts               one world from one seed, for both sides
src/render/iso3d/world/interpolate.ts   20Hz deltas -> a pose per frame (pure)
src/render/iso3d/world/intent.ts        held keys + cursor -> move/facing (pure)
src/render/iso3d/world/appearance.ts    entity kind/typeId -> which rig (pure)
src/render/iso3d/world/scene.ts         the three.js scene, driven by a ClientView
src/render/iso3d/world/hud.ts           cast bars, health, damage numbers, hotbar
src/render/iso3d/world/view.ts          mountWorld(): the Play tab
```

`scene.ts` takes a `ClientView` and a frame's `dt` and moves meshes to match. It
has no reference to `GameServer`, `GameClient` or a transport — `view.ts` owns
those, which is what keeps "draws server state" from quietly becoming "drives the
server".

The flat canvas stays, as a second tab. It is thirty lines of drawing over the
same `GameClient` and it is the fastest way to tell a wire bug from an art bug;
two *views* over one client breaks no rule, and it was two *sims* that the one
rule was ever about.

## Invariants tested

- **One world, both sides.** `buildWorld(seed)` twice gives identical terrain
  heights, an identical prop list and identical colliders; and the colliders it
  hands the server include every prop the renderer will draw — the empty
  vegetation list that shipped in `index.ts` cannot come back unnoticed.
- **The seed survives the wire.** A welcome encoded and decoded round-trips
  `worldSeed`, and a client connected to a server built on seed N reports N.
- **Interpolation converges.** Fed a stream of positions three ticks apart, the
  sampled pose at `alpha = 1` equals the latest observed position exactly — a
  smoothed draw never lags behind an authoritative one it has fully consumed.
- **Interpolation is monotone.** Between two observations the sampled position
  moves toward the newer one and never overshoots it, at any alpha in [0, 1].
- **Facing takes the short way.** Interpolating from 350° to 10° passes through
  0°, not backwards through 180°.
- **A forgotten entity is gone.** After `forget`, sampling returns null rather
  than a stale pose, so a despawned monster cannot be drawn by a renderer that
  merely stopped being told about it.
- **Intent is a pure mapping.** Held W and D give the normalised diagonal;
  opposed keys cancel; facing is the angle to the cursor and nothing else.
- **Appearance is total.** Every entity kind and every id in `MONSTERS` maps to a
  rig, so an unknown type draws *something* rather than throwing in a frame.

Everything above runs headlessly in Node. The three.js half is checked the way
the editor's is: a Playwright screenshot, committed to `.claude/screenshots/`.

## Out of scope

- **Deleting the flat view.** It stays as a diagnostic tab.
- **Multiplayer from the tab.** The Play tab boots a loopback server, which is
  what 057 says single-player is. Pointing it at `ws://` is a URL and a
  transport swap, deliberately not wired to UI here.
- **Prediction of anything but movement.** Casts stay server-confirmed, per 062.
- **The terrain the editor authors.** The renderer builds the *generated* world
  from a seed. Playing a saved map document is spec 048's data path meeting this
  one, and it is its own change.
- **Interest-driven mesh streaming.** The world is built once at welcome. Chunked
  loading matters when the world is bigger than the one `createArenaWorld` makes.
