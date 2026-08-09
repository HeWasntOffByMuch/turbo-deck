/**
 * The pipeline end to end, against a fake HTTP layer (spec 108).
 *
 * Nothing here touches the network -- and it could not: this environment's
 * egress policy blocks `openapi.tripo3d.ai`, which is why the fake is a fake
 * `fetch` rather than a fake client. The real {@link TripoClient} builds every
 * URL, sets every header and maps every status in these tests; only the socket
 * is imaginary.
 *
 * The properties being asserted are the expensive ones: the record is on disk
 * before the request goes out, a ceiling stops before anything is sent, a failure
 * is never retried, and a success is downloaded rather than left as a URL that
 * expires in five minutes.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadStudioConfig, type StudioConfig } from './config.js';
import { FakeTripo } from './fake-tripo.js';
import { createJob } from './jobs.js';
import { StudioPipeline } from './pipeline.js';
import { studioPaths, StudioStore } from './store.js';
import { TripoClient } from './tripo.js';
import type { GenerationParams, Job } from './types.js';

const HASH = 'a'.repeat(64);
const MESH_URL = 'https://cdn.example/mesh.glb';
const RIG_URL = 'https://cdn.example/rigged.glb';
const CLIP_URL = 'https://cdn.example/clips.glb';

function params(patch: Partial<GenerationParams> = {}): GenerationParams {
  return {
    modelVersion: 'P1-20260311',
    faceLimit: 8000,
    texture: true,
    pbr: false,
    clipIntents: ['idle', 'run'],
    outFormat: 'glb',
    ...patch,
  };
}

interface Harness {
  readonly dir: string;
  readonly store: StudioStore;
  readonly fake: FakeTripo;
  readonly pipeline: StudioPipeline;
  readonly config: StudioConfig;
  /** Advances with every simulated sleep, so pacing is measurable. */
  clock: number;
}

let harness: Harness;

function build(env: Record<string, string> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'studio-test-'));
  const config = loadStudioConfig(
    { TRIPO_API_KEY: 'tsk_secret', STUDIO_DATA_DIR: dir, ...env } as NodeJS.ProcessEnv,
    dir,
  );
  const store = new StudioStore(studioPaths(config.dataDir));
  store.load();

  const state = { clock: 0 };
  const fake = new FakeTripo(() => state.clock);
  fake.downloads.set(MESH_URL, new Uint8Array([1, 2, 3]));
  fake.downloads.set(RIG_URL, new Uint8Array([4, 5, 6]));
  fake.downloads.set(CLIP_URL, new Uint8Array([7, 8, 9]));

  const client = new TripoClient({ apiKey: 'tsk_secret', baseUrl: 'https://openapi.example/v3', fetch: fake.fetch });
  const pipeline = new StudioPipeline({
    client,
    store,
    config,
    now: () => state.clock,
    // Time only moves when something waits, so the pacer's arithmetic is
    // observable and no test spends a real second.
    sleep: (ms) => {
      state.clock += ms;
      return Promise.resolve();
    },
    writeArtifact: (jobId, filename, bytes) => store.writeArtifact(jobId, filename, bytes),
  });

  return {
    dir,
    store,
    fake,
    pipeline,
    config,
    get clock() {
      return state.clock;
    },
    set clock(value: number) {
      state.clock = value;
    },
  };
}

function seedJob(h: Harness, patch: { establishesRigFamily?: boolean; id?: string } = {}): Job {
  const id = patch.id ?? 'job-1';
  const job = createJob(
    {
      id,
      unitId: 'grunt',
      skeletonId: 'biped',
      establishesRigFamily: patch.establishesRigFamily ?? true,
      referenceImageSha256: HASH,
      params: params(),
    },
    0,
  );
  h.store.saveReferenceImage(id, 'ref.png', 'image/png', new Uint8Array([9, 9, 9]));
  h.store.saveJob(job);
  return job;
}

/** The happy path's script: every task succeeds and hands back a model URL. */
function scriptSuccess(fake: FakeTripo): void {
  fake
    .script('/generation/image-to-model', { creditsConsumed: 20, modelUrl: MESH_URL })
    .script('/animations/rig-check', { creditsConsumed: 0, riggable: true })
    .script('/animations/rig', { creditsConsumed: 10, modelUrl: RIG_URL })
    .script('/animations/retarget', { creditsConsumed: 10, modelUrl: CLIP_URL });
}

beforeEach(() => {
  harness = build();
});

afterEach(() => {
  rmSync(harness.dir, { recursive: true, force: true });
});

describe('the happy path', () => {
  it('walks the four calls and succeeds', async () => {
    scriptSuccess(harness.fake);
    seedJob(harness);
    const job = await harness.pipeline.run('job-1');

    expect(job?.status).toBe('succeeded');
    expect(harness.fake.callsTo('/generation/image-to-model')).toHaveLength(1);
    expect(harness.fake.callsTo('/animations/rig-check')).toHaveLength(1);
    expect(harness.fake.callsTo('/animations/rig')).toHaveLength(1);
    expect(harness.fake.callsTo('/animations/retarget')).toHaveLength(1);
  });

  it('downloads every artifact rather than storing a URL', async () => {
    // Model URLs expire about five minutes after success. A URL in the record
    // would be a dead link by the time anybody clicked it.
    scriptSuccess(harness.fake);
    seedJob(harness);
    const job = await harness.pipeline.run('job-1');

    expect(job?.artifacts.meshGlb).toContain('mesh.glb');
    expect(job?.artifacts.riggedGlb).toContain('rigged.glb');
    expect(Object.keys(job?.artifacts.clipGlbs ?? {})).toEqual(['idle', 'run']);
    for (const path of [job?.artifacts.meshGlb, job?.artifacts.riggedGlb]) {
      expect(readFileSync(path ?? '').length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(job?.artifacts)).not.toContain('https://');
  });

  it('records what the API said it charged, not what was projected', async () => {
    scriptSuccess(harness.fake);
    seedJob(harness);
    await harness.pipeline.run('job-1');

    const ledger = harness.store.listLedger();
    expect(ledger.map((entry) => entry.credits)).toEqual([20, 0, 10, 10]);
    expect(ledger.every((entry) => entry.reported)).toBe(true);
    expect(harness.store.getJob('job-1')?.creditsSpent).toBe(40);
  });

  it('sends the key on every API call and never in a download', async () => {
    scriptSuccess(harness.fake);
    seedJob(harness);
    await harness.pipeline.run('job-1');

    const api = harness.fake.calls.filter((call) => call.url.startsWith('https://openapi.example'));
    expect(api.length).toBeGreaterThan(0);
    expect(api.every((call) => call.authorization === 'Bearer tsk_secret')).toBe(true);
    // A pre-signed CDN URL must not be handed a credential.
    const downloads = harness.fake.calls.filter((call) => call.url.startsWith('https://cdn.example'));
    expect(downloads.length).toBe(3);
    expect(downloads.every((call) => call.authorization === undefined)).toBe(true);
  });

  it('skips retarget for a unit reusing an established rig family', async () => {
    scriptSuccess(harness.fake);
    seedJob(harness, { establishesRigFamily: false });
    const job = await harness.pipeline.run('job-1');

    expect(harness.fake.callsTo('/animations/retarget')).toHaveLength(0);
    expect(job?.steps.find((step) => step.stage === 'retarget')?.status).toBe('skipped');
    expect(job?.status).toBe('succeeded');
  });

  it('batches retargets at five clips per call', async () => {
    scriptSuccess(harness.fake);
    const many = createJob(
      {
        id: 'job-many',
        unitId: 'grunt',
        skeletonId: 'biped',
        establishesRigFamily: true,
        referenceImageSha256: HASH,
        params: params({ clipIntents: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }),
      },
      0,
    );
    harness.store.saveReferenceImage('job-many', 'ref.png', 'image/png', new Uint8Array([1]));
    harness.store.saveJob(many);

    await harness.pipeline.run('job-many');
    expect(harness.fake.callsTo('/animations/retarget')).toHaveLength(2);
  });

  it('polls until a task finishes', async () => {
    harness.fake
      .script('/generation/image-to-model', { pollsBeforeDone: 3, creditsConsumed: 20, modelUrl: MESH_URL })
      .script('/animations/rig-check', { creditsConsumed: 0, riggable: true })
      .script('/animations/rig', { creditsConsumed: 10, modelUrl: RIG_URL })
      .script('/animations/retarget', { creditsConsumed: 10, modelUrl: CLIP_URL });
    seedJob(harness);
    const job = await harness.pipeline.run('job-1');

    expect(job?.status).toBe('succeeded');
    expect(harness.fake.callsTo('/tasks/task-1').length).toBe(4);
  });
});

describe('the interlocks', () => {
  it('persists the record before the request that spends money goes out', async () => {
    // Asserted from inside the fake, at the moment of the call: a process killed
    // here must still have a row saying a paid task may exist.
    scriptSuccess(harness.fake);
    seedJob(harness);

    // An array rather than a `let`: the compiler narrows a variable only ever
    // assigned inside a callback to `never`, which is wrong here and unhelpful.
    const captured: Job[] = [];
    const raw = harness.fake.fetch;
    const spy = new StudioPipeline({
      client: new TripoClient({
        apiKey: 'tsk_secret',
        baseUrl: 'https://openapi.example/v3',
        fetch: async (url, init) => {
          if (url.includes('/generation/image-to-model')) {
            const text = readFileSync(harness.store.paths.jobsFile, 'utf8');
            const stored = (JSON.parse(text) as { jobs: Job[] }).jobs[0];
            if (stored) captured.push(stored);
          }
          return raw(url, init);
        },
      }),
      store: harness.store,
      config: harness.config,
      now: () => 0,
      sleep: () => Promise.resolve(),
      writeArtifact: (jobId, filename, bytes) => harness.store.writeArtifact(jobId, filename, bytes),
    });

    await spy.run('job-1');
    expect(captured).toHaveLength(1);
    expect(captured[0]?.status).toBe('running');
    expect(captured[0]?.stage).toBe('imageToModel');
  });

  it('blocks on a ceiling before sending anything at all', async () => {
    const tight = build({ STUDIO_CEILING_PER_RUN: '5' });
    scriptSuccess(tight.fake);
    seedJob(tight);

    const job = await tight.pipeline.run('job-1');
    expect(job?.status).toBe('blocked');
    expect(tight.fake.submitCount).toBe(0);
    expect(tight.store.listLedger()).toHaveLength(0);
    expect(job?.message).toContain('per-run ceiling');
    rmSync(tight.dir, { recursive: true, force: true });
  });

  it('blocks part-way through when the run creeps past its ceiling', async () => {
    // Image-to-model at 20 fits under 25; the rig at 10 would reach 30.
    const tight = build({ STUDIO_CEILING_PER_RUN: '25' });
    scriptSuccess(tight.fake);
    seedJob(tight);

    const job = await tight.pipeline.run('job-1');
    expect(job?.status).toBe('blocked');
    expect(job?.stage).toBe('rig');
    expect(tight.fake.callsTo('/animations/rig-check')).toHaveLength(1);
    expect(tight.fake.callsTo('/animations/rig')).toHaveLength(0);
    rmSync(tight.dir, { recursive: true, force: true });
  });

  it('stops before the rig call when the model is not riggable', async () => {
    // rig-check is free, so this costs nothing and saves the rig's credits.
    harness.fake
      .script('/generation/image-to-model', { creditsConsumed: 20, modelUrl: MESH_URL })
      .script('/animations/rig-check', { creditsConsumed: 0, riggable: false });
    seedJob(harness);

    const job = await harness.pipeline.run('job-1');
    expect(job?.status).toBe('blocked');
    expect(job?.message).toContain('not riggable');
    expect(harness.fake.callsTo('/animations/rig')).toHaveLength(0);
  });

  it('never retries a failed paid call', async () => {
    harness.fake
      .script('/generation/image-to-model', { creditsConsumed: 20, modelUrl: MESH_URL })
      .script('/animations/rig-check', { creditsConsumed: 0, riggable: true })
      .script('/animations/rig', { status: 'failed', message: 'internal error', creditsConsumed: 10 });
    seedJob(harness);

    const job = await harness.pipeline.run('job-1');
    expect(job?.status).toBe('failed');
    expect(harness.fake.callsTo('/animations/rig')).toHaveLength(1);

    // And running it again does not quietly re-submit: the job is terminal.
    await harness.pipeline.run('job-1');
    expect(harness.fake.callsTo('/animations/rig')).toHaveLength(1);
  });

  it('turns a transport failure into a failed job rather than an escaped throw', async () => {
    harness.fake.networkError = 'ECONNRESET';
    seedJob(harness);

    const job = await harness.pipeline.run('job-1');
    expect(job?.status).toBe('failed');
    expect(job?.message).toContain('ECONNRESET');
  });

  it('keeps outbound requests at least one interval apart', async () => {
    scriptSuccess(harness.fake);
    seedJob(harness);
    await harness.pipeline.run('job-1');

    const api = harness.fake.calls.filter((call) => call.url.startsWith('https://openapi.example'));
    for (let i = 1; i < api.length; i += 1) {
      const gap = (api[i]?.atMs ?? 0) - (api[i - 1]?.atMs ?? 0);
      expect(gap, `gap between call ${i - 1} and ${i}`).toBeGreaterThanOrEqual(harness.config.minRequestIntervalMs);
    }
  });

  it('marks the total a lower bound when the API does not say what it charged', async () => {
    harness.fake
      .script('/generation/image-to-model', { creditsConsumed: null, modelUrl: MESH_URL })
      .script('/animations/rig-check', { creditsConsumed: 0, riggable: true })
      .script('/animations/rig', { creditsConsumed: 10, modelUrl: RIG_URL })
      .script('/animations/retarget', { creditsConsumed: 10, modelUrl: CLIP_URL });
    seedJob(harness);
    await harness.pipeline.run('job-1');

    const unreported = harness.store.listLedger().filter((entry) => !entry.reported);
    expect(unreported).toHaveLength(1);
    expect(unreported[0]?.credits).toBe(0);
  });

  it('fails rather than succeeding when a task finished but nothing was saved', async () => {
    harness.fake
      .script('/generation/image-to-model', { creditsConsumed: 20, modelUrl: null })
      .script('/animations/rig-check', { creditsConsumed: 0, riggable: true })
      .script('/animations/rig', { creditsConsumed: 10, modelUrl: null })
      .script('/animations/retarget', { creditsConsumed: 10, modelUrl: null });
    seedJob(harness);

    const job = await harness.pipeline.run('job-1');
    expect(job?.status).toBe('failed');
    expect(job?.message).toContain('nothing was saved');
  });

  it('does not run the same job twice concurrently', async () => {
    scriptSuccess(harness.fake);
    seedJob(harness);
    await Promise.all([harness.pipeline.run('job-1'), harness.pipeline.run('job-1')]);
    expect(harness.fake.callsTo('/generation/image-to-model')).toHaveLength(1);
  });

  it('cancels a job that is mid-flight', async () => {
    scriptSuccess(harness.fake);
    seedJob(harness);
    const cancelled = harness.pipeline.cancel('job-1');
    expect(cancelled?.status).toBe('cancelled');
    await harness.pipeline.run('job-1');
    expect(harness.fake.submitCount).toBe(0);
  });
});

describe('durability', () => {
  it('round-trips every job field through the store', async () => {
    scriptSuccess(harness.fake);
    seedJob(harness);
    const finished = await harness.pipeline.run('job-1');

    const reopened = new StudioStore(studioPaths(harness.dir));
    reopened.load();
    expect(reopened.getJob('job-1')).toEqual(finished);
  });

  it('leaves the previous queue intact when a write is interrupted', () => {
    // The atomic rename: a stray .tmp file is never read, so a kill mid-write
    // costs the newest change and not the whole queue.
    seedJob(harness);
    writeFileSync(`${harness.store.paths.jobsFile}.tmp`, '{ truncated');

    const reopened = new StudioStore(studioPaths(harness.dir));
    expect(() => reopened.load()).not.toThrow();
    expect(reopened.getJob('job-1')).not.toBeNull();
  });

  it('skips an unreadable ledger line instead of refusing to boot', () => {
    seedJob(harness);
    writeFileSync(harness.store.paths.ledgerFile, '{"jobId":"a","credits":5,"reported":true,"atMs":0}\n{ half-writ');

    const reopened = new StudioStore(studioPaths(harness.dir));
    const loaded = reopened.load();
    expect(loaded.ledger).toBe(1);
    expect(loaded.skippedLedgerLines).toBe(1);
  });

  it('resumes what was in flight and leaves what was finished', async () => {
    scriptSuccess(harness.fake);
    seedJob(harness, { id: 'job-running' });
    seedJob(harness, { id: 'job-done' });
    await harness.pipeline.run('job-done');

    const reopened = new StudioStore(studioPaths(harness.dir));
    reopened.load();
    const resumedIds = reopened
      .listJobs()
      .filter((job) => job.status !== 'succeeded')
      .map((job) => job.id);
    expect(resumedIds).toEqual(['job-running']);
  });

  it('keeps the reference image so a resumed job can still find it', () => {
    seedJob(harness);
    const reopened = new StudioStore(studioPaths(harness.dir));
    reopened.load();
    const reference = reopened.readReferenceImage('job-1');
    expect(reference?.filename).toBe('ref.png');
    expect(reference?.contentType).toBe('image/png');
    expect(reference?.bytes).toEqual(new Uint8Array([9, 9, 9]));
  });
});
