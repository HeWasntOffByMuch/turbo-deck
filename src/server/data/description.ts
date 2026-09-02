/**
 * What a mechanic does, said once (spec 191).
 *
 * The writer for the Technical Description standard in
 * `docs/mechanics-vocabulary.md`. Every player-facing statement about an
 * ability or a status is produced here and nowhere else, which is what makes
 * the brief's bar -- *two designers independently describing the same mechanic
 * produce nearly identical descriptions* -- a property of the module graph
 * rather than a habit somebody has to keep: there is one writer, so there is
 * one description.
 *
 * **Derived, not authored.** The lines are composed from the same row the sim
 * reads, so a retuned number is described correctly on the next frame with
 * nothing to remember. `inventory-model.ts` has worked this way since spec 185
 * -- an item's stat lines come from its `modifiers` rather than from a sentence
 * somebody wrote -- and this is that precedent applied to the two tables that
 * never got it.
 *
 * The corollary is the rule that keeps the file honest: **nothing that can be
 * derived may be authored.** A `StatusVisual` knows its name, its kind and its
 * stack ceiling and does *not* know what the condition does -- that lives in
 * `sim/blow.ts` and `SCALING` -- so the effect sentence is authored on the row
 * and everything around it is composed here. An ability knows all of it, so
 * none of an ability's technical text is authored.
 *
 * **Flavour is never mixed in.** `AbilityDefinition.description` is the
 * authored flavour line and it is returned in its own field, never concatenated
 * into {@link TechnicalDescription.lines} and never included by
 * {@link technicalText}. A flavour line that makes a mechanical claim is a bug,
 * because it will drift from the row beside it.
 *
 * **Nothing is invented.** Where the sim's answer is unclear the line is
 * omitted rather than guessed, and the question is recorded in the document's
 * open-questions section. The two that bite hardest are worth naming here: a
 * shape's `maxTargets` is candidate order rather than distance, so no line may
 * say *the nearest*; and a basic attack's cadence comes from Base Attack Time
 * rather than from its `cooldownTicks`, so no basic attack shows a cooldown.
 *
 * Pure, dependency-free, part of the deterministic core: no clock, no
 * randomness, no entity is read. Every number comes out of a table.
 */

import { SERVER_TICK_RATE } from '../config.js';
import type { AbilityDefinition } from './abilities.js';
import type { StatModifier } from './modifiers.js';
import type { SpecializationDefinition } from './specializations.js';
import { ATTRIBUTES } from './attributes.js';
import { subjectOf, type SkillArea, type SkillEffect } from './skill-effects.js';
import { visualFor, type StatusVisual } from './status-visuals.js';
import {
  dotById,
  dotPulseDamage,
  dotTotalDamage,
  type DotDefinition,
} from './damage-over-time.js';
import { auraFieldById, type AuraFieldDefinition } from './aura-fields.js';
import { abilityProfileOf, isUnscaled } from './ability-scaling.js';
import { letterOf, SCALING_ATTRIBUTES, SCALING_SEPARATOR } from './weapon-scaling.js';
import type { ScalingAttribute } from '../state/types.js';

/**
 * Which register a line is in, so a surface can style the block without
 * parsing it.
 *
 * Also the standard's information order: `target`, `effect`, `cost`, `timing`,
 * `note`. A line with nothing to say is omitted rather than left blank, so the
 * order is stable and a reader learns where to look.
 */
export type Tone = 'target' | 'effect' | 'cost' | 'timing' | 'note';

export interface TechnicalLine {
  readonly text: string;
  readonly tone: Tone;
  /**
   * The line cut into runs, where one colour is not enough (spec 242).
   *
   * Absent for every line but one, and the one is the scaling line: it borrows
   * the weapon tooltip's `S / - / D` notation, where **position is the
   * attribute** and each position is drawn in that attribute's own hue. Three
   * labelled rows would say the same thing and not fit; three coloured
   * characters do.
   *
   * {@link text} is still the whole line, so a caller that wants plain text --
   * `technicalText`, the DOM `title` on the weapon switch -- reads it and never
   * learns runs exist.
   */
  readonly spans?: readonly TechnicalSpan[];
}

/**
 * One run of a {@link TechnicalLine}, and what kind of thing it is.
 *
 * `attribute` rather than a colour, because this file is in the deterministic
 * core and naming a colour here would be the layering violation `Tone` already
 * exists to avoid: the writer says what a run *is* and `src/ui/` says what that
 * looks like. Absent means the run takes the line's own tone, which is what the
 * separators between grades do.
 */
export interface TechnicalSpan {
  readonly text: string;
  readonly attribute?: ScalingAttribute;
}

export interface TechnicalDescription {
  readonly name: string;
  /** The mechanical lines, in the standard's order. Never empty. */
  readonly lines: readonly TechnicalLine[];
  /** Authored flavour, kept out of {@link lines} and never mixed into them. */
  readonly flavor: string | null;
}

/**
 * What the Resource pool is called in front of a player.
 *
 * One string, because it is the open question the document records first: the
 * pool has no in-world name and "Resource" is a category. When it gets one,
 * this is the line that changes.
 */
export const RESOURCE_NAME = 'Resource';

/**
 * What `poise` is called in front of a player.
 *
 * The internal name never appears: the pool is Guard, the damage to it is Guard
 * damage, and the skill that strips it is named for it.
 */
export const GUARD_NAME = 'Guard';

// --- number forms -------------------------------------------------------
//
// The standard's §2.3, in four functions, so a number cannot be formatted two
// ways in two places.

/**
 * A bare quantity: damage, healing, range, radius.
 *
 * Two decimals, trailing zeros trimmed, so an integer stays an integer and a
 * fractional one survives. Rounding to a whole number was fine while every
 * damage figure in the tables was one, and spec 190's afflictions are not:
 * Burn's pulse is 4.5 and calling it 5 overstates every tick of it. Two rather
 * than one because Bleed's exertion multiplier is 1.75, which one decimal calls
 * 1.8 -- the same accuracy-over-tidiness call the percentage rule already lost.
 */
function amount(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Ticks as seconds, to at most two decimals with trailing zeros trimmed.
 *
 * Two rather than the one the first draft of the standard asked for, because
 * one is not enough to be *accurate*: `seconds(0.35)` is 21 ticks and one
 * decimal reports it as 0.4s. Accuracy outranks brevity, and every authored
 * duration in the game lands exactly on two.
 */
export function formatSeconds(ticks: number): string {
  if (!Number.isFinite(ticks)) return '0s';
  const value = Math.round((ticks / SERVER_TICK_RATE) * 100) / 100;
  return `${String(value)}s`;
}

/** A fraction as an integer percentage. `0.4` -> `40%`. */
function percent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

/**
 * A cone's **full** opening angle in degrees, from the squared cosine of its
 * half-angle.
 *
 * The inverse of `arcCosSqOf`, and it answers in the full angle because that is
 * what the standard fixed and what a caller means by "a 90-degree cone".
 */
function coneDegrees(arcCosSq: number): string {
  const clamped = Math.max(0, Math.min(1, arcCosSq));
  const half = Math.acos(Math.sqrt(clamped));
  return `${String(Math.round(((half * 2) * 180) / Math.PI))}°`;
}

/** `['a', 'b', 'c']` -> `a, b and c`. Never an Oxford comma; never `&`. */
function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${String(parts[parts.length - 1])}`;
}

// --- abilities ----------------------------------------------------------

/**
 * The Technical Description for one ability.
 *
 * Every line is composed from the row. The only authored string that survives
 * is the flavour, and it is returned separately.
 */
export function describeAbility(ability: AbilityDefinition): TechnicalDescription {
  const lines: TechnicalLine[] = [];
  const push = (tone: Tone, text: string): void => {
    if (text.length > 0) lines.push({ tone, text });
  };

  push('target', targetLine(ability));
  // Travel before shape: a shot flies and *then* bursts, and the burst line
  // reading first put the impact before the flight that causes it.
  push('target', travelLine(ability));
  push('target', shapeLine(ability));

  for (const text of effectLines(ability)) push('effect', text);
  const scaling = scalingLine(ability);
  if (scaling) lines.push(scaling);
  push('cost', costLine(ability));
  for (const text of timingLines(ability)) push('timing', text);
  for (const text of noteLines(ability)) push('note', text);

  return {
    name: ability.name,
    lines,
    flavor: ability.description.length > 0 ? ability.description : null,
  };
}

/**
 * What this ability's offence scales with (specs 238, 242).
 *
 * **The weapon tooltip's notation, borrowed whole**: three positions, always
 * `Strength / Agility / Intelligence` in that fixed order, one character each,
 * `-` for `None`. Never reordered by strongest -- position *is* the attribute,
 * which is what lets the line be three characters instead of three labelled
 * rows, and what lets a player read a sigil and a sword with one habit instead
 * of two.
 *
 * It replaced a sentence (*"Scales with Strength A and Agility D."*), and the
 * sentence was the thing that made the two halves of the game's offence read as
 * two systems: a weapon said `A / D / -` and a skill that scales identically
 * said it in prose, so nothing about them looked comparable. `inventory-model.ts`
 * builds the weapon's; this builds the ability's; both go through
 * {@link letterOf} and {@link SCALING_ATTRIBUTES}, so neither can invent a
 * fourth position or a letter the ladder has not got.
 *
 * The weapon fraction is appended rather than given a position, because it is
 * not an attribute: `- / A / -  + weapon` is an ability whose damage is partly
 * the thing in your hand, and the letters it brings are the *weapon's* and are
 * on the weapon's own tooltip.
 *
 * Two deliberate departures from the weapon's version, both about which rows
 * have anything to say:
 *
 *  - **A basic attack draws nothing.** Its damage is the weapon's, whole, and
 *    the weapon's own tooltip already states these three grades. A second copy
 *    is the duplicate rule this file exists to prevent.
 *  - **An unscaled ability draws nothing**, where an unscaled *weapon* still
 *    draws `- / - / -`. Every weapon scales somehow, so a blank there reads as
 *    a tooltip that forgot; for an ability, scaling with nothing is a real and
 *    deliberate classification -- a flask, a Mend -- and `- / - / -` on a
 *    draught would be noise about a number that does not exist.
 */
function scalingLine(ability: AbilityDefinition): TechnicalLine | null {
  if (ability.basicAttack === true) return null;
  const profile = abilityProfileOf(ability.scaling);
  if (isUnscaled(ability.scaling)) return null;

  const spans: TechnicalSpan[] = [];
  SCALING_ATTRIBUTES.forEach((attribute, index) => {
    // The separator carries no attribute, so it takes the line's own tone and
    // only the three letters are hued -- the weapon line's rule, for its
    // reason: coloured punctuation reads as decoration rather than as three
    // marked positions.
    if (index > 0) spans.push({ text: SCALING_SEPARATOR });
    spans.push({ text: letterOf(profile.grades[attribute]), attribute });
  });
  if (profile.weapon > 0) {
    spans.push({
      text: profile.weapon >= 1 ? ' + weapon' : ` + ${percent(profile.weapon)} weapon`,
    });
  }
  return { text: spans.map((span) => span.text).join(''), tone: 'effect', spans };
}


/** Who or what the cast is aimed at, and how far away it may be. */
function targetLine(ability: AbilityDefinition): string {
  const parts: string[] = [];
  switch (ability.targeting) {
    case 'self':
      parts.push('Target: yourself.');
      break;
    case 'unit':
      parts.push('Target: one enemy.');
      break;
    case 'point':
      parts.push('Target: a point on the ground.');
      break;
    case 'direction':
      parts.push('Target: a direction.');
      break;
  }
  // Range zero is a self-cast and says nothing; the standard omits an absent
  // field rather than writing it as zero.
  if (ability.range > 0) parts.push(`Range ${amount(ability.range)}.`);
  return parts.join(' ');
}

/**
 * The shape the landing picks with, where there is one.
 *
 * `area` first, because `kind: 'area'` is the only kind that reads it; then the
 * cone a melee swing or a channel sweeps; then the burst a ground blast or an
 * exploding projectile leaves.
 */
function shapeLine(ability: AbilityDefinition): string {
  if (ability.area) return areaLine(ability.area);
  if (ability.arcCosSq !== undefined) {
    return `Hits enemies in a ${coneDegrees(ability.arcCosSq)} cone.`;
  }
  if (ability.kind === 'ground' && ability.radius !== undefined) {
    return `Hits enemies within ${amount(ability.radius)} of the point.`;
  }
  if (ability.projectile && ability.radius !== undefined) {
    return `Bursts on impact, hitting enemies within ${amount(ability.radius)}.`;
  }
  return '';
}

/**
 * One area shape as a sentence.
 *
 * `up to N` and never *the N nearest*: `sim/skill-area.ts` picks in candidate
 * order and says at length that sorting by distance "would be a better game and
 * a worse guarantee". Naming distance would be a claim the code does not make.
 */
function areaLine(area: SkillArea): string {
  const cap = area.maxTargets === undefined ? 'enemies' : `up to ${amount(area.maxTargets)} enemies`;
  switch (area.shape) {
    case 'circle':
      return area.origin === 'caster'
        ? `Hits ${cap} within ${amount(area.radius)} of you.`
        : `Hits ${cap} within ${amount(area.radius)} of the target point.`;
    case 'cone':
      return `Hits ${cap} in a ${amount(area.angleDeg)}° cone, up to ${amount(area.range)} away.`;
    case 'line':
      return `Hits ${cap} in a line ${amount(area.range)} long and ${amount(area.width)} wide.`;
  }
}

/**
 * What a shot does on the way, where the row has a projectile.
 *
 * **Derived from `targeting`, deliberately not from `arc`.** The first draft of
 * this function read the arc, on the strength of the comment in
 * `data/abilities.ts` that a lobbed shot "flies over whatever is between the
 * archer and the body it named" and the two flavour lines that say the same.
 * `sim/world.ts` says the opposite in as many words -- *"`arcHeight` is a
 * *look*: whether the shot rises on its way. It buys nothing mechanical, so an
 * arrow and a star reach the same body at the same tick"* -- and
 * `projectileHits` is a flat 2D overlap with no height term in it at all.
 *
 * What actually decides whether a bystander can take the shot is whether it
 * **named** a body: a shot with a target id resolves against that body and
 * ignores everything else, and a shot thrown at a point takes the first hostile
 * thing it overlaps. That is the fact worth telling a player, and it is the one
 * the row can honestly support.
 *
 * Flight speed is omitted: `ProjectileSpec.speed` is the value *before*
 * `PROJECTILE_SPEED_SCALE`, so the number in the row is not the speed the shot
 * travels at and printing it would be worse than saying nothing.
 */
function travelLine(ability: AbilityDefinition): string {
  if (!ability.projectile) return '';
  return ability.targeting === 'unit'
    ? 'The shot follows the enemy it was aimed at, and passes anything else.'
    : 'The shot hits the first enemy in its path.';
}

/**
 * What happens to whoever the landing picked, in the row's own order.
 *
 * The order is load-bearing: `sim/skill-effects.ts` runs the list in the order
 * it is written, so Guard Break strips guard *before* its guard damage is
 * measured against the pool. Reordering the row is a balance change and the
 * description follows it rather than tidying it.
 */
function effectLines(ability: AbilityDefinition): readonly string[] {
  // A channel's damage is a cadence rather than a blow, and the row carries
  // both halves of it. Said here rather than in the damage case below, because
  // "deals 7 damage" about a channel is true of one pulse and false of the
  // ability.
  if (ability.kind === 'channel') {
    const out: string[] = [];
    if (ability.damage > 0 && ability.pulseIntervalTicks && ability.channelTicks) {
      out.push(
        `Deals ${amount(ability.damage)} damage every ` +
          `${formatSeconds(ability.pulseIntervalTicks)} for ` +
          `${formatSeconds(ability.channelTicks)}.`,
      );
    }
    out.push('Withdraw at any point to stop early.');
    return out;
  }

  if (ability.effects && ability.effects.length > 0) {
    const out: string[] = [];
    for (const effect of ability.effects) out.push(...effectLine(effect, ability));
    return out;
  }

  // No effect list is "the damage, as before", which is what every row written
  // before spec 188 means.
  const out: string[] = [];
  // A basic attack's damage is the **weapon's**, since spec 217, so there is no
  // number on this row to state -- and stating the row's anyway is exactly the
  // second copy of a rule the vocabulary standard exists to forbid. What the
  // weapon rolls between is on the weapon's own tooltip, where the player is
  // choosing between weapons.
  if (ability.basicAttack === true) out.push('Deals your weapon damage.');
  else if (ability.damage > 0) out.push(`Deals ${amount(ability.damage)} damage.`);
  const healing = healLine(ability.healing ?? 0, ability.healingFraction ?? 0, true);
  if (healing) out.push(healing);
  return out;
}

/** One effect. Returns more than one line where the effect has a stacking rule. */
function effectLine(effect: SkillEffect, ability: AbilityDefinition): readonly string[] {
  const onCaster = subjectOf(effect) === 'caster';
  const who = onCaster ? 'you' : 'the target';

  switch (effect.kind) {
    case 'damage': {
      const base = effect.amount ?? ability.damage;
      const scaled = base * (effect.multiplier ?? 1);
      if (scaled <= 0) return [];
      return [`Deals ${amount(scaled)} damage.`];
    }

    case 'poiseDamage': {
      // Two forms since spec 271, and the line has to say which, because they
      // answer differently to everything the player has bought: an authored
      // `amount` is an absolute, and the scaled form is the caster's own
      // `staggerPower` -- Strength, Crushing Blows, all of it -- times what this
      // row weighs. Naming the multiplier rather than a number is the only
      // honest thing available here: the number depends on who is casting, and
      // this table describes a row rather than a character.
      if (effect.amount !== undefined) {
        const flat = effect.amount * (effect.multiplier ?? 1);
        return [`Deals ${amount(flat)} ${GUARD_NAME} damage.`];
      }
      const impact = (ability.guardImpact ?? 0) * (effect.multiplier ?? 1);
      if (impact <= 0) return [];
      return [`Deals ${amount(impact)}x your ${GUARD_NAME} damage.`];
    }

    case 'poise':
      // The pool written directly, which `sim/skill-effects.ts` is explicit
      // cannot break it -- so this is "removes" and never "breaks".
      return effect.amount < 0
        ? [`Removes ${amount(-effect.amount)} ${GUARD_NAME} from ${who}.`]
        : [`Restores ${amount(effect.amount)} ${GUARD_NAME} to ${who}.`];

    case 'stun':
      // Staggered, not stunned: one state, one word (the standard's §1.14).
      return [`Staggers ${who} for ${formatSeconds(effect.ticks)}.`];

    case 'applyStatus': {
      const visual = visualFor(effect.statusId);
      // A status with no row in `STATUS_VISUALS` is one the player is never
      // shown, so naming it in a description would name something they cannot
      // see. Omitted rather than printed as a raw id.
      if (!visual) return [];
      const out = [
        `Applies ${visual.name} to ${who} for ${formatSeconds(effect.durationTicks)}.`,
      ];
      const ceiling = effect.maxStacks ?? 1;
      if (ceiling > 1) out.push(`Stacks up to ${amount(ceiling)} times.`);
      return out;
    }

    case 'removeStatus': {
      const visual = visualFor(effect.statusId);
      if (!visual) return [];
      return [`Removes ${visual.name} from ${who}.`];
    }

    case 'applyDot': {
      // The row *is* the affliction, whole -- a skill names one and adds no
      // numbers of its own -- so the line names it and the reader gets the rate
      // and the cadence from the affliction's own tooltip. Restating them here
      // would be the skill claiming to own numbers it does not.
      const dot = dotById(effect.dotId);
      if (!dot) return [];
      return [`Applies ${dot.name} to ${who}.`];
    }

    case 'heal': {
      const line = healLine(effect.amount ?? 0, effect.fraction ?? 0, onCaster || ability.targeting === 'self');
      return line ? [line] : [];
    }

    case 'resource':
      return effect.amount >= 0
        ? [`Restores ${amount(effect.amount)} ${RESOURCE_NAME} to ${who}.`]
        : [`Drains ${amount(-effect.amount)} ${RESOURCE_NAME} from ${who}.`];
  }
}

/**
 * A heal, flat or proportional or both.
 *
 * The two add rather than replace -- `applyEffects` sums them -- so a row that
 * carries both says both in one sentence rather than in two that read as two
 * heals.
 */
function healLine(flat: number, fraction: number, self: boolean): string {
  const parts: string[] = [];
  if (flat > 0) parts.push(amount(flat));
  if (fraction > 0) parts.push(`${percent(fraction)} of maximum health`);
  if (parts.length === 0) return '';
  return self ? `Heals you for ${joinList(parts)}.` : `Heals the target for ${joinList(parts)}.`;
}

/**
 * Everything the cast is priced in, in one sentence.
 *
 * One line rather than one per currency, because a player deciding whether they
 * can afford something is asking one question. Every one of them is refunded in
 * full by a withdrawal, which the standard states once rather than on each row.
 */
function costLine(ability: AbilityDefinition): string {
  const parts: string[] = [];
  if (ability.cost > 0) parts.push(`${amount(ability.cost)} ${RESOURCE_NAME}`);
  const extra = ability.costs;
  if (extra?.health) parts.push(`${amount(extra.health)} health`);
  if (extra?.poise) parts.push(`${amount(extra.poise)} ${GUARD_NAME}`);
  if (ability.chargeCost) {
    parts.push(
      ability.chargeCost === 1 ? '1 flask charge' : `${amount(ability.chargeCost)} flask charges`,
    );
  }
  if (parts.length === 0) return '';
  return `Costs ${joinList(parts)}.`;
}

/**
 * The spans the cast occupies.
 *
 * A basic attack's `cooldownTicks` is deliberately **not** shown. Its cadence
 * comes from Base Attack Time (spec 144), so printing the row's cooldown beside
 * it would tell a player that attack speed shortens a skill's cooldown -- the
 * one thing the standard's §1.6 exists to keep apart. The note takes its place.
 */
function timingLines(ability: AbilityDefinition): readonly string[] {
  const out: string[] = [];
  if (ability.windupTicks > 0) out.push(`Wind-up ${formatSeconds(ability.windupTicks)}.`);
  if (ability.backswingTicks && ability.backswingTicks > 0) {
    out.push(`Backswing ${formatSeconds(ability.backswingTicks)}.`);
  }
  if (!ability.basicAttack && ability.cooldownTicks > 0) {
    out.push(`Cooldown ${formatSeconds(ability.cooldownTicks)}.`);
  }
  return out;
}

/** The few rules a row carries that are not a number, a cost or a span. */
function noteLines(ability: AbilityDefinition): readonly string[] {
  const out: string[] = [];
  if (ability.basicAttack) {
    out.push('Swing rate comes from your attack speed, not a cooldown.');
  }
  if (ability.skill) {
    out.push('Cast from an equipped skill slot.');
  }
  if (ability.castAngleDeg !== undefined) {
    out.push(`Facing tolerance ${amount(ability.castAngleDeg)}°.`);
  }
  if (ability.chargeCost) {
    // Where charges come back is a real rule and the only one here that is not
    // in the row: `advanceRest` returns one at a time while a player is out of
    // combat and resting. It used to live in the flavour line, which is exactly
    // the drift the standard forbids, so it is stated by the presence of a
    // charge cost instead.
    out.push('Flask charges return one at a time while resting out of combat.');
  }
  return out;
}

// --- what a modifier grants ---------------------------------------------

/**
 * How one field of a {@link StatModifier} is written out (spec 191).
 *
 * The naming table for the *other* half of the content: `describeAbility` reads
 * an ability's own columns, and this reads the generic bag of numbers that
 * items, milestones, synergies and the passive skill tree all grant through.
 *
 * It lives here rather than in `render/iso3d/world/inventory-model.ts`, where the
 * item half of it has lived since spec 185, for the reason the whole standard
 * exists: an item saying `+15% Attack Speed` and a skill saying something else
 * about the same field would be two answers to one question. One table, two
 * presentations -- the bag colours its lines by good and bad, the sheet does
 * not, and neither decides what the field is *called*.
 *
 * **A field with no row here draws no line at all.** That is the same rule the
 * item table has always had, and here it is load-bearing rather than defensive:
 * the trait layer is not uniform the way `modifiers` is. Some of its fields are
 * magnitudes, some are unlock flags, some are thresholds, and three of them
 * (`juggernautBelow`, `masteryRelief`, `overflowHealthPerResource`) cannot be
 * turned into a signed quantity that reads correctly in English. A missing line
 * leaves the authored sentence to carry the skill; an invented one is a lie
 * about a number, which is what this document was written to stop.
 * `description.test.ts` reports which keys are uncovered, so the gap is
 * measurable rather than silent.
 */
export interface GrantLabel {
  /** A `StatModifier` field, or a `TraitModifier` one under `traits`. */
  readonly key: string;
  /** Where it is read from. */
  readonly where: 'stat' | 'trait';
  readonly name: string;
  /**
   * `flat` -- a bare number. `percent` -- a fraction as a percentage.
   * `seconds` -- ticks. `flag` -- {@link name} is the whole sentence and the
   * value is never shown.
   */
  readonly form: 'flat' | 'percent' | 'seconds' | 'flag';
  /**
   * Whether a bigger number is better for the player. Default true.
   *
   * Not decoration: `shapingCostPct` is a *premium* a skill charges you and
   * `prepareTicks` is a delay it removes, so the sign alone cannot say which way
   * a grant cuts.
   */
  readonly higherIsBetter?: boolean;
  /**
   * A rule about the mechanic this grant brings, as a whole sentence.
   *
   * For the part of a mechanic that **is not a quantity** -- when it re-arms,
   * what ends it, what it will not stack with. A number's own line cannot say
   * any of that, and the only other place to put it is the row's authored
   * `description` -- which is flavour, and which is where this standard's own
   * first rule says a mechanical claim must never live, because nothing keeps
   * one true there.
   *
   * Second Wind is the case that proved it. Its flavour said it would not fire
   * again *"until you have climbed back out"*, which was the behaviour until
   * spec 239 replaced it -- and the sentence stayed, describing a rule the sim
   * had stopped having. Emitted from the label rather than the row, it appears
   * exactly when the grant that carries the mechanic does.
   */
  readonly note?: string;
}

/**
 * Every field either half of a modifier can grant, and what it is called.
 *
 * Ordered, and read in order, so two things granting the same fields list them
 * the same way rather than in whatever order somebody authored the object in.
 */
export const GRANT_LABELS: readonly GrantLabel[] = [
  // --- attributes: the biggest thing a grant can say -----------------------
  { key: 'strength', where: 'stat', name: 'Strength', form: 'flat' },
  { key: 'agility', where: 'stat', name: 'Agility', form: 'flat' },
  { key: 'intelligence', where: 'stat', name: 'Intelligence', form: 'flat' },
  { key: 'constitution', where: 'stat', name: 'Constitution', form: 'flat' },
  { key: 'perception', where: 'stat', name: 'Perception', form: 'flat' },
  { key: 'wisdom', where: 'stat', name: 'Wisdom', form: 'flat' },

  // --- offence, defence, movement -----------------------------------------
  { key: 'attackDamage', where: 'stat', name: 'Damage', form: 'flat' },
  { key: 'attackDamagePct', where: 'stat', name: 'Damage', form: 'percent' },
  { key: 'attackRange', where: 'stat', name: 'Range', form: 'flat' },
  { key: 'attackSpeed', where: 'stat', name: 'Attack Speed', form: 'percent' },
  { key: 'attackSpeedPct', where: 'stat', name: 'Attack Speed', form: 'percent' },
  { key: 'attackCooldownTicks', where: 'stat', name: 'Attack Delay', form: 'flat', higherIsBetter: false },
  { key: 'critChance', where: 'stat', name: 'Crit Chance', form: 'percent' },
  { key: 'spellPower', where: 'stat', name: 'Spell Power', form: 'percent' },
  { key: 'maxHealth', where: 'stat', name: 'Health', form: 'flat' },
  { key: 'maxHealthPct', where: 'stat', name: 'Health', form: 'percent' },
  { key: 'armor', where: 'stat', name: 'Armour', form: 'percent' },
  { key: 'maxResource', where: 'stat', name: `Maximum ${RESOURCE_NAME}`, form: 'flat' },
  { key: 'resourceRegen', where: 'stat', name: `${RESOURCE_NAME} regeneration`, form: 'flat' },
  { key: 'moveSpeed', where: 'stat', name: 'Move Speed', form: 'flat' },
  { key: 'moveSpeedPct', where: 'stat', name: 'Move Speed', form: 'percent' },
  { key: 'turnRate', where: 'stat', name: 'Turn Rate', form: 'flat' },

  // --- weapon scaling grades (spec 216) ------------------------------------
  //
  // Named here as well as in `inventory-model.ts` for the reason this table
  // exists: an item and a passive skill granting the same field must call it the
  // same thing. `flat`, because a step is a whole signed count and not a
  // percentage of anything -- `+1 Agility Scaling` says exactly what it does.
  { key: 'strengthScalingGrade', where: 'stat', name: 'Strength Scaling', form: 'flat' },
  { key: 'agilityScalingGrade', where: 'stat', name: 'Agility Scaling', form: 'flat' },
  { key: 'intelligenceScalingGrade', where: 'stat', name: 'Intelligence Scaling', form: 'flat' },

  // --- the trait half ------------------------------------------------------
  //
  // Guard, never poise: the pool has one player-facing name and the internal
  // one does not appear (the standard's §1.7).
  { key: 'maxPoise', where: 'trait', name: 'Maximum Guard', form: 'flat' },
  { key: 'poiseDamagePct', where: 'trait', name: 'Guard damage', form: 'percent' },
  { key: 'poiseRegenPct', where: 'trait', name: 'Guard regeneration', form: 'percent' },
  { key: 'poiseRegenStaggered', where: 'trait', name: 'Guard regeneration while Staggered', form: 'percent' },
  { key: 'windupPoiseArmor', where: 'trait', name: 'Guard protection while winding up', form: 'percent' },
  { key: 'poiseArmorAllCasts', where: 'trait', form: 'flag', name: 'Guard protection covers every cast, not only attacks.' },

  // Both of these move a **threshold**, so the quantity is "how much of the
  // Backswing you may break off", not "how much shorter the Backswing is"
  // (spec 258). Named for what moves rather than for the number, because a
  // player reading "-5% Backswing" would reasonably expect to be attacking more
  // often, and they are not. `Backswing` and `break off` are the controlled
  // terms (`docs/mechanics-vocabulary.md` §1), which is also why neither line
  // says *recovery*.
  { key: 'backswingCancelReduction', where: 'trait', name: 'Backswing you may break off', form: 'percent' },
  { key: 'handlingReduction', where: 'trait', name: 'Wind-up reduction for abilities that launch something', form: 'percent' },
  { key: 'heavyWindupReduction', where: 'trait', name: 'Wind-up reduction for heavy abilities', form: 'percent' },

  { key: 'flowTicks', where: 'trait', name: 'Flow duration', form: 'seconds' },
  { key: 'flowDurationPct', where: 'trait', name: 'Flow duration', form: 'percent' },
  { key: 'flowBackswingCancelPct', where: 'trait', name: 'Backswing you may break off per Flow stack', form: 'percent' },
  // Seconds rather than ticks, like every other span a player is shown: the
  // sim counts in ticks and nothing outside it should have to (spec 191).
  {
    key: 'mobileOffenseCooldownTicks',
    where: 'trait',
    name: 'Active ability cooldown removed',
    form: 'seconds',
  },
  { key: 'momentumTicks', where: 'trait', name: 'Momentum duration', form: 'seconds' },
  { key: 'momentumWindupScale', where: 'trait', name: 'Wind-up reduction while Momentum is held', form: 'percent' },
  { key: 'perfectExitResource', where: 'trait', name: `${RESOURCE_NAME} on a perfect exit`, form: 'flat' },
  { key: 'perfectExitWindowTicks', where: 'trait', name: 'Perfect exit window', form: 'seconds' },
  { key: 'overkillResource', where: 'trait', name: `${RESOURCE_NAME} on an overkill`, form: 'flat' },

  // The two below are **not** reductions and their names must not become one.
  // `prepareTicks` is authored negative -- the skill takes stillness *away* --
  // and `preparedWindupScale` is a negative delta on a multiplier whose base is
  // 1. Both read correctly as a signed quantity that is better when lower.
  { key: 'prepareTicks', where: 'trait', name: 'Stillness needed to become Prepared', form: 'seconds', higherIsBetter: false },
  { key: 'preparedWindupScale', where: 'trait', name: 'Wind-up while Prepared', form: 'percent', higherIsBetter: false },
  { key: 'spellRadiusPct', where: 'trait', name: 'Ability radius', form: 'percent' },
  { key: 'spellRangePct', where: 'trait', name: 'Ability range', form: 'percent' },
  { key: 'shapingCostPct', where: 'trait', name: 'Cost of shaped abilities', form: 'percent', higherIsBetter: false },
  { key: 'shapingCostRelief', where: 'trait', name: 'Relief on the shaping premium', form: 'percent' },
  { key: 'vsAfflictedPct', where: 'trait', name: 'Damage against a target carrying an affliction', form: 'percent' },
  // The three capability flags (spec 239). Each is a *rule about what you can
  // do* rather than a quantity, which is exactly what `form: 'flag'` is for --
  // and each is worth a line, because before that spec a player could buy the
  // skill granting it and get nothing at all.
  { key: 'grantsPrepared', where: 'trait', form: 'flag', name: 'Standing still primes your next ability.' },
  { key: 'overflowCostReduction', where: 'trait', name: 'Relief on Arcane Overflow’s health cost', form: 'percent' },

  {
    key: 'secondWindHeal',
    where: 'trait',
    name: 'Second Wind heal, of maximum health',
    form: 'percent',
    // The lifecycle, which is the half of this mechanic that is not a number
    // and the half a player has to plan around. `advanceRest` and `respawn` are
    // the only two callers of `clearStatus(SecondWindSpent)` in the tree, and
    // the last sentence is here because the rule it denies is the one the game
    // used to have -- somebody who played before spec 239 has to be told the
    // comeback no longer re-arms itself.
    note: 'Resting in a safe zone re-arms it, and so does dying. Recovering health does not.',
  },
  { key: 'resoluteReduction', where: 'trait', name: 'Damage reduction while badly hurt', form: 'percent' },
  {
    key: 'staggerImmuneBelow',
    where: 'trait',
    form: 'flag',
    name: 'Your guard cannot be broken while badly hurt.',
  },
  { key: 'overhealShieldTicks', where: 'trait', name: 'Shield duration', form: 'seconds' },

  { key: 'weakPointChance', where: 'trait', name: 'Weak-point chance', form: 'percent' },
  { key: 'weakPointResource', where: 'trait', name: `${RESOURCE_NAME} on a weak point`, form: 'flat' },
  { key: 'weakPointKillHeal', where: 'trait', name: 'Health on a weak-point kill, of maximum health', form: 'percent' },
  { key: 'exposeTicks', where: 'trait', name: 'Exposed duration', form: 'seconds' },
  { key: 'exploitDamagePct', where: 'trait', name: 'Damage on a weak point against an Exposed target', form: 'percent' },
  { key: 'grantsOpeningRead', where: 'trait', form: 'flag', name: 'An enemy that commits an attack becomes Vulnerable.' },
  { key: 'openingReadTicks', where: 'trait', name: 'Vulnerable duration', form: 'seconds' },
  {
    key: 'vulnerableWeakPointFactor',
    where: 'trait',
    name: 'Weak-point chance against a Vulnerable target',
    form: 'percent',
  },
  { key: 'steadyAimPct', where: 'trait', name: 'Damage after standing still', form: 'percent' },

  { key: 'costReduction', where: 'trait', name: 'Ability cost reduction', form: 'percent' },
  { key: 'healingPct', where: 'trait', name: 'Healing received', form: 'percent' },
  { key: 'attunedCostPct', where: 'trait', name: 'Ability cost reduction per Attuned stack', form: 'percent' },
  { key: 'attunedTicks', where: 'trait', name: 'Attuned duration', form: 'seconds' },
  { key: 'grantsAdaptation', where: 'trait', form: 'flag', name: 'Being hit by the same ability builds resistance to it.' },
  { key: 'adaptationPerStack', where: 'trait', name: 'Adaptation per stack', form: 'percent' },
  { key: 'adaptationTicks', where: 'trait', name: 'Adaptation duration', form: 'seconds' },
  { key: 'conversionCap', where: 'trait', name: 'Overflow conversion cap', form: 'flat' },
];

/** A trailing full stop removed, so a line can be extended before it is closed. */
function trimStop(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

/** Just the signed quantity out of a grant line: `+18% Guard damage.` -> `+18%`. */
function rateOf(text: string): string {
  return /^[+-][\d.]+%?s?/.exec(text)?.[0] ?? trimStop(text);
}

/** One thing a modifier grants, written out. */
export interface Grant {
  readonly text: string;
  /** Which way it cuts for the player, so a surface can colour it. */
  readonly good: boolean;
  /**
   * A whole sentence already, carrying no number.
   *
   * A caller must not scale it, total it or append "per tier" to it -- a flag
   * is on or off, and "Guard protection covers every cast per tier" is what
   * happens when that is forgotten.
   */
  readonly whole?: boolean;
}

/** `8` -> `+8`; `-0.2` at percent -> `-20%`. Signed always: the `+` is the point. */
function signed(value: number, form: GrantLabel['form']): string {
  const scaled = form === 'percent' ? value * 100 : value;
  const rounded =
    form === 'seconds'
      ? Math.round((value / SERVER_TICK_RATE) * 100) / 100
      : Math.round(scaled * 10) / 10;
  const sign = rounded >= 0 ? '+' : '-';
  const unit = form === 'percent' ? '%' : form === 'seconds' ? 's' : '';
  return `${sign}${String(Math.abs(rounded))}${unit}`;
}

/**
 * What a `StatModifier` grants, one line per field it carries.
 *
 * Zero is skipped rather than written as `+0`. That is the item table's rule and
 * it matters more here: the passive tree authors a zero as a *socket* -- a
 * documented "this row is about that trait" whose magnitude comes from a
 * milestone or a synergy -- so `appliesSundered: 0` and
 * `vulnerableWeakPointFactor: 0` are inert and a line about either would claim
 * an effect the row does not have.
 *
 * `times` multiplies every value, which is how a specialization at tier 2 states its
 * total rather than its per-level rate.
 */
export function grantsOf(modifier: StatModifier, times = 1): readonly Grant[] {
  const traits = (modifier.traits ?? {}) as Readonly<Record<string, number | undefined>>;
  const stats = modifier as unknown as Readonly<Record<string, number | undefined>>;
  const out: Grant[] = [];
  for (const label of GRANT_LABELS) {
    const raw = label.where === 'trait' ? traits[label.key] : stats[label.key];
    if (typeof raw !== 'number' || raw === 0) continue;
    if (label.form === 'flag') {
      out.push({ text: label.name, good: true, whole: true });
      continue;
    }
    const value = raw * times;
    out.push({
      text: `${signed(value, label.form)} ${label.name}.`,
      good: value > 0 === (label.higherIsBetter ?? true),
    });
    // After the quantity, because the number is what the row grants and this is
    // a rule about what the number brings with it. `times` does not reach it:
    // a rule is the same rule at tier 1 and at tier 3.
    if (label.note !== undefined) out.push({ text: label.note, good: true, whole: true });
  }
  return out;
}

// --- the passive skill tree ---------------------------------------------

/**
 * The Technical Description for one row of the attuned tree (spec 191).
 *
 * The tree was the one thing the standard's first pass left out, and it is the
 * largest body of unexplained mechanics in the game: thirty-six rows granting
 * fifty-odd trait fields, of which a player could read only an authored sentence
 * and a trigger. "Your blows carry more weight against an enemy's guard" is a
 * true thing to say about +18% Guard damage per tier and it is not the same
 * thing, and nothing on the sheet was the number.
 *
 * `level` is what the character actually holds. At zero the lines are the row's
 * *rate* -- what a point buys -- because that is the question somebody looking
 * at an unspent skill has. Above zero they are the total, with the rate beside
 * it, because that is the question somebody looking at their own build has.
 */
export function describeSpecialization(skill: SpecializationDefinition, level = 0): TechnicalDescription {
  const lines: TechnicalLine[] = [];
  const attribute = ATTRIBUTES.find((entry) => entry.key === skill.attribute);

  lines.push({
    tone: 'target',
    text: `Requires ${attribute?.name ?? skill.attribute} ${amount(skill.requires)}.`,
  });

  // The trigger is authored, and it is the one part of a stat skill that could
  // not be derived from anything: `perTier` says what the row grants and
  // nothing in it says when. Labelled rather than run into the sentence, the
  // same way `Target:` labels an ability's.
  lines.push({
    tone: 'note',
    text: skill.trigger === 'passive' ? 'Always active.' : `Trigger: ${skill.trigger}.`,
  });

  const held = Math.max(0, Math.min(skill.maxTier, Math.floor(level)));
  const perTier = grantsOf(skill.perTier);
  const total = held > 0 ? grantsOf(skill.perTier, held) : perTier;

  for (const [index, grant] of total.entries()) {
    if (grant.whole === true) {
      lines.push({ tone: 'effect', text: grant.text });
      continue;
    }
    if (held === 0) {
      // A comma where the name already contains a "per", or a trait scoped to
      // something else reads as two rates run together: "+1% Backswing
      // reduction per Flow stack per tier".
      const joiner = grant.text.includes(' per ') ? ', per tier.' : ' per tier.';
      lines.push({ tone: 'effect', text: `${trimStop(grant.text)}${joiner}` });
      continue;
    }
    // The total first, because that is what is true of this character right
    // now; the rate after it, because that is what one more point buys. The
    // rate is the *value* alone -- repeating the name inside its own
    // parenthesis is how the first cut read, and it doubled every line.
    const rate = perTier[index];
    const suffix = rate === undefined || held === 1 ? '' : ` (${rateOf(rate.text)} per tier)`;
    lines.push({ tone: 'effect', text: `${trimStop(grant.text)}${suffix}.` });
  }

  return {
    name: skill.name,
    lines,
    flavor: skill.description.length > 0 ? skill.description : null,
  };
}

// --- statuses -----------------------------------------------------------

/**
 * What an affliction does, off its own row (spec 190).
 *
 * Every line here is arithmetic the table already exports: `dotPulseDamage`,
 * `dotDurationTicks` and `dotTotalDamage` are the sim's own, so a description
 * cannot come to a different answer than the pulse pass does. The total is
 * `dotTotalDamage` rather than `pulse * pulses` because Frostbite escalates and
 * the naive product is wrong for it by a factor of two and a bit -- the same
 * trap `scripts/preview-afflictions.ts` was written to catch.
 *
 * The riders each name the system they reach into and none of them restates its
 * arithmetic, which is the rule the whole resolver is built on.
 */
function afflictionLines(dot: DotDefinition): readonly TechnicalLine[] {
  const out: TechnicalLine[] = [];
  const per = dot.maxStacks > 1 ? ' per stack' : '';
  out.push({
    tone: 'effect',
    text:
      `Deals ${amount(dotPulseDamage(dot))} damage every ` +
      `${formatSeconds(dot.intervalTicks)}, ${amount(dot.pulses)} times` +
      `${per}.`,
  });
  out.push({
    tone: 'effect',
    // `pulses * interval`, **not** `dotDurationTicks`. That helper adds one tick
    // of slack so the last pulse lands inside `statusOf`'s expiry comparison,
    // and reporting it says "over 4.02s" -- an implementation guard read out to
    // a player as though it were a designed number. The authored length is the
    // one a player experiences, and the difference is a sixtieth of a second.
    text: `${amount(dotTotalDamage(dot))} damage in total over ${formatSeconds(dot.pulses * dot.intervalTicks)}${per}.`,
  });

  if (dot.rampPerSecond !== undefined) {
    const cap = dot.rampCap === undefined ? '' : `, up to ${amount(dot.rampCap)}x`;
    // Measured from when it was first applied and a refresh does not move that,
    // which is the whole of "dangerous if exposure continues" -- and the one
    // part of this a player would otherwise have to infer from a health bar.
    out.push({
      tone: 'effect',
      text: `The rate grows by ${percent(dot.rampPerSecond)} of itself each second it is held${cap}. Refreshing it does not restart the growth.`,
    });
  }
  if (dot.exertionScale !== undefined) {
    out.push({
      tone: 'effect',
      text: `Pulses are worth ${amount(dot.exertionScale)}x while the target is moving or casting.`,
    });
  }
  if (dot.spreadRadius !== undefined) {
    out.push({
      tone: 'effect',
      text: `Spreads to another enemy within ${amount(dot.spreadRadius)}.`,
    });
  }
  if (dot.guardPerSecond !== undefined) {
    out.push({
      tone: 'effect',
      text: `Removes ${amount(dot.guardPerSecond)} ${GUARD_NAME} a second. It cannot break it.`,
    });
  }
  if (dot.sunderMagnitude !== undefined) {
    // It applies the existing status rather than reducing armour its own way,
    // so the description names the status a player can already see.
    out.push({ tone: 'effect', text: 'Applies Sundered while it lasts.' });
  }
  if (dot.healingScale !== undefined) {
    out.push({
      tone: 'effect',
      text: `Healing the target receives is multiplied by ${amount(dot.healingScale)}.`,
    });
  }
  return out;
}

/**
 * The mechanical lines for a status that is an aura field (spec 223).
 *
 * Derived for the same reason {@link afflictionLines} is: a field *is* a reach,
 * an affliction and a linger in `data/aura-fields.ts`, so a sentence authored
 * beside it in `STATUS_VISUALS` would be a second copy of `radius` with nothing
 * keeping it true.
 *
 * The affliction is **named, not restated**. Spec 190's rule is that the row is
 * the affliction whole, so a reader gets the rate and the cadence from that
 * condition's own tooltip -- exactly as an `applyDot` effect's line does -- and
 * the field claims only the three numbers it owns.
 */
function auraFieldLines(field: AuraFieldDefinition): TechnicalLine[] {
  const dot = dotById(field.dotId);
  const out: TechnicalLine[] = [
    {
      tone: 'effect',
      text: `Applies ${dot?.name ?? field.name} to enemies within ${amount(field.radius)} of you.`,
    },
  ];
  // The linger is the mechanic, so it is stated as the thing a player acts on:
  // not "it is reapplied every tick" -- which is how it is built -- but "it
  // runs out this long after they get out", which is what they decide against.
  out.push({
    tone: 'effect',
    text: `It is renewed while they stay inside, and runs out ${formatSeconds(field.lingerTicks)} after they leave.`,
  });
  out.push({
    tone: 'note',
    text: `Reaches at most ${amount(field.maxTargets)} enemies at once.`,
  });
  return out;
}

/**
 * The Technical Description for one status.
 *
 * The one place the writer reads an authored string as a *mechanical* line, and
 * the reason is stated in the header: a `StatusVisual` genuinely does not know
 * what its condition does. Everything around it -- the stacking rule, the
 * refresh rule, whether a count is shown -- is derived from the row.
 */
export function describeStatus(visual: StatusVisual): TechnicalDescription {
  // An affliction is a rate, a cadence and a length, all of them in
  // `data/damage-over-time.ts`; a field is a reach, an affliction and a linger,
  // all of them in `data/aura-fields.ts`. Both are derived rather than authored,
  // and `StatusVisual.effect` is absent on exactly those rows.
  const dot = dotById(visual.id);
  const field = auraFieldById(visual.id);
  const derived = dot ? afflictionLines(dot) : field ? auraFieldLines(field) : null;
  const lines: TechnicalLine[] = [
    ...(derived ?? [{ tone: 'effect' as const, text: visual.effect ?? '' }]),
    {
      tone: 'note',
      text: visual.kind === 'boon' ? 'Beneficial.' : 'Harmful.',
    },
  ];

  // Every status in this game refreshes its duration when re-applied, and takes
  // the larger of the two magnitudes. Stated on the ones where a reader could
  // expect otherwise, which is all of them: a stacking status because the
  // ceiling matters, and a non-stacking one because "does not stack" without
  // "refreshes" reads as "a second application does nothing".
  //
  // An indefinite status has no duration to refresh, so it says so instead.
  // Saying "refreshes the duration" about Prepared -- which is applied with an
  // effectively infinite window and ends by being *spent* -- would describe a
  // clock that does not exist.
  const stacking = visual.maxStacks > 1 ? `Stacks up to ${amount(visual.maxStacks)} times.` : 'Does not stack.';
  const clock = visual.indefinite ? 'Lasts until it is spent.' : 'Refreshes the duration.';
  lines.push({ tone: 'note', text: `${stacking} ${clock}` });

  return { name: visual.name, lines, flavor: null };
}

/**
 * The mechanical block as plain text, one line each.
 *
 * The flavour is **not** included, which is the point of it being a separate
 * field: a caller that wants both puts them in two places with two styles, and
 * a caller that wants the rules gets only the rules.
 */
export function technicalText(described: TechnicalDescription): string {
  return described.lines.map((line) => line.text).join('\n');
}
