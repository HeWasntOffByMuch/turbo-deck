/**
 * Wiring the studio into the Node server (spec 108).
 *
 * The one export the entry point needs. Everything Node-only about generation
 * -- `node:fs`, `fetch`, the API key -- is reachable from here and from nothing
 * in `src/server/`'s portable half, which is the boundary that lets `GameServer`
 * still be bundled into a browser tab for single-player.
 *
 * Mounting is unconditional and spending is not: with no `TRIPO_API_KEY` the
 * routes come up and refuse, so the Studio tab gets a clear "set the key" rather
 * than a 404 that looks like a broken build.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { verifyAdminToken } from '../admin/auth.js';
import { ConfirmationStore } from './confirm.js';
import { describeConfig, loadStudioConfig, type StudioConfig } from './config.js';
import { Router, type Authorize } from './http.js';
import { StudioPipeline } from './pipeline.js';
import { studioRoutes } from './routes.js';
import { studioPaths, StudioStore } from './store.js';
import { TripoClient } from './tripo.js';

export interface StudioOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly repoRoot: string;
  /** The same secret the admin namespace verifies against. */
  readonly adminSecret: string;
  readonly log?: (message: string) => void;
}

export interface Studio {
  readonly config: StudioConfig;
  /** Returns false when the request is not ours, so the caller can handle it. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  /** Picks up anything that was mid-flight when the process last stopped. */
  resume(): void;
  stop(): void;
}

/**
 * Reads the bearer token off the request.
 *
 * Header only -- never a query parameter. A token in a URL ends up in access
 * logs, in `Referer` headers and in shell history, and this one authorises
 * spending money.
 */
function bearerOf(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function createStudio(options: StudioOptions): Studio {
  const log = options.log ?? ((message: string) => console.log(message));
  const config = loadStudioConfig(options.env, options.repoRoot);

  const store = new StudioStore(studioPaths(config.dataDir));
  const loaded = store.load();
  log(`[studio] ${describeConfig(config)}`);
  log(
    `[studio] ${loaded.jobs} job(s), ${loaded.ledger} ledger entr(ies)` +
      (loaded.skippedLedgerLines > 0 ? `, ${loaded.skippedLedgerLines} unreadable ledger line(s) skipped` : ''),
  );

  const client = new TripoClient({
    // Empty string when unset: the routes refuse before anything reaches here,
    // and a client that cannot be constructed would take the whole server down
    // over a feature nobody had switched on.
    apiKey: config.apiKey ?? '',
    baseUrl: config.baseUrl,
    fetch: (url, init) => fetch(url, init),
    webhookUrl: config.webhookUrl,
  });

  const now = (): number => Date.now();
  const pipeline = new StudioPipeline({
    client,
    store,
    config,
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
    writeArtifact: (jobId, filename, bytes) => store.writeArtifact(jobId, filename, bytes),
  });

  const authorize: Authorize = (request) => {
    const token = bearerOf(request);
    if (token === null) return { ok: false, reason: 'missing bearer token' };
    const verified = verifyAdminToken(token, options.adminSecret, now());
    return verified.ok ? { ok: true, subject: verified.claims.sub } : { ok: false, reason: verified.reason };
  };

  const router = new Router(authorize);
  const unitsDir = join(options.repoRoot, 'assets', 'units');
  for (const route of studioRoutes({
    config,
    unitsDir,
    store,
    pipeline,
    confirmations: new ConfirmationStore(),
    now,
    log,
  })) {
    router.add(route);
  }

  return {
    config,
    handle: (request, response) => router.handle(request, response),
    resume: () => {
      const pending = pipeline.resume();
      if (pending.length > 0) log(`[studio] resumed ${pending.length} in-flight job(s)`);
    },
    stop: () => pipeline.stop(),
  };
}
