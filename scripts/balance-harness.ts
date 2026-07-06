import { runArchetype, type Archetype } from '../src/balance/harness.js';

const ARCHETYPES: readonly Archetype[] = [
  {
    // Pure active damage, no passives held.
    name: 'raw-aggro',
    deck: [
      'fireball', 'fireball', 'fireball', 'fireball', 'fireball',
      'iceshard', 'iceshard', 'iceshard', 'iceshard',
      'emberlash', 'emberlash', 'emberlash',
      'guardbreak', 'guardbreak', 'guardbreak',
    ],
  },
  {
    // Offensive passives: flat + every-other-strike bonus stacked with attacks.
    name: 'strike-stacker',
    deck: [
      'sharpen', 'sharpen', 'sharpen',
      'momentum', 'momentum', 'momentum',
      'fireball', 'fireball', 'fireball',
      'emberlash', 'emberlash', 'emberlash',
      'guardbreak', 'guardbreak', 'guardbreak',
    ],
  },
  {
    // The emergent sustain combo: enemy fast-but-weak + heal-on-hurt + regen.
    name: 'hex-sustain',
    deck: [
      'recklesshex', 'recklesshex', 'recklesshex',
      'bloodpact', 'bloodpact', 'bloodpact',
      'vigor', 'vigor', 'vigor',
      'fireball', 'fireball', 'fireball',
      'emberlash', 'emberlash', 'emberlash',
    ],
  },
  {
    // Mana engine: focus passives fuel constant active casting.
    name: 'focus-caster',
    deck: [
      'focus', 'focus', 'focus',
      'fireball', 'fireball', 'fireball', 'fireball', 'fireball',
      'iceshard', 'iceshard', 'iceshard', 'iceshard',
      'mend', 'mend', 'warcry',
    ],
  },
  {
    // A little of everything.
    name: 'balanced',
    deck: [
      'sharpen', 'momentum', 'vigor', 'focus', 'bloodpact', 'recklesshex',
      'fireball', 'fireball', 'iceshard', 'iceshard',
      'emberlash', 'guardbreak', 'mend', 'warcry', 'guardbreak',
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
