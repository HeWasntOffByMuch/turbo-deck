import * as THREE from 'three';
import { pointIntensity } from './player-lights.js';
import {
  assignLights,
  type LightFocus,
  type LightLimits,
  type LightRequest,
} from './light-residency.js';

/**
 * The lights standing in the world (spec 250).
 *
 * The three.js half of `light-residency.ts`. That module decides *which* lights
 * are lit; this one owns the `PointLight`s they are lit with, and the one rule
 * that makes a village affordable: **nothing here casts a shadow, and the number
 * of lights never changes.**
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
 * `castShadow` is `false` on every slot, written once at construction and never
 * touched -- it is part of that same program key, so a light that sometimes cast
 * would be the recompile this pool exists to prevent.
 *
 * ## There are no shadows here any more
 *
 * There were. A fixture's cube map was baked on the frame the light was assigned
 * a slot and never again (`shadow.autoUpdate` off, `needsUpdate` set once), which
 * made a casting fixture cost a `samplerCube` and one lookup per lit fragment
 * and nothing per frame -- measured flat in the probe with four of them lit. It
 * was not a budget problem and it is not gone for one.
 *
 * It is gone because of what it looked like: a point light a body's height off
 * the ground throws every trunk, post and body near it outward in a hard radial
 * fan, and four fixtures in a square throw four of those across each other.
 *
 * What went with it -- the casting prefix, the cube setup, the one-bake-a-frame
 * queue, the revision stamp that re-took a map when its ground streamed in late,
 * and the mask that kept moving bodies out of a frozen one -- is written down
 * here rather than left in place, because a socket with nothing plugged into it
 * is the thing this repo keeps rediscovering a hundred specs later. Putting it
 * back is one revert.
 */

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
  readonly activateRadius: number;
  readonly releaseRadius: number;
  readonly swapMargin: number;
}

/**
 * The pool's size.
 *
 * Six, and every one of them is the same slot -- there was a casting prefix and
 * two sub-pools to keep a shadowless light out of it, and with nothing casting
 * there is nothing to keep anything out of.
 *
 * What sets the number is that a slot costs a shader program's worth of ALU per
 * lit fragment whether or not anything is assigned to it, at the low internal
 * resolution the retro pass draws at. Six covers a village square -- the four
 * fixtures `light-the-square.ts` places, plus the bodies near you carrying a
 * conjured light -- with room to spare, and a request that cannot get a slot
 * goes dark rather than costing anything.
 */
export const WORLD_LIGHT_DEFAULTS: WorldLightsOptions = {
  slots: 6,
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
  key: string | null;
}


export class WorldLights {
  private readonly slots: Slot[] = [];
  private readonly limits: LightLimits;
  /** Scratch, so a frame of walking past a village allocates nothing. */
  private held: (string | null)[];

  constructor(
    private readonly scene: THREE.Scene,
    options: WorldLightsOptions = WORLD_LIGHT_DEFAULTS,
  ) {
    this.limits = {
      slots: options.slots,
      activateRadius: options.activateRadius,
      releaseRadius: options.releaseRadius,
      swapMargin: options.swapMargin,
    };
    for (let i = 0; i < options.slots; i++) {
      const light = new THREE.PointLight(0xffffff, 0, IDLE_RADIUS);
      // Written once, and false. See the header: a slot that changed its mind
      // about casting would be the recompile this whole pool exists to prevent.
      light.castShadow = false;
      // Added once and never removed, and never hidden: see the header.
      this.scene.add(light);
      this.slots.push({ light, key: null });
    }
    this.held = this.slots.map(() => null);
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

      slot.key = key;
      this.held[i] = key;
      const light = slot.light;
      light.color.setHex(request.color);
      light.distance = request.radius;
      light.intensity = pointIntensity(request.brightness, request.radius);
      light.position.set(request.x, request.y, request.z);
    }
  }

  /**
   * Put a slot to sleep without taking it off the scene.
   *
   * The one thing it must not do is become invisible. See the header: an
   * invisible light is not collected, and the count is part of the program key.
   */
  private park(slot: Slot): void {
    slot.key = null;
    slot.light.intensity = 0;
    slot.light.distance = IDLE_RADIUS;
  }

  /** What each slot is holding. For the probe's readout and for tests. */
  heldKeys(): readonly (string | null)[] {
    return this.slots.map((slot) => slot.key);
  }

  dispose(): void {
    for (const slot of this.slots) {
      this.scene.remove(slot.light);
      slot.light.dispose();
    }
    this.slots.length = 0;
  }
}
