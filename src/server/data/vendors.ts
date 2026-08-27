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
 */

import { itemById } from './items.js';
import { idlePlanOf } from './monsters.js';
import { npcById } from './npcs.js';

/**
 * Where the merchant's spawner is, in world units (spec 244).
 *
 * The one number in this file that has to agree with something outside it. A
 * vendor's reach is measured from a fixed point and the body that owns this one
 * *walks*, so the point is its anchor -- which is a marker in the map document,
 * where this module cannot see it. `vendors.test.ts` asserts the shipped map's
 * `npc.merchant` spawner is here, so the two drifting apart is a failing test
 * rather than a shop that quietly refuses to open.
 *
 * Inside Hearthstead, a short walk south-east of where players arrive, on flat
 * ground whose whole wander disc is clear of props.
 */
export const RELL_HOME = { x: 650, y: 520 } as const;

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
  /**
   * Whether standing near this shop is enough to open it (spec 244).
   *
   * True for the two above, which is how shopping has worked since spec 129:
   * there is nobody to talk to, so `nearestVendorTo` finds one by proximity and
   * the shop key opens it.
   *
   * False for a shop with a **body** standing in it, and that is a rule rather
   * than a preference. Its reach has to cover its owner's whole wander disc plus
   * the distance a player can be talking from, which is four times the radius of
   * a shop you walk onto -- so left in the proximity search it would swallow the
   * others, and pressing the shop key anywhere near the square would open a
   * merchant's stock without a word being exchanged. Reached through the
   * conversation instead, which is what the reach was sized for.
   */
  readonly byProximity: boolean;
}

/**
 * Both of them stand near the spawn at (600, 450), because a shop nobody can
 * find is a shop nobody uses and there is no map yet that says where a town is.
 */
const DEFINITIONS: readonly VendorDefinition[] = [
  {
    id: 'vendor.quartermaster',
    name: 'Quartermaster',
    x: 640,
    y: 470,
    radius: 60,
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
    byProximity: true,
  },
  {
    // Better goods, worse rates: the choice a second shop exists to offer.
    id: 'vendor.armourer',
    name: 'Armourer',
    x: 560,
    y: 430,
    radius: 60,
    stock: ['sword.keen', 'maul.iron', 'staff.emberwood', 'focus.quartz', 'helm.plated', 'chest.scale'],
    buyMarkup: 1.8,
    sellFraction: 0.3,
    byProximity: true,
  },
  {
    // The first shop with a body standing in it (spec 244). The two above are
    // invisible coordinates you walk onto and press a key at, which is what the
    // header's own caveat is about: there was no map that said where a town was.
    // This one is reached by talking to the merchant who owns it, so its `x`/`y`
    // are that body's spawner rather than a spot chosen here -- see
    // `RELL_HOME` below for the one thing that has to agree.
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
    // Talk to Rell. See the field's own note: this shop's reach is four times a
    // walk-up shop's, because it is measured from an anchor its owner wanders
    // around, and in the proximity search it would swallow both of the others.
    byProximity: false,
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
