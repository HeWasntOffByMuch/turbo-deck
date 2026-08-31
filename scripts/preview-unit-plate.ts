/**
 * The two overhead shapes, side by side, in a real browser (spec 257).
 *
 *   npx tsx scripts/preview-unit-plate.ts
 *
 * Everything spec 257 decides is asserted in Node (`world/player-plate.test.ts`)
 * and none of it is what could be wrong here. A plate is a frame with two rows
 * and a box in it, and every way it fails is a way a stylesheet fails: a row
 * negotiated down to nothing by a flex parent (which is what happened to the
 * status row until spec 186's probe caught it), a level box the digits spill
 * out of, an inner rule that does not show because the frame and the track are
 * the same dark.
 *
 * So this mounts the real `createHud` over `src/render/hud-probe.html`, anchors
 * two players and a monster beside each other, and photographs them -- through a
 * scaled viewport rather than by upscaling after, which would only blur what it
 * is meant to show (spec 186's rule), because a plate is 76x16 CSS pixels and
 * the whole question is whether its parts can be told apart at that size.
 *
 * It measures the boxes as well, because a picture cannot say whether a row came
 * out the height it was given -- and every failure listed above is visible in a
 * rectangle.
 *
 * It writes `.claude/screenshots/unit-plate.png`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import {
  PLATE,
  PLATE_HEIGHT,
  PLATE_LEVEL_PX,
  PLATE_WIDTH,
} from '../src/render/iso3d/world/player-plate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4337;
const VIEWPORT = { width: 900, height: 420 };

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

/** The tick the rig's fabricated view claims to be at. */
const NOW = 400;

/**
 * Where the three bodies are put.
 *
 * Far enough apart that no plate overlaps its neighbour, and low enough to clear
 * the developer readout the rig draws across the top of the frame: a plate
 * photographed through that panel is a picture of the panel.
 */
const PLAYER_AT = { id: 1, x: 190, y: 330 };
const OTHER_AT = { id: 2, x: 450, y: 330 };
const MONSTER_AT = { id: 3, x: 690, y: 330 };

const problems: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) problems.push(what);
}

async function waitForServer(url: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${url} never came up`);
}

/**
 * Three bodies in the rig's view: us, another player, and a monster -- so spec
 * 145's bar is in the same picture as the thing that replaced it for players.
 *
 * Both players are dented rather than full, because a plate at 140/140 says
 * nothing about where its fill ends; the local one carries a status, because the
 * row above the plate is the part of this that had to keep working.
 */
async function stage(page: Page): Promise<void> {
  // Every field spelled out rather than spread from a local helper. A function
  // declared inside `page.evaluate` is compiled by tsx with esbuild's
  // `keepNames` shim, whose `__name` does not exist in the page -- so the whole
  // call throws a `ReferenceError` before it reaches the rig.
  await page.evaluate((now: number) => {
    window.hudProbe?.set({
      entities: [
        {
          id: 1,
          kind: 0,
          typeId: 'player',
          x: 0,
          y: 0,
          z: 0,
          facing: 0,
          activity: 0,
          activityUntilTick: 0,
          name: '',
          health: 96,
          maxHealth: 140,
          poise: 0.62,
          // Sixty, which is `MAX_PLAYER_LEVEL` and so the widest number the box
          // ever holds. A one-digit level tells you nothing about whether the
          // box is big enough for the face it is set in.
          level: 60,
          statuses: [{ wire: 1, stacks: 2, expiresAtTick: now + 200 }],
        },
        {
          id: 2,
          kind: 0,
          typeId: 'player',
          x: 0,
          y: 0,
          z: 0,
          facing: 0,
          activity: 0,
          activityUntilTick: 0,
          name: 'Ada',
          health: 24,
          maxHealth: 40,
          poise: 1,
          level: 7,
          statuses: [],
        },
        {
          id: 3,
          kind: 1,
          typeId: 'spider',
          x: 0,
          y: 0,
          z: 0,
          facing: 0,
          activity: 0,
          activityUntilTick: 0,
          name: '',
          health: 9,
          maxHealth: 16,
          poise: 0.55,
          level: 1,
          statuses: [],
        },
      ],
    });
  }, NOW);
  await page.waitForTimeout(80);
}

/** What one body's holder is really showing, measured rather than looked at. */
interface Measured {
  readonly width: number;
  readonly height: number;
  readonly healthHeight: number;
  readonly guardHeight: number;
  readonly guardShown: boolean;
  readonly levelWidth: number;
  readonly levelText: string;
  readonly levelFontPx: number;
  /**
   * How far the digits' ink sits off the middle of their box, in CSS pixels.
   * Positive is low.
   */
  readonly levelInkOffset: number;
  readonly levelOverflows: boolean;
  readonly levelRing: string;
  readonly rowMarks: number;
  readonly name: string;
  readonly isPlate: boolean;
}

async function plateOf(page: Page, id: number): Promise<Measured | null> {
  return page.evaluate((want: number) => {
    const holder = document.querySelector<HTMLElement>(`[data-entity="${want}"]`);
    if (!holder) return null;
    const track = holder.querySelector<HTMLElement>('[data-bar="health"]');
    const guard = holder.querySelector<HTMLElement>('[data-bar="guard"]');
    const plate = holder.querySelector<HTMLElement>('[data-bar="plate"]');
    const level = holder.querySelector<HTMLElement>('[data-plate-level]');
    const named = holder.querySelector<HTMLElement>('[data-name]');
    const frame = (plate ?? track)?.getBoundingClientRect();
    const trackBox = track?.getBoundingClientRect();
    const levelStyle = level ? getComputedStyle(level) : null;

    // Where the digits' *ink* sits, against the middle of the box holding it.
    //
    // Not the line box, which is what every DOM rectangle reports and is
    // exactly what cannot answer this: a line box is centred by flexbox
    // already, and the digits inside it sit above its middle by half the
    // font's descent, because a digit has no descender to fill that space
    // with. So the baseline is reconstructed from the font's own metrics and
    // the ink measured off it, which is the only way to ask a browser where
    // something *looks* like it is.
    let levelInkOffset = 0;
    if (level && levelStyle && level.firstChild) {
      const context = document.createElement('canvas').getContext('2d');
      if (context) {
        context.font = `${levelStyle.fontSize} ${levelStyle.fontFamily}`;
        const metrics = context.measureText(level.textContent ?? '');
        const box = level.getBoundingClientRect();
        // The line box is asked for rather than reconstructed from the border
        // box, which is the mistake this measurement was written with: padding
        // and flex centring both move it, so a reconstruction reports the same
        // number whatever the box does and calls a fixed nudge no fix at all.
        const range = document.createRange();
        range.selectNodeContents(level);
        const line = range.getBoundingClientRect();
        const fontAscent = metrics.fontBoundingBoxAscent;
        const fontDescent = metrics.fontBoundingBoxDescent;
        // The baseline sits one half-leading plus one ascent below the top of
        // the line box; the ink sits at its own ascent and descent either side.
        const baseline = line.top + (line.height - (fontAscent + fontDescent)) / 2 + fontAscent;
        const inkTop = baseline - metrics.actualBoundingBoxAscent;
        const inkBottom = baseline + metrics.actualBoundingBoxDescent;
        levelInkOffset = (inkTop + inkBottom) / 2 - (box.top + box.height / 2);
      }
    }

    return {
      width: frame?.width ?? 0,
      height: frame?.height ?? 0,
      healthHeight: trackBox?.height ?? 0,
      guardHeight: guard?.getBoundingClientRect().height ?? 0,
      guardShown: guard ? getComputedStyle(guard).visibility === 'visible' : false,
      levelWidth: level?.getBoundingClientRect().width ?? 0,
      levelText: level?.textContent ?? '',
      levelFontPx: levelStyle ? parseFloat(levelStyle.fontSize) : 0,
      levelInkOffset,
      // The digits against the box holding them. A level box the number spills
      // out of is the one failure a fixed width invites, and the bigger the
      // face the likelier it gets.
      levelOverflows: level ? level.scrollWidth > level.clientWidth : false,
      // Anything the box draws around the number. It carried a coloured ring
      // and now carries nothing, which is what bought the digits their size --
      // a ring that came back would cost it silently.
      levelRing: levelStyle ? levelStyle.boxShadow : '',
      // Anything left inside either row past the two bands. Both rows were
      // divided by marks and are not any more.
      rowMarks: (track ? track.children.length - 2 : 0) + (guard ? guard.children.length - 1 : 0),
      name: named?.textContent ?? '',
      isPlate: holder.dataset['plate'] === 'player',
    };
  }, id);
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });

  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  try {
    await waitForServer(`http://localhost:${PORT}/hud-probe.html`);
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 4 });
    page.on('pageerror', (error) => problems.push(String(error)));
    await page.goto(`http://localhost:${PORT}/hud-probe.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.hudProbe?.ready === true, undefined, {
      timeout: 30_000,
    });

    await stage(page);
    await page.evaluate((at) => window.hudProbe?.anchor(at), [
      PLAYER_AT,
      OTHER_AT,
      MONSTER_AT,
    ]);
    await page.waitForTimeout(120);

    console.log('the local player, level 60, 96/140, guard at 62%');
    const self = await plateOf(page, PLAYER_AT.id);
    check(self !== null, 'has a holder on screen');
    check(self?.isPlate === true, 'wears a plate rather than a bar');
    check(
      Math.abs((self?.width ?? 0) - PLATE_WIDTH) < 0.5,
      `the plate is ${PLATE_WIDTH}px wide (${(self?.width ?? 0).toFixed(1)})`,
    );
    check(
      Math.abs((self?.height ?? 0) - PLATE_HEIGHT) < 0.5,
      `and ${PLATE_HEIGHT}px tall (${(self?.height ?? 0).toFixed(1)})`,
    );
    check(
      Math.abs((self?.healthHeight ?? 0) - PLATE.healthHeight) < 0.5 &&
        Math.abs((self?.guardHeight ?? 0) - PLATE.guardHeight) < 0.5,
      'both rows came out the height they were given ' +
        `(${(self?.healthHeight ?? 0).toFixed(1)} / ${(self?.guardHeight ?? 0).toFixed(1)})`,
    );
    check(self?.guardShown === true, 'the guard row is drawn without waiting to be dented');
    check(self?.name === 'Player', `our own name is drawn (${self?.name ?? ''})`);

    // The level, at the widest number it ever holds. The box has no ring and no
    // border, which is what bought the digits their size, so both halves of
    // that are checked: the face is the one the module states, and nothing is
    // drawn around it.
    check(self?.levelText === '60', `the level box says 60 (${self?.levelText ?? ''})`);
    check(
      Math.abs((self?.levelFontPx ?? 0) - PLATE_LEVEL_PX) < 0.5,
      `set at ${PLATE_LEVEL_PX}px (${(self?.levelFontPx ?? 0).toFixed(1)})`,
    );
    check(self?.levelOverflows === false, 'and two digits still fit inside the box');
    check(
      Math.abs(self?.levelInkOffset ?? 9) <= 0.5,
      `centred in it, ink against box middle ` +
        `(${(self?.levelInkOffset ?? 0).toFixed(2)}px, positive is low)`,
    );
    check(
      self?.levelRing === 'none' || self?.levelRing === '',
      `with nothing drawn around them (${self?.levelRing ?? ''})`,
    );

    // Both rows are two bands and nothing else now.
    check(self?.rowMarks === 0, `neither row is divided (${self?.rowMarks ?? 0} extra children)`);

    console.log('another player, level 7, 24/40, guard untouched');
    const other = await plateOf(page, OTHER_AT.id);
    check(other?.isPlate === true, 'wears a plate too');
    check(other?.levelText === '7', `its level box says 7 (${other?.levelText ?? ''})`);
    check(other?.levelOverflows === false, 'and one digit fits as well as two');
    check(other?.name === 'Ada', `and their name is over it (${other?.name ?? ''})`);
    check(other?.guardShown === true, 'its guard row is drawn at a full guard');

    console.log('a monster');
    const mob = await plateOf(page, MONSTER_AT.id);
    check(mob?.isPlate === false, 'keeps the bar spec 145 shipped');
    check(mob?.levelWidth === 0, 'with no level box on it');
    check(mob?.name === '', 'and no name over it');
    check(
      Math.abs((mob?.healthHeight ?? 0) - 5) < 0.5,
      `its health track is the 5px it always was (${(mob?.healthHeight ?? 0).toFixed(1)})`,
    );

    // The picture: the band the three holders sit in, with room above for the
    // names and the status row.
    await page.screenshot({
      path: join(outDir, 'unit-plate.png'),
      clip: { x: 110, y: PLAYER_AT.y - 62, width: 650, height: 84 },
    });
    console.log(`\nwrote ${join(outDir, 'unit-plate.png')}`);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('\nall checks passed');
  }
}

await main();
