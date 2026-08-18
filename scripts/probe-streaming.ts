/**
 * The streaming client, against a real server, in a real browser (spec 165):
 * `npx tsx scripts/probe-streaming.ts`
 *
 * `preview-world.ts` drives the loopback page, which is a tab holding the whole
 * map already. The *remote* path is the one that has to build its world out of
 * the wire, and it is the path every bug in this spec's follow-ups lived on --
 * so it needs a harness of its own rather than a query parameter on that one.
 *
 * What it asserts is one invariant and one property:
 *
 *  - **Nothing arrives and goes undrawn.** `takeMesh` dequeues what it returns,
 *    and a caller that dropped part of that list left a chunk in the streamed map
 *    with no geometry for it -- a hole in the world that never fills in, because
 *    the chunk is held and will not be offered again. That shipped, and it was
 *    invisible to the whole headless suite. `data-chunks-held` against
 *    `data-chunks-drawn` is that bug as a number.
 *
 *  - **The world is not shown until it is playable.** The load gate exists so a
 *    player never meets a half-built world; a frame drawn before the gate opens
 *    that is not the loading screen is the gate failing.
 *
 * It walks, too, because holes appear where the player goes rather than where
 * they spawn -- which is exactly how the shipped one was found.
 */

import { chromium, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';

/** The container's browser, and software GL: there is no GPU here. */
const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

const PORT = Number(process.env['PORT'] ?? 8811);
const PAGE_PORT = Number(process.env['PAGE_PORT'] ?? 4321);

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

/** See probe-admin-console.ts: `npx` leaves a grandchild holding the port. */
function run(script: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn('node_modules/.bin/tsx', [script], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', (c: Buffer) => {
    const t = c.toString().trim();
    if (t) console.log(`  [server] ${t.slice(0, 200)}`);
  });
  return child;
}

function stop(child: ChildProcess | null): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function refuseIfTaken(port: number): Promise<void> {
  // Checked for the page server as well as the game server: a leaked page
  // server is just as capable of making a run measure the previous build.
  // The lesson probe-admin-console.ts records: a run that connects to the
  // previous run's leaked server reports green while measuring older code.
  const alive = await fetch(`http://127.0.0.1:${port}/`).then(
    () => true,
    () => false,
  );
  if (alive) throw new Error(`port ${port} already answers -- a previous run leaked a server`);
}

interface Counts {
  held: number;
  drawn: number;
  pending: number;
  ready: boolean;
}

async function counts(page: Page): Promise<Counts> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-chunks-held]');
    const ready = document.querySelector<HTMLElement>('[data-world-ready]');
    return {
      held: Number(root?.dataset['chunksHeld'] ?? 0),
      drawn: Number(root?.dataset['chunksDrawn'] ?? 0),
      pending: Number(root?.dataset['chunksPending'] ?? 0),
      ready: ready !== null,
    };
  });
}

async function main(): Promise<void> {
  await refuseIfTaken(PORT);
  await refuseIfTaken(PAGE_PORT);
  const server = run('src/server/index.ts', { PORT: String(PORT), TICK_RATE: '60' });

  // Serve the built page, exactly as preview-world.ts does: what is measured
  // should be what ships.
  const { readFile } = await import('node:fs/promises');
  const { join, extname } = await import('node:path');
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.glb': 'model/gltf-binary',
  };
  const pages = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const file = join('dist', path === '/' ? 'index.html' : path.slice(1));
    readFile(file).then(
      (body) => {
        res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      },
      () => {
        res.writeHead(404);
        res.end();
      },
    );
  });
  await new Promise<void>((resolve) => pages.listen(PAGE_PORT, resolve));

  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  try {
    // Give the server its boot: it reads a 3MB map and warms its routing grids.
    await sleep(9000);

    const url = `http://127.0.0.1:${PAGE_PORT}/?server=ws://127.0.0.1:${PORT}`;
    console.log(`  loading ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // While the gate is shut the canvas must not be showing the world.
    let sawOverlayBeforeReady = false;
    for (let i = 0; i < 40; i++) {
      const state = await page.evaluate(() => ({
        ready: document.querySelector('[data-world-ready]') !== null,
        overlay: document.querySelector('[data-loading]') !== null,
        canvasHidden: document.querySelector<HTMLCanvasElement>('canvas')?.style.visibility === 'hidden',
      }));
      if (!state.ready && (state.overlay || state.canvasHidden)) sawOverlayBeforeReady = true;
      if (state.ready) break;
      await sleep(500);
    }
    check('the loading screen covered the world before it was ready', sawOverlayBeforeReady);
    console.log(`  counts at the gate: ${JSON.stringify(await counts(page))}`);

    await page.waitForSelector('[data-world-ready]', { timeout: 90_000 });
    console.log('  world ready');

    // Walk, because a hole appears where the player goes.
    for (const key of ['KeyD', 'KeyD', 'KeyS']) {
      await page.keyboard.down(key);
      await sleep(2500);
      await page.keyboard.up(key);
      await sleep(1200);
    }

    // Let the queue drain before comparing.
    let final = await counts(page);
    for (let i = 0; i < 40 && final.pending > 0; i++) {
      await sleep(500);
      final = await counts(page);
    }

    console.log(`  chunks held ${final.held}, drawn ${final.drawn}, pending ${final.pending}`);
    check('every chunk held has been drawn', final.held > 0 && final.drawn >= final.held,
      `held ${final.held}, drawn ${final.drawn}`);
    check('the mesh queue drained', final.pending === 0, `pending ${final.pending}`);

    if (errors.length > 0) {
      console.log('\npage reported errors:');
      for (const e of [...new Set(errors)]) console.log(`  ${e.slice(0, 220)}`);
    }
  } finally {
    await browser.close();
    // `close()` alone waits for keep-alive sockets the browser left behind, and
    // a probe that has finished its checks but will not exit reads exactly like
    // a probe that hung -- which is how the first run of this one was read.
    pages.closeAllConnections();
    pages.close();
    stop(server);
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  // Explicit, for the same reason: neither the server child nor a stray handle
  // may hold this process open once the answer is known.
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  // Hard exit on the failure path too. The page server and the spawned game
  // server are both live handles, so a probe that throws on its way in stays
  // resident holding its ports -- and the *next* run then dies on EADDRINUSE
  // instead of telling anybody what went wrong the first time.
  process.exit(1);
});
