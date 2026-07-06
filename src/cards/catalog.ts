import type { CardDef, Catalog, SynergyDef } from './types.js';

const CARD_DEFS: readonly CardDef[] = [
  { id: 'fireball', name: 'Fireball', tags: ['fire', 'projectile'], cost: 2, effect: { kind: 'damage', amount: 10 } },
  { id: 'emberlash', name: 'Ember Lash', tags: ['fire', 'melee'], cost: 1, effect: { kind: 'damage', amount: 4 } },
  { id: 'iceshard', name: 'Ice Shard', tags: ['ice', 'projectile'], cost: 2, effect: { kind: 'damage', amount: 8 } },
  { id: 'frostbite', name: 'Frostbite', tags: ['ice', 'debuff'], cost: 1, effect: { kind: 'damage', amount: 2 } },
  { id: 'guardbreak', name: 'Guard Break', tags: ['melee', 'armor-break'], cost: 1, effect: { kind: 'damage', amount: 5 } },
  {
    id: 'manasurge',
    name: 'Mana Surge',
    tags: ['arcane', 'utility'],
    cost: 0,
    effect: { kind: 'buffDamage', amount: 3, durationTicks: 180 },
  },
];

export const CARD_CATALOG: Catalog = new Map(CARD_DEFS.map((def) => [def.id, def]));

export const SYNERGY_DEFS: readonly SynergyDef[] = [
  {
    id: 'inferno',
    requiredTags: ['fire', 'fire'],
    effect: { kind: 'damageMultiplier', multiplier: 1.5 },
  },
  {
    id: 'permafrost',
    requiredTags: ['ice', 'ice'],
    effect: { kind: 'damageMultiplier', multiplier: 1.5 },
  },
  {
    id: 'elemental-overload',
    requiredTags: ['fire', 'ice'],
    effect: { kind: 'manaRefund', amount: 1 },
  },
];
