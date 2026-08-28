/**
 * Does the player actually hold the thing they have equipped? (spec 165)
 *
 *   npm run build && npx tsx scripts/probe-held-weapon.ts
 *
 * Everything about the grip that can be asserted in Node already is:
 * `grip.ts`'s arithmetic, `weapon-look.ts`'s table, `weapon-attach.test.ts`'s
 * socket resolution, and `preview-weapon.ts` draws the whole chain into a PNG.
 * What none of them can say is whether **the Play tab calls any of it**, and
 * that is exactly the shape of the bug this spec fixes: `weapon-rig.ts`,
 * `weapon-assets.ts` and the socket calibration have all existed since spec 140,
 * with a complete set of green tests, beside a game that drew every player
 * empty-handed because `scene.ts` never called `setSockets` and never built a
 * `WeaponRig`.
 *
 * So this drives the shipped page, clicks the real weapon switch, and reads back
 * what is hanging off a bone -- `data-held-weapons`, published from the scene
 * graph's own state rather than from the intent, so a weapon that was fetched
 * and attached to nothing reads as absent rather than as present.
 *
 * Serves `dist/` rather than the dev server, for the reason `preview-world.ts`
 * gives: what is photographed should be what ships.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4321;

/**
 * A Chromium to drive, the same rule `preview-world.ts` states: prefer the one
 * already on the box, because an agent container ships a build at
 * `PLAYWRIGHT_BROWSERS_PATH` that need not match the version this Playwright
 * would go and download.
 */
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';

/** What each switch button should put in which socket, once it is clicked. */
const EXPECTED: readonly { readonly itemId: string; readonly held: string }[] = [
  { itemId: 'sword.worn', held: 'weapon.main=sword_jian' },
  { itemId: 'bow.hunting', held: 'weapon.off=bow_recurve' },
  // The stars have no mesh, so the correct answer is empty hands -- and this row
  // is here because "nothing is drawn" has to be a *checked* outcome rather than
  // the same silence a broken attach produces.
  { itemId: 'stars.weighted', held: '' },
];

/** Polls until the preview server answers. Spawning it is not starting it. */
async function waitForServer(url: string, attempts = 60): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} never answered`);
}

async function heldWeapons(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.querySelector('[data-world-ready]') as HTMLElement | null;
    return element?.dataset['heldWeapons'] ?? '<no readout>';
  });
}

/**
 * Waits for the readout to reach `expected`, then checks it stayed there.
 *
 * Both halves are needed and the first version had neither right. It settled on
 * "two consecutive polls agree", which an equip round trip and a mesh fetch can
 * both be inside of -- so it reported empty hands for a bow that turned up 200ms
 * later, and the failure it invented was more convincing than the real one. And
 * it cannot only wait, because one of the expectations *is* empty hands: a
 * stale weapon still hanging off the bone would satisfy an impatient poll for
 * "" the instant the drop happened and before the wrong thing came back.
 */
async function heldAfterSettling(page: Page, expected: string, attempts = 40): Promise<string> {
  let last = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await heldWeapons(page);
    if (last === expected) break;
    await page.waitForTimeout(250);
  }
  // And it is still there a beat later, rather than having been passed through.
  await page.waitForTimeout(750);
  return heldWeapons(page);
}

async function main(): Promise<void> {
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    console.error('  no dist/ -- run `npm run build` first');
    process.exitCode = 1;
    return;
  }
  await mkdir(outDir, { recursive: true });

  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const failures: string[] = [];

  try {
    const browser = await chromium.launch({
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
      ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
    });
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(`http://localhost:${PORT}/?seed=7`);
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 30_000 });
    // The body's own mesh has to be in before anything can hang off it: `attach`
    // resolves a *bone*, and there is no bone until the .glb has decoded.
    await page.waitForFunction(
      () => Number((document.querySelector('[data-world-ready]') as HTMLElement | null)?.dataset['authoredUnits'] ?? 0) > 0,
      undefined,
      { timeout: 30_000 },
    );

    // What a fresh character is already holding, before anything is clicked.
    // `STARTING_KIT` equips the worn sword, so an empty hand here means the
    // whole path is dead rather than that the switch is broken.
    const initial = await heldAfterSettling(page, 'weapon.main=sword_jian');
    console.log(`  on arrival: ${initial === '' ? '(empty hands)' : initial}`);
    if (initial !== 'weapon.main=sword_jian') {
      failures.push(`a fresh character equips the worn sword, and the scene held "${initial}"`);
    }
    await page.screenshot({ path: join(outDir, 'held-sword.png') });

    for (const want of EXPECTED) {
      const button = await page.$(`[data-weapon="${want.itemId}"]`);
      if (!button) {
        failures.push(`the weapon switch has no button for ${want.itemId}`);
        continue;
      }
      await button.click();
      const held = await heldAfterSettling(page, want.held);
      const shown = held === '' ? '(empty hands)' : held;
      console.log(`  ${want.itemId.padEnd(16)} -> ${shown}`);
      if (held !== want.held) {
        failures.push(`${want.itemId} should hold "${want.held || '(nothing)'}" and held "${shown}"`);
      }
      if (want.itemId === 'bow.hunting') await page.screenshot({ path: join(outDir, 'held-bow.png') });
    }

    // Back to the sword, because the switch-then-switch-back path is the one
    // with the race in it: a mesh still in flight when the next click lands.
    const sword = await page.$('[data-weapon="sword.worn"]');
    if (sword) {
      await sword.click();
      await page.waitForTimeout(120);
      const bow = await page.$('[data-weapon="bow.hunting"]');
      await bow?.click();
      const held = await heldAfterSettling(page, 'weapon.off=bow_recurve');
      console.log(`  after a fast switch back and forth: ${held === '' ? '(empty hands)' : held}`);
      if (held !== 'weapon.off=bow_recurve') {
        failures.push(`a fast switch left "${held}" rather than the bow -- a stale fetch won the race`);
      }
    }

    // The two `Hip travels` lines are the root-motion importer reporting what
    // it stripped, on clips that have carried that notice since spec 118. They
    // are documented, accepted and printed on every load, so they are not a
    // finding of this probe -- but everything else is, including the
    // `[items] ...` line this spec added, which is the one that says a weapon
    // was wanted and never arrived.
    const unexpected = consoleErrors.filter(
      (message) => !/failed to load resource|net::ERR_|travels .* over the clip/i.test(message),
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
  console.log('\n  the equipped weapon is in the hand, and the switch changes which one');
}

void main();
