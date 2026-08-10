/**
 * Is the weapon in the hand, in the real page? (spec 121)
 *
 * `probe-attach.ts` settles the geometry offscreen: the socket resolves and
 * what hangs off it is the size it was authored. What it cannot settle is
 * whether the thing is *there* once the whole client is running -- the weapon
 * is built from an item id that has to survive the wire, the replica, the view
 * and a body that loads its mesh asynchronously, and every one of those can
 * drop it while every offscreen measurement stays right.
 *
 * So this drives the built page, switches weapons through the real HUD, and
 * reads back what is actually parented to the rig's hand. The screenshots are
 * for a person; the assertions are what fails the script.
 *
 * The player's torch is turned off first, because a body standing in its own
 * light is a white blob and the whole point here is to see a silhouette.
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
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`server at ${url} never came up`);
}

async function waitForTick(page: Page, ticks: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    const text = (await page.textContent('body')) ?? '';
    last = Number(/tick (\d+)/.exec(text)?.[1] ?? -1);
    if (last >= ticks) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`sim never reached tick ${ticks} (last seen: ${last})`);
}

/**
 * What is hanging off the local player's `weapon.main`, read out of the scene.
 *
 * The mesh is named `weapon.<kind>` by `buildWeapon`, so this reports the kind
 * without needing the page to expose anything it would not otherwise have.
 */
async function heldWeapon(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-authored-weapons]');
    return root?.dataset['authoredWeapons'] || 'nothing';
  });
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });

  const problems: string[] = [];
  try {
    await waitForServer(`http://localhost:${PORT}/`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', (error) => problems.push(String(error)));

    await page.goto(`http://localhost:${PORT}/?seed=20260806`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    await page.waitForSelector('[data-world-ready="true"]', { timeout: 60_000 });
    await waitForTick(page, 150);

    // The torch off: a body standing in its own light photographs as a blob,
    // and the silhouette is the entire thing being looked at here. Unchecked by
    // its label rather than by position -- the popover has several checkboxes
    // and the first one is not the one that matters.
    await page.click('button[aria-label="Player lights"]').catch(() => undefined);
    await page.waitForTimeout(250);
    const torch = page.getByLabel('Torch', { exact: true });
    if ((await torch.count()) > 0) await torch.uncheck().catch(() => undefined);
    await page.click('button[aria-label="Player lights"]').catch(() => undefined);
    await page.waitForTimeout(400);

    for (const [label, item] of [
      ['Worn Sword', 'sword'],
      ['Hunting Bow', 'bow'],
      ['Weighted Stars', 'thrown'],
    ] as const) {
      const button = page.locator(`[data-weapon][aria-label="${label}"]`);
      if ((await button.count()) === 0) {
        problems.push(`no weapon button called "${label}"`);
        continue;
      }
      await button.click();
      // Polled, not waited on. The equip is a round trip -- the server
      // re-derives, the next delta carries the id, the renderer rebuilds -- and
      // a fixed wait read the *previous* weapon on every switch, which looks
      // exactly like a renderer one frame behind rather than a harness reading
      // too early.
      const deadline = Date.now() + 8000;
      let held = await heldWeapon(page);
      while (Date.now() < deadline && !held.includes(item)) {
        await page.waitForTimeout(200);
        held = await heldWeapon(page);
      }
      console.log(`  ${label.padEnd(15)} -> ${held}`);
      if (!held.includes(item)) {
        problems.push(`picked ${label} and the hand holds "${held}", expected a ${item}`);
      }
      // Cropped to the middle of the frame, where the local player stands. A
      // full 1280x800 of forest with a 40-pixel body in it shows nothing about
      // a weapon; this is the picture somebody can actually judge.
      await page.screenshot({
        path: join(outDir, `weapon-${item}.png`),
        clip: { x: 530, y: 210, width: 260, height: 260 },
      });
    }
    console.log(`  wrote ${outDir}/weapon-*.png`);
  } finally {
    await browser.close();
    server.kill();
  }

  if (problems.length > 0) {
    console.error(`\nFAIL\n${problems.map((line) => `  - ${line}`).join('\n')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nOK: the switch changes what is in the hand.');
}

await main();
