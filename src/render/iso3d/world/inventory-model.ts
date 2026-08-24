/**
 * What the inventory screen is handed (spec 127).
 *
 * The one file that reads both sides: the replicated containers on one hand, the
 * item table on the other, out to the plain view-model `src/ui/` is allowed to
 * hold. That boundary is not bureaucracy -- lint refuses `src/ui/` the imports
 * needed to build this, because layer 1 has to be portable to an engine that has
 * never heard of `PersistedPlayer`. This is where that costs something, and it
 * costs one pure function.
 *
 * Pure and headlessly tested: it is a mapping, and a mapping is exactly the kind
 * of thing that is checked in Node rather than looked at in a browser.
 */

import { itemById, rarityOf } from '../../../server/data/items.js';
import { rarityRow } from '../../../server/data/loot.js';
import type { StatModifier } from '../../../server/data/modifiers.js';
import type { ItemDefinition } from '../../../server/data/items.js';
import {
  effectiveScaling,
  letterOf,
  NO_GRADE_MODIFIERS,
  NO_SCALING,
  SCALING_ATTRIBUTES,
  type ScalingGradeModifiers,
} from '../../../server/data/weapon-scaling.js';
import { abilityById } from '../../../server/data/abilities.js';
import { describeAbility } from '../../../server/data/description.js';
import {
  EQUIP_SLOTS,
  isSkillSlot,
  SKILL_EQUIP_SLOTS,
  slotFamily,
  type Equipment,
  type EquipSlot,
  type EquipTarget,
  type Inventory,
} from '../../../server/state/types.js';
import type {
  ContainerView,
  ItemDetail,
  ItemDetailSpan,
  ItemView,
  SlotDescriptor,
} from '../../../ui/screens/inventory.js';
import type { SwapProgress } from './skill-swap-view.js';

/**
 * An item id to a sprite name.
 *
 * Here rather than in `data/items.ts` because it is *art direction* and that
 * table is game rules -- and here rather than in `src/ui/` because the screen
 * must not know what a `sword.keen` is. Unknown ids fall through to the box, so a
 * content edit shows up as a wrong picture rather than as a crash.
 */
const ICONS: Readonly<Record<string, string>> = {
  'sword.worn': 'item:sword',
  'sword.keen': 'item:sword',
  'maul.iron': 'item:sword',
  'staff.emberwood': 'item:staff',
  'bow.hunting': 'item:bow',
  'stars.weighted': 'item:star',
  'shield.oak': 'item:shield',
  'focus.quartz': 'item:focus',
  'helm.leather': 'item:helm',
  'helm.plated': 'item:helm',
  'chest.leather': 'item:chest',
  'chest.scale': 'item:chest',
  'legs.traveller': 'item:legs',
  'trinket.swiftband': 'item:trinket',
  'trinket.bloodstone': 'item:trinket',
  'potion.minor': 'item:potion',
  // The sigils (specs 188, 190). One picture between them on purpose: a sigil is
  // a skill in a bag, and what tells them apart is the name in the tooltip and
  // the ability behind it rather than eleven variants of the same lozenge.
  'sigil.guardBreak': 'item:sigil',
  'sigil.stunningBlow': 'item:sigil',
  'sigil.whirlwind': 'item:sigil',
  'sigil.cripplingStrike': 'item:sigil',
  'sigil.poisonDart': 'item:sigil',
  'sigil.rendingCut': 'item:sigil',
  'sigil.emberToss': 'item:sigil',
  'sigil.acidSpray': 'item:sigil',
  'sigil.arcLash': 'item:sigil',
  'sigil.rimeTouch': 'item:sigil',
  'sigil.blight': 'item:sigil',
  // The test row's sigil (spec 190). The same picture again: it is a skill in
  // a bag like the four above, and what says it is a test one is its name.
  'sigil.testStatuses': 'item:sigil',
};

export const UNKNOWN_ICON = 'item:unknown';

export function iconFor(defId: string): string {
  return ICONS[defId] ?? UNKNOWN_ICON;
}

/**
 * How a slot is named to a player. Title-casing `mainHand` gives "Mainhand".
 *
 * Two names each since spec 185, and the reason is where they are read. The
 * paperdoll's labels sit in a column beside 20px cells and have to be terse; a
 * tooltip has a line to itself and "Main" alone is a riddle. One table, so the
 * two can never come to name different slots.
 */
const SLOT_LABELS: Readonly<Record<EquipSlot, { readonly short: string; readonly long: string }>> = {
  mainHand: { short: 'Main', long: 'Main Hand' },
  offHand: { short: 'Off', long: 'Off Hand' },
  head: { short: 'Head', long: 'Head' },
  chest: { short: 'Chest', long: 'Chest' },
  legs: { short: 'Legs', long: 'Legs' },
  trinket: { short: 'Charm', long: 'Trinket' },
  // Numbered rather than named, because the number *is* the key you press
  // (spec 188): the four cells beside the bag and the four along the bottom of
  // the screen are the same four slots, and a cell labelled "Skill" would be
  // the interface declining to say which.
  skill1: { short: '1', long: 'Skill 1' },
  skill2: { short: '2', long: 'Skill 2' },
  skill3: { short: '3', long: 'Skill 3' },
  skill4: { short: '4', long: 'Skill 4' },
};

/**
 * What a *family* is called in a tooltip (spec 188).
 *
 * `ItemDefinition.slot` names where a thing is worn, and for a sigil that is
 * the family `skill` rather than any one of the four -- so the tooltip needs a
 * word for it that the paperdoll's per-slot table cannot supply. One line here
 * rather than a fifth entry in the table above, because "which slot is this in"
 * and "what kind of thing is this" are different questions.
 */
function wornName(target: EquipTarget): string {
  return target === 'skill' ? 'Skill' : SLOT_LABELS[target].long;
}

/**
 * How a modifier is written out (spec 185).
 *
 * Here rather than in `data/modifiers.ts` for the reason {@link ICONS} gives:
 * this is what a player is told and that file is what the sim computes. Ordered,
 * and read in order, so two items with the same stats list them the same way
 * rather than in whatever order somebody happened to author the object in.
 *
 * `higherIsBetter` is one field and it exists so a stat where *less* is more
 * cannot be coloured as a benefit by accident. Every row but the attack delay
 * is `true` today; the delay is the reason the field is not an assumption.
 *
 * A field with no row here draws no line at all -- an unknown stat is a missing
 * description, not a crash, and not a raw key in front of a player.
 */
interface StatLabel {
  readonly key: keyof Omit<StatModifier, 'traits'>;
  readonly name: string;
  /** Whether the number is a fraction shown as a percentage. */
  readonly percent: boolean;
  readonly higherIsBetter?: boolean;
}

const STAT_LABELS: readonly StatLabel[] = [
  // Attribute grants first: they are the biggest thing an item can say, since
  // spec 147 made an attribute open milestones rather than nudge a coefficient.
  { key: 'strength', name: 'Strength', percent: false },
  { key: 'agility', name: 'Agility', percent: false },
  { key: 'intelligence', name: 'Intelligence', percent: false },
  { key: 'constitution', name: 'Constitution', percent: false },
  { key: 'perception', name: 'Perception', percent: false },
  { key: 'wisdom', name: 'Wisdom', percent: false },
  // Then the grade steps (spec 215), beside the attributes because they are the
  // same kind of claim -- a thing about the character rather than about a
  // number -- and above the stat lines for the same reason a weapon's own
  // scaling line is. `writeAmount` already writes a signed integer, so
  // `+1 Agility Scaling` needs no special case.
  { key: 'strengthScalingGrade', name: 'Strength Scaling', percent: false },
  { key: 'agilityScalingGrade', name: 'Agility Scaling', percent: false },
  { key: 'intelligenceScalingGrade', name: 'Intelligence Scaling', percent: false },
  // ...then what it does to the numbers, offence before defence before movement.
  { key: 'attackDamage', name: 'Damage', percent: false },
  { key: 'attackDamagePct', name: 'Damage', percent: true },
  { key: 'attackRange', name: 'Range', percent: false },
  { key: 'attackSpeed', name: 'Attack Speed', percent: true },
  { key: 'attackSpeedPct', name: 'Attack Speed', percent: true },
  { key: 'attackCooldownTicks', name: 'Attack Delay', percent: false, higherIsBetter: false },
  { key: 'critChance', name: 'Crit Chance', percent: true },
  { key: 'spellPower', name: 'Spell Power', percent: true },
  { key: 'maxHealth', name: 'Health', percent: false },
  { key: 'maxHealthPct', name: 'Health', percent: true },
  { key: 'armor', name: 'Armour', percent: true },
  { key: 'maxResource', name: 'Resource', percent: false },
  { key: 'resourceRegen', name: 'Resource Regen', percent: false },
  { key: 'moveSpeed', name: 'Move Speed', percent: false },
  { key: 'moveSpeedPct', name: 'Move Speed', percent: true },
  { key: 'turnRate', name: 'Turn Rate', percent: false },
];

/** `8` -> `+8`, `-0.2` at percent -> `-20%`. Signed always: a `+` is the point. */
function writeAmount(value: number, percent: boolean): string {
  const scaled = percent ? value * 100 : value;
  // Rounded to a tenth and then trimmed, so `0.15 * 100` reads `15%` rather than
  // `15.000000000000002%` and a genuinely fractional flat stat still says so.
  const rounded = Math.round(scaled * 10) / 10;
  const sign = rounded >= 0 ? '+' : '-';
  return `${sign}${Math.abs(rounded)}${percent ? '%' : ''}`;
}

/**
 * What an item does, one line per modifier it carries.
 *
 * Zero is skipped rather than written as `+0`: a row that sets a field to zero
 * is saying nothing, and a line saying nothing is worse than no line.
 */
function statDetails(modifiers: StatModifier): ItemDetail[] {
  const lines: ItemDetail[] = [];
  for (const label of STAT_LABELS) {
    const value = modifiers[label.key];
    if (typeof value !== 'number' || value === 0) continue;
    const good = value > 0 === (label.higherIsBetter ?? true);
    lines.push({ text: `${writeAmount(value, label.percent)} ${label.name}`, tone: good ? 'good' : 'bad' });
  }
  return lines;
}

/**
 * What a weapon scales with, as one compact line (spec 215).
 *
 * Three positions, always `Strength / Agility / Intelligence` in that fixed
 * order, one character each, `-` for `None`. Never reordered by strongest --
 * position *is* the attribute, which is what lets the line be three characters
 * instead of three labelled rows.
 *
 * The grades come from {@link effectiveScaling}, the same resolver
 * `computeEffectiveStats` runs the damage through, so what a player is told and
 * what a blow does cannot drift: a modifier that moved one moved both, and
 * neither this file nor `src/ui/` has any modifier arithmetic in it to disagree
 * with.
 *
 * Absent for anything that is not a weapon. A main hand with no scaling
 * configured still draws `- / - / -`, because "this scales with nothing" is a
 * fact worth stating about a weapon and an empty line would read as a tooltip
 * that had forgotten to mention it.
 */
function scalingDetail(definition: ItemDefinition, modifiers: ScalingGradeModifiers): ItemDetail | null {
  if (definition.slot !== 'mainHand') return null;
  const effective = effectiveScaling(definition.scaling ?? NO_SCALING, modifiers);
  const spans: ItemDetailSpan[] = [];
  SCALING_ATTRIBUTES.forEach((attribute, index) => {
    // The separator takes `normal` -- the tooltip's own text colour -- so only
    // the three letters carry an attribute hue and the line reads as three
    // marked positions rather than as coloured punctuation.
    if (index > 0) spans.push({ text: SCALING_SEPARATOR, tone: 'normal' });
    spans.push({ text: letterOf(effective[attribute]), tone: attribute });
  });
  return { text: spans.map((span) => span.text).join(''), tone: 'normal', spans };
}

/** What sits between two grades. One string, so the text and the runs agree. */
const SCALING_SEPARATOR = ' / ';

function descriptorOf(slot: EquipSlot): SlotDescriptor {
  // `accepts` is the **family**, which is what makes one `slot: 'skill'` sigil
  // row fit any of the four skill slots (spec 188). It is the slot's own name
  // for everything else, so nothing about the paperdoll changes.
  //
  // Derived here rather than in the screen because `slotFamily` is the server's
  // rule and `src/ui/` may not import it -- and a screen with its own copy is a
  // second answer to "will this cell take this", free to disagree with the one
  // `applyMove` will give. It did disagree: the cell compared a sigil's `skill`
  // against the cell's `skill1` and refused every drop the server would have
  // taken, which made the whole feature unreachable with nothing on screen
  // saying why.
  return { id: slot, label: SLOT_LABELS[slot].short, accepts: slotFamily(slot) };
}

/**
 * The worn slots, which is every equipment slot that is not a skill (spec 188).
 *
 * Derived by exclusion rather than listed, so a seventh piece of armour appears
 * on the paperdoll by being added to `EQUIP_SLOTS` and nothing here has to be
 * remembered.
 */
export const EQUIPMENT_SLOT_VIEW: readonly SlotDescriptor[] = EQUIP_SLOTS.filter(
  (slot) => !isSkillSlot(slot),
).map(descriptorOf);

/** The four skill slots, in bar order (spec 188). */
export const SKILL_SLOT_VIEW: readonly SlotDescriptor[] = SKILL_EQUIP_SLOTS.map(descriptorOf);

/**
 * Everything an item says about itself under its name (spec 185).
 *
 * The tier and where it is worn on one line, because they are one sentence --
 * "a rare thing you hold in your main hand" -- and two lines of two words each
 * over a 20px cell is a paragraph. Then the stats, then the worth.
 *
 * The level gate is deliberately *not* here: it is the only thing about an item
 * that depends on who is holding it, and `InventoryScreen` adds it against the
 * character's own level. Baking it in would mean rebuilding every view the
 * moment somebody levelled.
 */
export function detailsFor(
  defId: string,
  modifiers: ScalingGradeModifiers = NO_GRADE_MODIFIERS,
): readonly ItemDetail[] {
  const definition = itemById(defId);
  const rarity = rarityOf(defId);
  const tier = rarityRow(rarity).name;
  const slot = definition?.slot ?? null;
  const lines: ItemDetail[] = [
    { text: slot === null ? tier : `${tier}  ${wornName(slot)}`, tone: 'rarity' },
  ];
  if (definition) {
    // Above the stat lines: what a weapon scales with is the first thing a
    // player decides on, and it is the line the other numbers are read against.
    const scaling = scalingDetail(definition, modifiers);
    if (scaling) lines.push(scaling);
    lines.push(...statDetails(definition.modifiers));
    // A sigil's Technical Description is its *skill's* (spec 191). Before this,
    // a sigil said its tier, that it went in a skill slot, and what it was
    // worth -- and nothing at all about what it did, because `modifiers` is
    // deliberately empty on those rows and the stat lines above are all a
    // tooltip had. The one thing a player wants to know about a sigil was the
    // one thing it would not say.
    //
    // Read through the writer rather than copied here, so a retune of
    // `data/abilities.ts` reaches the bag with nothing to remember.
    const skill = definition.activeSkillId === undefined ? null : abilityById(definition.activeSkillId);
    if (skill) {
      for (const line of describeAbility(skill).lines) {
        // `normal` for what it does, `dim` for the small print. The tones are
        // the view-model's vocabulary and `src/ui/` decides what they look
        // like, which is why the mapping is here and the colours are not.
        lines.push({ text: line.text, tone: line.tone === 'note' ? 'dim' : 'normal' });
      }
    }
    // `0` is "cannot be sold" rather than "free" (spec 129), so it is said in
    // as many words -- an omitted line would read as an item nobody had priced.
    lines.push(
      definition.value > 0
        ? { text: `Worth ${definition.value} coins`, tone: 'dim' }
        : { text: 'Cannot be sold', tone: 'dim' },
    );
  }
  return lines;
}

/**
 * One stack as the screen sees it, or null.
 *
 * An id the table no longer defines still draws: it is in somebody's bag and
 * pretending otherwise would make it un-draggable and therefore un-removable.
 */
export function itemViewOf(
  defId: string,
  count: number,
  modifiers: ScalingGradeModifiers = NO_GRADE_MODIFIERS,
): ItemView {
  const definition = itemById(defId);
  return {
    defId,
    name: definition?.name ?? defId,
    count,
    slot: definition?.slot ?? null,
    icon: iconFor(defId),
    levelRequirement: definition?.levelRequirement ?? 1,
    // `common` for an id the table no longer defines, exactly as `rarityOf`
    // answers on the server: a stack nobody can name is drawn quietly rather
    // than not at all.
    rarity: rarityOf(defId),
    details: detailsFor(defId, modifiers),
  };
}

export interface ContainerSource {
  readonly inventory: Inventory;
  readonly equipment: Equipment;
  readonly level: number;
  /**
   * The body's weapon-scaling grade steps, from its replicated `Stats` (spec 215).
   *
   * Handed in rather than derived from `equipment` above, because the server's
   * summation is the one that counts -- it includes the milestones and synergies
   * this side cannot see, and re-deriving it from equipment alone would be a
   * second answer to a question `effectiveScaling` exists to have one answer to.
   *
   * Absent is "no modifiers", which is what a fresh character has and what every
   * test that does not care about them gets.
   */
  readonly scalingModifiers?: ScalingGradeModifiers;
  /** The skill-slot change in flight and how far through it is (spec 188). */
  readonly swap?: SwapProgress | null;
}

/**
 * The whole view, from the client's replicated containers.
 *
 * Takes the three fields rather than a `ClientView`, so a test can build one
 * without standing up a server and so this cannot quietly start depending on the
 * rest of the client's read model.
 */
export function containerViewOf(source: ContainerSource): ContainerView {
  const modifiers = source.scalingModifiers ?? NO_GRADE_MODIFIERS;
  return {
    bag: source.inventory.map((stack) => (stack ? itemViewOf(stack.defId, stack.count, modifiers) : null)),
    worn: Object.fromEntries(
      EQUIP_SLOTS.map((slot) => {
        const id = source.equipment[slot];
        return [slot, id === null ? null : itemViewOf(id, 1, modifiers)];
      }),
    ),
    slots: EQUIPMENT_SLOT_VIEW,
    skillSlots: SKILL_SLOT_VIEW,
    level: source.level,
    // Passed straight through: `swapProgress` has already turned the two server
    // ticks into a fraction, and this layer's job is to hand the screen plain
    // data rather than to work anything out about it.
    ...(source.swap
      ? {
          pendingSwap: {
            from: source.swap.from,
            to: source.swap.to,
            progress: source.swap.progress,
          },
        }
      : {}),
  };
}
