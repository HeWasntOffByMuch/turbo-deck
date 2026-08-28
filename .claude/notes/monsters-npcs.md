# Monsters/NPCs in the server sim (traced 2026-08-27, supersedes the 08-17 pass)

The 08-17 note was itself marked stale in its own header ("Sections 1 and 3
superseded by spec 163") and had drifted further since: it undercounted the
monster roster (missing `sheep`), had the dummy's health wrong (25000, not
100000), and predated spec 213 (`sim/idle.ts`, wander/patrol/flee-commit) and
spec 222 (per-spawner leash/respawn overrides). This pass reads current
source top to bottom. Read `src/server/sim/aggro.ts`, `src/server/sim/idle.ts`
and `src/server/data/monsters.ts` first if you only have time for three files.

## 0. The load-bearing finding for "add a friendly NPC"

**`isHostile` (`sim/world.ts:474-512`) is decided by `EntityKindValue`, not by
a monster's `Temperament`.** Player-vs-Monster (or vice versa) is hostile
*unconditionally* once `attacker.kind !== target.kind` and neither is `Prop`
(world.ts:511: `return attacker.kind !== EntityKindValue.Prop && target.kind
!== EntityKindValue.Prop;`). Same-kind Monster-vs-Monster is *always* false
(world.ts:497-498), regardless of temperament.

Temperament (`data/monsters.ts:81-96`) only governs what the *monster decides
to do* — flee, ignore, alert-then-engage, call for help — never whether a
player's blow is allowed to land. Every one of the four temperaments
(`skittish`/`defensive`/`territorial`/`ferocious`), once hit, runs `provoke()`
(`sim/aggro.ts:95-124`, called from `sim/blow.ts:317-327`) which either sets
it `Fleeing` (skittish) or `engage()`s it (the other three) — **there is no
temperament that means "permanently inert, cannot be provoked."** The closest
existing precedent is the `dummy` row (`defensive` + `moveSpeed: 0` +
`basicAttackId: ''`): it can be hit and will silently flip to `Engaged`
internally, but never moves or swings because its stats make both impossible.

So there are two different things "friendly" could mean, and the fork is
real:

1. **"Won't start a fight, but will scrap back if hit"** — already exists:
   `temperament: { kind: 'defensive' }` (what the ravager and the dummy use).
   Give it a real `basicAttackId` and it fights back like any monster.
2. **"Cannot be attacked, cannot fight, a player can just walk through/past
   it"** — needs a change to `isHostile` itself, since no `Temperament` can
   suppress it. Two options that fit the existing shape:
   - Reuse `EntityKindValue.Prop` (`sim/types.ts:22`, wire value 2,
     `net/protocol.ts:453`). It is **already fully excluded from
     `isHostile` on both ends** (world.ts:495-496 style exclusion for Drop is
     the pattern; Prop's own exclusion is the final-line check at
     world.ts:511) and there is **no code path anywhere that spawns a live
     `Prop`-kind `ServerEntity` today** (`grep EntityKindValue.Prop` in
     `src/server` hits only `blankEntity`'s placeholder default at
     world.ts:127 and the `isHostile` exclusion at world.ts:511 — map props
     like trees/buildings are baked into terrain, per `src/terrain/vegetation.ts`,
     never entities). The client already has a stub for it too:
     `appearanceOf` in `src/render/iso3d/world/appearance.ts:180-181` returns
     `{ rig: 'prop', ... , showsHealth: false }` for `EntityKind.Prop` — worth
     checking whether that rig case is wired to anything before relying on
     it, the way CLAUDE.md warns other "complete format, no caller" cases
     have gone.
   - Add a new `EntityKindValue` (e.g. `Npc`) and add it to `isHostile`'s
     exclusion list next to `Prop`/`Mote`/`Drop`/`Projectile`. More explicit,
     costs a new wire enum value and a new `appearanceOf` case, but doesn't
     risk colliding with a future real use of `Prop`.
   Either way, if the NPC still needs to *move* (idle wander/patrol) it must
   keep going through the non-Player branch of the movement pass
   (world.ts:894-903), which currently calls `monsterIntent` for **every**
   non-Player/Projectile/Mote/Drop entity unconditionally — `idle()`
   (`sim/idle.ts:110-111`) already no-ops for anything that isn't
   `EntityKindValue.Monster`, so a `Prop`- or `Npc`-kind body would stand
   frozen unless `idle()`'s kind check (and `temperamentOf`'s, `sim/aggro.ts:33`)
   are loosened to cover it, or the new kind's wander is driven by a
   parallel, smaller function rather than reusing `monsterIntent` verbatim.
   Simplest path if wander is wanted: keep `kind: Monster` (so idle/notice/
   settle all work unmodified) and *only* change `isHostile` to also check
   something like a `friendly` flag or a new `Temperament` member — this
   needs a field either on `ServerEntity` or readable from
   `MonsterDefinition`/`Temperament`, since `isHostile` currently takes no
   monster-table lookup at all (it only sees the two `ServerEntity`s and
   `ZoneManager`). That is new plumbing either way; there is no existing
   "friendly monster" switch to flip.

## 1. `src/server/sim/world.ts` — `step()`, the tick structure

Signature: `export function step(state: ServerWorldState, inputs: readonly
ServerInput[], context: StepContext): StepResult` — world.ts:795-799.
`StepResult = { state: ServerWorldState; events: readonly ServerSimEvent[] }`
(types.ts:939).

Comment-labelled passes, in exact order (world.ts line the comment sits on):

- **1+2** (826): "timers, intent, the crowd and movement, in creation order."
  Explicitly three sub-passes over the *same* entity list in *creation
  order*, because reciprocal avoidance needs every body's decision before
  anyone moves:
  - **1a** (no separate comment, inline in the loop starting 864): every
    living, simulated, non-Projectile/Mote/Drop entity decides. Player →
    `rawIntent = input` (894-895). Non-player → `monsterIntent(current,
    working, players, tick, context, APPROACHES)` (899), which can also
    *mutate the entity* (route state) — `steered = decision.entity`. Also
    here: a player's move-to-withdraw-from-cast check (938-951, **player
    only**, spec 221 excludes monsters), skill-swap-drop-on-move (963-965),
    and the stagger/cast movement pin (986-992). Pushed into `decided: DecidedMove[]`.
  - **1b** (996): `buildCrowd` / `solveAvoidance(crowd, CROWD, AVOIDANCE)` /
    `applyCrowd` — ORCA avoidance rewrites `intent.moveX/moveY` in place.
  - **1c** (1008): `resolveMovement(steered, intent, movement)` actually
    moves each body (in the same creation order), writes `position`,
    `facing`, `velocity`, `zoneId`, `claimedPosition`/`claimedSeq`/`pardon`,
    runs `advanceRest`/`advanceProgression`, and (1099) pushes onto
    `casters` if there's an intent or an in-progress cast.
  - **1d** (1102): `separateCrowd(crowd, working, context)` — position-based
    overlap correction for cases avoidance couldn't prevent (spawn-on-top,
    stagger mid-swerve, etc). Player bodies are exempt (they're outside this
    pass; spec 187's stated limit).
- **3** (1119): "casts, in id order" — `casters.sort((a,b) => a-b)`, then per
  caster: cancel (1168) outranks a fresh commit (1187), `startCast`/
  `advanceCast` run, `isHostile` filters `[...working.values()]` into
  `candidates` for `advanceCast` (1217-1219), `rewindTargets` compensates for
  lag (1224), projectile spawns queued (1236).
- **3b** (1239): projectile flight + impact resolution (single-target and
  blast), using `isHostile` again at 1323/1328/1337.
- **3c** (1392): `pulseAuraFields` — ground-attached afflictions (aura
  fields, spec 223).
- **3d** (1408): `pulseDots` — damage-over-time ticks (spec 190).
- **3e** (1426): `creditDeaths` — health-economy kill qualities off this
  tick's `died` events.
- **3f** (1436): `advanceMotes`.
- **3g** (1439): `rally(events, working)` — the herd response (spec 163),
  driven off this tick's `hit` events, must run *before* the sweep (a killed
  spider must still call its nest).
- **4** (1448): sweep the dead. Players kept (`activity: Dead`, entity id
  survives); monsters deleted immediately (no corpse timer — spec 076), loot
  rolled/scattered/spawned as a separate `Drop` entity if the killer was a
  player with an `ownerPlayerId` (1490-1524); `emptied` collects
  `spawnerId`s of anything removed (1528).
  - **4b** (1531): drop entity expiry/reveal, over *every* drop in the
    world (not gated on residency — a promised reveal tick must land).
- **5** (1547): `runSpawners(working, state.spawners, emptied, nextEntityId,
  tick, context)`.

`StepContext` (world.ts:223-257): `{ world: WorldColliders; terrain:
TerrainSampler; zones: ZoneManager; config: LiveConfig; rewind?:
RewindLookup; activeChunks: ReadonlySet<ChunkKey>; chunkSize: number;
spawnPoints: readonly SpawnPoint[]; nav?: NavLookup }`.

## 2. `ServerEntity` — `src/server/sim/types.ts:379-606`

One struct for every entity kind. `kind: number` (`EntityKindValue`,
types.ts:19-52): `Player=0, Monster=1, Prop=2, Projectile=3, Mote=4, Drop=5`
— mirrored verbatim on the wire as `EntityKind` in `net/protocol.ts:450-469`.

**What distinguishes a monster from a player:** `kind === EntityKindValue.Monster`
plus `ownerPlayerId: null` (types.ts:385, "Set for player entities, null for
everything the server spawned itself"). `typeId` (383) is the monster's row
id (`'small_spider'`, etc.) or the player's chosen critter skin — same field,
different table on lookup. There is no separate discriminated-union type;
every field is present on every kind and most are simply unused/zeroed for
kinds that don't need them (e.g. `projectile`/`mote`/`drop` are `null` on
anything that isn't that kind — types.ts:472,490,499).

AI/aggro-relevant fields (all under `// --- progression state` etc. headers
or inline):
- `targetId: number | null` (417) — homing target.
- `aggro: number` (422, `AggroValue`: `Calm=0, Alert=1, Engaged=2, Fleeing=3`
  — types.ts:91-100) — "`Calm` exactly when `targetId` is null" is an
  invariant `aggro.ts`'s `calm`/`engage`/`settle` maintain, not something the
  type system enforces.
- `aggroUntilTick: number` (428) — when an `Alert` becomes `Engaged` or a
  `Fleeing` becomes `Calm`; 0 for the two event-driven states.
- `fleeGoal: Vec2 | null` (448) — committed flight destination (spec 213),
  written only by `provoke`, cleared only by `calm`/`engage`.
- `path`/`pathIndex`/`repathAtTick`/`pathGoal` (454-460) — A* route state,
  shared by chase, flee and idle-wander.
- `spawnerId: string | null` (540) — which map spawner produced it.
- `anchor: Vec2 | null` (545) — leash centre; null = "no home" (player, or an
  admin-conjured/test-seeded monster).
- `leashRadius: number` (557, spec 222) — **not** nullable; a body with no
  anchor carries `LEASH_RADIUS` (world.ts:174/347) as a value nothing reads,
  since `beyondLeash` (world.ts:2331-2337) checks `anchor` first.
- `cast: CastState | null`, `cooldowns: Readonly<Record<string, number>>` —
  same ability machinery a player uses.
- `stats: EffectiveStats` — for a monster this is `MonsterDefinition.stats`
  verbatim (never re-derived at runtime); for a player it's recomputed on
  login/equip/skill change.
- `velocity: Vec2` (415, spec 187) — *actual* last-tick displacement, used by
  the crowd/avoidance pass; not replicated.
- `health`, `poise`, `shield`, `statuses`, `stillSinceTick`, `restoration`,
  `fallbackCharges`, `restingTicks` — same progression fields a player has.

`ServerWorldState` (620-634): `{ tick: number; entities:
ReadonlyMap<number, ServerEntity>; nextEntityId: number; rng: Rng; spawners:
ReadonlyMap<string, SpawnerState> }`.

`SpawnerState` (609-618): `{ entityId: number | null; readyAtTick: number }`.

Building an entity: `spawnEntity(state, spec: SpawnSpec)` (world.ts:310-366)
is the general-purpose constructor (used by players and by anything a
caller/test wants to place directly); `SpawnSpec` (278-308) takes `kind,
typeId, position, facing?, ownerPlayerId?, stats, radius, level?, zoneId,
health?, targetId?, anchor?, fallbackCharges?, restoration?`. Handing it a
`targetId` starts the body `Engaged` rather than `Calm` (333). `blankEntity(id)`
(124-184) is the all-zeros/Prop-kind default `SpawnSpec` fields fall back
from and what a projectile/drop entity is built by spreading over.

## 3. `src/server/data/monsters.ts` — the MONSTERS table

```ts
export type AuthoredStats = Omit<
  EffectiveStats,
  | 'traits' | 'skillAbilityIds' | 'weaponScaling' | 'scalingModifiers'
  | 'weaponDamageMin' | 'weaponDamageMax' | 'scalingAttributes'
>;
```
i.e. a row authors: `maxHealth, moveSpeed, turnRate, attackDamage,
attackRange, baseAttackTimeTicks, attackSpeed, attackSpeedMultiplier,
attackSpeedSlowMultiplier, armor, spellPower, critChance, maxResource,
resourceRegen, basicAttackId`. `...NO_ATTACK_SPEED` (`sim/attack-timing.ts:60-64`)
= `{ attackSpeed: 0, attackSpeedMultiplier: 1, attackSpeedSlowMultiplier: 1 }`,
what every row in the table spreads in.

```ts
export type Temperament =
  | { readonly kind: 'skittish'; readonly fleeTicks: number }
  | { readonly kind: 'defensive' }
  | { readonly kind: 'territorial'; readonly noticeRange: number; readonly alertTicks: number }
  | { readonly kind: 'ferocious'; readonly noticeRange: number; readonly assistRange: number };
```
(monsters.ts:81-96). Interpreted **only** by `sim/aggro.ts`.

```ts
export type Idle =
  | { readonly kind: 'sentinel' }
  | { readonly kind: 'wander'; readonly radius: number; readonly cycleTicks: number }
  | { readonly kind: 'patrol'; readonly radius: number; readonly points: number; readonly legTicks: number };
```
(monsters.ts:114-138). Interpreted **only** by `sim/idle.ts`.
`DEFAULT_IDLE = { kind: 'wander', radius: 150, cycleTicks: seconds(12) }`
(171) is what `withTraits` fills in for a row with no `idle` key —
**"all units wander" is the default, not something every row states.**

```ts
export interface MonsterDefinition {
  readonly id: string;
  readonly name: string;
  readonly radius: number;
  readonly experience: number;   // XP to its killer
  readonly stats: EffectiveStats; // POST-withTraits, full derived shape
  readonly temperament: Temperament;
  readonly idle: Idle;
}
```
(140-156). Raw authored rows are `AuthoredMonster extends Omit<MonsterDefinition,
'stats'|'idle'> { stats: AuthoredStats; idle?: Idle }` (201-205).

`withTraits(monster: AuthoredMonster): MonsterDefinition` (216-246): fills
`idle` from `DEFAULT_IDLE` if absent; sets `skillAbilityIds: []` and
`...NO_WEAPON` (monsters can't carry skills or weapon-scaling grades);
`weaponDamageMin = weaponDamageMax = max(0, attackDamage)` (a monster's blow
is a flat number, not a range); `traits: monsterTraits(maxHealth, power)`
where `power = attackDamage * 0.5 + SCALING.strength.staggerBase * 0.5`
(217) — poise is a fraction of health, stagger power off damage, both
defaults a row can't get wrong by omission.

**Full roster, six real monsters + dummy** (`AUTHORED` array, monsters.ts:252-500,
plus `DUMMY` at 502-531): `grazer` (skittish, 3hp — divided by 8 not 4 per
spec 217, since fleeing means it "never" gets hit twice), `sheep` (skittish,
18hp, the one row with an authored `idle.wander` that's mostly standing —
grazing), `stalker` (territorial, 10hp, patrol), `ravager` (defensive, 35hp,
heaviest, no authored `idle` → gets `DEFAULT_IDLE`), `small_spider`
(ferocious — assists neighbours via `rally`, 6hp, tight nest-bound wander),
`slinger` (territorial, 9hp, `basicAttackId: 'ranged.star'`, patrol,
standoff at throw range not melee `attackRange`). `dummy`: `defensive`,
`idle: { kind: 'sentinel' }`, `maxHealth: 25000`, `moveSpeed: 0`,
`basicAttackId: ''` — scenery with a health bar, and the working precedent
for "a monster that is hostile/attackable but can never actually act."

**`small_spider` row, verbatim** (monsters.ts:419-450):
```ts
{
  id: 'small_spider',
  name: 'Small Spider',
  radius: 12,
  experience: 10,
  temperament: { kind: 'ferocious', noticeRange: 300, assistRange: 260 },
  idle: { kind: 'wander', radius: 90, cycleTicks: seconds(7) },
  stats: {
    maxHealth: 6,
    moveSpeed: 115,
    turnRate: 290,
    attackDamage: 1,
    attackRange: 55,
    baseAttackTimeTicks: seconds(0.8),
    ...NO_ATTACK_SPEED,
    armor: 0,
    spellPower: 1,
    critChance: 0.05,
    maxResource: 0,
    resourceRegen: 0,
    basicAttackId: 'melee.slash',
  },
},
```
(`seconds(v) = Math.max(1, Math.round(v * SERVER_TICK_RATE))`, monsters.ts:248-250.)

Registry: `MONSTERS: ReadonlyMap<string, MonsterDefinition>` (535-537, includes
dummy), `ALL_MONSTERS: readonly MonsterDefinition[]` (539, excludes dummy),
`monsterById(id): MonsterDefinition | null` (541-543). No JSON Schema —
plain TS, not touched by `validate:units`/`validate:items`.

Helpers: `noticeRangeOf(temperament)` (182-186, 0 unless territorial/ferocious),
`idlePlanOf(typeId)` (197-199, `monsterById(typeId)?.idle ?? SENTINEL` — a
row that has *gone missing* stands, unlike a row that simply omitted `idle`
which wanders).

## 4. Spawning — map markers → entities

Boot wiring: `world/build.ts:115` `buildWorldFromMap`/`buildWorldFromDocument`
calls `spawnPointsFrom(doc)` → `BuiltMapWorld.spawnPoints` → `server.ts:509`
`this.spawnPoints` → `server.ts:2666` into `StepContext.spawnPoints` every
tick → read by `runSpawners`.

`spawnPointsFrom(doc: MapDocument): readonly SpawnPoint[]`
(`world/spawners.ts:56-98`): walks every layer/chunk/marker, keeps
`marker.kind === 'spawner'`, **throws `SpawnerError`** (a boot failure, not a
silent skip) if `label` is missing/unknown as a monster id (74-80) or an id
is duplicated (81-83). Converts chunk-local marker coords to world coords via
`originX = layer.origin.x + chunk.cx * extent`, `extent = doc.grid.cellSize *
doc.grid.chunkCells` (60,69-70,88-89). Result **sorted by id** (97) —
sim order must not depend on chunk iteration order.

```ts
export interface SpawnPoint {
  readonly id: string;          // the marker's id
  readonly monsterId: string;   // marker.label
  readonly x: number;
  readonly y: number;           // the document's z
  readonly respawnTicks: number | null;  // null = config's global default
  readonly leashRadius: number | null;   // null = LEASH_RADIUS
}
```
(spawners.ts:19-45). `respawnTicks`/`leashRadius` come from the optional
`marker.spawner?: MapSpawnerSettings` block (spec 222, `terrain/map.ts:137-148`:
`{ respawnSeconds?: number; leashRadius?: number }`, **seconds**, converted
by `respawnTicksOf` at spawners.ts:112-115) — refused by the parser on any
marker kind other than `spawner` (map.ts:161-170).

`MapMarker` (`terrain/map.ts:151-171`): `{ kind: MapMarkerKind; id: string;
x: number; z: number; label?: string; spawner?: MapSpawnerSettings }`.
`MapMarkerKind = 'spawn' | 'objective' | 'campfire' | 'trigger' | 'spawner'`
(map.ts:118) — **adding a new marker kind for an NPC is a real option** (the
editor's marker tool already round-trips arbitrary kinds; only `spawner` has
a reader today per `editor/tools.ts`'s note that `spawn`/`objective`/
`campfire`/`trigger` are sockets with nothing plugged in).

**Verbatim spawner marker**, from `maps/arena/r/0_1.json` (layer `ground`,
chunk cx=1,cz=2 — note: `maps/arena.json` no longer exists as a single file;
spec 220 split the map into `maps/arena/manifest.json` + per-region files
under `maps/arena/r/<rx>_<rz>.json`, each itself a full `MapDocument`-shaped
file with `layers`):
```json
{
  "kind": "spawner",
  "id": "spawner-1",
  "x": 323.452,
  "z": 162.277,
  "label": "small_spider"
}
```
No shipped marker currently carries a `spawner: {...}` settings block (all
rely on the config defaults).

`runSpawners` (`sim/world.ts:2660-2791`): one entity per spawn point.
`emptied: string[]` (bodies removed this tick, from the sweep pass) start
each spawner's clock (`world.ts:2691-2696`, stamped *before* the refill pass
so a same-tick kill+refill can't happen). Refill loop (2733-2788) only visits
spawn points in `context.activeChunks` (via `spawnIndexFor`, memoized), then
**sorts the candidate indices back into authored order** (2720) so entity-id
assignment is independent of `Set` iteration order — deterministic replay
depends on this. Gated by `config.maxEntitiesPerChunk` via a **once-per-tick**
`populationByChunk` count (2556-2566, 2731) — not per-spawner. Built entity
(2761-2783) gets `spawnerId: point.id`, `anchor: {x,y}`, `leashRadius:
leashOf(point)` (`leashOf`, 2603-2605, caps at `LEASH_RADIUS=800`,
world.ts:121), full poise/health/resource. **No `Rng` draw anywhere in this
path** — spawn position and monster identity are both document-decided, and
the timer is tick arithmetic (spec 076's stated reason: keep the RNG stream
reserved for combat).

`respawnInterval(config, point?)` (2803-2811): `null` disables spawning
entirely (`config.spawnRateMultiplier <= 0`); otherwise `point?.respawnTicks
?? config.spawnIntervalTicks`, divided by `spawnRateMultiplier` (which the
admin console can change live, including to 0 — halts repopulation without a
restart, and a per-marker override cannot escape that).

## 5. `src/server/sim/idle.ts` — wander/patrol (spec 213)

One exported entry point:
```ts
export function idle(monster: ServerEntity, tick: number): IdleStep
```
(idle.ts:110). `IdleStep = { entity: ServerEntity; goal: IdleGoal | null }`
(89-94). `IdleGoal = { at: Vec2; pace: number }` (83-87, `pace` = fraction of
the body's own move speed — consumed by `idleDecision` in world.ts:2394-2395
as `moveX: steer.direction.x * goal.pace` etc., relying on `resolveMovement`
already treating a sub-unit-length direction vector as "go slower").

`idle()` returns `goal: null` immediately for `kind !== EntityKindValue.Monster`
(111) or for a monster with no `anchor` (115) — **this is the exact spot
that would need loosening (or bypassing) for a wandering `Prop`/new-kind
NPC**, see §0.

Logic (110-125): `restore()` (health regen, gated on **not** carrying
`StatusId.InCombat`, linear over `RECOVERY_TICKS` = 4s, idle.ts:144-152) runs
unconditionally first. Then: if `drift > homeRadiusOf(plan) + HOME_MARGIN(24)`
(118-121), goal = anchor at `RETURN_PACE=1` (full speed — a body coming home
must not be catchable the whole way back). Otherwise `postAt(plan, id,
anchor, tick)` at `IDLE_PACE=0.45`.

`postAt` (167-191) — **no RNG, hash-only**, via `hash2i`/`hashUnit2`
(`shared/hash.ts:23,31`, both `(x: number, y: number, seed: number) =>
number`, deterministic functions of their inputs):
- `wander`: cut the body's life into `cycleTicks`-long epochs
  (`epoch = floor((tick + hash2i(id,0,PHASE_SEED) % cycle) / cycle)`, a
  per-body phase offset so a herd doesn't turn over together), then a fresh
  `hashUnit2(id, epoch, ANGLE_SEED) * TAU` angle and
  `sqrt(hashUnit2(id, epoch, REACH_SEED)) * radius` reach (square-rooted for
  uniform-over-disc, not uniform-over-radius) — a **new** point every epoch.
- `patrol`: fixed ring of `points` posts, `step = floor((tick +
  hash2i(id,0,PHASE_SEED) % circuit) / legTicks)`, direction hashed
  (`(hash2i(id,0,TURN_SEED) & 1) === 0 ? 1 : -1`) and start angle hashed
  (`hashUnit2(id,0,START_SEED) * TAU`) — same six distinct seed constants
  (`0x1d1e0001`..`0x1d1e0013`) keep the three questions (which way / how far
  / phase) independent.

Six seed constants are module-level `const`s (idle.ts:75-80); adding a third
plan kind means picking two or three more distinct literals in that style,
not reusing one.

`idleDecision` (world.ts:2360-2409) is the caller inside `monsterIntent`:
turns `IdleGoal` into a `MonsterDecision` the same way a chase does, via
`routeToward` — so an ambling monster paths around obstacles exactly like a
charging one.

## 6. Facing/turning

Lives in `src/server/sim/movement.ts`, **not** `world.ts`.

- `export function turnToward(from: number, to: number, turnRateDegPerSecond:
  number, tickRate: number): number` (movement.ts:112-126) — one tick's worth
  of rotation toward `to`, clamped by the turn-rate stat; a `turnRate` of 0
  cannot turn at all (used for `dummy`). Exported so the **client predicts
  facing with the same function** — no second implementation to drift.
- `export function headingToward(from: Vec2, to: Vec2, fallback: number):
  number` (138-143) — `atan2`, but returns `fallback` when `from`≈`to`
  (avoids a defined-but-wrong `atan2(0,0)` heading for a self-cast/aim-at-own-feet).
- `function resolveFacing(entity: ServerEntity, input: ServerInput | null):
  number` (284-294, **not exported**) — priority: a live `cast`'s
  `{targetX,targetY}`, else `entity.dropAim`, else the input's `facing`, else
  hold current — then run through `turnToward`. Called from inside
  `resolveMovement` (257), so a monster's facing is set the *same* way a
  player's is, off the *synthesized* `ServerInput` `monsterIntent` builds
  (world.ts:2220 `facing: ...` field on the returned input, computed either
  from `steer.direction` while routing or `atan2(dy,dx)` toward the target
  while stopped-and-swinging, world.ts:2202-2206).

The field: `ServerEntity.facing: number` (types.ts:387) — radians, no unit
conversion anywhere in the sim.

## 7. Hostility / targeting

```ts
export function isHostile(
  attacker: ServerEntity,
  target: ServerEntity,
  zones: ZoneManager,
): boolean
```
(`sim/world.ts:474-512`). Full logic, in order: not self (479); neither end
may be a Projectile (483-484) or a Mote (489-490) or a Drop (495-496) — all
four of those `return false` unconditionally, both as attacker and as
target; same-kind check (497-509): Monster-vs-Monster is **always** `false`
(498, no friendly-fire between monsters at all, not even different types);
Player-vs-Player is hostile only if **both** bodies are standing in a pvp
zone right now (`zones.zoneAt(...).pvp` checked at both positions, 506-509 —
spec 145's "both ends, not just the attacker's"); otherwise (different
kinds, i.e. the Player/Monster case) hostile unless either is a `Prop`
(511). See §0 for why this means temperament cannot make something
unattackable.

Call sites (all in `world.ts` unless noted): cast-candidate filtering (1218),
projectile single-target hit test (1323) and area-of-effect blast filtering
(1328, 1337), aura-field pulse (1404, via a closure passed as
`context.isHostile` into `sim/aura-field.ts:214`) and DoT pulse (1421, into
`sim/damage-over-time.ts:383,555`) — the latter two take `isHostile` as an
injected function rather than importing it directly, keeping those two pure
modules free of a `ZoneManager` import.

**Client-side "attackable" is a different, presentational function** —
`function attackable(entity: {id,kind,health}, selfId: number): boolean` in
`src/render/iso3d/world/view.ts:2467-2471`: not self, alive, and
`kind === Monster || kind === Player`. Its own doc comment: "Whether the blow
is *allowed* — hostility, range, the zone's pvp flag — is the server's to
answer." This only decides which cursor/right-click-order the UI offers; it
does **not** consult temperament either, so a `Prop`/new-kind NPC would
already fail this check for free (not drawn as attackable) without any
render-side change, since it only allows `Monster`/`Player` kinds.

**How `monsterIntent` picks a target** — two entry points, not one function
called "nearestQuarry" from `world.ts` (that name is `sim/aggro.ts`'s own
private helper, not exported, not used by `world.ts` directly):
- `sim/aggro.ts:notice(monster, players, tick)` (139-164) — only runs when
  `monster.aggro === AggroValue.Calm` and its temperament reads a
  `noticeRange` (territorial/ferocious). Calls the **module-private**
  `nearestQuarry(monster, players, range)` (276-295, plain squared-distance
  scan over the `players` array with strict `<` so first-in-insertion-order
  wins a tie — deterministic). `players` is gathered **once per tick** by
  `playersOf(entities)` (306-312) in `world.ts:863`, not re-scanned per
  monster (spec 206 perf fix).
- `sim/aggro.ts:provoke(target, attacker, tick)` (95-124) — the *retaliation*
  path, called from `sim/blow.ts:317` on every landed hit. This is what sets
  `targetId` for anything with no temperament (players, "the pre-163 rule,
  untouched") and drives the flee/engage transition for anything with one.
- `sim/aggro.ts:rally(events, entities)` (224-262) — herd response, scans
  **all** entities per `hit` event (not per tick) looking for `ferocious`
  allies within `assistRange` of the victim; bounded because it only runs
  off actual `hit` events (one hop per blow), never a per-tick proximity
  sweep.

`monsterIntent` itself (`world.ts:2120-2235`) composes these: resolve
`target` from `targetId` → drop it if `beyondLeash` (2138, exempted while
`Fleeing`) → `settle`/`notice` (2151-2161) → no target → `idleDecision`
(2167) → `Fleeing` → `fleeFrom` (2172) → otherwise compute `standoffFrom`
(2091-2094, `(swing.range + target.radius) * STANDOFF_FRACTION(0.8)`,
`swing = abilityById(monster.stats.basicAttackId)`) and either
`routeToward`+ring-offset (2196-2200, via the file-local `ApproachBoard`
class at world.ts:567, planned once per tick at world.ts:858, `aimFor` at
world.ts:2196) or stop-and-face-and-swing (`wantsToSwing`, 2211).

## Open questions for the friendly-NPC task specifically

- No existing "NPC that draws in the world but has no fight logic at all"
  precedent to copy verbatim — vendors (`data/vendors.ts`) are the closest
  *conceptual* analogue (a named, positioned, proximity-gated thing a player
  interacts with) but are **not entities at all**: no `ServerEntity`, no
  body, no client-visible model tied to the table row — just `{id, name, x,
  y, radius, stock, buyMarkup, sellFraction}` and a distance check
  (`withinReach`, vendors.ts:108-110). If the desired NPC needs to be *seen*
  standing somewhere and *walk around*, it needs a real `ServerEntity`;
  vendors today don't answer how one would be drawn/replicated as a body.
- Whether `appearanceOf`'s `case EntityKind.Prop` (`appearance.ts:180-181`,
  `rig: 'prop'`) is wired to an actual rig-building path in `scene.ts`, or is
  another "complete format, no caller" case — **not checked in this pass**,
  out of the server-side scope given, but worth a `grep "rig === 'prop'"` /
  `rig: 'prop'` in `src/render/iso3d/world/scene.ts` before committing to
  reusing `Prop`-kind for a visible NPC.
- Whether `MapMarkerKind` should grow an `'npc'` case (parallel to `spawner`)
  so an NPC's placement is a map edit rather than a code table entry, the
  way `data/vendors.ts`'s own header explicitly frames as the tradeoff
  ("Vendors are content, content is a table... When somebody wants to place
  one by dragging it, this becomes a marker kind"). Not investigated further
  since it's a design choice, not a fact to trace.
