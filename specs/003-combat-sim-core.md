# 003 — Deterministic combat sim core

## Problem

The combat loop — move, attack, parry/dodge, mana — needs to exist as a
fixed-timestep, seed-deterministic simulation before anything renders it or
wires it to cards. This spec covers the sim in isolation: a player vs. one
scripted dummy enemy, with the perfect-parry/perfect-dodge timing mechanic
that is the heart of the game. Card effects are not interpreted here —
that's spec 004 — but the sim exposes a generic "external effect" hook so
integration can apply a played card's effect without the sim knowing what a
card is.

## Shape

`src/sim/constants.ts` — all tuning numbers (tick rate, arena bounds, move
speed, attack range/damage/cooldown, enemy windup/recovery durations,
perfect/normal defense windows, defense recovery, mana max/regen).

`src/sim/types.ts`:
```ts
interface PlayerState {
  health: number; maxHealth: number;
  mana: number; maxMana: number;
  position: number;
  attackCooldownUntil: number;   // tick
  defenseLockUntil: number;      // tick
  damageBuffs: { amount: number; expiresAtTick: number }[];
}

type EnemyPhase = 'idle' | 'windup' | 'recovery';
type DefenseOutcome = 'none' | 'perfect' | 'normal' | 'whiffed';

interface EnemyState {
  health: number; maxHealth: number;
  position: number;
  phase: EnemyPhase;
  phaseEndsAtTick: number;
  incomingAttackOutcome: DefenseOutcome; // registered by a defend input, applied at resolution
}

interface CombatState { tick: number; player: PlayerState; enemy: EnemyState; rng: Rng; }

interface InputFrame {
  moveDir: -1 | 0 | 1;
  attack: boolean;
  parry: boolean;
  dodge: boolean;
  externalEffect?: ExternalEffect; // integration's hook for a played card
}

type ExternalEffect =
  | { kind: 'damageEnemy'; manaCost: number; amount: number }
  | { kind: 'healPlayer'; manaCost: number; amount: number }
  | { kind: 'buffPlayerDamage'; manaCost: number; amount: number; durationTicks: number };

type SimEvent =
  | { kind: 'perfectDefense'; defenseType: 'parry' | 'dodge'; tick: number }
  | { kind: 'normalDefense'; defenseType: 'parry' | 'dodge'; tick: number }
  | { kind: 'playerHit'; damage: number; tick: number }
  | { kind: 'enemyHit'; damage: number; tick: number }
  | { kind: 'attackMissed'; tick: number }
  | { kind: 'effectRejectedInsufficientMana'; tick: number }
  | { kind: 'enemyDefeated'; tick: number }
  | { kind: 'playerDefeated'; tick: number };
```

`src/sim/combat.ts`:
- `initCombat(seed: number): CombatState`
- `step(state: CombatState, input: InputFrame): { state: CombatState; events: SimEvent[] }` — advances exactly one 1/60s tick:
  1. Apply `moveDir` to player position, clamped to arena bounds.
  2. If `attack` is set and off cooldown: hit if in range (`enemyHit`/`attackMissed`), set cooldown.
  3. If `parry`/`dodge` is set, off defense-lock, and the enemy is mid-`windup` with `incomingAttackOutcome === 'none'`: compare the current tick to the enemy's fixed hit tick and register `perfect` (within the perfect window), `normal` (within the wider window), or `whiffed`; set the defense lock.
  4. Advance the enemy state machine; at the hit tick, apply damage per the registered outcome (0 for perfect, halved for normal, full otherwise), emit the matching event, and transition to `recovery`.
  5. Apply `externalEffect` if mana covers its cost (else emit `effectRejectedInsufficientMana`); this is the only way anything outside the sim changes player/enemy state.
  6. Regenerate mana, expire stale damage buffs, emit `enemyDefeated`/`playerDefeated` if health crosses 0.
- `runSim(seed: number, inputs: readonly InputFrame[]): { state: CombatState; events: SimEvent[] }` — folds `step` over a full input sequence from `initCombat(seed)`, concatenating events, for reuse by tests, integration, and the balance harness.

## Invariants tested

- Replaying a fixed input sequence from a fixed seed reproduces byte-identical `CombatState` and event lists on every run.
- A defend input pressed exactly at the enemy's hit tick (or within the perfect window of it) always registers `perfect` and zeroes the incoming damage; outside the perfect window but inside the normal window always registers `normal` and halves it; outside both always yields full damage.
- Only the first defend input during a given windup is registered; later presses in the same windup are no-ops.
- An `externalEffect` whose `manaCost` exceeds current mana is rejected and mana/health are unchanged; one whose cost is affordable spends exactly that much mana.
- Mana never exceeds `maxMana` or drops below 0; health never goes below 0 or above `maxHealth`.
- Player position stays within arena bounds regardless of how long `moveDir` is held.

## Out of scope

- Interpreting cards/synergies as `ExternalEffect`s (spec 004).
- Rendering, input capture from a keyboard/gamepad (spec 005).
- Enemy variety beyond one scripted dummy attack pattern.
