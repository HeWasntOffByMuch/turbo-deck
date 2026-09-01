import type { FixtureKind } from '../../../terrain/vegetation.js';
import { seedFor, type VfxPlayer } from './affliction-vfx.js';

/**
 * The fire burning in a fixture (specs 250, 263).
 *
 * A campfire's prop is a ring of stones, four charred logs and a bed of embers,
 * and nothing in it moves. What makes it a *fire* is this: a painted effect
 * played at the middle of the ring, in the same brush vocabulary the afflictions
 * are drawn in. A standing torch is the same sentence one prop over -- a stake,
 * three legs and a pitch bowl with a coal in it, and the flame is paint.
 *
 * The cone that used to stand there was the honest first answer and is the wrong
 * one for a specific reason -- a fire is the one prop in this game whose subject
 * moves, so a static solid can only ever be a picture of one instant of it.
 *
 * ## Which fixtures burn
 *
 * `FIXTURE_ART` and nothing else, in the register `shot-vfx.ts`'s `SHOT_ART` is
 * in: which effect a fixture carries is **art direction**, so it lives beside
 * the art rather than in `data/`. A kind with no row simply has no paint, which
 * is the right and quiet answer for a lamp post: what is in its lantern is a
 * mantle rather than a fire, and a mantle is a made thing that glows steadily.
 *
 * A row says how *wide* and how far *up* as well as which effect, because those
 * are the two things that separate a torch from a campfire and neither is a
 * property of the effect: the same three layers are played a fraction as wide
 * and a body's height off the ground.
 *
 * ## The three rules it inherits
 *
 * Built to `affliction-vfx.ts`'s pattern, because the machinery is the same and
 * so are the ways it goes wrong:
 *
 *  - **Handles, not ids.** `play` returns 0 on refusal -- an unknown id, the
 *    effect budget, `cullDistance` -- and a driver that recorded *ids* could not
 *    tell "asked for, did not start" from "started", so a fire refused once
 *    would be a cold campfire for the rest of the session.
 *  - **Ask `isLive` every frame.** A full instance pool does not refuse, it
 *    *evicts* the lowest-priority furthest instance and bumps that slot's
 *    generation, so every handle to it goes stale where it sits. A fire is
 *    `priority: 1` and therefore among the first things to go.
 *  - **The stop is owed.** `fire_camp` has `durationTicks: 0`, so nothing stops
 *    it: one left running when its ground is forgotten holds an instance slot
 *    for the session. {@link step} takes the whole list every frame and stops
 *    what is no longer in it, which is what makes that a reconciliation rather
 *    than something a caller has to remember.
 *
 * Impure only in that it remembers: no three.js and no DOM, so it is driven end
 * to end in Node against a recording {@link VfxPlayer}.
 */

/**
 * How much of a fixture's footprint the fire is drawn at.
 *
 * Inside the stones rather than across them: the ring is what a campfire's
 * collider is measured to, so paint at the full footprint is a fire standing on
 * its own kerb.
 */
export const FIRE_SCALE = 0.72;

/** What a fixture burns with: the effect, how wide, and how far up it (spec 263). */
export interface FixtureFire {
  readonly id: string;
  /**
   * The fire's width, as a fraction of what the fixture blocks.
   *
   * Relative rather than a length, so a prop placed at twice the size burns
   * twice as wide -- `footprint` is already the row's base times the prop's own
   * scale.
   */
  readonly scale: number;
  /**
   * Where the flame's root sits, as a fraction of the height its own light hangs
   * at.
   *
   * A fraction of {@link FireSite.lightY} rather than a world number, for two
   * reasons. It scales with the prop for free, since that height already does --
   * a torch placed at twice the size burns out of its own bowl rather than out
   * of the middle of its shaft. And it ties the flame to the light with **one**
   * number instead of two constants in two files, which is the mistake
   * `props.ts` names beside `LAMP_HEAD_HEIGHT` and cannot otherwise defend
   * against: a lamp whose flame is not inside its own lantern is the sort of
   * thing nobody would think to go looking for.
   *
   * At most 1, always: a light hangs *in* a flame, so a root above it is a fire
   * burning off the top of its own fixture.
   */
  readonly root: number;
}

/**
 * Which effect each fixture kind burns with, or nothing.
 *
 * A lamp post has no row and is right not to: what is inside its lantern is a
 * mantle, which is a made thing that glows steadily, and it says so by emitting
 * its own light's colour (spec 263) rather than by throwing marks.
 */
export const FIXTURE_ART: Readonly<Partial<Record<FixtureKind, FixtureFire>>> = {
  // On the ground, inside the ring of stones. `root: 0` is what it has always
  // played at -- a campfire's flame is born on the logs.
  campfire: { id: 'fire_camp', scale: FIRE_SCALE, root: 0 },
  // In the bowl. The light hangs at the middle of the flame, so its root is just
  // under it -- and `footprint` here is the *pole's* collider, which is narrower
  // than the head it holds up, so the fire is drawn a little wider than the
  // thing a body cannot walk through.
  'torch-stand': { id: 'fire_torch', scale: 1.15, root: 0.93 },
};

/** A fixture standing on ground the client is drawing, as this driver reads one. */
export interface FireSite {
  /** The region light's key: stable for as long as this is the same fixture. */
  readonly key: string;
  readonly kind: FixtureKind;
  readonly x: number;
  /** The **ground**, not the flame: a campfire is born on the logs. */
  readonly groundY: number;
  /**
   * Where this fixture's light hangs -- the ground plus its row's height, scaled
   * by the prop's own scale, which is what `RegionLight.y` already is.
   *
   * A flame's root is measured against it rather than against the ground: see
   * {@link FixtureFire.root}.
   */
  readonly lightY: number;
  readonly z: number;
  /** What the fixture blocks, which is what its paint is sized by. */
  readonly footprint: number;
}

export class FireVfx {
  /** Site key -> the handle that stops it. */
  private readonly burning = new Map<string, number>();

  constructor(private readonly player: VfxPlayer) {}

  /**
   * Bring every fire up to date, from the whole list of sites.
   *
   * Reconciled rather than told: a fixture leaves this list because the region
   * it stands in stopped being drawn, and there is no event for that -- spec 215
   * made a region's residency a question about the *ground under it*, so the
   * honest way to ask whether a fire should still be burning is to look for it
   * in the list of fixtures still on screen.
   *
   * Idempotent: the same sites on the next frame start nothing and stop nothing.
   */
  step(sites: readonly FireSite[]): void {
    const seen = new Set<string>();
    for (const site of sites) {
      const art = FIXTURE_ART[site.kind];
      if (art === undefined) continue;
      seen.add(site.key);
      const handle = this.burning.get(site.key) ?? 0;
      // Evicted out from under us, or refused when it was last asked for. Either
      // way nothing is burning, so ask again -- which may well be refused again
      // while the pressure lasts, and should be.
      if (handle !== 0 && this.player.isLive(handle)) continue;
      this.burning.set(site.key, this.start(art, site));
    }

    for (const [key, handle] of this.burning) {
      if (seen.has(key)) continue;
      if (handle !== 0) this.player.stop(handle);
      this.burning.delete(key);
    }
  }

  /** Stop everything. For a scene teardown, where there is no next frame. */
  forgetAll(): void {
    for (const handle of this.burning.values()) {
      if (handle !== 0) this.player.stop(handle);
    }
    this.burning.clear();
  }

  /** Fires currently held, for the probe's readout and for tests. */
  keys(): readonly string[] {
    return [...this.burning.keys()];
  }

  private start(art: FixtureFire, site: FireSite): number {
    if (!this.player.has(art.id)) return 0;
    return this.player.play(art.id, {
      x: site.x,
      // The root, up from the ground toward the light hung in the flame: the
      // logs for a campfire, the bowl for a torch. Interpolated rather than
      // added, so a fixture on a slope burns at its own base rather than at a
      // height measured from nothing.
      y: site.groundY + (site.lightY - site.groundY) * art.root,
      z: site.z,
      // Hashed off *where it is* rather than drawn, so two clients watching one
      // campfire watch the same fire and a reload does not reshuffle it. The
      // same rule every other seeded thing in this directory follows.
      seed: seedFor(Math.round(site.x), site.kind, Math.round(site.z)),
      scale: site.footprint * art.scale,
    });
  }
}
