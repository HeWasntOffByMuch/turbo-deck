import type { CardDef, Catalog } from './types.js';

/**
 * Cards are data. Active cards fire a one-shot effect when played; passive
 * cards apply a mechanic modifier while held and are simply retired when
 * played. There are no named synergies -- interesting combinations emerge from
 * how the passive modifiers stack against the sim's mechanics.
 */
const CARD_DEFS: readonly CardDef[] = [
  // --- Active cards: one-shot on play, cost mana, refill the slot. ---
  { id: 'fireball', name: 'Fireball', tags: ['fire', 'projectile'], cost: 2, kind: 'active', effect: { kind: 'damage', amount: 10 } },
  { id: 'iceshard', name: 'Ice Shard', tags: ['ice', 'projectile'], cost: 2, kind: 'active', effect: { kind: 'damage', amount: 8 } },
  { id: 'emberlash', name: 'Ember Lash', tags: ['fire', 'melee'], cost: 1, kind: 'active', effect: { kind: 'damage', amount: 5 } },
  { id: 'guardbreak', name: 'Guard Break', tags: ['melee', 'armor-break'], cost: 1, kind: 'active', effect: { kind: 'damage', amount: 6 } },
  { id: 'mend', name: 'Mend', tags: ['holy', 'utility'], cost: 3, kind: 'active', effect: { kind: 'heal', amount: 30 } },
  { id: 'warcry', name: 'War Cry', tags: ['fury', 'utility'], cost: 2, kind: 'active', effect: { kind: 'buffDamage', amount: 4, durationTicks: 240 } },

  // --- Passive cards: apply while held, no mana cost, playing them retires the effect. ---
  { id: 'sharpen', name: 'Sharpen Blade', tags: ['passive', 'offense'], cost: 0, kind: 'passive', passive: { kind: 'attackDamage', amount: 4 } },
  { id: 'momentum', name: 'Momentum', tags: ['passive', 'offense'], cost: 0, kind: 'passive', passive: { kind: 'nthStrikeDamage', everyN: 2, bonusFraction: 0.2 } },
  { id: 'vigor', name: 'Vigor', tags: ['passive', 'sustain'], cost: 0, kind: 'passive', passive: { kind: 'healthRegen', perSecond: 3 } },
  { id: 'focus', name: 'Focus', tags: ['passive', 'arcane'], cost: 0, kind: 'passive', passive: { kind: 'manaRegen', perSecond: 1.5 } },
  { id: 'bloodpact', name: 'Blood Pact', tags: ['passive', 'sustain'], cost: 0, kind: 'passive', passive: { kind: 'healOnHurt', amount: 6 } },
  { id: 'recklesshex', name: 'Reckless Hex', tags: ['passive', 'curse'], cost: 0, kind: 'passive', passive: { kind: 'enemyTempo', speedMultiplier: 0.55, damageMultiplier: 0.5 } },
];

export const CARD_CATALOG: Catalog = new Map(CARD_DEFS.map((def) => [def.id, def]));
