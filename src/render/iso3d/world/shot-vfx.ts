/**
 * The paint a shot flies with, started and stopped (spec 218).
 *
 * Pure -- no three.js, no DOM, no `GameClient`. It is handed replicated facts
 * and answers what to play, which is the discipline `vfx-wire.ts`,
 * `affliction-vfx.ts` and `unit-driver.ts` all keep so that presentation has
 * nothing it *could* call. The one rule: every `if` in here decides which effect
 * is drawn and none of them decides a game outcome.
 *
 * ## What kind of thing this is
 *
 * `auras.ts` draws the line in one sentence -- *"a hit happens; a poison
 * lasts"* -- and a shot in flight is squarely the second. It is a **state**:
 * started once when the projectile comes into view, stopped once when it leaves,
 * and nothing per frame in between. A shot that a client picks up halfway across
 * the arena is a shot on fire, because there is no start to have missed.
 *
 * So there is no beat here and no edge detection. What there *is* is the
 * bookkeeping a persistent attached effect needs, and all three rules below were
 * learned by spec 215 one system over -- the failure modes are identical because
 * the machinery is.
 *
 * ## Handles, not ids
 *
 * `play` returns **0 on refusal** -- an unknown id, over budget, past
 * `cullDistance`. A driver that recorded ids could not tell "wanted, asked for,
 * did not start" from "started", so a shot refused in the frame it spawned would
 * fly the rest of its life unpainted, silently, and only in the crowded fight
 * that caused the pressure. Holding a handle makes a refusal mean "not started
 * yet", and the next frame tries again.
 *
 * ## `isLive`, every frame
 *
 * A full instance pool does not refuse: `claimInstance` **evicts** the
 * lowest-priority furthest instance, hands the slot over and bumps its
 * generation, so every handle to it goes stale where it sits. Asking rather than
 * assuming is what lets the paint come back when the pressure lifts.
 *
 * ## The stop is owed
 *
 * Nothing in the particle system stops itself when the body it is attached to
 * goes away: the attach hook simply answers false, the instance stays wherever
 * it last resolved, and a `durationTicks: 0` effect hangs in the air forever
 * holding one of 128 slots. A shot lives a second and a half, so that is a leak
 * that would run at the rate of the shooting. {@link ShotVfx.forget} is called
 * from the despawn sweep that already knows a body has left, never inferred from
 * an absence.
 */

import type { ProjectileLook } from '../../../server/data/abilities.js';

/**
 * What each shot flies with, or nothing.
 *
 * A **table**, not a naming convention, for the reason `naming.ts` is a table
 * and `AFFLICTION_ART` is one: a built id (`` `shot_${look}` ``) is a second,
 * invisible answer that every boundary has to re-derive, a typo in it survives
 * as an effect that silently plays nothing, and it has nowhere to say that three
 * of the four looks deliberately carry no paint at all.
 *
 * They do not, and each for its own reason. An **arrow** and a **shuriken** are
 * objects: their whole silhouette is their mesh, and paint on one would be
 * something burning that is not on fire. An **orb** is a bead of conjured light
 * and already reads as lit from within; giving it marks would make an Arcane
 * Bolt look like a second spell.
 *
 * Both directions are asserted against the compiled registry in the test beside
 * this: every id here exists, and every `shot_` effect in the registry is named
 * here. The second half is what catches an effect authored and then reached by
 * nothing -- which is the state this spec found the painted explosion in.
 */
export const SHOT_ART: Readonly<Partial<Record<ProjectileLook, string>>> = {
  ember: 'shot_ember',
};

/** The effect a shot of this look flies with, or null for one that flies bare. */
export function shotArtFor(look: ProjectileLook | null | undefined): string | null {
  if (look === null || look === undefined) return null;
  return SHOT_ART[look] ?? null;
}

/**
 * The two calls this needs from the particle system.
 *
 * An interface rather than `VfxLayer`, so the driver is pure and the whole
 * feature is driven end to end in Node against a recorder -- the same reason
 * `unit-driver.ts` takes a snapshot rather than a `GameClient`. `VfxLayer`
 * satisfies it structurally.
 */
export interface ShotVfxPlayer {
  play(
    id: string,
    options: {
      x: number;
      y: number;
      z: number;
      seed: number;
      scale?: number;
      attach?: { kind: 'entity'; entityId: number };
    },
  ): number;
  stop(handle: number): void;
  has(id: string): boolean;
  /** Whether a handle still names a running effect. See the header. */
  isLive(handle: number): boolean;
}

/** Where a shot is being drawn, how big it is, and what it is. */
export interface ShotBody {
  readonly entityId: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /**
   * The shot's collision radius, which is the effect's `scale`.
   *
   * Every length in `brushShot` is authored as a multiple of it, so one
   * definition is a fireball at any size: `system.ts` multiplies both the
   * shape's local coordinates and the size curve by the instance scale.
   */
  readonly radius: number;
  readonly look: ProjectileLook | null;
}

/** What one shot currently owns. */
interface Owned {
  /** The effect playing, and the handle that stops it. */
  id: string;
  handle: number;
}

export class ShotVfx {
  private readonly owned = new Map<number, Owned>();

  constructor(private readonly player: ShotVfxPlayer) {}

  /**
   * Bring one shot up to date. Idempotent: the same facts on the next frame
   * start nothing and stop nothing.
   */
  step(body: ShotBody): void {
    const wanted = shotArtFor(body.look);
    const own = this.owned.get(body.entityId);

    if (wanted === null) {
      // A look that lost its art, which cannot happen for a shot in flight --
      // `appearanceOf` reads a frozen table -- but is one line and means the
      // driver has no state that only a despawn can clear.
      if (own) this.forget(body.entityId);
      return;
    }

    if (own) {
      // Evicted out from under us: the pool filled and something with a better
      // claim took the slot, so the handle names nothing and the paint is gone.
      // Forget it and let the start below try again -- it may well be refused
      // again this frame, which is what should happen while the pressure lasts.
      if (own.handle !== 0 && !this.player.isLive(own.handle)) own.handle = 0;
      // Belt and braces: an id that changed would leave a shot wearing both.
      if (own.handle !== 0 && own.id !== wanted) {
        this.player.stop(own.handle);
        own.handle = 0;
      }
      if (own.handle === 0) {
        own.id = wanted;
        own.handle = this.start(wanted, body);
      }
      return;
    }

    this.owned.set(body.entityId, { id: wanted, handle: this.start(wanted, body) });
  }

  /** Everything this shot still owns, on its way out of the scene. */
  forget(entityId: number): void {
    const own = this.owned.get(entityId);
    if (!own) return;
    if (own.handle !== 0) this.player.stop(own.handle);
    this.owned.delete(entityId);
  }

  /** Every shot this driver still believes is painted. */
  entities(): readonly number[] {
    return [...this.owned.keys()];
  }

  clear(): void {
    for (const entityId of [...this.owned.keys()]) this.forget(entityId);
  }

  private start(id: string, body: ShotBody): number {
    // `playCue`'s rule rather than `addEffect`'s: an id the registry does not
    // know is silence, never a fallback ring. A debug disc under every shot in
    // the air is exactly the noise the restrained-presentation rule exists to
    // prevent.
    if (!this.player.has(id)) return 0;
    return this.player.play(id, {
      x: body.x,
      y: body.y,
      z: body.z,
      // Derived from the shot and the effect rather than drawn, so two clients
      // watching one fireball see the same marks -- the reason `seed` has no
      // default in `PlayOptions` at all.
      seed: shotSeedFor(body.entityId, id),
      scale: body.radius,
      attach: { kind: 'entity', entityId: body.entityId },
    });
  }
}

/**
 * A seed from facts every client shares.
 *
 * No clock and no `Math.random`: the entity and the effect. FNV-1a over the id's
 * bytes mixed with the entity, which is `affliction-vfx.ts`'s `seedFor` with the
 * pulse index dropped -- a flight has no beats to tell apart, and a second
 * parameter nothing could ever pass would be a parameter nobody could read.
 */
export function shotSeedFor(entityId: number, id: string): number {
  let hash = 0x811c9dc5 ^ (entityId * 0x01000193);
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 0x7fffffff;
}
