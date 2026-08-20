# VFX and particles — plan

Status: **Phases 0–3 landed. Fire and smoke re-authored as solids (spec 123),
auras as drawn sigils (spec 124), impacts as crystals (spec 125), the shockwave
combined and the counts made tunable (spec 126), blood lit and bent (spec 139),
and a painted vocabulary added beside all of it (spec 158), corrected (159) and
given two lingering variants (160), a second way for a mark to end (161) and a
preview that can actually show it (162). Spec 197 put the vocabulary on a
*body*: the seven afflictions, as paint that clings and beats — the last at its
review gate.**

| Phase | State |
|---|---|
| 0 — plan | done |
| 1 — core system (spec 118) | done, 71 tests, lint and typecheck green |
| 2a — sparks + verification + glow comparison | done |
| 2b — blood splat generator (spec 119) | done |
| 2c — decals: ground, props, gore setting, combat wiring (spec 120) | done |
| 2d — the effect library: fire, smoke, auras, hit vocabulary (spec 121) | done |
| 3 — the VFX tab and the stress numbers (spec 122) | done |
| art direction: fire and smoke as solids (spec 123) | done |
| art direction: auras as drawn sigils (spec 124) | done |
| art direction: impacts as crystals (spec 125) | done |
| the shockwave, and tunable counts (spec 126) | done |
| blood: lit stains, and streaks that bend (spec 139) | done |
| art direction: a painted vocabulary (spec 158) | superseded in place by 159 |
| the painted vocabulary, corrected (spec 159) | done |
| two variants that linger (spec 160) | done |
| a mark that comes apart (spec 161) | done |
| the tab could not show what it was editing (spec 162) | done |
| the afflictions, as paint on a body (spec 197) | **at the review gate** |

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

## 5f. The tab, and the acceptance numbers

Spec 122: a sixth tab — effect browser, live parameter panel generated from a
field table, curve and gradient editors, a preview on the game's own path, the
debug readout, and a JSON round trip that makes tuning the authoring.

### The acceptance criteria, answered

| Criterion | Where it stands |
|---|---|
| Adding an effect is config only, no call-site change | Yes. `library.ts` builders return plain config; `vfx-wire.ts` maps events to ids by table. |
| The VFX pass renders inside the low-res buffer | **Measured**: 36,000/36,000 pixels on the palette, 0/36,000 device-pixel blocks non-flat (§5b). |
| 50 combat effects + 200 decals holds framerate | **Measured**: see below. |
| No per-frame allocation in the update loop | **Measured**: ~0.4 bytes per particle per tick against ≥32 for one object each (§5a). |
| Same seed reproduces the same effect | Asserted field-by-field across the whole registry. |
| Disabling VFX leaves gameplay working | Intensity 0 skips the update; gore 0 refuses every decal. |
| Every effect visible in the tab | Yes — the browser lists the registry. |

### The stress number

`node --expose-gc --import tsx scripts/stress-vfx.ts`, CPU simulation only
(particle tick plus decal ageing), sustained by re-playing every 20 ticks:

| Run | particles (mean / peak) | decals held | µs/tick | worst tick | of a 60fps frame |
|---|---|---|---|---|---|
| **50 effects, 200 decals** | **385 / 669** | **382** | **113** | 2,906 | **0.7%** |
| 10 effects, 50 decals | 93 / 159 | 176 | 37 | 1,468 | 0.2% |
| 50 effects, 512 decals | 385 / 669 | 382 | 101 | 1,513 | 0.6% |
| 100 effects, 512 decals | 629 / 1,105 | 419 | 194 | 2,159 | 1.2% |
| 50 effects, 200 decals, intensity 1 | 134 / 252 | 303 | 46 | 1,282 | 0.3% |

Read it with §5a beside it, because the honest caveat is that **fifty combat
effects is not the hard case**. Combat bursts are short-lived by design, so fifty
of them sustain a few hundred live particles; a saturated field of 2,000
continuous particles measured 697 µs/tick (4.2% of a frame) and is the real
ceiling. The stress test passes comfortably and says why rather than claiming the
easy case as the hard one.

Two things the harness got wrong first and now reports honestly: it labelled a
run "200 decals" while holding 382 (the blood those effects throw adds to the
pre-load), and it reported only the final particle count, which understated a
sustained test by four times. The worst-tick column is the re-play spike, not the
steady state.

### The panel is generated, not written

`EMITTER_FIELDS` is a table and the panel is built from it. Forty hand-written
rows is forty chances to forget one, and the failure is silent — a field with no
row is simply not tunable and nobody notices until they go looking. A test
asserts the table covers every key any shipped emitter uses, or that the key is
named in `UNEDITED_KEYS` with a reason, so adding a field to the format fails a
test rather than quietly going missing.

### Curve editing is almost entirely edge cases

Which is why it is a file with tests rather than fifty lines in a mousemove: a
key dragged past its neighbour (re-sort, or `sampleCurve` reads garbage), a key
dragged outside the box, the last key deleted (an empty curve is not
representable — `compileCurve` substitutes a fallback, so the delete would
silently reset the field), and a click near two keys at once (nearest, not first,
or one of them is undraggable and the other moves when you grab either).

### An edit rebuilds the layer, once per frame

A compiled emitter is frozen and the system holds its table by reference, so an
edit cannot be poked into a running system — and should not be, since particles
already in the air read their emitter every tick and would change mid-flight. The
layer is rebuilt outright, deferred to the next frame because a slider fires on
every pixel of a drag.

### Still open

- Nothing decides that an ability *is* fire: `CombatFacts.damageType` is supplied
  as `physical` by the Play tab.
- `puff_footstep` and its terrain-tinted siblings are authored and unplayed —
  there is no footfall event since `Poofs` was removed.
- `DecalField.dropChunk` is still called by nothing.
- Statuses are still not replicated (§5e), so the status auras are reachable and
  undriven.
- Export writes JSON to the clipboard and the textarea. Turning that into a
  committed `library.ts` is a person's decision and a git diff, which is the rule
  the map editor already follows.

---

## 5g. Smoke is a solid (spec 123)

The art direction changed after the library was reviewed: sparks were right, and
fire, smoke and the poison cloud were not. The note asked for smoke that behaves
like smoke rather than like particles, poison clouds that are semi-transparent 3D
masses changing shape, and a different direction for fire — with references
showing chunky solid flame tongues, square embers, a dark smoke column and a warm
ground pool.

### All three complaints had one cause

`RenderMode.mesh` was in the format and was a **stub**. `modeCode` mapped it to
`0`, the billboard, and the default branch swallowed it silently. Every emitter
that asked for a solid got a flat camera-facing quad, and no test could see it,
because the whole format round-tripped correctly — the value was accepted, stored,
compiled and then quietly ignored one layer further down.

That is what makes "particles" the word for the result. **A billboard cannot
intersect anything.** Two of them at the same place are two decals stacked up; the
mass a smoke plume reads as comes entirely from solids interpenetrating each
other. No amount of tuning alpha, size or count gets there from quads.

### What was built

- `vfx/meshes.ts`, pure and tested in Node: `blobMesh` (an icosahedron subdivided
  once, then pushed in and out per vertex — 80 faces) and `tongueMesh` (a lathe:
  shoulders low, a pinched waist, a twist and a lean, closing to a single apex).
  Both flat-shaded by splitting vertices per face, which is the house style —
  `flatShading` is on every material in this scene.
- `MeshParticleBatch` in `batches.ts`: one `InstancedBufferGeometry` per (shape,
  blend), per-instance offset, size, rotation, colour, alpha and seed. The vertex
  shader builds a fixed tumble hashed out of the seed, so a hundred blobs are a
  hundred *orientations* of one geometry rather than a hundred draw calls; the
  fragment shader is a wrapped lambert against a fixed light, which is what makes
  a blob read as round instead of as a silhouette.
- `vfx/depth-sort.ts`: alpha-blended solids are drawn back-to-front. Insertion
  sort over preallocated arrays — nearly-sorted frame to frame, so about O(n),
  and it allocates nothing. `WorldScene` and the VFX tab both feed it their real
  camera direction.
- `Emitter.mesh: { shape }` is part of the batch key, editable in the tab, and
  validated on the way in from JSON rather than passed through: an unknown shape
  is the stub failure wearing a different hat.

### One geometry, many orientations

Deliberate, and worth writing down because the alternative looks tempting. A mesh
per particle would be a draw call per particle. At 480×270 a lumpy sphere is
perhaps twenty pixels across, and nobody can tell one sphere seen from a hundred
angles from a hundred different spheres. The variety budget goes on orientation,
which is free.

### What the first sheet showed, and the fix

The solids worked immediately — smoke and dust read as overlapping volumes with
edges. Fire did not: the smoke column swallowed the flame. Thirty-unit blobs, at
a rise of `h * 0.3` and living up to 170 ticks, piled into one grey mass sitting
on top of a twenty-six-unit fire. A column that does not *travel* is not a column.

Smoke now rises at `h * 0.5–0.9` with `h * 0.7` of upward acceleration, lives
70–130 ticks, tops out at `h * 0.78` rather than `h * 1.15`, and peaks at 0.34
alpha instead of 0.42. The flame is the brightest thing in its own effect again.

### Still open

- The aura reference (a runed circle with light shafts and floating diamonds) is
  a different piece of work. Nobody asked for it; it is not built.
- `cloud_poison` is a 140-unit zone made of 39-unit blobs, so on the contact
  sheet the camera is inside it and the tile is a green wall. It is correct at
  gameplay scale and unreadable at sheet scale — the sheet frames every effect
  identically on purpose.
- Sparks, blood, decals and the hit vocabulary are untouched.

---

## 5h. An aura is a sigil (spec 124)

Same review, next verdict: the status auras were a dithered ring stamped twelve
times a second with motes orbiting it, and the particle look was rejected
outright. The reference is a **runed magic circle** — outer band, inner band,
rune marks between them, shafts of light standing on the ring, diamonds floating
above it.

### Three faults, and only one of them was the look

- **A stipple is not a line.** `dither-cutout` on a ground quad dissolves the
  ring's edge into the frame's weave. Correct for a smoke halo; wrong for a drawn
  symbol, which wants the ink definition the rest of the art direction asks for.
- **The ring was a stream.** Re-stamped on a `rate` emitter because size is a
  curve over a particle's own life and that was the only way to make it pulse.
  Two stamps alive at once at slightly different radii is survivable for a
  stipple and reads as a doubled line for a solid.
- **There was no sigil.** A featureless annulus has nothing in it to read.

### What was built

`runeRingMesh` (flat, in the XZ plane: two bands and a ring of marks),
`diamondMesh` (an octahedron, taller than wide) and `shaftMesh` (a spike that
tapers to a point). The sigil is one held particle — burst of one, ten minutes of
life, constant size and alpha, spun by `angularVelocity` — and the shafts and
diamonds are ordinary stamped emitters over it.

**The runes are blocks, not glyphs.** A forty-unit ring is about forty pixels
across at 480×270, which leaves two or three pixels per mark: a letterform is
mush at that size and a bar with a gap beside it is legible. `pixel-font.ts`
reached the same conclusion for text and settled on 5×7.

### Two things this needed from the layer below

- **Orientation became a property of the shape.** The mesh batch had a boolean —
  tumble or yaw-only — and yaw-only adds a per-seed jitter so two flames are not
  one extrusion. A sigil needs a third answer: exactly the angle it was given,
  because a jitter puts the runes somewhere different every stamp. `uOrient` now
  has three values and `meshes.ts` answers for each shape.
- **`EffectDefinition.hardStop`.** `stop(handle)` lets particles finish, which is
  right for a fire trail and catastrophic for a held sigil: a soft stop would
  leave it on the ground for the ten minutes it was given. An effect can now
  insist, and every aura does. There is a test that stops one softly and asserts
  the pool is empty.

### What the sheet changed

`scripts/preview-auras.ts` is new, and it exists because the library sheet frames
every effect identically — right for comparing forty, useless here, since an aura
is a hundred-odd units across where a hit flash is fifteen, so the big ones were
photographed from inside themselves. Two moments each: the sigil nearly alone,
and the steady state.

Three things it caught:

- **Shafts read as traffic cones** at a base radius of 0.09. Halved, and the
  height brought down from 1.15× the radius to 0.85×.
- **Diamonds were specks.** Three world units is two pixels at 480×270 — exactly
  the thing this direction is a move away from. Now 3→7 units, and lifted from
  8 units above the ground to 14 so they float rather than sit in the ring.
- **The thin sigil came out as a dashed ellipse.** `thin` had been implemented as
  half-width bands, and at radius 34 that band is a world unit: the foreshortened
  near and far edges of the ellipse fell under one pixel. `thin` now means fewer
  marks and a lighter ring, not a thinner line.

### Still open

- Nothing drives auras. Statuses are still not replicated (§5e), so this is
  reachable from the Studio tab and from `AuraTracker` and nowhere else.
- The reference also shows a soft glow pooled inside the circle. Left out: at
  this resolution a low-alpha disc under a crisp sigil is mud, and the sigil is
  the thing being read.

---

## 5i. The preview was lying about what it drew

Two reports about the VFX tab's viewport, one of which turned out to be a real
clipping bug rather than a framing one.

### The far plane sat exactly on the origin

`new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 6000)` — hand-picked, and the
camera orbits at a distance of **6000**. So the middle of the scene was precisely
on the far plane and everything past it was clipped: half the ground vanished
behind a hard horizon, the far side of an aura's ring was sliced off, and an
effect that drifted away from the camera simply stopped being drawn. Raising the
camera swept that plane through the scene, which is what "the auras get cut off
on top" was.

It now uses `CAMERA_NEAR`/`CAMERA_FAR` from `view-settings.ts` — the Play tab's
own numbers, which is what this preview claims to be using everywhere else.

### One dummy, standing exactly where the effect plays

An effect spawns at the origin and the dummy stood there too. A capsule is twenty
units across and forty tall, so a hit flash was inside a solid: "sometimes I
can't see the effects". There are three dummies now, none of them at the origin,
at different heights — the first is the attach target and the others are there
for scale.

### `previewFrame`, and what it is honestly for

`vfx-frame.ts` measures an effect by playing it headlessly in a real `VfxSystem`
and reading the extent off the pool, and the preview's box is never tighter than
that. Measured, because a bound derived from the authored numbers has to know
that a `size` of 110 is a *radius* for a sigil lying flat, a *height* for a flame
standing up and a half-width for a billboard — three special cases and a fourth
waiting for the next shape. A bounding **sphere** rather than a box, because the
camera orbits and a box that fits head-on does not fit from above.

Being straight about it: this is not what fixed the report. The tightest zoom the
panel offers is a half-width of 200 and the widest aura needs about 127, so
nothing in the library was ever cropped by the frustum. What it does buy is the
camera aiming at the effect's own middle instead of a fixed height — a campfire
was previously pointed at knee level — and a guarantee for the next effect that
is bigger than anything here.

### The check, and which half of it can fail

`scripts/preview-vfx-frame.ts` photographs the tab at three cameras. Putting the
old `6000` back makes all three frames fail on "sky in the top corner", so that
one has teeth. The top-edge check has never been seen to fire, and the script
says so rather than implying otherwise. A third check — "the ring is closed" —
was written, found to pass on the very bug it was for (the telegraph's ten shafts
put enough ink above the ring's middle to hide the clipped half) and deleted.

---

## 5j. An impact is a crystal (spec 125)

The last of the art-direction passes. The hit vocabulary was a dithered halo with
a hard core in it — the right answer for "something landed" at three ticks, and
the wrong answer for *what* landed. The reference is a **crystal**: a bright
faceted star at the middle, a fan of long tapered spikes out of it, rocks thrown
clear, dust at the base.

### The one thing the machinery could not do

Everything in that description is a solid, and specs 123–124 had already built
solids. What was missing is orientation: **a spike must point the way it is
travelling.** The mesh batch could tumble, stand upright or hold an exact angle,
and none of those aims a shard outward from a centre. `ORIENT.velocity` is the
fourth mode; the batch uploads `iVelocity` only for the shapes that use it.

Direction rather than speed, and that distinction is load-bearing: a spike is
thrown hard and stopped by drag inside three or four ticks. Drag *scales* a
velocity and never turns it, so the axis is stable all the way down — but it
shrinks toward zero, which is what the guard in `aimedAt` is for.

### The spikes barely move

What reads as the burst opening is the **size** curve, not travel. Spikes that
actually travelled separated from the core and read as a ring of darts leaving,
where the reference is one object flowering and closing. So: thrown at speed,
stopped by a drag of 14, and grown from a fifth of their reach to full and back.

### The hot centre is baked into the geometry

A colour ramp runs over a particle's *life*, which makes every spike in a fan the
same colour at the same moment. The reference is yellow-white where the spikes
converge and red at their tips — a gradient along the **shape**. So the mesh
shader brightens by distance from the shape's own origin, for the shard and the
star alike, since both are authored radiating out of it. One uniform, and it is
most of why the crystal reads.

### One builder, every impact

`burst({ id, scale, hot, warm, cool, spikes, chunks, spread, flat, dust, glow,
light })`. `explosion_large`, `_small`, `_directed` (a jet) and `_ground` (flat
along the floor) are new; **every `hit_<type>`, `impact_flash` and `hit_critical`
is now the same crystal, small** — the ids did not change, so no call site did
either. A hit is not a different vocabulary from an explosion; it is the quiet
end of one.

### The contact point

Hits played at the target's own position, which is *inside* the target — twenty
units of capsule in front of it, so a small burst could be invisible from the near
side. `effectsForBlow` now steps back along the incoming blow by a body radius
and lifts to chest height. A blow lands on a face, not in a torso.

### What the sheet changed

`scripts/preview-bursts.ts` frames each burst by `previewFrame` — the same
measurement the Studio viewport uses — and photographs three moments: the crystal
flowering, its full reach, and what is left after it has gone. Two rounds of
tuning came out of it:

- **The spikes were broad triangles**, not needles. The shard's waist went from
  0.11 to 0.06 and its counts up by half.
- **The dust ate the explosion.** Six ticks after the bang, `explosion_large` was
  a white boulder with an orange star somewhere inside it. Dust is now a third
  smaller, a third fainter, greyer, and rises a quarter as fast — it sits under
  the crystal instead of replacing it.

### Still open

- Scorch decals. Blood owns the decal field (spec 120) and a burn wants its own
  splat profile, so a burst leaves a fading warm pool instead of a mark. Worth
  building when something actually calls `explosion_*`.
- Nothing plays the explosions yet: no ability names one. They are reachable from
  the Studio VFX tab and from a `play()` call that does not exist.

---

## 5k. The shockwave, and the one knob the tool would not turn (spec 126)

### The panel refused to change how many

`EMITTER_FIELDS` generates the whole parameter panel from a table, and `emission`
was in `UNEDITED_KEYS` — declared deliberately unedited, with a real reason: it is
a tagged union whose shape changes with its kind. The consequence was that the
number a person reaches for *first* while tuning, how many particles, was the one
number the tool would not move. Everything else had a slider.

It is five rows now: `emission.kind`, `count`, `perSecond`, `delayTicks`,
`overTicks`. A row that does not apply to the current kind is inert rather than
hidden — the panel is generated from a flat table, and a conditional row is a
second mechanism bought for one saved click. The edit round-trips through the
JSON export, which is the point of the whole tab.

**No global "more particles" multiplier.** The budget already scales counts
*down* under pressure (`INTENSITY_SCALE`), and a second global scaling them up
would fight it. Density is per-effect config, which is the rule the arc is built
on. The shipped bursts also got roughly half again as many spikes, shards, chunks
and dust — they were authored against a budget that turned out to have room.

### The shockwave is the combined thing

`shockwave_ring` was a single dithered ground quad that grew. The reference is a
crystal, streaks laid flat along the ground, a crater of scattered rock **and** a
bright wavefront outrunning all of it. Spec 125 had built four of those five, so
this is `burst({ flat: true, ring: true })` in frost colours — one more mesh
(`ringMesh`, a plain flat annulus, deliberately not `rune-ring`: that one is a
symbol, this is an edge) and two instances of it, a leading edge and a fainter
half-step behind.

Two things the sheet caught:

- **A wavefront must not fade toward the ramp's dark end.** The halo ran
  `warm → cool`, and on frost colours `cool` is a deep navy: additive or not, a
  thinning ring that *saturates* as it dims left a dark hoop lying on the ground
  after the effect was over, which reads as broken rather than as fading. It ends
  on `warm` now.
- **The warm pool is a scorch, and frost does not scorch.** `glow` in ice colours
  is a dark blue stain under the wave. The shockwave turns it off.

### And then the wave got a second job (spec 127)

A right-click on the ground used to park a gold octahedron there for the whole
walk. It answered "did my click land" in the first quarter second and was
scenery for the rest, and it was the only thing on screen that was a *symbol*
rather than something that happened.

So the wave pair moved out of `burst` into `waveEmitters(scale, hot, warm)` and
`order_move` is that pair on its own — no crystal, no rock, nothing thrown,
because an order throws nothing. Priority 3 like a telegraph: two particles cost
nothing, and a click whose answer was dropped under budget pressure reads as a
click that missed.

What the screenshots settled: **a wavefront has a smallest legible size**, and
this one is deliberately under it. The ring mesh is a fixed fraction of its own
radius thick, so below about a 30-unit peak radius it goes sub-pixel at the
virtual resolution and arrives as a scatter of lit pixels opening outward
instead of a closed ring. `order_move` peaks at 15. That is the call: the cue is
read as a flash at a position rather than as a shape, and a *legible ring* at
the destination is most of what was wrong with the marker it replaced. Worth
knowing before anyone reaches for this scale on an effect that is meant to be
looked at.

---

## 5l. Blood takes the light, and a streak bends (spec 139)

Two complaints from watching a fight, and `death_blood` showed both worst
because it is the loud one. **The stains ignore every shadow they lie in**, and
**the blood in the air is straight pipes**.

### The stain was never in the lit pipeline at all

Not a bias problem, not a z-fight: `DecalView`'s fragment shader ended
`gl_FragColor = vec4(vTint, 1.0)`. A constant. The ground beneath it is a
`MeshLambertMaterial` that takes the sun, the ambient, the day/night ramp and the
shadow map, so a stain in the shade of a cliff was drawn at full daylight over
ground that was not -- and the deeper the shadow, the more it read as a sticker
laid over the world.

It is a patched `MeshLambertMaterial` now, spliced the way
`patchTerrainCurvature` splices: the atlas coverage and the ordered fade become
discards *before* the lighting, and the per-vertex tint replaces `diffuseColor`,
so the sun multiplies the blood rather than being pasted over it. Being lit by
the same material three.js lights the terrain with is what makes the agreement
structural rather than two shaders that were tuned to match once.
`transparent: true` and `depthWrite: false` are untouched, which is what keeps
decals out of `HikeBuffers` and therefore un-inked.

One thing that had to come with it: **normals**, from the decal's own grid by
central difference. A lit surface with no normals is a black one, and lighting
the whole patch by the `Decal`'s single stored normal -- the one the drop landed
on -- would light fifty world units of bending terrain as though it were flat,
which is the same "sticker" read one step further in.

### The ribbon mode had never drawn anything

`RENDER.ribbon` compiles, `familyOf` gives it a batch of its own, and the sim has
been claiming a trail track per particle and pushing distance-gated samples into
it every tick since spec 118. Then `modeCode` fell through its `default` and
returned `0`, the billboard. **This is exactly the stub spec 123 found in
`RenderMode.mesh`**, with the same symptom: the value is accepted, stored,
compiled and ignored one layer below, and the whole round trip is green. Two of
these in one system is a pattern rather than an accident -- a `default:` arm in a
mode switch is where a feature goes to be quietly not implemented.

A blood drop is now a chain of quads through its own recorded flight, tapering
from the head to the tail. The arithmetic is `vfx/ribbon.ts`, pure and tested in
Node; the shader gets one new `iMode` branch and **no new attribute** -- a segment
re-uses the row the batch already uploads, with `iVelocity` carrying the segment
vector and `iSize`/`iStretch` the widths at its two ends.

Why that beats a longer or thinner `stretched` quad: a quad is straight by
construction. `death_blood/spray` was `4 * (1 + 340 * 0.05)` = 72 world units of
rigid bar -- longer than a player is tall, hard-ended at both ends, and at full
length on the tick it was born. Over the fifth of a second it is airborne, a drop
falls about twenty units clear of the line it left on. That curve *is* the shape.

### Three things only the browser could say

`npx tsx scripts/preview-blood.ts` -> `.claude/screenshots/blood.png`. A lit
scene, a wall throwing a real shadow across it, and stains **twinned** across the
shadow's edge: same seed, same size, one in and one out, so the comparison is one
splat against itself rather than two splats against each other.

1. **The shadow is real and survives the frame's quantizer.** A stain in shade
   measures 0.69 of its twin in sun, on identical pixel counts (544/544,
   704/704, 1268/1268 -- the equal counts are the check that the two really are
   the same splat). Reverting `decal-view.ts` to the flat material makes every
   pair 1.00 and the script fails.
2. **The first taper was sub-pixel, and beaded.** Tapering to `0.1` of a
   four-unit head is 0.4 world units, against about 0.84 world units per virtual
   pixel at the Play tab's default zoom. The rasteriser caught it in some places
   and missed it in others: the streaks came out as dashed lines -- which would
   also have crawled frame to frame. There is a floor of one world unit on the
   tail now, and the authored tapers are 0.35-0.4. This is invisible to every
   headless test, and it is the whole reason the picture is taken.
3. **The head link is a zero-length quad** on the tick the distance gate fires,
   because the newest sample *is* the particle then. Dropped -- it saves an
   instance per drop per frame and the streak still reaches the drop.

### Two things fixed on the way past

- `window.vfxProbe.shot` took `(id, ticks)` and forwarded them to a method taking
  `(id, ticks, halfHeight)`. So `preview-bursts.ts` measured a frame for every
  burst and every tile was photographed in the default box anyway.
- `fieldGroups()` split `EMITTER_FIELDS` at literal row numbers that had drifted
  as the table grew: "Motion" began at `emission.delayTicks` and ended in the
  middle of the accelerations. The coverage test could not see it, because four
  wrong-but-contiguous cuts partition the table perfectly. It splits at the name
  each section starts with now.

### Still open

- Blood on *units* is still the hybrid recommendation of section 5d and still
  unbuilt: it needs a change to the unit shader.
- Every other `stretched` emitter is untouched. A spark is a chip of light going
  in a straight line over a short life, and it reads correctly.
- The trail is bounded by `RIBBON_SAMPLES` (12) rather than by an authored
  length, so a fast drop's streak is as long as twelve ticks of its own flight --
  about 68 units at the top speed `death_blood` throws. If that ever wants
  bounding per emitter, the cap belongs beside `ribbonSpacing`.

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


---

## 7. The painted vocabulary (spec 158)

The library up to spec 139 could say exactly one thing about a shape: which of
nine convex lumps it was. That was the right call for fire and smoke — §3 argues
it at length, and the argument still holds — and it is also the whole of what the
format could express. A *brush mark* has none of the properties a lump has: its
identity is its outline, no two of a handful may match, and a batch of identical
ones is the failure rather than the saving.

So this is an addition rather than a replacement. Nothing authored before it
moved.

### What it brings

| Piece | Where | What it is for |
|---|---|---|
| the stroke generator | `vfx/stroke.ts` | a spine, a width sampled along it, independent noise per edge |
| the per-instance layer | `vfx/batches.ts`, under `VFX_STROKE` | one geometry, a hundred silhouettes, no CPU cost |
| two card orientations | `vfx/meshes.ts` `ORIENT.card` / `cardVelocity` | a flat mark that reads from every bearing |
| the mesh dissolve | `vfx/batches.ts` | `dither-cutout` reaching solids, ten specs after it was accepted for them |
| the `fan` emitter shape | `vfx/shapes.ts` | "away from the attacker, and a bit upward", which nothing could say |
| the two effects | `vfx/brush.ts` | `blood_hit_brush{,_heavy}`, `explosion_brush{_small,,_large}` |
| the spawn API | `VfxLayer.spawnBloodHit` / `.spawnBrushExplosion` | a point, a surface, a bearing, an intensity |

### The decision worth restating

**The variation is in the shader, not in the mesh.** `meshes.ts` says a hundred
distinct lumpy spheres would be a hundred draw calls, and it is right; the way
out is that a stroke splits cleanly into a *spine* and a *width along it*, so the
geometry can carry one canonical mark and the vertex shader can re-derive the
outline per instance from `iSeed`. Five things move — how fat, where it swells,
where the tip gives out, how long, and which way it curls — and the whole
painted vocabulary costs five batches and nothing per frame.

The second decision is the one a reviewer should push on: **these are camera
cards.** A brush mark is flat, and free tumbling would make a third of every
spatter vanish depending on where the player left the camera. The marks are
still positioned, thrown and depth-tested in three dimensions; only their plane
is the screen's. `cardVelocity` foreshortens by the component of the throw that
lies across the view, so a mark aimed at the camera reads as a dab rather than
as a full-length streak pointing nowhere — the same complaint §139 made about
`stretched` blood, and it was made again here by the first version of this.

### Cost

Five new batches, so `REGISTRY.batches` moved from 20 to 25 (a ceiling on what
*could* be drawn; a painted hit is three calls and a painted explosion is four).
A hit is 14 marks and an explosion 27–43. Nothing is rebuilt per frame and
nothing is allocated per spawn.

### What 159 changed, and why

Spec 158's first cut is worth keeping on the record because four of its five
faults were *technique* choices rather than tuning, and each one has a general
lesson in it.

| Fault | Cause | Lesson |
|---|---|---|
| checkerboards, halftone fills, one-pixel fragments | `dither-cutout` on every painted emitter | ordered dithering is screen-door transparency; it is a pixel-art technique and cannot be borrowed for a painterly look |
| "the silhouettes are pixelated" | the preview drove `vfx-probe.html`, which is 240×150 upscaled 4× with `image-rendering: pixelated` | a rig built to prove one thing will report that thing about everything; judging art needs its own rig |
| a fan of twelve marks reading as one mark twelve times | one baked outline per shape | for a *lump*, one mesh is enough; for a mark whose identity is its outline, it is not |
| the blast was a radial star | a `cone`, which samples directions uniformly | asymmetry cannot be sampled, only composed |
| the effects read flat | both orientations pinned every piece to the view plane | the hybrid: what carries the composition faces the camera, the small pieces do not |

The structural additions were a **bank** of independently generated gestures
merged into one geometry (clipped per instance, still one draw call), a
**crest** vertex per node so a mark is a shell rather than a plane and can
therefore be turned in world space, an **`iAge`** attribute so the *shape*
extends and erodes instead of the transform scaling, and a **`bearing`** on the
`fan` shape so an explosion is four lobes rather than one spray.

### The picture

`npx tsx scripts/preview-brush-vfx.ts` drives `brush-scene.html` -- full
resolution, MSAA, no retro pass -- and writes `brush-blood.png` and
`brush-explosion.png`, four rows of six each. It measures what a contact sheet
cannot say: that the stroke shader compiles at all, that isolated pixels stay
under 20% of ink (a dither fill is ~50%; these run 0.2--0.8%), that the ink
survives six camera bearings, that six seeds differ and differ by similar
amounts, and that the blast's ink does not sit on its own origin.

`brush-scene.html` on its own is the thing to open when judging in motion: a lit
low-poly scene with a dummy, an orbiting camera, blood from any bearing,
explosions at three sizes, twenty seeds at a click, slow motion to 0.04x, pause
and single-step.

### One property worth knowing about the whole system

These particle shaders write `gl_FragColor` themselves and include no
`colorspace_fragment` chunk, so the **linear** value `palette.ts` decodes to is
what reaches the framebuffer -- there is no encode on the way out. Every colour
in the table is affected and the bright ones never notice; a brown authored at
0x63402c arrives as near-black. 159 is the first spec to need dark colours and
therefore the first to pay for it, and the browns are authored much lighter than
they look for that reason.


---

## 8. The variants (spec 160)

Two, and they are the same request in different material: something that
outstays the thing that made it.

| Preset | What it is |
|---|---|
| `explosion_brush_smoulder` | smoke on tick 3, while the major strokes are still arriving, living four to six times as long as any of them over a fire cut to half its usual life |
| `blood_hit_brush_mist` | a spatter that never lands: no gravity at all, a gentle lift, turbulence pulling the pieces apart, and an ending that thins instead of drying |

Both are parameter calls on the existing builders -- no new geometry, no new
shapes, no new orientation. That was the point of the builders, and it is the
first time the claim has been tested by something that wanted genuinely
different behaviour rather than different numbers.

Six parameters had to be added to make them sayable, and two of them are worth
naming here because they are general:

- **the explosion's two halves had one clock.** `lifetimeTicks` drove the fire
  and the smoke together and the smoke's delay was a literal inside the builder,
  so they could not move in opposite directions -- which is the whole of what a
  smoulder is. `smokeDelayTicks` and `smokeLifeTicks` split them; `lifetimeTicks`
  now governs the fire alone.
- **`linger`, and the finding behind it.** Shrinking a mark and fading it early
  does nothing if the mark is already dead. The three blood layers are authored
  to die in order -- flick, then medium marks, then dabs -- which is right for a
  hit, where the gesture lands and the debris outlives it, and wrong for a
  fizzle, where the fizzling *is* the effect. The first cut of the mist was over
  before anybody could watch it go.

Both sit outside the duration windows spec 158 wrote down, deliberately, and the
two tests that assert those windows now name the exemption rather than widening.


---

## 9. Two ways a mark can end (spec 161)

Spec 159 gave every brush mark one ending -- retract it from its own root -- and
called that a virtue, because the flecks past the tip are then the last thing
left and a flick reads as having finished. That is true at the speed a hit runs
at, and it stops being true the moment a mark is held.

Slowed to a second, retract is the brush retracing its own path backwards: the
mark is drawn out from its root and taken back in at its root, which is the
animation in reverse. Spec 160's mist inherited it and dissipated by
**un-painting itself**. Shrinking and fading on top only made it fainter while
it rewound.

So `strokeDecay` is now a field on the emitter with two values:

| | what it does | who wants it |
|---|---|---|
| `retract` | an eroding threshold walks from the root, pulling the spine after it | a hit: it is over in a third of a second and reads as finishing |
| `fizzle` | the spine is untouched; a field varying *along* the mark opens gaps through it, and it comes apart into islands that shrink where they stand | anything held long enough to be watched |

Two notes worth carrying forward.

**The smoke had the fault worse, and nobody had reported it.** A cloud lobe is a
lens with no root the eye can point at, so retract does not read as finishing --
it reads as the mass being eaten from one side -- and the smoke is the
longest-lived mark in the library by a distance. Every explosion's smoke fizzles
now, and it separates into clumps as it clears, which is what the original brief
asked smoke to do and what it had never quite done.

**The frequency of the break-up field is an art decision, not a detail.** About
one and a half cycles over the mark's length gives two or three islands. A high
one takes it apart into a dotted line, which is the stipple spec 159 exists
without -- the same failure arriving through a different door.


---

## 10. The tab could not show what it was editing (spec 162)

`Ends by` was reported as doing nothing in the VFX tab. The wiring was correct
end to end and every existing check was green; three separate things were wrong
and none of them was the wiring.

**The preview never zoomed in.** `resize()` framed with
`Math.max(cameraSpan, fit.span)`, and `cameraSpan` is the cog's world zoom --
640 units, because that is the *Play tab's*. Every effect smaller than the game's
zoom was drawn at the game's zoom, so a blood hit covered about **1% of the
canvas**. A field that changes the last third of a mark's life then moves a few
dozen pixels. The cog is a ratio on the measured frame now.

**The ending was partly applied at birth.** Both decays tested
`smoothstep(0, band, x - leaving)`, which at `leaving = 0` is already under 1
wherever `x` is under the band -- so retract pinched the first 9% of every mark
from its first frame and fizzle was permanently *full of* holes rather than
coming apart into them. Both sweep from `-band` now.

**And the fizzle had no room.** It shared retract's window, so it finished at the
same moment the alpha fade reached zero. It has its own now, and the mist stopped
racing it with alpha.

### The gap this closed

The VFX tab had **no browser check on its editing path at all** -- `preview-studio`
proves it mounts, `vfx-panels.test.ts` proves the table partitions and the JSON
round-trips, and between them a row can be missing or wired to nothing forever.
`scripts/probe-vfx-studio.ts` drives the real controls under a virtual clock and
asserts an edit reaches the definition *and* the pixels, with a control edit
beside it so a broken harness cannot pass as a broken product.

Its measure is **piece count**, not pixel churn, and that is the transferable
part: a broken stroke and an intact one overlap everywhere except the gap, so the
obvious measurement is small when the read is completely different. Gating on it
would have got the shader retuned to satisfy a number rather than the picture.

---

## 11. The afflictions, as paint on a body (spec 197)

The painted vocabulary had three builders and all three were *events*: a hit, a
blast, a placed cross. Nothing in it held to a body, and nothing in it lasted
longer than a second and a bit. Spec 190 had meanwhile shipped seven afflictions
— the one damage in this game that stays on a body after the thing that did it
has walked away — and the only thing separating four seconds of fire from ten
seconds of rot was which thirteen-pixel glyph sat in a row of glyphs over the
head.

### Three sockets, each with a comment naming this work

Worth recording together, because the pattern is the finding rather than any one
of them:

- `world/auras.ts` has said since spec 121 that *"the day a status list is
  replicated, `aurasFor` gains a branch and nothing else in the renderer
  changes."* Spec 186 replicated it. `aurasFor` and `AuraTracker` still had no
  caller outside their own test — seventy-five specs of written, tested,
  mounted-nowhere code.
- `EmitterShape`'s `{ kind: 'mesh' }` is documented as *"the surface of whatever
  the effect is attached to … which is what makes a **burning-unit** definition
  safe to preview in isolation."* There was no burning-unit definition, and
  `scene.ts` supplied no `surface` hook, so in the game that shape had never
  once resolved to anything but a point.
- `scene.ts`'s `attach` hook says *"the effects that need a socket — **a burning
  unit**, a weapon trail — arrive with the fire and slash work."*

### The one decision the whole thing turns on

**The beat is derived, not sent.** `WireStatus` carries an *absolute*
`expiresAtTick` and `data/damage-over-time.ts` is shared code, so the client can
recover the entire schedule:

```
elapsed = tick - (expiresAtTick - dotDurationTicks(row))
landed  = clamp(floor(elapsed / row.intervalTicks), 0, row.pulses)
```

Every client beats together, nothing new crosses the wire, and the paint lands on
the frame the damage number does. That is the whole difference between "there is
a green haze on that thing" and "that thing is being poisoned."

It is a **count** rather than "is this tick a pulse tick", and that is the
load-bearing half. A frame drains several ticks — three at 20fps, and this
environment paints a real page at about five — so a rule that asked whether
`tick` were exactly a multiple would skip most beats and all of them on a slow
frame. Counting what has landed and firing on the increase is frame-rate
independent by construction, and fires **once** for a frame that drained three,
because a beat is a beat and not a quantity.

The stated limit: the sim measures elapsed from `appliedAtTick`, which a refresh
does not move; the client has only the expiry, which a refresh does. So after a
refresh the derived phase can sit up to `intervalTicks - 1` off. The *cadence*
stays exact and the offset is under half a second on every row, so it is accepted
rather than fixed with a protocol change.

### Two layers, and one of them is the whole feature

**The cling** is a state — marks born on the body's own surface, riding it,
renewed about twice a second, `worldSpace: false`. **The shed** is what says
*which* — marks leaving that surface along `rise`, and up-or-down is the cheapest
direction there is: fire lifts, every rot falls, cold barely moves.

There is deliberately no third layer. The hit has three because it is a *gesture*
and needs a dominant mark to carry the bearing. An affliction has no bearing.

### What the vocabulary decided, rather than taste

- **`worldSpace: false` is the whole of "it clings."** The compiled default is
  `true`, and attaching an effect moves only the emission *origin* — so a mark
  born on a walking body and left in world space is one the body walks out of.
  It is a translation and not a rotation, so a stain does not turn with a body
  spinning on the spot; at half a second a mark and twice a second a refresh,
  that is not visible, and paying for it would mean giving every particle a
  frame.
- **The shape choice is the orientation choice.** `brush-blot` is `tumble`
  (world space, where this vocabulary's depth comes from) so the cling turns with
  the body's volume; `brush-slash`/`brush-flick` are `cardVelocity`, always
  camera-facing, so the beat always reads. `brush-mark` is `ground` and is the
  one brush shape that cannot go on a body at all.
- **`fizzle`, never `retract`, for the cling.** Spec 161's rule, and this is the
  case it was written about.
- **`alpha`, nothing additive.** It matters more here than anywhere else in the
  file, because a cling is *many overlapping marks on one body by construction* —
  the one arrangement where a translucent mark is guaranteed to cross another.

### Lengths are in body radii

Every length is a multiple of the effect's own scale, the driver plays with
`scale` set to the body's footprint radius, and the `surface` hook answers in the
same units. `system.ts` multiplies *both* the shape's local coordinates and the
size curve by the instance scale, so one authored definition lands on a spider
and on a player at the right place **and** the right size. Speed and gravity are
not scaled, which is correct: gravity is gravity.

### Two severities, not five

`stacks` rides the wire, and Poison at five must not look like Poison at one. But
the count is already drawn — the mark over the head carries it — so what the paint
owes is *severity*, and two tiers is the honest resolution at three hundred pixels
tall. More paint, never brighter paint: brightness is what the beat says, and one
signal meaning two things is a legend nobody can read. Frostbite crosses on
**elapsed** rather than stacks, because its ramp is that row's whole design.

Burn and Shock get no heavy tier at all. Neither stacks and neither ramps, so
there is no state of a body where either is worse than it already is, and a
louder version would be a picture of something that never happens.

### Why the driver does its own diff instead of using `AuraTracker`

`play` returns **0** on refusal — unknown id, over budget, or beyond
`cullDistance` — and a tracker that records *ids* cannot say "wanted, asked for,
did not start". Committing a refused id leaves a body silently unmarked for the
rest of its life. Holding **handles** makes a refusal mean "not started yet", so
a body that walks into range gets its paint on the frame it does.

The same argument answers eviction, which is the half that had to be *read* for
rather than tripped over. A full instance pool does not refuse: `claimInstance`
takes the lowest-priority, furthest instance, hands the slot over and bumps its
generation, so every handle to it goes stale in place. A cling is priority 1 and
is therefore the first thing evicted -- correctly. A driver that kept believing
its handle would leave that body unpainted permanently, and only in the crowded
fight that caused the pressure. `isLive` is asked each step and a dead handle
means "not started", so the restart happens the moment the pressure lifts.

The obligation that comes with holding one: on despawn **nothing stops itself.**
The attach hook answers false, the instance stays where it last resolved, and a
`durationTicks: 0` effect hangs in the air forever holding one of 128 slots.
Nothing in this game had ever held a persistent attached effect, so `forget` is
the pattern rather than a use of one — and it is called from the sweep that knows
a body has left, never inferred from an absence.

### Two colours the palette did not have

Five of the seven already had a ramp. Corrosion and Decay did not, and both had
to be unmistakable against the neighbour they would otherwise read as: Corrosion
is a *chemical* green pushed hard toward chartreuse against Poison's leaf, and
Decay is the only **desaturated** ramp in the table — it suppresses healing, so it
should look like colour draining rather than colour landing.

### What the sheets said, and what changed because of them

`npx tsx scripts/preview-afflictions-vfx.ts` writes three: one row per
affliction across its life with the beats fired on their real cadence, the four
heavy clings interleaved with their light ones, and three seeds each. It reports
the same four numbers `preview-brush-vfx.ts` already computes, because two
harnesses answering "is this crisp" two ways would be two definitions of crisp.

Three things came out of looking at the first one, and only the first was a
number anybody had predicted.

**The cling was spending its life in the dark end of its own ramp.** With the
gradient running `bright → mid → deep`, the back half of every mark was the
darkest tone the affliction has, which against grass and dirt is mud. It showed
up as Frostbite being far and away the most legible of the seven for a reason
nobody had chosen: its ramp is the only one whose dark end is still light. So
the two layers divide the ramp. The cling is what is *on* the body and lives in
the top two tones; the shed is what is coming *off* it and goes dark on the way
out — which also buys the thing one ramp could not, that the paint on a body and
the paint falling from it are different colours without either needing a new
palette entry.

**There was nowhere near enough of it.** Five to seven live marks reads as flecks
caught on a body rather than as a body that is burning, and it left the light
tiers very close to invisible beside the heavy ones. Roughly doubled: ten to
thirteen live for light, nineteen to thirty-three for heavy.

**Corrosion stopped being pitting.** It was authored as small marks renewed twice
as fast as anything else, on the argument that what it eats through is the guard
and the armour. It came out at a third of Frostbite's ink and was the one row of
the seven you had to look for. Small and fast is *detail*, and this vocabulary's
rule is silhouette over detail at three hundred pixels tall. It keeps the fast
renewal, which is where the sense of something being eaten away comes from, and
the marks are the size of everybody else's.

Where it landed, means over the sampled ticks:

| | marks | ink % | isolated % | biggest piece % | pieces | body % |
|---|---|---|---|---|---|---|
| burn | 12 | 0.71 | 2.3 | 31 | 7.4 | 98 |
| bleed | 10 | 0.42 | 2.9 | 42 | 4.7 | 93 |
| poison | 11 | 0.70 | 2.0 | 31 | 8.5 | 92 |
| corrosion | 12 | 0.72 | 1.7 | 36 | 7.2 | 88 |
| shock | 10 | 0.58 | 2.8 | 45 | 5.8 | 102 |
| frostbite | 13 | 0.80 | 1.9 | 45 | 6.5 | 113 |
| decay | 13 | 0.89 | 1.4 | 40 | 7.0 | 93 |

**Isolated %** is the crispness number and the one worth reading: a dithered or
stippled fill is roughly half isolated pixels and these are between one and
three, all of it boundary. **Biggest piece** and **pieces** say the mass is in a
handful of strokes rather than in confetti. **Body %** is how much of the body's
own height the paint spans, so a sampler that piled everything into the caps
would show up as a number well under a hundred. Severity carries two to five
times the ink of its light tier in every pair.

### And the half no rig can answer

`npx tsx scripts/probe-afflictions.ts` drives the shipped Play tab: a real
server in the tab, the real `?afflict=` path, the real driver, the real particle
system. It exists because everything above is true of a rig, and spec 121's
aura system has a decision function, a tracker, eight authored effects and no
caller *to this day* — a green suite sits beside an unplugged feature perfectly
happily.

It compares each affliction's frame against a control with nothing applied, and
the measurement has to survive a world that moves on its own: the trees sway,
and the control and each affliction are separate page loads whose wind phases
are uncorrelated. So each state is captured twice a beat apart and only pixels
that agreed both times are trusted — `preview-paint.ts`'s trick, and the same
reason it needed it.

