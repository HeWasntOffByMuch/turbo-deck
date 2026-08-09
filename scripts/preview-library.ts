/**
 * Preview a generated unit from the library, in a real browser (spec 112).
 *
 *   npx tsx scripts/preview-library.ts
 *
 * The flow this checks did not exist until now: a job finished, appeared in the
 * library as a paragraph of text, and there it stopped. You could not look at
 * what you had paid for, and Export -- which refuses to invent a clip duration
 * or a state machine, both correctly -- had nothing to write.
 *
 * None of that can be checked in Node. The clip lengths come out of a `.glb`
 * three has decoded, the import scale comes out of a bounding box three has
 * measured, and the documents are derived from both. So this stands up a real
 * authoring server over a seeded job, drives the real page, clicks the real
 * button, and asserts the panel came back with a scaffolded machine.
 *
 * The seeded job points at the committed reference `.glb`s rather than anything
 * generated: the question here is whether the *plumbing* works, and paying Tripo
 * to answer it would be an odd way to test a button.
 *
 * Deliberately does **not** click Export. Export writes into `assets/units/` in
 * this repo, and a preview script that leaves files behind in a working tree is
 * a preview script people stop running. The export path is covered in Node, in
 * `src/server/studio/export.test.ts`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { signToken } from '../src/server/admin/auth.js';
import { cacheKey } from '../src/server/studio/cache.js';
import type { GenerationParams, Job } from '../src/server/studio/types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.claude', 'screenshots');
const API_PORT = 8791;
const WEB_PORT = 4331;
const SECRET = 'preview-library-secret';
const UNIT_ID = 'seeded-grunt';

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

const devGlb = (name: string): string => join(root, 'assets', 'units', 'dev', name);

/** A job that looks exactly like a finished generation, pointing at real files. */
function seededJob(): Job {
  const params: GenerationParams = {
    modelVersion: 'P1-local',
    faceLimit: 2000,
    texture: true,
    pbr: false,
    clipIntents: ['idle', 'walk', 'run', 'slash'],
    outFormat: 'glb',
  };
  const done = (stage: string) =>
    ({
      stage,
      taskId: `task-${stage}`,
      status: 'done',
      creditsConsumed: 0,
      startedAtMs: 0,
      finishedAtMs: 1,
      error: null,
    }) as Job['steps'][number];

  return {
    id: 'seeded-job-0001',
    unitId: UNIT_ID,
    skeletonId: 'biped',
    establishesRigFamily: true,
    cacheKey: cacheKey('b'.repeat(64), params),
    rigType: 'biped',
    inFlight: {},
    referenceImageSha256: 'b'.repeat(64),
    params,
    status: 'succeeded',
    stage: null,
    steps: ['imageToModel', 'rigCheck', 'rig', 'retarget', 'download'].map(done),
    creditsSpent: 125,
    createdAtMs: 1,
    updatedAtMs: 2,
    message: null,
    artifacts: {
      meshGlb: devGlb('mannequin.glb'),
      riggedGlb: devGlb('mannequin.glb'),
      // The clip ids are preset intents, which is what a real retarget produces.
      clipGlbs: {
        idle: devGlb(join('clips', 'idle.glb')),
        walk: devGlb(join('clips', 'walk.glb')),
        run: devGlb(join('clips', 'run.glb')),
        slash: devGlb(join('clips', 'attack.glb')),
      },
    },
  };
}

async function waitForServer(url: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`nothing answered at ${url}`);
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-library-'));
  writeFileSync(join(dataDir, 'jobs.json'), `${JSON.stringify({ jobs: [seededJob()] }, null, 2)}\n`);

  const failures: string[] = [];
  const processes: ChildProcess[] = [];

  try {
    processes.push(
      spawn('npx', ['tsx', 'src/server/index.ts'], {
        cwd: root,
        stdio: 'ignore',
        env: { ...process.env, PORT: String(API_PORT), ADMIN_SECRET: SECRET, STUDIO_DATA_DIR: dataDir },
      }),
      spawn('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], {
        cwd: root,
        stdio: 'ignore',
        env: { ...process.env, STUDIO_SERVER: `http://localhost:${API_PORT}` },
      }),
    );

    await waitForServer(`http://localhost:${API_PORT}/`);
    await waitForServer(`http://localhost:${WEB_PORT}/`);

    const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`uncaught: ${error.message}`));

    await page.goto(`http://localhost:${WEB_PORT}/`);
    await page.getByRole('button', { name: 'Studio', exact: true }).click();
    await page.waitForTimeout(2500);

    await page.locator('input[type=password]').fill(signToken({ sub: 'dev', role: 'admin' }, SECRET, Date.now()));
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.waitForTimeout(2500);

    const text = await page.locator('#app').innerText();
    if (!text.includes(UNIT_ID)) {
      failures.push(`the seeded job is not in the library. Panel said: ${text.slice(0, 400)}`);
    }

    // --- the button this whole spec is about --------------------------------
    const previewButton = page.getByRole('button', { name: 'Preview', exact: true });
    if ((await previewButton.count()) === 0) {
      failures.push('no Preview button on the library card');
    } else {
      await previewButton.first().click();
      // Long enough to fetch four clips through the authenticated client, decode
      // them, measure, derive the documents and rebuild the panels.
      await page.waitForTimeout(6000);

      const after = await page.locator('#app').innerText();
      const stats = /(\d+) triangles, (\d+) bones, (\d+) vertices/.exec(after);
      if (!stats) {
        failures.push(`the preview reported no model stats -- it did not load. Panel said: ${after.slice(-1200)}`);
      } else {
        console.log(`  previewed ${UNIT_ID}: ${stats[1]} triangles, ${stats[2]} bones, ${stats[3]} vertices`);
        if (Number(stats[2]) !== 25) failures.push(`expected 25 bones, got ${stats[2]}`);
      }

      // The seeded job *is* the reference mannequin, whose correct import scale
      // was measured off its own rig and committed as 32.35. So this is the one
      // case where the fitted scale has a known right answer, and it is worth
      // asserting: every generated unit's size comes out of the same
      // measurement, and one that is 15% out looks plausible on its own and
      // wrong the moment it stands next to a player.
      const scale = /import scale ([\d.]+)/.exec(after);
      if (!scale) {
        failures.push('the panel does not report the import scale it measured');
      } else {
        const measured = Number(scale[1]);
        console.log(`  fitted import scale ${measured} (committed: 32.35)`);
        if (Math.abs(measured - 32.35) > 0.5) {
          failures.push(`fitToHeight measured ${measured} for a rig whose committed scale is 32.35 -- generated units will be the wrong size`);
        }
      }

      // The scaffold: a machine derived from which clips exist, not the
      // reference unit's. `slash` is in the seeded set, so there is a swing.
      for (const [needle, why] of [
        [UNIT_ID, 'the caption does not name the unit being previewed'],
        ['locomotion', 'no locomotion state -- the scaffold did not build a blend'],
        ['swing', 'no swing state -- the scaffold did not find the attack clip'],
        ['basic.attack', 'no action timing was scaffolded'],
      ] as const) {
        if (!after.includes(needle)) failures.push(why);
      }

      // Derived from the *measured* clip lengths, so the reference unit's own
      // numbers appearing here would mean the placeholder was never replaced.
      if (!/slash/.test(after)) failures.push('the clip list does not name the retargeted clips');
      if (/mannequin/.test(after) && !after.includes(UNIT_ID)) {
        failures.push('the panel is still showing the reference unit');
      }
    }

    // Scrolled into view first. The tab shell scrolls inside a fixed-height
    // container, so `fullPage` captures the viewport and nothing below it -- a
    // screenshot of this flow that stops above the preview is a screenshot of
    // the wrong thing.
    await page.evaluate(() => {
      const headings = Array.from(document.querySelectorAll('h2'));
      headings.find((node) => /preview/i.test(node.textContent ?? ''))?.scrollIntoView();
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, 'studio-library.png') });
    console.log(`  wrote ${join('.claude', 'screenshots', 'studio-library.png')}`);

    const unexpected = consoleErrors.filter((message) => !/failed to load resource|net::ERR_/i.test(message));
    for (const message of unexpected) failures.push(`console error: ${message}`);

    await browser.close();
  } finally {
    for (const child of processes) child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('a generated unit previews from the library, scaffolded from its own clips');
}

await main();
