# VFX and particles — plan

Status: **Phase 1 landed; Phase 2a (sparks) at its review gate.**

| Phase | State |
|---|---|
| 0 — plan | done |
| 1 — core system (spec 118) | done, 71 tests, lint and typecheck green |
| 2a — sparks + verification + glow comparison | done |
| 2b — blood splat generator (spec 119) | done |
| 2c — decals: ground, props, gore setting, combat wiring (spec 120) | done |
| 2d — the effect library: fire, smoke, auras, hit vocabulary (spec 121) | **at the review gate** |
| 3 — Studio VFX tab | not started |
| 3 — Studio VFX tab | not started |

This is the living document for the VFX arc. It is updated as decisions land, and
it is where the damage-type colour/shape language is written down so future
effects stay coherent.

A note on where this lives. `CLAUDE.md` requires a numbered `specs/` entry
committed *before* its implementation. This file is the plan and the running
record the brief asked for; the per-phase specs (`specs/118-…` onward) are the
short, testable contracts that go in before each phase's code. They are not
duplicates: this argues, those assert.

---

## 0. What the read turned up

Findings that actually changed the design, with the file that says so.

**The whole frame is already low-resolution, before any pass runs.**
`WorldScene.resize` (`src/render/iso3d/world/scene.ts:1405`) sets the
*renderer's backing store* to `internalRenderSize(...)` — height fixed at
`RENDER_H = 300`, width capped at `MAX_RENDER_W = 760`
(`src/render/iso3d/view-frame.ts:13`). With the `lowRes` switch on it is a fixed
480×270 instead (`hike.ts:416`), and CSS blows the canvas up by a whole number of
device pixels with `image-rendering: pixelated`. So the upscale is the *browser's*
nearest-neighbour, not a blit shader we could accidentally bypass.

**There is exactly one path from the scene graph to the screen.**
`WorldScene.render` ends in `this.retro.render(this.renderer, this.scene, this.camera)`
(`scene.ts:836`), and `RetroPass.render` draws `scene` into its own target then
paints that target through the quantize/dither quad (`retro-pass.ts:423-426`).
The only other thing that touches the default framebuffer is the outline pass
(`drawEdges`, `scene.ts:840`), which draws no scene geometry at all.

The consequence is the single most important fact in this plan: **a
`THREE.Object3D` added to `WorldScene.scene` is in the low-res buffer by
construction.** There is no compositing step to get wrong, and no VFX render pass
to insert. The art-direction constraint is satisfied by *not building a separate
pass*, which is the opposite of the usual answer.

**Transparent geometry is already excluded from the outline buffers.**
`HikeBuffers.capture` skips any material with `transparent === true` or
`depthWrite === false` (`hike-buffers.ts:358`), which is documented as the rule
that keeps ground decals from being outlined like surfaces. Particles and decals
inherit that exclusion for free, and correctly: a spark is not a form that should
be inked.

**A VFX id channel already exists on the wire.** `EffectMessage` carries
`effectId: string` (`src/server/net/messages.ts:425`), and the sim already emits
`` `${ability.id}.impact` `` and `` `${ability.id}.self` ``
(`src/server/sim/abilities.ts:697,724`, `sim/world.ts:608,632`). The renderer
currently throws the id away and draws one hardcoded circle
(`scene.addEffect`, `scene.ts:722`). Wiring the registry to that id needs no
protocol change.

**There is precedent for presentation-only data on a shared table.**
`ProjectileLook` on `AbilityDefinition` (`src/server/data/abilities.ts:41`) is
explicitly documented as a look that nothing under `src/server/sim/` reads and
that rides no wire. Damage type and per-ability VFX ids follow that pattern
exactly, so no new mechanism is needed.

**Two existing effects are ad-hoc and should be absorbed.** `Poofs`
(`rigs.ts:1608`) allocates a `Group` and three materials per footfall and disposes
them on death; `scene.addEffect` allocates a `CircleGeometry` and a material per
blast. Both are per-spawn garbage in a hot path. They become registry entries
(`footstep_dust`, `blast_ring`) and the classes go away.

### Friction to flag rather than work around

1. **`Rng` cannot be used in the update loop.** `src/shared/prng.ts` is
   deliberately immutable — every draw returns a *new* `Rng`
   (`prng.ts:16-19`) — which is exactly right for the sim and fatal for a
   zero-allocation particle loop. VFX needs a mutable, non-allocating generator.
   Since VFX is presentation-only and lives outside the deterministic core, the
   plan is a small mutable xorshift in `src/render/iso3d/vfx/rng.ts`, with a test
   asserting seed-reproducibility. It is **not** a second sim PRNG and must never
   be imported by anything the linter guards. Alternative considered and rejected:
   pre-drawing a block of numbers from `Rng` at spawn time — it bounds the draws
   per effect instance, which sub-emitters break.
2. **`CombatResultMessage` has no damage type.** Fields are attacker, target,
   damage, targetHealth, flags (killed/critical/blocked). Damage type is derived
   client-side from the ability/item tables, the `ProjectileLook` way. This is
   fine, and it is worth stating because "tint the impact by damage type" reads
   like a protocol change and is not one.
3. **The client never evicts map chunks.** `StreamedMap.add` inserts and nothing
   removes (`src/server/client/streamed-map.ts`); there is no drop path in
   `map-cache.ts` either. So "decals stream out with the chunk" has no eviction
   event to hang off *today*. See decision (c).
4. **No audio system is wired up.** `src/render/music.ts` is pure note data with
   no player attached to the Play tab. The sound hook is a typed no-op sink, with
   the interface written now so wiring one later is a single implementation.
5. **The Studio preview shares a control-panel *type* with Play, not an
   instance** — an existing, documented caveat (`studio/preview.ts` header). The
   VFX tab inherits it: switches have to be thrown in both places.

---

## 1. Where VFX hooks into the pipeline

### Render pass order (existing, with VFX marked)

```
WorldScene.render(view, frame)
  1  resize()                       -> backing store = virtual res (<=760x300, or 480x270)
  2  advanceWind(dt); observe(); syncBodies(); carryTorch()
  3  syncTelegraphs(); ageEffects(); poofs.update(dt)
 3b  >>> vfx.update(frame.ticks)    <<< NEW - whole 60Hz steps, not dt
 3c  >>> vfx.sync(camera)           <<< NEW - billboard/sort/upload, once per frame
  4  followSelf(); applyControls(); applyPlayerLights(); camera.lookAt()
  5  syncHover()                    (unsnapped camera: a pick, not a picture)
  6  applyPixelSnap(); collectAnchors()
  7  HikeBuffers.capture()          VFX excluded automatically (transparent/no depthWrite)
  8  RetroPass.render(scene, cam)   >>> VFX rendered HERE, inside the low-res target <<<
  9  drawEdges()                    over the finished frame; draws no scene geometry
 10  unsnap()
--- outside the scene ---
 11  DOM HUD overlay, positioned to the letterboxed canvas box
```

VFX enters at 3b/3c (update) and is *drawn* at 8 by virtue of being in the scene
graph. Nothing is added to the pass chain.

Two ordering details that matter:

- **`vfx.sync` runs before the pixel snap (6), not after.** The snap nudges the
  camera by up to half a virtual pixel and is undone at 10. Billboard basis
  vectors want the unsnapped camera for the same reason `syncHover` does — a
  basis derived from the snapped camera would wobble by the snap amount each
  frame, which is the shimmer the snap exists to remove. Particle *positions* are
  world-space and unaffected either way.
- **Ground decals must not write depth**, both to avoid z-fighting with terrain
  and to keep the `HikeBuffers` exclusion at `hike-buffers.ts:358` applying to
  them. Depth offset comes from `polygonOffset` plus a small lift along the
  terrain normal, the way the existing ground rings already sit.

### Update tick

`FrameInfo` already carries both `dt` (seconds, clamped to 0.05) and `ticks` (the
whole 60Hz steps this frame drained) — `view.ts:878-885`. VFX advances on
**`ticks`**, for the same reason `UnitMachine` does: an effect stepped by wall
time is a different effect at 30fps and at 144fps, and "same seed reproduces the
same effect exactly" stops being a statement anyone can test. A frame that drains
zero ticks redraws the previous state.

Cost: at 60Hz a particle's per-tick motion is at most a fraction of a virtual
pixel at gameplay zoom, so there is no visible stepping to buy back with
interpolation. If one ever shows on a very fast spark, the fix is a render-time
position extrapolation in `sync`, which does not touch the simulated state.

### Event sources

| Source | Signal | Effects it drives |
|---|---|---|
| `client.onEffect` (`game-client.ts:788`) | `effectId`, x/y/z, radius, durationTicks | Ability impacts and self-casts. `effectId` **is** the registry key. |
| `client.onCombatResult` (`view.ts:233`) | attacker, target, damage, flags | Impact flash, sparks, blood, crit, block. Damage type looked up from the ability table. |
| `client.onCastStarted` / `onCastEnded` | entity, abilityId, phase, ticks | Channel auras, cast flashes, boss telegraphs. |
| Replica diff (`replica.ts`) | health drop, entity removed, `activity` | Death effects, status auras, burning-unit attachment. |
| Renderer-local | footfalls (`rigs.ts`), projectile spawn/despawn (`scene.syncBodies`), terrain material under a foot | Footstep dust, trails, muzzle flashes. No server event exists for these. |

All server-fed translation lives in **one** pure module,
`src/render/iso3d/world/vfx-wire.ts`: `(event, snapshot) -> PlayRequest[]`. It is
handed plain data, never the `GameClient` — the same discipline `unit-driver.ts`
already follows so that animation has nothing it *could* call. It is unit-tested
in Node, and `presentation-only.test.ts` gets a sibling asserting that the same
seed and inputs produce identical authoritative state with VFX driven and with
VFX absent.

---

## 2. Data model

An effect is data. Call sites only ever say:

```ts
vfx.play('hit_metal_spark', { position, rotation, attachTo, tint, scale, seed });
```

### Types

```ts
/** Piecewise-linear over normalized life. Sampled, never allocated. */
export interface Curve {
  readonly keys: readonly (readonly [t: number, value: number])[];
}

/**
 * Colour over life. Stops name PALETTE entries rather than free hex, so an
 * effect cannot introduce a colour the look does not have (see section 6).
 */
export interface Gradient {
  readonly stops: readonly (readonly [t: number, color: PaletteKey])[];
}

export type EmitterShape =
  | { readonly kind: 'point' }
  | { readonly kind: 'sphere' | 'hemisphere'; readonly radius: number; readonly shell?: boolean }
  | { readonly kind: 'cone'; readonly angle: number; readonly radius: number }
  | { readonly kind: 'box'; readonly half: Vec3 }
  | { readonly kind: 'circle'; readonly radius: number; readonly shell?: boolean }
  | { readonly kind: 'mesh'; readonly source: 'attached' }        // surface of the attached unit
  | { readonly kind: 'arc'; readonly radius: number; readonly sweep: number };  // slashes

export type Emission =
  | { readonly kind: 'burst'; readonly count: number; readonly delayTicks?: number }
  | { readonly kind: 'rate'; readonly perSecond: number }
  | { readonly kind: 'ramp'; readonly perSecond: Curve; readonly overTicks: number };

export type RenderMode =
  | 'billboard'            // camera-facing quad
  | 'stretched'            // velocity-aligned, length scales with speed
  | 'axis-billboard'       // Y-locked; the isometric default for uprights
  | 'ground-quad'          // flat on the terrain, follows its normal
  | 'ribbon'               // trail through recent positions
  | 'mesh';                // instanced solid (debris chips)

export type Blend = 'alpha' | 'additive' | 'dither-cutout';

export interface Emitter {
  readonly id: string;
  readonly shape: EmitterShape;
  readonly emission: Emission;
  readonly lifetimeTicks: readonly [min: number, max: number];
  readonly speed: readonly [min: number, max: number];
  readonly spreadRadians: number;
  readonly gravity: number;            // world units / s^2, negative is down
  readonly drag: number;               // per second
  readonly angularVelocity: readonly [min: number, max: number];
  readonly turbulence?: { readonly amplitude: number; readonly frequency: number };
  readonly size: Curve;
  readonly alpha: Curve;
  readonly color: Gradient;
  readonly rotation?: Curve;
  readonly velocityScale?: Curve;
  readonly render: RenderMode;
  readonly blend: Blend;
  readonly sprite?: { readonly sheet: string; readonly frames: number; readonly fps: number; readonly randomStart: boolean };
  readonly collision?: {
    readonly restitution: number;
    readonly friction: number;
    readonly maxBounces: number;
    readonly onCollide?: string;       // sub-effect id
  };
  readonly subEmitters?: {
    readonly onSpawn?: string;
    readonly onDeath?: string;
  };
  readonly light?: { readonly color: PaletteKey; readonly intensity: Curve; readonly radius: number };
  readonly sound?: { readonly cue: string; readonly on: 'start' | 'burst' | 'collide' };
}

export interface EffectDefinition {
  readonly id: string;
  /** Dropped first when over budget. 0 = ambient, 3 = must never be culled. */
  readonly priority: 0 | 1 | 2 | 3;
  readonly emitters: readonly Emitter[];
  /** Beyond this many world units from the camera the effect is not spawned. */
  readonly cullDistance?: number;
}
```

### Concrete example

```ts
export const HIT_METAL_SPARK: EffectDefinition = {
  id: 'hit_metal_spark',
  priority: 2,
  cullDistance: 1400,
  emitters: [
    {
      id: 'shower',
      shape: { kind: 'cone', angle: 1.05, radius: 2 },
      emission: { kind: 'burst', count: 14 },
      lifetimeTicks: [8, 20],
      speed: [220, 460],
      spreadRadians: 1.05,
      gravity: -900,
      drag: 1.6,
      angularVelocity: [0, 0],
      size: { keys: [[0, 3.2], [0.25, 2.4], [1, 0.9]] },
      alpha: { keys: [[0, 1], [0.7, 1], [1, 0]] },
      // hot white -> orange -> ember, all palette entries (section 6)
      color: { stops: [[0, 'sparkHot'], [0.35, 'sparkWarm'], [1, 'sparkEmber']] },
      velocityScale: { keys: [[0, 1], [1, 0.55]] },
      render: 'stretched',
      blend: 'additive',
      collision: { restitution: 0.35, friction: 0.4, maxBounces: 2 },
      light: { color: 'sparkWarm', intensity: { keys: [[0, 1], [1, 0]] }, radius: 90 },
      sound: { cue: 'impact_metal', on: 'burst' },
    },
    {
      id: 'stragglers',
      shape: { kind: 'cone', angle: 0.5, radius: 1 },
      emission: { kind: 'burst', count: 3 },
      lifetimeTicks: [34, 52],           // the few that outlive the shower
      speed: [140, 260],
      spreadRadians: 0.5,
      gravity: -900,
      drag: 1.1,
      angularVelocity: [0, 0],
      size: { keys: [[0, 2.4], [1, 0.8]] },
      alpha: { keys: [[0, 1], [0.85, 0.9], [1, 0]] },
      color: { stops: [[0, 'sparkWarm'], [1, 'sparkEmber']] },
      render: 'stretched',
      blend: 'additive',
      collision: { restitution: 0.45, friction: 0.35, maxBounces: 2 },
    },
    {
      id: 'flash',
      shape: { kind: 'point' },
      emission: { kind: 'burst', count: 1 },
      lifetimeTicks: [3, 4],             // brief, oversized, reads at 300px tall
      speed: [0, 0],
      spreadRadians: 0,
      gravity: 0,
      drag: 0,
      angularVelocity: [0, 0],
      size: { keys: [[0, 16], [1, 22]] },
      alpha: { keys: [[0, 0.95], [1, 0]] },
      color: { stops: [[0, 'sparkHot'], [1, 'sparkWarm']] },
      render: 'billboard',
      blend: 'additive',
    },
  ],
};
```

Runtime overrides (`tint`, `scale`, `seed`, `attachTo`) multiply into the
definition; they never mutate it. The registry is frozen at module load.

### Attachment

`AttachSpec` is one of: `world` (default), `{ entityId }`, `{ entityId, socket }`
(a bone name on a loaded `UnitRig`), or `{ entityId, socket, detach: 'onSpawn' }`
— the sparks-fly-off-a-moving-unit case. Socket lookup goes through
`UnitRig`, **not** through a name read out of a skeleton document: three.js
sanitises `mixamorig:Hips` to `mixamorigHips`, a trap `unit-rig.ts` already
documents and already solved with `findRootBone`. The VFX socket resolver reuses
that same "find it in the loaded rig" rule.

---

## 3. The three open decisions

### (a) CPU-simulated with instanced rendering — **recommended**

| | CPU sim + instanced draw | GPU/shader sim |
|---|---|---|
| Particle ceiling | ~3k comfortably; ~10k before JS is the cost | 100k+ |
| Cost at *our* counts | ~2k particles × ~40 flops × 60Hz ≈ 0.2–0.4 ms/frame | Similar, plus 2 FBO ping-pongs and state textures |
| Headless testability | Full. Runs in Node, in vitest, with no GL. | None. Cannot assert a seeded result without a GL context. |
| Collision, sub-emitters, decal spawn-on-impact | Straightforward — read terrain height, push an event | Needs readback or a parallel CPU shadow; spawn-on-collide is genuinely painful |
| Fits the repo | Matches `lobe.ts`, `edges.ts`, `shading.ts`: the arithmetic is pure and tested in Node, three.js is the thin half | Fights it |

The deciding number is the resolution. The buffer is at most 760×300 = 228,000
pixels. A particle that is *readable* under nearest-neighbour quantization is
roughly 3–12 virtual pixels across, so 2,000 live particles already covers a
meaningful fraction of the screen and the look wants far fewer, larger, crisper
ones than that. GPU simulation buys headroom above a ceiling we cannot approach
without the screen turning to soup — and it costs the one property this repo is
built around, which is that the interesting half runs and is asserted in Node.

**Recommendation: CPU simulation over flat typed arrays (SoA), instanced
rendering, batched by material + blend.** Revisit only if a real effect wants
>5k particles, which none in the Phase 2 list does.

Layout: one `Float32Array` per field (`x,y,z,vx,vy,vz,age,life,seed,size,rot,…`),
a free-list of indices, and a swap-with-last removal. No per-particle objects
exist at all, so there is nothing to allocate.

### (b) Both, with one rule — **recommended**

Explicit `vfx.play()` is the only API. The event bus is an *adapter on top of it*,
not a second path.

- Server events → `vfx-wire.ts` (pure, tested) → `vfx.play(...)`.
- Renderer-local cues with no server event (footfalls, projectile trails, terrain
  material under a foot) → `vfx.play(...)` directly from the scene.

Why not bus-only: footsteps, trails and material-tinted dust have no server
message and inventing one would put presentation on the wire, which spec 065 went
out of its way to remove (`messages.ts:344` records exactly that removal).

Why not calls-only: `effectId` already exists on `EffectMessage`, and the whole
point of a registry is that a designer adds `frostbolt.impact` to the table and it
plays with no renderer change. Throwing that away would mean editing a call site
per ability.

The rule that keeps it honest: **`vfx-wire.ts` may read game state and may not
change it.** No `if` in it affects a game outcome — the standing rule for
`src/render/`, and here it is the entire contract.

### (c) Blood decals across chunk streaming — **own the lifetime, hook the eviction that does not exist yet**

The honest finding first: **the client never drops a chunk.** `StreamedMap` only
inserts. So a design that relies on "the decal dies when its chunk streams out"
would be relying on an event that is never fired, and would look correct in
review and leak forever in play.

Recommended:

1. **Key decals by chunk coordinate** (`cx,cz` from the impact point), stored in a
   `Map<chunkKey, DecalBucket>`. A chunk is 28 cells × 22 units = **616 world
   units** square; the player is ~56 units tall, so a chunk is roughly eleven
   player-heights across.
2. **Cap per bucket at 64, oldest fades first** — a ring buffer, so a fight in one
   spot bounds its own cost and the eviction is a fade rather than a pop.
3. **Cap globally at 512** across all buckets, evicting whole buckets by distance
   from the camera when over.
4. **Expose `vfx.dropChunk(cx, cz)`** and call it from wherever chunk eviction
   eventually lands. Today nothing calls it; that is written down here rather than
   left as a surprise.
5. **One merged geometry per bucket**, rebuilt only when that bucket changes —
   the same region-invalidation pattern `props.ts` uses for the prop field
   (spec 086). A decal is a handful of triangles; rebuilding one 616-unit bucket
   is cheap and a global rebuild is not.

Terrain-fitted rather than projected: the terrain height sampler is already on
hand (`WorldScene.ground(x, y)`), so a ground decal is a small grid of quads
sampling the heightfield with a lift along the normal, `depthWrite: false`,
`polygonOffset` on. That handles hills without a projector pass, and keeps decals
inside the `hike-buffers.ts:358` exclusion.

Static props (Phase 2 item 2) use a real box projector with normal-angle
rejection; units (item 3) get their own recommendation, deferred to the Phase 2
review gate where the contact sheet is due — the current lean is the **hybrid**
(UV-space mask texture for persistent staining, bone-parented quads for the
moment-of-impact splat), but that is a call to make with pictures in hand, not
here.

---

## 4. Budget

Measured against the default path: virtual buffer ≤ 760×300, orthographic
isometric camera, 60Hz sim tick.

| Resource | Soft cap | Hard cap | What happens at the cap |
|---|---|---|---|
| Live particles | 2,000 | 3,000 | New spawns refused for priority 0, then 1 |
| Live decals | 512 total, 64/chunk | 640 | Oldest in bucket fades early; whole far buckets evicted |
| Concurrent effect instances | 96 | 128 | Lowest priority, then furthest, stopped (emitters off, live particles finish) |
| Draw calls for the whole VFX pass | 6 | 10 | One per (material, blend) batch; over this is a bug, not a budget |
| Sub-emitter depth | 2 | 2 | Third-level spawns are dropped silently |
| Per-frame allocations in update | 0 | 0 | Asserted by test, not by hope |

**Degradation order under pressure** — first to go, last to go:

1. Ambient/looping priority 0 (torch flicker, vents, distant fire embers)
2. Priority 1 cosmetics (footstep dust, minor debris)
3. Distance: any effect beyond its `cullDistance`, furthest first
4. Emission rate scaling on priority 2 (continuous emitters throttle before they stop)
5. Priority 2 one-shots (impacts, sparks) — *never* dropped for the local player's
   own blows while any budget remains
6. Priority 3 never drops (boss telegraphs, channel auras — these are readable
   information, not decoration)

The global **VFX intensity** setting (0 / low / medium / full) scales the soft
caps and emission counts, and `0` skips the update and sync entirely rather than
simulating into a void. **Gore intensity** is separate and its off switch skips
the blood decal work altogether, as required.

---

## 5. Build order

Each phase lands its `specs/` entry first, then its implementation, in separate
commits, per `CLAUDE.md`.

| # | Phase | Gate |
|---|---|---|
| 0 | This document | **Review — stop here** |
| 1a | `specs/118`: core system contract | — |
| 1b | RNG, curves, gradients, palette helper — all pure, tested in Node | `npm test` |
| 1c | Particle pool (SoA), emitters, shapes, over-life curves, collision, sub-emitters — pure | `npm test` + zero-alloc test |
| 1d | three.js half: instanced batches, blend modes, billboard bases, attachment | typecheck/lint |
| 1e | `vfx-wire.ts` + registry, replacing `Poofs` and `scene.addEffect` | `presentation-only.test.ts` sibling |
| 2a | **Sparks**, plus the low-res-buffer verification probe and the **glow approach comparison** | **Review — stop here** |
| 2b | Blood: procedural splat generator + **~30-splat contact sheet** | **Review** (contact sheet before wiring) |
| 2c | Ground decals, then prop decals, then the unit-staining recommendation | Review of (3)(a) vs (b) vs hybrid |
| 2d | Fire, smoke/clouds, auras, remaining hit effects | — |
| 3 | Studio VFX tab: browser, live editing, curve/gradient editors, preview scene, JSON export, debug HUD | Stress test numbers reported |

**Deliverables owed at the Phase 2a gate**, per the brief:

- How the low-res-buffer claim was *verified*, not asserted. Plan:
  `scripts/probe-vfx.ts`, modelled on `scripts/probe-shading.ts`, reads pixels out
  of the drawing buffer and asserts (i) every VFX colour present in the frame is a
  member of the active palette, and (ii) colour runs along a scanline through a
  particle are exact multiples of the upscale factor — i.e. the particle's edge
  lands on a virtual-pixel boundary. A natively-rendered sprite fails both.
- Two glow approaches rendered side by side: **additive sprite halo with an
  ordered-dither radial falloff** (reusing the Bayer matrix from `retro.ts` so the
  weave matches the frame's) versus **a low-res bloom applied inside the pixel
  buffer** (threshold + small blur at virtual resolution, before the quantize).
  Pictures, then a decision. No full-resolution bloom is on the table.

---

## 5a. What Phase 1 actually cost, measured

`node --expose-gc --import tsx scripts/profile-vfx.ts`, on the container this was
built in (software rendering, no GPU — the simulation figures are CPU only and
are what matter here). One tick is one 60Hz step, so µs/tick is the per-frame
cost at 60fps.

| Configuration | live | µs/tick | ns/particle | B/particle/tick |
|---|---|---|---|---|
| every feature at once, cap 1000 | 980 | 341 | 348 | 0.58 |
| every feature at once, cap 2000 | 1957 | 697 | 356 | 0.50 |
| every feature at once, cap 3000 | 2936 | 1045 | 356 | 0.32 |
| plain (curves, gradient, gravity, drag) | 1961 | 232 | 118 | 0.20 |
| + turbulence | 1961 | 509 | 259 | 0.50 |
| + ground collision | 1950 | 326 | 167 | 0.20 |
| + collision with a sub-effect | 1961 | 313 | 160 | 0.57 |
| + ribbon | 1961 | 248 | 126 | 0.24 |
| + sprite flipbook | 1958 | 238 | 122 | 0.20 |

Reading it:

- **The budget holds with room to spare.** 2,000 particles of ordinary work is
  0.23 ms a frame; 2,000 particles doing *everything at once* is 0.70 ms. Against
  a 16.6 ms frame that is 1.4% and 4.2%.
- **Turbulence is the one expensive feature** — it more than doubles the
  per-particle cost on its own. Fire and smoke both want it, so it is worth
  spending deliberately rather than sprinkling. It got 2.1× cheaper during this
  phase and is still the ceiling.
- **Allocation is not per particle.** 0.2–0.6 bytes per particle per tick, where
  a single small object each would be 32 or more. `alloc.test.ts` asserts the
  per-particle figure stays under 8.

Two performance findings worth keeping, because both cost real time to find and
neither is guessable from reading the code:

1. **V8 will not inline an eleven-argument helper.** `noise.ts` was factored into
   `field()` and a `blend()` taking eight corners and three weights, which is how
   anyone would write it. Flattening the identical arithmetic into one function
   took it from **325 ns to 112 ns a call** — 2.9×. The file is written flat now
   and says why at the top, because it reads worse and the next person to tidy it
   would undo the measurement.
2. **`>>> 0` leaves V8's small-integer range.** An unsigned 32-bit hash exceeds
   2³¹, which cannot be a Smi, so it boxes. The extraction `(h >> s) & 0x3ff`
   reads exactly the same bits with every intermediate staying small. (This one
   turned out *not* to be the bottleneck when measured in isolation — the
   inlining was — but it is still the right way to write it, and the ratio test
   in `alloc.test.ts` is what keeps either from regressing.)

The honest caveat on all of it: this is CPU simulation cost, measured under
software rendering. What the *draw* costs on a real GPU is a separate number, and
the stress test in the acceptance criteria (50 effects + 200 decals) needs decals
to exist first — it lands with Phase 2c.

---

## 5b. The two gate deliverables

### How "inside the low-resolution buffer" was verified

Not asserted — measured, on the composited page, by `npx tsx scripts/probe-vfx.ts`.
It renders a spark burst through the real `RetroPass` at a real virtual
resolution (240×150, upscaled ×4 by CSS) with a deliberately tiny six-colour
palette, screenshots the canvas, and checks two independent things in Node. A
particle drawn at native resolution and composited on top fails both:

| Check | What it would catch | Result |
|---|---|---|
| Every pixel is a palette entry | The pass snaps the whole image to the palette; anything drawn *after* it keeps its own colour | **36,000 of 36,000 on palette, 0 off** |
| Every 4×4 device-pixel block is one flat colour | The backing store is the virtual buffer and CSS upscales by a whole number, so a natively-drawn edge lands inside a block | **0 of 36,000 blocks non-flat** |
| Draw calls for the whole effect | Batching by (blend, sheet) working at all | **2** |

Two things went wrong on the way to that number, and both are worth recording
because both produced *believable* wrong answers:

- The first version called `readRenderTargetPixels(null, …)` to read the default
  framebuffer. three refuses that — it wants a real render target — so every
  measurement came back zero and the probe reported "nothing is on the palette",
  which is exactly what a genuinely broken pipeline reports. The pixels now come
  from the screenshot, which is the better subject anyway: it is what a player
  sees, and it is the only place the CSS upscale exists at all.
- The script imported the palette from the page module, which mounts itself on
  import, so running it in Node crashed on `document`. The shared numbers moved
  to `probe-config.ts`. Copying the palette into the script instead is the
  version where the two drift and the check keeps passing against a list nothing
  uses.

### Glow: three approaches, rendered

`.claude/screenshots/vfx-glow-{dither,smooth,layered}.png`. Same seed, same tick,
same ramp — only the halo's falloff differs.

| | What it is | How it reads at 240×150 |
|---|---|---|
| **dither** | Additive halo, radial falloff resolved against the same 4×4 Bayer matrix `retro.ts` dithers the frame with | Hot white core, halo dissolves into a stipple that belongs to the frame's own weave. 3 luminance levels over 415 px. |
| **smooth** | Additive halo, plain radial ramp | The ramp does not survive the quantizer. It collapses into a **hard-edged brown blob** with a visible contour — a shape, not a glow. |
| **layered** | Dithered halo plus a second wider, dimmer one | A much broader stipple field, 642 px. Reads big; also reads busy. |

**Recommendation: `dither` as the default, `layered` reserved for effects that
are meant to be large** (explosions, boss telegraphs, a fireball's ignition).

**And no bloom pass.** The `smooth` image is the argument, and it is a fair proxy:
a low-res bloom applied inside the pixel buffer produces exactly the smooth ramp
that `smooth` produces — it just generates it from the framebuffer instead of
from a sprite — and the quantizer does the same thing to it either way. Spending
a threshold pass, a blur pass and a second render target to arrive at the picture
on the right is not a trade worth making. If a future effect genuinely needs
light to bleed onto neighbouring geometry, the cheap light hook already in the
system (`LightSpec`) tints real geometry without touching the frame.

One honest caveat on the comparison: `dither` and `smooth` are like-for-like, but
`layered` adds an emitter, which shifts every later emitter's index and therefore
its RNG stream — so its *sparks* differ, not just its halo. The halo is still the
thing being compared, but the burst underneath is not the same burst.

---

## 5c. Blood: the generator, and what the contact sheet changed

`npx tsx scripts/preview-splats.ts` → `.claude/screenshots/splats.png`. Fifty
tiles: thirty blood splats over three rows, then one seed thrown eight ways, then
all five fluids from the same generator.

**The approach is the hybrid, as planned.** Five hand-authored blot profiles
supply the shape language; the seed supplies which blot, how big, how turned,
mirrored or not, where the droplets land, how far the drips run, and how far the
whole thing is drawn out along the blow. Nothing is fetched and nothing is fBm.

### The first sheet was wrong, and that is what it was for

The first render produced thirty rounded masses with a couple of specks beside
them — jellybeans, not spatter. Every test passed. Three things were wrong, and
none of them is visible from the code:

1. **The outlines were circles.** Sixteen smoothly interpolated profile samples
   at a six-pixel radius is a slightly squashed circle. Fixed with a per-stamp
   ragged edge — three harmonics with random amplitude and phase — which puts
   irregularity back at the scale the pixels can hold while staying continuous,
   so the edge is torn rather than fizzy.
2. **The droplets were invisible.** Sized at a tenth of the core, which on a
   32-pixel tile is one or two pixels: present in the mask, absent on screen.
   They are now a third to two thirds of the core, stretched harder than the
   core is, so an airborne drop lands as a dash rather than a dot — and the
   dashes are most of what says "thrown".
3. **The mass was one blob.** Now three or four overlapping blots, so the
   silhouette is a union of ragged outlines rather than one rim.

A fourth thing was wrong before the sheet was even rendered, and the *tests*
caught that one: the throw stretch was symmetric, which elongates a splat equally
both ways and leaves its centre of mass exactly where it started. A splat "thrown
right" was measurably identical to one thrown left. Real spatter is a comet, so
the stretch is forward-only now.

| Measure | First pass | Now |
|---|---|---|
| Centre of mass displaced along the throw | −4.60 px (**backwards**) | **+3.89 px** |
| Shape dissimilarity, closest pair of 30 | 0.11 | **0.24** |
| Shape dissimilarity, median pair | 0.34 | **0.40** |
| Splats clipped by the tile border | 0 / 30 | 0 / 30 |

Dissimilarity is symmetric-difference-over-union, not raw pixel difference. These
masks fill about 11% of their tile, so two entirely unrelated splats differ on
only ~6% of its pixels — asserting on that number makes a healthy generator look
broken and pushes the threshold the wrong way.

### Standing judgement to make at this gate

The droplets now often merge into the main mass rather than staying separate.
That reads as one torn shape, which is right for a heavy hit and arguably wrong
for a light one — the fix, if wanted, is to push the near-in droplets further out
at low `mass`. Worth deciding with the sheet in hand rather than by argument.

### Still to come, in the decal spec

The generator emits coverage and nothing else — no colour, no placement, no
lifetime. Ground decals per chunk, the box projector for props, the unit-staining
recommendation (mask texture vs bone-parented quads vs hybrid), the gore setting
and its off switch, and wiring any of it to a hit all belong to the next spec.

---

## 5d. Decals, and the unit-staining decision

Landed with spec 120: a per-chunk decal field, terrain-fitted ground decals, the
projection rule for props, the gore setting, and blood wired to combat results
through one pure module.

### What the preview caught that the tests did not

`npx tsx scripts/preview-decals.ts` reports the field's own arithmetic, and the
first run said **chunk 0,0: 77 decals, 77 fading out**. The per-chunk cap counted
decals that were *already fading* toward its limit, so under sustained fire every
add marked another survivor and within a few seconds the entire bucket was on its
way out — the ground going clean in the middle of the fight staining it. The cap
now counts only the solid ones; the same spot reports 64 solid and 16 fading.

The test that should have caught it existed and was too weak: it used a four-tick
fade, which is fast enough that the dying decals leave before they can distort
the count. It now uses a sixty-tick fade and asserts the solid count exactly.

### Ground and props

Ground decals are **fitted, not projected**: each is a 4×4 grid whose vertices
sample the real terrain height. That is a few dozen vertices instead of a
projection pass, it needs no depth buffer, and it cannot z-fight — there is no
coplanar surface to fight with, because the decal *is* the surface, lifted along
its normal. A flat quad on this heightfield floats at one end of a slope and is
buried at the other, and on a ridge does both at once.

Props use a box projector with `acceptsProjection`, which rejects faces turned
more than a limit from the spray. Without it a projector paints every face it
passes through, including the ones facing away, and blood appears on the
underside of a rock as though applied from below.

Neither writes depth, which is also what keeps them out of `HikeBuffers` and
therefore un-inked. A bloodstain is a mark on a surface, not a form.

### Units: recommendation

Both approaches were evaluated; **neither is implemented**, because either one
needs a change to the unit shader and, for (a), a render target per stained unit
— a bigger surface than the ground and the props together, and its own spec.

| | (a) UV-space mask texture | (b) Bone-parented quads |
|---|---|---|
| Persistence | Real. Stays through every animation. | Real, but attached to one bone. |
| Deformation | Follows the skin exactly — it *is* the skin's texture. | Slides visibly. A quad on the chest bone stays rigid while the chest bends. |
| Cost | One R8 target per stained unit (64×64 ≈ 4 KB), plus a brush-splat draw per hit. | Nothing but a few quads. |
| Shader change | The unit material samples a second texture and tints. | None. |
| Failure mode at this resolution | The mask is 64×64 over a whole body, so a stain is a handful of texels — coarse, but coarse is the house style. | The slide. It reads as a decal sitting *near* a unit rather than on it. |
| Cleanup | Target returns to a pool on despawn. | Dies with the unit. |

**Recommended: the hybrid, weighted toward (a).** A bone-parented quad at the
moment of impact — one or two ticks, where nothing has time to slide — and a
brush splat painted into the unit's mask texture for the staining that persists.
That gets the impact's punch from the cheap mechanism and the persistence from
the correct one, and neither is asked to do the job it is bad at.

The reason not to take (b) alone, despite it being nearly free: this game's
bodies are animated constantly and the camera is close enough at gameplay zoom to
read the slide. The reason not to take (a) alone is that a mask painted the
instant a blow lands has no *impact* to it — it appears rather than arriving.

Worth knowing before it is scheduled: `unit-rig.ts` finds bones in the **loaded
rig**, never by a name from a skeleton document, because three sanitises
`mixamorig:Hips` to `mixamorigHips`. Whichever half of the hybrid gets built
first inherits that rule.

### Still open

- The gore setting has no UI yet. `WorldScene.setGore` exists and is wired to the
  field; the seventh button in the Play tab's corner is with the other panels.
- `DecalField.dropChunk` is tested and **nothing calls it**, because the client
  still never evicts a chunk. That is the honest state, not an oversight.
- Damage types all currently map to `hit_metal_spark` in `DAMAGE_EFFECTS`. The
  table is the seam; filling it in is the fire/ice/lightning work.

---

## 5e. The library, and the one thing the brief asked for that cannot be built

Spec 121: forty-odd authored effects, the damage-type tables filled in, and the
Play tab's seventh corner button.

### Statuses are not replicated, and auras were meant to hang off them

The brief asks that auras "hook to the existing debuff/status tracking so
applying a status shows its aura automatically." **There is no such tracking on
the client.** `ReplicatedEntity` carries id, kind, typeId, position, facing,
health, maxHealth, activity, activityUntilTick and level. `StatModifier` exists
server-side and never reaches a client; there is no buff or debuff list on the
wire at all.

Putting one there is a protocol change, which this arc rules out as a non-goal.
So the whole aura path is built and tested against a pure `aurasFor(facts)` and
driven by what the client *does* know — a channel in progress, the selected
target, a telegraph. Every status aura is authored and reachable, and
`AuraFacts` already carries a `statuses` field that is empty today. When a status
list is replicated, `aurasFor` gains a branch and nothing else in the renderer
changes.

This is flagged rather than worked around because the alternative — inferring
statuses from health deltas, or having the client keep its own guess — would be
a renderer with an opinion about game state, which is the one thing the whole
split exists to prevent.

### Three builders, forty effects

`fire`, `puff` and `aura` are parameterized because each brief says so. They
return plain config; nothing in them is behaviour.

- **Fire is five layers**, and that is what makes it read as burning rather than
  as a decal of a fire: a flipbook core, embers that leave and keep rising, a
  shimmer, a smoke column that starts *above* the flame, and a ground glow. Tint
  carries down through sub-effects, so blue fire is a parameter and not a second
  definition — asserted by a test that blue and normal fire have identical
  luminance ramps.
- **One puff drives nine effects**, and it works because at this resolution the
  only things separating dust from poison gas are colour, size, rise speed and
  lifetime. There is no detail left to differ in.
- **Auras are ground rings**, which is the whole reason two can be on at once:
  concentric rings read as two things where two body glows read as one muddy
  colour. `auras.test.ts` reads the authored radii out of the library and asserts
  every neighbouring pair is at least two virtual pixels apart at gameplay zoom,
  and that the whole stack fits inside the frame.

### The heat shimmer, and why it is not refraction

A refraction pass samples the frame with an offset. At 300 pixels tall that moves
*whole pixels* around and reads as tearing, not as heat. The stand-in is a few
large, faint, fast-rising dither-cutout quads: they punch a shifting stipple
through what is behind them, which is the impression of disturbed air for the
cost of one more batch of quads.

### One test over the whole table

`library.test.ts` asserts across every effect at once — compiles, emits, positive
lifetimes, a size and alpha that are ever non-zero, sprite sheets that exist with
the right frame counts, information at priority 3, no dangling sub-effects, and
the whole library playable for a hundred ticks without throwing. A new effect
next month gets all of it for free, which is the only way a library this size
stays honest: nobody writes six tests per effect.

It found one thing immediately -- `death_blood/pool` is fully transparent. That
turned out to be deliberate (an invisible carrier that exists to fall and place
the pool decal), so the rule became "visible **or** places a decal", which still
fails an emitter that went transparent by accident.

### The sheet caught the damage-type language failing

The first render of the library sheet showed all seven damage-type flashes as the
same desaturated grey-brown smudge. Each was a single dithered halo running
hot-to-cool over its life, and at that size the dithered falloff is most of the
disc -- so most of what reached the screen was the *faint* outer stipple and the
hue never got a chance to say anything.

That is the whole damage-type language failing quietly: every test passed, and
six of the seven types were indistinguishable in play. A flash is two emitters
now, a small hard-edged core at full alpha in the type's hot colour plus the
dithered halo in its cool one, and the seven read apart at a glance.

### Two mistakes worth recording

**I overwrote `scripts/preview-library.ts`**, which has belonged to spec 112's
Studio unit library since it landed. Caught by reading `CLAUDE.md`'s directory
map, restored from git with nothing lost, and mine is `preview-vfx-library.ts`.

**The library sheet photographed eleven effects after they had finished.** The
first version picked a tick from an id prefix; every flash in the library lives
three or four ticks and was being caught at eight, producing eleven empty tiles
and eleven confident bug reports about effects that were working perfectly. It
now derives candidate ticks from the emitters and *measures* which one holds the
most particles — counting is cheap, only the screenshot is slow.

### Still open

- The gore and intensity settings have their button now. `DecalField.dropChunk`
  is still called by nothing, for the same reason as before.
- Damage types are wired for *impacts*. Nothing yet decides that a given ability
  is fire rather than physical — `CombatFacts.damageType` is supplied as
  `physical` by the Play tab. Deriving it from the ability table is a one-line
  lookup and belongs with whichever spec gives abilities a damage type.
- `puff_footstep` and its terrain-tinted siblings exist and nothing plays them:
  there is no footfall event in the Play tab since `Poofs` was removed. Wiring it
  needs the rig to report a footfall, which the authored-unit machine can do and
  the mech rigs cannot.

---

## 6. Damage-type colour and shape language

Written here so future effects stay coherent. Colours become named `PALETTE`
entries in a shared `vfx/palette.ts`; nothing in an effect definition names a raw
hex.

| Type | Colour ramp | Shape language | Motion |
|---|---|---|---|
| Physical | bone white → warm grey → dust | Chips, wedges, a short directional shockwave ring | Fast out, gravity-bound, settles |
| Fire | hot white → orange → ember red → dark smoke | Round lobed puffs, upward tongues | Rises, turbulent, drags upward |
| Poison | pale sickly green → deep green → murky | Low flat blobs, ground-hugging area | Slow churn, sinks and spreads |
| Ice | near-white → pale cyan → deep blue | Hard-edged shards, straight lines, radial cracks | Sharp burst then near-freeze |
| Lightning | white → pale yellow → violet | Thin jagged polylines, tight bright core | Instant, no gravity, flickers |
| Arcane | pale lilac → magenta → deep violet | Rings, orbiting motes, geometric arcs | Orbital, floats, resists gravity |

Cross-cutting rules:

- **Hot core, cool edge.** Every burst has a near-white centre for one to three
  ticks. At 300 pixels tall that flash is what reads, not the colour ramp behind it.
- **Silhouette over detail.** Few large crisp particles. A particle below ~2
  virtual pixels is invisible after quantization and is pure cost.
- **Direction is information.** Spatter, sparks and shockwaves follow the hit
  vector. A blow from the left throws to the right, always.
- **Critical is louder in the same language**, never a new one: same ramp, larger
  flash, more stragglers, one extra ring. A player should read "that was big"
  without reading a number.
- **Status auras are ground-projected rings**, so two statuses stack as
  concentric rings rather than as overlapping soup. Colour comes from this table.

---

## 7. Non-goals, restated

No changes to gameplay simulation, networking, or combat resolution. No
third-party particle library (none is proposed; if one becomes worth it, it comes
back here with a size and integration cost, and waits). No full-resolution
post-processing stack.
