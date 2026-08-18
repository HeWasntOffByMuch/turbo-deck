/**
 * Whether the shadow map has to be drawn again (spec 165 follow-up 10).
 *
 * `shadowMap.autoUpdate` has been false since spec 045 and `needsUpdate` was set
 * unconditionally once a frame -- so every light's map was redrawn every frame
 * over a world that mostly does not move. Measured: **335 of the frame's 625
 * draw calls**, more than half, with the day/night cycle off by default and the
 * sun therefore not moving at all.
 *
 * The instinct is "rebuild when the sun moves", and it is not enough. Four
 * things invalidate a shadow map and only one of them is the sun:
 *
 *  - the **light's direction**, which the day/night cycle and the sun sliders move;
 *  - the **shadow camera's frustum**, which follows the player -- `applySun`
 *    copies the view target into the light every frame, so walking moves the
 *    volume the map covers even under a fixed sun, and the zoom moves its radius;
 *  - the **casters**, which are the terrain, the props *and every body*: rigs set
 *    `castShadow` on their nodes, so a monster walking past changes the map with
 *    nothing else having changed at all;
 *  - the **set of lights that cast**, since `needsUpdate` is renderer-wide and a
 *    torch switched on has no map until something asks for one.
 *
 * Miss any of the four and the failure is a shadow that stays where the thing
 * that cast it used to be. So this compares all four against the state the map
 * was last *built* from, and asks for a rebuild when any has moved.
 *
 * The one thing it does **not** see is a body animating **in place**: a rig
 * playing an idle clip moves its own limbs without moving its group, and there
 * is no cheap number standing for "what pose is this rig in" to fold into the
 * signature. So that is the stated trade rather than a lossless win -- at this
 * camera, under `BasicShadowMap`, an idle body's shadow is a few units of hard
 * edge that stops breathing until the body turns or steps. Everything else here
 * is lossless: the frames it skips are frames in which the existing map is
 * already the correct answer.
 *
 * Pure: numbers in, a boolean out, no clock and no three.js.
 */

export interface ShadowInputs {
  /** The light's unit direction. */
  readonly sunX: number;
  readonly sunY: number;
  readonly sunZ: number;
  /** Where the shadow camera is centred -- the view target, which follows the player. */
  readonly targetX: number;
  readonly targetZ: number;
  /** The shadow frustum's half-extent, which the zoom moves. */
  readonly radius: number;
  /** Bumped when shadow-casting geometry is added, rebuilt, hidden or shown. */
  readonly geometry: number;
  /** A signature over every moving caster's placement. See {@link MoverTally}. */
  readonly movers: number;
}

/**
 * How far the light's direction or the shadow centre may drift before the map is
 * considered stale.
 *
 * Small enough to be invisible and large enough to absorb float noise: the
 * target is written from an eased camera follow, so it creeps in the last
 * decimal place for a long time after the player has stopped, and a bare
 * inequality would call that a change and rebuild every frame -- which is the
 * behaviour this replaces.
 */
const POSITION_EPSILON = 0.25;
const DIRECTION_EPSILON = 1e-4;

/**
 * The quantum a mover's placement is rounded to before it is counted.
 *
 * Same argument as the epsilons, for the same reason: an interpolated body's
 * coordinates change in the last decimal on every frame it is drawn, and a
 * signature that noticed would never let a single rebuild be skipped. A quarter
 * of a world unit is far below anything a hard-edged shadow shows and far above
 * the noise.
 */
const MOVER_QUANTUM = 4;
/** Radians, at the same order: about a third of a degree. */
const YAW_QUANTUM = 180;

/**
 * One number standing for where every moving caster is and which way it faces.
 *
 * An accumulator rather than a function over a collection, because it is called
 * from inside the body loop that already has these numbers -- a second pass
 * would either walk the rigs again or allocate a sample object per body per
 * frame, and this is running underneath a draw-call count.
 *
 * Yaw is in it because a body turning on the spot moves its shadow without
 * moving its position, and turning on the spot is what a player does most.
 *
 * A sum rather than a hash: the cost of a collision here is one stale frame
 * rather than a wrong picture, and the cheaper this is the less it argues with
 * what it saves.
 */
export class MoverTally {
  private sum = 0;
  private count = 0;

  /** Start a frame's tally. */
  reset(): void {
    this.sum = 0;
    this.count = 0;
  }

  /**
   * Count one caster, at the place and the size it is actually drawn.
   *
   * `scale` is in it because a body dying is squashed to 0.6 without moving an
   * inch, and a corpse casting a standing figure's shadow is exactly the kind of
   * thing a skipped rebuild is accused of.
   */
  add(x: number, y: number, z: number, yaw: number, scale = 1): void {
    this.count++;
    this.sum +=
      Math.round(x * MOVER_QUANTUM) * 7919 +
      Math.round(y * MOVER_QUANTUM) * 104729 +
      Math.round(z * MOVER_QUANTUM) * 1299709 +
      Math.round(yaw * YAW_QUANTUM) * 15485863 +
      Math.round(scale * 64) * 122949829;
  }

  /**
   * The frame's signature.
   *
   * The count is folded in here rather than left implicit: a body that leaves
   * the world changes the map even when every body that remains has stood still.
   */
  get signature(): number {
    return this.sum + this.count * 32452843;
  }
}

export class ShadowRefresh {
  private built: ShadowInputs | null = null;
  private rebuilds = 0;
  private frames = 0;

  /**
   * Whether to draw the shadow maps this frame, and remember the answer.
   *
   * The comparison is against what the maps were last *built* from rather than
   * against the previous frame, so a drift smaller than an epsilon still
   * eventually triggers instead of creeping past unnoticed one frame at a time.
   */
  needed(inputs: ShadowInputs): boolean {
    this.frames++;
    const built = this.built;
    if (built !== null && !changed(built, inputs)) return false;
    this.built = inputs;
    this.rebuilds++;
    return true;
  }

  /** Rebuilds and frames since the session began. For the readout. */
  get stats(): { rebuilds: number; frames: number } {
    return { rebuilds: this.rebuilds, frames: this.frames };
  }
}

function changed(a: ShadowInputs, b: ShadowInputs): boolean {
  if (a.geometry !== b.geometry || a.movers !== b.movers) return true;
  if (Math.abs(a.radius - b.radius) > POSITION_EPSILON) return true;
  if (Math.abs(a.targetX - b.targetX) > POSITION_EPSILON) return true;
  if (Math.abs(a.targetZ - b.targetZ) > POSITION_EPSILON) return true;
  return (
    Math.abs(a.sunX - b.sunX) > DIRECTION_EPSILON ||
    Math.abs(a.sunY - b.sunY) > DIRECTION_EPSILON ||
    Math.abs(a.sunZ - b.sunZ) > DIRECTION_EPSILON
  );
}
