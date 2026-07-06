import { Rng } from '../shared/prng.js';
import {
  SPRITE_W,
  SPRITE_H,
  N_BASE,
  N_HEAD,
  N_FACE,
  IDLE_COLS,
  RUN_COLS,
  PART_OY,
  OUTLINE,
  PALETTE,
  SHADOW,
  SRC,
  BASE_W,
  BASE_H,
  HEADS_W,
  HEADS_H,
  FACES_W,
  FACES_H,
  BASE_PX,
  HEADS_PX,
  FACES_PX,
} from './dude-atlas.js';

/**
 * Pure, deterministic sprite baker for the vendored pixeldudesmaker atlases.
 * No DOM, no Pixi — given a seed it composites base+head+face and recolours the
 * marker channels, so `bakeDude(seed)` is byte-identical every run and testable
 * headlessly. The renderer (sprites.ts) wraps the RGBA it returns into textures.
 * See specs/011.
 */

export { SPRITE_W, SPRITE_H };

type Rgb = readonly [number, number, number];

// --- atlas pixel data: base64 -> per-pixel indices into SRC ---------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

function unb64(s: string): Uint8Array {
  const len = s.endsWith('==') ? (s.length / 4) * 3 - 2 : s.endsWith('=') ? (s.length / 4) * 3 - 1 : (s.length / 4) * 3;
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = B64_INV[s.charCodeAt(i)] as number;
    const b = B64_INV[s.charCodeAt(i + 1)] as number;
    const c = B64_INV[s.charCodeAt(i + 2)] as number;
    const d = B64_INV[s.charCodeAt(i + 3)] as number;
    const n = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
    if (o < len) out[o++] = (n >> 16) & 0xff;
    if (o < len) out[o++] = (n >> 8) & 0xff;
    if (o < len) out[o++] = n & 0xff;
  }
  return out;
}

const BASE = unb64(BASE_PX);
const HEADS = unb64(HEADS_PX);
const FACES = unb64(FACES_PX);

// --- seed from an identity string (FNV-1a, 32-bit) ------------------------

export function seedFromName(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// --- palette selection ----------------------------------------------------

interface Skin {
  outline: Rgb;
  eyes: Rgb;
  body: Rgb;
  hair: Rgb;
  item: Rgb;
  suit: Rgb;
}

const shade = (c: Rgb, m: number): Rgb => [Math.floor(c[0] * m), Math.floor(c[1] * m), Math.floor(c[2] * m)];

function pickSkin(pickColor: () => Rgb): Skin {
  const body = pickColor();
  // eyes re-rolled so they don't vanish into the body colour (as app.js does).
  let eyes = pickColor();
  for (let i = 0; i < 10 && eyes === body; i++) eyes = pickColor();
  const hair = pickColor();
  const suit = pickColor();
  const item = pickColor();
  return { outline: OUTLINE, eyes, body, hair, item, suit };
}

/** Resolve every SRC entry to its RGBA for this skin (index 0 stays transparent). */
function resolveColors(skin: Skin): Uint8ClampedArray {
  const out = new Uint8ClampedArray(SRC.length * 4);
  for (let i = 1; i < SRC.length; i++) {
    const [ch, r, g, b] = SRC[i] as readonly [number, number, number, number];
    let c: Rgb;
    switch (ch) {
      case 0: c = skin.outline; break;
      case 1: c = skin.eyes; break;
      case 2: c = skin.body; break;
      case 3: c = shade(skin.body, SHADOW.body); break;
      case 4: c = skin.hair; break;
      case 5: c = shade(skin.hair, SHADOW.hair); break;
      case 6: c = skin.item; break;
      case 7: c = shade(skin.item, SHADOW.item); break;
      case 8: c = skin.suit; break;
      case 9: c = shade(skin.suit, SHADOW.suit); break;
      default: c = [r, g, b]; break; // literal (-1)
    }
    const o = i * 4;
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
    out[o + 3] = 255;
  }
  return out;
}

// --- compositing ----------------------------------------------------------

const oy = (part: 'head' | 'face', anim: 'idle' | 'run', frame: number): number =>
  PART_OY[part][anim][frame] ?? 0;

function sample(px: Uint8Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  return px[y * w + x] as number;
}

interface Parts {
  base: number;
  head: number;
  face: number;
}

/** Composite one pose into a W*H grid of SRC indices (later layers win). */
function composeIndices(p: Parts, baseCol: number, anim: 'idle' | 'run', frame: number): Uint8Array {
  const grid = new Uint8Array(SPRITE_W * SPRITE_H);
  const bx0 = baseCol * SPRITE_W;
  const by0 = p.base * SPRITE_H;
  const hx0 = p.head * SPRITE_W;
  const fx0 = p.face * SPRITE_W;
  const hoy = oy('head', anim, frame);
  const foy = oy('face', anim, frame);
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      const dst = y * SPRITE_W + x;
      const bpx = sample(BASE, BASE_W, BASE_H, bx0 + x, by0 + y);
      if (bpx !== 0) grid[dst] = bpx;
      const hpx = sample(HEADS, HEADS_W, HEADS_H, hx0 + x, y - hoy);
      if (hpx !== 0) grid[dst] = hpx;
      const fpx = sample(FACES, FACES_W, FACES_H, fx0 + x, y - foy);
      if (fpx !== 0) grid[dst] = fpx;
    }
  }
  return grid;
}

function toRgba(grid: Uint8Array, colors: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(SPRITE_W * SPRITE_H * 4);
  for (let i = 0; i < grid.length; i++) {
    const s = grid[i] as number;
    if (s === 0) continue;
    const o = i * 4;
    const c = s * 4;
    out[o] = colors[c] as number;
    out[o + 1] = colors[c + 1] as number;
    out[o + 2] = colors[c + 2] as number;
    out[o + 3] = 255;
  }
  return out;
}

export interface BakedDude {
  readonly width: number;
  readonly height: number;
  readonly idle: Uint8ClampedArray;
  readonly windup: Uint8ClampedArray;
}

/**
 * Bake a deterministic dude for `seed`. `idle` is a neutral idle frame; `windup`
 * is a distinct lunge from the run cycle so the attack-anticipation swap reads.
 */
export function bakeDude(seed: number): BakedDude {
  // Thread the immutable Rng through a closure so draws read as plain calls.
  let rng = Rng.fromSeed(seed);
  const nextInt = (max: number): number => {
    const [value, next] = rng.nextInt(0, max);
    rng = next;
    return value;
  };
  const pickColor = (): Rgb => PALETTE[nextInt(PALETTE.length - 1)] as Rgb;

  const parts: Parts = {
    base: nextInt(N_BASE - 1),
    head: nextInt(N_HEAD - 1),
    face: nextInt(N_FACE - 1),
  };
  const colors = resolveColors(pickSkin(pickColor));
  return {
    width: SPRITE_W,
    height: SPRITE_H,
    idle: toRgba(composeIndices(parts, IDLE_COLS[0] as number, 'idle', 0), colors),
    windup: toRgba(composeIndices(parts, RUN_COLS[1] as number, 'run', 1), colors),
  };
}
