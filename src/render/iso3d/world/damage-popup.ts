/**
 * The floating damage numbers, as a field of world points (spec 096).
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
 *
 * Since spec 183 the field carries a second kind of number -- what a kill was
 * worth -- and the two differ only in the path they take. Everything else about
 * a floating number was already right for both: one capacity over the pair, one
 * projection, one expiry, one place a test can reach any of it.
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

/**
 * Which path a number takes (spec 183).
 *
 * A property of one popup rather than of the field, so both kinds share the
 * capacity, the projection and the expiry spec 096 already got right.
 */
export type PopupTrail = 'damage' | 'xp';

/**
 * How far *below* the blow's number an experience number sits, in CSS pixels.
 *
 * Below, and in the blow's own lane, because the two are one reading: what that
 * hit took off and what the body was worth. The first cut swept the reward out
 * to the side on an ease-out, which separated the pair perfectly and looked
 * wrong -- a number leaving a body at 45 degrees is not a thing that happens in
 * this game, and reading it meant tracking two marks going different ways.
 *
 * So the reward is stacked under the blow and rises with it, at the same rate,
 * in the same direction: one column, and nothing to follow. The gap is a little
 * more than the reward's own height, so the two boxes are clear of each other
 * without a hole between them.
 */
export const XP_GAP = 24;

/**
 * How many rewards stack under one body before the gap starts over.
 *
 * The counterpart to {@link NUMBER_LANES} and for the same reason: two kills a
 * client is told about as one total, or a grant landing twice, would otherwise
 * be two numbers in exactly one place. Three, because a fourth would be further
 * under the body than a number over it can be read from.
 */
export const XP_STACK = 3;

/**
 * How much longer an experience number floats than a blow's, in frames.
 *
 * Half a second at 60fps. A blow's number is one of a burst and gets out of the
 * way; the reward is the last thing to happen to that body and is worth reading
 * after the fight has moved on -- and outliving the blow above it is what gives
 * it a moment on its own, which is the whole of what the sweep was reaching for.
 */
export const XP_EXTRA_LIFE = 30;

/** How long an experience number floats, in frames. */
export const XP_LIFE = NUMBER_LIFE + XP_EXTRA_LIFE;

/**
 * How far an experience number rises, in CSS pixels.
 *
 * Not a free number: it is `NUMBER_RISE` at the same rate for a longer life, so
 * the reward holds station under the blow for as long as the blow is there and
 * carries on alone afterwards. Rising at its own speed would have the two
 * converge or separate, which is the diagonal's problem in another direction.
 */
export const XP_RISE = (NUMBER_RISE * XP_LIFE) / NUMBER_LIFE;

/** A long fight should not grow the DOM without bound. */
const CAPACITY = 40;

interface Popup {
  readonly id: number;
  readonly group: number;
  readonly trail: PopupTrail;
  readonly at: WorldAnchor;
  readonly offsetX: number;
  readonly offsetY: number;
  /** How many frames it floats for. Per popup, because the two trails differ. */
  readonly life: number;
  /** How far it rises over that life, in CSS pixels. */
  readonly rise: number;
  age: number;
}

/** What one group has been given so far, for lane and side assignment. */
interface GroupTally {
  /** Damage numbers, which cycle {@link NUMBER_LANES}. */
  damage: number;
  /** Experience numbers, which alternate sides. */
  xp: number;
}

export class DamagePopups {
  private readonly popups: Popup[] = [];
  /** What each group has been given, for lane and side assignment. */
  private readonly lanes = new Map<number, GroupTally>();
  private nextId = 1;

  /**
   * Spawn a number at a world point.
   *
   * `group` -- in practice the target's entity id -- only fans the lanes out.
   * It is never resolved to anything: the anchor is the whole of what the
   * popup knows about the world.
   *
   * `trail` says which path it takes; see {@link PopupTrail}. An `xp` number
   * does not consume a damage lane, it *reads* the last one -- so a kill's
   * reward cannot shift where the next blow on that body draws its number.
   *
   * Returns the id to hang an element on, plus any ids evicted to stay under
   * capacity, so the caller never orphans one.
   */
  add(
    group: number,
    at: WorldAnchor,
    trail: PopupTrail = 'damage',
  ): { readonly id: number; readonly expired: readonly number[] } {
    const tally = this.lanes.get(group) ?? { damage: 0, xp: 0 };
    this.lanes.set(group, tally);

    let offsetX = 0;
    let offsetY = 0;
    if (trail === 'damage') {
      const lane = NUMBER_LANES[tally.damage % NUMBER_LANES.length] ?? { x: 0, y: 0 };
      offsetX = lane.x;
      offsetY = lane.y;
      tally.damage += 1;
    } else {
      // Directly under whichever lane the group's last blow took, so the pair
      // reads as one column rather than as two marks going different ways. No
      // damage before it -- a grant, a quest -- and that is the centre lane,
      // which is where a lone number belongs anyway.
      const above =
        tally.damage > 0
          ? (NUMBER_LANES[(tally.damage - 1) % NUMBER_LANES.length] ?? { x: 0, y: 0 })
          : { x: 0, y: 0 };
      offsetX = above.x;
      offsetY = above.y + XP_GAP * (1 + (tally.xp % XP_STACK));
      tally.xp += 1;
    }

    const id = this.nextId++;
    this.popups.push({
      id,
      group,
      trail,
      at: { x: at.x, y: at.y, lift: at.lift },
      offsetX,
      offsetY,
      life: trail === 'xp' ? XP_LIFE : NUMBER_LIFE,
      rise: trail === 'xp' ? XP_RISE : NUMBER_RISE,
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
      const life = 1 - popup.age / popup.life;
      if (life <= 0) {
        this.popups.splice(i, 1);
        expired.push(popup.id);
        continue;
      }
      const point = project(popup.at.x, popup.at.y, popup.at.lift);
      // The two trails differ only in where they start, how long they last and
      // how far they get -- and the last two are one rate, so a reward holds
      // station under the blow above it and carries on once that has gone.
      const spent = 1 - life;
      live.push({
        id: popup.id,
        left: point.x + popup.offsetX,
        top: point.y + popup.offsetY - spent * popup.rise,
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
