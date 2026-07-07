# 012 — Enemy population: spawner, types, death, grazing AI, camera

## Problem

Combat is a fixed 1-on-1 in a small static arena with a hardcoded camera. This
spec grows it into a small living arena: a handful of enemies of a few types
spawn and die, most of them minding their own business (grazing like sheep)
until the player picks a fight, on a larger green map that scrolls under a
camera that follows the player with a little lag.

Six connected changes, sim first then render. Determinism (spec 003) must hold
throughout: everything random — spawn timing/type/position, graze targets and
pauses — is drawn from the sim's seeded `Rng`, which until now was threaded but
never used.

## 1. Multiple enemies + types (sim)

`CombatState.enemy` becomes `enemies: readonly EnemyState[]`. Each `EnemyState`
gains:
- `id: number` — stable identity for the renderer's sprite pool; assigned from
  a monotonic `CombatState.nextEnemyId`.
- `type: string` — key into `ENEMY_TYPES` (`src/sim/enemies.ts`): a few types
  (`brawler`, `skitter`, `brute`) differing in health, attack damage, and move
  speed. The type string is also the sprite seed (spec 011), so each type looks
  distinct for free.
- behaviour fields (below).

Shared arena constants (`ENEMY_RADIUS`, attack radius/windows, windup/recovery
durations) stay global to avoid per-type collision/telegraph rework; only
health / damage / speed vary by type.

## 2. Spawner + cap (sim)

`CombatState` gains `nextSpawnTick`. `initCombat` seeds a couple of grazing
enemies. Each tick, if `tick >= nextSpawnTick` and `enemies.length <
MAX_ENEMIES` (a few, e.g. 5), spawn one enemy: random type, random position at
least `SPAWN_MIN_PLAYER_DIST` from the player, behaviour `grazing`; then
`nextSpawnTick = tick + ENEMY_SPAWN_INTERVAL_TICKS`. All draws thread `rng`.

## 3. Death (sim)

- Enemy: when health reaches 0 it is **removed** from `enemies` and an
  `enemyDefeated { id, type }` event fires (the spawner refills over time). The
  killing blow still emits its `enemyHit`.
- Player: when health reaches 0, `CombatState.over` becomes `true` and
  `playerDefeated` fires once. While `over`, `step` is inert — a terminal
  game-over freeze (no respawn in scope); the renderer shows a banner.

## 4. Behaviour: passive until attacked, else graze (sim)

`EnemyState.behavior: 'grazing' | 'hunting'`.

- **grazing** (default, and how every enemy spawns): the enemy ignores the
  player and wanders like a grazing animal — pick a random nearby graze target
  (`grazeTarget`), amble to it at `grazeSpeed`, then stand and "eat" for a
  random pause (`grazeResumeTick`) before picking the next. It never attacks.
- **hunting**: entered the moment the enemy first takes damage from the player
  (melee or an active card). Now it homes toward the player and runs the
  existing attack state machine (`idle → windup → recovery`) — the current
  enemy behaviour, per type stats. Once hunting, it stays hunting until death.

Graze wandering and pauses draw from `rng`; the transition is purely "took
damage → hunting", so a replay of the same inputs reproduces it exactly.

New/!changed `EnemyState` fields: `behavior`, `grazeTarget: Vec2 | null`,
`grazeResumeTick`. The combat `phase`/`phaseEndsAtTick`/`incomingAttackOutcome`
/`attackZoneCenter` fields are only meaningful while hunting.

Player melee is now a **cleave**: one swing hits every enemy inside reach and
the aim cone (each takes damage, each can die), so a swing into the herd wakes
and can strike several. Defense (parry/dodge) registers against the hunting
enemy whose windup is most imminent (nearest `phaseEndsAtTick`).

`enemyHit` gains the hit enemy's `id` and world position (so the renderer can
place the damage popup even when that enemy dies and leaves `enemies` the same
tick). `enemyDefeated` gains `id` and `type`.

## 5. Larger arena + green map (constants + render)

`ARENA_WIDTH`/`ARENA_HEIGHT` grow to roomy values (e.g. 1200×900) so the
population and grazing read. The renderer draws a **green grassy field** (base
fill + a lightly seeded, deterministic tile/texture pattern) covering the arena,
with a border, replacing the flat dark rectangle.

## 6. Lag-follow camera (render only)

A `Camera { x, y }` in world space eases toward the player each frame
(`cam += (player - cam) * CAMERA_LAG`), clamped so the view stays within the
arena. `worldToScreen` becomes camera-relative: world point → screen =
`(world - cam) * SCALE + screenCenter`, keeping the player near centre with the
map sliding under them and a slight trailing lag. World-space layers (map,
telegraphs, actors, popups) move with the camera; the HUD (hand, passives, log,
banner, prompt) stays screen-fixed. No game rules move into the renderer; the
camera is pure presentation and never feeds back into the sim.

## Invariants tested (sim, pure Node)

- **Determinism:** same seed + inputs ⇒ identical final `enemies` (positions,
  ids, types, behaviour) and events — grazing and spawns included.
- **Spawn cap:** `enemies.length` never exceeds `MAX_ENEMIES`; the count refills
  after kills but never overshoots.
- **Passive until attacked:** an untouched enemy never enters `hunting`, never
  emits `playerHit`; after it takes a player hit it becomes `hunting` and can.
- **Grazing bounds:** grazing enemies stay within the arena and only move at
  graze speed.
- **Death:** a lethal blow removes the enemy and emits `enemyDefeated`; lethal
  damage to the player sets `over` and emits `playerDefeated` once, after which
  `step` is a no-op.
- **Cleave:** one swing can hit multiple enemies in the cone.

## Out of scope

- Enemy-vs-enemy interaction, flocking, or fleeing; hunting never reverts to
  grazing; no player respawn.
- Per-type radius/telegraph shapes; camera zoom or screen-shake.
- Multiplayer / more than one player.
