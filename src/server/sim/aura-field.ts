/**
 * A status that reaches the bodies around its carrier (spec 223).
 *
 * Every landing this game has resolves **once**: `landOnTarget` names a body,
 * `landBlast` a point, `landArea` a shape, `launchProjectile` a flight, and each
 * runs its effect list at one instant and is finished. Spec 190 added the one
 * thing that outlives its own delivery -- an affliction -- but an affliction is
 * carried by the body it was put on. Nothing could say *this ground is dangerous
 * while I am standing on it*, which is a question about time and position
 * together and therefore one a landing cannot answer.
 *
 * This is that pass, and it is small because it invents nothing: a field is a
 * boon its carrier wears (`sim/statuses.ts`), its reach and its affliction are a
 * row (`data/aura-fields.ts`), and what it lays on a body goes through
 * {@link landDot}, the same function `applyDot` and `spread` land theirs
 * through.
 *
 * ## The linger is the mechanic
 *
 * A field re-lays its affliction **every tick** a body is inside it. Two
 * properties fall out of that and they are the feature:
 *
 *  - **Standing in it never runs out.** The expiry keeps moving forward while
 *    `appliedAtTick` does not, which is exactly what `applyStatus` promises a
 *    refresh does -- so the pulses keep their own cadence rather than being
 *    ticked forever into the future or restarted.
 *  - **Stepping out leaves exactly the linger.** The last application a body got
 *    was worth `lingerWindowTicks`, so the fire goes out about a second later
 *    wherever they went.
 *
 * ## Three rules, each the fix for the version without it
 *
 * **It never puts out a bigger fire.** `applyStatus` refreshes a clock in
 * *both* directions -- the mistake spec 190 records having made with Corrosion's
 * Sundered -- so a body carrying four seconds of Burn from an Ember Toss that
 * walked into a one-second field would have had three of them cancelled by the
 * fire it was standing in. The window is the larger of what is left and the
 * field's own.
 *
 * **It never stacks with itself.** It re-applies every tick, so any rule but
 * this one reaches a stacking affliction's ceiling in `maxStacks` ticks. It lays
 * one stack and then holds whatever concentration somebody *else's* skill put
 * there: the ceiling handed to `landDot` is `max(1, stacks already held)`, which
 * is a no-op on a body at one stack and cannot cut a five-stack Poison to one.
 *
 * **Hostility is re-asked every tick**, for the reason `pulseDots` states one
 * level down and which applies here more sharply: a field is *live*, so a
 * carrier who walked into a safe zone with one up would otherwise go on burning
 * whoever was standing there.
 *
 * It draws **nothing from the Rng** -- `applyStatus` never has -- so adding a
 * field to a fight cannot move a single draw in the world after it. It raises no
 * events either: everything it does is somebody else's to report, and the pulse
 * that follows already floats the number and credits the kill.
 *
 * Pure, and handed the same {@link DotContext} the affliction pass is, for the
 * same reason: both questions live in `world.ts` and `world.ts` calls this.
 */

import { auraFieldById, lingerWindowTicks, type AuraFieldDefinition } from '../data/aura-fields.js';
import { dotById } from '../data/damage-over-time.js';
import { afflictable, landDot, type DotContext } from './damage-over-time.js';
import { statusOf, type StatusState } from './statuses.js';
import type { ServerEntity } from './types.js';

/** A body inside a field this tick, and how far in. */
interface Caught {
  readonly id: number;
  readonly distanceSq: number;
}

/**
 * What one tick inside a field is worth to a body already carrying `held` of
 * its affliction.
 *
 * Out here rather than inline in the pass because it is the *whole* of the two
 * rules a field's repetition turns on, and a test that asserted them against its
 * own copy of the arithmetic would be asserting nothing. Two callers, one
 * description -- the same reason `gradeNavCells` came out of `createNavGrid`.
 *
 * **The window is the larger of the two.** `applyStatus` refreshes a clock in
 * both directions, so the naive version has a one-second field putting out the
 * four seconds of Burn an Ember Toss just started.
 *
 * **The ceiling is whatever is already there, floored at one.** The pass
 * re-applies every tick, so any other rule runs a stacking affliction to its cap
 * in `maxStacks` ticks -- and a flat cap of one would cut a five-dart Poison down
 * to a single stack the moment its carrier walked past.
 */
export function fieldLanding(
  field: AuraFieldDefinition,
  held: StatusState | null,
  tick: number,
): { readonly durationTicks: number; readonly maxStacks: number } {
  return {
    durationTicks: Math.max(lingerWindowTicks(field), held ? held.expiresAtTick - tick : 0),
    maxStacks: Math.max(1, held?.stacks ?? 0),
  };
}

/**
 * Whether this body is carrying a field, and which.
 *
 * Exported because two callers want the same answer and must not disagree about
 * it: the pass, and the client's ring driver by way of the replicated status
 * list. Null is the overwhelmingly common case.
 */
export function fieldsOn(entity: ServerEntity, tick: number): readonly AuraFieldDefinition[] | null {
  // The common case, and the reason this costs a key walk rather than a table
  // walk: almost every body in the world is carrying nothing at all.
  let found: AuraFieldDefinition[] | null = null;
  for (const id of Object.keys(entity.statuses)) {
    const row = auraFieldById(id);
    if (!row) continue;
    if (!statusOf(entity.statuses, id, tick)) continue;
    (found ??= []).push(row);
  }
  return found;
}

/**
 * One tick of every field in the world.
 *
 * Mutates `working` and returns nothing. It runs **between the movement passes
 * and the affliction pass**, which is the one correctly bracketed slot: every
 * body has finished moving, so the positions it measures are this tick's, and
 * `pulsesOn` requires `elapsed > 0`, so a body that steps in on this tick
 * cannot also take a pulse for having done so.
 */
export function pulseAuraFields(
  working: Map<number, ServerEntity>,
  tick: number,
  context: DotContext,
): void {
  // Gathered before anything is written, so a body that a field puts an
  // affliction on cannot become a carrier for the rest of this tick -- the pass
  // is over the world as it was at the top of it, not over its own output.
  let carriers: { readonly entity: ServerEntity; readonly fields: readonly AuraFieldDefinition[] }[] | null = null;
  for (const entity of working.values()) {
    if (!afflictable(entity) || !context.isSimulated(entity)) continue;
    const fields = fieldsOn(entity, tick);
    if (!fields) continue;
    (carriers ??= []).push({ entity, fields });
  }
  if (!carriers) return;

  for (const carrier of carriers) {
    for (const field of carrier.fields) {
      const row = dotById(field.dotId);
      // The power this field was **cast** with, read off the carrier's own
      // field status -- which is where `applyStatus` snapshotted it when the
      // skill landed (spec 238). Per field rather than per carrier, because a
      // body carrying two fields carries two independent snapshots.
      //
      // **A magnitude that is not positive means none was stated**, and the
      // answer is 1 -- the table's own rate, unmodified. That is not defensive
      // padding: `admin:triggerEvent 'field'` applies this status directly and
      // authors no magnitude, so a plain `?? 1` would leave the developer path
      // drawing a ring that burns nobody, which is the exact shape of silent
      // no-op this file's neighbours are written to refuse. `applyStatus`
      // itself defaults a magnitude to 0, so "absent" arrives here as 0 rather
      // than as `undefined`.
      const held = statusOf(carrier.entity.statuses, field.id, tick);
      const power = held && held.magnitude > 0 ? held.magnitude : 1;
      // A field naming an affliction that is not in the table does nothing
      // rather than throwing. `aura-fields.test.ts` refuses the row, so this is
      // the runtime half of a check that has already failed in CI.
      if (!row) continue;
      for (const caught of inside(carrier.entity, field, working, context)) {
        const body = working.get(caught.id);
        if (!body) continue;
        working.set(body.id, {
          ...body,
          statuses: landDot(body.statuses, row, tick, {
            ...fieldLanding(field, statusOf(body.statuses, row.id, tick), tick),
            // The power the field was **cast** with, snapshotted into the
            // carrier's own field status when the skill landed (spec 238), not
            // the carrier's live spell power. Two changes in one: it is the
            // casting ability's declared letters rather than Intelligence
            // outright, and it is a snapshot rather than a live read -- so a
            // field is worth what the build that laid it was worth, which is
            // the rule `magnitude` exists for and the one every affliction
            // already follows.
            magnitude: power,
            sourceId: carrier.entity.id,
          }),
        });
      }
    }
  }
}

/**
 * Who is standing in one field, nearest first.
 *
 * The reach is measured to a body's **edge**, the way `landOnTarget` and
 * `landBlast` already measure theirs, so a big body is caught by the edge of the
 * fire rather than only by its centre.
 *
 * Sorted by distance and tied on entity id, which is `crowd.ts`'s rule and is
 * what makes `maxTargets` a deterministic cut rather than a function of the
 * order the entity map happens to iterate in.
 */
function inside(
  carrier: ServerEntity,
  field: AuraFieldDefinition,
  working: Map<number, ServerEntity>,
  context: DotContext,
): readonly Caught[] {
  const caught: Caught[] = [];
  for (const candidate of working.values()) {
    if (candidate.id === carrier.id) continue;
    if (!afflictable(candidate) || !context.isSimulated(candidate)) continue;
    if (!context.isHostile(carrier, candidate)) continue;
    const dx = candidate.position.x - carrier.position.x;
    const dy = candidate.position.y - carrier.position.y;
    const reach = field.radius + candidate.radius;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq > reach * reach) continue;
    caught.push({ id: candidate.id, distanceSq });
  }
  if (caught.length <= field.maxTargets) return caught;
  caught.sort((a, b) => (a.distanceSq === b.distanceSq ? a.id - b.id : a.distanceSq - b.distanceSq));
  return caught.slice(0, field.maxTargets);
}
