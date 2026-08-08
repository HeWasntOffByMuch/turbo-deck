/**
 * The floating damage numbers, as a field of world points (spec 094).
 * Pure -- no three.js, no DOM.
 *
 * A number marks *where a blow landed*, and a place is a world point. It used
 * to be an entity id resolved to a screen pixel every frame, which got both
 * halves of that wrong: while the victim lived the number walked away with it,
 * and once the victim despawned there was no anchor left to resolve, so the
 * number simply held the last pixel it had been given -- and a pixel is fixed
 * to the glass, so the killing blow's number slid over the map with the camera.
 *
 * Here the world point is taken once, when the blow lands, and projected fresh
 * every frame. Nothing about the target is ever consulted again, which is what
 * makes a corpse's last number stay on the ground it fell on.
 *
 * The rise and the lane fan stay in CSS pixels deliberately: they are how the
 * number reads against the glass -- big enough to separate, small enough not to
 * drift off its mark -- and not part of where it happened.
 *
 * `hud.ts` owns the elements and nothing else; every judgement about lifetime,
 * lanes, fade and placement lives here, where a test can reach it.
 */

/** A point in the world a number is nailed to: ground x/z, plus a height. */
export interface WorldAnchor {
  readonly x: number;
  readonly y: number;
  /** World units above the ground under `x, y`. */
  readonly lift: number;
}

/**
 * Projects a world point to a canvas pixel. `WorldScene.projectPoint` is the
 * one implementation; a test passes its own camera.
 */
export type Projector = (
  x: number,
  y: number,
  lift: number,
) => { readonly x: number; readonly y: number; readonly onScreen: boolean };

/** Where one number should be drawn this frame, in CSS pixels. */
export interface PopupPlacement {
  readonly id: number;
  readonly left: number;
  readonly top: number;
  readonly opacity: number;
  /** False when its world point is behind the camera or outside the frame. */
  readonly onScreen: boolean;
}

export interface PopupStep {
  readonly live: readonly PopupPlacement[];
  /** Ids whose element the caller should now delete. Reported exactly once. */
  readonly expired: readonly number[];
}

/** How long a damage number floats, in frames. */
export const NUMBER_LIFE = 48;

/** How far one rises over its life, in CSS pixels. */
export const NUMBER_RISE = 46;

/**
 * Sideways lanes for numbers landing on the same body in quick succession.
 *
 * Without this they stack on one anchor, and once each carries a hard outline
 * the pile reads as a solid dark block with a couple of legible digits at the
 * bottom -- which is exactly what it looked like. Cycling lanes fans them out so
 * three hits in half a second are three numbers.
 */
export const NUMBER_LANES: readonly { readonly x: number; readonly y: number }[] = [
  { x: 0, y: 0 },
  { x: -46, y: -12 },
  { x: 46, y: -12 },
  { x: -24, y: -26 },
  { x: 24, y: -26 },
];

/** A long fight should not grow the DOM without bound. */
const CAPACITY = 40;

interface Popup {
  readonly id: number;
  readonly group: number;
  readonly at: WorldAnchor;
  readonly offsetX: number;
  readonly offsetY: number;
  age: number;
}

export class DamagePopups {
  private readonly popups: Popup[] = [];
  /** How many numbers each group has been given, for lane assignment. */
  private readonly lanes = new Map<number, number>();
  private nextId = 1;

  /**
   * Spawn a number at a world point.
   *
   * `group` -- in practice the target's entity id -- only fans the lanes out.
   * It is never resolved to anything: the anchor is the whole of what the
   * popup knows about the world.
   *
   * Returns the id to hang an element on, plus any ids evicted to stay under
   * capacity, so the caller never orphans one.
   */
  add(group: number, at: WorldAnchor): { readonly id: number; readonly expired: readonly number[] } {
    const index = this.lanes.get(group) ?? 0;
    this.lanes.set(group, index + 1);
    const lane = NUMBER_LANES[index % NUMBER_LANES.length] ?? { x: 0, y: 0 };

    const id = this.nextId++;
    this.popups.push({
      id,
      group,
      at: { x: at.x, y: at.y, lift: at.lift },
      offsetX: lane.x,
      offsetY: lane.y,
      age: 0,
    });

    const expired: number[] = [];
    while (this.popups.length > CAPACITY) {
      const dropped = this.popups.shift();
      if (dropped) expired.push(dropped.id);
    }
    this.forgetEmptyLanes();
    return { id, expired };
  }

  /**
   * Advance one frame and place every number still alive.
   *
   * The projection happens here rather than at spawn because that is the whole
   * point: the same world point, asked again of a camera that has moved.
   */
  step(project: Projector): PopupStep {
    const live: PopupPlacement[] = [];
    const expired: number[] = [];

    for (let i = this.popups.length - 1; i >= 0; i--) {
      const popup = this.popups[i];
      if (!popup) continue;
      popup.age += 1;
      const life = 1 - popup.age / NUMBER_LIFE;
      if (life <= 0) {
        this.popups.splice(i, 1);
        expired.push(popup.id);
        continue;
      }
      const point = project(popup.at.x, popup.at.y, popup.at.lift);
      live.push({
        id: popup.id,
        left: point.x + popup.offsetX,
        top: point.y + popup.offsetY - (1 - life) * NUMBER_RISE,
        opacity: life,
        onScreen: point.onScreen,
      });
    }

    if (expired.length > 0) this.forgetEmptyLanes();
    return { live, expired };
  }

  /** How many numbers are floating. For tests and for anyone counting elements. */
  get count(): number {
    return this.popups.length;
  }

  /**
   * Drop the lane counter of any group with nothing left on screen.
   *
   * Two reasons. A counter that lived forever grew the map by one entry per
   * body ever hit, over a session that never ends; and a lone hit landing a
   * minute after the last one deserves the centre lane rather than wherever the
   * old cycle had got to.
   */
  private forgetEmptyLanes(): void {
    if (this.lanes.size === 0) return;
    const busy = new Set<number>();
    for (const popup of this.popups) busy.add(popup.group);
    for (const group of [...this.lanes.keys()]) {
      if (!busy.has(group)) this.lanes.delete(group);
    }
  }
}
