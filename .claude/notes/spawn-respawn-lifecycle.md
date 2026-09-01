# Spawn / respawn lifecycle, server -> wire -> client (traced 2026-09-01)

Companion to `.claude/notes/monsters-npcs.md`, which already covers monster
spawning (`runSpawners`, `ServerEntity` fields, `MonsterDefinition`) in depth
-- read that first for §1-4 below. This note adds what it doesn't cover:
player respawn, what actually crosses the wire for a spawn/respawn, and the
client-side entity-add/remove sweep pattern.

## 1. Monster spawn — pointer into the other note

`runSpawners` (`src/server/sim/world.ts:2764-2895`), pass 5 of `step()`
(last pass of a tick). Builds an entity by spreading `blankEntity(id)` then
overriding kind/typeId/position/health/zoneId/stats/radius/resource/poise/
spawnerId/anchor/leashRadius (world.ts:2865-2887). **No RNG draw.**

**No spawn/activation delay exists.** `blankEntity` (world.ts:124-184) sets
`activity: ActivityValue.Idle`, `aggro: AggroValue.Calm`, `targetId: null` —
there is no "warming up" flag or grace-tick field anywhere on `ServerEntity`.
`isHostile` (world.ts:474-512) has no spawn-age check, so a body is
attackable the instant it exists; `idle()` (`sim/idle.ts:110-125`) and
`monsterIntent` (world.ts:2120-2235) run on it starting the *next* tick
(runSpawners is the last pass of the tick it was created in), which is an
artifact of pass ordering, not a designed delay. Full health/poise/resource
from the first tick.

A `ServerSimEvent` of `kind: 'spawned'` is pushed at world.ts:2891 (and at
1293, 1559, 1815 for projectiles/motes) — see §3, it is a sim-internal
bookkeeping event and is a no-op on the wire.

## 2. Player respawn — `src/server/server.ts`

- Client → server: `ClientMessageType.Respawn` (no payload), handled at
  server.ts:815-820, calls `this.respawn(connection)` (server.ts:819).
  Ignored silently from a living body.
- `private respawn(connection: Connection): boolean` — server.ts:2994-3052.
  **Reuses the existing entity id via `replaceEntity`, never re-creates.**
  Refuses (`return false`) unless `entity.health <= 0`.
- Fields reset (server.ts:3003-3039), all via one `replaceEntity(this.state,
  { ...entity, ... })`:
  - `position` — `this.clearSpawnNear(DEFAULT_SPAWN, entity.id)` (Vec2 ring
    search dodging other live players, `PLAYER_BODY_RADIUS * 2.5` apart,
    server.ts:2907-2919) + `terrain.heightAt`. `DEFAULT_SPAWN = { x: 600,
    y: 450, z: 0 }` (`src/server/player/player-manager.ts:76`).
  - `health` → `session.stats.maxHealth`; `fallbackCharges` →
    `entity.stats.traits.fallbackCharges`; `restoration` → 0.
  - `statuses` → `clearStatus(clearAfflictions(entity.statuses),
    StatusId.SecondWindSpent)` — **afflictions and Second Wind's spent-mark
    only; boons (Flow, Attunement, etc.) survive death.**
  - `activity` → `Idle`, `activityUntilTick` → 0.
  - `targetId`/`path`/`pathIndex`/`repathAtTick`/`pathGoal` → cleared.
  - `claimedPosition`/`claimedSeq` → cleared (else the first input after
    respawn reads as a cross-map teleport claim).
  - `pardon: { x, y, seq: connection.lastSeq }` — pre-authorizes the
    client's next claim at the new position, same mechanism a normal
    correction pardon uses.
  - No `Rng` draw anywhere in this path.
- `this.chunks.place(entity.id, position.x, position.y, true)` (chunk/interest
  re-placement) and `this.players.syncFromEntity(...)` (persistence-facing
  copy) — server.ts:3040-3041.
- Answered with `ServerMessageType.Correction` at `reason:
  CorrectionReason.Teleport` (server.ts:3044-3050) — **sent only to the
  respawning connection** (`this.send(connection, ...)`, singular, not
  broadcast). `CorrectionReason.Teleport = 3` (`net/protocol.ts:595`) is the
  *same* value used for an admin teleport (protocol.ts's own comment: "An
  admin moved them") — respawn reuses it rather than adding a 5th reason.
  PROTOCOL.md:365-366's per-value gloss ("`3` admin teleport") predates this
  reuse and doesn't mention respawn by name; PROTOCOL.md's own `Respawn`
  section (line 253-267) does say "answered with a `Correction(Teleport)`".
- **No respawn timer.** PROTOCOL.md:267: "There is no respawn timer. A dead
  player lies there until they ask." (spec 164 removed the old
  `handleRespawns`, see doc comment at server.ts:2953-2961.) The admin
  console's own HTML (`src/server/admin-client/index.html:302-303`) still has
  a stale comment claiming "a dead player is respawned at full health by the
  server after RESPAWN_DELAY_TICKS" — that field/behavior no longer exists;
  the comment is dead documentation, not implemented behavior (grep for
  `RESPAWN_DELAY_TICKS` across `src/` turns up nothing).
- Client side: `GameClient.respawn()` (`src/server/client/game-client.ts:
  1306-1309`) just sends the message — **no client-side prediction of
  respawn** (doc comment 1297-1305: "a predicted respawn would be the one
  prediction that could not be rolled back honestly"). The client stays
  drawn dead until the `Correction` + delta actually arrive.
- Other, *remote* observers of the respawning body get no special message at
  all: the next `Delta` broadcast just carries an ordinary upsert with
  `EntityField.Position | Health | Activity` changed (§3) — ordinary field
  deltas, indistinguishable on the wire from a plain heal-and-walk.

## 3. What crosses the wire — `src/server/net/`

**There is no explicit "this entity spawned" wire message for a monster
spawn or a player respawn.** Two independent things can look like one and
neither is:

- `ServerSimEvent.kind === 'spawned' | 'despawned'` (`sim/types.ts:973-974`)
  is a **sim-internal** event pushed on real spawns (monster: world.ts:2891;
  projectile: 1293; mote: 1559, 1815) and removals (world.ts:1302, 1426,
  1564, 1578, 1933, 2052). `GameServer.dispatchEvents`
  (server.ts, switch around 3054-3229) explicitly no-ops both:
  `case 'spawned': case 'attackMissed': break;` (server.ts:3226-3228) and
  `case 'despawned': break;` (3207-3213, comment explains why: forgetting
  here would suppress the delta tracker's own withdrawal). Consumed only by
  a dev script (`scripts/probe-attack.ts:503`), not by anything that reaches
  a client.
- `EntityField.Spawn` (`net/protocol.ts:466-468`, bit `0x01`) is a
  **delta-encoding flag**, not a game event: `DeltaTracker.build`
  (`net/delta.ts:171-312`) sets it whenever an entity has no `known` entry
  for *this connection* yet (delta.ts:188-227) — "first sight for this
  client", which fires identically whether the entity was created a
  millisecond ago or has existed for an hour and this client just walked
  into interest range. It forces every field onto the wire (position,
  facing, health, activity, level, poise, shield, + statuses/moveScale/
  identity if non-default) — see delta.ts:190-226 and PROTOCOL.md:306-329.
  `removed` (delta.ts:305-309) is the mirror: any id previously `known` and
  not `seen` this build is pushed onto `removed` and dropped from `known`.
- Respawn crosses as an ordinary upsert (Position+Health+Activity fields)
  **plus** an out-of-band `Correction(Teleport)` sent only to the owner
  (§2) — nothing marks it as a respawn for anyone else.
- `client/replica.ts`'s `ReplicatedWorld.apply` (67-172) is the client-side
  mirror: an upsert for an unknown id **without** the Spawn bit is dropped
  outright (89-92, 101) — "the server only omits identity for something it
  believes we already have; receiving one is a desync." An upsert *with*
  Spawn constructs a fresh `ReplicatedEntity` (102-122); `removed` ids are
  `this.entities.delete(id)` (96).

So: **the client infers a spawn purely from an id appearing in
`ReplicatedWorld`'s persistent Map for the first time** (which happens to
coincide with the Spawn bit being set, but that bit is a bandwidth
optimization the render layer never reads directly — see §4). There is no
discrete "entity spawned" callback anywhere in the render code.

Full field-flag table, message ids and `CorrectionReason` values:
`src/server/net/PROTOCOL.md:253-267` (`0x1a Respawn`), `:296-357` (`0x41
Delta`), `:359-373` (`0x42 Correction`). Enum source of truth:
`net/protocol.ts:466-527` (`EntityField`), `:587-602` (`CorrectionReason`).

## 4. Client: entity add/remove — `src/render/iso3d/world/scene.ts`

No `syncEntities`/`onSpawn` function exists; the mechanism is a **per-frame
diff sweep** inside `WorldScene.syncBodies(view, frame, dt)`
(scene.ts:2057+), called every render frame from `render()` (via
`this.observe(view)` at 1730 for the interpolation side, and `syncBodies`
itself elsewhere in `render()`):

- `private observe(view: ClientView): void` (scene.ts:2045-2055) — feeds
  every `view.entities` id into `EntityMotion.observe` (position sampling
  for interpolation), then calls `retain(live)` on three per-body trackers:
  `this.motion.retain(live)` (`interpolate.ts:320` `EntityMotion.retain`),
  `this.turnEase.retain(live)`, `this.staggerFlinches.retain(live)`. **This
  is one of the two idioms**: hand the tracker the full live-id `Set` every
  frame and let it prune internally.
- `syncBodies` (2057-2340) is the other, more elaborate idiom, used for
  everything that owns a three.js object or a pooled vfx instance:
  1. Builds `const live = new Set<number>()` (2058).
  2. `for (const entity of view.entities)` (2094+): `live.add(entity.id)`
     (2100), then `const body = this.bodyFor(entity.id, look)` (2102).
     `bodyFor` (`private bodyFor(id, appearance): Body`, scene.ts:2829-...)
     is create-if-absent: `const existing = this.bodies.get(id); if
     (existing) return existing;` (2830-2831) — **this is the entire "new
     entity" detection**: a body/rig is built the first frame an id is seen
     in `view.entities` with no matching entry in `this.bodies`, whether
     that's a genuine spawn, a respawn (id already known, so `bodyFor`
     returns the existing rig — no rebuild), or simply walking back into
     view. `bodyFor` picks a rig kind (authored `UnitRig` at 2842+, player
     `CritterRig` at 2892+, `ShotRig` for projectiles at 2913+, procedural
     `MechRig` fallback) and calls `this.scene.add(...)`.
  3. Same loop calls the per-body vfx drivers every frame regardless of
     whether anything changed (idempotent `step` calls) —
     `this.swings.step(...)` (2229), `this.afflictions.step(...)` (2244),
     `this.auras.step(...)` (2276) — see below.
  4. **Despawn sweep**, right after the loop (scene.ts:2316-2340):
     `for (const [id, body] of this.bodies) { if (live.has(id)) continue;
     ...dispose...; this.bodies.delete(id); }` — removes the three.js group
     from the scene, disposes a projectile's trail/mesh, drops a held
     weapon, and calls `forget(id)` on every per-body driver:
     `this.afflictions.forget(id)` (2332), `this.swings.forget(id)` (2333),
     `this.auras.forget(id)` (2334), `this.shots.forget(id)` (2338).

### The driver pattern (`step` + `forget`, handles not ids)

Three drivers share one documented shape (doc comment at
`affliction-vfx.ts:333-358` states it explicitly; `shot-vfx.ts` and
`aura-vfx.ts` follow the same shape):

- `AfflictionVfx.step(body: AfflictedBody, statuses, tick): void`
  (`world/affliction-vfx.ts:369-434`) / `.forget(entityId): void` (437+).
  Keyed by entity id in `private readonly owned = new Map<number,
  Map<string, Owned>>()` (360-363).
- `ShotVfx.step(body: ShotBody): void` (`world/shot-vfx.ts:141`) /
  `.forget(entityId): void` (175).
- `AuraVfx.step(...)` (`world/aura-vfx.ts`), same shape (called at
  scene.ts:2276, forgotten at 2334).

Why not the simpler `retain(live)` idiom: `play`/`start` on the underlying
pooled particle system returns `0` on refusal (unknown id, over instance
budget, beyond cull distance), and a full instance pool **evicts** rather
than refusing (bumps the slot's generation) — so these drivers hold a
*handle* (not an id) and re-check `isLive(handle)` every `step()` call
(e.g. affliction-vfx.ts:400), letting a refused/evicted effect quietly retry
next frame instead of being permanently marked "started". The stop is
**owed**: nothing in the particle system stops itself on despawn, so
`forget` — called only from the scene's despawn sweep, never inferred from
an entity's absence in a single frame — is what releases the pool slot.

`FireVfx` is the odd one out and is the useful contrast: `.step(sites:
readonly FireSite[]): void` (`world/fire-vfx.ts:90`) takes a **list of
fixture sites**, not per-entity calls, because a campfire is a *prop*
(map-baked, tied to chunk/ground residency) not a `ServerEntity` — there is
no entity id to key on at all. It reconciles against `this.fireSites`
(rebuilt from held ground, scene.ts:3727 `this.fires.step(this.fireSites)`)
and has no `forget(id)`, only `forgetAll(): void` (fire-vfx.ts:112) for a
full scene teardown (`this.fires.forgetAll()` at scene.ts:1949).

## 5. Admin/dev spawn tools

**Wire** (`src/server/admin/router.ts`, `AdminHost` interface at 76-92):
- `spawnEntities(entityType: string, x: number, y: number, count: number):
  number` — implemented at `server.ts:3485-3509`. Calls the general-purpose
  `spawnEntity(this.state, {...})` (world.ts, not `runSpawners`'s inline
  path), fanned out on a ring (`spread = definition.radius * 2.5` per unit
  past the first) so a batch doesn't stack. Capped at 200
  (`Math.min(200, count)`). **No `spawnerId`/`anchor` set** — an
  admin-spawned monster has no leash, no home, and `idle()`
  (`sim/idle.ts:110-125`) returns `goal: null` for any monster with no
  anchor, so it never wanders; it only moves if aggroed.
- `despawnEntity(entityId: number): boolean` — server.ts:3511-3519, calls
  `removeEntity` + `this.chunks.remove(entityId)`; comment notes it
  deliberately does *not* call `delta.forget` (the next delta's own
  `removed` list handles it, per §3).
- Wire opcodes: `0x86 admin:spawnEntity` (`str entityType, f32 x, f32 y, u16
  count`), `0x87 admin:despawnEntity` (`varuint entityId`) —
  `net/PROTOCOL.md:774-775`.
- `triggerEvent(eventName: string, x, y, magnitude): string` —
  server.ts:3566-3894, opcode `0x88` (PROTOCOL.md:776). Full vocabulary
  (`case` labels in the switch): `raid`, `clear`, `status`, `affliction`,
  `field`, `drop`, `reveal`, `heal`, `meter`, `charges`, `elite`. Two are
  spawn-flavored:
  - `'raid'` (server.ts:3568-3578): `spawnEntities('ravager', x, y, count)`
    where `count = clamp(round(magnitude), 1, 50)`, plus a system chat
    broadcast.
  - `'elite'` (server.ts:3880-3890): picks the highest-`experience` row
    `isEliteType` classifies as elite out of `ALL_MONSTERS`, then
    `spawnEntities(elite.id, x, y, max(1, round(magnitude || 1)))`.
  - `'clear'` (3579-3588) is the despawn counterpart: despawns every
    Monster-kind entity within `magnitude` units of `(x, y)`.

**Admin console UI** (`src/server/admin-client/index.html`, static page,
hand-rolled binary codec — see CLAUDE.md's own note that this is the one
surface with no shared codec with the server): a "world tools > entities"
panel with `monster`/`x`/`y`/`n` fields and a `spawn` button (lines
332-339, wire helper at line 1019), plus `entity id` + `despawn` button
(340-341, line 1020). A separate "events" panel has an `eventName` `<select>`
+ `x`/`y`/`mag` fields + `fire` button (346-360, wire helper line 1021).
**The `<select>` only lists 3 of the 11 server-side event names**: `raid`,
`clear`, `heal` (lines 350-352, static `<option>`s, nothing populates more
at runtime) — `elite`, `status`, `affliction`, `field`, `drop`, `reveal`,
`meter`, `charges` are reachable only by driving the protocol directly
(tests, `scripts/probe-*.ts`, or editing the `<select>`'s value in devtools),
not from this dropdown.

**Test/browser harness**: `scripts/probe-admin-console.ts` drives the real
console in Playwright against a real server + bots (doc comment at
top: "the console is a static HTML file with a hand-written codec, so its
encoder is not the server's encoder and no test in the suite imports it").

**Not present**: no `?spawn=`/`?monsters=` render-side query flag that
spawns real `ServerEntity` monsters. The render-side `?`-flags found
(`?units=` in `world/view.ts:394-395`, `?field=` in `view.ts:650` and
`aura-vfx.ts:173,190`) are presentational-only (which rig draws a type;
forcing a status/aura visual on the local player) and touch nothing in
`src/server/sim/`.

## Open questions
- Whether anything server-side ever reads `ServerSimEvent.kind === 'spawned'`
  besides `probe-attack.ts` (metrics.ts does not) — not fully swept; grep
  `'spawned'` in `src/server` if it matters later.
- `hello()` (server.ts:1113+) spawns a fresh login character via the same
  `spawnEntity(this.state, {...})` general path (server.ts:1340) rather than
  `runSpawners`'s inline construction — not traced field-by-field here since
  the question was about monster spawn + player *respawn*, not first login.
