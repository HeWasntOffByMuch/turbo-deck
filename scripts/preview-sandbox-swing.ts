/**
 * Drive the movement sandbox's authored pig, in a real browser (spec 140).
 *
 *   npm run build && npx tsx scripts/preview-sandbox-swing.ts
 *
 * `preview-sandbox.ts` photographs the tab's procedural rigs. This one exists
 * because everything spec 140 added is invisible to both of the other kinds of
 * check this repo has. The pure halves -- the grip arithmetic, the cast
 * rehearsal -- are covered in Node and say nothing about whether a sword ends up
 * in a hand. The offscreen rasteriser in `preview-weapon.ts` draws the real mesh
 * at the real pose and knows nothing about `UnitRig.attach`, the scene graph, or
 * the panel: it reimplements the grip chain as matrices.
 *
 * So the one question left is the one only a browser answers -- does
 * `attach` put the thing where `gripTransform` says, through three's own graph,
 * in the tab a person actually opens. Plus the two panel behaviours that are
 * pure DOM: switching weapons swaps rather than accumulates, and sheathing moves
 * it to the back. (That the swap does not *accumulate* is asserted in Node --
 * `unit-rig` replaces a socket's contents -- so what is checked here is that the
 * picture changes at all.)
 *
 * Serves `dist/` rather than the dev server, so what is photographed is what
 * ships. For a *close* look at the grip, `preview-weapon.ts` is the better
 * picture: this tab renders at 480x300 into a forest, which is the right frame
 * for watching a body move and the wrong one for inspecting a hand.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const PORT = 4324;

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
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server at ${url} never came up`);
}

async function shoot(page: Page, name: string): Promise<void> {
  const canvas = page.locator('canvas:visible').first();
  await canvas.screenshot({ path: join(outDir, `${name}.png`) });
  console.log(`  wrote ${name}.png`);
}

async function statusLine(page: Page): Promise<string> {
  const line = page.locator('div').filter({ hasText: /^Unit: / }).last();
  return ((await line.textContent()) ?? '(no status line)').trim();
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
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    page.on('pageerror', (error) => problems.push(String(error)));
    page.on('console', (message) => {
      // The two travel notices are `UnitRig` doing its job out loud on the pig's
      // bought walk and run clips (spec 118) -- expected, and printed at error
      // level on purpose. Everything else is a real problem.
      const text = message.text();
      if (message.type() === 'error' && !text.includes('[runner.clip.travel]') && !text.includes('travels')) {
        problems.push(text);
      }
    });

    // The built page is the game client since spec 253 and builds no tab strip at
    // all; this harness drives the Movement sandbox tab, so it asks the workbench back.
    await page.goto(`http://localhost:${PORT}/?client=workbench`, { waitUntil: 'load' });
    await page.waitForSelector('canvas');
    await page.getByRole('button', { name: 'Movement sandbox' }).click();
    await page.waitForTimeout(4000);

    // The authored unit's chip. Named off the manifest, so this is the id with
    // its underscores turned into spaces.
    await page.getByRole('button', { name: 'pig a pose full' }).click();
    // Three documents and five clip `.glb`s over a preview server, decoded by
    // software: seconds, not milliseconds.
    await page.waitForTimeout(6000);
    await shoot(page, 'swing-01-armed');
    console.log(`  armed:    ${await statusLine(page)}`);

    // Zoom in with the wheel over the canvas, which is the affordance a player
    // has (spec 042) and is far less brittle than reaching for the panel's
    // slider in a shell that keeps every hidden tab's controls mounted. The
    // sandbox opens framed for watching a gait across a field; this is a look at
    // a grip.
    const view = await page.locator('canvas:visible').first().boundingBox();
    if (!view) throw new Error('no visible canvas to zoom');
    await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
    for (let step = 0; step < 12; step += 1) {
      await page.mouse.wheel(0, -240);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(500);

    // Walk a short way, so the blend tree is doing something while the sword is
    // held -- and toward the dummy rather than away from it.
    const box = await page.locator('canvas:visible').first().boundingBox();
    if (!box) throw new Error('no visible canvas');
    await page.mouse.click(box.x + box.width / 2 + 40, box.y + box.height / 2 - 15, { button: 'right' });
    await page.waitForTimeout(700);
    await shoot(page, 'swing-02-walking');
    console.log(`  walking:  ${await statusLine(page)}`);

    // Drag the wind-up out to 1.4s before swinging. Two things at once: it is
    // the demonstration -- the clip is rescaled to the timing, so the swing
    // visibly slows -- and it is the only way to photograph the middle of a
    // swing at all, since a screenshot under software WebGL costs more wall time
    // than the shipped 800ms swing takes.
    const windup = page.locator('div').filter({ hasText: /^Wind-up \(ms\)/ }).last();
    await windup.locator('input[type=range]').fill('1400');
    console.log(`  wind-up slider now ${await windup.locator('span').last().textContent()}ms`);

    await page.getByRole('button', { name: 'Swing' }).click();
    console.log(`  swung:    ${await statusLine(page)}`);
    await shoot(page, 'swing-03-windup');
    console.log(`  wind-up:  ${await statusLine(page)}`);
    await shoot(page, 'swing-04-contact');
    console.log(`  later:    ${await statusLine(page)}`);

    // The other weapon, to prove a switch swaps rather than accumulates.
    await page.getByRole('button', { name: 'Knotted Stick' }).click();
    await page.waitForTimeout(2500);
    // Space this time, so the key binding is exercised too. The canvas is
    // clicked first so focus is not sitting on a button that would eat it.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'left' });
    await page.keyboard.press('Space');
    await page.waitForTimeout(520);
    await shoot(page, 'swing-05-stick');
    console.log(`  stick:    ${await statusLine(page)}`);

    // Sheathed: the weapon moves to the back and the hand is empty.
    await page.getByRole('button', { name: 'Jian' }).click();
    await page.waitForTimeout(2500);
    await page.getByText('Sheathed', { exact: false }).click();
    await page.waitForTimeout(600);
    await shoot(page, 'swing-06-sheathed');
    console.log(`  sheathed: ${await statusLine(page)}`);

  } finally {
    await browser.close();
    server.kill();
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} console/page error(s):`);
    for (const problem of problems.slice(0, 12)) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n  no page errors');
}

main();
