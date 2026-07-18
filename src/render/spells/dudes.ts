import { bakeDude, seedFromName, type BakedDude } from '../dude-baker.js';

/**
 * Character skins for the spell arena. Each actor's sprite is baked
 * deterministically from an identity string via the pure `dude-baker` (the same
 * pixeldudesmaker atlases the legacy Pixi renderer uses, spec 011). This module
 * only rasterises that RGBA into small nearest-neighbour offscreen canvases and
 * blits them onto the arena's Canvas2D. No game rules, no sim state.
 */

/** The player's skin identity; enemies use their own type key as the seed. */
export const PLAYER_SKIN = 'turbo-hero';

type Frame = 'idle' | 'windup';

interface Skin {
  readonly idle: HTMLCanvasElement;
  readonly windup: HTMLCanvasElement;
  readonly w: number;
  readonly h: number;
}

function canvasFromRgba(rgba: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const image = ctx.createImageData(w, h);
  image.data.set(rgba);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export class DudeSkins {
  private readonly cache = new Map<string, Skin>();

  private get(name: string): Skin {
    let skin = this.cache.get(name);
    if (!skin) {
      const dude: BakedDude = bakeDude(seedFromName(name));
      skin = {
        idle: canvasFromRgba(dude.idle, dude.width, dude.height),
        windup: canvasFromRgba(dude.windup, dude.width, dude.height),
        w: dude.width,
        h: dude.height,
      };
      this.cache.set(name, skin);
    }
    return skin;
  }

  /**
   * Draw `name`'s sprite centred on (cx, cy) -- the actor's hitbox centre -- sized
   * so it is `targetH` screen px tall (width follows the sprite's aspect).
   * `faceLeft` mirrors it horizontally; `alpha` fades it (grazing/stunned).
   */
  draw(
    ctx: CanvasRenderingContext2D,
    name: string,
    frame: Frame,
    cx: number,
    cy: number,
    targetH: number,
    faceLeft: boolean,
    alpha = 1,
  ): void {
    const skin = this.get(name);
    const src = frame === 'windup' ? skin.windup : skin.idle;
    const h = targetH;
    const w = (skin.w / skin.h) * h;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    if (faceLeft) ctx.scale(-1, 1);
    ctx.drawImage(src, -w / 2, -h / 2, w, h);
    ctx.restore();
  }
}
