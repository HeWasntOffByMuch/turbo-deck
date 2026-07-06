import { CARD_CATALOG, SYNERGY_DEFS } from '../cards/catalog.js';
import { initGame, stepGame } from '../game/session.js';
import { Rng } from '../shared/prng.js';
import { botInput } from './bot.js';

export interface Archetype {
  readonly name: string;
  readonly deck: readonly string[];
}

export interface RunOutcome {
  readonly outcome: 'win' | 'loss' | 'timeout';
  readonly ticks: number;
}

export interface ArchetypeResult {
  readonly archetype: string;
  readonly runs: number;
  readonly wins: number;
  readonly losses: number;
  readonly timeouts: number;
  readonly winRate: number;
  readonly averageRunTicks: number;
}

/** Reaction-timing jitter for the bot's defend attempts: mostly early/on-time, sometimes late enough to whiff. */
const REACTION_JITTER_MIN = -6;
const REACTION_JITTER_MAX = 2;

export function simulateOneRun(deck: readonly string[], seed: number, maxTicks: number): RunOutcome {
  let state = initGame(seed, deck);
  let botRng = Rng.fromSeed(seed ^ 0x9e3779b9);
  let plannedReactionTick: number | null = null;

  for (let tick = 1; tick <= maxTicks; tick++) {
    const enemy = state.combat.enemy;
    if (enemy.phase === 'windup') {
      if (plannedReactionTick === null) {
        const [jitter, nextRng] = botRng.nextInt(REACTION_JITTER_MIN, REACTION_JITTER_MAX);
        botRng = nextRng;
        plannedReactionTick = enemy.phaseEndsAtTick + jitter;
      }
    } else {
      plannedReactionTick = null;
    }

    const input = botInput(state, plannedReactionTick, tick);
    const result = stepGame(state, input, CARD_CATALOG, SYNERGY_DEFS);
    state = result.state;

    if (result.events.some((event) => event.kind === 'enemyDefeated')) return { outcome: 'win', ticks: tick };
    if (result.events.some((event) => event.kind === 'playerDefeated')) return { outcome: 'loss', ticks: tick };
  }

  return { outcome: 'timeout', ticks: maxTicks };
}

export function runArchetype(
  archetype: Archetype,
  runsPerArchetype: number,
  maxTicks: number,
  baseSeed: number,
): ArchetypeResult {
  let wins = 0;
  let losses = 0;
  let timeouts = 0;
  let totalTicks = 0;

  for (let i = 0; i < runsPerArchetype; i++) {
    const seed = baseSeed + i * 7919;
    const { outcome, ticks } = simulateOneRun(archetype.deck, seed, maxTicks);
    totalTicks += ticks;
    if (outcome === 'win') wins++;
    else if (outcome === 'loss') losses++;
    else timeouts++;
  }

  return {
    archetype: archetype.name,
    runs: runsPerArchetype,
    wins,
    losses,
    timeouts,
    winRate: wins / runsPerArchetype,
    averageRunTicks: totalTicks / runsPerArchetype,
  };
}
