/**
 * The studio API (spec 108): `/api/studio/*`.
 *
 * Every route that could spend money is behind the existing HMAC admin verifier
 * -- the same gate the admin namespace uses -- because "it is only on localhost"
 * stops being true the first time somebody port-forwards a dev box, and what is
 * behind this door is a payment method.
 *
 * The shape of the spend path is two calls, and it is two on purpose:
 *
 *   POST /estimate  ->  a projection, and a one-shot token that authorises it
 *   POST /jobs      ->  redeems the token, then submits
 *
 * A client that never asked for a price has no token to send. A form submitted
 * twice redeems a token that is already gone. And the projection the ceilings
 * are checked against is the one the server issued, not a number the browser
 * sent back -- which it could have edited.
 */

import { randomUUID } from 'node:crypto';
import { canonicalClipIntents, cacheKey } from './cache.js';
import { ConfirmationStore } from './confirm.js';
import type { StudioConfig } from './config.js';
import { readBody, readJsonBody, sendJson, type RequestContext, type Route } from './http.js';
import { cacheHit, createJob } from './jobs.js';
import { summarize } from './ledger.js';
import type { StudioPipeline } from './pipeline.js';
import { projectCost, projectRemaining } from './pricing.js';
import type { StudioStore } from './store.js';
import { knownPresetsFor, unknownPresets } from './tripo.js';
import type { GenerationParams, Job } from './types.js';

/** A reference image is a picture, not a payload. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024;

export interface RouteDeps {
  readonly config: StudioConfig;
  /** Where `assets/units/` lives, so Export knows what "the repo" means. */
  readonly unitsDir: string;
  readonly store: StudioStore;
  readonly pipeline: StudioPipeline;
  readonly confirmations: ConfirmationStore;
  readonly now: () => number;
  readonly log?: (message: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asStringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function paramsFrom(body: Record<string, unknown>, config: StudioConfig): GenerationParams {
  const rawClips = body['clipIntents'];
  const clipIntents = Array.isArray(rawClips)
    ? canonicalClipIntents(rawClips.filter((entry): entry is string => typeof entry === 'string'))
    : [];
  const faceLimit = typeof body['faceLimit'] === 'number' ? body['faceLimit'] : config.defaultFaceLimit;
  return {
    modelVersion: config.modelVersion,
    faceLimit,
    // Texture on, PBR off, per the brief. Fixed rather than client-supplied:
    // they change the price and the look, and neither is a per-request whim.
    texture: true,
    pbr: false,
    clipIntents,
    outFormat: 'glb',
  };
}

/**
 * What a retry's confirmation token is bound to.
 *
 * Deliberately not the job's cache key, which is what a fresh generation's token
 * is bound to. Sharing one would let a token issued for "generate this image"
 * be redeemed as "retry that job" and the other way round -- two different
 * prices, one of them quoted for the other's work.
 */
function retryKey(jobId: string): string {
  return `retry:${jobId}`;
}

/**
 * Why these clip names cannot be retargeted, or null when they can.
 *
 * Checked here as well as in the pipeline, and the two are not redundant: the
 * pipeline's check is the one that guards the money, but it only runs after the
 * mesh and the rig have been bought. This one runs before a price is even
 * quoted, which is the difference between a typo costing nothing and a typo
 * costing a generation.
 *
 * Keyed on the skeleton id, since the rig check has not happened yet. `biped`
 * has a confirmed vocabulary; anything else is passed through unchecked rather
 * than refused against a list nobody has verified.
 */
function clipVocabularyProblem(skeletonId: string, params: GenerationParams): string | null {
  const unknown = unknownPresets(skeletonId, params.clipIntents);
  if (unknown.length === 0) return null;
  const known = knownPresetsFor(skeletonId) ?? [];
  return `no ${skeletonId} animation preset is called ${unknown.map((name) => `"${name}"`).join(', ')}. The ones there are: ${known.join(', ')}.`;
}

/**
 * What a job looks like over the wire.
 *
 * Explicitly projected rather than serialised whole, so a field added to `Job`
 * for the pipeline's own bookkeeping does not silently become public API.
 */
function jobView(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    unitId: job.unitId,
    skeletonId: job.skeletonId,
    establishesRigFamily: job.establishesRigFamily,
    status: job.status,
    stage: job.stage,
    steps: job.steps,
    creditsSpent: job.creditsSpent,
    createdAtMs: job.createdAtMs,
    updatedAtMs: job.updatedAtMs,
    message: job.message,
    cacheKey: job.cacheKey,
    referenceImageSha256: job.referenceImageSha256,
    params: job.params,
    // Paths, never URLs: a Tripo model URL is dead five minutes after success.
    artifacts: job.artifacts,
  };
}

export function studioRoutes(deps: RouteDeps): readonly Route[] {
  const { config, store, pipeline, confirmations, now } = deps;

  /** Refuses everything that spends when no key is configured. */
  const requireKey = (context: RequestContext): boolean => {
    if (config.apiKey !== null) return true;
    sendJson(context.response, 503, {
      error: 'TRIPO_API_KEY is not set on the server, so nothing can be generated. Set it and restart.',
    });
    return false;
  };

  return [
    {
      method: 'GET',
      pattern: '/api/studio/config',
      handler: ({ response }) => {
        // Deliberately says whether a key is set, never what it is.
        sendJson(response, 200, {
          keyConfigured: config.apiKey !== null,
          modelVersion: config.modelVersion,
          defaultFaceLimit: config.defaultFaceLimit,
          ceilings: config.ceilings,
          prices: config.prices,
          maxTimeScale: config.maxTimeScale,
          webhook: config.webhookUrl !== undefined,
        });
      },
    },

    {
      method: 'GET',
      pattern: '/api/studio/credits',
      handler: ({ response }) => {
        sendJson(response, 200, summarize(store.listLedger(), now(), config.ceilings));
      },
    },

    {
      method: 'GET',
      pattern: '/api/studio/jobs',
      handler: ({ response }) => {
        sendJson(response, 200, { jobs: store.listJobs().map(jobView) });
      },
    },

    {
      method: 'GET',
      pattern: '/api/studio/jobs/:id',
      handler: ({ response, params }) => {
        const job = store.getJob(params['id'] ?? '');
        if (!job) return sendJson(response, 404, { error: 'no such job' });
        return sendJson(response, 200, jobView(job));
      },
    },

    /**
     * Accepts a reference image and returns its hash.
     *
     * Hashing happens here, server-side, so the cache key is derived from bytes
     * the server actually holds rather than from a digest the client computed --
     * a client-supplied hash could collide with a cached job on purpose and be
     * handed somebody else's model.
     */
    {
      method: 'POST',
      pattern: '/api/studio/images',
      handler: async ({ request, response, url }) => {
        const bytes = await readBody(request, MAX_IMAGE_BYTES);
        if (bytes.length === 0) return sendJson(response, 400, { error: 'empty image' });
        const { createHash } = await import('node:crypto');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const stagingId = `img-${sha256.slice(0, 16)}`;
        store.saveReferenceImage(
          stagingId,
          url.searchParams.get('filename') ?? 'reference.png',
          request.headers['content-type'] ?? 'application/octet-stream',
          new Uint8Array(bytes),
        );
        return sendJson(response, 200, { sha256, bytes: bytes.length, stagingId });
      },
    },

    /**
     * Prices a generation and issues the token that authorises it.
     *
     * Also answers the cache question, before any money is involved: an
     * identical request that has already succeeded comes back as a hit with the
     * existing job, and the UI can show "this is free" rather than a price.
     */
    {
      method: 'POST',
      pattern: '/api/studio/estimate',
      handler: async ({ request, response }) => {
        const body = asRecord(await readJsonBody(request, MAX_JSON_BYTES));
        const sha256 = asStringField(body, 'referenceImageSha256');
        if (sha256 === null) return sendJson(response, 400, { error: 'referenceImageSha256 is required' });

        const params = paramsFrom(body, config);
        const establishesRigFamily = body['establishesRigFamily'] === true;
        const key = cacheKey(sha256, params);

        const hit = cacheHit(store.listJobs(), key);
        if (hit) {
          return sendJson(response, 200, {
            cached: true,
            job: jobView(hit),
            projection: { steps: [], totalCredits: 0 },
          });
        }

        // Before the price, not after: a set that cannot be retargeted should
        // never get as far as having a confirmation token issued for it.
        if (establishesRigFamily) {
          const problem = clipVocabularyProblem(asStringField(body, 'skeletonId') ?? 'biped', params);
          if (problem !== null) return sendJson(response, 400, { error: problem });
        }

        const projection = projectCost({ params, establishesRigFamily, prices: config.prices });
        const confirmation = confirmations.issue(randomUUID(), projection, key, now());
        confirmations.sweep(now());

        return sendJson(response, 200, {
          cached: false,
          projection,
          confirmationToken: confirmation.token,
          expiresAtMs: confirmation.expiresAtMs,
          credits: summarize(store.listLedger(), now(), config.ceilings),
        });
      },
    },

    /**
     * Creates and starts a job, redeeming a confirmation token.
     *
     * The record is written by `createJob` and saved before `pipeline.run` is
     * called, and `run` persists again before its first request -- so there is no
     * window in which a paid task exists without a row describing it.
     */
    {
      method: 'POST',
      pattern: '/api/studio/jobs',
      handler: async (context) => {
        const { request, response } = context;
        if (!requireKey(context)) return;

        const body = asRecord(await readJsonBody(request, MAX_JSON_BYTES));
        const sha256 = asStringField(body, 'referenceImageSha256');
        const unitId = asStringField(body, 'unitId');
        const skeletonId = asStringField(body, 'skeletonId') ?? 'biped';
        const token = asStringField(body, 'confirmationToken');
        if (sha256 === null || unitId === null) {
          return sendJson(response, 400, { error: 'unitId and referenceImageSha256 are required' });
        }
        if (token === null) {
          return sendJson(response, 400, {
            error: 'no confirmation token; price the generation with POST /api/studio/estimate first',
          });
        }

        const params = paramsFrom(body, config);
        const establishesRigFamily = body['establishesRigFamily'] === true;
        const key = cacheKey(sha256, params);

        const hit = cacheHit(store.listJobs(), key);
        if (hit) return sendJson(response, 200, { cached: true, job: jobView(hit) });

        if (establishesRigFamily) {
          const problem = clipVocabularyProblem(skeletonId, params);
          if (problem !== null) return sendJson(response, 400, { error: problem });
        }

        const redeemed = confirmations.redeem(token, key, now());
        if (!redeemed.ok) return sendJson(response, 409, { error: redeemed.reason });

        const jobId = randomUUID();
        const job = createJob(
          { id: jobId, unitId, skeletonId, establishesRigFamily, referenceImageSha256: sha256, params },
          now(),
        );
        // The reference image was uploaded to a staging id derived from its
        // hash; move it under the job so a resumed job can find it.
        const staged = store.readReferenceImage(`img-${sha256.slice(0, 16)}`);
        if (staged === null) {
          return sendJson(response, 400, {
            error: 'no reference image on the server for that hash; POST it to /api/studio/images first',
          });
        }
        store.saveReferenceImage(jobId, staged.filename, staged.contentType, staged.bytes);
        store.saveJob(job);

        void pipeline.run(jobId);
        return sendJson(response, 202, { cached: false, job: jobView(job) });
      },
    },

    /**
     * Serves one of a job's downloaded files.
     *
     * The name is matched against the job's own recorded artifacts rather than
     * joined onto a directory, so there is no path to traverse out of: a name
     * that is not in the record does not resolve, whatever it contains.
     */
    {
      method: 'GET',
      pattern: '/api/studio/jobs/:id/artifacts/:name',
      handler: async ({ response, params }) => {
        const job = store.getJob(params['id'] ?? '');
        if (!job) return sendJson(response, 404, { error: 'no such job' });

        const known = [job.artifacts.meshGlb, job.artifacts.riggedGlb, ...Object.values(job.artifacts.clipGlbs)];
        const wanted = params['name'] ?? '';
        const { basename } = await import('node:path');
        const path = known.find((candidate) => candidate !== null && basename(candidate) === wanted);
        if (path === undefined || path === null) {
          return sendJson(response, 404, { error: 'no such artifact on this job' });
        }

        const { existsSync, readFileSync } = await import('node:fs');
        if (!existsSync(path)) return sendJson(response, 404, { error: 'the record names a file that is not there' });
        const bytes = readFileSync(path);
        response.writeHead(200, {
          'content-type': 'model/gltf-binary',
          'content-length': bytes.length,
          'cache-control': 'no-store',
        });
        return response.end(bytes);
      },
    },

    /**
     * Stages a finished job into `assets/units/` and validates what it wrote.
     *
     * Deliberately refuses anything that has not succeeded: half a job's files
     * are on disk after a failure, and staging those into the repo would put a
     * broken unit in a directory CI validates.
     */
    {
      method: 'POST',
      pattern: '/api/studio/export',
      handler: async ({ request, response }) => {
        const body = asRecord(await readJsonBody(request, MAX_JSON_BYTES));
        const job = store.getJob(asStringField(body, 'jobId') ?? '');
        if (!job) return sendJson(response, 404, { error: 'no such job' });
        if (job.status !== 'succeeded') {
          return sendJson(response, 409, {
            error: `job is ${job.status}; only a succeeded job can be exported`,
          });
        }

        const { readFileSync, existsSync } = await import('node:fs');
        const { join } = await import('node:path');
        const skeletonRef = asStringField(body, 'skeletonRef') ?? `${job.skeletonId}.skeleton.json`;
        const skeletonPath = join(deps.unitsDir, skeletonRef);
        if (!existsSync(skeletonPath)) {
          return sendJson(response, 400, { error: `no skeleton at assets/units/${skeletonRef}` });
        }

        const { exportJob } = await import('./export.js');
        const result = exportJob({
          job,
          unitsDir: deps.unitsDir,
          skeletonRef,
          skeletonDoc: JSON.parse(readFileSync(skeletonPath, 'utf8')) as unknown,
          clipLibId: asStringField(body, 'clipLibId') ?? `${job.skeletonId}.core`,
          clips: Array.isArray(body['clips']) ? (body['clips'] as never) : undefined,
          stateMachine: body['stateMachine'] === undefined ? undefined : (body['stateMachine'] as never),
          maxTimeScale: config.maxTimeScale,
          nowIso: new Date(now()).toISOString(),
        });
        return sendJson(response, result.ok ? 200 : 422, result);
      },
    },

    /**
     * The authored documents, read and written (spec 110).
     *
     * Everything the Preview tab edits -- a dragged event marker, a retuned
     * wind-up, a transition's blend duration -- comes back through here, so
     * nothing tuned lives only in a browser session. The write validates first
     * and is atomic, both in `documents.ts`.
     */
    {
      method: 'GET',
      pattern: '/api/studio/documents',
      handler: async ({ response, url }) => {
        const { listDocuments, readDocument } = await import('./documents.js');
        const wanted = url.searchParams.get('path');
        if (wanted === null) return sendJson(response, 200, { documents: listDocuments(deps.unitsDir) });
        const result = readDocument(deps.unitsDir, wanted);
        if ('error' in result) return sendJson(response, 404, { error: result.error });
        return sendJson(response, 200, { path: wanted, doc: result.doc });
      },
    },

    {
      method: 'PUT',
      pattern: '/api/studio/documents',
      handler: async ({ request, response, url }) => {
        const { writeDocument } = await import('./documents.js');
        const wanted = url.searchParams.get('path');
        if (wanted === null) return sendJson(response, 400, { error: 'a ?path= is required' });
        const body = asRecord(await readJsonBody(request, MAX_JSON_BYTES));
        const result = writeDocument(deps.unitsDir, wanted, body['doc']);
        return sendJson(response, result.ok ? 200 : 422, result);
      },
    },

    /**
     * Carries a blocked job on from where the ceiling stopped it.
     *
     * Only ever a blocked job. A failed one has its own route below, because it
     * is a different decision: nothing was charged for a block, so carrying on
     * needs no fresh confirmation, and a retry does.
     */
    {
      method: 'POST',
      pattern: '/api/studio/jobs/:id/resume',
      handler: ({ response, params }) => {
        const id = params['id'] ?? '';
        const job = pipeline.unblock(id);
        if (job) return sendJson(response, 202, jobView(job));
        const existing = store.getJob(id);
        if (!existing) return sendJson(response, 404, { error: 'no such job' });
        return sendJson(response, 409, {
          error:
            existing.status === 'failed'
              ? 'this job failed rather than being blocked; price the rest of it with POST /api/studio/jobs/:id/retry/estimate and retry that.'
              : `this job is ${existing.status}; only a blocked job can be resumed`,
        });
      },
    },

    /**
     * Prices what is left of a failed job, and issues the token to buy it.
     *
     * Deliberately the same two-call shape as a fresh generation: a projection
     * and a one-shot token, then a second call that redeems it. A retry spends
     * money, so it goes through the same door money always goes through, and the
     * number shown is {@link projectRemaining} rather than the job's original
     * price -- what is already on disk is not for sale twice.
     */
    {
      method: 'POST',
      pattern: '/api/studio/jobs/:id/retry/estimate',
      handler: ({ response, params }) => {
        const id = params['id'] ?? '';
        const job = store.getJob(id);
        if (!job) return sendJson(response, 404, { error: 'no such job' });
        if (job.status !== 'failed') {
          return sendJson(response, 409, { error: `this job is ${job.status}; only a failed job is retried` });
        }

        const projection = projectRemaining(job, config.prices);
        const confirmation = confirmations.issue(randomUUID(), projection, retryKey(id), now());
        confirmations.sweep(now());
        return sendJson(response, 200, {
          projection,
          confirmationToken: confirmation.token,
          expiresAtMs: confirmation.expiresAtMs,
          credits: summarize(store.listLedger(), now(), config.ceilings),
        });
      },
    },

    /**
     * Picks a failed job back up at the stage that failed.
     *
     * This is the operator deciding, not the machine: the token proves a price
     * was quoted and somebody looked at it, and nothing anywhere calls this on a
     * timer. The rule the brief sets is that a failed paid call is never retried
     * *automatically*, and a pipeline with no manual way forward is worse than
     * the thing that rule protects against -- a retarget that died on its third
     * clip would otherwise strand a paid mesh and a paid rig, and the only route
     * onward would be a new job that buys both again.
     */
    {
      method: 'POST',
      pattern: '/api/studio/jobs/:id/retry',
      handler: async (context) => {
        const { request, response, params } = context;
        if (!requireKey(context)) return;

        const id = params['id'] ?? '';
        const existing = store.getJob(id);
        if (!existing) return sendJson(response, 404, { error: 'no such job' });

        const body = asRecord(await readJsonBody(request, MAX_JSON_BYTES));
        const token = asStringField(body, 'confirmationToken');
        if (token === null) {
          return sendJson(response, 400, {
            error: 'no confirmation token; price the retry with POST /api/studio/jobs/:id/retry/estimate first',
          });
        }
        const redeemed = confirmations.redeem(token, retryKey(id), now());
        if (!redeemed.ok) return sendJson(response, 409, { error: redeemed.reason });

        const job = pipeline.retry(id);
        if (!job) return sendJson(response, 409, { error: `this job is ${existing.status}; only a failed job is retried` });
        return sendJson(response, 202, jobView(job));
      },
    },

    {
      method: 'POST',
      pattern: '/api/studio/jobs/:id/cancel',
      handler: ({ response, params }) => {
        const job = pipeline.cancel(params['id'] ?? '');
        if (!job) return sendJson(response, 404, { error: 'no such job' });
        return sendJson(response, 200, jobView(job));
      },
    },

    /**
     * The optional completion callback.
     *
     * A nudge, never a source of truth: it marks the job for an immediate poll
     * rather than carrying a result. Anything else would mean trusting an
     * unauthenticated request to say a paid task succeeded, and polling already
     * answers that question from the API itself.
     */
    {
      method: 'POST',
      pattern: '/api/studio/webhook',
      public: true,
      handler: async ({ request, response }) => {
        const body = asRecord(await readJsonBody(request, MAX_JSON_BYTES));
        const taskId = asStringField(body, 'task_id') ?? asStringField(body, 'taskId');
        deps.log?.(`[studio] webhook for task ${taskId ?? '?'}`);
        sendJson(response, 200, { received: true });
      },
    },
  ];
}
