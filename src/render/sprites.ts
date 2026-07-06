import { Texture } from 'pixi.js';

/**
 * Placeholder character art, drawn procedurally into small nearest-neighbour
 * textures so the actors read as little pixel "dudes" instead of circles.
 *
 * SWAP SEAM: to use real sprite-sheet art (e.g. an export from the
 * pixeldudesmaker generator), replace `buildDudeTextures` with a loader that
 * slices your PNG into the same { idle, windup } textures per actor. The scene
 * only depends on that shape, nothing else changes.
 */

export type Pose = 'idle' | 'windup';

interface DudePalette {
  readonly body: string;
  readonly bodyDark: string;
  readonly skin: string;
  readonly eye: string;
  readonly outline: string;
  readonly weapon: string;
  readonly legs: string;
  readonly hair?: string;
  readonly horns?: string;
}

const PLAYER_PALETTE: DudePalette = {
  body: '#3a6ea5',
  bodyDark: '#284e78',
  skin: '#f0c090',
  eye: '#14121c',
  outline: '#0e0e18',
  weapon: '#dfe5f2',
  legs: '#2b2b3d',
  hair: '#5b3a1e',
};

const ENEMY_PALETTE: DudePalette = {
  body: '#c0392b',
  bodyDark: '#7d2626',
  skin: '#c0392b',
  eye: '#ffd23f',
  outline: '#150a0a',
  weapon: '#9aa0ae',
  legs: '#5b1f1f',
  horns: '#ecdcb4',
};

const NATIVE_W = 20;
const NATIVE_H = 24;

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** Paint one dude pose onto a small canvas; the caller wraps it in a nearest texture. */
function drawDude(pal: DudePalette, pose: Pose): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = NATIVE_W;
  canvas.height = NATIVE_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const O = pal.outline;

  // Ground shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.beginPath();
  ctx.ellipse(10, 22, 7, 2.4, 0, 0, Math.PI * 2);
  ctx.fill();

  // Legs.
  px(ctx, 6, 17, 3, 5, O);
  px(ctx, 11, 17, 3, 5, O);
  px(ctx, 6, 17, 3, 4, pal.legs);
  px(ctx, 11, 17, 3, 4, pal.legs);

  // Torso (outline then fill), with a darker belt band.
  px(ctx, 4, 9, 12, 10, O);
  px(ctx, 5, 10, 10, 8, pal.body);
  px(ctx, 5, 15, 10, 2, pal.bodyDark);

  // Arms.
  px(ctx, 3, 10, 2, 6, O);
  px(ctx, 15, 10, 2, 6, O);
  px(ctx, 3, 10, 2, 5, pal.bodyDark);
  px(ctx, 15, 10, 2, 5, pal.bodyDark);

  // Head.
  px(ctx, 5, 2, 10, 8, O);
  px(ctx, 6, 3, 8, 6, pal.skin);
  if (pal.hair) px(ctx, 6, 2, 8, 2, pal.hair);
  if (pal.horns) {
    px(ctx, 4, 0, 2, 4, pal.horns);
    px(ctx, 14, 0, 2, 4, pal.horns);
  }

  // Eyes.
  px(ctx, 8, 5, 1, 2, pal.eye);
  px(ctx, 11, 5, 1, 2, pal.eye);

  // Weapon in the right hand: lowered when idle, raised overhead on wind-up.
  if (pose === 'windup') {
    px(ctx, 15, 0, 2, 10, O);
    px(ctx, 15, 1, 2, 8, pal.weapon);
    px(ctx, 13, 9, 5, 2, pal.weapon);
  } else {
    px(ctx, 16, 10, 2, 10, O);
    px(ctx, 16, 11, 2, 8, pal.weapon);
  }

  return canvas;
}

export interface DudeTextures {
  readonly idle: Texture;
  readonly windup: Texture;
}

function makeTexture(pal: DudePalette, pose: Pose): Texture {
  const texture = Texture.from(drawDude(pal, pose));
  texture.source.scaleMode = 'nearest'; // crisp pixels when scaled up
  return texture;
}

export function buildDudeTextures(): { player: DudeTextures; enemy: DudeTextures } {
  return {
    player: { idle: makeTexture(PLAYER_PALETTE, 'idle'), windup: makeTexture(PLAYER_PALETTE, 'windup') },
    enemy: { idle: makeTexture(ENEMY_PALETTE, 'idle'), windup: makeTexture(ENEMY_PALETTE, 'windup') },
  };
}

export const SPRITE_NATIVE_HEIGHT = NATIVE_H;
