/**
 * The six attributes, as a table (spec 147).
 *
 * Same contract as SKILLS, ITEMS and ABILITIES: a save holds numbers, and
 * everything an attribute *means* lives here and is re-read on every
 * recalculation. Retuning what Perception is worth changes it for every
 * character at their next login, with no migration.
 *
 * What is deliberately in this file and nowhere else is the **prose**: the
 * identity, the route to staying alive, and -- the field that stops the design
 * rotting -- what the attribute does not own. `notOwned` is not documentation
 * for a player. It is the thing a reviewer holds a new mechanic up against when
 * somebody proposes hanging attack speed off Agility for the third time, and it
 * is asserted by a test that every mechanic named in one attribute's `owns` is
 * named in nobody else's.
 *
 * Pure data. No behaviour, no imports.
 */

import type { BaseStatKey } from '../state/types.js';

export type AttributeKey = BaseStatKey;

export interface AttributeDefinition {
  readonly key: AttributeKey;
  readonly name: string;
  /** Three letters, for a sheet with six rows and not much width. */
  readonly abbrev: string;
  /** The one-word verb. What a player picks this to *do*. */
  readonly verb: string;
  /** The mechanics this attribute is the source of. */
  readonly owns: readonly string[];
  /**
   * How a character built on this stays alive. Every attribute has one, and no
   * two are the same one -- that is the property that stops Constitution from
   * becoming a tax.
   */
  readonly sustain: string;
  /** What it explicitly is not the source of, and who is. */
  readonly notOwned: readonly string[];
}

export const ATTRIBUTES: readonly AttributeDefinition[] = [
  {
    key: 'strength',
    name: 'Strength',
    abbrev: 'STR',
    verb: 'Overpower',
    // Three attributes name a weapon-damage claim since spec 215 and they are
    // three different claims, not one shared three ways: a maul pays Strength,
    // the Weighted Stars pay Agility, the Emberwood Staff pays Intelligence, and
    // which of them a swing pays is the *weapon's* letter rather than a rule
    // about the attribute. Nobody is forced into another attribute to be paid
    // for their own, which is what the no-shared-mechanic rule is protecting.
    owns: ['poise damage', 'stagger duration', 'hyper-armour', 'weapon damage on a Strength-scaling weapon'],
    sustain: 'Ends the fight. A staggered enemy is not attacking, and force converts into resource on the kill.',
    notOwned: ['health pools (Constitution)', 'attack rate (nothing)', 'armour (Constitution)'],
  },
  {
    key: 'agility',
    name: 'Agility',
    abbrev: 'AGI',
    verb: 'Outmaneuver',
    owns: [
      'wind-up length',
      'backswing length',
      'weapon handling',
      'move speed',
      'turn rate',
      'flow',
      'weapon damage on an Agility-scaling weapon',
    ],
    sustain: 'Is not there. The rooted fraction of every attack shrinks; the interval never does.',
    notOwned: ['weak points (Perception)', 'crit (Perception)', 'attack speed (nothing)'],
  },
  {
    key: 'intelligence',
    name: 'Intelligence',
    abbrev: 'INT',
    verb: 'Manipulate',
    owns: [
      'spell power',
      'spell geometry',
      'prepared casting',
      'catalysis',
      'arcane overflow',
      'resource pool',
      'weapon damage on an Intelligence-scaling weapon',
    ],
    sustain: 'Changes the encounter. Reach and radius mean fewer things arrive; sundering means fights are shorter without more damage.',
    notOwned: ['resource efficiency (Wisdom)', 'cooldowns (Wisdom)', 'healing (Wisdom)'],
  },
  {
    key: 'constitution',
    name: 'Constitution',
    abbrev: 'CON',
    verb: 'Endure',
    owns: ['max health', 'poise pool', 'poise regen', 'shields', 'low-health behaviour', 'armour'],
    sustain: 'Absorbs. The only route that is literally taking the hit.',
    notOwned: ['healing efficiency (Wisdom)', 'weapon damage (the weapon decides)', 'stagger power (Strength)'],
  },
  {
    key: 'perception',
    name: 'Perception',
    abbrev: 'PER',
    verb: 'Exploit',
    owns: ['weak points', 'exposure', 'opening reads', 'crit', 'precision recovery'],
    sustain: 'Acts first. A committed enemy cannot answer, and landing precisely is what pays for the next attempt.',
    notOwned: ['how fast you act (Agility)', 'movement (Agility)', 'weapon damage (the weapon decides)'],
  },
  {
    key: 'wisdom',
    name: 'Wisdom',
    abbrev: 'WIS',
    verb: 'Sustain',
    owns: ['ability cost', 'cooldown length', 'healing received', 'attunement', 'adaptation', 'conversion', 'mastery'],
    sustain: 'Stretches what it has. The same pool goes further and the same enemy hurts less the third time.',
    notOwned: ['pool size (Intelligence)', 'health (Constitution)', 'weapon damage (the weapon decides)'],
  },
];

export const ATTRIBUTE_KEYS: readonly AttributeKey[] = ATTRIBUTES.map((a) => a.key);

const BY_KEY: ReadonlyMap<string, AttributeDefinition> = new Map(
  ATTRIBUTES.map((definition) => [definition.key, definition]),
);

export function attributeByKey(key: string): AttributeDefinition | null {
  return BY_KEY.get(key) ?? null;
}

export function isAttributeKey(value: string): value is AttributeKey {
  return BY_KEY.has(value);
}

/**
 * The attribute at this position in {@link ATTRIBUTES}, or null.
 *
 * The wire names an attribute by ordinal rather than by string -- one byte
 * instead of a length-prefixed name, and an ordinal out of range is a rejection
 * with nothing to parse. `BASE_STAT_KEYS` is the canonical order and this is the
 * only place that turns it back into a key.
 */
export function attributeByOrdinal(ordinal: number): AttributeDefinition | null {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= ATTRIBUTES.length) return null;
  return ATTRIBUTES[ordinal] ?? null;
}

export function ordinalOfAttribute(key: AttributeKey): number {
  return ATTRIBUTE_KEYS.indexOf(key);
}
