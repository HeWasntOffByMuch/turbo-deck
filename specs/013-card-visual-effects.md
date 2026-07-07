# 013 — Card visual effects: passive auras and active-card FX

## Problem

Cards currently read only as HUD text and log lines. Held passive modifiers
are invisible on the actors they affect, and playing an active card produces
nothing but a damage number. This spec gives cards a visible on-field
presence: passives paint a subtle aura on every unit they affect, and active
cards fire a distinct effect (a projectile, or a ground AOE that winds up).

This is **render-only**. Per the one governing rule, none of it touches the
sim or the card engine — the effects are derived purely from existing
`GameState` (held passives, unit positions) and existing `GameEvent`s
(`cardPlayed` / `bonusCardPlayed` / `enemyHit`). No new game rules, no sim
fields, no determinism surface. "Cast time" is a cosmetic per-card render
property, not a sim mechanic.

## Shape

New module `src/render/effects.ts` (presentation data + pure Graphics helpers,
no sim rules):

- `PASSIVE_VFX: Record<PassiveEffect['kind'], PassiveVfx>` — for each passive
  kind, which unit it decorates (`'player'` or `'enemies'`), its colour, and
  which aura primitives it uses: `'rotatingShapes'`, `'glow'`, `'underglow'`
  (floor aura), `'overheadSymbol'`. Offensive passives orbit rotating shapes;
  sustain passives get a floor underglow; the enemy-tempo curse marks affected
  enemies with a floor aura + an overhead symbol.
- `ACTIVE_VFX: Record<string, ActiveVfx>` keyed by card id — each active card
  is either `kind: 'projectile'` (fireball, iceshard: a shape that flies from
  the caster to the struck enemy) or `kind: 'aoe'` (mend, warcry cast on self;
  emberlash, guardbreak cast forward). AOEs carry a cosmetic `castTicks`
  windup and a `radius`; guardbreak also carries an overhead `symbol`
  (`'brokenArmor'`) shown on the enemies it hits.
- Pure drawing helpers `drawUnderglow` / `drawGlow` / `drawRotatingShapes` /
  `drawOverheadSymbol(kind)` that take a `Graphics`, a screen centre, a radius,
  a colour and an animation `phase` (a free-running render frame counter — no
  sim time).
- Transient effect classes `ProjectileEffect`, `AoeEffect`,
  `OverheadSymbolEffect`, each anchored in **world** coordinates (so they track
  the scrolling camera), with `update()` returning whether they are still
  alive and `drawFloor` / `drawTop` splitting ground vs. above-sprite drawing.

`src/render/scene.ts`:
- Two new world layers: an aura/telegraph **floor** layer under the sprites
  (underglows, floor auras, AOE windup rings) and an aura **top** layer above
  them (rotating shapes, glows, overhead symbols, projectiles, AOE bursts).
- A per-render frame counter driving all aura animation.
- On `cardPlayed` / `bonusCardPlayed` whose id is in `ACTIVE_VFX`: spawn a
  projectile aimed at the matching `enemyHit` (nearest-enemy target) or, if the
  card missed, along the aim direction; or spawn an AOE at the caster / forward
  point. Symbol-bearing actives also spawn an `OverheadSymbolEffect` over each
  `enemyHit`.
- Each render: advance and draw live transient effects, then paint passive
  auras for every held passive on each unit it affects.

## Invariants tested

- `PASSIVE_VFX` covers every `PassiveEffect['kind']` and `ACTIVE_VFX` covers
  every active card in the catalog (no unstyled card ships).
- Projectile actives are `kind: 'projectile'`; self/forward actives are
  `kind: 'aoe'` with `castTicks >= 0` and `radius > 0`.
- A `ProjectileEffect` advances from its start toward its target and reports
  dead after its lifetime; an `AoeEffect` lives at least its `castTicks` windup
  before bursting and then dies. (Pure update logic, no rendering.)
- The module imports nothing from `src/sim` except types — asserted by the
  existing render/sim split; it introduces no sim fields or events.

## Out of scope

- A real cast-time / channel **mechanic** in the sim (the AOE windup here is
  cosmetic and plays out after the instantaneous hit). If casting should gate
  gameplay, that is a separate sim spec.
- Audio, particle systems, and sprite-sheet FX art — the shapes are vector
  primitives ("shape enough for now").
- Per-projectile collision or travel-time damage; damage still resolves in the
  sim exactly as today, the projectile is a cosmetic follow-up to it.
