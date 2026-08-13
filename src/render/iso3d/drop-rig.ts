/**
 * An item lying in the grass (spec 156).
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

/** How big the object itself is drawn, in world units. */
const ITEM_SIZE = 7;
/** The halo's radius at `flare` 0 and at 1. */
const HALO_MIN = 9;
const HALO_MAX = 26;
/** How high off the ground the object floats, and how far it bobs. */
const FLOAT_HEIGHT = 9;
const BOB = 2.2;
/** Radians per second the object turns on the spot. */
const SPIN_RATE = 1.1;

export class DropRig {
  readonly group = new THREE.Group();
  private readonly item: THREE.Mesh;
  private readonly halo: THREE.Mesh;
  private readonly ring: THREE.Mesh;
  private readonly itemMaterial: THREE.MeshStandardMaterial;
  private readonly haloMaterial: THREE.MeshBasicMaterial;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private phase = 0;
  private hovered = false;

  constructor(rarity: RarityId) {
    const color = TIER_COLOR[rarity] ?? TIER_COLOR.common;

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

    this.group.add(this.item, this.halo, this.ring);
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

  update(dt: number, flare: number): void {
    this.phase += dt;
    const lit = Math.max(0, Math.min(1, flare));

    this.item.rotation.y += SPIN_RATE * dt;
    this.item.position.y = FLOAT_HEIGHT + Math.sin(this.phase * 1.7) * BOB;
    this.itemMaterial.emissiveIntensity = 0.25 + lit * 1.2;

    const radius = HALO_MIN + (HALO_MAX - HALO_MIN) * lit;
    this.halo.scale.setScalar(radius);
    this.halo.position.y = this.item.position.y;
    // Squared, so the halo fades out fast rather than leaving a permanent glow
    // over a potion: at the common tier's 0.12 this is 0.003, which is nothing.
    this.haloMaterial.opacity = 0.22 * lit * lit;

    this.ring.scale.setScalar((0.9 + lit * 0.6) * (this.hovered ? 1.15 : 1));
    this.ringMaterial.opacity = (0.18 + lit * 0.35) * (this.hovered ? 1.8 : 1);
  }

  dispose(): void {
    this.item.geometry.dispose();
    this.halo.geometry.dispose();
    this.ring.geometry.dispose();
    this.itemMaterial.dispose();
    this.haloMaterial.dispose();
    this.ringMaterial.dispose();
  }
}
