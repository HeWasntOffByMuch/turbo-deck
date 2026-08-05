# 056 — Multiplayer simulation layer

## Problem

The game is single-player and client-only: `src/sim/` steps one `player` at
60Hz inside the browser tab, and there is no server. To prepare for multiplayer
we need an authoritative Node process that owns all state, accepts inputs (never
state) from clients, and streams back the slice of the world each client can
actually see. Nothing about the shipping single-player game changes; this is a
new layer beside it, not a rewrite of it.

## Conflicts with the existing codebase, and how they are resolved

The requested architecture does not line up with what is already here in four
places. Resolutions, all chosen to leave the existing game untouched:

1. **Tick rate.** `src/sim/` is a 60Hz fixed timestep and CLAUDE.md makes that a
   rule. The server runs its *own* sim at 20Hz (`SERVER_TICK_RATE`) rather than
   retiming the existing one. The two sims are separate programs that share pure
   helpers (`src/shared/prng.ts`, `src/sim/collision.ts`, `src/shared/world.ts`),
   so neither constrains the other's timestep.
2. **Single-player shape.** `CombatState` has one `player` field and ~2000 lines
   of tests pinned to it. The server gets its own N-player state
   (`ServerWorldState`) instead of a refactor of `CombatState`.
3. **Chunk size.** `src/terrain/chunk.ts` already chunks at 616×616 world units
   (22 cellSize × 28 cells) — but that is a *meshing* unit, sized for draw calls.
   Network interest is a different concern with a different natural size, so the
   server uses an independent 100×100 unit grid. The two grids are unrelated by
   design and neither needs to know about the other.
4. **Skills and equipment.** The game has str/agi/int stat points and no items,
   skills or slots at all. The server introduces `SKILLS` and `ITEMS` definition
   tables with a small placeholder dataset in a production-shaped schema; the
   derived stats bottom out in the existing tuning constants
   (`HP_PER_STRENGTH`, `ARMOR_PER_AGILITY`, …) so the numbers stay consistent
   with the single-player game.

## Shape

```
src/server/
  config.ts              tick rate, chunk size, interest radius, live-tunable knobs
  loop.ts                fixed-timestep 20Hz driver (accumulator; the only clock reader)
  server.ts              GameServer: ws transport + loop + routing, wired together
  index.ts               CLI entry (npm run server)
  net/
    codec.ts             BufferWriter/BufferReader: u8/u16/i32/f32/varint/string
    protocol.ts          message type bytes + wire constants
    messages.ts          encode/decode for every message type
    delta.ts             per-client delta snapshot: changed entities only
  world/
    chunks.ts            pure chunk-grid math (world point -> chunk, radius queries)
    chunk-manager.ts     occupancy index, active/inactive chunks, interest sets
    zone-manager.ts      named zones over the one continuous coordinate space
  state/
    types.ts             PersistedPlayer, entity records
    store.ts             DataStore interface (async, storage-agnostic)
    memory-store.ts      in-memory DataStore implementation
  player/
    stats.ts             effective-stat recalculation from base + skills + equipment
    skills.ts            tier-gating and branch-locking validation
    player-manager.ts    login/logout, equip/unequip, skill spend, recalc triggers
  sim/
    types.ts             ServerWorldState, entities, input frames
    movement.ts          input -> validated position (speed cap, collision, bounds)
    combat.ts            hit detection, damage, cooldowns, hitstop/knockback payload
    world.ts             step(): the authoritative 20Hz tick
  data/
    skills.ts            SKILLS definition table
    items.ts             ITEMS definition table
  admin/
    auth.ts              HS256 JWT sign/verify with a `role` claim (node:crypto)
    audit.ts             append-only admin action log (who/what/when)
    router.ts            admin:* message handling
  admin-client/
    index.html           minimal plain-HTML/JS admin console
```

Key types:

```ts
interface DataStore {
  loadPlayer(id: string): Promise<PersistedPlayer | null>;
  savePlayer(p: PersistedPlayer): Promise<void>;
  listBans(): Promise<readonly Ban[]>;
  // ...all async, so a Postgres/Redis implementation drops in unchanged
}

interface PersistedPlayer {
  readonly id: string;
  readonly baseStats: BaseStats;                 // set at character creation
  readonly skills: readonly SkillAllocation[];   // { skillId, level }
  readonly equipment: Readonly<Record<EquipSlot, string | null>>;  // slot -> itemId
  readonly position: Vec3;
  readonly currentZone: string;
  // currentChunk is derived from position, never persisted as a second source of truth
}

function computeEffectiveStats(p: PersistedPlayer): EffectiveStats;  // never persisted
function step(state: ServerWorldState, inputs, config): StepResult;   // pure, 20Hz
```

Wire format: every frame is binary. Byte 0 is the message type; the payload is
type-specific and little-endian. Documented in full in
`src/server/net/PROTOCOL.md`.

## Invariants tested

- **Determinism.** Same seed + same sequence of input frames ⇒ bit-identical
  `ServerWorldState`, replayed twice. This is the same property the existing sim
  guarantees, and it is what makes server-side regressions detectable.
- **Codec round-trip.** Every message type encodes and decodes back to an equal
  value, including edge values (negative coords, empty entity lists, max varint).
- **Stats are derived, never stored.** `computeEffectiveStats` is a pure function
  of base stats + skills + equipment; changing an equipped item changes the
  result, and no effective stat survives a save/load round-trip.
- **Skill validation.** A tier-2 skill is rejected until its tier-1 prerequisite
  is met; allocating into one branch locks the sibling branch; spending more
  points than earned is rejected. Rejection leaves the player unchanged.
- **Movement validation.** An input that would move a player faster than their
  effective speed allows is clamped, not trusted; a position inside a collider or
  outside world bounds is rejected and the player is corrected.
- **Interest management.** A player receives entity updates for entities within
  the interest radius and none outside it; crossing a chunk boundary produces
  enter/leave transitions exactly once.
- **Delta correctness.** A delta snapshot contains exactly the entities whose
  visible fields changed since that client's last acknowledged tick, plus full
  state for entities newly entering interest.
- **Chunk lifecycle.** A chunk with no player within the interest radius goes
  inactive and stops simulating; it reactivates when a player approaches.
- **Admin auth.** A message in the `admin:*` range from a connection whose token
  lacks `role: admin` is rejected and audited; an expired or tampered token fails
  verification. Every accepted admin action appends one audit entry.

## Out of scope

- Real persistence (Postgres/Redis). The `DataStore` interface exists so that
  swap is additive; only the in-memory implementation ships here.
- Wiring the browser renderer to the server. The client-side prediction and
  reconciliation *contract* is defined (input sequence numbers, correction
  messages, divergence threshold) and the server half is implemented, but
  `src/render/` is not touched.
- Merging the card/spell economy into server combat. The resolver covers basic
  attacks, cooldowns, damage, hitstop and knockback; cards stay single-player.
- Attack telegraphs. The single-player sim has wind-up, perfect-parry and dodge
  windows; the server resolver fires on the tick the button is pressed if the
  cooldown allows. Porting the defence windows is its own spec, because they
  need a latency story (whose clock decides a 4-tick perfect window?) that this
  one deliberately does not open.
- Unit separation. The single-player sim runs `resolveOverlaps` after movement;
  the server does not, so bodies may overlap in a crowd.
- Rate limiting, TLS termination, horizontal scaling, real account auth. Player
  identity is a claimed id on connect, which is fine for a LAN/dev server and
  is deliberately not a login system.
