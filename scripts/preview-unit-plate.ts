/**
 * The two overhead shapes, side by side, in a real browser (spec 256).
 *
 *   npx tsx scripts/preview-unit-plate.ts
 *
 * Everything spec 256 decides is asserted in Node (`world/player-plate.test.ts`)
 * and none of it is what could be wrong here. A plate is a frame with two rows
 * and a box in it, and every way it fails is a way a stylesheet fails: a row
 * negotiated down to nothing by a flex parent (which is what happened to the
 * status row until spec 186's probe caught it), marks placed at percentages of
 * a width the plate never had, a level box the digits spill out of, an inner
 * rule that does not show because the frame and the track are the same dark.
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
  healthPerSegment,
  healthTicks,
  PLATE,
  PLATE_HEIGHT,
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
          level: 7,
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
          level: 1,
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
  readonly levelOverflows: boolean;
  readonly ticks: readonly number[];
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
    // Where each mark really landed, as a fraction of the row it is on --
    // measured off the page rather than recomputed here, which is the whole
    // point of asking a browser rather than asserting in Node.
    const ticks: number[] = [];
    if (track && trackBox && trackBox.width > 0) {
      // The marks are the track's third child: ghost, then fill, then them.
      for (const mark of Array.from(track.children[2]?.children ?? [])) {
        const at = mark.getBoundingClientRect();
        ticks.push((at.x - trackBox.x) / trackBox.width);
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
      // The digits against the box holding them. A level box the number spills
      // out of is the one failure a fixed width invites.
      levelOverflows: level ? level.scrollWidth > level.clientWidth : false,
      ticks,
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

    console.log('the local player, level 7, 96/140, guard at 62%');
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
    check(self?.levelText === '7', `the level box says 7 (${self?.levelText ?? ''})`);
    check(self?.levelOverflows === false, 'and the digits fit inside it');
    check(self?.name === 'Player', `our own name is drawn (${self?.name ?? ''})`);

    // The marks, against the arithmetic. Measured off the page, so a plate that
    // laid its rows out at a width the marks were not placed against reads as
    // marks in the wrong place rather than as a passing test.
    const wanted = healthTicks(140);
    check(
      (self?.ticks.length ?? 0) === wanted.length,
      `${wanted.length} marks across the health row, one every ` +
        `${healthPerSegment(140)} health (${self?.ticks.length ?? 0})`,
    );
    const drift = Math.max(
      0,
      ...(self?.ticks ?? []).map((at, index) => Math.abs(at - (wanted[index] ?? 0))),
    );
    check(drift < 0.02, `and they land where the arithmetic says (worst ${drift.toFixed(4)})`);

    console.log('another player, level 1, 24/40, guard untouched');
    const other = await plateOf(page, OTHER_AT.id);
    check(other?.isPlate === true, 'wears a plate too');
    check(other?.levelText === '1', `its level box says 1 (${other?.levelText ?? ''})`);
    check(other?.name === 'Ada', `and their name is over it (${other?.name ?? ''})`);
    check(other?.guardShown === true, 'its guard row is drawn at a full guard');
    check(
      (other?.ticks.length ?? 0) === healthTicks(40).length,
      `a level-1 bar is marked too (${other?.ticks.length ?? 0} marks)`,
    );

    console.log('a monster');
    const mob = await plateOf(page, MONSTER_AT.id);
    check(mob?.isPlate === false, 'keeps the bar spec 145 shipped');
    check(mob?.levelWidth === 0, 'with no level box on it');
    check(mob?.ticks.length === 0, 'and no marks across it');
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
