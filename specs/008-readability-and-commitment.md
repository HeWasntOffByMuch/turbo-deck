# 008 — Readability pass: slower pacing, attack commitment, richer visuals

## Problem

The top-down combat (spec 007) is mechanically complete but hard to read at
speed: the enemy telegraph is only ~0.4s, both actors slide around while
attacking, and the renderer shows little about *why* something happened
(when to parry, where an attack reaches, who just got hit). This spec slows
the loop down and makes it legible, without changing the sim/render split or
determinism.

Three changes, split across the layers:

1. **Slower pacing (sim tuning).** Longer enemy idle/windup/recovery and
   slightly slower movement, so the orange danger zone visibly grows and the
   player has time to read and react. The perfect/normal defense windows widen
   a little but stay skill-based.
2. **Attack commitment / "stop when attacking" (sim rule).** The player is
   rooted for a short window when they swing (`moveLockUntil`); movement input
   is ignored while committed. The enemy moves **only during idle** — it plants
   for the whole windup and recovery, so a slam always lands where it was
   telegraphed and the recovery is a clear punish window.
3. **Richer visuals (render only).** Zoomed-in arena, actor labels, an enemy
   phase banner with a windup countdown, a "PARRY / DODGE" timing prompt that
   brightens inside the perfect window, a translucent attack-swing wedge shown
   while the player is committed (visualising aim + reach), and brief hit
   flashes on damage. No game rules move into the renderer.

## Shape

`src/sim/constants.ts` — retuned durations/speeds; new `ATTACK_ROOT_TICKS`.
Indicative values: move 2.0 / enemy 1.0 per tick; idle 66 / windup 54 /
recovery 54; perfect 4 / normal 14; attack cooldown 24; root 12; larger radii
and zone for visibility. All still integer/float, no randomness.

`src/sim/types.ts` — `PlayerState` gains `moveLockUntil: number` (tick).

`src/sim/combat.ts` — `step` order changes so the attack decision is known
before movement:
1. `willAttack = attack && tick >= attackCooldownUntil`.
2. `rooted = willAttack || tick < moveLockUntil`; apply movement only if not
   rooted (so the player stops on the swing tick and for `ATTACK_ROOT_TICKS`
   after).
3. Resolve the attack; on a swing set both `attackCooldownUntil` and
   `moveLockUntil`.
4. Enemy homes toward the player **only while `phase === 'idle'`** (was: any
   phase except windup).
Everything else (telegraph snapshot, positional resolution, defense timing,
cards, mana) is unchanged.

`src/render/scene.ts` + `input.ts` — presentation only: larger `ARENA_SCALE`,
`YOU` / `ENEMY` labels, enemy phase banner + `slam in Ns` countdown during
windup, a defense-timing prompt driven by `enemy.phaseEndsAtTick − tick`
against the window constants (brighter inside the perfect window), an attack
wedge drawn while `tick < player.moveLockUntil` using the current aim, and
short hit-flash timers keyed off `playerHit` / `enemyHit` events. These read
sim state and animation-only counters; they decide no game outcome.

## Invariants tested

- Determinism/replay (spec 003) and card conservation / bounds (spec 004) still
  hold under the new field and tuning.
- While `tick < moveLockUntil` after a swing, movement input does not change the
  player's position; once the root expires, movement resumes.
- The enemy's position is unchanged across every windup **and** recovery tick,
  and only changes during idle.
- Defense timing still resolves perfect/normal/whiffed against the (now wider)
  windows; telegraph dodge-by-moving still avoids the hit.

## Out of scope

- Rebalancing card numbers or the bot to spread balance-harness win rates.
- Enemy variety or a second attack pattern.
- Any animation that changes game state (all render timers are cosmetic).
