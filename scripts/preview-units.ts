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

/**
 * Every monster the arena spawns, all drawn from the one authored unit.
 *
 * Which unit is an argument since spec 277, because there is more than one now
 * and the `.glb` this repo writes by hand is exactly what this script exists to
 * put in front of three's own loader -- a second authored rig that nothing ever
 * drove through a browser would be the risk this file's header describes,
 * unchecked again.
 */
const UNIT = process.argv[2] ?? process.env['UNIT'] ?? 'mannequin';
/** How many bones the unit under test has, which is what proves it is the one drawn. */
const EXPECTED_BONES = Number(process.argv[3] ?? process.env['BONES'] ?? 25);
const UNITS = ['grazer', 'stalker', 'ravager', 'slinger', 'dummy']
  .map((id) => `${id}:${UNIT}`)
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
    const readout = async (): Promise<{ loaded: number; bones: string; states: string }> =>
      page.evaluate(() => {
        const root = document.querySelector('[data-world-ready]') as HTMLElement | null;
        return {
          loaded: Number(root?.dataset['authoredUnits'] ?? 0),
          bones: root?.dataset['authoredBones'] ?? '',
          states: root?.dataset['authoredStates'] ?? '',
        };
      });
    const drawn = (bones: string): boolean => bones.split(',').includes(String(EXPECTED_BONES));

    const before = await readout();
    await page.waitForTimeout(1500);
    const after = await readout();

    if (after.loaded === 0) {
      failures.push('no authored unit was built -- the .glb never loaded, or the catalogue never matched a monster');
    } else {
      console.log(`  ${after.loaded} authored bod(ies), bone counts on screen: ${after.bones}`);
      // The player and the three shopkeepers are authored bodies by default
      // (specs 246, 247), so a count is not evidence and neither is the largest
      // rig in the frame. What is asked is whether *this* unit's own bone count
      // is among the ones being drawn.
      if (!drawn(after.bones)) {
        failures.push(`no ${EXPECTED_BONES}-bone rig on screen -- ${UNIT} did not load. Counts drawn: ${after.bones || 'none'}`);
      }
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

    // Take the title screen away before photographing (spec 255). The world is
    // mounted and running behind it -- which is why the readout above is valid
    // either way -- but a screenshot of the front door is a screenshot of the
    // front door, and this script's whole job is a picture of the unit.
    await page.evaluate(() => document.querySelector<HTMLElement>('[data-title-entry="start"]')?.click());
    await page.waitForTimeout(2500);
    const shot = UNIT === 'mannequin' ? 'units.png' : `units-${UNIT}.png`;
    await page.screenshot({ path: join(outDir, shot) });
    console.log(`  wrote ${join('.claude', 'screenshots', shot)}`);

    // --- and the arena is unchanged without the switch ----------------------
    await page.goto(`http://localhost:${PORT}/?seed=7`);
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 30_000 });
    await page.waitForTimeout(6000);
    const plain = await page.evaluate(() => {
      const root = document.querySelector('[data-world-ready]') as HTMLElement | null;
      return root?.dataset['authoredBones'] ?? '';
    });
    // Not "no authored bodies": the player is one and so are the shopkeepers.
    // What must be gone is the rig the switch put there.
    if (drawn(plain)) {
      failures.push(`a ${EXPECTED_BONES}-bone rig is still drawn with the switch off -- the Play tab did not stay unchanged`);
    }

    // `[units] ... travels ... over the clip` is the importer saying it took
    // root motion out of a bought clip, which is a correction it is *supposed*
    // to make: `validate-units.ts` reports the same finding as a warning, and
    // the two biped clips that carry it have carried it since they were bought.
    // It reaches the console at error level and started reaching this page when
    // the player became an authored body (spec 246), which is what has had this
    // script red on every unit including its own.
    const unexpected = consoleErrors.filter(
      (message) => !/failed to load resource|net::ERR_/i.test(message) && !/\[units\].*travels .* over the clip/.test(message),
    );
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
