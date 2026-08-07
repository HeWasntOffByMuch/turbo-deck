# Combat / auto-attack system map (as of spec 072-era code)

Traced 2026-08-06. Re-read source before relying on line numbers for edits;
this is a map, not a substitute for the files.

## 1. Attack lifecycle

**Render side (issuing an order)**
- `src/render/iso3d/world/target.ts` — pure `autoAttack(input): AutoAttack`.
  Given self pos, target snapshot, basic-attack range, `rooted`, and
  `readyAtTick`, decides `chaseTo` (where to walk to close range, or null),
  `attack` (bool: ask to swing this tick), `drop` (target is dead/gone).
  Standoff is `STANDOFF_FRACTION = 0.8` of reach.
- `src/render/iso3d/world/view.ts` owns the actual mutable state: `targetId`,
  `destination`, a `RoutePlanner`. `driveAutoAttack()` (line ~364) calls
  `autoAttack()` every render tick, sets `destination = decision.chaseTo`,
  and on `decision.attack` calls `client.useAbility(swingId, entity.x,
  entity.y, entity.id)` — note the 4th arg, the target's entity id (spec 070:
  attacks are single-target by id, not just cone-aimed).
  - Right-click on an attackable entity sets `targetId`, clears `destination`.
  - Right-click on empty ground sets `destination`, clears `targetId`.
  - Any WASD key, or Escape, or opening a hotbar slot (`useAbility`) clears
    `destination`/`targetId`/planner — "taking control back" (view.ts:264-286).
  - Escape also calls `client.cancelCast()`, which is the *only* client action
    that sends `CancelCast` explicitly.
- `src/render/iso3d/world/intent.ts` — pure `moveIntent(input): MoveIntent`.
  Turns held keys / standing destination / route waypoint into a per-tick
  `{moveX, moveY, facing}` sent as `InputMessage`. Critically: if
  `input.castAim` is non-null (i.e. `view.selfRoot`, meaning the client
  believes it is casting — server-confirmed or self-predicted), it *always*
  returns `moveX:0, moveY:0` and aims facing at the cast's captured target,
  regardless of held keys. This mirrors the server's root so prediction
  doesn't diverge every tick of a wind-up.
- `src/render/iso3d/world/cast.ts` — pure `castBar()`: turns a `CastState`-like
  object + current (fractional) tick into 0..1 progress for the UI, using the
  ability table's `windupTicks`/`channelTicks` (never a wire-sent duration).

**Wire (client -> server)**
- `net/protocol.ts`: `ClientMessageType.UseAbility = 0x08`,
  `ClientMessageType.CancelCast = 0x09`.
- `net/messages.ts`: `UseAbilityMessage { abilityId, targetX, targetY,
  targetEntityId, afterInputSeq }`, `CancelCastMessage { afterInputSeq }`.
  `afterInputSeq` pins the commit to a specific input tick so the client's own
  predicted root lines up exactly with the server's (spec 067).

**Server-side state machine** — `src/server/sim/abilities.ts`
- Cast shape, all kinds: `commit -> [turning] -> windup (cancellable) ->
  release -> [channel pulses] -> free`. `CastPhase = {Windup:0, Channel:1,
  Turning:3}` (`src/server/sim/types.ts:38`).
- `CastState` (types.ts:61-86): `abilityId`, `startedTick`, `releaseTick`
  (tick the effect lands), `endTick` (tick caster is free, except channel
  pulses run past it), `phase`, `targetX/Y` (aim captured at commit, never
  re-read), `targetEntityId` (0 = point aim only), `nextPulseTick` (channel).
- `startCast(entity, attempt, tick)`: validates ability exists, not dead, not
  already casting, off cooldown, has resource, in range if point-targeted.
  Spends cost and stamps cooldown **at commit**, not release (so cancelling
  refunds exactly the time spent, never makes cancel strictly better than not
  casting). If the body isn't yet facing the aim, phase starts as `Turning`
  instead of `Windup` (spec 065) — `releaseTick` is provisional until aligned.
  Returns `entity.activity = Casting`, `activityUntilTick = endTick`.
- `advanceCast(entity, candidates, tick, rng)` — called every tick a cast is
  live, regardless of whether an input arrived that tick (world.ts:340-343,
  to avoid freezing windups when a client goes quiet between 20Hz-ish input
  sends on a 60Hz sim). Handles: turning->windup transition (re-stamps
  `releaseTick`/`endTick` once aligned), release (`landAbility`), channel
  pulses (`landAbility` again every `pulseIntervalTicks`), and the
  free-on-release / free-on-channel-end transition back to `cast: null,
  activity: Idle`.
- `cancelCast(entity, tick, reason)` — legal only during `Turning` or before
  `releaseTick` (or interrupt-by-death at any point, or mid-channel).
  Refunds cost and clears the cooldown entry when refundable.
- `landAbility` dispatches by `ability.kind`: `melee` -> `landOnTarget` (named
  target, single-target, checked at *release* not commit — a target that
  walked out of range during windup is a miss) or `landCone` (no named
  target: sweeps `isInCone` against every hostile candidate); `channel` ->
  `landCone`; `ground` -> `landBlast` (point + radius); `self` -> `landSelf`
  (heal); `projectile` -> `launchProjectile` (spawns a `ProjectileSpawn`,
  does not damage anything itself).
- `applyDamage(ability, attacker, target, rng)`: crit roll via `rng.nextInt`,
  `raw = ability.damage * attacker.stats.spellPower * (crit ? 1.75 : 1)`,
  armor via `applyArmor` (player/stats.ts), `killed = health <= 0`. **Being
  hit no longer interrupts a cast** (spec 068) — only death does, and death
  emits an explicit `castEnded{reason: Interrupted}` so the client's UI
  un-roots correctly.

**Basic attack cooldown**: `cooldownTicksFor()` — if `ability.basicAttack`
is set (only `melee.slash` has it), cooldown comes from the caster's own
`attackSpeed` stat via `attackIntervalTicks()` in `player/stats.ts`, not from
the table's `cooldownTicks`. Everything else always uses the table value.

## 2. Movement vs. an in-progress cast

`src/server/sim/world.ts` `step()`, in the movement pass (~line 271-278):
```
// Since spec 079 the root yields to a move order rather than outranking it.
if (steered.cast !== null && asksToMove(rawIntent)) {
  const withdrawn = cancelCast(steered, tick, CastEndReason.Cancelled);
  ...
}
const intent =
  rawIntent && steered.cast !== null
    ? { ...rawIntent, moveX: 0, moveY: 0 }
    : rawIntent;
```
A move order (WASD or a right-click destination) arriving while
`entity.cast !== null` **withdraws from the cast** (spec 079) at the same refund
`Esc` gives — cost back, cooldown cleared — and the body moves on that same
tick. Only a cast past its release is unaffected, because there is nothing left
to withdraw from. An intent that asks for nothing still roots as it always did.
Facing during a cast is driven by `resolveFacing()` in `sim/movement.ts`
(~line 201): it ignores input facing entirely and turns the body toward
`cast.targetX/Y` at `stats.turnRate` — visible "turning into the blow", but
never changes what the cone/target actually is, since the aim was captured once
at commit.

Client-side this is mirrored in three places so prediction agrees:
`moveIntent` (`intent.ts`) lets a direction beat `castAim`; `GameClient.sendInput`
drops `selfRoot` (predicted *and* confirmed) on any input carrying a move
vector; and `autoAttack` (`target.ts`) returns no `chaseTo` while `rooted`, so
only the player's own movement withdraws — never the chase.

Monster movement runs through the identical `resolveMovement`/`cast` check —
`monsterIntent()` in world.ts synthesizes a `ServerInput`-shaped decision, and
the same guard roots a monster mid-swing exactly like a player, including the
withdrawal: a monster whose quarry leaves reach breaks off and chases.

## 3. Data tables — `src/server/data/`

`abilities.ts` — `AbilityDefinition`:
```ts
interface AbilityDefinition {
  id: string; name: string;
  kind: 'melee' | 'projectile' | 'ground' | 'self' | 'channel';
  targeting: 'direction' | 'point' | 'self';
  windupTicks: number;       // commit -> release
  cooldownTicks: number;     // table fallback; basicAttack overrides via stats
  cost: number;               // resource cost, spent at commit
  range: number;
  damage: number;
  arcCosSq?: number;          // melee/channel cone half-angle, squared cosine
  radius?: number;            // ground blast / projectile-with-radius impact
  projectile?: { speed; arcHeight; radius; lifetimeTicks };
  channelTicks?: number; pulseIntervalTicks?: number;
  healing?: number;           // negative "damage" for self heals
  basicAttack?: boolean;      // exactly one ability (melee.slash) has this
  description: string;
}
```
7 seeded rows: `melee.slash` (basic attack, free, 0.2s windup), `melee.heavy`
(0.65s windup, 42 dmg), `bolt.arcane` (flat fast bolt, speed 620, arcHeight
0), `bolt.lob` (point-targeted lobbed pot, arcHeight 130, radius 90 blast),
`ground.quake` (pure ground blast, radius 140), `self.mend` (heal 60),
`channel.drain` (2s channel, pulses every 0.25s). `totalCastTicks(ability)` =
`windupTicks + (channel ? channelTicks : 0)`.

`monsters.ts` — `MonsterDefinition { id, name, radius, aggroRange,
experience, stats: EffectiveStats, passive, ability: string|null }`. Three
real monsters (`grazer` passive, `stalker`, `ravager`) plus a `dummy` with
100000 HP and no ability, all use `ability: 'melee.slash'`. `EffectiveStats`
(shared with players) carries `attackSpeed`, `attackRange`,
`attackCooldownTicks`, `armor`, `spellPower`, `critChance`, etc.
(`src/server/state/types.ts`).

`skills.ts` is unrelated to attacks — passive `StatModifier` trees
(might/finesse/arcane branches), not abilities.

## 4. Damage application & wire

- Damage is computed once, in `applyDamage()` (abilities.ts), for every
  landing path (melee cone/single-target, ground blast, self heal, and
  projectile impact in `world.ts`'s projectile-flight pass). It returns a
  `ServerSimEvent` of `kind: 'hit'` plus the updated target entity.
- `src/server/server.ts` `dispatchEvents()` (~line 880) is the one place
  `ServerSimEvent`s become wire messages:
  - `'hit'` -> `ServerMessageType.CombatResult` (0x43): `{attackerId,
    targetId, damage, targetHealth, flags}` where flags bit0=killed,
    bit1=crit, bit2=blocked. Sent to any connection whose entity is in
    interest range of either attacker or target.
  - `'castStarted'` -> `CastState` (0x49): full `{entityId, abilityId,
    phase, releaseTick, endTick, targetX/Y, targetEntityId}`, sent to
    "watchers of" the caster (interest-based fanout).
  - `'castEnded'` -> `CastEnded` (0x4a): `{entityId, abilityId, reason}`
    (`CastEndReasonValue`: Released/Cancelled/Interrupted).
  - `'castRejected'` -> `CastRejected` (0x4c), sent only to the asker.
  - `'effect'` -> `Effect` (0x4b): a point cue `{effectId, x,y,z, radius,
    durationTicks}` for impacts/blasts/heals, not tied to an entity, fanned
    out by chunk-distance from the event point rather than by entity
    interest.
  - `'died'` triggers experience grant, no direct wire message of its own
    (health change already rode the entity delta / CombatResult).
- Entity position/health/activity also ride the normal 20Hz `EntityDelta`
  (`net/messages.ts` `FIELD_POSITION`/`FIELD_HEALTH`/`FIELD_ACTIVITY` bits) —
  `CombatResult` is the *why*, the delta is the *current truth*.
- Render side: `src/render/iso3d/world/scene.ts` consumes `CastState` +
  the ability table to draw wind-up telegraphs and cast bars (via
  `cast.ts castBar()`), and interpolates projectile entities the same as any
  other entity (`interpolate.ts`) since a projectile is a real `ServerEntity`
  with `kind === EntityKind.Projectile`. `addEffect()` in scene.ts (line
  ~392) is the sink for `Effect` messages — impacts/blasts as point cues.

## 5. Projectiles

Not bolted on — fully unified into the entity/cast system since spec 062:
- `EntityKindValue.Projectile = 3` (sim/types.ts) is a normal entity kind.
- `ProjectileState` (types.ts:89-103) carried on `ServerEntity.projectile`:
  owner, origin, target, `speed` (world units/tick), `arcHeight`,
  `totalDistance`/`travelled`, `expiresAtTick`.
- `launchProjectile()` in abilities.ts only *computes* the spawn spec at
  cast-release; `world.ts` `step()` (~line 404-499) actually creates the
  entity, advances every live projectile's position each tick (parabolic arc
  via `arcHeightAt()`), checks `projectileHits()` against hostile candidates,
  applies damage or a blast radius burst on arrival/impact, then deletes the
  entity and emits `despawned`.
- No other projectile system exists anywhere in the repo (checked
  `src/sim/`, `src/render/` — only references are the ones above plus
  drawing/appearance code that treats it as an entity kind).

## 6. Per-tick loop — `src/server/sim/world.ts` `step()`

Pure `(state, inputs, context) -> StepResult`. Fixed order, documented at the
top of the file (world.ts:10-22):
1. **Expire timers** (per-entity, in `state.entities` insertion/creation
   order) — dead entities get flagged `Dead` and skipped for the rest of the
   loop.
2. **Movement**, same per-entity loop as (1): players move from their
   `ServerInput`; monsters get `monsterIntent()` (AI decision + pathing,
   folded into the same per-tick `ServerInput` shape so it goes through
   identical `resolveMovement`/collision code). A live cast zeroes the
   movement components (see §2). Corrections, resource regen, and the
   `casters` queue (who needs `advanceCast` this tick) are all built here.
   Entities in inactive chunks are skipped entirely (`isSimulated`).
3. **Casts**, iterated in **entity-id order** (`casters.sort((a,b)=>a-b)`,
   explicitly for reproducibility across replays regardless of creation
   order) — honors `cancelCast` first, then a new `castAbilityId` commit via
   `startCast`, then `advanceCast` on whatever cast (old or just-started) is
   now live. Projectile spawns queue into `spawnQueue` rather than being
   created immediately.
   3b. **Projectiles fly**: spawn entities from the queue, then advance every
   live projectile's position/arc, resolve hits/blasts, despawn on
   expiry/impact.
4. **Despawns**: corpses tick down `CORPSE_TICKS` (5s) and get removed;
   dead players are kept (respawned in place elsewhere) so their entity id
   survives.
5. **Ambient spawner** (`runSpawner`): per-chunk population cap, RNG-seeded
   monster type/position, cadence derived from tick number + chunk hash
   (never wall-clock).

Entity positions live in `ServerWorldState.entities: ReadonlyMap<number,
ServerEntity>` (`sim/types.ts:192-201`), rebuilt into a fresh `working` Map
each tick and returned as the new state — no entity is mutated in place.
`ServerEntity.position: Vec3` (`{x,y,z}`) plus `facing` (radians) are the
transform; `activity`/`activityUntilTick` drive animation state on the wire.

## Invariants worth remembering before changing anything here

- The whole ability system is pure and RNG-threaded (`Rng` in, `Rng` out) —
  no `Math.random`, no ambient time, matching CLAUDE.md's determinism rule.
  `abilities.ts`/`world.ts`/`movement.ts` have zero DOM/render imports.
- Aim (`cast.targetX/Y`, `cast.targetEntityId`) is captured once at commit
  and never re-read from current cursor/target position — this is what makes
  a wind-up mean something. Don't let a "quality of life" change re-aim a
  cast mid-flight.
- Range for a named-target melee swing (`landOnTarget`) is checked at
  *release*, deliberately, not at commit — encodes "wind-up is readable and
  escapable" as a rule, not just a visual.
- Getting hit no longer interrupts a cast (spec 068) — only death does.
  Any change reintroducing hit-interrupt needs to update the `castEnded`
  emission path in `applyDamage` and the client's root-clearing logic.
- The client (`src/server/client/combat.ts`) mirrors `startCast`/a reduced
  `advanceCast` for prediction, calling the *same* pure functions rather than
  a hand-rolled copy — keep it that way; don't fork the rules.
- `src/render/` files here (`target.ts`, `intent.ts`, `cast.ts`) are pure and
  headlessly tested by design (CLAUDE.md sim/render split) — they decide
  *what to ask for*, never whether it happens. Any new game-outcome logic
  belongs in `src/server/sim/`, not in `view.ts`/`scene.ts`.


---

## Spec 079 additions

- **`EffectiveStats.basicAttackId`** — which attack a body swings with is a
  derived stat now, from `ItemDefinition.basicAttackId` (main hand) for a player
  and from its row for a monster. `MonsterDefinition.ability` is gone.
  `BASIC_ATTACK_ID` survives only as the fallback. On the wire in `0x44 Stats`;
  `PROTOCOL_VERSION` 9.
- **`ranged.shot` / `ranged.star`** — `kind: 'projectile'`, `basicAttack: true`,
  `targeting: 'point'`. The `slinger` monster and the `bow.hunting` /
  `stars.weighted` items carry them.
- **`ProjectileState.targetEntityId`** — a shot re-aims at that body every tick
  in world.ts's projectile pass, and `totalDistance` is re-stamped as
  `travelled + what is left` so `progress` still drives `arcHeightAt`. Target
  gone → the last aim stands (a "disjoint") and the shot expires on it.
- **Flat vs arcing** — `arcHeight === 0` takes the first hostile body it
  overlaps; `arcHeight > 0` flies over everything and resolves only against the
  body it was fired at.

---

## Spec 081 additions

- **A shot's speed is no longer a table constant.** `launchProjectile` runs
  `spec.speed` through `projectileSpeedFor(baseSpeed, stats)` in
  `player/stats.ts`: `baseSpeed * clamp(attackSpeed) * PROJECTILE_SPEED_SCALE`,
  where the scale is a deliberate global 30% knob and `attackSpeed` is the same
  clamped weapon stat `attackIntervalTicks` divides by. One weapon speed, both
  halves of what it means.
- **`lifetimeTicks` is a reach, not a duration.** `projectileLifetimeTicks`
  re-times it as `lifetimeTicks * spec.speed / actualSpeed`, so every row keeps
  the exact distance the table describes for every shooter. Do not "simplify"
  this back to a raw tick count: at 30% speed that expires `bolt.arcane` at 372
  units of its 700-unit range and `bolt.lob` at 360 of 520.
- **`ProjectileSpec.look`** (`'orb' | 'arrow' | 'shuriken'`, default orb) is a
  *picture*. Nothing under `src/server/sim/` reads it, and it rides no wire — a
  projectile entity's `typeId` is already its ability id and the table is shared
  code, so `appearanceOf` looks it up client-side. `PROTOCOL_VERSION` stays 9.
- **Render**: `world/projectile-shape.ts` (arrow proportions, shuriken outline)
  and `world/trail.ts` (distance-sampled ring buffer + tapered ribbon) are pure
  and headlessly tested; `world/shot.ts` is the three.js `ShotRig` that builds
  them, pitches the arrow from its drawn positions, spins the star, and owns the
  streak. The streak is added to the *scene root*, not to the shot's group, and
  must be removed and disposed on every body-teardown path in `scene.ts`.
- A star is drawn at `SHURIKEN_DRAW_SCALE` (1.9x) its collision radius. That is
  the one place a projectile's drawn extent and its hit radius part company on
  purpose; `projectileHits` is untouched.
- `npx tsx scripts/preview-shots.ts` → `.claude/screenshots/shots.png` flies the
  real rig through a real `arcHeightAt` arc, with a software rasteriser that
  blends vertex alpha so the streak's fade is actually visible.
