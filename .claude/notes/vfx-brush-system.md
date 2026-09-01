# The brush-style VFX system (`src/render/iso3d/vfx/`)

Traced for spec-158-style work (painted combat effects). Full detail in the
session that produced this note; this is the API-surface summary.

## Files

| File | Job |
|---|---|
| `vfx/types.ts` | The authored format: `EffectDefinition`, `Emitter`, `EmitterShape`, `Blend`, `RenderMode`, `PlayOptions`, `Priority`. Pure data types. |
| `vfx/brush.ts` | Builders for the "painted" vocabulary: `bloodHit`, `brushExplosion`, `brushCross`, `brushSwing`, `brushShards`, `brushLane`, `brushAffliction`, `brushAfflictionPulse`, `brushShot`, `brushBeam`, `brushFire`. Exports `BRUSH_EFFECTS` (the compiled preset array) plus pure request helpers `bloodHitRequest`/`brushExplosionRequest` -> `SpawnRequest`. |
| `vfx/library.ts` | The other (non-brush) builders: `fire`, `puff`, `aura`, `burst`, `waveEmitters`. Exports `LIBRARY`. |
| `vfx/registry.ts` | `EFFECTS = [SPARK_BOUNCE, HIT_METAL_SPARK, HIT_BLOOD, DEATH_BLOOD, ...LIBRARY, ...BRUSH_EFFECTS]`; `REGISTRY = compileRegistry(EFFECTS)`, built once at module load. |
| `vfx/compile.ts` | Authored format -> flat typed-array-friendly `CompiledEffect`/`CompiledEmitter`. Batches keyed `family:blend:sheet:meshShape`. `danglingSubEffects` catches typo'd sub-effect ids. |
| `vfx/system.ts` | `VfxSystem`: the pure particle sim. `play`, `stop`, `isLive`, `move`, `update(ticks)`, instance pool with priority eviction. |
| `vfx/layer.ts` | `VfxLayer`: the three.js-owning wrapper around `VfxSystem` (batches, ribbons, decals, point lights). `play`, `spawnBloodHit`, `spawnBrushExplosion`, `stop`, `update`. |
| `vfx/palette.ts` | `VFX_PALETTE` (all colour keys), `PaletteKey` type, tint/quantize helpers. |
| `vfx/meshes.ts` | `MeshShape` union incl. brush marks (`brush-slash`, `brush-flick`, `brush-dab`, `brush-blot`, `brush-mark`), `ORIENT` table, `orientOf`, `shadingOf`, `rootShadeOf`. |
| `world/fire-vfx.ts`, `world/shot-vfx.ts`, `world/affliction-vfx.ts`, `world/aura-vfx.ts`, `world/swing-vfx.ts` | Pure drivers (no three.js/DOM) that turn replicated state into `play`/`stop`/`isLive` calls. Three shapes: persistent-attached (fire/shot/affliction/aura: hold a handle, `isLive` every frame, owe a `stop`), one-shot-with-duration (swing: `play`+`has` only, no handle). |

## 1. Builders in `brush.ts`

All are pure functions `(params) => EffectDefinition`. One dominant "brush mark"
gesture + company, never a cloud of identical specks (spec 158/159's correction).

- `bloodHit(params: BloodHitParams)` — a blow's spatter: `primary` (1 dominant
  `brush-slash`), `secondary` (2-5 `brush-flick`), `fragments` (3-8 `brush-dab`).
  Thrown through `{kind:'fan'}` (local +X, biased to middle, lifted off ground).
- `brushExplosion(params: BrushExplosionParams)` — `flash` (additive, 3-6t) +
  4 lobes (`major`/`mid`/`rise`/`ground`, irregular bearings `LOBES = [0.34,
  1.74, 3.06, 4.61]`) + optional `transitional` (debris) + optional `smoke`
  (`brush-blot`, world-orbiting).
- `brushCross(params)` — the order-move mark: two `brush-mark` (ORIENT.ground,
  flat-on-floor) strokes at `CROSS_YAWS`, `fizzle` decay, no company.
- `brushSwing(params)` — a melee sweep: N lobes of marks strung along an arc,
  offset out to the reach, alternating `brush-slash`/`brush-flick`.
- `brushShards(params)` — many small radially-even marks (ice shatter; opposite
  distribution from `brushExplosion`'s lobes). Real gravity (they fall).
- `brushLane(params)` — marks strung along a bearing (a lane) or fanned out
  (a cone, via `cone` param); alternating zigzag nodes.
- `brushAffliction(params: BrushAfflictionParams)` — a **state** (not an
  event): `cling` (world Space:false, rides the body, `brush-blot`, `fizzle`,
  top of ramp `bright->mid`) + `shed` (world space, leaves the body, `mid->deep`).
  `durationTicks: 0`, `hardStop` not set (soft stop = let cling marks finish).
- `brushAfflictionPulse(params)` — one beat/tick of damage: a few marks thrown
  off the body, `retract` decay (it's a flick, not paint drying).
- `brushShot(params: BrushShotParams)` — a projectile's fire: `core` (clings,
  `worldSpace:false`, `brush-blot`) + `licks` (additive flash) + `trail`
  (world-space, left behind, `brush-blot`, grows+fades).
- `brushBeam(params)` — Warden's sustained lance: `spark_n` (off the flanks,
  gravity) + `scorch_n` (`brush-mark` on the ground, `collision` to settle).
- `brushFire(params: BrushFireParams)` — see full excerpt below. A **place**,
  not an event: loops invisibly forever (`durationTicks: 0`), `priority: 1`
  (first to yield), scaled in "fire radii" via `scale`.

Preset instances live in `BRUSH_EFFECTS` (bottom of `brush.ts`): `blood_hit_brush(*)`,
`explosion_brush(*)`, `order_move` is NOT here (that's in `library.ts`), `fire_camp`,
`affliction_*` (7 elements x base/heavy), `shot_ember`, Warden lance id, etc.

### Full example: `brushFire` (the standing-fire builder) — `vfx/brush.ts:2071-2220`

Three emitters (`flame` circle-born `brush-blot` fizzle alpha; `embers` — the
only layer with real gravity, `brush-flick` alpha retract; `smoke` — grows,
never fully opaque, `brush-blot` fizzle). Returns:
```ts
return {
  id: params.id,
  priority: params.priority ?? 1,        // ambient; first to yield under pressure
  cullDistance: params.cullDistance ?? 1100,
  durationTicks: 0,                       // until stopped; driver owes the stop
  emitters,
};
```
Registered once: `brushFire({ id: 'fire_camp' })` (`brush.ts:2494`).

## 2. `library.ts` / registry — how ids resolve

`REGISTRY.byId: Map<string, index>` built by `compileRegistry(EFFECTS)` in
`registry.ts:280`. `EFFECTS` is the concatenation `[hand-authored 4] + LIBRARY
+ BRUSH_EFFECTS`. **Convention: `id` is just a string key** — snake_case for
authored presets (`fire_camp`, `blood_hit_brush`), or `` `${ability.id}.impact` ``
/`.self` for anything driven straight off the server's `EffectMessage` (so
registering an id under the exact string the sim already sends is "the whole
of the wiring" — see `skill.whirlwind.impact` etc., `library.ts:960-1210`).
`system.has(id)` / `registry.byId.has(id)` is how a caller checks before
falling back (`scene.addEffect`'s orange-disc fallback).

**Hard budget**: `REGISTRY.batches.length` must stay `<= 25`
(`library.test.ts:145`) — one batch per distinct `family:blend:sheet:meshShape`.
Reusing an existing `mesh:alpha:brush-blot`/`brush-slash`/`brush-flick`/`brush-dab`
combo costs nothing; a new blend or new mesh shape on a brush mark adds a batch.

## 3. `system.ts` — the play API

```ts
play(id: string, options: PlayOptions): number         // 0 = refused (unknown id / budget / distance)
stop(handle: number, hard = false): void                // soft: emitters off, particles finish; hard/effect.hardStop: kill now
isLive(handle: number): boolean
move(handle, x, y, z): void                              // for a caller driving its own attachment
update(ticks: number): void                              // whole 60Hz ticks only
```
`PlayOptions = { x, y, z, rotation?, attach?, tint?, tintStrength?, scale?, seed }`
— `seed` is **required**, no ambient default. `scale` multiplies emitter local
coordinates and the size curve **only** — never speed/gravity/turbulence/light
radius (world units always). `rotation` is radians about Y, turns the emitter's
local +X ("bearing")/offset.

Handle = `(generation << 12) | (slot + 1)`, 0 means nothing. **Eviction**:
`claimInstance` (system.ts:1016) takes a free slot, or steals the
lowest-priority-then-furthest instance and bumps its generation (making every
old handle to it go stale) — never refuses outright once any slot exists.
Cut-loose particles keep their own copied scale/tint and just finish their
lives (no visual snap). Priority pressure gate: `PRIORITY_PRESSURE = [2,1,0.35,0]`
(system.ts:100) against `pressureFloor` (default 0.25) — priority 3 is never
refused while any pool capacity remains.

Budget constants (`system.ts`): `DEFAULT_LIMITS = { maxParticles: 3000,
maxInstances: 128, pressureFloor: 0.25 }`; `MAX_VFX_LIGHTS = 8` (renderer-side
`LIGHT_POOL = 4` in `layer.ts`); `DEFAULT_RIBBONS = 512`; `MAX_SUB_DEPTH = 2`.

`VfxLayer` (`layer.ts`) is the three.js-owning wrapper apps actually hold:
`play(id, options)`, `spawnBloodHit(input)`, `spawnBrushExplosion(input)`
(convert combat-shaped inputs -> `PlayOptions` via the pure `*Request`
functions in `brush.ts`), `stop(handle, hard?)`, `update(ticks)`. `has`/`isLive`
are NOT re-exposed on `VfxLayer` itself — callers needing them reach
`layer.system.has(id)` / `layer.system.isLive(handle)` (see wiring pattern below).

## 4. `palette.ts` — colour ramps

`VFX_PALETTE` (single flat object, `PaletteKey = keyof typeof`), authored sRGB,
decoded to linear via `unpackLinear`/`paletteInto`. Effects may ONLY reference
keys, never hex — that's the whole "constrained palette" mechanism.

**White/pale already present**: `sparkHot` (0xfff6df), `fireCore` (0xfff3cd),
`dustPale` (0xf2efe4), `dustSnow` (0xf5f5f0), `physicalBone` (0xe8e2d4),
`iceWhite` (0xeaf7ff), `boltWhite`/`boltFlash` (cream/blue-white).

**Brown/dirt already present**: `dustEarth` (0xc8823f), `paintBrown` (0x9a6f52),
`paintSoot` (0x7a5f4c), `paintBurnt` (0x8f3d16, more burnt-orange-brown),
`sparkEmber` (0x8a3418), `corrodeDeep` (0x8a6a2e, rusted olive), `decayDeep`
(0x6e6a52, desaturated olive-brown), `smokeDark` (0x3c3733, neutral grey —
explicitly NOT a good "brown", reads as a hole per the comments).

So there is no single generic `white`/`brown` entry, but the palette already
has usable near-white and dirt/brown ramps for a dust- or mud-style effect;
check whether an existing ramp (`dustPale`->`dustEarth`->`dustStone`, or
`paintBrown`/`paintBurnt`/`paintSoot`) fits before adding new keys. Adding a
key is cheap (just extend `VFX_PALETTE`); the *test* worth checking is
`brush.test.ts`'s ramp-warmth/luma assertions if a new explosion-style ramp is
added (mirrors `EXPLOSION_PALETTE`'s shape).

## 5. Call pattern from `world/` (one-shot at a world position)

Three shapes seen in production:

**a. Direct blast/id passthrough — `world/scene.ts:1651` `addEffect`:**
```ts
addEffect(effectId, x, y, radius, durationTicks, rotation = 0): void {
  if (this.vfx.system.has(effectId)) {
    this.vfx.play(effectId, {
      rotation, x, y: this.ground(x, y) + 2, z: y,
      scale: 1,          // authored effects are drawn at authored size (spec 218)
      seed: (Math.round(x) * 73856093) ^ (Math.round(y) * 19349663),
    });
    return;
  }
  // ...fallback debug ring mesh when the id isn't registered
}
```

**b. Persistent attached driver (fire/shot/affliction/aura pattern) —
`world/fire-vfx.ts` + wiring in `world/scene.ts:1032-1036`:**
```ts
// scene.ts construction:
this.fires = new FireVfx({
  play: (id, options) => this.vfx.play(id, options),
  stop: (handle) => this.vfx.stop(handle),
  has: (id) => this.vfx.system.has(id),
  isLive: (handle) => this.vfx.system.isLive(handle),
});

// fire-vfx.ts driver (pure, no three.js):
private start(id: string, site: FireSite): number {
  if (!this.player.has(id)) return 0;
  return this.player.play(id, {
    x: site.x, y: site.groundY, z: site.z,
    seed: seedFor(Math.round(site.x), site.kind, Math.round(site.z)),
    scale: site.footprint * FIRE_SCALE,
  });
}
// step(sites) every frame: reconcile against isLive; stop() what's no longer present.
```
Three rules stated repeatedly across `fire-vfx.ts`/`shot-vfx.ts`/`affliction-vfx.ts`:
hold a **handle** not an id (`play` returns 0 on refusal); ask **`isLive` every
frame** (pool eviction bumps generation, going stale silently); **the stop is
owed** by whatever despawn/reconciliation sweep already knows the owner is gone
(nothing in the particle system stops itself).

**c. One-shot-with-own-duration, no handle needed (`world/swing-vfx.ts`):**
only needs `play`+`has` — the effect's own `durationTicks`/particle lifetimes
retire it, so there's nothing to hold or stop.

**d. Convenience wrapper for combat-shaped inputs — `vfx/layer.ts:167-174`:**
`VfxLayer.spawnBloodHit(input: BloodHitInput)` / `.spawnBrushExplosion(input)`
call the pure `bloodHitRequest`/`brushExplosionRequest` (`brush.ts`, pure,
tested in Node) to convert `{x,y,z,normal?,incoming?,intensity?,seed}` into a
`SpawnRequest{id,x,y,z,rotation,scale,seed}`, then `system.play`. (Note: as of
this trace these two convenience methods have no production caller in `world/`
yet — only `vfx/brush-scene.ts`'s preview harness uses them; production hit
effects currently go through `vfx-wire.ts` -> `scene.playEffect(request)`,
`scene.ts:1542`.)

## 6. Tests / preview

- `vfx/brush.test.ts` — asserts on `BRUSH_EFFECTS`/`EFFECTS`/`REGISTRY`: every
  brush emitter renders as `mesh` + a `strokeShape`; camera-facing vs
  world-oriented split (`ORIENT.cardVelocity` for slash/flick, `.velocity` for
  dab, `.tumble` for blot); shading amount bounds; no `dither-cutout` on mesh
  emitters; per-effect timing windows (blood 0.25-0.8s, explosion 0.7-1.5s at
  60Hz); composition rules (1 dominant + 2-5 + 3-8, angle fans, velocity-scale
  decay curve); `bloodHitRequest`/`brushExplosionRequest` pure-function
  properties (aim blending, NORMAL_LIFT, heavy-vs-mist selection, radius as
  length not multiplier, preset-by-size not shrink-one).
- `vfx/library.test.ts` — whole-registry sweep: >35 effects, no dup ids, no
  emitter with zero emitters, no dangling sub-effect ids, every emitter visible
  or a decal-placing carrier, sprite sheet/frame-count validity, priority 3 for
  telegraphs, **`REGISTRY.batches.length <= 25`**, the Warden lance id/geometry
  bound check.
- `scripts/preview-brush-vfx.ts` — `npx tsx scripts/preview-brush-vfx.ts`,
  drives `vfx/brush-scene.ts` in a real (headless Chromium) lit scene, no retro
  pass/no palette, writes `.claude/screenshots/brush-blood.png`,
  `brush-explosion.png`, `brush-shot.png` (also covers `shot_ember` in flight
  and `fire_camp`/campfire looping over 2s). Measures: stipple fraction
  (isolated lit pixels), mass concentration (largest connected ink region
  share), asymmetry (explosion centre-of-mass offset), seed variation
  (different-but-same-family across 6 seeds in `SEEDS`).
