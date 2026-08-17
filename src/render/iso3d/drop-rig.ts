/**
 * An item lying in the grass (spec 158).
 *
 * Beside `rigs.ts`, `critter.ts` and `weapon-rig.ts` rather than in `world/`,
 * because it is what those are: three.js meshes with an `update`. Everything
 * `world/` decides about a drop -- when, how bright, what the label says -- is
 * pure and lives in `world/loot-drop.ts`, and the blanket lint rule on that
 * directory's tests is the mechanical statement of the same split.
 *
 * Three pieces and no more: the object itself, a halo that grows and brightens
 * with the flare, and a ring on the ground under it. What the halo does is the
 * whole of the "subtle rarity effect develops" step -- there are no particles,
 * no beam, no banner, and `docs/reward-philosophy.md` §10 is the reason rather
 * than the budget.
 *
 * It knows nothing about ticks. `setFlare` takes the number
 * `loot-drop.ts` computed and turns it into a size and a brightness, so every
 * decision about *when* lives in the pure module and every decision about
 * *what it looks like* lives here.
 */

import * as THREE from 'three';
import type { RarityId } from '../../server/data/items.js';
import type { Pop } from './world/loot-drop.js';

/**
 * A tier's colour, here rather than in `data/loot.ts`.
 *
 * A colour is presentation and the content table is read by the server, which
 * must never learn what a drop looks like. The tiers read cool-to-warm and
 * lift in value with the tier, so which one something is survives the retro
 * pass quantizing every channel to a handful of steps.
 */
const TIER_COLOR: Record<RarityId, number> = {
  common: 0xb9c2cc,
  rare: 0x6fb4ff,
  exceptional: 0xffc861,
};

/**
 * What an unrevealed drop is drawn in (spec 158).
 *
 * **Common's own colour, deliberately.** An item whose tier has not resolved
 * looks exactly like ordinary loot, so the swell and the pulse are the only
 * things saying otherwise -- you can tell something is up, not what. Anything
 * else here would be a fourth colour meaning "unknown", which is a label, and
 * the whole point is not to put one on it yet.
 */
const NEUTRAL_COLOR = TIER_COLOR.common;

/** How big the object itself is drawn, in world units. */
const ITEM_SIZE = 7;
/** The halo's radius at `flare` 0 and at 1. */
const HALO_MIN = 8;
const HALO_MAX = 17;
/**
 * The outer shell's radius, as a multiple of the inner one, and how much of the
 * inner one's opacity it carries.
 *
 * Two shells rather than one, because a `MeshBasicMaterial` sphere is *flat* --
 * it has no falloff, so a single one reads as a disc of paint over the object
 * rather than as light around it. Two nested at different opacities is the
 * cheapest thing that reads as a gradient, and costs one more draw of twelve
 * triangles. A real radial falloff wants a sprite and a texture, which is a
 * bigger change than this is worth until something else needs one.
 */
const HALO_OUTER = 1.7;
const HALO_OUTER_ALPHA = 0.4;
/** How high off the ground the object floats, and how far it bobs. */
const FLOAT_HEIGHT = 9;
const BOB = 2.2;
/** Radians per second the object turns on the spot. */
const SPIN_RATE = 1.1;
/**
 * How far a full beat lifts the object, per unit of scale bump.
 *
 * The bounce and the swell are one movement rather than two effects: a heart
 * that grew without moving reads as inflating, and one that hopped without
 * growing reads as being nudged.
 */
const BEAT_LIFT = 55;

export class DropRig {
  readonly group = new THREE.Group();
  private readonly item: THREE.Mesh;
  private readonly halo: THREE.Mesh;
  private readonly haloOuter: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly itemMaterial: THREE.MeshStandardMaterial;
  private readonly haloMaterial: THREE.MeshBasicMaterial;
  private readonly haloOuterMaterial: THREE.MeshBasicMaterial;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly neutral = new THREE.Color(NEUTRAL_COLOR);
  private readonly tier: THREE.Color;
  private phase = 0;
  private hovered = false;
  private pop: Pop = { scale: 1, alpha: 1 };
  /** Last mix written, so three colours are not rebuilt on a frame that is flat. */
  private mixed = -1;

  constructor(rarity: RarityId) {
    this.tier = new THREE.Color(TIER_COLOR[rarity] ?? TIER_COLOR.common);
    // Built neutral. The tier arrives at the reveal and not one frame before it.
    const color = NEUTRAL_COLOR;

    this.itemMaterial = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.4,
      roughness: 0.35,
      metalness: 0.1,
    });
    // An octahedron, because the one thing this shape must not do is look like a
    // specific item: what the item *is* is the thing being withheld, and a mesh
    // that spoiled it would make the whole reveal decorative.
    this.item = new THREE.Mesh(new THREE.OctahedronGeometry(ITEM_SIZE), this.itemMaterial);
    this.item.position.y = FLOAT_HEIGHT;

    // Additive and depth-write-off, so it reads as light rather than as a
    // sphere of fog around the object.
    this.haloMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.25,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.halo = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), this.haloMaterial);
    this.halo.position.y = FLOAT_HEIGHT;

    this.haloOuterMaterial = this.haloMaterial.clone();
    this.haloOuter = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), this.haloOuterMaterial);
    this.haloOuter.position.y = FLOAT_HEIGHT;

    this.ringMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // Flat on the ground and lifted a hair, which is all a small disc needs --
    // spec 153's ground-following machinery is for indicators tens of units
    // across, and this one is barely wider than the body it sits under.
    this.ring = new THREE.Mesh(new THREE.RingGeometry(HALO_MIN * 0.8, HALO_MIN, 20), this.ringMaterial);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.6;

    this.group.add(this.item, this.halo, this.haloOuter, this.ring);
  }

  /**
   * One frame.
   *
   * `flare` is presentation state from `loot-drop.ts`; `dt` only turns the
   * object and bobs it, which is idle motion and is deliberately *not* part of
   * the reveal -- a drop that stopped spinning when it revealed would read as
   * having broken.
   */
  /**
   * Whether the cursor is on it.
   *
   * The whole hover response is the ground ring, brighter and a touch wider --
   * a drop already glows on its own, and lighting the object as well would make
   * the hover indistinguishable from the reveal it is sitting in the middle of.
   * Set here and read on the next `update`, exactly as a body's highlight is.
   */
  setHovered(on: boolean): void {
    this.hovered = on;
  }

  /**
   * How far the tier's colour has arrived, 0..1 (spec 158).
   *
   * Three materials lerped from the neutral rather than swapped, because this is
   * the moment the feature exists for and a hard swap reads as a glitch. Skipped
   * when the mix has not moved, which is every frame outside the blend.
   */
  setTierMix(mix: number): void {
    const clamped = Math.max(0, Math.min(1, mix));
    if (clamped === this.mixed) return;
    this.mixed = clamped;
    const blended = this.neutral.clone().lerp(this.tier, clamped);
    this.itemMaterial.color.copy(blended);
    this.itemMaterial.emissive.copy(blended);
    this.haloMaterial.color.copy(blended);
    this.haloOuterMaterial.color.copy(blended);
    this.ringMaterial.color.copy(blended);
  }

  /**
   * One frame.
   *
   * `beat` is the heartbeat multiplier from `loot-drop.ts` -- exactly 1 for a
   * tier without one, so a common drop needs no branch to stay still. It scales
   * the object *and* lifts it, because a pulse that only grew would read as
   * breathing rather than as a beat.
   */
  /**
   * How far through its pop this drop is, once it has been taken (spec 158).
   *
   * The rig is kept alive for a fraction of a second after the entity has gone
   * so this can play -- see `syncDrops`. Everything it draws is scaled and faded
   * together, because the object leaving is one movement rather than three.
   */
  setPop(pop: Pop): void {
    this.pop = pop;
  }

  update(dt: number, flare: number, beat = 1): void {
    this.phase += dt;
    const lit = Math.max(0, Math.min(1, flare));
    const pulse = Math.max(0, beat);

    this.item.rotation.y += SPIN_RATE * dt;
    this.item.position.y = FLOAT_HEIGHT + Math.sin(this.phase * 1.7) * BOB + (pulse - 1) * BEAT_LIFT;
    this.item.scale.setScalar(pulse);
    this.itemMaterial.emissiveIntensity = 0.25 + lit * 1.2;

    const radius = HALO_MIN + (HALO_MAX - HALO_MIN) * lit;
    this.halo.scale.setScalar(radius * pulse);
    this.halo.position.y = this.item.position.y;
    // Squared, so the halo fades out fast rather than leaving a permanent glow
    // over a potion: at the common tier's 0.12 this is 0.003, which is nothing.
    const alpha = 0.22 * lit * lit;
    this.haloMaterial.opacity = alpha;
    this.haloOuter.scale.setScalar(radius * pulse * HALO_OUTER);
    this.haloOuter.position.y = this.item.position.y;
    this.haloOuterMaterial.opacity = alpha * HALO_OUTER_ALPHA;

    this.ring.scale.setScalar((0.9 + lit * 0.6) * (this.hovered ? 1.15 : 1));
    this.ringMaterial.opacity = (0.18 + lit * 0.35) * (this.hovered ? 1.8 : 1);

    // The pop, applied last so it multiplies everything above rather than
    // competing with it. The object's own material is opaque and has to be made
    // transparent to fade at all -- done here rather than at construction so a
    // drop that is merely lying there pays nothing for a blend mode.
    const pop = this.pop;
    this.group.scale.setScalar(pop.scale);
    if (pop.alpha < 1) {
      this.itemMaterial.transparent = true;
      this.itemMaterial.opacity = pop.alpha;
      this.haloMaterial.opacity *= pop.alpha;
      this.haloOuterMaterial.opacity *= pop.alpha;
      this.ringMaterial.opacity *= pop.alpha;
    }
  }

  dispose(): void {
    this.item.geometry.dispose();
    this.halo.geometry.dispose();
    this.haloOuter.geometry.dispose();
    this.ring.geometry.dispose();
    this.itemMaterial.dispose();
    this.haloMaterial.dispose();
    this.haloOuterMaterial.dispose();
    this.ringMaterial.dispose();
  }
}
