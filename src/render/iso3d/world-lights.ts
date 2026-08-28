import * as THREE from 'three';
import { pointIntensity } from './player-lights.js';
import {
  assignLights,
  type LightFocus,
  type LightLimits,
  type LightRequest,
} from './light-residency.js';

/**
 * The lights standing in the world, and the shadow maps they build once
 * (spec 248).
 *
 * The three.js half of `light-residency.ts`. That module decides *which* lights
 * are lit; this one owns the `PointLight`s they are lit with, and the one rule
 * that makes a village affordable: **a fixture's shadow map is rendered on the
 * frame it is assigned and never again.**
 *
 * ## Why the pool is fixed
 *
 * three collects lights in `projectObject`, which returns early on
 * `object.visible === false` -- so a light that is hidden is a light that is not
 * counted, and the count is part of the program key. "Add a `PointLight` per
 * fixture in range" therefore recompiles **every material in the scene** as the
 * player walks past a campfire, which is a hitch rather than a slowdown and is
 * far worse than the thing it was trying to save.
 *
 * So the pool is allocated once and never grows, never shrinks and is never
 * hidden. An unassigned slot sits at intensity 0 with a small reach: a few ALU
 * per fragment at the low internal resolution the retro pass draws at, which is
 * what a constant shader program costs.
 *
 * For the same reason `castShadow` is written **once per slot, at construction**.
 * The pool's first {@link WorldLightsOptions.shadowSlots} lights cast and the
 * rest never do, which is why `light-residency.ts` has two sub-pools rather than
 * a flag on a request.
 *
 * ## Why the shadow maps are built once
 *
 * A shadow-casting point light re-renders the scene into six cube faces every
 * frame. three exposes the fix and this scene already drives shadows by hand
 * (`renderer.shadowMap.autoUpdate = false` since spec 045): `shadow.autoUpdate`
 * off and `shadow.needsUpdate` set exactly once means `WebGLShadowMap` renders
 * the map on the next shadow pass and clears the flag itself. After that the
 * light costs one cube lookup per fragment and no draw calls at all, forever.
 *
 * Three obligations come with freezing a map, and each is a bug the moment it is
 * skipped:
 *
 *  - **Nothing that moves may be in it.** A body baked into a cube map is a
 *    silhouette painted on the ground that stays there once the body has walked
 *    off. {@link bakingThisFrame} is what the scene asks so it can mask the
 *    bodies out for that one frame, the way `player-lighting.ts` already masks
 *    the player permanently.
 *  - **The ground can arrive after the light.** Terrain and props stream, so a
 *    map baked over ground that had not landed is a light shining on nothing.
 *    A request carries a `revision` -- spec 208's churn counter -- and a slot
 *    whose revision has moved bakes again.
 *  - **It is amortised.** At most one light bakes per frame, so walking into a
 *    village is three frames each carrying one cube render rather than one frame
 *    carrying three.
 */

/** How big a fixture's cube map is, per face. */
const FIXTURE_SHADOW_MAP_SIZE = 256;
/** How close to the flame the shadow camera starts. */
const FIXTURE_SHADOW_NEAR = 8;
/**
 * Pushed along the surface normal before the depth comparison.
 *
 * The torch's own number, and a little more of it, because these maps are half
 * its resolution: acne is a function of how much world one shadow texel covers,
 * so halving the map doubles what the bias has to cover.
 */
const FIXTURE_SHADOW_NORMAL_BIAS = 4;

/**
 * What an idle slot's reach is set to.
 *
 * Not zero. three divides by `distance` in its own falloff window, and a light
 * at intensity 0 contributes nothing whatever this is -- but a `distance` of 0
 * means *no* window at all in three's point light, which is the one value that
 * makes an idle slot reach the whole world before its zero intensity is applied.
 * Small and finite says what is meant.
 */
const IDLE_RADIUS = 1;

export interface WorldLightsOptions {
  readonly slots: number;
  readonly shadowSlots: number;
  readonly activateRadius: number;
  readonly releaseRadius: number;
  readonly swapMargin: number;
}

/**
 * The pool's size.
 *
 * Six lights, two of which cast. Both numbers are a budget rather than a
 * measurement, and the shape of the budget is what matters: the casting pair is
 * the expensive half (a cube map each, and a bake whenever one changes hands),
 * and the plain four are nearly free, so the split is deliberately lopsided
 * toward *more places lit* over *more places casting*.
 *
 * With the sun and the panel torch that is four point-shadow samplers and one
 * directional in the fragment shader, which is inside what WebGL2 guarantees.
 */
export const WORLD_LIGHT_DEFAULTS: WorldLightsOptions = {
  slots: 6,
  shadowSlots: 2,
  /**
   * Nothing further than this is lit.
   *
   * Wider than the camera frames at the default zoom, because a light *outside*
   * the frame still lights what is inside it -- a campfire just off screen
   * throws its glow onto the ground you are standing on, and culling it at the
   * frame's edge would make the world brighten as you walked toward things.
   */
  activateRadius: 1600,
  /** See `light-residency.ts`: the band between the two is what stops thrash. */
  releaseRadius: 2100,
  swapMargin: 250,
};

/** One slot, and what it is holding. */
interface Slot {
  readonly light: THREE.PointLight;
  readonly casts: boolean;
  key: string | null;
  /** The revision the map in this slot was baked against, or -1 for never. */
  bakedRevision: number;
}

export class WorldLights {
  private readonly slots: Slot[] = [];
  private readonly limits: LightLimits;
  /** Scratch, so a frame of walking past a village allocates nothing. */
  private held: (string | null)[];
  private baking = false;

  constructor(
    private readonly scene: THREE.Scene,
    options: WorldLightsOptions = WORLD_LIGHT_DEFAULTS,
  ) {
    this.limits = {
      slots: options.slots,
      shadowSlots: options.shadowSlots,
      activateRadius: options.activateRadius,
      releaseRadius: options.releaseRadius,
      swapMargin: options.swapMargin,
    };
    for (let i = 0; i < options.slots; i++) {
      const casts = i < options.shadowSlots;
      const light = new THREE.PointLight(0xffffff, 0, IDLE_RADIUS);
      light.castShadow = casts;
      if (casts) {
        light.shadow.mapSize.set(FIXTURE_SHADOW_MAP_SIZE, FIXTURE_SHADOW_MAP_SIZE);
        light.shadow.camera.near = FIXTURE_SHADOW_NEAR;
        light.shadow.normalBias = FIXTURE_SHADOW_NORMAL_BIAS;
        // The whole point. three renders this map only when it is asked to.
        light.shadow.autoUpdate = false;
      }
      // Added once and never removed, and never hidden: see the header.
      this.scene.add(light);
      this.slots.push({ light, casts, key: null, bakedRevision: -1 });
    }
    this.held = this.slots.map(() => null);
  }

  /**
   * Whether a shadow map is being rendered on this frame.
   *
   * Asked by the scene so it can keep the bodies out of it. True only for the
   * frame the bake actually happens on, because three clears `needsUpdate`
   * itself once the map is drawn.
   */
  bakingThisFrame(): boolean {
    return this.baking;
  }

  /**
   * Bring the pool up to date for this frame's lights and camera.
   *
   * `requests` is everything that would like to be lit -- the fixtures on held
   * ground, plus any conjured light on a body -- and may be as long as the map
   * is; what it costs is one distance per entry and a sort.
   */
  update(requests: readonly LightRequest[], focus: LightFocus): void {
    const next = assignLights(requests, this.held, focus, this.limits);
    const byKey = new Map(requests.map((request) => [request.key, request]));

    // One bake a frame, and the *first* slot that needs one -- so a village
    // arriving all at once resolves over as many frames as it has fixtures
    // rather than in one frame that drops.
    let baked = false;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot) continue;
      const key = next[i] ?? null;
      const request = key === null ? undefined : byKey.get(key);
      if (!request) {
        this.park(slot);
        this.held[i] = null;
        continue;
      }

      const changed = slot.key !== key;
      slot.key = key;
      this.held[i] = key;
      const light = slot.light;
      light.color.setHex(request.color);
      light.distance = request.radius;
      light.intensity = pointIntensity(request.brightness, request.radius);
      light.position.set(request.x, request.y, request.z);

      if (!slot.casts) continue;
      // Re-baked when this slot changed hands, and when the ground under it has
      // moved since -- which is a chunk arriving or being forgotten, and nothing
      // else. In a settled world neither happens and this costs a comparison.
      const stale = changed || slot.bakedRevision !== request.revision;
      if (!stale || baked) continue;
      light.shadow.camera.far = Math.max(FIXTURE_SHADOW_NEAR + 1, request.radius);
      light.shadow.camera.updateProjectionMatrix();
      light.shadow.needsUpdate = true;
      slot.bakedRevision = request.revision;
      baked = true;
    }
    this.baking = baked;
  }

  /**
   * Put a slot to sleep without taking it off the scene.
   *
   * The one thing it must not do is become invisible. Its shadow map is left
   * exactly where it is: at intensity 0 nothing samples it, and disposing it
   * would mean re-allocating a render target the next time this slot is used.
   */
  private park(slot: Slot): void {
    slot.key = null;
    slot.bakedRevision = -1;
    slot.light.intensity = 0;
    slot.light.distance = IDLE_RADIUS;
  }

  /** What each slot is holding. For the probe's readout and for tests. */
  heldKeys(): readonly (string | null)[] {
    return this.slots.map((slot) => slot.key);
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.light.shadow.dispose();
      this.scene.remove(slot.light);
      slot.light.dispose();
    }
    this.slots.length = 0;
  }
}
