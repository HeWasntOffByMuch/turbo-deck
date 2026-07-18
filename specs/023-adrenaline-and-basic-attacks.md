# 023 — Adrenaline & interrupting basic attacks

## Problem

The `attack` card is dead weight: a tax the deck-thinning rewards exist to
cycle out, useful only as filler that opens a synergy window. This spec gives
basic attacks a job and adds a risk/reward resource on top of them.

- **Basic attacks interrupt.** A basic-attack cone that connects with an enemy
  mid-wind-up cancels that slam — the attack never lands and the enemy drops to
  recovery. Basic attacks become a defensive tool, not just filler.
- **Adrenaline.** A basic attack that hits at least one unit grants **+1
  adrenaline** (capped at 5). Adrenaline does nothing on its own — it is banked.
- **Synergies spend it.** When a played window forms a synergy (two-or-more of
  the same card fuse), every point of banked adrenaline empowers that cast's
  damage, and the synergy spends all of it back to zero.

The loop: sweep with basic attacks to interrupt threats and bank adrenaline,
then dump the bank into a fused synergy for an outsized hit.

## Shape

### Geometry (`src/shared/spell-spec.ts`)

The cone gains an optional `interrupt` flag — a basic-attack cone; other cones
(Fire Blast, etc.) leave it unset:

```ts
| { kind:'cone'; range; arcCosSq; damage; interrupt?: boolean }
```

### Cards (`src/cards/synergy.ts`)

- Both `attack` tiers carry `interrupt: true`.
- `ADRENALINE_DAMAGE_PER_POINT = 0.2` and
  `empowerSpecs(specs, adrenaline): SpellSpec[]` — scales each spec's damage by
  `1 + 0.2 * adrenaline` (reusing the existing damage-scaling, geometry
  untouched). Adrenaline's *value* comes from the sim; how much a point is worth
  is a card-damage rule and stays here.

### Sim (`src/sim/`)

- `constants.ts`: `MAX_ADRENALINE = 5`.
- `PlayerState.adrenaline: number` (identity default 0).
- `castSpells` external effect gains `spendAdrenaline?: boolean`.
- New `SimEvent`: `{ kind:'adrenalineChanged'; tick; value; delta }`.
- Executing a `castSpells`:
  - An `interrupt` cone that connects damages as usual, and additionally, for
    every enemy it hits that is a hunting enemy in `windup`, drops it to
    `recovery` (aim/outcome cleared) so the slam never resolves.
  - If any `interrupt` cone hit ≥1 enemy, adrenaline gains +1 (clamped to
    `MAX_ADRENALINE`).
  - If `spendAdrenaline` is set, adrenaline resets to 0 — applied *after* the
    gain, so a double-`attack` fusion (which both hits and is a synergy) nets to
    zero rather than leaking a point.
  - A net change emits one `adrenalineChanged`.

### Game (`src/game/spell-session.ts`)

When a window closes it is a **synergy** iff some card id has count ≥ 2 (a
fusion occurred). On a synergy with banked adrenaline > 0, the resolved specs
are run through `empowerSpecs(specs, adrenaline)` and the `castSpells` effect
carries `spendAdrenaline: true`. Non-synergy windows are cast unchanged and
never spend. (The mis-timed-window slow from spec 021 is unaffected.)

### Render (`src/render/spells/`)

- HUD: a 5-pip adrenaline gauge in the status row, filled to the current value,
  with the live empower bonus shown when it is non-zero.
- Arena: adrenaline pips ride above the player and a rising popup marks each
  gain (`+ADR`) and spend (`ADRENALINE!`). No game rules — reads sim state and
  the `adrenalineChanged` event.

## Invariants tested

- A basic-attack (`interrupt`) cone that connects with a hunting enemy in
  wind-up cancels its slam: the enemy enters recovery and deals no damage that
  it otherwise would have. A non-interrupt cone does not interrupt.
- A basic attack that hits ≥1 enemy grants +1 adrenaline; one that connects with
  nothing grants none; adrenaline never exceeds `MAX_ADRENALINE`.
- `empowerSpecs` scales damage by `1 + 0.2·adrenaline` and leaves geometry
  (range/arc/radius/etc.) unchanged; 0 adrenaline is a no-op.
- A synergy window with banked adrenaline casts empowered specs and resets
  adrenaline to 0 (`spendAdrenaline`); a non-synergy window neither empowers nor
  spends.
- Determinism: same seed + inputs ⇒ bit-identical state, including adrenaline;
  the new fields do not change any existing sim/session test outcome.

## Out of scope

- No adrenaline gain from any source other than basic attacks (no gain on
  parry/dodge, spell hits, kills).
- No per-card empower tuning — every point is a flat +20% to the whole synergy
  cast.
- No new SFX; the `adrenalineChanged` event is cosmetic-only for the renderer.
- The legacy catalog game (`session.ts`) and balance harness are untouched.
