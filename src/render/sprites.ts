import { Texture } from 'pixi.js';
import { bakeDude, seedFromName, type BakedDude } from './dude-baker.js';

/**
 * Character art for the actors. Each dude is baked deterministically from an
 * identity string (enemy type / player name) via the vendored pixeldudesmaker
 * atlases — same identity always yields the same sprite. The heavy lifting is in
 * the pure, DOM-free `dude-baker`; this module only wraps its RGBA output into
 * nearest-neighbour Pixi textures. See specs/011.
 */

export interface DudeTextures {
  readonly idle: Texture;
  readonly windup: Texture;
}

export interface DudeIdentity {
  readonly playerName: string;
  readonly enemyType: string;
}

function textureFromRgba(rgba: Uint8ClampedArray, w: number, h: number): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const image = ctx.createImageData(w, h);
  image.data.set(rgba);
  ctx.putImageData(image, 0, 0);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest'; // crisp pixels when scaled up
  return texture;
}

/** Bake the `{ idle, windup }` textures for one identity string (player name or enemy type). */
export function dudeTexturesFor(name: string): DudeTextures {
  const dude: BakedDude = bakeDude(seedFromName(name));
  return {
    idle: textureFromRgba(dude.idle, dude.width, dude.height),
    windup: textureFromRgba(dude.windup, dude.width, dude.height),
  };
}

export function buildDudeTextures(identity: DudeIdentity): { player: DudeTextures; enemy: DudeTextures } {
  return {
    player: dudeTexturesFor(identity.playerName),
    enemy: dudeTexturesFor(identity.enemyType),
  };
}

export { SPRITE_H as SPRITE_NATIVE_HEIGHT } from './dude-atlas.js';
