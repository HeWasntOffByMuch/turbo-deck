/**
 * Zones (spec 056).
 *
 * A zone here is a *label on a region of the one continuous world*, not an
 * instance and not a separate coordinate space. Walking from "Greenmarch" to
 * "The Barrows" is walking, not a load screen: the sim never partitions on
 * zone, and the only things that read it are presentation (which music, which
 * name to show) and rules that want to key off place (spawn tables, PvP flags).
 *
 * Regions are rectangles tested in declaration order, with the first match
 * winning, so a small zone declared before a large one carves out of it. Any
 * point matching nothing falls through to the wilderness default.
 */

export interface ZoneDefinition {
  readonly id: string;
  readonly displayName: string;
  /** Axis-aligned region in world units. */
  readonly bounds: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** Whether players may damage each other here. */
  readonly pvp: boolean;
  /**
   * Reserved for a zone that wants its own repopulation rate. Unread since spec
   * 073 took spawning out of the zone and into the map document; kept because
   * "this region refills faster" is a knob a zone should own, and removing it
   * would only mean adding it back.
   */
  readonly spawnMultiplier: number;
}

export const WILDERNESS_ZONE_ID = 'wilds';

/**
 * The starting layout, laid over the same world rectangle the sim and terrain
 * already share (`src/shared/world.ts`): a safe hub at the play area's centre,
 * a forest around it, and everything past that is wilderness.
 */
export const DEFAULT_ZONES: readonly ZoneDefinition[] = [
  {
    id: 'hearth',
    displayName: 'Hearthstead',
    bounds: { x: 450, y: 300, w: 300, h: 300 },
    pvp: false,
    spawnMultiplier: 0,
  },
  {
    id: 'greenmarch',
    displayName: 'Greenmarch',
    bounds: { x: 0, y: 0, w: 1200, h: 900 },
    pvp: false,
    spawnMultiplier: 1,
  },
];

export const WILDERNESS: ZoneDefinition = {
  id: WILDERNESS_ZONE_ID,
  displayName: 'The Wilds',
  bounds: { x: -1e9, y: -1e9, w: 2e9, h: 2e9 },
  pvp: true,
  spawnMultiplier: 1.5,
};

export class ZoneManager {
  private readonly zones: readonly ZoneDefinition[];
  private readonly byId: ReadonlyMap<string, ZoneDefinition>;

  constructor(zones: readonly ZoneDefinition[] = DEFAULT_ZONES) {
    this.zones = zones;
    const index = new Map<string, ZoneDefinition>();
    for (const zone of zones) index.set(zone.id, zone);
    index.set(WILDERNESS.id, WILDERNESS);
    this.byId = index;
  }

  /** First matching region wins; unmatched points are wilderness. */
  zoneAt(x: number, y: number): ZoneDefinition {
    for (const zone of this.zones) {
      const b = zone.bounds;
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return zone;
    }
    return WILDERNESS;
  }

  zoneIdAt(x: number, y: number): string {
    return this.zoneAt(x, y).id;
  }

  byIdOrWilderness(id: string): ZoneDefinition {
    return this.byId.get(id) ?? WILDERNESS;
  }

  all(): readonly ZoneDefinition[] {
    return [...this.zones, WILDERNESS];
  }
}
