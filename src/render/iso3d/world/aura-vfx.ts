/**
 * The ring under a body carrying an aura field (spec 223).
 *
 * `aurasFor` decides *which* rings a body should be wearing and has since spec
 * 121; this is what starts and stops them. The two are separate for the reason
 * every view-model in this directory is separate from its mount: the decision is
 * a pure function of replicated facts, and the bookkeeping is a thing that
 * remembers.
 *
 * ## Nothing in this game had ever played an aura
 *
 * Spec 124 built the sigil -- three generated meshes, `uOrient` on the mesh
 * batch for it, `hardStop` on the effect format for it -- and left it reachable
 * from the Studio tab and from nowhere else, because no status was replicated.
 * Spec 186 replicated them and nothing came back to collect. So this driver is
 * the first caller of that whole path, and the ring it puts on the ground is the
 * first one a player has ever seen in the game.
 *
 * ## Why not `AuraTracker`
 *
 * `AuraTracker` (spec 121) is the tested machinery for exactly this diff and is
 * still right for a ring whose start cannot be refused. It is wrong here for the
 * reason `affliction-vfx.ts` gives at length: **`play` returns 0 on refusal** --
 * an id the registry does not know, the effect budget, `cullDistance` -- and a
 * tracker that records *ids* cannot tell "wanted, asked for, did not start" from
 * "started". Committing a refused id leaves a body wearing no ring for the rest
 * of its life, which for a field is worse than for a cling: the ring is where
 * the fire is, so a missing one is not missing paint, it is a hazard nobody can
 * see.
 *
 * So this holds **handles**, and inherits the two obligations that come with
 * one, both of them stated in `affliction-vfx.ts` and both of them bugs the
 * moment they are skipped:
 *
 *  - **Ask `isLive` every frame.** A full instance pool does not refuse, it
 *    *evicts* the lowest-priority furthest instance and bumps that slot's
 *    generation, so every handle to it goes stale where it sits.
 *  - **The stop is owed.** Nothing in the particle system stops itself. An aura
 *    particle lives `HELD` ticks -- ten minutes -- so one left on a despawned
 *    body holds an instance slot for the rest of the session. {@link forget} is
 *    called from the sweep that knows a body has left, never inferred.
 *
 * Impure only in that it remembers: no three.js and no DOM, so it is driven end
 * to end in Node against a recording {@link VfxPlayer}.
 */

import type { WireStatus } from '../../../server/net/messages.js';
import { visualByWire } from '../../../server/data/status-visuals.js';
import { ALL_AURA_FIELDS, auraFieldById } from '../../../server/data/aura-fields.js';
import { aurasFor, type AuraFacts } from './auras.js';
import { seedFor, type VfxPlayer } from './affliction-vfx.js';

/** Where a body is. An aura is on the ground under it, so it has no size. */
export interface AuraBody {
  readonly entityId: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const NONE: readonly string[] = [];

/**
 * Which aura-field statuses this body's replicated list says it is carrying.
 *
 * Off the wire index rather than an id, because that is what crosses:
 * `visualByWire` answers null for an index this build has no row for, which is a
 * client reading a newer server and is the case the whole table is append-only
 * to survive.
 *
 * Live ones only, on the same comparison the sim makes -- `status-marks.ts`'s
 * rule, and for its reason: correctness must not depend on whether the delta
 * saying "it fell off" has arrived yet.
 */
export function fieldStatusesOn(statuses: readonly WireStatus[], tick: number): readonly string[] {
  let found: string[] | null = null;
  for (const status of statuses) {
    if (tick >= status.expiresAtTick) continue;
    const visual = visualByWire(status.wire);
    if (!visual || !auraFieldById(visual.id)) continue;
    (found ??= []).push(visual.id);
  }
  return found ?? NONE;
}

/**
 * Starts and stops the rings under every body wearing one.
 *
 * Idempotent: the same facts on the next frame start nothing and stop nothing.
 */
export class AuraVfx {
  /** entity id -> aura effect id -> the handle that stops it. */
  private readonly owned = new Map<number, Map<string, number>>();

  constructor(private readonly player: VfxPlayer) {}

  /** Bring one body's rings up to date. */
  step(body: AuraBody, facts: AuraFacts): void {
    const wanted = aurasFor(facts);
    let held = this.owned.get(body.entityId);

    if (wanted.length === 0) {
      if (held) this.forget(body.entityId);
      return;
    }

    if (!held) {
      held = new Map<string, number>();
      this.owned.set(body.entityId, held);
    }

    for (const id of wanted) {
      const handle = held.get(id) ?? 0;
      // Evicted out from under us, or refused when it was last asked for. Either
      // way the ring is not on the ground, so ask again -- which may well be
      // refused again this frame, and should be while the pressure lasts.
      if (handle !== 0 && this.player.isLive(handle)) continue;
      held.set(id, this.start(id, body));
    }

    for (const [id, handle] of held) {
      if (wanted.includes(id)) continue;
      if (handle !== 0) this.player.stop(handle);
      held.delete(id);
    }
    if (held.size === 0) this.owned.delete(body.entityId);
  }

  /** Everything this body still owns, on its way out of the scene. */
  forget(entityId: number): void {
    const held = this.owned.get(entityId);
    if (!held) return;
    for (const handle of held.values()) {
      if (handle !== 0) this.player.stop(handle);
    }
    this.owned.delete(entityId);
  }

  /** Every body this driver still believes is wearing a ring. */
  entities(): readonly number[] {
    return [...this.owned.keys()];
  }

  clear(): void {
    for (const entityId of [...this.owned.keys()]) this.forget(entityId);
  }

  private start(id: string, body: AuraBody): number {
    // `playCue`'s rule rather than `addEffect`'s: an id the registry does not
    // know is silence, never a fallback ring -- which for this driver would be
    // a *literal* fallback ring, drawn at a radius that is not the field's and
    // therefore saying something untrue about where the fire is.
    if (!this.player.has(id)) return 0;
    return this.player.play(id, {
      x: body.x,
      y: body.y,
      z: body.z,
      // Derived rather than drawn, so two clients watching one body see the ring
      // at the same angle -- the reason `seed` has no default in `PlayOptions`.
      seed: seedFor(body.entityId, id, 0),
      // **No scale.** An aura is authored at the radius it is drawn at, because
      // that radius is the field's own reach and `system.ts` multiplies an
      // instance scale into offsets and absolute sizes as well as into the
      // shape -- a ring scaled to fit would take its shafts' height with it.
      attach: { kind: 'entity', entityId: body.entityId },
    });
  }
}

// --- reaching one from the shipped page --------------------------------------

/**
 * Whether `?field=` asks for an aura field to be forced on (spec 223).
 *
 * The developer path, in the same register as `?afflict=` and for the same
 * reason: the alternative to it is farming a level-6 exceptional sigil every
 * time somebody wants to look at the ring in the game. It answers a boolean
 * rather than a list, because there is one field -- `triggerEvent('field')`
 * grants every row and a per-row switch would be a list with one entry in it.
 *
 * Read by `view.ts`, which turns it into `server.triggerEvent('field', ...)` on
 * the player's own position. Loopback only, because that is where a server this
 * thread can ask exists at all.
 */
export function fieldsWantedByQuery(search: string): boolean {
  const raw = new URLSearchParams(search).get('field');
  if (raw === null) return false;
  const value = raw.trim().toLowerCase();
  if (value === '' || value === '1' || value === 'true' || value === 'all') return true;
  // A named row, so `?field=scorchedEarth` reads as what it does rather than as
  // a switch -- and so a second row is a name somebody can already type.
  return ALL_AURA_FIELDS.some((field) => field.id.toLowerCase() === value);
}
