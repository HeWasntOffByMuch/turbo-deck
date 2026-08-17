# Monsters/NPCs in the server sim (traced 2026-08-17, supersedes the 08-06 pass)

> **Sections 1 and 3 below are superseded by spec 163**
> (`specs/163-four-ways-to-meet-a-player.md`), which is the spec 076 predicted.
> `aggroRange` and `passive` are **gone**; a row authors a `Temperament` union
> (`skittish` / `defensive` / `territorial` / `ferocious`) and every rule about
> acquiring, holding and dropping a target lives in `src/server/sim/aggro.ts` —
> `provoke` (what a blow does to a mind), `notice` (what proximity does),
> `settle` (what a clock running out or a quarry backing off does) and `rally`
> (the herd, driven off the tick's `hit` events as a new step-3e pass in
> `world.ts`). `ServerEntity` carries `aggro`/`aggroUntilTick` beside
> `activity`/`activityUntilTick`. The rest of the note — the entity struct, the
> spawner mechanism, the wire format, the test patterns — is still accurate.
> Read `src/server/sim/aggro.ts` and `src/server/sim/aggro.test.ts` first.

The 2026-08-06 version of this note described a proximity-aggro scan and a
random ambient spawner. **Both are gone as of spec 076** (`specs/076-spawners-in-the-map.md`),
and proximity came back in a different shape in spec 163.

## 1. `src/server/data/monsters.ts` — the MONSTERS table

```ts
export type AuthoredStats = Omit<EffectiveStats, 'traits'>;

export interface MonsterDefinition {
  readonly id: string;
  readonly name: string;
  readonly radius: number;
  readonly aggroRange: number;      // world units — UNREAD by the sim since spec 076
  readonly experience: number;      // XP to its killer
  readonly stats: EffectiveStats;   // full stat block, same shape a player uses
  readonly passive: boolean;        // read only by restoration.ts's threat factor, not by targeting
}
```

No `ability` field any more (spec 079 deleted it) — what a monster swings
with is `stats.basicAttackId` (an ability id string, e.g. `'melee.slash'` or
`'ranged.star'`), the same derived-stat field a player's weapon fills.
`stats.traits` (poise/shield/etc.) is *not* authored per row — `withTraits()`
(monsters.ts:65) derives it from `attackDamage`/`maxHealth` on the way into
the exported map, so a raw row is `AuthoredStats` (traits omitted) and
`MONSTERS`/`ALL_MONSTERS` hold the post-`withTraits` `MonsterDefinition`.

Six rows: `grazer` (passive, aggroRange 0, 24hp), `stalker` (aggro 320, 40hp),
`ravager` (aggro 420, 140hp), `small_spider` (aggro 300, 22hp, fastest BAT in
the table), `slinger` (aggro 520, `basicAttackId: 'ranged.star'`, standoff at
its throw's range not its melee `attackRange`), plus `dummy` (100000 HP,
`basicAttackId: ''`, scenery). Registry: `MONSTERS: ReadonlyMap<string,
MonsterDefinition>`, `ALL_MONSTERS` (excludes dummy), `monsterById(id)`.

**`small_spider` row verbatim** (monsters.ts:159-180):
```ts
{
  id: 'small_spider',
  name: 'Small Spider',
  radius: 12,
  aggroRange: 300,
  experience: 10,
  passive: false,
  stats: {
    maxHealth: 22,
    moveSpeed: 115,
    turnRate: 290,
    attackDamage: 5,
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

`EffectiveStats` (`src/server/state/types.ts`) fields used: maxHealth,
moveSpeed, turnRate, attackDamage, attackRange, baseAttackTimeTicks (spec 144;
NOT attackCooldownTicks any more), armor, spellPower, critChance, maxResource,
resourceRegen, basicAttackId (spec 079), traits (derived).

Schema: no JSON Schema — `MonsterDefinition` is a plain TS interface, rows are
authored in-code (`AUTHORED: readonly AuthoredMonster[]`), not validated by
`npm run validate:units`/`validate:items` (those are for `assets/units`/`assets/items`).

## 2. Entity struct — `src/server/sim/types.ts:300` `ServerEntity`

One struct for players, monsters, props, projectiles, motes and drops
(`EntityKindValue`: Player=0, Monster=1, Prop=2, Projectile=3, Mote=4, Drop=…).
AI-relevant fields:
- `targetId: number | null` (types.ts:322) — homing target; the *entire*
  aggro state.
- `anchor: Vec2 | null` (types.ts:403) — where this body spawned; centre of
  its leash. Null for anything with no home (players, admin-conjured
  monsters).
- `spawnerId: string | null` (types.ts:398) — which map spawn point produced
  it, so its timer can be started when it dies.
- `path`/`pathIndex`/`repathAtTick`/`pathGoal` — A*/string-pulled route state
  (spec 065), shared by chase and "walk home".
- `cast: CastState | null`, `cooldowns` — monsters cast through the *same*
  `sim/abilities.ts` machinery players do.
- `stats`, `health`, `poise`, `shield`, `statuses`, `stillSinceTick` — same
  progression fields (spec 147) a player has; a monster's `stats` is its
  definition's `stats` verbatim, never derived at runtime.

`ServerWorldState { tick, entities: ReadonlyMap<number, ServerEntity>,
nextEntityId, rng: Rng, spawners: ReadonlyMap<string, SpawnerState> }`.

## 3. AI / aggro / targeting — `sim/world.ts:1524` `monsterIntent()`

Still one function, no separate "AI system" file. Called once per monster
per tick from inside `step()`'s movement pass (world.ts:519), returns a
`ServerInput`-shaped `MonsterDecision` so movement/casts cannot tell a
monster's intent from a player's input.

Current logic (world.ts:1524-1599), in order:
1. Read `target` from `monster.targetId` if alive.
2. **Leash check runs before anything else reads the target**
   (`beyondLeash`, world.ts:1602): if a live target has dragged the monster
   past `LEASH_RADIUS` (800 units, world.ts:104) from its `anchor`, drop the
   target — this is checked *every tick*, so a monster being hit while it
   walks home re-acquires the attacker for one tick and drops it again the
   next.
3. **No proximity scan exists any more.** The comment at world.ts:1533-1538
   states it outright: *"Nothing initiates (spec 076). A monster's only route
   to a target is the retaliation `applyDamage` writes... `aggroRange` sits
   unread in the table until a spec turns proximity back on."*
4. If no target: `walkHome()` (world.ts:1624) routes back to `anchor` via the
   same A* the chase uses, and simply stands once within its own radius of
   home. No target and no anchor → stand, drop any route.
5. With a target: `reach = (swing.range + target.radius) * STANDOFF_FRACTION`
   (0.8, world.ts:92) where `swing = abilityById(monster.stats.basicAttackId)`
   — a slinger stands off at its throw's range, a stalker at its sword's, off
   the same two lines (world.ts:1555-1558).
6. Beyond reach → `routeToward` (chase); within it → stop, face target,
   `wantsToSwing = !closing && monster.cast === null && swing !== null` sets
   `castAbilityId`/`castTargetEntityId` on the synthesized input, which flows
   through the same `startCast`/`advanceCast` a player's cast does.

**`monsterIntent` never writes `targetId` itself** (aside from clearing it to
null when the target is gone/leashed, world.ts:1544) — the only place
anything *sets* it to a value is the retaliation write in `resolveBlow`
(`sim/blow.ts:211`): `targetId: target.targetId ?? attacker.id`. So "aggro" is
100% retaliation-driven today: a monster (any monster, `passive` or not, any
`aggroRange`) fights only whatever hit it first, and forgets it once it's
been dragged past the leash or the target dies/despawns.

`isHostile(attacker, target, zones)` (world.ts, search for the name): players
vs monsters always hostile; same-kind hostile only for players in a pvp zone;
Prop/Projectile/Drop entities are never targets/attackers.

## 4. Damage → target set, exact path

`sim/blow.ts:103` `resolveBlow(ability, attacker, target, tick, rng)` — the
one function every landing path (melee cone, single-target melee, projectile
impact, ground blast) calls through the thin wrapper `applyDamage()` in
`sim/abilities.ts:1568` (kept as a stable name/signature for the five call
sites: `abilities.ts:1247,1291,1330`, `world.ts:870,880`).

`resolveBlow`'s documented order (blow.ts:9-19): eligibility → rolls (**crit
before weak point, always** — RNG-thread determinism) → amplify → mitigate
(armor etc.) → absorb (shield before health) → poise/stagger → aftermath. The
retaliation write is inline in step 5 (absorb), `blow.ts:206-213`:
```ts
target = {
  ...target,
  health,
  shield: shieldLive - absorbed,
  activity: killed ? ActivityValue.Dead : target.activity,
  targetId: target.targetId ?? attacker.id,   // <-- the whole aggro-on-hit rule
  stillSinceTick: tick,
};
```
That's it — one line, unconditional on `attacker` being a player, so a
monster hit by another monster (friendly fire scenario, or an admin-forced
hit) would retaliate against it too, gated only by whatever calls `resolveBlow`
in the first place (`isHostile` gates who is a legal attack candidate
upstream, in `landOnTarget`/`landCone`).

Death: `killed = health <= 0` computed in `resolveBlow`; `step()`'s sweep
pass (world.ts:913, "--- 4: sweep the dead ---") deletes a dead monster
**immediately** (no corpse timer — spec 076 removed `CORPSE_TICKS` entirely;
a monster is deleted the tick its health reaches 0, and a loot drop entity is
spawned separately if the killer was a player). Dead players are kept in
place (`activity: Dead`) so their entity id survives; despawn/respawn logic
is `server.ts`'s job, not the sim's.

## 5. Movement/attack once targeted

Same as before, unchanged by spec 076: `monsterIntent`'s synthesized
`ServerInput` goes through the identical `resolveMovement`/collision code a
player's input does (world.ts step 2), and its `castAbilityId` goes through
the identical `startCast`/`advanceCast` state machine (`sim/abilities.ts`,
step 3, entity-id order). A monster mid-swing is rooted and withdrawable
exactly like a player (spec 079's move-cancels-cast rule applies equally).
Attack cadence comes from `stats.baseAttackTimeTicks` via
`sim/attack-timing.ts` (spec 144) — Agility-style speed stats don't apply to
monsters since they have no attribute allocation, but the same formula runs.

## 6. Spawning — no longer random

`runSpawner`/`ZoneDefinition.spawnTable` are **gone**. Spawns come from
`maps/arena.json` marker data (`kind: 'spawner'`, `label` = monster id),
parsed by `src/server/world/spawners.ts` `spawnPointsFrom(doc)` into
`SpawnPoint[]` (`{ id, monsterId, x, y }`, sorted by id). `StepContext.spawnPoints`
carries them in. `runSpawners()` (world.ts:1786, step 5) is now: one entity
per spawn point, refilled `interval = spawnIntervalTicks / spawnRateMultiplier`
ticks after that spawner's occupant dies (timer keyed by `spawnerId`, not by
chunk/zone/RNG — **no `Rng` draw happens at spawn any more**, keeping the RNG
stream reserved for combat). Population still gated by
`config.maxEntitiesPerChunk`, counted via `chunkKeyOf` (world.ts:1827-1832),
still a linear scan of `entities.values()`.

Spawned entity gets `anchor: {x: point.x, y: point.y}` and `spawnerId: point.id`
(world.ts:1859-1860) — this is the *only* place `anchor` is ever set to
non-null (aside from raw entity construction in tests).

`0x51 SpawnerStates` / `0x0b WatchSpawners` is a debug-only channel (opt-in
per connection) exposing spawner occupancy/countdown to the client for an
overlay — carries no AI/aggro state, just `{id, monsterId, x, z, state, ticks}`.

## 7. Wire serialization — `src/server/net/`

**No `targetId`, leash, or AI state rides the entity delta.** Current
`EntityField` bitmask (`net/protocol.ts:356`, a *varuint* since spec 147, not
a byte): `Spawn=1<<0, Position=1<<1, Facing=1<<2, Health=1<<3, Activity=1<<4,
Level=1<<5, Identity=1<<6 (players only: name+turnRate), Poise=1<<7,
Shield=1<<8`. `EntityDelta` (`net/messages.ts:684`) has fields for all of
those plus `kind`/`typeId`/`maxHealth`/`shieldUntilTick` — nothing for who a
monster is targeting.

A monster's cast (which encodes *who* it's attacking, via
`targetEntityId`) rides separately as `CastState`/`CastEnded` messages
(`0x49`/`0x4A`), built in `server.ts`'s `dispatchEvents` from the sim's
`castStarted`/`castEnded` events — so a client *can* currently infer "who is
this monster about to hit" only while it's mid-windup, from `CastState.targetEntityId`,
never from idle chase state.

**Where a new field would go**, if replicating e.g. `targetId` or a threat
state:
1. `EntityField` (`net/protocol.ts:356`) — new bit, next free is `1 << 9`.
2. `EntityDelta` interface (`net/messages.ts:684`) — new optional field.
3. `writeEntityDelta`/`readEntityDelta` (`net/messages.ts:1110`/`1141`) — wire
   codec, mirror the `Poise`/`Shield` pattern (both added together in spec
   147) for how to add a field to a varuint-masked delta cleanly.
4. `src/server/net/delta.ts` `DeltaTracker.build()` — decide when the field
   counts as "changed" (quantization epsilon if it's not an id/enum) against
   its `KnownEntity` cache, and include it in first-sighting sends.
5. `src/server/net/PROTOCOL.md` (`### 0x41 Delta`, line ~226) — the field's
   place in the doc, and bump `PROTOCOL_VERSION` (currently checked at
   connect via manifest hashing / hello handshake).
6. `src/server/client/replica.ts` `ReplicatedEntity`/`ReplicatedWorld.apply()`
   — client-side mirror of the same field set.
7. `src/server/client/game-client.ts` `view()` — expose it on `ClientView` if
   the renderer needs to read it (recall: `src/render/` may not reach the sim
   and must not decide game outcomes — a new AI-state field read there is for
   *drawing* only, e.g. an aggro indicator, never for changing behavior).

## 8. Distance / spatial queries available to the AI

**There is no spatial hash / spatial index in this codebase** — checked
`src/shared/` (only `hash.ts`, a string/number hash, and `prng.ts`; no
`SpatialHash` class exists anywhere in `src/`) and `src/sim/` (collision.ts,
pathfinding.ts — no broadphase structure). Every distance query the AI does
is either:
- A **linear scan of `entities`** (a `ReadonlyMap<number, ServerEntity>`),
  e.g. `runSpawners`'s population count (world.ts:1829-1831) and the old
  (now-deleted) proximity scan.
- **Chunk-grid bucketing by key**, not a hash structure: `chunkKeyOf(x, y,
  chunkSize)` (`src/server/world/chunks.ts:45`) buckets a position into a
  `"cx,cy"` string key; `ChunkManager` (`src/server/world/chunk-manager.ts`)
  tracks which chunks are "active" (near a player) and each connection's
  `interestSet()` (chunk-manager.ts:138) for network relevance — this is what
  gates *which entities are simulated at all* (`isSimulated`, world.ts:480)
  and *which entities a client is told about*, not what an individual
  monster's AI uses to find a target.
- `context.activeChunks: Set<ChunkKey>` is passed into `step()` for the
  "don't simulate what nobody's near" gate; `monsterIntent` itself does not
  consult chunks — it just reads `monster.targetId`/`monster.anchor` and does
  point-to-point math (`Math.hypot`) against the one target entity it
  already has, or nothing at all if it doesn't. **If proximity aggro comes
  back, the naive approach is a full scan of `entities` per untargeted
  monster per tick** (as spec 076 removed), which is what the removed
  `runSpawner` did; there's no existing broadphase to reach for instead —
  building one would be new work, not a rewire of something already there.

## Tests — `src/server/sim/world.test.ts`

Pattern throughout: hand-build a `ServerWorldState` via `spawnEntity`, run
`step(state, inputs, context)` in a loop for N ticks, assert on
`state.entities.get(id)`. No mocking — real `step()`, real pathfinding, real
`Rng` (seeded via `createWorldState(seed)`).

- `withMonster(state, typeId, x, y, { targetId?, anchor? })` (world.test.ts:100)
  — note its own doc comment: *"Nothing initiates since spec 076, so a test
  that wants a monster to walk anywhere has to hand it the target being hit
  would have given it."* Tests construct the post-retaliation state directly
  rather than simulating a hit, when what's under test is chase/leash, not
  the hit itself.
- `describe('aggro and the leash', ...)` (world.test.ts:697):
  - `'ignores a player standing on top of it until it is hit'` — spawns a
    ravager well inside its *old* aggro range next to a player, steps 10
    seconds of ticks, asserts zero `hit` events and the monster never moved
    (`targetId` stays null). This is the invariant a proximity-aggro change
    would need to either keep (opt-in per monster) or deliberately break.
  - `'drops a target it has been dragged too far from, and walks home'` —
    seeds `targetId`+`anchor` directly, steps until `targetId` flips back to
    null past `LEASH_RADIUS`, then re-applies `targetId` every tick (simulating
    "player keeps hitting it") and asserts it still ends up within its own
    radius of `anchor`.
- `describe('monsters find their way round', ...)` (world.test.ts:766) —
  pathfinding around obstacles, replanning cadence, retry-vs-replan.
- `describe("the map's spawners", ...)` (world.test.ts:570) — fill-on-boot,
  one-at-a-time, respawn-after-interval-at-the-marker, RNG-free, replay
  determinism (`'replays identically from the same seed and the same map'`).
- `describe('determinism', ...)` (world.test.ts:165) — the general
  seed+input-replay bit-identical assertion pattern everything else in this
  file relies on being true.

`sim/abilities.test.ts` and `sim/attack-cancel.test.ts` cover the cast
machinery a monster's swing goes through (shared with players, not
monster-specific).

## Invariants worth remembering before changing aggro

- `aggroRange`/`passive` are authored, validated by nothing, and **read by
  exactly one place that isn't targeting**: `sim/restoration.ts:162`'s threat
  factor for the health-economy mote system (`row.passive && row.aggroRange <= 0`
  → different regen weighting). Turning `aggroRange` back on for targeting
  does not conflict with that read, but don't assume the field is currently
  inert everywhere.
- The leash check (`beyondLeash`) runs *before* the target is read, every
  tick — any new targeting rule that re-introduces proximity acquisition
  must decide where it sits relative to that check, since leash-drop and
  re-acquisition currently can't both be true in the same tick by
  construction (spec 076's stated design: "cannot be re-aggroed while
  leashing... is a consequence of the rule rather than a second piece of
  state").
- `targetId` is not replicated (§7) — a client-visible "this monster is
  aggroed on someone" indicator does not exist today and needs a new wire
  field, not just a sim change.
- No corpse timer exists any more (spec 076) — a monster is deleted the tick
  it dies; don't assume `CORPSE_TICKS`/`Dead` activity lingers for monsters
  the way it does for players.
- `monsterIntent` is pure and returns a `ServerInput`-shaped intent; any new
  aggro rule should stay a pure function of `(monster, entities, tick,
  context)` — no ambient state, no RNG unless threaded through `context`/state
  explicitly (spec 076 deliberately removed the RNG draw from spawning to
  keep the stream reserved for combat; a new proximity/aggro roll that wants
  randomness would need to thread `Rng` through `step()`'s movement pass the
  way casts already do).
