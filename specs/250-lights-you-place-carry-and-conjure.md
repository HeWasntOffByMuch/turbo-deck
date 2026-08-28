# 250 — Lights you place, carry and conjure

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

`FIXTURE_LIGHTS` is the authored row per kind — colour, brightness, radius and
the height the flame sits at. Absent `light` is
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
}
```

`PropFieldHandle.lights()` is the union over held regions — so a fixture on
ground the client has forgotten (spec 208, 215) is a fixture that stops being
lit, by construction rather than by a second residency rule.

### C. The pool (`world-lights.ts`)

The performance requirement is the design, and what makes it affordable is one
sentence: **nothing here casts a shadow, and the number of lights never changes.**

three collects lights in `projectObject`, and an invisible light is not collected
— so "add a `PointLight` per fixture in range" changes `NUM_POINT_LIGHTS` as the
player walks, and a shader permutation change is a hitch, not a slowdown.
`castShadow` is in that same program key. So the pool is **fixed**:
`WORLD_LIGHT_POOL` point lights added at construction and never removed, never
hidden, `castShadow = false` written once and never touched. An unassigned slot
sits at intensity 0 with a small radius — a few ALU per fragment at the virtual
resolution the retro pass draws at, which is the price of a constant program.

That is the whole cost. A village lights up for no draw calls at all, and the
probe's draw count is flat across the square (`probe-world-lights.ts`).

Which fixtures get slots is a pure module, `light-residency.ts`, because it is a
decision and not a thing that draws:

```ts
export function assignLights(
  requests: readonly LightRequest[],
  held: readonly (string | null)[],   // what each slot holds now
  focus: { x: number; z: number },
  limits: LightLimits,
): readonly (string | null)[];
```

**Hysteresis is the whole of it.** A slot assignment that flipped between two
fixtures at equal distance would pop a light on and off every frame, which is
the most visible thing in the system driven by the cheapest possible
indecision. So a request is *claimed* within `activateRadius` and *kept* until
past `releaseRadius`, and a held slot is only taken from it by a candidate
nearer by more than `LIGHT_SWAP_MARGIN`. The same shape spec 208 derives its
keep radius with, and for the same reason: the thing that lets go must not fight
the thing that takes hold.

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

**The fire**

- A campfire on drawn ground burns; a lamp post and a torch stand do not, and a
  fixture kind with no `FIXTURE_ART` row is silence rather than a fallback.
- A fire is played at the **ground**, not at the height its light hangs at, and
  sized inside the ring of stones rather than across it.
- Its seed is a function of where it stands, so two clients watching one campfire
  watch the same fire.
- It stops when its fixture leaves the list — which is what a region's ground no
  longer being drawn looks like — and comes back when the ground does.
- The three handle rules hold: a refusal is asked again, an eviction is
  restarted, and a handle that was never got is never stopped.
- The registry still compiles to 25 batches, and one fire on screen is two draw
  calls.

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

## Follow-up, in the same spec

Three things the first pass got wrong, all found by looking at it.

### Fixtures cast, and then they did not

This went both ways, and the round trip is worth keeping because the argument
that lost was correct about the cost and wrong about the thing that mattered.

The first cut had only the campfire casting, on a budget argument that is true
of a *live* shadow map and false of a frozen one: a fixture's cube map rendered
on the frame it is assigned and never again (`shadow.autoUpdate` off,
`needsUpdate` set once) costs a `samplerCube` and one lookup per lit fragment
and **nothing per frame**. Measured in the probe with four of them lit: flat.
So all three were made to cast, on the reading that the question is not "how
many can we draw" but "how many samplers can the shader have".

They cast nothing now, and the reason is not a number. A point light a body's
height off the ground throws every trunk, post and body near it outward in a
hard radial fan, and four fixtures round a square throw four of those across
each other. It reads as a bug in the lighting rather than as evening in a
village, and no amount of it being free makes it look better.

What went with it: the casting prefix on the pool, the cube setup, the
one-bake-per-frame queue, the `revision` stamp that re-took a map when its
ground streamed in late, and the mask that kept moving bodies out of a frozen
one. **Deleted rather than left switched off**, because a socket with nothing
plugged into it is what this repo keeps rediscovering a hundred specs later —
`aurasFor` waited a hundred specs for a caller, `SoundSpec` longer. Putting it
back is one revert of one commit.

The pool is one undifferentiated six now, because the only reason it was split
was that a conjured light could never be allowed into the casting half.

The carried torch and the conjured orb also stop being *hidden* when they are
off. An invisible light is not collected by `projectObject`, so hiding one
changes `NUM_POINT_LIGHTS` — which is a full material recompile the moment
somebody equips a torch, the exact hitch the fixed pool exists to avoid. They sit
at intensity 0 instead.

### A campfire's fire is paint

The cone is gone. What is left of the prop is a ring of stones, four charred logs
and a bed of embers — everything that does not move — and the fire is
`brushFire` in `vfx/brush.ts`, played at the middle of the ring by
`world/fire-vfx.ts`.

A fire is the only prop in this game whose subject moves, so a static solid can
only ever be a picture of one instant of it; and a five-sided cream cone inside a
cloud of brush marks reads as a cone somebody put in a fire.

`brushFire` is three layers: **flames** rising on an updraft and dying young,
**embers** with gravity on them, thrown up and falling back, and **smoke** born
above the flame that drifts, spreads and thins. The embers are the layer the
brief names — an arc is the shape an eye reads as heat coming off something, and
everything else in a fire rises steadily.

The driver is `affliction-vfx.ts`'s, with one thing of its own: a fire stops
because the ground it stands on stopped being drawn, and there is no event for
that, so the whole list is reconciled every frame and an absence is the signal.

**Three of its numbers were measured rather than chosen**, through
`preview-brush-vfx.ts`'s new fire rows:

- the first cut's flames rose ~18 units with 15-unit marks, so the column was one
  mark tall and read as a puddle of fire;
- there was as much smoke as flame, which is `brushShot`'s own finding one effect
  along — against a mid-green field a grey mark is a hole and an orange one is a
  highlight, so equal counts photograph as smoke with a fire somewhere in it;
- the embers were **additive**, which is right for a lick inside a fireball and
  wrong over open grass, where it is a yellow-green speck rather than a warm
  spark. The alpha version reads better *and* reuses a batch the registry
  already has, so the draw-call ceiling moved to 26 and then back to 25.

## What building it found

Four things, and none of them could have been found by reading:

**A lil-gui row cannot bind to `null`, and the editor went black.** The two
light sliders were seeded `null`, meaning "the kind's own row" — a perfectly
good encoding everywhere except in the one object a slider is bound to, and the
default armed structure is a hut, which has no light to seed from. So it was
`null` on every boot: `gui.add` logged `gui.add failed` and returned
`undefined`, the `.name()` on the end of the chain threw, panel construction
stopped where it stood, and the Map editor tab opened to a black screen with a
half-built panel.

It needed no encoding at all. `fixtureOverride` already compares against the
kind's row and writes no override when they are equal, so a number that *is* the
row's is worth nothing in the document — which is exactly what `null` meant. The
fields are plain numbers now, seeded from the first fixture kind.

Two tests, at the level the bug lives at rather than the level it showed up at:
`createEditorSettings()` holds no `null`, no `undefined` and no non-finite number
in **any** field, and the two light fields are the first fixture's numbers. The
general one is the point — the next one will be a different field, and nothing
under `editor/` builds a panel outside a browser, so this class of bug is silent
in Node and fatal in the tab.

Three more that were already wrong:

**three unrolls the point-light loop.** `player-lighting.ts`'s shader patch
declares two locals in the body of that loop, and `#pragma unroll_loop_start`
emits the body once per light *at the same scope*. With one point light — which
is every build of this game since spec 047 — that is one copy and it compiles.
With two it is `'turboToLight' : redefinition`, the player's material never
builds, and three logs a failed compile and carries on, so the symptom is an
unlit player and a completely green suite. The pool made a second light and
`probe-world-lights.ts` found it on its first run. The injection is one block
now, and `player-lights.test.ts` pins both halves: that the loop is still
unrolled, and that what is substituted into it is braced.

**A prop's light did not cross the wire.** `MapChunk` carries props with two
flag bits and no room for anything else, so a fixture's override reached the
client as nothing at all — every fixture in the game would have looked correct
and simply burned at the table's brightness rather than the one somebody set.
Caught by `map-messages.test.ts`'s "reproduces every chunk of the shipped map
exactly", which is a test written for a completely different reason. There is a
`MapPropFlag.Light` now, and two quantized numbers behind it.

**A hand-written document is not a baked one.** The first run of
`light-the-square.ts` wrote raw doubles where every other number in a map
document is `quantize`d, and the wire's `unq` is exact only for what `quantize`
produced — so the shipped map stopped surviving its own round trip. Same test.

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
- **Shadows from fixtures, of any kind.** Tried, measured, and cut for how it
  looked rather than for what it cost — see the follow-up above. Anything that
  brings them back has to answer the radial fan, not the budget.
- **A light budget slider.** The pool is a constant, because the whole point of
  it being fixed is that it cannot change while the game is running.
