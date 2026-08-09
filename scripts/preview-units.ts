/**
 * Put an authored unit in the arena and photograph it (spec 111).
 *
 *   npm run build && npx tsx scripts/preview-units.ts
 *
 * Everything else about this system is checked in Node: the machine's ticks and
 * events, the driver's edge detection, the LOD's cadence, the parser's refusals,
 * the invariance of the authoritative state. All of it can be green while the
 * game draws nothing at all, because the half that is left is a `.glb` fetched
 * over HTTP, decoded by three's `GLTFLoader`, skinned by a shader, and posed by
 * a mixer -- and none of those exist in a headless test.
 *
 * That is not a hypothetical gap. The mesh this repo writes is written by hand,
 * and the last time an assumption about it went unchecked it was the single
 * riskiest thing in the pipeline. So this drives the real page with `?units=`
 * on, waits for a monster to be in frame, and asserts the thing a screenshot
 * would show: a skinned mesh, in the scene, with bones in it, moving.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4327;
const VIEWPORT = { width: 1280, height: 800 };

/** Every monster the arena spawns, all drawn from the one authored unit. */
const UNITS = ['grazer', 'stalker', 'ravager', 'slinger', 'dummy']
  .map((id) => `${id}:mannequin`)
  .join(',');

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
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

async function main(): Promise<void> {
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    throw new Error('no dist/ -- run `npm run build` first');
  }
  await mkdir(outDir, { recursive: true });

  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const failures: string[] = [];

  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });
    const page = await browser.newPage({ viewport: VIEWPORT });

    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`uncaught: ${error.message}`));

    // A pinned seed so a re-run is the same arena, and the roster switched on.
    await page.goto(`http://localhost:${PORT}/?seed=7&units=${UNITS}`);
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 30_000 });
    // Long enough for the monsters to spawn, the clips to fetch and the mixer
    // to have been handed a few hundred poses.
    await page.waitForTimeout(9000);

    // --- was a skinned mesh actually built, and is it being posed? ----------
    //
    // Read off the renderer's own readout rather than off pixels: "the screen
    // is not black" is satisfied by a ground plane. What is being asked is
    // whether a *skinned* body exists with the right bone count and whether its
    // machine is advancing, which are the two things a headless test cannot see.
    const readout = async (): Promise<{ loaded: number; bones: number; states: string }> =>
      page.evaluate(() => {
        const root = document.querySelector('[data-world-ready]') as HTMLElement | null;
        return {
          loaded: Number(root?.dataset['authoredUnits'] ?? 0),
          bones: Number(root?.dataset['authoredBones'] ?? 0),
          states: root?.dataset['authoredStates'] ?? '',
        };
      });

    const before = await readout();
    await page.waitForTimeout(1500);
    const after = await readout();

    if (after.loaded === 0) {
      failures.push('no authored unit was built -- the .glb never loaded, or the catalogue never matched a monster');
    } else {
      console.log(`  ${after.loaded} authored bod(ies), ${after.bones} bones`);
      if (after.bones !== 25) failures.push(`expected 25 bones on the mixamo contract, got ${after.bones}`);
      // The machine tick is in the readout, so a state string that did not move
      // means nothing is being driven at all.
      if (before.states !== '' && before.states === after.states) {
        failures.push(`the machines did not advance in 1.5s: still "${after.states.slice(0, 80)}"`);
      }
      // And it is actually animating rather than standing in the entry state.
      if (!/idle|locomotion|swing|down/.test(after.states)) {
        failures.push(`no recognised state in the readout: "${after.states.slice(0, 80)}"`);
      }
    }

    await page.screenshot({ path: join(outDir, 'units.png') });
    console.log(`  wrote ${join('.claude', 'screenshots', 'units.png')}`);

    // --- and the arena is unchanged without the switch ----------------------
    await page.goto(`http://localhost:${PORT}/?seed=7`);
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 30_000 });
    await page.waitForTimeout(6000);
    const plain = await page.evaluate(() => {
      const root = document.querySelector('[data-world-ready]') as HTMLElement | null;
      return Number(root?.dataset['authoredUnits'] ?? 0);
    });
    if (plain !== 0) failures.push(`${plain} authored bodies with the switch off -- the Play tab did not stay unchanged`);

    const unexpected = consoleErrors.filter((message) => !/failed to load resource|net::ERR_/i.test(message));
    for (const message of unexpected) failures.push(`console error: ${message}`);

    await browser.close();
  } finally {
    server.kill();
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('an authored unit stands in the arena, skinned and posed, and is absent without the switch');
}

await main();
