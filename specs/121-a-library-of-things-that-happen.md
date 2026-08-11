# 121 — A library of things that happen

## Problem

The core (118), the splat generator (119) and the decal field (120) are the
machinery. Four effects use them. This is the library: fire, smoke, auras, and
the rest of the hit vocabulary, plus the damage-type table that has been a stub
since the wire adapter landed.

The bar this spec is held to is the arc's acceptance criterion: **adding an
effect is editing config in one place, and no call site changes.** If any effect
below needs a new branch in `scene.ts` or `view.ts`, the core is wrong and this
spec is where that shows up.

Two things genuinely need code, and neither is an effect:

- **Sprites.** A ring, a flame flipbook and an angular chip do not exist yet and
  are generated, never fetched.
- **An aura driver.** Auras are the one family that is *state*, not an event:
  something is true about a unit for a while, and a ring is under it for exactly
  that long. That needs a pure function from replicated facts to a set of live
  auras, plus start/stop bookkeeping the event path does not have.

## What the read found, and what it costs this spec

**No status is replicated.** `ReplicatedEntity` carries id, kind, typeId,
position, facing, health, maxHealth, activity, activityUntilTick and level.
There is no buff list, no debuff list, no modifier set — `StatModifier` exists
server-side and never reaches a client.

So "hook auras to the existing debuff/status tracking so applying a status shows
its aura automatically" **cannot be honoured as written**, and the missing piece
is a protocol change, which is a stated non-goal of this arc.

What this spec does instead: builds the whole aura path against a pure
`aurasFor(facts)` and drives it from what the client actually knows — casts in
progress, the selected target, a body's health fraction, and its activity. Every
status-driven aura is authored and reachable; the day a status list is
replicated, `aurasFor` gains a branch and nothing else changes.

## Shape

Config, in `registry.ts`:

- `fire(params)` — one builder, five layers: flame flipbook, embers, a
  heat-shimmer stand-in, a smoke column, a ground glow. Tint is a parameter, so
  normal, blue and cursed fire are the same definition. Variants: `torch`,
  `campfire`, `fire_burning_unit` (attached), `fire_ground_patch`,
  `fire_trail`, `fire_ignite`.
- `puff(params)` — one builder for every soft volume: `puff_footstep`,
  `puff_landing`, `puff_teleport`, `puff_debris`, `puff_steam`,
  `cloud_poison`, `smoke_extinguish`.
- `aura(params)` — a ground ring plus optional orbiting motes: `aura_buff`,
  `aura_debuff`, `aura_poison`, `aura_shield`, `aura_channel`,
  `aura_telegraph`, `aura_heal`, `aura_selected`.
- Hit effects: `impact_flash`, `slash_arc`, `impact_physical`,
  `shockwave_ring`, `hit_critical`, `hit_block`, and one `hit_<type>` per damage
  type, filling in `DAMAGE_EFFECTS`.
- Death effects per archetype: `death_dissolve`, `death_collapse`,
  `death_ash`.

Code:

```ts
// textures.ts: 'ring', 'flame', 'chip', 'bolt' -- generated, never fetched.

// auras.ts, pure:
interface AuraFacts {
  readonly entityId: number;
  readonly casting: boolean;
  readonly channelling: boolean;
  readonly selected: boolean;
  readonly healthFraction: number;
  readonly telegraphing: boolean;
}
/** Which auras should be live on this unit, in draw order. */
function aurasFor(facts: AuraFacts): readonly string[];

/** Diffs two frames of auras into what to start and what to stop. */
class AuraTracker {
  step(entityId: number, wanted: readonly string[]): AuraChange;
  forget(entityId: number): readonly string[];
}
```

Plus the Play tab's seventh corner button: VFX intensity and gore, in the
existing `settings-menu.ts` pattern.

## Invariants tested

- **Every registered effect compiles, has at least one emitter, and names no
  sub-effect that does not exist.** One test over the whole table, so a new entry
  is checked by existing.
- **Every effect id `DAMAGE_EFFECTS` names is in the registry** — the stub table
  is exactly where a typo hides.
- **A tint parameter changes hue and not brightness**, asserted on the fire
  family: blue fire and normal fire have the same luminance ramp.
- **Auras are readable at gameplay zoom**: a ring's outer radius, drawn at the
  player's real size and at the camera's real span, covers a minimum number of
  virtual pixels. This is arithmetic and is checked in Node.
- **Two stacked auras do not overlap**: the ring radii are separated by at least
  a virtual pixel at gameplay zoom, so two statuses read as concentric rings
  rather than as one thick smear.
- **The aura tracker starts and stops exactly once.** No effect is started twice,
  none is left running when its condition ends, and `forget` stops everything a
  despawned unit owned.
- **`aurasFor` is a pure function of its facts** and orders them consistently, so
  the same state produces the same rings in the same order.
- **Budget.** Every effect declares a priority, and the ones that carry
  information — telegraph, channel — are priority 3.

## Out of scope

- Replicating statuses. That is the protocol change this spec is written around,
  and it is a non-goal of the arc.
- Unit blood staining (recommended in `docs/vfx-plan.md` §5d, deferred there).
- The Studio VFX tab, which is the phase after this.
- Audio: still a typed sink.
