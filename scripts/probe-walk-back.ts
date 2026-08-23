/**
 * Walk away and come back, in a real browser: `npx tsx scripts/probe-walk-back.ts`
 *
 * The reported bug is "went south, then north again and chunks didn't
 * re-appear". Every headless model of that path -- the cache, the store, the
 * worker core and the ingest driven together against a real server -- says the
 * ground comes back, so what is left is the half only a browser has: a real
 * worker, real frame budgets, and a real scene graph.
 *
 * Movement is an *admin teleport* rather than a held key, because walking past
 * the keep radius is 2,464 units and this container walks about 44 units a
 * second into the first of 6,942 trees.
 *
 * What it reads is `data-chunks-held` against `data-chunks-drawn`: held is what
 * the cache has, drawn is what the scene graph has, and the bug -- if it is
 * this one -- is the second failing to follow the first back.
 */

import { chromium, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { join, extname } from 'node:path';
import { readFile } from 'node:fs/promises';

import { signToken } from '../src/server/admin/auth.js';

const CHROMIUM_PATH = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];
const PORT = Number(process.env['PORT'] ?? 8813);
const PAGE_PORT = Number(process.env['PAGE_PORT'] ?? 4323);
const SECRET = 'probe-walk-back-secret';
/** Chunk extent of the shipped map, in world units. */
const EXTENT = 616;

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
  child.stderr?.on('data', (d: Buffer) => {
    const text = d.toString().trim();
    if (text) console.log(`  [server] ${text.split('\n')[0]}`);
  });
  return child;
}

function stop(child: ChildProcess): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Counts {
  held: number;
  drawn: number;
  pending: number;
  regions: number;
  diag: string;
  x: number;
  z: number;
}

async function counts(page: Page): Promise<Counts> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-chunks-held]');
    const at = document.querySelector<HTMLElement>('[data-self-at]');
    const parts = String(at?.dataset['selfAt'] ?? '0,0').split(',');
    return {
      held: Number(root?.dataset['chunksHeld'] ?? 0),
      drawn: Number(root?.dataset['chunksDrawn'] ?? 0),
      pending: Number(root?.dataset['chunksPending'] ?? 0),
      regions: Number(root?.dataset['propRegions'] ?? 0),
      diag: String(root?.dataset['propDiag'] ?? ''),
      x: Number(parts[0] ?? 0),
      z: Number(parts[1] ?? 0),
    };
  });
}

/** Wait until the stream has caught up, or give up. */
async function quiet(page: Page, ms = 20_000): Promise<Counts> {
  let last = await counts(page);
  for (let i = 0; i < ms / 500; i++) {
    await sleep(500);
    const now = await counts(page);
    if (now.pending === 0 && now.held === last.held && now.drawn === last.drawn) return now;
    last = now;
  }
  return last;
}

async function main(): Promise<void> {
  const server = run('src/server/index.ts', {
    PORT: String(PORT),
    TICK_RATE: '60',
    ADMIN_SECRET: SECRET,
  });

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
  await sleep(3000);

  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: CHROMIUM_ARGS });
  try {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const game = await context.newPage();
    game.on('pageerror', (e) => console.log(`  [page] ${e.message.slice(0, 160)}`));
    await game.goto(`http://127.0.0.1:${PAGE_PORT}/?server=ws://127.0.0.1:${PORT}`);
    await game.waitForSelector('[data-world-ready]', { timeout: 120_000 });
    console.log('  world ready');

    const home = await quiet(game);
    console.log(`  at home: held ${home.held}, drawn ${home.drawn}, regions ${home.regions}, at ${home.x},${home.z}`);

    // The admin console, for the one thing a keyboard cannot do here.
    const admin = await context.newPage();
    await admin.goto(`http://127.0.0.1:${PORT}/admin`);
    await admin.fill('#token', signToken({ sub: 'probe', role: 'admin' }, SECRET, Date.now()));
    await admin.click('#connect');
    await admin.waitForSelector('#players tbody tr', { timeout: 20_000 });
    const row = await admin.textContent('#players tbody tr');
    console.log(`  admin sees: ${row?.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
    await admin.click('#players tbody tr');

    const teleport = async (x: number, z: number): Promise<void> => {
      await admin.fill('#tpX', String(Math.round(x)));
      await admin.fill('#tpY', String(Math.round(z)));
      await admin.click('button[data-act="teleport"]');
    };

    // South, a chunk at a time, well past the keep radius.
    const legs: Counts[] = [];
    for (let step = 1; step <= 8; step++) {
      await teleport(home.x, home.z + step * EXTENT);
      const now = await quiet(game, 12_000);
      legs.push(now);
      console.log(
        `  south ${step}: held ${now.held}, drawn ${now.drawn}, pending ${now.pending},` +
          ` regions ${now.regions} [${now.diag}]`,
      );
    }

    // ...and back north the same way.
    for (let step = 7; step >= 0; step--) {
      await teleport(home.x, home.z + step * EXTENT);
      const now = await quiet(game, 12_000);
      legs.push(now);
      console.log(
        `  north ${step}: held ${now.held}, drawn ${now.drawn}, pending ${now.pending},` +
          ` regions ${now.regions} [${now.diag}]`,
      );
    }

    // Stand perfectly still for a good while: does anything the walk dropped
    // ever come back on its own?
    for (const wait of [2000, 4000, 8000]) {
      await sleep(wait);
      const now = await counts(game);
      console.log(`  after standing still ${wait}ms: regions ${now.regions} [${now.diag}]`);
    }

    const back = await counts(game);
    if (!back) throw new Error('no legs');
    check(
      'the ground came back: every chunk held is drawn',
      back.held > 0 && back.drawn >= back.held,
      `held ${back.held}, drawn ${back.drawn}`,
    );
    check(
      'the trees came back with it',
      back.regions > 0,
      `regions ${back.regions}`,
    );
    check(
      'nothing is still owed',
      back.pending === 0,
      `pending ${back.pending}`,
    );
    // The walk should not have grown what is held without bound.
    const peak = Math.max(...legs.map((l) => l.held));
    check('held stayed bounded over the walk', peak <= 81, `peak ${peak}`);

    await game.screenshot({ path: '.claude/screenshots/walk-back.png' });
    console.log('  wrote .claude/screenshots/walk-back.png');
  } finally {
    await browser.close();
    pages.closeAllConnections();
    pages.close();
    stop(server);
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
