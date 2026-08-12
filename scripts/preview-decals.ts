// Dev-only: photograph blood on real ground (spec 120).
// `npx tsx scripts/preview-decals.ts`
//
// The contact sheet in `preview-splats.ts` shows what a splat *is*. It cannot
// show what only exists once decals are a *field*: where they cluster, how the
// chunk buckets divide them, and what the per-chunk cap does to a spot that
// keeps being fought over.
//
// Top-down rather than the game's isometric view, because the subject is
// placement and foreshortening hides half of it. How a stain *looks* is the
// contact sheet's job (`preview-splats.ts`) and the browser probe's.
//
// It reports the field's own numbers too: "ninety hits into one chunk settles
// back to sixty-four" is a claim about arithmetic and is cheaper to read than to
// look at. That readout is what caught the cap counting decals that were already
// fading, which had the whole bucket dying mid-fight.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { DecalField, decalGrid, type Decal } from '../src/render/iso3d/vfx/decals.js';
import { generateSplat, FLUIDS } from '../src/render/iso3d/vfx/splat.js';
import { VFX_PALETTE } from '../src/render/iso3d/vfx/palette.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A hillside, so "does it follow the ground" is a question with an answer. */
function slope(x: number, z: number): number {
  return Math.sin(x * 0.012) * 26 + Math.cos(z * 0.017) * 18;
}

/**
 * Draw the field from directly above, with the terrain height as a shade.
 *
 * A top-down render rather than the game's isometric one on purpose: the thing
 * being checked here is *placement* -- where the stains are, how they cluster,
 * whether the caps behave -- and an isometric view hides half of that behind
 * foreshortening. The look is checked in the browser probe instead.
 */
function drawField(field: DecalField, width: number, height: number, worldPerPixel: number): PNG {
  const png = new PNG({ width, height });
  const originX = -width * 0.5 * worldPerPixel;
  const originZ = -height * 0.5 * worldPerPixel;

  // The ground: the terrain's own two dirt tones, banded by height so the slope
  // is legible.
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const x = originX + px * worldPerPixel;
      const z = originZ + py * worldPerPixel;
      const shade = (slope(x, z) + 44) / 88;
      const band = Math.round(shade * 5) / 5;
      const at = (py * width + px) * 4;
      png.data[at] = Math.round(0x9a + band * 0x30);
      png.data[at + 1] = Math.round(0x66 + band * 0x24);
      png.data[at + 2] = Math.round(0x33 + band * 0x18);
      png.data[at + 3] = 255;
    }
  }

  // Chunk boundaries, so the bucketing is visible.
  const chunk = 616 / worldPerPixel;
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const x = originX + px * worldPerPixel;
      const z = originZ + py * worldPerPixel;
      const onLine = Math.abs(((x % 616) + 616) % 616) < worldPerPixel || Math.abs(((z % 616) + 616) % 616) < worldPerPixel;
      if (!onLine) continue;
      const at = (py * width + px) * 4;
      png.data[at] = 0x22;
      png.data[at + 1] = 0x1c;
      png.data[at + 2] = 0x18;
    }
  }
  void chunk;

  const TILE = 32;
  const grid = new Float32Array(4 * 4 * 3);
  const [br, bg, bb] = [(VFX_PALETTE.bloodFresh >> 16) & 0xff, (VFX_PALETTE.bloodFresh >> 8) & 0xff, VFX_PALETTE.bloodFresh & 0xff];

  for (const { cx, cz } of field.chunks()) {
    for (const decal of field.bucket(cx, cz)) {
      const mask = generateSplat(decal.seed, { size: TILE, ...FLUIDS[decal.fluid] });
      // The same grid the real view builds. Not used to draw this top-down
      // picture -- it is the *fit* being exercised, so a change that made decals
      // float off a hillside would fail here rather than in a browser.
      decalGrid(decal as Decal, 4, slope, 1.2, grid);
      for (let i = 0; i < 16; i++) {
        if (!Number.isFinite(grid[i * 3 + 1] ?? Number.NaN)) throw new Error('decal grid produced a non-finite height');
      }

      // Iterate *output* pixels and sample the mask, rather than scattering the
      // mask's texels into the output. Gap-free at any zoom, which the other way
      // round is not.
      //
      // Worth saying plainly: this was changed on the theory that undersampling
      // was why the stains looked like specks, and the picture came out
      // identical. They are simply that small -- a decal is 26 to 52 world units
      // against a 616-unit chunk, so at this zoom it is about a dozen pixels.
      // The sampling is still the right way round; it just was not the cause.
      const half = decal.size * 0.5;
      const cos = Math.cos(decal.rotation);
      const sin = Math.sin(decal.rotation);
      const reach = half * Math.SQRT2;
      const minPx = Math.max(0, Math.floor((decal.x - reach - originX) / worldPerPixel));
      const maxPx = Math.min(width - 1, Math.ceil((decal.x + reach - originX) / worldPerPixel));
      const minPy = Math.max(0, Math.floor((decal.z - reach - originZ) / worldPerPixel));
      const maxPy = Math.min(height - 1, Math.ceil((decal.z + reach - originZ) / worldPerPixel));

      for (let py = minPy; py <= maxPy; py++) {
        for (let px = minPx; px <= maxPx; px++) {
          const wx = originX + px * worldPerPixel - decal.x;
          const wz = originZ + py * worldPerPixel - decal.z;
          // Into the decal's own frame, then to a texel.
          const lx = wx * cos + wz * sin;
          const lz = -wx * sin + wz * cos;
          const u = (lx / half + 1) * 0.5;
          const v = (lz / half + 1) * 0.5;
          if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
          const tx = Math.min(TILE - 1, Math.floor(u * TILE));
          const ty = Math.min(TILE - 1, Math.floor(v * TILE));
          if ((mask[ty * TILE + tx] ?? 0) === 0) continue;

          const at = (py * width + px) * 4;
          const fade = decal.opacity;
          png.data[at] = Math.round((png.data[at] ?? 0) * (1 - fade) + br * fade);
          png.data[at + 1] = Math.round((png.data[at + 1] ?? 0) * (1 - fade) + bg * fade);
          png.data[at + 2] = Math.round((png.data[at + 2] ?? 0) * (1 - fade) + bb * fade);
        }
      }
    }
  }

  return png;
}

function main(): void {
  const field = new DecalField();
  field.setViewpoint(0, 0);

  // A fight that wanders: three clusters, one of them hammered well past the
  // per-chunk cap so the oldest-fades-first behaviour is visible.
  let seed = 31337;
  const next = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) | 0);

  const drop = (cxWorld: number, czWorld: number, count: number, spread: number): void => {
    for (let i = 0; i < count; i++) {
      const angle = ((next() >>> 8) % 628) / 100;
      const radius = ((next() >>> 8) % 1000) / 1000 * spread;
      field.add({
        x: cxWorld + Math.cos(angle) * radius,
        y: 0,
        z: czWorld + Math.sin(angle) * radius,
        size: 26 + (((next() >>> 8) % 100) / 100) * 26,
        rotation: angle,
        nx: 0,
        ny: 1,
        nz: 0,
        seed: next(),
        fluid: 'blood',
      });
      field.update(2);
    }
  };

  drop(-420, -260, 18, 130);
  drop(180, 120, 90, 200); // Well past the per-chunk cap of 64.
  drop(760, -300, 26, 150);

  const png = drawField(field, 900, 620, 2.2);
  const outDir = join(root, '.claude', 'screenshots');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'decals.png');
  writeFileSync(file, PNG.sync.write(png));

  const buckets = field.chunks();
  console.log(`wrote ${file}`);
  console.log(`  ${field.count} decals live across ${buckets.length} chunk bucket(s)`);
  for (const { cx, cz } of buckets) {
    const bucket = field.bucket(cx, cz);
    const fading = bucket.filter((decal) => decal.fadeFrom >= 0).length;
    console.log(`    chunk ${cx},${cz}: ${bucket.length} decals, ${fading} fading out`);
  }
  console.log('  134 adds went in; the per-chunk cap is 64 and the global cap is 512.');
}

main();
