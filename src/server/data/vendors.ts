/**
 * The VENDORS definition table (spec 129).
 *
 * A vendor is a row here rather than a marker in the map document, and that is a
 * deliberate trade. A marker would mean a new kind in `MapMarkerKind`, a new byte
 * in the map wire format, a re-baked `arena.json` and a tool in the editor -- for
 * a position and a name. Vendors are content, content is a table, and where they
 * stand is a field on the row like every other field.
 *
 * The cost of that choice, stated plainly: moving a shop is a code change rather
 * than a map edit. When somebody wants to place one by dragging it, this becomes
 * a marker kind and the positions move into the document; nothing else here has
 * to change, because the rest of the system only ever asks for a vendor by id.
 *
 * Since spec 247 every row's `x`/`y` is a *body's* spawner rather than a spot
 * chosen here, which is half of that migration already done by hand: the
 * positions are in the map document, and these three constants are what has to
 * agree with them. `world/npc-placement.test.ts` is what says they do.
 */

import { itemById } from './items.js';
import { idlePlanOf } from './monsters.js';
import { npcById } from './npcs.js';

/**
 * Where each shopkeeper's spawner is, in world units (spec 246, spec 247).
 *
 * The numbers in this file that have to agree with something outside it. A
 * vendor's reach is measured from a fixed point and the bodies that own these
 * *walk*, so the point is the anchor -- which is a marker in the map document,
 * where this module cannot see it. `world/npc-placement.test.ts` asserts the
 * shipped map's spawners are here, so the two drifting apart is a failing test
 * rather than a shop that quietly refuses to open.
 *
 * All three stand on flat ground -- gradient zero across the whole wander disc,
 * so every point any of them can walk to is walkable -- with nothing solid
 * within thirty units of the anchor. Measured, not guessed. They sit a little
 * over two hundred units apart, which is more than two wander radii, so no two
 * of them can end up standing in the same place.
 *
 * They moved when the spawn was gated, and two of these three numbers are
 * simply where the marker went. The merchant's is not: the spots that edit
 * chose put it a hundred and fifty-eight from the quartermaster, which is
 * *inside* two wander radii -- the pair shoving each other around through
 * `resolveCrowding` for the fight-free half of their lives, with a player
 * right-clicking the pile getting whichever one the pick landed on. It is
 * fifty units off that spot, on the nearest ground that clears both wander
 * discs, which is the smallest correction that separates them.
 */
export const RELL_HOME = { x: 168, y: 316 } as const;
export const QUARTERMASTER_HOME = { x: 240, y: 508 } as const;
export const ARMOURER_HOME = { x: 741, y: 215 } as const;

/**
 * How far from {@link RELL_HOME} the merchant's shop can be reached.
 *
 * **Derived, not chosen**, because the thing it must not do is be smaller than
 * the distance a player can legitimately be standing at when they press the
 * reply that opens it. That distance is how far the body has wandered from its
 * anchor plus how far away the player may be from the body, and both of those
 * numbers are authored elsewhere -- so this reads them rather than restating
 * them, and raising either one carries the shop's reach along for free.
 *
 * The margin is for the gap between the tick the client asked on and the tick
 * the server answers: a player walking away as they press is measured where the
 * server last put them, not where they were.
 */
const REACH_MARGIN = 40;

function reachFor(npcId: string): number {
  const npc = npcById(npcId);
  const plan = idlePlanOf(npcId);
  const roam = plan.kind === 'sentinel' ? 0 : plan.radius;
  return (npc?.talkRadius ?? 0) + roam + REACH_MARGIN;
}

const RELL_REACH = reachFor('npc.merchant');
const QUARTERMASTER_REACH = reachFor('npc.quartermaster');
const ARMOURER_REACH = reachFor('npc.armourer');

export interface VendorDefinition {
  readonly id: string;
  readonly name: string;
  /** Where they stand, in world units. */
  readonly x: number;
  readonly y: number;
  /** How close a player must be to trade at all. */
  readonly radius: number;
  /** What they offer, by item id. Unlimited: buying does not deplete it. */
  readonly stock: readonly string[];
  /** What you pay: `ceil(value * buyMarkup)`. Above 1, always. */
  readonly buyMarkup: number;
  /** What you get: `floor(value * sellFraction)`. Below 1, always. */
  readonly sellFraction: number;
}

/**
 * Three shops, each with a body standing in it (spec 247).
 *
 * They used to be coordinates near the spawn that a player walked onto and
 * pressed a key at, which was the honest answer while there was no map that
 * said where a town was. There is one now, and the key is gone -- so every row
 * here names a spawner in `maps/arena`, its reach is derived from how far that
 * body wanders, and it is opened by talking to whoever owns it.
 *
 * The stock and the rates are exactly what they were. What moved is the way in.
 */
const DEFINITIONS: readonly VendorDefinition[] = [
  {
    id: 'vendor.quartermaster',
    name: 'Quartermaster',
    x: QUARTERMASTER_HOME.x,
    y: QUARTERMASTER_HOME.y,
    radius: QUARTERMASTER_REACH,
    stock: [
      'sword.worn',
      'bow.hunting',
      'stars.weighted',
      'shield.oak',
      'helm.leather',
      'chest.leather',
      'legs.traveller',
      'potion.minor',
    ],
    buyMarkup: 1.5,
    sellFraction: 0.4,
  },
  {
    // Better goods, worse rates: the choice a second shop exists to offer, and
    // the one thing either script says out loud about a number.
    id: 'vendor.armourer',
    name: 'Armourer',
    x: ARMOURER_HOME.x,
    y: ARMOURER_HOME.y,
    radius: ARMOURER_REACH,
    stock: ['sword.keen', 'maul.iron', 'staff.emberwood', 'focus.quartz', 'helm.plated', 'chest.scale'],
    buyMarkup: 1.8,
    sellFraction: 0.3,
  },
  {
    // The first shop that had a body standing in it (spec 246), and for one
    // spec the only one.
    id: 'vendor.rell',
    name: "Rell's Pack",
    x: RELL_HOME.x,
    y: RELL_HOME.y,
    radius: RELL_REACH,
    // A traveller's pack: the things somebody forgot to bring, at a fair price
    // rather than a good one. Deliberately overlapping the Quartermaster's --
    // this is a second place to buy a flask, not a third tier of goods.
    stock: ['potion.minor', 'sword.worn', 'bow.hunting', 'helm.leather', 'legs.traveller'],
    // Between the two above. It walks to you, so it charges for the walk.
    buyMarkup: 1.6,
    sellFraction: 0.35,
  },
];

export const VENDORS: ReadonlyMap<string, VendorDefinition> = new Map(
  DEFINITIONS.map((vendor) => [vendor.id, vendor]),
);

export const ALL_VENDORS: readonly VendorDefinition[] = DEFINITIONS;

export function vendorById(id: string): VendorDefinition | null {
  return VENDORS.get(id) ?? null;
}

/**
 * What one of `defId` costs at this vendor, or 0 for something with no price.
 *
 * **Rounds up**, and its sibling below rounds down. That pair is the one rule
 * that keeps the economy closed: with any markup above one and any fraction
 * below it, selling something back can never pay more than buying it cost, at
 * any value, including the small ones where rounding is the whole difference.
 */
export function buyPrice(defId: string, vendor: VendorDefinition): number {
  const value = itemById(defId)?.value ?? 0;
  if (value <= 0) return 0;
  return Math.ceil(value * vendor.buyMarkup);
}

/** What this vendor pays for one of `defId`. Rounds down; see {@link buyPrice}. */
export function sellPrice(defId: string, vendor: VendorDefinition): number {
  const value = itemById(defId)?.value ?? 0;
  if (value <= 0) return 0;
  return Math.floor(value * vendor.sellFraction);
}

/** Whether this vendor offers `defId` at all. */
export function sells(vendor: VendorDefinition, defId: string): boolean {
  return vendor.stock.includes(defId);
}

/** Whether a player standing at (x, y) is close enough to trade. */
export function withinReach(vendor: VendorDefinition, x: number, y: number): boolean {
  return Math.hypot(vendor.x - x, vendor.y - y) <= vendor.radius;
}
