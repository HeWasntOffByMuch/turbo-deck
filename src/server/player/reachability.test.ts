/**
 * The audit pass that would have caught Heavy Handling (spec 271).
 *
 * `auditSpecializations` asks whether a purchase moves a number the sim reads,
 * and by that question Heavy Handling was ACTIVE for thirty-four specs: it
 * granted `heavyWindupReduction`, `deriveTraits` turned it into a
 * `heavyWindupScale` that fell from 1.0 to 0.55 across its three tiers, and the
 * number genuinely moved. What nothing asked was whether any content could
 * reach the line reading it -- the consumer was
 * `ability.damage >= HEAVY_ABILITY_DAMAGE`, and spec 237 had deleted the one
 * ability in the table that cleared the bar.
 *
 * So the case is asserted here **against the real ability table**, using the
 * predicate that consumer actually used, rather than against a mock. That is the
 * whole value of the test: a mock would prove the filter works, and this proves
 * the filter would have fired on the content that shipped.
 */

import { describe, expect, it } from 'vitest';

import { ALL_ABILITIES } from '../data/abilities.js';
import { ALL_SPECIALIZATIONS } from '../data/specializations.js';
import {
  auditReachability,
  TRAIT_GATES,
  unreachableTraits,
  type TraitGate,
} from './progression-audit.js';
import type { SpecializationDefinition } from '../data/specializations.js';

/** Heavy Handling's consumer, as it stood before spec 271 removed it. */
const HEAVY_ABILITY_DAMAGE = 6;

const HEAVY_GATE: TraitGate = {
  trait: 'heavyWindupScale',
  gate: 'an ability over the heavy-damage threshold',
  satisfiedBy: () =>
    ALL_ABILITIES.filter((ability) => ability.damage >= HEAVY_ABILITY_DAMAGE).map((a) => a.id),
};

/** Heavy Handling's row, as it stood before spec 271 replaced it. */
const HEAVY_HANDLING = {
  id: 'str.heavyHandling',
  attribute: 'strength',
  name: 'Heavy Handling',
  requires: 25,
  tier: 2,
  maxTier: 3,
  trigger: 'casting a heavy ability',
  perTier: { traits: { heavyWindupScale: 0.15 } },
  description: 'Oversized weapons stop punishing you for their weight.',
} as unknown as SpecializationDefinition;

describe('content reachability', () => {
  it('reports the Heavy Handling case: a trait that moves and a gate nothing satisfies', () => {
    const rows = auditReachability([HEAVY_GATE], [HEAVY_HANDLING]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.reachable).toBe(false);
    expect(row.satisfying).toBe(0);
    // And it names who was selling it, which is what turns a dead gate into a
    // finding: a dormant trait nothing grants is a state a dozen former-synergy
    // fields are deliberately in.
    expect(row.granters).toEqual(['str.heavyHandling']);
    expect(unreachableTraits(rows)).toHaveLength(1);
  });

  it('confirms the ability table really cannot satisfy that gate', () => {
    // The control. If some row did clear 6, the case above would be a test about
    // a predicate rather than about the content that shipped -- so this states
    // the fact separately, off the live table.
    const heaviest = Math.max(...ALL_ABILITIES.map((ability) => ability.damage));
    expect(heaviest).toBeLessThan(HEAVY_ABILITY_DAMAGE);
  });

  it('does not report a dead gate that nothing sells', () => {
    // The false-positive rule, and the reason `granters` exists. An unreachable
    // gate on a trait no specialization grants is not a player-facing failure --
    // it is the dormant state, and reporting it would make the check noise
    // nobody reads.
    const rows = auditReachability([HEAVY_GATE], []);
    expect(rows[0]?.reachable).toBe(false);
    expect(rows[0]?.granters).toEqual([]);
  });

  it('finds every gate in the shipped table reachable', () => {
    // The false-positive check that matters: a conditional mechanic somebody
    // *can* reach must not be reported. All six of the sim's real gates are
    // satisfied by content today.
    for (const row of auditReachability()) {
      expect(row.reachable, `${row.trait}: ${row.gate}`).toBe(true);
      expect(row.satisfying, row.trait).toBeGreaterThan(0);
    }
    expect(unreachableTraits()).toEqual([]);
  });

  it('covers each gate with a real trait and a non-empty description', () => {
    // A gate naming a trait that does not exist would silently never fire.
    expect(TRAIT_GATES.length).toBeGreaterThan(0);
    const traits = new Set(TRAIT_GATES.map((gate) => gate.trait));
    expect(traits.size, 'a trait is gated twice').toBe(TRAIT_GATES.length);
    for (const gate of TRAIT_GATES) {
      expect(gate.gate.trim(), gate.trait).not.toBe('');
    }
  });

  it('reports Guard-pressure traits as reachable now that content carries impact', () => {
    // Spec 271's own gates. `abilityPoiseFactor` is the fallback for a row that
    // authors no `guardImpact`, and `momentumWindupScale` needs something able
    // to break a Guard at all -- both of which the table now satisfies.
    const rows = auditReachability();
    const byTrait = new Map(rows.map((row) => [row.trait, row]));
    expect(byTrait.get('abilityPoiseFactor')?.reachable).toBe(true);
    expect(byTrait.get('momentumWindupScale')?.reachable).toBe(true);
  });

  it('no longer sells Heavy Handling at all', () => {
    // The other half of the fix: the row is gone, so even if the gate came back
    // there would be nothing to spend on it.
    expect(ALL_SPECIALIZATIONS.map((s) => s.id)).not.toContain('str.heavyHandling');
    expect(ALL_SPECIALIZATIONS.map((s) => s.id)).toContain('str.executioner');
  });
});
