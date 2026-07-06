// Dev-only: render a contact sheet of baked dudes (idle + windup) to a PNG so a
// human can eyeball the baker output. Not part of the app. `tsx scripts/preview-dudes.ts`
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { bakeDude, seedFromName, SPRITE_W, SPRITE_H } from '../src/render/dude-baker.js';

const NAMES = ['Rook', 'Brawler', 'Adam', 'goblin', 'Ivy', 'Warden', 'skeleton', 'Mage', 'Rook2', 'ZZZ'];
const SCALE = 10;
const GAP = 6;
const cellW = SPRITE_W * SCALE + GAP;
const cellH = SPRITE_H * SCALE + GAP;
const cols = NAMES.length;
const img = new PNG({ width: cols * cellW, height: 2 * cellH, colorType: 6 });
img.data.fill(20);
for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;

function blit(rgba: Uint8ClampedArray, gx: number, gy: number): void {
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      const s = (y * SPRITE_W + x) * 4;
      if (rgba[s + 3] === 0) continue;
      for (let sy = 0; sy < SCALE; sy++) {
        for (let sx = 0; sx < SCALE; sx++) {
          const X = gx + x * SCALE + sx;
          const Y = gy + y * SCALE + sy;
          const d = (Y * img.width + X) * 4;
          img.data[d] = rgba[s] as number;
          img.data[d + 1] = rgba[s + 1] as number;
          img.data[d + 2] = rgba[s + 2] as number;
          img.data[d + 3] = 255;
        }
      }
    }
  }
}

NAMES.forEach((name, i) => {
  const dude = bakeDude(seedFromName(name));
  blit(dude.idle, i * cellW + GAP, GAP);
  blit(dude.windup, i * cellW + GAP, cellH + GAP);
});

const out = process.argv[2] ?? '/tmp/dudes.png';
writeFileSync(out, PNG.sync.write(img));
console.log('wrote', out, '(top row = idle, bottom = windup)');
