# Monsters/NPCs in the server sim (traced 2026-08-06)

## 1. src/server/data/monsters.ts — the MONSTERS table

```ts
export interface MonsterDefinition {
  readonly id: string;
  readonly name: string;
  readonly radius: number;
  readonly aggroRange: number;      // world units; 0 = never initiates
  readonly experience: number;      // XP to its killer
  readonly stats: EffectiveStats;   // full stat block, same shape a player uses
  readonly passive: boolean;        // only fights back once hit
  readonly ability: string | null;  // ability id it swings with, or null (scenery/dummy)
}
```
`EffectiveStats` (src/server/state/types.ts) fields used: maxHealth, moveSpeed,
turnRate, attackDamage, attackRange, attackCooldownTicks, attackSpeed, armor,
spellPower, critChance, maxResource, resourceRegen.

Content: `grazer` (passive, aggroRange 0), `stalker` (aggro 320), `ravager`
(aggro 420), plus `dummy` (100000 HP, ability null, scenery). Registry:
`MONSTERS: ReadonlyMap<string, MonsterDefinition>`, `ALL_MONSTERS` (excludes
dummy), `monsterById(id)`.

## 2. Entity struct, creation, ticking — src/server/sim/

`ServerEntity` (src/server/sim/types.ts:105) is the one struct for players,
monsters, props *and* projectiles (`EntityKindValue`: Player=0, Monster=1,
Prop=2, Projectile=3). Relevant fields for monster/AI purposes:
- `health`, `stats` (a monster's stats are its definition's `stats` verbatim,
  never derived at runtime the way a player's are)
- `activity`/`activityUntilTick` (`ActivityValue`: Idle/Moving/Casting/
  Stunned/Dead)
- `targetId: number | null` — homing target, monster-only in practice
- `path`/`pathIndex`/`repathAtTick`/`pathGoal` — A*/string-pulled route state
  when line-of-sight to the target is blocked (spec 065)
- `cast: CastState | null`, `cooldowns` — monsters cast through the *same*
  ability system players do (`sim/abilities.ts`); there is no separate
  monster-attack code path
- `zoneId`, `radius`, `resource` (monsters have `maxResource: 0` so this is
  inert), `claimedPosition`/`claimedSeq`/`pardon` (player-prediction fields,
  unused for monsters but present because it's one struct)

`ServerWorldState { tick, entities: ReadonlyMap<number, ServerEntity>,
nextEntityId, rng: Rng }` — insertion-ordered map, deterministic iteration.

**Creation**: `spawnEntity(state, spec: SpawnSpec)` (sim/world.ts:147) is the
general constructor (used for players and ad hoc spawns). The *ambient*
monster spawner is `runSpawner` (sim/world.ts:751), called as step 5 of every
tick from `step()`. It:
- iterates each zone's `activeChunks` (chunks with >=1 player nearby, from
  `ChunkManager`), skips chunks at/over `config.maxEntitiesPerChunk`
- looks up the zone at the chunk centre (`ZoneManager.zoneAt`); skips zones
  with `spawnMultiplier <= 0` or an empty `spawnTable`
- picks a monster id via `rng.nextInt` from `zone.spawnTable` (weighted only
  by list repetition, not by explicit weight), a random position inside the
  chunk, cadence gated by `config.spawnIntervalTicks / (spawnRateMultiplier *
  zone.spawnMultiplier)`, offset per-chunk by a hash so chunks don't all spawn
  the same tick
- builds a `ServerEntity` directly (not via `spawnEntity`, inlined) with
  `kind: EntityKindValue.Monster`, health = `definition.stats.maxHealth`,
  emits a `{ kind: 'spawned', entityId, typeId }` event

`DEFAULT_ZONES` (src/server/world/zone-manager.ts) wires spawn tables:
Hearthstead (spawnMultiplier 0, no table = safe zone), a general zone
`['grazer', 'stalker']`, and `WILDERNESS` fallback `['grazer', 'stalker',
'ravager']` at 1.5x. Config knobs live in src/server/config.ts (all
admin-tunable `LiveConfig`, defaults `spawnRateMultiplier: 1`,
`maxEntitiesPerChunk: 40`, `spawnIntervalTicks: 300` = 5s at 60Hz).

**Ticking** happens inside `step()` (sim/world.ts:220), fixed order per the
top-of-file comment: 1) expire timers, 2) movement (players from input,
monsters from `monsterIntent`), 3) casts in entity-id order, 3b) projectile
flight/impact, 4) death/despawn, 5) ambient spawner. Only entities in
`context.activeChunks` (or players) are simulated — an unloaded chunk's
monsters are frozen, not ticked (cost tracks player proximity, not map size).

**Damage/death**: `applyDamage` (sim/abilities.ts:662) is the single damage
function for every attacker/target pair (melee cone, single-target melee,
projectile, blast). It rolls crit off `attacker.stats.critChance` via the
threaded `Rng`, applies `applyArmor` (src/server/player/stats.ts), clamps
health to >=0, and if `health <= 0`: sets `killed = true`, force-interrupts
any cast the target had (`castEnded`/Interrupted event — the one case damage
still breaks a cast, since spec 068 removed the general "any hit interrupts"
rule), and emits a `died` event with `killerId`. It also does the retaliation
write: `targetId: target.targetId ?? attacker.id` — **being hit sets a
target's `targetId` to its attacker if it had none**, which is how a passive
monster (aggroRange 0) starts fighting back once struck.

Once `health <= 0`, `step()`'s step-4 pass (sim/world.ts:502) sets
`activity: Dead` and, for non-player entities, stamps `activityUntilTick =
tick + CORPSE_TICKS` (5s); once that passes the entity is deleted from the
map and a `despawned` event fires. Player entities are never deleted (kept at
Dead so the client's own entity id survives — respawn logic lives in
`server.ts`'s `handleRespawns`, not in the sim).

`isHostile(attacker, target, zones)` (sim/world.ts:202): players vs monsters
always hostile; same-kind hostile only for players in a pvp zone; Prop and
Projectile entities are never targets/attackers.

## 3. AI / aggro / targeting — sim/world.ts:565 monsterIntent()

There is no separate "AI system" file — targeting/steering/attacking is all
one function, `monsterIntent(monster, entities, tick, context)`
(sim/world.ts:565), called once per monster per tick from inside `step()`'s
movement pass, and it returns a `ServerInput`-shaped intent so **the rest of
the pipeline (movement resolution, cast commit) cannot tell a monster's
intent from a player's input** — same code path, same rules, same
interruptibility.

Logic:
1. Keep current `target` (from `entities` by `monster.targetId`) if alive.
2. If no target and `aggroRange > 0`: linear scan of all entities, nearest
   living Player within `aggroRange` wins (`<=` comparison, so ties favor
   later iteration order — insertion order of the map).
3. No target at all -> stand still, `forgetPath`.
4. Compute `reach` = `(ability.range + target.radius) * STANDOFF_FRACTION`
   (0.8) using the monster's `ability` from its definition (falls back to
   `monster.stats.attackRange` if no ability id resolves).
5. If beyond reach: `routeToward` (A*/string-pull via `sim/pathfinding.ts`,
   replans on `PATH_REPLAN_TICKS` cadence or when the target moves >
   `REPLAN_DISTANCE` (48u) from where the route was planned); else stop and
   face the target.
6. `wantsToSwing = !closing && monster.cast === null && swing !== null` ->
   sets `castAbilityId`/`castTargetX/Y`/`castTargetEntityId: target.id` on
   the synthesized input, which then flows through the *same* `startCast`/
   `advanceCast` machinery a player's cast does (turn-then-windup, cooldowns,
   etc, per spec 065/070/062).

Notable: `monster.targetId` is **read** here but this function never writes
it back explicitly — the only place `targetId` is ever set on an entity is
the retaliation write in `applyDamage` above, plus it's cleared to `null` at
spawn/respawn. So "aggro" for an active monster (aggroRange > 0) is really
re-derived every tick from nearest-player-in-range rather than sticky state;
only a *passive* monster's retaliation target sticks (since nothing else
would ever populate `targetId` for it once it's been hit).

## 4. Wire serialization — src/server/net/

- `src/server/net/protocol.ts` — `EntityKind` (mirrors `EntityKindValue`),
  `EntityField` bitmask: `Spawn=1<<0, Position=1<<1, Facing=1<<2, Health=1<<3,
  Activity=1<<4, Level=1<<5`. Note there is **no bitmask for `targetId`,
  `cast`, or monster-specific fields** in the delta — a monster's cast state
  goes out separately as `CastState`/`CastEnded` messages (dispatched from
  the `castStarted`/`castEnded` sim events in `server.ts`), not as part of
  the entity delta.
- `src/server/net/messages.ts:275` — `EntityDelta`:
```ts
export interface EntityDelta {
  readonly id: number;
  readonly fields: number;
  readonly kind?: number;
  readonly typeId?: string;
  readonly position?: Vec3;
  readonly facing?: number;
  readonly health?: number;
  readonly maxHealth?: number;
  readonly activity?: number;
  readonly activityUntilTick?: number;
  readonly level?: number;
}
```
  `DeltaMessage { type, tick, ackInputSeq, removed: number[], upserts:
  EntityDelta[] }`.
- `src/server/net/delta.ts` — `class DeltaTracker`, one per connection.
  `build(tick, ackInputSeq, visible: ServerEntity[])` diffs against
  `known: Map<id, KnownEntity>` (quantized epsilons: position 0.01, facing
  0.001 rad, health 0.01) and emits only changed fields; first sighting of an
  id always sends the `Spawn` bit plus every field (kind, typeId, position,
  facing, health/maxHealth, activity, level). `visible` is precomputed by the
  caller from `ChunkManager.interestSet` — DeltaTracker itself does no
  interest filtering.
- `CombatResultMessage` (0x-coded, `ServerMessageType.CombatResult`) carries
  `attackerId, targetId, damage, targetHealth, flags` (killed/critical/
  blocked bits) — sent separately from Delta, immediately, to any connection
  whose interest set contains attacker or target (`server.ts` `dispatchEvents`
  'hit' case).
- `CastStateMessage`/`CastEndedMessage`/`EffectMessage` similarly ride
  outside Delta, built straight from the sim's `castStarted`/`castEnded`/
  `effect` events in `server.ts:dispatchEvents`.
- `died` event handling (server.ts ~925): only grants XP (`killer =
  players.byEntityId(event.killerId)`, `victim.kind === Monster`,
  `monsterById(victim.typeId).experience`, async `players.grantExperience`)
  — it does not itself remove the entity; despawn is the sim's corpse timer
  (`CORPSE_TICKS`) producing a `despawned` event, which the delta's `removed`
  array picks up as visibility drops (entity deleted from `working` map so it
  falls out of every future `interestSet`/`visible` list).

## 5. Client receipt — src/server/client/

- `src/server/client/replica.ts` — `ReplicatedEntity`:
```ts
export interface ReplicatedEntity {
  readonly id: number;
  readonly kind: number;
  readonly typeId: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly facing: number;
  readonly health: number;
  readonly maxHealth: number;
  readonly activity: number;
  readonly activityUntilTick: number;
  readonly level: number;
}
```
  `class ReplicatedWorld` — `apply(tick, removed, upserts)` mirrors
  `DeltaTracker` exactly (same field bits), `get(id)`, `all()` (insertion
  order), `clear()`. No `targetId`/cast/AI state — a monster's cast is
  tracked client-side separately by `GameClient` from `CastState`/
  `CastEnded` messages (`this.casts: Map<entityId, KnownCast>`), not through
  the replica.
- `src/server/client/game-client.ts` — `class GameClient`. `view(): ClientView`
  (line 845) assembles the read-only projection:
  `entities: readonly ReplicatedEntity[]` = `this.world.all()`, plus
  `casts: readonly KnownCast[]` (server casts + this client's own predicted
  cast merged, `visibleCasts()`), `self`/`selfEntityId` (local player
  prediction), `worldSeed`, `map`, `stats`/`level`/`experience`/
  `unspentSkillPoints` (local player only), `cooldowns`, `resource`. There is
  **no monster-specific projection** — a monster is just another
  `ReplicatedEntity` with `kind === EntityKind.Monster` and a `typeId` the
  renderer looks up in its own appearance table (not traced here — see
  `src/render/iso3d/world/appearance.ts` per CLAUDE.md's directory notes).

## Data flow summary (spawn -> death)

1. `runSpawner` (sim/world.ts, step 5) picks a zone's `spawnTable` entry via
   the tick's `Rng`, builds a `ServerEntity` with `kind: Monster`, inserts it
   into `working`, emits `spawned`.
2. Every tick, `monsterIntent` (sim/world.ts) re-derives a target (sticky
   `targetId` if alive, else nearest player in `aggroRange`), synthesizes a
   `ServerInput`-shaped intent (move + optional `castAbilityId`), which flows
   through the *same* `resolveMovement`/`startCast`/`advanceCast` code a
   player's input does.
3. A landed hit goes through `applyDamage` (sim/abilities.ts) — clamps
   health, sets `targetId` on the victim if it had none (retaliation), emits
   `hit` and, at 0 health, `died`.
4. `server.ts:dispatchEvents` turns `hit` into an immediate `CombatResult`
   message to interested connections, and `died` into an XP grant to the
   killer (no entity removal here).
5. The corpse lingers `CORPSE_TICKS` (5s) in `Dead` activity, then step-4 of
   `step()` deletes it from `working` and emits `despawned`.
6. Per-connection `DeltaTracker.build()`, filtered by `ChunkManager
   .interestSet`, diffs the entity against what that client last knew and
   puts changed fields in the next `Delta` (broadcast every 3rd tick / 20Hz);
   the entity's removal shows up as an id in `removed`.
7. Client-side, `ReplicatedWorld.apply()` mirrors that diff into
   `ReplicatedEntity` records; `GameClient.view().entities` is what the
   renderer draws monsters from.

## Open questions / things to check before editing

- No dedicated "AI state machine" type exists — `targetId` plus the read of
  `aggroRange`/`ability` from the static `MonsterDefinition` *is* the AI
  state. Adding new behaviours (fleeing, patrol, ability variety per
  monster) means extending `monsterIntent` directly; there's no plugin point.
- `MonsterDefinition.ability` is singular (one ability per monster) — no
  ability rotation/selection logic exists.
- The wire format has no field for a monster's target or AI state at all;
  the client only ever sees position/facing/health/activity/level — worth
  confirming before assuming a client could render e.g. "who is this monster
  attacking" without a new protocol field.
- `runSpawner`'s per-type weighting is just list repetition in `spawnTable`,
  not an explicit weight field — if per-monster spawn weights are wanted,
  `zone-manager.ts`'s `ZoneDefinition.spawnTable: readonly string[]` shape
  would need to change.
