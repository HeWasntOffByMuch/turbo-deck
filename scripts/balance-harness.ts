import { runArchetype, type Archetype } from '../src/balance/harness.js';

const ARCHETYPES: readonly Archetype[] = [
  {
    name: 'fire-aggro',
    deck: [
      'fireball', 'fireball', 'fireball', 'fireball', 'fireball', 'fireball',
      'emberlash', 'emberlash', 'emberlash', 'emberlash', 'emberlash', 'emberlash',
      'guardbreak', 'guardbreak', 'guardbreak',
    ],
  },
  {
    name: 'ice-control',
    deck: [
      'iceshard', 'iceshard', 'iceshard', 'iceshard', 'iceshard', 'iceshard',
      'frostbite', 'frostbite', 'frostbite', 'frostbite', 'frostbite', 'frostbite',
      'guardbreak', 'guardbreak', 'guardbreak',
    ],
  },
  {
    name: 'elemental-overload',
    deck: [
      'fireball', 'fireball', 'fireball', 'fireball', 'fireball',
      'iceshard', 'iceshard', 'iceshard', 'iceshard', 'iceshard',
      'emberlash', 'emberlash', 'emberlash',
      'frostbite', 'frostbite',
    ],
  },
  {
    name: 'utility-heavy',
    deck: [
      'manasurge', 'manasurge', 'manasurge', 'manasurge', 'manasurge', 'manasurge',
      'guardbreak', 'guardbreak', 'guardbreak', 'guardbreak',
      'fireball', 'fireball', 'fireball',
      'iceshard', 'iceshard',
    ],
  },
  {
    name: 'balanced',
    deck: [
      'fireball', 'fireball', 'fireball',
      'emberlash', 'emberlash', 'emberlash',
      'iceshard', 'iceshard', 'iceshard',
      'frostbite', 'frostbite', 'frostbite',
      'guardbreak', 'guardbreak',
      'manasurge',
    ],
  },
];

const RUNS_PER_ARCHETYPE = 150;
const MAX_TICKS = 4000; // ~67s of sim time per run
const BASE_SEED = 1;

function formatRow(name: string, winRate: number, avgTicks: number, wins: number, losses: number, timeouts: number): string {
  const winRatePct = `${(winRate * 100).toFixed(1)}%`.padStart(7);
  const avgSeconds = (avgTicks / 60).toFixed(1).padStart(6);
  return `${name.padEnd(20)} winRate=${winRatePct}  avgRun=${avgSeconds}s  (W:${wins} L:${losses} T:${timeouts})`;
}

console.log(`Monte Carlo balance harness -- ${RUNS_PER_ARCHETYPE} runs/archetype, cap ${MAX_TICKS} ticks\n`);

for (const archetype of ARCHETYPES) {
  const result = runArchetype(archetype, RUNS_PER_ARCHETYPE, MAX_TICKS, BASE_SEED);
  console.log(formatRow(result.archetype, result.winRate, result.averageRunTicks, result.wins, result.losses, result.timeouts));
}
