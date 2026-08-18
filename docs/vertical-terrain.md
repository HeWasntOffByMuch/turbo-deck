# Vertical terrain: floating islands, arches and overhangs

What it would cost to build each of them, measured rather than estimated.
`npx tsx scripts/probe-overhang.ts` is the measurement; every number below comes
from it or from the file it names.

Labelled **Current rule** / **Implemented** / **Future direction** / **Not yet
implemented** throughout, because the risk with a document like this is a
direction reading as a backlog item and getting built as a side effect of
something else.

---

## The one fact everything follows from

**Current rule.** Terrain is a set of **layers**, each a *single-valued*
heightfield: one height per `(x, z)` per layer. `createWorld().heightAt` returns
the **maximum over the solid layers** (`src/terrain/types.ts`).

That rule is what makes the ground cheap to sample, cheap to mesh, cheap to
stream and trivially deterministic, and it is load-bearing in 103 places across
22 files under `src/` alone. It is also the entire reason the three things in this document have
three very different price tags. Sorted by what they need from it:

| | Ground under it | Needs `heightAt` to change | Status |
|---|---|---|---|
| Floating island you only land on | dead space | no | **nearly free** |
| Arch you walk *under* | usable | no, if it is a prop | **cheap** |
| Overhang you walk under **and** over | usable | **yes** | **the expensive one** |

The first two are the same shape as spec 123's rock tiers and need no new
mechanic. The third is a different representation.

---

## What already exists

**Implemented**, and further along than it looks. `maps/arena.json` has exactly
one layer and always has, so most of this is machinery that has run only in
probes — but it has run, and it works.

- **The representation.** `TerrainLayer` carries `bounds`, `baseY`,
  `waterLevel` and a per-cell `solid` mask. Spec 043 wrote the sentence this
  whole document is about: *"a floating island is another layer with a high
  `baseY`, not a second representation."*
- **Authoring.** `src/terrain/rock.ts` (spec 123) bakes a layer into a map;
  `bakeStair` (spec 124) ramps between two; spec 125's detail pass erodes the
  outline and plants props on top. The map editor has a Rock folder that drives
  all three.
- **The wire.** `MapInfo` carries an array of layers, each with its own `baseY`,
  bounds, water level and chunk coords; `MapChunk` is keyed `layer:cx,cz`. The
  probe round-tripped a floating layer and got its heights back byte-exact.
- **The mesher.** `terrain-mesh.ts` iterates `world.layers` and drops a vertical
  skirt wherever a solid cell meets a *definite* hole — with a comment that has
  been waiting since spec 043: *"or (later) a floating island a solid side
  instead of a paper edge."*
- **Bounds.** `worldBoundsOf` unions the layers, so a new layer grows the world
  rather than being clipped by it.
- **Picking.** `WorldScene.screenToWorld` raycasts the **terrain mesh itself**,
  not a ground plane, so a cursor over a floating island already hits the
  island. It then throws the height away and returns `{x, z}`.

So: adding a second layer to the shipped map is authoring work, not engineering
work. What follows is what breaks when you stand under one.

---

## What the probe found

A slab 200 units over the shipped arena, with the real hillside left intact
underneath. Four findings, and **none of them is a defect** — the single-valued
heightfield is behaving exactly as specified. They are the price list.

### 1. The island swallows the ground under it

`heightAt(750, 610)` returns **258.0** — the slab. The hillside at **50.6** is
gone. Max-over-solid-layers has one answer per `(x, z)` and this is it.

### 2. So a floating island is an impassable column, not an overhang

Walking in under the footprint is a **222.3-unit step** against a
`MAX_STEP_HEIGHT` of **24**. `isWalkable` refuses it. The ground below is not
merely swallowed, it is walled off: the island's plan footprint becomes a
cylinder nothing can enter at any height.

This is the same "sealed box" spec 124 found for tiers, one storey up — and a
stair does not solve it, because there is nothing at ground level to ramp *to*.

### 3. The router detours around it, and not for the reason you would guess

The nav cell under the island reads **OPEN** — collision is 2D and there is no
collider there. What refuses the route is `climbable()`, the per-edge height
rule. So the ground under an overhang is not blocked, it is *unreachable*, and
the nav grid holds one `Float32Array` of heights per `(radius, grid shape)` with
nowhere to record a second storey.

### 4. Combat is entirely flat, and this bites even the cheap options

Every distance in the sim is `Math.hypot(dx, dy)` — **20** call sites across
`abilities.ts`, `world.ts`, `movement.ts` and `restoration.ts`, and **not one of
them is the three-argument form**: zero read `z`. A body
on the slab and a body underneath it, 207 units apart in space, measure **4.0
units apart**. They are in melee range of each other through solid rock.

**Not yet implemented, and needed by every option here including the cheapest.**
A floating island with a monster on it is already a monster that can hit you
from above. This is a small change — a Y term and a vertical tolerance on the
range checks — but it is not optional the moment anything leaves the ground.

### 5. A floating island has no underside (read, not measured)

`terrain-mesh.ts` emits a surface, a skirt and water. There is no bottom cap,
and `surfaceMaterial` is default `THREE.FrontSide` while `wallMaterial` is
`DoubleSide`. Looking up at a floating island you would see the inside of its
skirt and straight through where its floor should be. Islands need a cap; tiers
never did, because you cannot get under a tier.

---

## The three options for walking *under* something

### Option A — it is a prop, not terrain

**Future direction, and the recommended way to get arches.**

An arch, a natural bridge, a rock overhang: a mesh whose footprint is its
**legs**, with nothing under its span. Terrain stays single-valued and untouched.

- No determinism risk, no `heightAt` change, no nav change, no wire change.
  Props already stream per chunk, already carry a species and a scale, and
  already become sim obstacles through `vegetationColliders`.
- You walk under it. You cannot stand on top of it.
- Gets the whole *visual* ask — an arch you ride through reads as an arch
  whether or not its span is walkable.

One real constraint, and the codebase already contains its answer.
`vegetationColliders` gives **one circle per prop, centred on the prop**, with
its radius read from a per-kind table (`FOOTPRINT_BASE`). An arch modelled as a
single prop would therefore block a disc through the middle of its own opening —
exactly backwards. A shape wider than one circle is not new here: a fence run
solves it by being *many* props, and the comment on its footprint says why —
*"a fence is thinner than it is long and a circle cannot say so."*

So an arch is authored the way a fence is: the span is one prop with no
footprint, and the legs are the props that block. That needs `PropKind` to gain
an entry (it is a closed union, so `FOOTPRINT_BASE` fails the typecheck until it
does — a good failure), geometry in `props.ts` next to `lobe.ts`'s trees, and a
zero entry in the footprint table. Small, and entirely inside the existing
pattern.

The honest question this option asks is: **do you want to fight on the bridge,
or ride under it?** If the answer is ride under it, stop here.

### Option B — `heightAt` learns who is asking

**Future direction. This is the real feature, and it should get its own spec.**

Replace "the topmost solid surface" with "the surface *this body* is on":

```ts
surfaceUnder(x: number, z: number, fromY: number): number
```

— the highest solid layer whose height is at most `fromY + MAX_STEP_HEIGHT`. A
body's `position.z` is already authoritative state and already replicated as an
`f32`, so the disambiguator exists and costs no wire.

What it forces, in rough order of pain:

1. **Height becomes path-dependent.** "How high is the ground at `(x, z)`" stops
   having an answer. `heightAt` is read **103 times across 22 files** under
   `src/` alone, and each has to say which surface it means: where an arrow lands, where loot falls, where a monster spawns, how
   a ground decal drapes, where the cursor's click resolves.
2. **The nav grid gains a dimension.** One grid per `(radius, layer)`, plus
   explicit transition edges where a ramp joins two layers. `warmNavGrids`
   already builds one grid per radius and that is already ~1s on a real map.
3. **Prediction must pick the same floor.** `prediction.ts:123` currently
   *recomputes* `standingOn.z` from `heightAt` rather than using the body's own
   z. Left alone, client and server would choose different storeys and the
   player would be corrected every tick.
4. **A body can lose its floor.** Walk off an arch and there is no answer,
   because there is no gravity here — `resolveMovement` snaps z to the ground
   every tick and nothing falls. That is a new mechanic, not a fix.
5. **Combat needs finding 4 fixed first**, or the storeys fight each other.

None of this is exotic — it is the standard "which floor am I on" resolution —
but it touches the deterministic core, the wire's consumers, the router and the
renderer at once, which is exactly the shape CLAUDE.md says gets a spec first.

### Option C — volumetric terrain

**Not yet implemented, and recommended against.** Voxels or a signed-distance
field would express caves and spirals honestly, and would invalidate the map
document, the chunk wire format, the mesher, the nav grid, the collision system
and every `heightAt` caller. The layered heightfield was chosen over this in
spec 043 deliberately. Nothing in the three things asked for here needs it: an
arch is not a cave.

---

## Recommended order

1. **Fix the flat range checks** (finding 4). Small, and a prerequisite for
   anything that leaves the ground. Worth doing even alone — it also fixes a
   monster on a tall spec-123 tier reaching a player at its foot.
2. **Ship a floating island you land on.** Authoring plus three things: a cap on
   the underside (finding 5), an explicit decision that its footprint is dead
   ground, and a way up. `bakeStair` *would* reach it — a ramp is just a layer
   with sloping corner heights, and nothing bounds its length — but a ramp
   climbing 200 units from the ground is a ramp that visually tethers the island
   to the ground, which is the one thing a floating island must not be. Anything
   else (a bridge from a clifftop, a lift, a jump) is a new mechanic and should
   be priced as one. This step proves the layer machinery in the shipped map,
   which is the part that has only ever run in probes.
3. **Arches as props** (Option A). Cheap, and it is what "arch" actually means
   most of the time.
4. **Walkable overhangs** (Option B) **only if the game needs to fight on one.**
   Its own spec, and the five costs above stated up front.

The thing to avoid is arriving at Option B by accident — one call site at a time
while building an island — because a half-converted `heightAt` is a world where
some systems agree about which floor you are on and some do not.

---

## The instrument

`npx tsx scripts/probe-overhang.ts` builds the slab and reports all of the
above. Like `probe-rock.ts` it is deliberately **not a test**: a test asserts
what was already decided, and this reports what is true, including the parts
that are broken. Re-run it after any change to `heightAt`, the step rule or the
nav grid — a "BROKE" line turning into an "ok" line is the feature landing.
