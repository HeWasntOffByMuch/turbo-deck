# Unit rig / animation architecture (render side), traced 2026-09-01

Scope: how a replicated entity becomes a posed three.js body in the Play tab.
Three rig kinds (`MechRig` procedural chassis, `CritterRig` procedural animal,
`UnitRig` authored/skinned `.glb`), how `scene.ts` picks one and drives it, and
where a per-frame vertical offset could be injected. Read this before
re-deriving any of it, especially before touching spawn/reveal VFX for a
monster body.

## 1. `src/render/iso3d/rigs.ts` -- `MechRig`

Procedural "alien spider" chassis: N (3-8) multi-joint IK legs + a turret body,
built from primitives (`box`/`cone`/`faceted`), no skinning, no `.glb`.

**Group hierarchy** (constructor, rigs.ts:984-998):
```
MechRig.group (THREE.Group, public readonly)      -- scene sets position + yaw here
 └─ carriage (private, THREE.Group)                -- "lower body": bob/sway/height/roll/pitch spring, NO facing yaw
     └─ turret (private, THREE.Group)               -- "upper body": body meshes (box/plate/head/eye, or sphere), yaws to heading
 (legs' 3 meshes/leg are added directly to `group`, i.e. SIBLINGS of `carriage`, not children of it -- see MechLeg ctor, rigs.ts:222 `group.add(this.coxa, this.femur, this.tibia)`)
```
`orientsWithGroupYaw: boolean` (rigs.ts:925) tells the scene whether to yaw
`group` itself (spider reading, legs turn with the body) or leave it at 0 and
let only the turret turn (Warden's "grey mech" reading, `lowerBodyTurns: false`).

**Public API:**
- `readonly group = new THREE.Group()` (rigs.ts:919)
- `readonly tuning: MechTuning` (rigs.ts:921) -- live-mutable movement/shape numbers (`defaultMechTuning()`, rigs.ts:579)
- `readonly appearance: MechAppearance` (rigs.ts:923) -- `{ shape: 'box'|'sphere', bodyColor, legColor }` (rigs.ts:806-838), live-mutable
- `readonly orientsWithGroupYaw: boolean`
- `constructor(type: string, bodyColorOverride?: number, opts: MechOptions = {})` (rigs.ts:984) -- `MechOptions = { lowerBodyTurns?, tuning?, appearance? }` (rigs.ts:840-857)
- `update(dt: number, worldPos: Vec2, ry: number): void` (rigs.ts:1301) -- **the per-frame pose call**. `worldPos` is sim (x,y) only, no height; the rig has no concept of world Y at all -- see 6.
- `get locomotionState(): LocomotionState` (rigs.ts:1198) -- `'idle'|'walking'|'running'|'turning'|'stopping'`
- `openingWorld(out: THREE.Vector3): boolean` (rigs.ts:1217) -- world position of the head's "opening" (Warden's beam origin, spec 262), false for a body shape with none
- `debugSnapshot(): MechDebug` (rigs.ts:1232) -- every leg's solved joints/rest/trigger radius/flags for the rig-debug overlay

**Leg IK -- yes, genuine per-leg inverse kinematics with world-locked foot
targets** (this is the "STRIDE_LEN" / foot-placement system asked about):
- `STRIDE_LEN = 48` (rigs.ts:458) -- world distance per gait half-cycle, drives `this.phase` (bob phase), NOT a stride *length* used by IK directly.
- `class MechLeg` (rigs.ts:185-399): one leg = coxa (hip yaw segment) + femur + tibia (cone tip = foot), posed by a classic 2-bone IK solve (`pose()`, rigs.ts:276-398) with an up-pointing pole vector so the knee always bows upward.
- `interface LegPlant` (rigs.ts:715-767): the **per-leg ground-lock state** -- `rest {x,z}` (corner offset), `azimuth`/`halfWedge` (angular territory), `world {x,z}` (the logical planted foot, in WORLD coordinates), `y` (lift height, 0 planted), `disp {x,z}`/`dispY` (slew-limited drawn foot), `stepping`/`held`/`cooldown`/`from`/`to`/`t`/`dur`/`arcH` (step-in-progress state).
- Feet are **world-locked**: `stepLegs()` (rigs.ts:1369) decides which feet re-plant (overstretch past a trigger radius, or having left their angular wedge) and `beginStep()` (rigs.ts:1573) computes a fresh world-space plant target led in the travel direction. `LegPlant.world` persists across frames independent of the body's bob/sway.
- Per-frame draw (`stabilise()`, rigs.ts:1685-1789): the **hip** is `_hip.set(hx, HIP_Y*S, hz).applyMatrix4(this.carriage.matrix)` (rigs.ts:1772) -- i.e. carried by the carriage's bob/sway/pitch/roll spring; the **foot** (`_foot`, rigs.ts:1784) is the world-locked plant transformed into the leg's local frame, independent of the carriage. `leg.pose(_hip, _foot, ...)` (rigs.ts:1787) then IK-solves the visible bones between those two points.
- Base proportions at scale 1 (rigs.ts:404-416): `HIP_Y=30`, `HIP_INSET=11`, `REST_X=34`, `REST_Z=42`, `COXA_LEN=12`, `FEMUR_LEN=27`, `TIBIA_LEN=36`, `BODY_Y=40`, `BODY_SIZE=22`, `BODY_RADIUS=13.2` (sphere shape). So in group-local space: feet sit near y=0 (i.e. at world height = whatever the scene set `group.position.y` to), legs reach up to hip height ~30*S, body sits ~40*S and up.
- `numLegs` changes trigger `recreateLegs()` (rigs.ts:1105) which disposes and rebuilds every leg **and replants every foot on its rest spot** (no gradual reveal) -- see 1105-1195, `legJustRecreated` flag forces an instant replant on the next `update()` (rigs.ts:1324-1335).

**No existing spawn/reveal/emerge state.** `MechRig` always draws a complete
body + complete IK-solved legs from the very first `update()` call. There is
no visibility toggle, opacity, or per-part scale for "legs only" vs "body
only", and `carriage`/`turret` are private with no accessors. See 6 for what
would have to be added.

## 2. `src/render/iso3d/critter.ts` -- `CritterRig`

Procedural animal (sheep, cow/player, etc.), built by lofting a species'
declared "hull" primitives onto a shared skeleton (`Humanoid`), NOT skinned
`.glb` geometry.

**Public API** (`class CritterRig implements SandboxUnit`, critter.ts:567):
- `readonly group = new THREE.Group()` (critter.ts:569) -- `this.group.add(this.humanoid.group)` (critter.ts:634)
- `readonly orientsWithGroupYaw = true` (critter.ts:570, always true -- no turret-only reading for a critter)
- `readonly species: CritterSpecies`, `readonly tuning: CritterTuning`, `readonly humanoid: Humanoid`
- `constructor(species, opts: { tuning?, coat? })` (critter.ts:588)
- `update(dt: number, worldPos: Vec2, ry: number): void` (critter.ts:682) -- delegates the walk to `this.humanoid.update(h, gait, this.tuning)` (critter.ts:686), then `poseSockets()` (ears/tail wobble, critter.ts:742) and `poseGraze()` (head-down grazing dip, critter.ts:722)
- `get locomotionState()`, `get coat()`, `get colors()`, `setCoat(coat)`, `jump(): boolean`, `drop(height): boolean` (critter.ts:668-676, see 6)

**How it's posed -- forward kinematics, no IK, no foot targets.** The walk
comes entirely from `Humanoid` (`src/render/iso3d/humanoid.ts`), the same
skeleton driver the robed/cloth character uses. `Humanoid.poseLegs()`
(humanoid.ts:271-301) is a pure sine-driven hip/knee rotation:
```
hip = sin(phase + legOffset) * hipAmp
knee = kneeAmp * (0.12 + 0.88*max(0, cos(phase + legOffset))) + idleBend
thigh.rotation.z = hip; shin.rotation.z = -knee
```
No leg-length IK solve, no world-space foot plant, no per-foot ground lock --
this is the opposite architecture from `MechRig`'s `MechLeg`/`LegPlant`
system. Stride phase advances by distance travelled (`humanoid.ts:250-251`,
`STRIDE_WALK`/`STRIDE_RUN` constants local to that file, unrelated to
`rigs.ts`'s `STRIDE_LEN`).

`Humanoid` (humanoid.ts) DOES have a whole-body vertical offset mechanism --
see 6, `JumpMotion`.

## 3. `appearance.ts` / `monster-look.ts` -- rig selection, and where `scene.ts` builds/updates it

`src/render/iso3d/world/appearance.ts` `appearanceOf(entity)` (line 143-205)
maps a replicated entity's `kind`/`typeId` to an `Appearance` (`rig: 'player'
| 'monster' | 'projectile' | 'prop' | 'drop'`, plus `radius`, `showsHealth`,
etc.) -- it does NOT pick MechRig vs CritterRig vs UnitRig; it only says the
coarse category. Pure, no three.js.

`src/render/iso3d/world/monster-look.ts` `monsterLookFor(typeId)` (line
175-186) answers what a **MechRig** is built *with* for a given type id --
`MechAppearance` (shape/colours) + `MechRigTuning` (a `Partial<MechTuning>`
minus the two sim fields) -- from a small `Map` (`LOOKS`, line 163-166):
`small_spider` -> `SMALL_SPIDER` (line 87-104, sphere body, `sizeScale: 0.6`),
`warden` -> `WARDEN` (line 136-158, `lowerBodyTurns: false`, taller steps,
stiffer chassis). A type id with no row gets `null` -> default box-chassis
MechRig.

`src/render/iso3d/world/monster-critter.ts` `monsterCritterFor(typeId)`
answers whether a monster is drawn as a **CritterRig** instead -- one row
today, `sheep` -> `{ species: 'sheep', figure: { bodyScale: 0.475,
strideScale: 2.15 } }`.

`src/render/iso3d/world/unit-catalog.ts` `authoredUnitFor(look: Appearance)`
answers whether an entity is drawn as an **authored `UnitRig`** -- `Map`
seeded from `DEFAULT_AUTHORED_UNITS`: `player` -> `pig_a_pose_full`,
`npc.merchant`/`npc.quartermaster`/`npc.armourer` -> `fox_a_pose`. Only
`rig === 'monster' | 'player'` is eligible; falls through to `null` (old rig)
if the build has not baked that unit's assets.

**Construction and priority order, in `scene.ts` `bodyFor(id, appearance)`**
(scene.ts:2829-2985): `authoredUnitFor` is tried **first** (line 2840, for
player AND monster), then `rig === 'player'` -> CritterRig cow (line
2892-2912), then `monsterCritterFor` -> CritterRig species (line 2933-2952),
else `monsterLookFor` -> MechRig (line 2953-2973). So the *fallback chain* per
type id is: authored unit (if baked) > CritterRig (if a `monster-critter.ts`
row exists, or it's `player`/`rig==='player'`) > MechRig (default, with an
optional look).

**Per-frame update call sites**, in `scene.ts` `syncBodies()` (scene.ts:2057),
inside the per-entity loop:
```
body.critter?.update(dt, { x, y }, -facing);   // scene.ts:2161
body.mech?.update(dt, { x, y }, -facing);      // scene.ts:2162
if (body.unit) this.driveAuthoredUnit(...);    // scene.ts:2163
```

## 4. Monster roster (`src/server/data/monsters.ts`) x rig kind

Full `AUTHORED` roster: `grazer`, `sheep`, `stalker`, `ravager`,
`small_spider`, `slinger`, `warden`, `npc.merchant`, `npc.quartermaster`,
`npc.armourer` (all via `shopkeeper(id, name)` factory), plus `dummy` (kept
separate from `AUTHORED`, appended in `MONSTERS`).

| typeId | Rig (primary, assets baked) | Fallback if unbaked | Notes |
|---|---|---|---|
| `player` | `UnitRig` (`pig_a_pose_full`) | `CritterRig` species `cow` (`PLAYER_CRITTER`, appearance.ts:120) | only type id whose CritterRig fallback is NOT `monster-critter.ts` -- it's the `rig==='player'` branch in `bodyFor` |
| `npc.merchant` | `UnitRig` (`fox_a_pose`) | `MechRig`, default look (not in `monster-look.ts` or `monster-critter.ts`) | |
| `npc.quartermaster` | `UnitRig` (`fox_a_pose`) | `MechRig`, default look | |
| `npc.armourer` | `UnitRig` (`fox_a_pose`) | `MechRig`, default look | |
| `sheep` | `CritterRig` species `sheep` | -- | via `monster-critter.ts`, not authored |
| `small_spider` | `MechRig`, `SMALL_SPIDER` look (sphere body, small, legColor=bodyColor) | -- | "Small Spider" |
| `warden` | `MechRig`, `WARDEN` look (`lowerBodyTurns: false` -- turret-only turning, the "grey mech"/"walker" reading) | -- | the one monster explicitly NOT reading as a spider (legs world-fixed) |
| `grazer` | `MechRig`, default box-chassis look | -- | no row anywhere -- default "spider" mech |
| `stalker` | `MechRig`, default | -- | ditto |
| `ravager` | `MechRig`, default | -- | ditto |
| `slinger` | `MechRig`, default | -- | ditto |
| `dummy` | `MechRig`, default | -- | ditto |

"Spiders" vs "mechs" in the *design vocabulary* (rigs.ts:786-796 doc comment):
EVERY `MechRig` is architecturally "a living alien spider" by default
(`orientsWithGroupYaw`/`lowerBodyTurns` true => the whole body incl. legs
turns as one). `warden` is the one row that opts into the "grey mech" reading
(`lowerBodyTurns: false`, legs world-fixed, only the turret/head turns) --
that is the literal meaning of "mech" vs "spider" in this codebase. Every
other MechRig-drawn monster (`grazer`/`stalker`/`ravager`/`slinger`/`dummy`,
plus `small_spider` which is additionally sphere-bodied) is the default
spider reading.

## 5. `world/unit-driver.ts` + `unit-rig.ts` -- authored-unit path (player/pig, fox NPCs)

Presentation-only boundary: `unit-driver.ts` is handed a plain `UnitFacts`
snapshot (speed, activity, castPhase, attackRate, abilityId, castTicksLeft,
dead) -- never the `GameClient` -- and returns fired animation events. Cannot
reach gameplay state even in principle (module-graph enforced, `src/render/`
may not be imported the other way).

`driveUnit(machine, facts, previous, ticks)` (unit-driver.ts:239-276):
sets `speed`/`dead` params, calls `machine.revive()` if alive,
`attackTriggerFor(abilityId)` picks `attack`/`shoot`/`cast` trigger by what
the ability's row declares (projectile look / `castLook`), raises the trigger
on the edge into casting (`startedCasting`) or calls `machine.cancelAction()`
on a withdrawal (`cancelledCast`), raises `stagger` on a poise-break edge, then
`machine.step(ticks)`.

`scene.ts` `driveAuthoredUnit(unit, entity, at, frame)` (scene.ts:2575-2630)
is the caller: measures `speed` off the **drawn** position delta on the sim's
tick clock (`advanceSpeed`, spec 118), slews it (`slewSpeed`, spec 119) into
`unit.blendSpeed` for the machine's blend tree, builds the `UnitFacts`,
calls `driveUnit`, then -- rate-limited by an LOD cadence keyed on drawn pixel
size (`mixerCadence`, line 2625-2629) -- calls
`unit.rig.applyPoses(unit.machine.poses())` (line 2629).

`UnitRig` (`src/render/iso3d/unit-rig.ts`) is the three.js half: loads a `.glb`
mesh + per-clip animation-only `.glb`s (`load()`, unit-rig.ts:239-300), strips
root motion by node-chain (never guessed), builds a `THREE.AnimationMixer`
with every clip paused at weight 0. `applyPoses(poses: readonly
PoseSample[])` (unit-rig.ts:375-386) is the actual pose write: zeroes every
action's weight, sets weight+time (`normalizedTime * duration`) for each pose
in the machine's blend, then **`mixer.update(0)`** -- a zero-delta update,
because time is an integer-tick-derived normalized position, not a running
clock (this is what makes a pose a pure function of tick count). `attach()`
(unit-rig.ts:408-427) hangs a weapon off a named socket bone, parented (not
copied) so it rides the pose through three's own graph.

## 6. Per-frame world transform + vertical-offset precedent

**The single place a rig's world position/yaw is applied**, every frame, for
every kind of body (mech/critter/unit alike): `scene.ts` `syncBodies()`
(scene.ts:2057), specifically:
```ts
body.group.position.set(x, ground, y);              // scene.ts:2140
const groupYaw = body.mech?.orientsWithGroupYaw === false ? 0 : -facing;
body.group.rotation.y = groupYaw + flinch.yaw;       // scene.ts:2149-2150
body.group.rotation.z = flinch.pitch;                // scene.ts:2157  (poise-break rock, rotation only)
...
body.group.scale.setScalar(dead && !fallen ? 0.6 : 1); // scene.ts:2183 (death squash, uniform, legs+body together)
```
`ground = this.ground(x, y)` (scene.ts:1187-1189) is `map.world.heightAt(x,
z) ?? 0` -- pure terrain height, no per-entity vertical offset exists here
today. `x`/`y` come from the interpolator (`this.motion.sample`,
`interpolate.ts`) for remote bodies or from prediction for the local player;
the sim itself has **no notion of height** for combat entities (stated
explicitly in `jump.ts`'s doc comment, see below) -- `DrawnPose.z`
(`interpolate.ts:44`) exists only for **projectiles**' ballistic arc height,
read at scene.ts:2166/2173, and is unrelated to ground-standing bodies.

**No existing spawn/reveal/emerge mechanic** for a monster or player body.
The only "spawn" tracking in `scene.ts` is for loot drops (`spawnTick` /
`poppingDrops`, scene.ts:2458/2496-2499), a wholly different rig (`DropRig`)
and system (spec 158's reveal-phase arithmetic in `loot-drop.ts`), not
reusable for MechRig/CritterRig without new plumbing.

**Two existing "temporary visual offset" precedents, neither of which is a
turnkey fit:**

1. `MAX_EASED_OFFSET = 48` (`src/server/client/prediction.ts:171`) --
   `PredictionBuffer.offsetX/offsetY`, the decaying remainder of a server
   correction eased into the *local player's own* drawn ground-plane (X/Y)
   position (`OFFSET_DECAY = 0.82` per tick). Horizontal only, local-player
   only, lives in `src/server/client/` (not `src/render/`), and never fed
   back into prediction -- "presentation, not state," same category as
   `interpolate.ts`. Not a vertical mechanism and not per-arbitrary-body.

2. **`JumpMotion`** (`src/render/iso3d/jump.ts`) -- explicitly documented as
   *"a renderer-side offset applied to the character's root, in the same
   category as the mech's body bob"* (jump.ts:6-10) and *"the combat sim has
   no notion of height... nothing here reads or writes sim state."* Owned by
   `Humanoid` (`readonly jump = new JumpMotion()`, humanoid.ts:145) and
   applied every frame as `this.group.position.y = this.jump.y`
   (humanoid.ts:362) -- i.e. it offsets `Humanoid.group`, which is nested
   inside `CritterRig.group`. `trigger(height, gravity)` launches a
   `v=sqrt(2gh)` ballistic hop; `drop(height)` teleports to a height with
   `vy=0` to watch a long fall; both exposed on `CritterRig` as `jump()`/
   `drop()` (critter.ts:668-676). **Only wired to the movement sandbox today**
   (`movement.ts:1183-1246`, `scene.robeUnit?.jump()` /
   `scene.critterUnit?.jump()`) -- `scene.ts`'s real per-entity `syncBodies`
   loop never calls it, so no gameplay body currently jumps or drops. It also
   offsets the *whole* body uniformly (CritterRig's legs are FK bone
   rotations of one skeleton, not independently root-positioned) -- there is
   no legs/body split in this mechanism.

**Can `MechRig` be posed to make legs emerge before the body? Not today, with
no code changes -- but the architecture is unusually well-suited to it,**
because body and legs are *already* two separately-positioned parts under
`group`, and the leg IK is *already* decoupled from the body's own vertical
motion:

- Legs are IK-solved every frame from a **hip** point that goes through
  `carriage.matrix` (rigs.ts:1772: `_hip...applyMatrix4(this.carriage.matrix)`)
  to a **foot** point that is a world-locked ground plant computed
  independently of `carriage`/`turret` (rigs.ts:1775-1784). This is exactly
  the mechanism that already lets the body (`carriage`->`turret`, via the
  private `sHeight` spring) bob up and down a few units while the legs simply
  re-bend to keep their feet on the ground -- i.e. "body moves independently
  of planted feet" is the *existing* suspension mechanic, just currently
  bounded to a small oscillation (`swayCap = 4*S*REST_Z`, rigs.ts:1733,
  ~168 units at scale 1 -- more than enough headroom to sink the body below
  `HIP_Y*S`≈30 if it were externally driveable).
- Legs are drawn fully IK-solved from the very first `update()` call (no
  partial-build state) and, being siblings of `carriage` under `group`
  (rigs.ts:222), are wholly unaffected by anything done to `carriage`/`turret`
  alone.
- Nothing external can reach `carriage`/`turret` today -- both are `private`
  with no getters, and there is no reveal/opacity/scale field on `MechRig` at
  all. The minimal, structurally-honest addition would be a new method on
  `MechRig` (e.g. `setBodyReveal(t: number)` or similar) that, during a spawn
  window, either (a) hides/zero-scales the `turret`'s meshes while leaving
  `carriage`/legs untouched, or (b) offsets `turret.position.y` (or drives
  `sHeight`'s target) downward and eases it back to 0 -- both keep the
  already-standing, already-IK-solved legs visually undisturbed while only
  the body appears/rises. `scene.ts` would need a per-`Body` timestamp (there
  is none today; the `poppingDrops`-style side map at scene.ts:2496-2499 is
  the closest existing pattern for tracking one) to drive that timer per
  entity and call the new method once per frame from `syncBodies`, alongside
  the existing `body.mech?.update(...)` call at scene.ts:2162.
- `CritterRig` is a poorer fit for the same ask: its "legs" are FK bone
  rotations on one skeleton (`Humanoid.poseLegs`, humanoid.ts:271-301) with no
  separate root transform from the torso, so there is no clean seam to hide
  "body" behind while showing "legs" -- the whole figure is one rigid
  hierarchy under `Humanoid.group`.
