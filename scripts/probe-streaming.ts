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
  /** Prop batching regions on the scene graph (spec 215). */
  regions: number;
  ready: boolean;
}

interface Perf {
  fps: number;
  worstMs: number;
  stalls: number;
  /** Worst *streaming* cost seen, which is the part this repo can fix. */
  worstWorkMs: number;
}

/**
 * Watch the shipped frame meter for a while and report what it saw.
 *
 * Read off the meter the game already draws rather than timing from outside:
 * what a player calls "not smooth" is the game's own frame cadence, and a
 * number measured anywhere else is a number about the harness.
 */
async function measure(page: Page, forMs: number, label: string): Promise<Perf> {
  const start = Date.now();
  let worst = 0;
  let stalls = 0;
  let fps = 0;
  let worstWork = 0;
  let stage = '';
  let stageMs = 0;
  let calls = 0;
  let tris = 0;
  while (Date.now() - start < forMs) {
    await sleep(500);
    const now = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-fps-value]');
      return {
        fps: Number(el?.dataset['fpsValue'] ?? 0),
        worstMs: Number(el?.dataset['fpsWorst'] ?? 0),
        stalls: Number(el?.dataset['fpsStalls'] ?? 0),
        workMs: Number(el?.dataset['fpsWork'] ?? 0),
        stage: String(el?.dataset['fpsWorstStage'] ?? ''),
        stageMs: Number(el?.dataset['fpsWorstStageMs'] ?? 0),
        calls: Number(el?.dataset['fpsDrawCalls'] ?? 0),
        tris: Number(el?.dataset['fpsTriangles'] ?? 0),
      };
    });
    fps = now.fps;
    worst = Math.max(worst, now.worstMs);
    stalls = Math.max(stalls, now.stalls);
    worstWork = Math.max(worstWork, now.workMs);
    calls = now.calls;
    tris = now.tris;
    if (now.stageMs > stageMs) {
      stageMs = now.stageMs;
      stage = now.stage;
    }
  }
  console.log(
    `  ${label}: ${fps.toFixed(0)} fps, worst frame ${worst.toFixed(0)}ms, ` +
      `worst streaming cost ${worstWork.toFixed(0)}ms (${stage} ${stageMs.toFixed(0)}ms), ${stalls} stalls, ` +
      `${calls} draws / ${(tris / 1000).toFixed(0)}k tris`,
  );
  return { fps, worstMs: worst, stalls, worstWorkMs: worstWork };
}

async function counts(page: Page): Promise<Counts> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-chunks-held]');
    const ready = document.querySelector<HTMLElement>('[data-world-ready]');
    return {
      held: Number(root?.dataset['chunksHeld'] ?? 0),
      drawn: Number(root?.dataset['chunksDrawn'] ?? 0),
      pending: Number(root?.dataset['chunksPending'] ?? 0),
      regions: Number(root?.dataset['propRegions'] ?? 0),
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

    // `PERF=noworker` runs the load on the main thread, as it did before spec
    // 176. The point of it is that the two are then one command apart on one
    // machine, which is the only honest way to say what moving the load bought
    // -- this container's frame *rate* transfers nowhere, but the streaming cost
    // it measures is main-thread work and is the same work everywhere.
    const perf = process.env['PERF'] ?? '';
    const url =
      `http://127.0.0.1:${PAGE_PORT}/?server=ws://127.0.0.1:${PORT}` +
      (perf === '' ? '' : `&perf=${perf}`);
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

    // Standing perfectly still, right after the gate lifts -- the window the
    // report is about ("the first 2000 ticks are not smooth even standing
    // still"). Nothing is pressed; every frame here is the streaming tail and
    // whatever it triggers.
    const settle = await measure(page, 20_000, 'standing still after load');

    // Walk, because a hole appears where the player goes.
    for (const key of ['KeyD', 'KeyD', 'KeyS']) {
      await page.keyboard.down(key);
      await sleep(2500);
      await page.keyboard.up(key);
      await sleep(1200);
    }

    // After walking, which re-opens the stream: this is not the idle state and
    // is not asserted against, but it is what ordinary play looks like.
    const steady = await measure(page, 15_000, 'after walking');

    // Let the queue drain before comparing.
    let final = await counts(page);
    for (let i = 0; i < 40 && final.pending > 0; i++) {
      await sleep(500);
      final = await counts(page);
    }

    console.log(
      `  chunks held ${final.held}, drawn ${final.drawn}, pending ${final.pending},` +
        ` prop regions ${final.regions}`,
    );
    check('every chunk held has been drawn', final.held > 0 && final.drawn >= final.held,
      `held ${final.held}, drawn ${final.drawn}`);
    // The trees, in a real browser (spec 215). Not the eviction itself -- this
    // walk is a few seconds and the keep radius is four chunks, so nothing has
    // gone yet -- but that the field is drawing regions at all *and* that the
    // count is a small one rather than a region per chunk, which is what a
    // reconcile reading the wrong grid would produce.
    check(
      'the prop field is drawing a handful of regions, not one per chunk',
      final.regions > 0 && final.regions < final.held,
      `regions ${final.regions}, chunks ${final.held}`,
    );
    check('the mesh queue drained', final.pending === 0, `pending ${final.pending}`);

    // A frame budget rather than a target: this container paints through
    // software GL at a handful of frames a second, so the *rate* here says
    // nothing about a real machine. What does carry over is a single frame far
    // longer than the rest -- that is main-thread work, and it is the same work
    // on any machine.
    // Measured against the *streaming* cost, not the frame time. This container
    // paints through software GL at a few frames a second, so its frame times
    // say nothing about a real machine -- but the main-thread work the loader
    // does is the same work everywhere, and it is the only half this repo can
    // do anything about.
    check(
      'the loader never took a sixth of a second of a frame after load',
      settle.worstWorkMs < 160,
      `worst streaming cost ${settle.worstWorkMs.toFixed(0)}ms`,
    );
    console.log(
      `  the load ran ${perf.includes('noworker') ? 'on the main thread' : 'on a worker'}` +
        ` (PERF=noworker to compare)`,
    );
    // Not asserted: `steady` is measured after the walk, when the stream has
    // legitimately re-opened. The idle claim belongs to `settle`, above.
    void steady;

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
