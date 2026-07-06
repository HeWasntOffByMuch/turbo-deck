# 006 — Monte Carlo balance harness

## Problem

Once cards, sim, and their wiring exist, the question shifts from "does it
work" to "is it balanced" — which deck archetypes win too often. That needs
a headless script that plays many full runs per archetype against the
scripted dummy and reports win rate / run length, so overpowered synergies
show up as data rather than as a hunch.

## Shape

`src/balance/bot.ts` — a deterministic, seeded policy function, *not* game
logic: given a `GameState` and a per-windup "planned reaction tick" (itself
drawn from a seeded `Rng`, independent of the sim's own seed), it produces
a `GameInput`: close distance or attack when in range, attempt a defend
right at its planned tick, and play the cheapest affordable card (bonus
slot first, else the first affordable hand slot). This models a
consistent, moderately-skilled player so that win-rate differences
between archetypes reflect deck composition, not bot skill variance.

`src/balance/harness.ts`:
```ts
interface Archetype { name: string; deck: readonly string[]; }
interface RunOutcome { outcome: 'win' | 'loss' | 'timeout'; ticks: number; }
interface ArchetypeResult {
  archetype: string; runs: number;
  wins: number; losses: number; timeouts: number;
  winRate: number; averageRunTicks: number;
}

function simulateOneRun(deck: readonly string[], seed: number, maxTicks: number): RunOutcome;
function runArchetype(archetype: Archetype, runsPerArchetype: number, maxTicks: number, baseSeed: number): ArchetypeResult;
```
A run ends in `'win'`/`'loss'` on the sim's `enemyDefeated`/`playerDefeated`
events, or `'timeout'` if neither happens within `maxTicks`.

`scripts/balance-harness.ts` — the `npm run balance` entry point: defines a
handful of example archetypes (fire-aggro, ice-control, an
elemental-overload mix, a utility-heavy control deck, a balanced deck),
runs `runArchetype` for each, and prints a plain-text table of win rate and
average run length so an agent (or a person) can spot an outlier
archetype and go tune its cards.

## Invariants tested

- `runArchetype` is deterministic: the same `(archetype, runsPerArchetype, maxTicks, baseSeed)` produces the same `ArchetypeResult` every time.
- `winRate` is always in `[0, 1]` and `wins + losses + timeouts === runs`.
- Every run's `ticks` is between 1 and `maxTicks` inclusive.
- The bot never produces an input that crashes `stepGame` (reuses the fuzz smoke test's confidence rather than re-deriving it) across all example archetypes for a short run.

## Out of scope

- Actually rebalancing any card numbers — this spec only builds the
  measurement tool.
- A UI for the report; plain stdout text is enough for a PoC.
- Bot skill as a tunable axis (fixed "moderately skilled" policy only).
