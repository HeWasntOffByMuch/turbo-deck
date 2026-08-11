// The picture a person decides from (spec 119).
// `npx tsx scripts/preview-splats.ts`
//
// Writes .claude/screenshots/splats.png: thirty generated splats, plus a
// directionality row and a fluid row, laid out as a contact sheet.
//
// This exists because a splat generator that produces thirty variations of the
// same grey smudge passes every test anyone would think to write. The tests
// beside it assert that the masks *differ* and that they are *thrown the right
// way*; neither of those says the result looks like blood, and nothing in Node
// can. So the sheet gets looked at before any of this is wired to a hit.
//
// No GL: the masks are software-rasterised in `splat.ts` and written straight
// out as pixels, so this runs anywhere `npm test` does.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { FLUIDS, generateSplat, type FluidKind, type SplatParams } from '../src/render/iso3d/vfx/splat.js';
import { VFX_PALETTE } from '../src/render/iso3d/vfx/palette.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The mask's own resolution: what a decal actually gets at gameplay scale. */
const TILE = 32;
/** Blown up by a whole number, the way the game blows up its frame. */
const ZOOM = 4;
const PAD = 4;
const COLUMNS = 10;

/** Behind the splats: the game's own trodden earth, so red is judged on dirt. */
const GROUND = 0xc8823f;
const GRID = 0xb37034;

interface Cell {
  readonly seed: number;
  readonly params: Partial<SplatParams>;
  readonly color: number;
}

function unpack(hex: number): [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

/** Draw one splat into the sheet at a tile position. */
function drawCell(png: PNG, cell: Cell, column: number, row: number): void {
  const mask = generateSplat(cell.seed, { size: TILE, ...cell.params });
  const [r, g, b] = unpack(cell.color);
  const [gr, gg, gb] = unpack(GROUND);
  const [dr, dg, db] = unpack(GRID);

  const originX = PAD + column * (TILE * ZOOM + PAD);
  const originY = PAD + row * (TILE * ZOOM + PAD);

  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const covered = (mask[y * TILE + x] ?? 0) > 0;
      // A faint checker under the transparent parts, so the tile's extent and
      // the splat's own scale are both readable.
      const checker = ((x >> 2) + (y >> 2)) % 2 === 0;
      const cr = covered ? r : checker ? gr : dr;
      const cg = covered ? g : checker ? gg : dg;
      const cb = covered ? b : checker ? gb : db;

      for (let sy = 0; sy < ZOOM; sy++) {
        for (let sx = 0; sx < ZOOM; sx++) {
          const px = originX + x * ZOOM + sx;
          const py = originY + y * ZOOM + sy;
          if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
          const at = (py * png.width + px) * 4;
          png.data[at] = cr;
          png.data[at + 1] = cg;
          png.data[at + 2] = cb;
          png.data[at + 3] = 255;
        }
      }
    }
  }
}

function main(): void {
  const cells: Cell[] = [];

  // Rows 1-3: thirty blood splats, thrown in eight directions, at the sizes a
  // real hit would ask for. This is the repetition check -- if two of these
  // thirty read as the same splat, the generator is not doing its job.
  for (let i = 0; i < 30; i++) {
    const angle = (i / 8) * Math.PI * 2;
    cells.push({
      seed: 7000 + i * 13,
      params: {
        ...FLUIDS.blood,
        dirX: Math.cos(angle),
        dirY: Math.sin(angle),
        throwStrength: 0.35 + (i % 5) * 0.16,
        mass: 0.3 + (i % 4) * 0.06,
      },
      color: VFX_PALETTE.bloodFresh,
    });
  }

  // Row 4: one seed, thrown eight ways plus two strengths. The directionality
  // has to be visible here or it is not visible in play either.
  for (let i = 0; i < COLUMNS; i++) {
    const angle = (i / 8) * Math.PI * 2;
    cells.push({
      seed: 4242,
      params: {
        ...FLUIDS.blood,
        dirX: Math.cos(angle),
        dirY: Math.sin(angle),
        throwStrength: i >= 8 ? 0.15 : 1,
        spread: 0.85,
      },
      color: VFX_PALETTE.bloodFresh,
    });
  }

  // Row 5: the same generator as every other fluid, two seeds each. The claim
  // being checked is that viscosity and spread alone make sap read as sap.
  const fluids: readonly (readonly [FluidKind, number])[] = [
    ['blood', VFX_PALETTE.bloodDeep],
    ['sap', VFX_PALETTE.sapAmber],
    ['ichor', VFX_PALETTE.ichorViolet],
    ['oil', VFX_PALETTE.oilBlack],
    ['slime', VFX_PALETTE.slimeGreen],
  ];
  for (const [kind, color] of fluids) {
    for (let variant = 0; variant < 2; variant++) {
      cells.push({
        seed: 900 + variant * 31,
        params: { ...FLUIDS[kind], dirX: 1, dirY: 0.35, throwStrength: 0.7 },
        color,
      });
    }
  }

  const rows = Math.ceil(cells.length / COLUMNS);
  const width = PAD + COLUMNS * (TILE * ZOOM + PAD);
  const height = PAD + rows * (TILE * ZOOM + PAD);
  const png = new PNG({ width, height });
  // The gaps between tiles: near-black, so each tile reads as its own thing.
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = 24;
    png.data[i * 4 + 1] = 22;
    png.data[i * 4 + 2] = 28;
    png.data[i * 4 + 3] = 255;
  }

  cells.forEach((cell, index) => {
    drawCell(png, cell, index % COLUMNS, Math.floor(index / COLUMNS));
  });

  const outDir = join(root, '.claude', 'screenshots');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'splats.png');
  writeFileSync(file, PNG.sync.write(png));

  console.log(`wrote ${file}`);
  console.log(`  ${cells.length} splats, ${TILE}x${TILE} each at ${ZOOM}x`);
  console.log('  rows 1-3  thirty blood splats, eight directions, varied throw and mass');
  console.log('  row 4     one seed thrown eight ways, then two at low throw');
  console.log('  row 5     blood, sap, ichor, oil, slime -- same generator, two seeds each');
}

main();
