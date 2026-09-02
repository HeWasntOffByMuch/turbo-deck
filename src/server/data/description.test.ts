/**
 * The Technical Description standard, as assertions (spec 191).
 *
 * These are the invariants `docs/mechanics-vocabulary.md` states in prose. The
 * point of having them here is that a standard nothing checks is a style guide,
 * and a style guide is what the ability table already had: eleven `description`
 * strings in three different registers, two of which were factually wrong.
 */

import { describe, expect, it } from 'vitest';
import { ALL_ABILITIES, abilityById } from './abilities.js';
import { isUnscaled } from './ability-scaling.js';
import { SERVER_TICK_RATE } from '../config.js';
import { ALL_ITEMS } from './items.js';
import { STATUS_VISUALS } from './status-visuals.js';
import { ALL_DOTS, dotById, dotPulseDamage } from './damage-over-time.js';
import { ALL_AURA_FIELDS, auraFieldById } from './aura-fields.js';
import { ALL_SPECIALIZATIONS } from './specializations.js';
import {
  GRANT_LABELS,
  describeAbility,
  describeSpecialization,
  describeStatus,
  formatSeconds,
  grantsOf,
  technicalText,
} from './description.js';

const SECONDS = 60;

/** Every description the game can produce, so a rule can be asserted over all of them. */
function everyDescription(): readonly { readonly what: string; readonly text: string }[] {
  return [
    ...ALL_ABILITIES.map((ability) => ({
      what: ability.id,
      text: technicalText(describeAbility(ability)),
    })),
    ...STATUS_VISUALS.map((visual) => ({
      what: visual.id,
      text: technicalText(describeStatus(visual)),
    })),
    // Both readings of every stat skill: the rate a fresh row states, and the
    // total a held one does. They are different strings and both are shown.
    ...ALL_SPECIALIZATIONS.map((skill) => ({
      what: `${skill.id}@0`,
      text: technicalText(describeSpecialization(skill, 0)),
    })),
    ...ALL_SPECIALIZATIONS.map((skill) => ({
      what: `${skill.id}@max`,
      text: technicalText(describeSpecialization(skill, skill.maxTier)),
    })),
  ];
}

describe('the writer is total', () => {
  it('produces at least one line for every ability and every status', () => {
    for (const ability of ALL_ABILITIES) {
      expect(describeAbility(ability).lines.length, ability.id).toBeGreaterThan(0);
    }
    for (const visual of STATUS_VISUALS) {
      expect(describeStatus(visual).lines.length, visual.id).toBeGreaterThan(0);
    }
  });

  it('never emits an empty line', () => {
    for (const ability of ALL_ABILITIES) {
      for (const line of describeAbility(ability).lines) {
        expect(line.text.trim(), ability.id).not.toBe('');
      }
    }
  });

  it('never leaks a raw id, a tick count or an undefined', () => {
    for (const { what, text } of everyDescription()) {
      expect(text, what).not.toMatch(/undefined|NaN|\[object/);
      expect(text, what).not.toMatch(/\bticks?\b/i);
      // An internal id has a dot in it and no space around it: `melee.slash`.
      expect(text, what).not.toMatch(/\b[a-z]+\.[a-zA-Z]+\b/);
      // The internal name for the Guard pool must never reach a player.
      expect(text, what).not.toMatch(/\bpoise\b/i);
    }
  });
});

/** The scaling notation's whole grammar: three graded positions, and a weapon. */
const NOTATION = /^[SABCDE-] \/ [SABCDE-] \/ [SABCDE-](?: \+ (?:\d+% )?weapon)?$/;

describe('grammar conformance', () => {
  it('ends every line in a full stop, unless it is notation', () => {
    // The exception is exactly one line and it is **structural**: a line with
    // `spans` is notation rather than prose (spec 242), and `A / - / -` is no
    // more a sentence than a chord symbol is. §2.2's rule governs sentences and
    // fragments, and the standard says so since this landed.
    //
    // It is not a loophole, because the exempt line is held to its *own*
    // grammar below rather than to nothing -- a prose line that acquired spans
    // to dodge the full stop would fail that instead.
    for (const ability of ALL_ABILITIES) {
      for (const line of describeAbility(ability).lines) {
        if (line.spans !== undefined) continue;
        expect(line.text.endsWith('.'), `${ability.id}: ${line.text}`).toBe(true);
      }
    }
  });

  it('holds the notation line to the notation’s own grammar', () => {
    let seen = 0;
    for (const ability of ALL_ABILITIES) {
      for (const line of describeAbility(ability).lines) {
        if (line.spans === undefined) continue;
        seen++;
        expect(line.text, `${ability.id}: ${line.text}`).toMatch(NOTATION);
        // The runs and the whole line are the same string, or the tooltip's
        // wrap and its repeat-hover key describe something nobody is shown.
        expect(line.spans.map((span) => span.text).join('')).toBe(line.text);
      }
    }
    // A control: an exemption that applied to nothing would pass both of these.
    expect(seen).toBeGreaterThan(10);
  });

  it('writes every duration as seconds with at most two decimals', () => {
    for (const { what, text } of everyDescription()) {
      for (const match of text.matchAll(/(\d+(?:\.\d+)?)s\b/g)) {
        const decimals = (match[1] ?? '').split('.')[1] ?? '';
        expect(decimals.length, `${what}: ${match[0]}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('writes every percentage to at most one decimal, trimmed', () => {
    // The standard said *integer* until the skill tree was run through it, and
    // Lightfoot's `armor: 0.008` broke it honestly: 0.8% rounded to an integer
    // is 1%, which overstates it by a quarter. Accuracy outranks consistency in
    // this document's own priority order, so the rule moved rather than the
    // number -- and it moved to what the item tooltip has always done.
    for (const { what, text } of everyDescription()) {
      for (const match of text.matchAll(/(\d+(?:\.\d+)?)%/g)) {
        const decimals = (match[1] ?? '').split('.')[1] ?? '';
        expect(decimals.length, `${what}: ${match[0]}`).toBeLessThanOrEqual(1);
        expect(decimals, `${what}: ${match[0]} has a trailing zero`).not.toBe('0');
      }
    }
  });

  it('uses none of the banned synonyms', () => {
    // The document's §1 "do not use" lists, as one regex. Each of these is a
    // word some other game uses for a thing this game already has a word for.
    const banned =
      /\b(buff|debuff|DoT|HoT|proc|procs|CC|crowd control|mana|energy|stamina|hitpoints?|HP|DPS|AoE|cleanse|dispel|purge|stun(?:s|ned|ning)?|knockdown|daze)\b/i;
    for (const { what, text } of everyDescription()) {
      const hit = banned.exec(text);
      expect(hit?.[0] ?? null, `${what}: ${text}`).toBeNull();
    }
  });

  it('never describes a target cap as the nearest', () => {
    // `sim/skill-area.ts` picks in candidate order, not by distance.
    for (const { what, text } of everyDescription()) {
      expect(text, what).not.toMatch(/nearest|closest/i);
    }
  });
});

describe('derived numbers match the row they came from', () => {
  it('states the damage, range, cost and cooldown each row carries', () => {
    for (const ability of ALL_ABILITIES) {
      const text = technicalText(describeAbility(ability));

      if (ability.range > 0) expect(text, ability.id).toContain(`Range ${String(ability.range)}.`);
      if (ability.cost > 0) {
        expect(text, ability.id).toContain(`${String(ability.cost)} Resource`);
      }
      // A basic attack's cadence is Base Attack Time, so its row cooldown is
      // deliberately not shown -- see the standard's §1.6.
      if (!ability.basicAttack && ability.cooldownTicks > 0) {
        expect(text, ability.id).toContain(`Cooldown ${formatSeconds(ability.cooldownTicks)}.`);
      }
      if (ability.windupTicks > 0) {
        expect(text, ability.id).toContain(`Wind-up ${formatSeconds(ability.windupTicks)}.`);
      }
    }
  });

  it('never shows a cooldown for a basic attack', () => {
    for (const ability of ALL_ABILITIES) {
      if (!ability.basicAttack) continue;
      expect(technicalText(describeAbility(ability)), ability.id).not.toContain('Cooldown');
    }
  });

  it('follows a retune without being edited', () => {
    // An *ability*, because since spec 217 a basic attack has no damage number
    // of its own to follow -- see the test below.
    const dart = abilityById('skill.poisonDart');
    expect(dart).not.toBeNull();
    if (!dart) return;
    const louder = { ...dart, damage: 99, range: 123 };
    const text = technicalText(describeAbility(louder));
    expect(text).toContain('Deals 99 damage.');
    expect(text).toContain('Range 123.');
  });

  it('sends a basic attack to the weapon rather than naming a number', () => {
    // The vocabulary standard's rule (docs/mechanics-vocabulary.md): a
    // description is derived from the row the sim reads, and since spec 217 the
    // row the sim reads for a swing is the *weapon's*. Stating this ability's
    // own `damage` would be a second copy of a rule, and a false one.
    for (const ability of ALL_ABILITIES) {
      if (!ability.basicAttack) continue;
      const text = technicalText(describeAbility(ability));
      expect(text, ability.id).toContain('Deals your weapon damage.');
      expect(text, ability.id).not.toMatch(/Deals \d+ damage\./);
    }
    // And it holds even for a row that still carries a number.
    const slash = abilityById('melee.slash');
    if (slash) {
      expect(technicalText(describeAbility({ ...slash, damage: 99 }))).not.toContain('99 damage');
    }
  });

  it('converts ticks to seconds', () => {
    expect(formatSeconds(SECONDS)).toBe('1s');
    expect(formatSeconds(SECONDS * 2.5)).toBe('2.5s');
    // 0.35s is 21 ticks, which one decimal place would report as 0.4s.
    expect(formatSeconds(21)).toBe('0.35s');
  });
});

describe('effects are described in the row order', () => {
  it('puts Guard Break’s strip before its damage', () => {
    const ability = abilityById('skill.guardBreak');
    expect(ability).not.toBeNull();
    if (!ability) return;
    const text = technicalText(describeAbility(ability));
    // Read off the row rather than spelled here: what this asserts is the
    // *order* the three lines come in, and a hand-written number turns it into
    // a test that fails whenever somebody retunes the skill.
    const strip = text.indexOf('Removes 50 Guard');
    const guardDamage = text.indexOf('Guard damage');
    const damage = text.indexOf(`Deals ${ability.damage} damage`);
    expect(strip).toBeGreaterThanOrEqual(0);
    expect(guardDamage).toBeGreaterThan(strip);
    expect(damage).toBeGreaterThan(guardDamage);
  });

  it('names the status a skill applies, with its duration', () => {
    const ability = abilityById('skill.cripplingStrike');
    expect(ability).not.toBeNull();
    if (!ability) return;
    expect(technicalText(describeAbility(ability))).toContain(
      'Applies Slowed to the target for 2.5s.',
    );
  });

  it('calls a stun a Stagger, because that is the state the sim enters', () => {
    const ability = abilityById('skill.stunningBlow');
    expect(ability).not.toBeNull();
    if (!ability) return;
    expect(technicalText(describeAbility(ability))).toContain('Staggers the target for 1.4s.');
  });

  it('writes a channel as a cadence rather than as one blow', () => {
    // Built here rather than looked up, because **no shipped row is a channel
    // any more** (spec 237): `channel.drain` was spec 062's one row of that
    // kind and went with the rest of the demo set. The mechanism is still in
    // `sim/abilities.ts` and this branch is still in `description.ts`, so it is
    // still tested -- against a row constructed for it, which is the honest
    // shape while the kind has no content behind it.
    const base = abilityById('skill.poisonDart');
    expect(base).not.toBeNull();
    if (!base) return;
    const ability = {
      ...base,
      kind: 'channel' as const,
      damage: 3,
      channelTicks: 2 * SERVER_TICK_RATE,
      pulseIntervalTicks: 0.25 * SERVER_TICK_RATE,
    };
    expect(technicalText(describeAbility(ability))).toContain(
      `Deals ${ability.damage} damage every 0.25s for 2s.`,
    );
  });
});

describe('nothing is invented', () => {
  it('adds no effect line beyond damage and scaling for a row that only damages', () => {
    // Whirlwind since spec 237 took `melee.heavy` out of the table, and it is
    // the better subject anyway: two lines, both derived rather than invented
    // -- what it does, and what that grows with.
    const ability = abilityById('skill.whirlwind');
    expect(ability).not.toBeNull();
    if (!ability) return;
    const effects = describeAbility(ability).lines.filter((line) => line.tone === 'effect');
    expect(effects).toHaveLength(2);
    expect(effects[0]?.text).toBe(`Deals ${ability.damage} damage.`);
    // The weapon tooltip's notation, borrowed (spec 242): position is the
    // attribute, so Whirlwind's Strength `A` and Agility `D` sit first and
    // second -- the same string `sword.worn` draws.
    expect(effects[1]?.text).toBe('A / D / -');
  });

  it('says nothing about scaling for a row that scales with nothing (spec 238)', () => {
    // The standard's first rule reaching the newest line: an ability that
    // scales with nothing gets no line, rather than a line saying so.
    //
    // Stated as a walk of the table rather than as a hand-written list of ids,
    // which is what the first cut was and what spec 237 broke -- it named
    // `self.mend` beside the flask, and when that row was deleted the test
    // failed for the row being absent rather than for anything about a
    // description. A rule over `isUnscaled` cannot go stale that way and covers
    // every row added since.
    //
    // Asserted structurally rather than by the absence of a phrase: the line is
    // notation now, so there is no wording for a stale test to pass against.
    const unscaled = ALL_ABILITIES.filter((ability) => isUnscaled(ability.scaling));
    for (const ability of unscaled) {
      expect(describeAbility(ability).lines.some((line) => line.spans !== undefined), ability.id).toBe(
        false,
      );
    }
    // And the row the rule is *about*: a flask that grew with a build would
    // stop being the fallback for the build that needs one. Named so the walk
    // above cannot pass vacuously on an empty list.
    expect(unscaled.map((ability) => ability.id)).toContain('self.hearthdraught');
  });

  it('leaves a basic attack’s scaling to the weapon that decides it (spec 238)', () => {
    // A basic attack takes the weapon's range whole and the weapon's own
    // tooltip already prints its three grades. A second statement here would be
    // the duplicate rule this file exists to prevent.
    for (const ability of ALL_ABILITIES) {
      if (ability.basicAttack !== true) continue;
      expect(
        describeAbility(ability).lines.some((line) => line.spans !== undefined),
        ability.id,
      ).toBe(false);
    }
  });

  it('adds no facing line for a row with no cast angle', () => {
    for (const ability of ALL_ABILITIES) {
      if (ability.castAngleDeg !== undefined) continue;
      expect(technicalText(describeAbility(ability)), ability.id).not.toContain('Facing tolerance');
    }
  });

  it('adds no target-count line for a row with no area', () => {
    for (const ability of ALL_ABILITIES) {
      if (ability.area !== undefined) continue;
      expect(technicalText(describeAbility(ability)), ability.id).not.toMatch(/up to \d+ enemies/);
    }
  });

  it('never claims an arc blocks or unblocks anything', () => {
    // `sim/world.ts`: "`arcHeight` is a *look* ... It buys nothing mechanical."
    for (const ability of ALL_ABILITIES) {
      if (!ability.projectile) continue;
      const text = technicalText(describeAbility(ability));
      expect(text, ability.id).not.toMatch(/arc|lob|over anything|unblockable/i);
    }
  });
});

describe('flavour is separated', () => {
  it('keeps the authored description out of the mechanical lines', () => {
    for (const ability of ALL_ABILITIES) {
      const described = describeAbility(ability);
      expect(described.flavor, ability.id).toBe(ability.description);
      for (const line of described.lines) {
        expect(line.text, ability.id).not.toBe(ability.description);
      }
      expect(technicalText(described), ability.id).not.toContain(ability.description);
    }
  });

  it('gives a status no flavour at all', () => {
    for (const visual of STATUS_VISUALS) {
      expect(describeStatus(visual).flavor, visual.id).toBeNull();
    }
  });
});

describe('statuses', () => {
  it('marks which way each one cuts', () => {
    for (const visual of STATUS_VISUALS) {
      const text = technicalText(describeStatus(visual));
      expect(text, visual.id).toContain(visual.kind === 'boon' ? 'Beneficial.' : 'Harmful.');
    }
  });

  it('states a stack ceiling only where one can be reached', () => {
    for (const visual of STATUS_VISUALS) {
      const text = technicalText(describeStatus(visual));
      if (visual.maxStacks > 1) {
        expect(text, visual.id).toContain(`Stacks up to ${String(visual.maxStacks)} times.`);
      } else {
        expect(text, visual.id).toContain('Does not stack.');
      }
    }
  });

  it('never promises a refresh for a status with no duration', () => {
    for (const visual of STATUS_VISUALS) {
      if (!visual.indefinite) continue;
      const text = technicalText(describeStatus(visual));
      expect(text, visual.id).not.toContain('Refreshes the duration.');
      expect(text, visual.id).toContain('Lasts until it is spent.');
    }
  });
});

describe('sigils', () => {
  it('carries no numbers of its own: every sigil names a real skill', () => {
    for (const item of ALL_ITEMS) {
      if (item.activeSkillId === undefined) continue;
      const ability = abilityById(item.activeSkillId);
      expect(ability, item.id).not.toBeNull();
      expect(ability?.skill, item.id).toBe(true);
      // The item table deliberately holds no damage, cooldown or cost for a
      // sigil -- a second copy would be a second place to retune.
      expect(Object.keys(item.modifiers), item.id).toHaveLength(0);
    }
  });
});

describe('the passive skill tree (spec 191)', () => {
  it('describes every row with at least its requirement and its trigger', () => {
    for (const skill of ALL_SPECIALIZATIONS) {
      const lines = describeSpecialization(skill, 0).lines;
      expect(lines.length, skill.id).toBeGreaterThanOrEqual(2);
      const text = lines.map((line) => line.text).join('\n');
      expect(text, skill.id).toContain('Requires ');
      expect(text, skill.id).toMatch(/Trigger: |Always active\./);
    }
  });

  it('states a number for every row that grants one', () => {
    // The gap this closes. Before it, the sheet showed the authored sentence
    // and the trigger, and a player could not read a single figure off any of
    // the thirty-six rows.
    for (const skill of ALL_SPECIALIZATIONS) {
      if (grantsOf(skill.perTier).length === 0) continue;
      const text = technicalText(describeSpecialization(skill, 0));
      expect(text, skill.id).toMatch(/[+-]\d/);
    }
  });

  it('scales the total with the level held, and keeps the rate beside it', () => {
    const crushing = ALL_SPECIALIZATIONS.find((skill) => skill.id === 'str.crushingBlows');
    expect(crushing).toBeDefined();
    if (!crushing) return;
    expect(technicalText(describeSpecialization(crushing, 0))).toContain('+18% Guard damage per tier.');
    expect(technicalText(describeSpecialization(crushing, 2))).toContain(
      '+36% Guard damage (+18% per tier).',
    );
    // One rank is the rate, so the parenthesis would say the same thing twice.
    expect(technicalText(describeSpecialization(crushing, 1))).toContain('+18% Guard damage.');
    expect(technicalText(describeSpecialization(crushing, 1))).not.toContain('per tier');
  });

  it('clamps the level to what the row can actually hold', () => {
    const crushing = ALL_SPECIALIZATIONS.find((skill) => skill.id === 'str.crushingBlows');
    expect(crushing).toBeDefined();
    if (!crushing) return;
    expect(technicalText(describeSpecialization(crushing, 99))).toBe(
      technicalText(describeSpecialization(crushing, crushing.maxTier)),
    );
  });

  it('skips a socket rather than claiming an effect', () => {
    // A zero in `perTier` may never produce a line, whatever it is there for.
    // Two kinds of zero survive and they are not the same thing: a *delta onto
    // a base in `SCALING`* (`per.steadyAim`'s `steadyAimTicks`,
    // `con.secondWind`'s `secondWindBelow`) is a row saying "the base is right",
    // and a **socket** was a row naming a trait whose magnitude was to arrive
    // from somewhere else. The second kind is gone: spec 244 deleted the
    // somewhere-else, and spec 270 gave Catalysis's `appliesSundered` a real
    // value rather than leaving a purchasable row describing a dead mechanic.
    for (const skill of ALL_SPECIALIZATIONS) {
      expect(technicalText(describeSpecialization(skill, 0)), skill.id).not.toMatch(/[+-]0[^.\d]/);
    }
    // Catalysis grants two lines now -- the damage against an afflicted target,
    // and the sunder that is the other half of the same trigger. One line here
    // would mean the socket had come back.
    const catalysis = ALL_SPECIALIZATIONS.find((skill) => skill.id === 'int.catalysis');
    expect(catalysis).toBeDefined();
    if (!catalysis) return;
    expect(grantsOf(catalysis.perTier)).toHaveLength(2);
  });

  it('never appends a rate to a flag', () => {
    // Unstoppable grants `poiseArmorAllCasts: 1`, which is on or off. "Guard
    // protection covers every cast per tier" is what happens when a flag is
    // run through the same path as a quantity.
    const unstoppable = ALL_SPECIALIZATIONS.find((skill) => skill.id === 'str.unstoppable');
    expect(unstoppable).toBeDefined();
    if (!unstoppable) return;
    const text = technicalText(describeSpecialization(unstoppable, 1));
    expect(text).toContain('Guard protection covers every cast, not only attacks.');
    expect(text).not.toContain('attacks per tier');
  });

  it('reads a reduction as a reduction', () => {
    // `backswingCancelReduction: 0.05` is a positive number meaning *less* of
    // the follow-through you have to sit through. Named as the quantity rather
    // than as the reduction, the line said the opposite of what the trait does
    // -- and since spec 258 the quantity it must not be misread as is the
    // *length* of the phase, which this no longer moves at all.
    const quick = ALL_SPECIALIZATIONS.find((skill) => skill.id === 'agi.quickRecovery');
    expect(quick).toBeDefined();
    if (!quick) return;
    const text = technicalText(describeSpecialization(quick, 0));
    expect(text).toContain('+5% Backswing you may break off');
    expect(text).not.toContain('Backswing reduction');
  });

  it('marks a premium as bad and a benefit as good', () => {
    const shaping = ALL_SPECIALIZATIONS.find((skill) => skill.id === 'int.shaping');
    expect(shaping).toBeDefined();
    if (!shaping) return;
    const grants = grantsOf(shaping.perTier);
    const cost = grants.find((grant) => grant.text.includes('Cost of shaped abilities'));
    const radius = grants.find((grant) => grant.text.includes('radius'));
    expect(cost?.good).toBe(false);
    expect(radius?.good).toBe(true);
  });

  it('keeps the flavour out of the mechanical lines', () => {
    for (const skill of ALL_SPECIALIZATIONS) {
      const described = describeSpecialization(skill, 1);
      expect(described.flavor, skill.id).toBe(skill.description);
      expect(technicalText(described), skill.id).not.toContain(skill.description);
    }
  });

  it('reports which granted fields still have no label', () => {
    // The safe default made measurable. A field with no row draws no line, so
    // an unlabelled trait is a silent gap rather than a wrong sentence -- and
    // this is the thing that stops it staying silent.
    const labelled = new Set(GRANT_LABELS.map((label) => `${label.where}:${label.key}`));
    const missing = new Set<string>();
    for (const skill of ALL_SPECIALIZATIONS) {
      const modifier = skill.perTier as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(modifier)) {
        if (key === 'traits' || value === 0) continue;
        if (!labelled.has(`stat:${key}`)) missing.add(`stat:${key}`);
      }
      const traits = (modifier['traits'] ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(traits)) {
        if (value === 0) continue;
        if (!labelled.has(`trait:${key}`)) missing.add(`trait:${key}`);
      }
    }
    // The three that cannot be turned into a signed quantity reading correctly
    // in English, each left to its row's authored sentence on purpose:
    // `juggernautBelow` is a health threshold, `masteryRelief` is a count that
    // *lowers* a requirement, and `overflowHealthPerResource` is a price the
    // skill charges for a benefit -- and since spec 239 it is a *capability*
    // rather than a rate, since the rate itself is `SCALING`'s and what a layer
    // grants is the relief beside it, which does have a label.
    expect([...missing].sort()).toEqual([
      'trait:juggernautBelow',
      'trait:masteryRelief',
      'trait:overflowHealthPerResource',
    ]);
  });
});

describe('afflictions are derived, never authored (spec 190)', () => {
  it('gives every row exactly one source for what it does', () => {
    // The rule the whole file rests on, as a check rather than a habit: an
    // affliction *is* its row in `data/damage-over-time.ts`, so authoring a
    // sentence beside it would be a second copy of `damagePerSecond` with
    // nothing keeping it true -- and a row with neither source says nothing.
    //
    // Two derived sources now rather than one (spec 223): an aura field is a
    // reach, an affliction and a linger in `data/aura-fields.ts`, which is the
    // same rule with a different table under it. A *third* would be worth
    // stopping to think about; this one is the same shape exactly.
    for (const visual of STATUS_VISUALS) {
      const derived = dotById(visual.id) !== null || auraFieldById(visual.id) !== null;
      const authored = visual.effect !== undefined;
      expect(derived !== authored, `${visual.id}: derived=${String(derived)} authored=${String(authored)}`).toBe(true);
    }
  });

  it('derives an aura field’s reach, affliction and linger off its own row (spec 223)', () => {
    for (const field of ALL_AURA_FIELDS) {
      const visual = STATUS_VISUALS.find((row) => row.id === field.id);
      expect(visual, field.id).toBeDefined();
      if (!visual) continue;
      const text = technicalText(describeStatus(visual));
      // The reach, because it is the number a player positions against.
      expect(text, field.id).toContain(String(field.radius));
      // The affliction by **name** and never by its numbers: spec 190's rule is
      // that the row is the affliction whole, so the field names it and the
      // reader gets the rate from that condition's own tooltip.
      const dot = dotById(field.dotId);
      expect(dot, field.dotId).not.toBeNull();
      if (dot) {
        expect(text, field.id).toContain(dot.name);
        expect(text, field.id).not.toContain(String(dot.damagePerSecond));
      }
      // And the linger, in seconds, which is the whole of what a player decides
      // against: leaving works, and this is how long it takes to work.
      expect(text, field.id).toContain(formatSeconds(field.lingerTicks));
    }
  });

  it('states each affliction’s rate, cadence and count off its own row', () => {
    for (const dot of ALL_DOTS) {
      const visual = STATUS_VISUALS.find((row) => row.id === dot.id);
      expect(visual, dot.id).toBeDefined();
      if (!visual) continue;
      const text = technicalText(describeStatus(visual));
      expect(text, dot.id).toContain(`Deals ${String(Math.round(dotPulseDamage(dot) * 100) / 100)} damage`);
      expect(text, dot.id).toContain(`${String(dot.pulses)} times`);
    }
  });

  it('never reports the expiry guard as a designed duration', () => {
    // `dotDurationTicks` is `pulses * interval + 1`, and that one tick is slack
    // so the last pulse lands inside `statusOf`'s comparison. Reported as-is it
    // reads "over 4.02s", which is an implementation detail in front of a player.
    for (const dot of ALL_DOTS) {
      const visual = STATUS_VISUALS.find((row) => row.id === dot.id);
      if (!visual) continue;
      const text = technicalText(describeStatus(visual));
      expect(text, dot.id).toContain(`over ${formatSeconds(dot.pulses * dot.intervalTicks)}`);
    }
  });

  it('names an affliction a skill applies without restating its numbers', () => {
    // `applyDot` carries one field -- the row *is* the affliction, whole -- so a
    // skill that lands one names it and claims none of its numbers.
    for (const ability of ALL_ABILITIES) {
      for (const effect of ability.effects ?? []) {
        if (effect.kind !== 'applyDot') continue;
        const dot = dotById(effect.dotId);
        expect(dot, `${ability.id} names ${effect.dotId}`).not.toBeNull();
        if (!dot) continue;
        const text = technicalText(describeAbility(ability));
        expect(text, ability.id).toContain(`Applies ${dot.name}`);
      }
    }
  });
});
