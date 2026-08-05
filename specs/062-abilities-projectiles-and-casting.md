# 062 — Abilities, projectiles and casting

## Problem

Spec 057 stage 2 was going to move the card economy onto the server. It is being
deleted instead. The card hand, the synergy windows, and the perfect-parry /
dodge timing that fed them are all removed, and the server grows a conventional
ability system in their place: attacks that wind up, projectiles that travel,
and skills that cost something and go on cooldown.

That also settles the open question 057 left: "whose clock decides a 4-tick
perfect window when the client is several ticks ahead?" Nobody's. There is no
perfect window any more. Commitment is expressed as a wind-up the caster can
cancel, which is a decision the *server* observes over many ticks rather than a
sub-frame judgement it has to arbitrate.

## What is deleted

- `src/cards/` — the card/deck engine.
- `src/game/` — the composition root that wired cards to the sim.
- `src/balance/` and `scripts/balance-harness.ts` — a Monte Carlo harness whose
  only subject was the card game.
- `src/shared/spell-spec.ts` — the card→sim spell geometry hand-off.
- `src/sim/combat.ts` and its tests — the local single-player sim, including
  parry, dodge, stances, adrenaline and the spell-card effects. Everything that
  routes through the server (spec 057) now has exactly one implementation.
- The renderer surface that existed only to play that game: the card hand and
  its animations, the spell sandbox, the 2D Pixi entry point, and the combat,
  movement and debug tabs of the iso3d shell.

Kept, because none of it depended on cards: `src/terrain/`, the map editor, the
critter rigs, the cloth solver, props, the terrain mesh, and the pure helpers
the server already builds on (`prng`, `hash`, `world` extent, `collision`,
`pathfinding`, and the tuning constants).

## Shape

An ability is data, in the same style as SKILLS and ITEMS:

```ts
type AbilityKind = 'melee' | 'projectile' | 'ground' | 'self' | 'channel';

interface AbilityDefinition {
  readonly id: string;
  readonly kind: AbilityKind;
  /** Ticks between committing and the effect landing. Cancellable throughout. */
  readonly windupTicks: number;
  /** Ticks the caster is rooted after release. Not cancellable. */
  readonly recoveryTicks: number;
  readonly cooldownTicks: number;
  readonly cost: number;
  readonly range: number;
  readonly damage: number;
  readonly targeting: 'direction' | 'point' | 'self';
  /** melee only: squared cosine of the cone half-angle. */
  readonly arcCosSq?: number;
  /** ground/projectile-impact only. */
  readonly radius?: number;
  /** projectile only. */
  readonly projectile?: {
    readonly speed: number;      // world units per second
    readonly arcHeight: number;  // 0 = flat, >0 = lobbed
    readonly radius: number;
    readonly lifetimeTicks: number;
  };
  /** channel only: total ticks, and how often it pulses. */
  readonly channelTicks?: number;
  readonly pulseIntervalTicks?: number;
}
```

The caster carries one cast at a time:

```ts
interface CastState {
  readonly abilityId: string;
  readonly startedTick: number;
  readonly releaseTick: number;   // when windup ends
  readonly endTick: number;       // when recovery (or channel) ends
  readonly targetX: number;
  readonly targetY: number;
  readonly phase: 'windup' | 'channel' | 'recovery';
}
```

**Projectiles are entities.** `EntityKind.Projectile` joins Player and Monster,
so interest management, delta tracking and replication all apply to them
unchanged rather than growing a parallel system with its own bugs. Their flight
parameters ride a spawn event so the client can interpolate a smooth arc between
the 20Hz deltas instead of stepping them.

Wire additions (full layout in `net/PROTOCOL.md`):

| Byte | Message | Meaning |
|---|---|---|
| `0x08` | `UseAbility` (C→S) | `str abilityId`, `f32 targetX`, `f32 targetY` |
| `0x09` | `CancelCast` (C→S) | — |
| `0x49` | `CastState` (S→C) | who is casting what, in which phase, until when |
| `0x4A` | `CastEnded` (S→C) | released, cancelled, or interrupted, with the reason |
| `0x4B` | `Effect` (S→C) | a point/radius VFX cue: impact, blast, heal |

## Invariants tested

- **Wind-up is real.** An ability deals no damage before its release tick, and
  exactly once on it.
- **Cancellation refunds nothing but time.** A cast cancelled during wind-up
  deals no damage, starts no cooldown, and returns the cost; a cast cancelled
  after release does none of those things because it is already spent.
- **Cooldowns and cost gate use.** An ability on cooldown is refused; one whose
  cost exceeds the caster's resource is refused; a refusal changes no state.
- **One cast at a time.** Starting an ability while another is winding up is
  refused rather than queued or overlapping.
- **Projectiles travel.** A projectile advances by its speed each tick, expires
  at its lifetime, and damages the first hostile body it overlaps. Its arc is a
  pure function of flight progress, so the client's interpolation and the
  server's position agree.
- **Channels pulse.** A channelled ability applies its effect every
  `pulseIntervalTicks` for `channelTicks`, and stops early if cancelled.
- **Determinism survives all of it.** Same seed and inputs, same world — casts,
  projectiles and channels included.
- **The client is told.** Every cast start, end and effect reaches a client
  whose interest set contains the caster, and nothing is inferred client-side.

## Out of scope

- Client-side prediction of abilities. Movement stays predicted; casts show a
  local "requested" state and are confirmed by the server. Predicting damage is
  a much larger commitment and belongs in its own spec.
- Repointing the iso3d renderer at the server (spec 057 stage 3). This spec adds
  a deliberately plain canvas debug client instead, so the new combat is
  playable and testable now without the full renderer swap.
- Threat/aggro tables, crowd control, damage-over-time stacking rules, and loot.
- Rebalancing. The starting abilities exist to exercise each `AbilityKind`, not
  to be fun.
