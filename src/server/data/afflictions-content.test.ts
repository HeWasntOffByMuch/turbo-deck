/**
 * The afflictions, checked as content (spec 190).
 *
 * An affliction is spread across four tables that do not import each other: the
 * row that does the damage (`data/damage-over-time.ts`), the id the sim writes
 * (`sim/statuses.ts`), the mark a player reads (`data/status-visuals.ts`) and
 * the sigil somebody has to be wearing before any of it can happen
 * (`data/items.ts`). Each of the four is correct on its own, and the failure
 * worth testing for is the one *between* them -- a row with no mark, a skill no
 * item names, a stack ceiling two tables disagree about, an `applyDot` naming a
 * row that was renamed.
 *
 * That failure is not hypothetical here; it is the one this repo keeps
 * shipping. `STARTING_ABILITIES` was exported and read by nothing for a hundred
 * and twenty specs, four weapons authored an `attackSpeedPct` that reached
 * nothing for eighty, and four of the map editor's five marker kinds still have
 * no reader anywhere. None of those is a bug in a function. Each is a row
 * pointing at nothing, which is exactly what no unit test of either end can
 * see.
 *
 * So what is asserted here is the *joins*, in the register
 * `progression-tables.test.ts` set for the progression: fifteen pairs or CI
 * fails, and here, an affliction nobody can apply or nobody can see or CI
 * fails.
 *
 * One assertion the brief asks for is deliberately not in this file. Whether
 * every icon a row names is actually drawn is a question about
 * `render/iso3d/world/icons.ts`, and `src/server/data/` is part of the
 * deterministic core -- eslint refuses it an import of `src/render/`, which is
 * the rule working rather than an obstacle. It lives in
 * `render/iso3d/world/afflictions-content.test.ts`, beside the table it is
 * about.
 */

import { describe, expect, it } from 'vitest';
import { StatusId } from '../sim/statuses.js';
import { ALL_ABILITIES, abilityById } from './abilities.js';
import {
  ALL_DOTS,
  dotById,
  dotDurationTicks,
  dotPulseDamage,
  dotTotalDamage,
  type DotDefinition,
} from './damage-over-time.js';
import { ALL_ITEMS } from './items.js';
import { STATUS_VISUALS, visualFor } from './status-visuals.js';

const SKILL_ABILITIES = ALL_ABILITIES.filter((ability) => ability.skill === true);

/** Every `applyDot` in the ability table, with the row that authored it. */
const APPLIED_DOTS: readonly { readonly abilityId: string; readonly dotId: string }[] =
  ALL_ABILITIES.flatMap((ability) =>
    (ability.effects ?? []).flatMap((effect) =>
      effect.kind === 'applyDot' ? [{ abilityId: ability.id, dotId: effect.dotId }] : [],
    ),
  );

describe('the afflictions, as content (spec 190)', () => {
  it('gives every affliction an id the sim actually writes', () => {
    // The row's `id` is a StatusId by contract and a bare string by type, so
    // nothing in the compiler stops a row naming `'frostbight'`. It would apply
    // cleanly, pulse cleanly, and be invisible to every reader that asks for
    // `StatusId.Frostbite` -- an affliction on a body that nothing can find.
    const known = new Set<string>(Object.values(StatusId));
    for (const row of ALL_DOTS) {
      expect(known.has(row.id), `${row.id} is not a StatusId`).toBe(true);
    }
    expect(new Set(ALL_DOTS.map((row) => row.id)).size).toBe(ALL_DOTS.length);
  });

  it('gives every affliction a mark a player can read', () => {
    // The first thing that can *kill* somebody without a blow landing, so the
    // one thing a player must not have to infer from a health bar going down
    // for no reason.
    for (const row of ALL_DOTS) {
      const visual = visualFor(row.id);
      expect(visual, `${row.id} has no STATUS_VISUALS row`).not.toBeNull();
      expect(visual?.kind).toBe('affliction');
    }
  });

  it('gives every affliction a wire index of its own', () => {
    const wires = ALL_DOTS.map((row) => visualFor(row.id)?.wire);
    for (const wire of wires) expect(wire).toBeTypeOf('number');
    expect(new Set(wires).size).toBe(ALL_DOTS.length);
  });

  it('agrees with the mark about how far an affliction stacks', () => {
    // The mark's count and the concentration doing the damage are one number.
    // Two tables each carrying their own would eventually disagree, and the
    // disagreement would read as the sim being wrong about what the player is
    // carrying -- five poison stacks doing five stacks' damage under a mark
    // that says three.
    for (const row of ALL_DOTS) {
      expect(visualFor(row.id)?.maxStacks, row.id).toBe(row.maxStacks);
    }
  });
});

describe('the wire indices the marks cross on', () => {
  /**
   * The current mapping, pinned.
   *
   * `wire` is the number that crosses in place of the string id, so **changing
   * a number below is a wire break**: every mark on a client that has not been
   * rebuilt is silently re-labelled, and nothing anywhere fails. The correct
   * edit when a status is added is to *append* -- a new id and the next free
   * index -- and the correct edit when one is retired is to leave its index
   * unused forever. Renumbering to close a gap is the one thing this table may
   * never do.
   */
  const EXPECTED_WIRE: Readonly<Record<string, number>> = {
    flow: 0,
    momentum: 1,
    prepared: 2,
    attuned: 3,
    exposed: 4,
    vulnerable: 5,
    sundered: 6,
    adapted: 7,
    slowed: 8,
    burn: 9,
    bleed: 10,
    poison: 11,
    corrosion: 12,
    shock: 13,
    frostbite: 14,
    decay: 15,
    // Appended by spec 223, which is the only way this list may ever grow: the
    // index crosses the wire in place of the string, so a renumber silently
    // re-labels every mark on a client that has not been rebuilt.
    scorchedEarth: 16,
    // Appended by spec 250, on the same terms.
    magicLight: 17,
    // Appended by spec 262, on the same terms.
    overheated: 18,
    // Appended by spec 270, on the same terms: the artillery stance being built,
    // the chain that rewards varying what you cast, and the notice that says a
    // spell was paid for with health.
    preparing: 19,
    weave: 20,
    overdrawn: 21,
    // Appended by spec 272, on the same terms -- at 22 rather than the 19 it was
    // written against, because spec 270 took 19 through 21 first. Renumbering on
    // the merge is exactly what append-only is for: the index is what crosses
    // the wire, so two branches claiming one number is two clients disagreeing
    // about which mark to draw.
    patientRead: 22,
  };

  it('carries exactly the twenty-three ids it carried when they were written down', () => {
    const actual = Object.fromEntries(STATUS_VISUALS.map((visual) => [visual.id, visual.wire]));
    expect(actual).toEqual(EXPECTED_WIRE);
  });

  it('numbers them uniquely and contiguously from zero', () => {
    // Contiguity is not a wire requirement -- a retired index would leave a gap
    // and that is correct. It is asserted because nothing has been retired yet,
    // so a gap today means a number was skipped by hand, which is how the next
    // append lands on top of an existing row.
    const wires = STATUS_VISUALS.map((visual) => visual.wire).sort((a, b) => a - b);
    expect(wires).toEqual(STATUS_VISUALS.map((_, index) => index));
  });
});

describe('the skills that reach the afflictions', () => {
  it('names every active skill from exactly one item', () => {
    // A skill is an item (spec 188), so a `skill: true` ability nothing names is
    // an ability no player can ever cast: `startCast` refuses one that is not in
    // `skillAbilityIdsOf`, and that is derived off the four worn slots. Seven
    // afflictions behind seven unreachable rows is the whole failure this file
    // exists for.
    const named = ALL_ITEMS.flatMap((item) => (item.activeSkillId ? [item.activeSkillId] : []));
    for (const ability of SKILL_ABILITIES) {
      const carriers = named.filter((id) => id === ability.id);
      expect(carriers.length, `${ability.id} is carried by ${carriers.length} items`).toBe(1);
    }
    expect(named).toHaveLength(SKILL_ABILITIES.length);
  });

  it('points every item that names a skill at a real one', () => {
    // The other direction, which fails differently: a sigil naming a renamed or
    // deleted ability is an item that equips, draws a bar slot and refuses every
    // press.
    for (const item of ALL_ITEMS) {
      if (!item.activeSkillId) continue;
      const ability = abilityById(item.activeSkillId);
      expect(ability, `${item.id} names ${item.activeSkillId}`).not.toBeNull();
      expect(ability?.skill, `${item.activeSkillId} is not a skill`).toBe(true);
    }
  });

  it('resolves every applyDot effect against a row that exists', () => {
    // `dotId` is a bare string and the resolver answers null for one it does not
    // know, so a typo here is a skill that lands, deals its damage and quietly
    // applies nothing -- the failure that looks like balance rather than a bug.
    expect(APPLIED_DOTS.length).toBeGreaterThan(0);
    for (const applied of APPLIED_DOTS) {
      expect(
        dotById(applied.dotId),
        `${applied.abilityId} applies "${applied.dotId}"`,
      ).not.toBeNull();
    }
  });

  it('leaves no affliction without a skill that applies it', () => {
    // The reverse of the same join, and the one the spec is explicit about:
    // seven afflictions with no applier would be seven dead rows, and a dead
    // row is indistinguishable from a working one until somebody tries to use
    // it.
    const applied = new Set(APPLIED_DOTS.map((entry) => entry.dotId));
    for (const row of ALL_DOTS) {
      expect(applied.has(row.id), `nothing applies ${row.id}`).toBe(true);
    }
  });
});

describe('the numbers a row derives', () => {
  const rowsWith = (has: (row: DotDefinition) => boolean): readonly DotDefinition[] =>
    ALL_DOTS.filter(has);

  it('keeps the last pulse inside the window it derives', () => {
    // The `+ 1` the file header calls "the whole of the arithmetic". A duration
    // of exactly `pulses * interval` loses its last pulse to `statusOf`'s
    // `tick >= expiresAtTick`, so "eight pulses of 4.5" quietly means seven.
    // Asserted rather than trusted because it is one character.
    for (const row of ALL_DOTS) {
      expect(dotDurationTicks(row), row.id).toBe(row.pulses * row.intervalTicks + 1);
      expect(dotDurationTicks(row)).toBeGreaterThan(row.pulses * row.intervalTicks);
    }
  });

  it('authors a rate, a cadence and a length that each mean something', () => {
    for (const row of ALL_DOTS) {
      expect(dotPulseDamage(row), `${row.id} pulse damage`).toBeGreaterThan(0);
      expect(row.pulses, `${row.id} pulses`).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(row.pulses), `${row.id} pulses`).toBe(true);
      expect(row.intervalTicks, `${row.id} interval`).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(row.intervalTicks), `${row.id} interval`).toBe(true);
      expect(row.maxStacks, `${row.id} maxStacks`).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(row.maxStacks), `${row.id} maxStacks`).toBe(true);
      // A flat row's total is its pulse times its count. An escalating one's is
      // strictly more, because its later pulses are bigger -- which is the
      // whole of what `rampPerSecond` buys, and was a real bug: `dotTotalDamage`
      // was `pulse * pulses` for every row, so the one row the field exists for
      // was the one row it lied about.
      const flat = dotPulseDamage(row) * row.pulses;
      if (row.rampPerSecond === undefined) {
        expect(dotTotalDamage(row), `${row.id} total`).toBeCloseTo(flat, 10);
      } else {
        expect(dotTotalDamage(row), `${row.id} total`).toBeGreaterThan(flat);
        // And bounded by the cap, or the ramp is not capped in the sum either.
        expect(dotTotalDamage(row), `${row.id} total`).toBeLessThanOrEqual(
          flat * (row.rampCap ?? 1),
        );
      }
    }
  });

  it('gives the escalating rider the ceiling it cannot work without', () => {
    // A ramp with no cap is unbounded damage, and a cap at or below 1 is a ramp
    // that makes the affliction weaker the longer it runs -- both are rows that
    // parse, apply and behave nothing like what they say.
    const ramping = rowsWith((row) => row.rampPerSecond !== undefined);
    expect(ramping.length).toBeGreaterThan(0);
    for (const row of ramping) {
      expect(row.rampPerSecond, row.id).toBeGreaterThan(0);
      expect(row.rampCap, `${row.id} ramps with no cap`).toBeDefined();
      expect(row.rampCap ?? 0, row.id).toBeGreaterThan(1);
    }
    // And nothing carries a cap it never reaches for.
    for (const row of ALL_DOTS) {
      if (row.rampCap === undefined) continue;
      expect(row.rampPerSecond, `${row.id} caps a ramp it has not got`).toBeDefined();
    }
  });

  it('suppresses healing without ever switching it off', () => {
    // "Suppresses" is not "prevents". At zero one status decides a whole fight;
    // at one or above the rider is a field that does nothing, which is the same
    // dead row in the other direction.
    const suppressing = rowsWith((row) => row.healingScale !== undefined);
    expect(suppressing.length).toBeGreaterThan(0);
    for (const row of suppressing) {
      expect(row.healingScale ?? 0, row.id).toBeGreaterThan(0);
      expect(row.healingScale ?? 1, row.id).toBeLessThan(1);
    }
  });
});
