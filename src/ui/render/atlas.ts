/**
 * One texture, baked from committed text (spec 123).
 *
 * Every glyph of both faces, every 9-slice frame and every icon are packed into
 * a single RGBA buffer at startup. Nothing is fetched and no PNG exists: the
 * source is `theme/atlas-source.ts` and the two glyph tables, all of which
 * review as a diff.
 *
 * Two rules that make the rest of the framework simpler:
 *
 * - **Glyphs are baked white.** Text colour is a tint at draw time, so one
 *   glyph serves every colour a label is ever set in. Frames and icons are baked
 *   in their palette colours and drawn with a white tint, which is the identity.
 * - **The bake is deterministic.** Sprites are packed in sorted name order into
 *   fixed shelves, so the same source produces byte-identical pixels on every
 *   run and on every machine. That is what lets a golden image be a golden image
 *   rather than a thing that passes locally.
 *
 * Pure enough to run in Node -- this is where the software rasterizer gets its
 * pixels, so it has to be. No DOM, no clock, no `Math.random`.
 */

import { multiply, WHITE, type Color } from '../core/color.js';
import type { Rect } from '../core/geom.js';
import { BODY_FONT, NUMERIC_FONT, type Font, type Glyph } from '../text/font.js';
import {
  ABILITY_ICONS,
  ABILITY_ICON_SIZE,
  ICONS,
  ICON_SIZE,
  ITEM_ICONS,
  ITEM_ICON_SIZE,
  PATCHES,
  PATCH_PALETTE,
  type PatchSource,
} from '../theme/atlas-source.js';
import type { Theme } from '../theme/theme.js';
import { colorKey } from '../core/color.js';

/** Where a sprite sits in the atlas. The `src` half of every draw call. */
export type AtlasRect = Rect;

/** A frame's rects, already split into the nine pieces a 9-slice needs. */
export interface NineSlice {
  readonly border: number;
  /** The whole patch, for callers that want to reason about it. */
  readonly bounds: AtlasRect;
}

export interface Atlas {
  readonly width: number;
  readonly height: number;
  /** RGBA, straight alpha, row-major, `width * height * 4` bytes. */
  readonly pixels: Uint8Array;
  sprite(name: string): AtlasRect;
  hasSprite(name: string): boolean;
  patch(name: string): NineSlice;
  glyph(font: Font, character: string): AtlasRect;
  /** Every sprite name, sorted. For tests and for the gallery's inventory. */
  names(): readonly string[];
}

/** One pixel of padding between sprites, so a nearest-neighbour fetch at the
 * edge of one cannot pick up its neighbour when a destination is a hair off. */
const PAD = 1;

interface Placement {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Writes the sprite's pixels at (ox, oy) into the atlas. */
  readonly draw: (put: (x: number, y: number, color: Color) => void) => void;
}

function glyphName(font: Font, character: string): string {
  return `glyph:${font.id}:${character}`;
}

function glyphPlacement(font: Font, glyph: Glyph): Placement {
  return {
    name: glyphName(font, glyph.character),
    width: font.width,
    height: font.height,
    draw: (put) => {
      for (let y = 0; y < font.height; y++) {
        for (let x = 0; x < font.width; x++) {
          if (glyph.lit[y * font.width + x]) put(x, y, WHITE);
        }
      }
    },
  };
}

function gridPlacement(
  name: string,
  rows: readonly string[],
  width: number,
  height: number,
  resolve: (slot: string) => Color,
): Placement {
  return {
    name,
    width,
    height,
    draw: (put) => {
      for (let y = 0; y < height; y++) {
        const row = rows[y] ?? '';
        for (let x = 0; x < width; x++) {
          const char = row[x] ?? '.';
          if (char === '.') continue;
          const slot = PATCH_PALETTE[char];
          if (!slot) throw new Error(`atlas: ${name} uses '${char}', which is not in PATCH_PALETTE`);
          put(x, y, resolve(slot));
        }
      }
    },
  };
}

function patchDimensions(patch: PatchSource): { width: number; height: number } {
  const height = patch.rows.length;
  const width = patch.rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  return { width, height };
}

/**
 * Bake every sprite into one buffer.
 *
 * Shelf-packed in sorted name order: sprites go left to right until the row is
 * full, then down by the tallest thing on it. Not the tightest packing there is,
 * and deliberately not -- a smarter packer is one whose output changes when an
 * unrelated sprite is added, and every golden image in the suite would move with
 * it. Sorted order and dumb shelves mean adding an icon shifts what comes after
 * it and nothing before.
 */
export function bakeAtlas(theme: Theme, width = 256): Atlas {
  const resolve = (slot: string): Color => theme.color(slot);

  const placements: Placement[] = [];
  for (const font of [BODY_FONT, NUMERIC_FONT]) {
    for (const glyph of Object.values(font.glyphs)) {
      placements.push(glyphPlacement(font, glyph));
    }
  }
  for (const [name, patch] of Object.entries(PATCHES)) {
    const { width: w, height: h } = patchDimensions(patch);
    placements.push(gridPlacement(`patch:${name}`, patch.rows, w, h, resolve));
  }
  for (const [name, rows] of Object.entries(ICONS)) {
    placements.push(gridPlacement(`icon:${name}`, rows, ICON_SIZE, ICON_SIZE, resolve));
  }
  // Item art is its own size (spec 127) and its own namespace, so `icon:close`
  // and `item:sword` can never collide and neither has to know the other exists.
  for (const [name, rows] of Object.entries(ITEM_ICONS)) {
    placements.push(gridPlacement(`item:${name}`, rows, ITEM_ICON_SIZE, ITEM_ICON_SIZE, resolve));
  }
  for (const [name, rows] of Object.entries(ABILITY_ICONS)) {
    placements.push(gridPlacement(`ability:${name}`, rows, ABILITY_ICON_SIZE, ABILITY_ICON_SIZE, resolve));
  }
  placements.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const rects = new Map<string, AtlasRect>();
  let penX = PAD;
  let penY = PAD;
  let shelfHeight = 0;
  for (const item of placements) {
    if (penX + item.width + PAD > width) {
      penX = PAD;
      penY += shelfHeight + PAD;
      shelfHeight = 0;
    }
    rects.set(item.name, { x: penX, y: penY, width: item.width, height: item.height });
    penX += item.width + PAD;
    shelfHeight = Math.max(shelfHeight, item.height);
  }
  const height = nextPowerOfTwo(penY + shelfHeight + PAD);

  const pixels = new Uint8Array(width * height * 4);
  for (const item of placements) {
    const at = rects.get(item.name);
    if (!at) continue;
    item.draw((x, y, colour) => {
      const px = at.x + x;
      const py = at.y + y;
      if (px < 0 || py < 0 || px >= width || py >= height) return;
      const offset = (py * width + px) * 4;
      pixels[offset] = colour.r;
      pixels[offset + 1] = colour.g;
      pixels[offset + 2] = colour.b;
      pixels[offset + 3] = colour.a;
    });
  }

  const sortedNames = [...rects.keys()].sort();

  return {
    width,
    height,
    pixels,
    hasSprite: (name) => rects.has(name),
    sprite: (name) => {
      const found = rects.get(name);
      if (!found) throw new Error(`atlas: no sprite named ${name}`);
      return found;
    },
    patch: (name) => {
      const source = PATCHES[name];
      if (!source) throw new Error(`atlas: no patch named ${name}`);
      const bounds = rects.get(`patch:${name}`);
      if (!bounds) throw new Error(`atlas: patch ${name} was never packed`);
      return { border: source.border, bounds };
    },
    glyph: (font, character) => {
      const found = rects.get(glyphName(font, character));
      return found ?? rects.get(glyphName(font, font.fallback.character)) ?? { x: 0, y: 0, width: 0, height: 0 };
    },
    names: () => sortedNames,
  };
}

function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size *= 2;
  return Math.max(1, size);
}

/**
 * A tinted copy of the atlas, cached per colour.
 *
 * Both backends share this: the software rasterizer reads the bytes directly and
 * `canvas2d` uploads each one to a canvas exactly once. Sharing it is not a
 * convenience -- it is the reason the two backends' output can be asserted
 * byte-identical, since a tint applied twice by two different rules would differ
 * in the last bit and nowhere else.
 *
 * The palette is sixteen colours and a handful of them are ever used as a tint,
 * so the cache stays small; there is no eviction and there does not need to be.
 */
export class TintCache {
  private readonly entries = new Map<string, Uint8Array>();

  constructor(private readonly atlas: Atlas) {}

  get(tint: Color): Uint8Array {
    const key = colorKey(tint);
    const cached = this.entries.get(key);
    if (cached) return cached;

    const source = this.atlas.pixels;
    const out = new Uint8Array(source.length);
    for (let i = 0; i < source.length; i += 4) {
      const tinted = multiply(
        { r: source[i] ?? 0, g: source[i + 1] ?? 0, b: source[i + 2] ?? 0, a: source[i + 3] ?? 0 },
        tint,
      );
      out[i] = tinted.r;
      out[i + 1] = tinted.g;
      out[i + 2] = tinted.b;
      out[i + 3] = tinted.a;
    }
    this.entries.set(key, out);
    return out;
  }

  /** How many tinted copies exist. A test asserts this stays small. */
  size(): number {
    return this.entries.size;
  }
}
