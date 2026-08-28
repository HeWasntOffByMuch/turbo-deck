# 248 — Lights you place, carry and conjure

## Problem

This game has had a complete lighting system since spec 047 and *nothing in the
world uses it*. `player-lights.ts` is pure, tested, documented at length, and its
only caller is the Play tab's **tuning panel**: a torch and a magic orb with
checkboxes on them, following the local player, off by default. Spec 118 then
built `player-lighting.ts` — the shader patch that lights a body from a carried
flame *as though the flame were farther away* — for that same panel. So the
three hardest parts of the feature are already written and reviewed, and the
game itself has no lights in it at all: no lit fixture stands anywhere on
`maps/arena`, no item lights anything, and no spell does.

Three gaps, and they are one feature:

- **Nothing in the world emits light.** A map is heights, materials, props and
  markers; a village at dusk is as bright as a village at noon, because the only
  thing in the frame that is not the sun is a debug checkbox following one body.
- **A torch is not a thing you can hold.** It is a setting.
- **A magic light is not a thing you can cast.** Same.

## Shape

### A. A prop that emits (`src/terrain/`)

Three new `PropKind`s, appended:

```ts
export const FIXTURE_KINDS = ['campfire', 'lamp-post', 'torch-stand'] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];
export function isFixtureKind(kind: PropKind): kind is FixtureKind;

/** What the press-to-place tool offers: buildings and fixtures alike. */
export const PLACED_KINDS = [...STRUCTURE_KINDS, ...FIXTURE_KINDS];
```

They are `PropKind`s and nothing else, which is the whole design — spec 224's
sentence about the hut and the well, one system further along. A fixture is
written into the map document, streamed, collided against, batched per region
and taken out by the eraser without one line of any of those asking what kind a
prop is.

What a fixture adds over a building is two numbers, and they are **optional and
per instance**:

```ts
export interface PropLight {
  /** Illuminance at half `radius`, the unit `pointIntensity` already means. */
  readonly brightness: number;
  /** Reach, world units. */
  readonly radius: number;
}

interface Prop {
  /** Overrides this kind's authored light. Ignored by a kind that has none. */
  readonly light?: PropLight;
}

/** The light a prop emits, resolved: its kind's row, with any override on top. */
export function fixtureLight(prop: Prop): ResolvedLight | null;
```

`FIXTURE_LIGHTS` is the authored row per kind — colour, brightness, radius, the
height the flame sits at, and whether the kind casts shadows. Absent `light` is
that row unchanged, so a fixture placed with the panel's defaults stores nothing
extra and a retune reaches every fixture already on every map.

`MapProp.light` carries it through `parseMap`/`writeMap`/`bakeMap`. Optional, so
no committed map file moves and no `mapId` does.

### B. The fixtures on screen (`src/render/iso3d/props.ts`)

Three `PropPart` lists — a ring of stones round a log fire, a lamp on a wooden
stake, a torch in a stand — appended to `PROP_GROUPS`, which is append-only
because an index into it crosses a thread.

`RegionInstances` gains `lights`, composed on the map worker beside the matrices
it already composes, because the worker is where a prop's ground height is
already being looked up:

```ts
export interface RegionLight {
  readonly key: string;     // region key + index: stable across a rebuild
  readonly x: number; readonly y: number; readonly z: number;
  readonly color: number; readonly brightness: number; readonly radius: number;
  readonly shadow: boolean;
}
```

`PropFieldHandle.lights()` is the union over held regions — so a fixture on
ground the client has forgotten (spec 208, 215) is a fixture that stops being
lit, by construction rather than by a second residency rule.

### C. The pool, and the shadow maps that are built once (`world/world-lights.ts`)

The performance requirement is the design. Two things cost, and they are
different costs with different fixes.

**A varying number of lights recompiles every material in the scene.** three
collects lights in `projectObject`, and an invisible light is not collected — so
"add a `PointLight` per fixture in range" changes `NUM_POINT_LIGHTS` as the
player walks, and a shader permutation change is a hitch, not a slowdown. So the
pool is **fixed**: `WORLD_LIGHT_POOL` point lights added at construction and
never removed, never hidden. An unassigned slot sits at intensity 0 with a small
radius — a few ALU per fragment at the virtual resolution the retro pass draws
at, which is the price of a constant program.

**A shadow-casting point light re-renders the scene six times a frame.** three
already exposes the fix and this scene already drives shadows by hand
(`renderer.shadowMap.autoUpdate = false` since spec 045): a fixture light gets
`shadow.autoUpdate = false`, and `shadow.needsUpdate = true` **exactly once**,
on the frame it is assigned to a fixture. three renders the cube map on the next
shadow pass and clears the flag itself. After that the light costs one texture
lookup and no draw calls, forever.

Three rules fall out of baking rather than rebuilding, and each is a bug the
moment it is skipped:

- **A frozen map must hold nothing that moves.** A body baked into a fixture's
  cube map is a silhouette painted on the ground that stays there after the body
  walks off. So a bake frame masks every body out of point-light shadows with
  the `customDistanceMaterial` stand-in `player-lighting.ts` already uses for the
  player, and unmasks after. The panel torch rebuilds every frame and loses body
  shadows for that one frame, which is one frame of a debug light.
- **The ground under a light can arrive after it.** Terrain and props stream, so
  a map baked over ground that had not landed yet is a light shining on nothing.
  A bake is stamped with the map's `revision` — spec 208's churn counter — and
  re-taken when that has moved. In steady state it never moves.
- **A bake is amortised.** At most one light bakes per frame, so walking into a
  village is three frames each carrying one cube render rather than one frame
  carrying three.

Which fixtures get slots is a pure module, `world/light-residency.ts`, because it
is a decision and not a thing that draws:

```ts
export function assignLights(
  requests: readonly LightRequest[],
  held: readonly (string | null)[],   // what each slot holds now
  focus: { x: number; z: number },
  limits: LightLimits,
): readonly (string | null)[];
```

**Hysteresis is the whole of it.** A slot assignment that flipped between two
fixtures at equal distance would re-bake a cube map every frame — the most
expensive thing in the system, driven by the cheapest possible indecision. So a
request is *claimed* within `activateRadius` and *kept* until past
`releaseRadius`, and a held slot is only taken from it by a candidate nearer by
more than `LIGHT_SWAP_MARGIN`. The same shape spec 208 derives its keep radius
with, and for the same reason: the thing that lets go must not fight the thing
that takes hold.

Shadow-casting slots are a **fixed prefix** of the pool, never a flag toggled per
assignment: `castShadow` is part of the program key too, so a light that
sometimes casts is the recompile the fixed pool exists to prevent.

### D. A torch you can hold (`data/items.ts`, `world/carried-light.ts`)

```ts
{ id: 'torch.hand', name: 'Hand Torch', slot: 'offHand', levelRequirement: 1, ... }
```

An off-hand item and nothing else. It does not burn down, because there is no
fuel system and inventing one to give a light source an expiry is a second
mechanic bolted to a light.

What lights it is a pure resolver, because two things now decide one light:

```ts
export function carriedLights(
  settings: PlayerLightSettings,   // the tuning panel
  facts: CarriedLightFacts,        // equipment, statuses
): ResolvedCarriedLights;
```

**The panel wins where it is asking for something, and the game decides where it
is not.** Every existing panel behaviour is byte-identical — same numbers, same
flicker, same shadows — and a player carrying the item with the panel switched
off gets the *item's* light: warm, flickering, and **casting no shadow at all**.
That last is not a shortcut. A carried light that cast shadows would throw six
cube faces a frame from a source that moves every frame, which is exactly the
cost the fixture half of this spec is built to avoid, and the panel torch is
still there for anyone who wants to look at it.

The player's own body is lit through `player-lighting.ts` unchanged: measured at
`apparentLightDistance` — half the light's own reach, the distance
`pointIntensity` is already defined at — and kept out of point-light shadow maps.
Spec 118 built both; this is the first thing in the game to reach them.

### E. A light you can cast (`data/abilities.ts`, `sim/statuses.ts`)

A sigil, so it arrives the way every other skill does (spec 188):

```ts
StatusId.MagicLight = 'magicLight'            // a boon, wire 17
'skill.conjureLight'  // kind 'self', targeting 'self', skill: true,
                      // cooldown 20s, effects: [{ applyStatus, 60s, on: 'caster' }]
'sigil.witchlight'    // slot: 'skill', activeSkillId: 'skill.conjureLight'
```

**No new sim mechanic.** `applyStatus` is an existing effect verb, `landSelf` has
run `applyEffects` since spec 190, and a status is replicated to every client
because it has a `STATUS_VISUALS` row. So unlike the carried torch — which is
equipment, and equipment is not on the wire — **everybody sees everybody's
conjured light**, and the orb over a remote body is a pool slot like a fixture:
same residency, same hysteresis, and never a shadow caster.

The colour is `PALETTE.magicOrb`, the cool blue spec 047 already burns the magic
light at, against the torch's flame. And it does not flicker: `orbState` is plain
trigonometry where the flame is layered noise, because a conjured thing holding a
steady orbit *should* read as regular.

#### The cooldown that was not a cooldown

A 20-second cooldown does not currently exist and cannot be authored.
`attackTimingFor` sends a non-basic ability's `cooldownTicks` through
`resolveAttackTiming`, which clamps the result to `MAX_ATTACK_INTERVAL_SECONDS`
— a bound on **Base Attack Time**, whose own comment says *"nothing in the
content reaches either bound"*, true of a BAT and false here. CLAUDE.md records
the consequence and nobody has fixed it: **twelve of the fourteen non-basic rows
are over five seconds, so every one of them is really on a five-second
cooldown.** Scorched Earth's authored 24s is 5s.

An attacks-per-second cap applied to a spell cooldown is a category error, so
`resolveAttackTiming` takes its interval bounds as an argument and the non-basic
branch passes cooldown bounds. The floor stays — the factor is a divisor — and
the ceiling becomes one no content reaches.

This is a **balance change to twelve existing rows**, deliberately, and it is the
only way the number this spec is asked for means anything: it restores what
`data/abilities.ts` already says.

## Invariants tested

**Fixtures and the document**

- A fixture round-trips through `writeMap`/`parseMap` with its light, and one
  with no override round-trips to *no* `light` key rather than to the resolved
  defaults — one map, one document.
- `parseProp` refuses a light with a non-finite, negative or absent number
  rather than storing one, and a light on a kind that emits none is inert.
- `fixtureLight` answers null for every non-fixture kind, and for a fixture
  answers its row with the instance override applied.
- Every `FIXTURE_KINDS` entry has a `FOOTPRINT_BASE` row and a `PROP_GROUPS`
  batch, so a placed fixture is collided against and drawn.
- `PROP_GROUPS` order is unchanged for every group that existed before.

**The pool**

- The number of point lights on the scene never changes with what is assigned.
- A slot holding a request keeps it while the request is inside
  `releaseRadius`, whatever else is nearer, unless a candidate is nearer by more
  than the swap margin — asserted as *no reassignment* over a walk that crosses
  the boundary repeatedly, which is the thrash the bake cost is paid on.
- Nothing outside `activateRadius` is ever claimed, and no slot holds a request
  that is no longer offered.
- `assignLights` is a pure function of its arguments: same inputs, same output,
  and the answer does not depend on the order requests arrive in.
- A bake is queued exactly once per (slot, request, revision) and at most one
  per frame.

**Carried and conjured**

- With the panel untouched, `carriedLights` answers exactly what
  `playerLights()` answers today, for every combination of its switches — the
  panel is not changed by this spec.
- Carrying `torch.hand` with the panel off lights the torch, and that light
  casts no shadow.
- A body carrying `StatusId.MagicLight` asks for an orb; the same body one tick
  after expiry asks for none, on the client's own `expiresAtTick` comparison
  rather than on a delta having arrived.
- `skill.conjureLight` applies a 60-second `MagicLight` to its caster and to
  nobody else, and is refused when it is not equipped (spec 188's ownership
  rule) and while on cooldown.
- The cooldown is **20 seconds**, asserted through `attackTimingFor` and not
  through the row — and Scorched Earth's is 24, which is the regression test for
  the clamp.
- Every ability in the table is still granted by something (spec 237's test) and
  every ability on a bar still has an icon.
- `presentation-only.test.ts` still holds: driving the light layer changes no
  authoritative state.

## Out of scope

- **Other players' torches.** Equipment is not replicated — only the local
  player's, which is why spec 165 draws a held weapon for one body — so a remote
  player's carried torch is not lit. The conjured light is, because a status is
  replicated. Replicating equipment is a protocol change and wants its own spec.
- **A torch model.** The carried torch draws the existing flame and a short
  haft at `TORCH_ANCHOR`; a proper held mesh is an `assets/items/` document and
  a `.glb`, which is spec 140's pipeline and not this.
- **Day/night driving fixtures.** They burn at all hours. The cycle is a
  panel setting, and a fixture that read it would be the first thing in the
  world whose appearance depended on one.
- **Light colour in the editor.** A fixture's colour is its kind's; brightness
  and radius are the two the brief names and the two a level designer places
  a lamp with.
- **Fixture shadows from moving props.** A tree sways after the bake and its
  baked shadow does not. That is the price of a frozen map, and at this camera's
  distance it is invisible.
- **A light budget slider.** The pool is a constant, because the whole point of
  it being fixed is that it cannot change while the game is running.
