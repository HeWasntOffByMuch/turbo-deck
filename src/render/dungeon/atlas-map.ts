/**
 * Pure tile-index mapping for the committed `assets/FD_Dungeon_Free.png` 48×48
 * sheet (spec 027). It says which source tile `(col,row)` to draw for each
 * dungeon cell, with deterministic per-cell variant selection so the floor/wall
 * texture is stable frame to frame. No DOM here, so it can be previewed
 * headlessly; the browser loader (`tileset.ts`) blits the tiles it names.
 */

export const TILE_PX = 48;

/** A source tile in the sheet, as `[col, row]` (each cell is TILE_PX square). */
export type SrcTile = readonly [col: number, row: number];

export type FloorTheme = 'blue' | 'red' | 'purple';

/** Rounded stone-slab floor tiles: a base plus decorated variants, per theme. */
export const FLOOR_THEMES: Record<FloorTheme, readonly SrcTile[]> = {
  blue: [
    [4, 2],
    [5, 2],
    [6, 2],
    [7, 2],
    [8, 2],
  ],
  red: [
    [4, 1],
    [5, 1],
    [6, 1],
    [7, 1],
    [8, 1],
  ],
  purple: [
    [4, 0],
    [5, 0],
    [6, 0],
    [7, 0],
    [8, 0],
  ],
};

/** Brown dirt floor, used for corridors so paths read apart from stone rooms. */
export const DIRT: readonly SrcTile[] = [
  [1, 0],
  [2, 0],
  [3, 0],
  [1, 1],
  [2, 1],
  [3, 1],
];

/** Brick wall courses used for every wall cell (one tile, no autotiling). */
export const WALL: readonly SrcTile[] = [
  [4, 8],
  [5, 8],
  [6, 8],
];

/** Flat dark tile for the void outside the walkable shell. */
export const VOID: SrcTile = [0, 5];

/** Switch/arrow floor plate marking an open doorway. */
export const DOOR_PLATE: SrcTile = [26, 4];

const THEME_ORDER: readonly FloorTheme[] = ['blue', 'red', 'purple'];

/** Pick the dungeon's stone theme from its seed (stable per run). */
export function themeForSeed(seed: number): FloorTheme {
  return THEME_ORDER[(seed >>> 0) % THEME_ORDER.length] as FloorTheme;
}

/** A small deterministic hash of a cell, for stable variant picks. */
export function cellHash(cx: number, cy: number): number {
  let h = (cx * 374761393 + cy * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = (h * 1274126177) >>> 0;
  return h >>> 0;
}

/** Choose a stable variant from `list` for cell (cx,cy). */
export function pickVariant(list: readonly SrcTile[], cx: number, cy: number): SrcTile {
  return list[cellHash(cx, cy) % list.length] as SrcTile;
}
