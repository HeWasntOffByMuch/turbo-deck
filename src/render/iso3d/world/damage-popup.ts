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
 * How far to the side an experience number *starts*, in CSS pixels.
 *
 * Sideways at all because the killing blow's number is spawned on the same
 * tick, from the same anchor, on the same body: taking the next lane would make
 * the reward a fourth damage number in the same fan, rising at the same rate in
 * the same direction. It has to read as a different kind of thing before it is
 * read as a quantity.
 *
 * A *lead* rather than a sweep from zero, because the sweep alone measured
 * clear and read as overlapping: the gap the paths open is between two centres,
 * and `+24 XP` is three times the width of `38`. Photographed on the shipped
 * page, the two boxes were still on top of each other for the first third of
 * the flight while the numbers were at their most legible. This is half the
 * reward's own width plus half a blow's, so they are clear on the first frame
 * and only get clearer.
 */
export const XP_LEAD = 56;

/**
 * How much further it sweeps over its life, in CSS pixels.
 *
 * On top of {@link XP_LEAD}, so the horizontal gap grows every frame -- two
 * numbers that separate and then converge are two numbers that cross.
 */
export const XP_DRIFT = 40;

/**
 * How far an experience number rises, in CSS pixels.
 *
 * Further than a blow's, because it is travelling diagonally to cover it -- the
 * two paths share an origin and the gap between them is what does the work.
 */
export const XP_RISE = 64;

/** A long fight should not grow the DOM without bound. */
const CAPACITY = 40;

interface Popup {
  readonly id: number;
  readonly group: number;
  readonly trail: PopupTrail;
  readonly at: WorldAnchor;
  readonly offsetX: number;
  readonly offsetY: number;
  /** Which way an `xp` trail sweeps: -1 left, +1 right. Unread by `damage`. */
  readonly drift: number;
  age: number;
}

/** What one group has been given so far, for lane and side assignment. */
interface GroupTally {
  /** Damage numbers, which cycle {@link NUMBER_LANES}. */
  damage: number;
  /** Experience numbers, which alternate sides. */
  xp: number;
}

/**
 * The rise of an `xp` trail, eased out (spec 183).
 *
 * A blow's number rises linearly, so easing is by itself most of what separates
 * the two paths: the experience number is already most of the way up while the
 * damage that earned it is still halfway. Quadratic, because the shape wanted
 * here is "leaves fast, settles" and there is no reason to spend a cubic on it.
 */
function easeOut(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) * (1 - clamped);
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

    let lane = { x: 0, y: 0 };
    let drift = 0;
    if (trail === 'damage') {
      lane = NUMBER_LANES[tally.damage % NUMBER_LANES.length] ?? lane;
      tally.damage += 1;
    } else {
      // Away from wherever the group's last damage number went. A constant
      // right-hand sweep would run straight through lane 2 of every burst,
      // which is the one case this exists to keep clear; the centre lane counts
      // as no side taken, so it falls through to the right.
      const last = tally.damage > 0
        ? (NUMBER_LANES[(tally.damage - 1) % NUMBER_LANES.length] ?? lane)
        : lane;
      // ...and alternating per experience number keeps two rewards on one group
      // -- two kills a client is told about as one total, or a grant landing on
      // the player's own body twice -- off each other's path.
      drift = (last.x > 0 ? -1 : 1) * (tally.xp % 2 === 0 ? 1 : -1);
      tally.xp += 1;
    }

    const id = this.nextId++;
    this.popups.push({
      id,
      group,
      trail,
      at: { x: at.x, y: at.y, lift: at.lift },
      offsetX: lane.x,
      offsetY: lane.y,
      drift,
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
      // The two trails share everything but the path: same field, same
      // capacity, same projection, same fade.
      const spent = 1 - life;
      const eased = popup.trail === 'xp' ? easeOut(spent) : 0;
      const left =
        popup.trail === 'xp'
          ? point.x + popup.drift * (XP_LEAD + XP_DRIFT * eased)
          : point.x + popup.offsetX;
      const top =
        popup.trail === 'xp'
          ? point.y - eased * XP_RISE
          : point.y + popup.offsetY - spent * NUMBER_RISE;
      live.push({
        id: popup.id,
        left,
        top,
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
