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
