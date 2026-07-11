import tilesetUrl from '../../../assets/FD_Dungeon_Free.png';
import { TILE_PX, type SrcTile } from './atlas-map.js';

/**
 * Browser loader for the 48×48 dungeon sheet (spec 027). It loads the committed
 * PNG once and blits source tiles onto a Canvas2D at nearest-neighbour scale.
 * Until the image finishes loading `ready` is false and callers fall back to
 * flat-colour tiles, so the layout is always visible. No game rules here.
 */
export class DungeonTileset {
  private readonly image = new Image();
  ready = false;

  constructor() {
    this.image.onload = (): void => {
      this.ready = true;
    };
    this.image.src = tilesetUrl;
  }

  /** Blit source tile `[col,row]` into the `size`×`size` screen rect at (dx,dy). */
  draw(ctx: CanvasRenderingContext2D, src: SrcTile, dx: number, dy: number, size: number): void {
    const [col, row] = src;
    ctx.drawImage(this.image, col * TILE_PX, row * TILE_PX, TILE_PX, TILE_PX, dx, dy, size, size);
  }
}
