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
    orientation: 'default',
    rigSpec: 'mixamo',
    // The config default, so the assertion that the rig gets its *own* version
    // rather than the generation one still means what it meant when the value
    // came off the config instead of off the job.
    rigModelVersion: 'v2.5-20260210',
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

/**
 * The happy path's script: every task succeeds and hands back a model URL.
 *
 * The credit figures are the ones a real run reported -- 50 for the mesh, 0 for
 * the free check, 25 for the rig -- so the ceiling tests below exercise the
 * arithmetic that actually fires rather than a friendlier version of it.
 */
function scriptSuccess(fake: FakeTripo): void {
  fake
    .script('/generation/image-to-model', { creditsConsumed: 50, modelUrl: MESH_URL })
    .script('/animations/rig-check', { creditsConsumed: 0, riggable: true, rigType: 'biped' })
    .script('/animations/rig', { creditsConsumed: 25, modelUrl: RIG_URL })
    .script('/animations/retarget', { creditsConsumed: 25, modelUrl: CLIP_URL });
}

/** Builds a second pipeline over the same store: a restart, from a job's view. */
function restart(h: Harness): StudioPipeline {
  return new StudioPipeline({
    client: new TripoClient({
      apiKey: 'tsk_secret',
      baseUrl: 'https://openapi.example/v3',
      fetch: h.fake.fetch,
    }),
    store: h.store,
    config: h.config,
    now: () => 0,
    sleep: () => Promise.resolve(),
    writeArtifact: (jobId, filename, bytes) => h.store.writeArtifact(jobId, filename, bytes),
  });
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
    // Two clips, two retarget calls: the API takes one preset per call.
    expect(harness.fake.callsTo('/animations/retarget')).toHaveLength(2);
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
    // Two clips is two retarget calls now, not one batch.
    expect(ledger.map((entry) => entry.credits)).toEqual([50, 0, 25, 25, 25]);
    expect(ledger.every((entry) => entry.reported)).toBe(true);
    expect(harness.store.getJob('job-1')?.creditsSpent).toBe(125);
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
    expect(downloads.length).toBe(4);
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

  it('makes one retarget call per clip, because the API takes one preset', async () => {
    scriptSuccess(harness.fake);
    const many = createJob(
      {
        id: 'job-many',
        unitId: 'grunt',
        skeletonId: 'biped',
        establishesRigFamily: true,
        referenceImageSha256: HASH,
        params: params({ clipIntents: ['idle', 'walk', 'run', 'jump', 'slash', 'shoot', 'turn'] }),
      },
      0,
    );
    harness.store.saveReferenceImage('job-many', 'ref.png', 'image/png', new Uint8Array([1]));
    harness.store.saveJob(many);

    await harness.pipeline.run('job-many');
    expect(harness.fake.callsTo('/animations/retarget')).toHaveLength(7);
  });

  it('sends a bare preset name, not one namespaced by rig type', () => {
    // An earlier draft sent `preset:biped:walk` on the strength of a third-party
    // integration note. The real API takes `preset:walk`, and the rig type is
    // read for a different purpose entirely: choosing which vocabulary the names
    // are checked against.
    scriptSuccess(harness.fake);
    harness.fake.script('/animations/rig-check', { creditsConsumed: 0, riggable: true, rigType: 'quadruped' });
    seedJob(harness);
    return harness.pipeline.run('job-1').then(() => {
      const sent = harness.fake
        .callsTo('/animations/retarget')
        .map((call) => (call.body as { animations: string[] }).animations);
      expect(sent).toEqual([['preset:idle'], ['preset:run']]);
    });
  });

  it('refuses a clip name the rig has no preset for, before spending on it', async () => {
    // A name the API does not know is not a validation error, it is a paid call
    // that buys nothing. So the whole set is checked before any of it is sent.
    scriptSuccess(harness.fake);
    const wrong = createJob(
      {
        id: 'job-wrong',
        unitId: 'grunt',
        skeletonId: 'biped',
        establishesRigFamily: true,
        referenceImageSha256: HASH,
        params: params({ clipIntents: ['idle', 'attack'] }),
      },
      0,
    );
    harness.store.saveReferenceImage('job-wrong', 'ref.png', 'image/png', new Uint8Array([1]));
    harness.store.saveJob(wrong);

    const job = await harness.pipeline.run('job-wrong');
    expect(harness.fake.callsTo('/animations/retarget')).toHaveLength(0);
    // Blocked, not failed: nothing was attempted at this stage, and the two want
    // different words and different next actions.
    expect(job?.status).toBe('blocked');
    expect(job?.message).toContain('"attack"');
    // And the message names the ones that do exist, since the fix is a rename.
    expect(job?.message).toContain('slash');
  });

  it('passes the clips of an unknown rig type through unchecked', async () => {
    // Only the biped vocabulary has been confirmed. Refusing a quadruped's
    // intents against a guessed list would block work that would have succeeded
    // -- the opposite failure, but still a failure.
    scriptSuccess(harness.fake);
    harness.fake.script('/animations/rig-check', { creditsConsumed: 0, riggable: true, rigType: 'quadruped' });
    const exotic = createJob(
      {
        id: 'job-exotic',
        unitId: 'hound',
        skeletonId: 'quadruped',
        establishesRigFamily: true,
        referenceImageSha256: HASH,
        params: params({ clipIntents: ['pounce'] }),
      },
      0,
    );
    harness.store.saveReferenceImage('job-exotic', 'ref.png', 'image/png', new Uint8Array([1]));
    harness.store.saveJob(exotic);

    const job = await harness.pipeline.run('job-exotic');
    expect(job?.status).toBe('succeeded');
    expect(harness.fake.callsTo('/animations/retarget')).toHaveLength(1);
  });

  it('names each clip file for its intent', () => {
    scriptSuccess(harness.fake);
    seedJob(harness);
    return harness.pipeline.run('job-1').then((job) => {
      expect(job?.artifacts.clipGlbs['idle']).toContain('idle.glb');
      expect(job?.artifacts.clipGlbs['run']).toContain('run.glb');
    });
  });

  it('uploads to /files and sends the token as a bare `input`', () => {
    // The call that failed first: `/upload` answered "No endpoint found", and
    // the body shape around it was the v2 one.
    scriptSuccess(harness.fake);
    seedJob(harness);
    return harness.pipeline.run('job-1').then(() => {
      expect(harness.fake.callsTo('/files')).toHaveLength(1);
      const body = harness.fake.callsTo('/generation/image-to-model')[0]?.body as Record<string, unknown>;
      expect(body['input']).toBe('file-token-1');
      expect(body['model']).toBe('P1-20260311');
      expect(body).not.toHaveProperty('model_version');
      expect(body).not.toHaveProperty('file');
    });
  });

  it('sends the generation orientation explicitly', async () => {
    // Whichever front the mesh ends up with is the front the auto-rig fits to,
    // and every clip afterwards plays in that frame. Too consequential to leave
    // to whatever the server defaults to this month.
    scriptSuccess(harness.fake);
    seedJob(harness);
    await harness.pipeline.run('job-1');
    const body = harness.fake.callsTo('/generation/image-to-model')[0]?.body as Record<string, unknown>;
    expect(body['orientation']).toBe('default');
  });

  it('sends align_image when the server is configured for it', async () => {
    const aligned = build({ TRIPO_ORIENTATION: 'align_image' });
    scriptSuccess(aligned.fake);
    // The job carries the orientation, so it is what the job was created with
    // rather than what the config says at the moment the call goes out.
    const job = createJob(
      {
        id: 'job-1',
        unitId: 'grunt',
        skeletonId: 'biped',
        establishesRigFamily: true,
        referenceImageSha256: HASH,
        params: params({ orientation: 'align_image' }),
      },
      0,
    );
    aligned.store.saveReferenceImage('job-1', 'ref.png', 'image/png', new Uint8Array([1]));
    aligned.store.saveJob(job);
    await aligned.pipeline.run('job-1');
    const body = aligned.fake.callsTo('/generation/image-to-model')[0]?.body as Record<string, unknown>;
    expect(body['orientation']).toBe('align_image');
    rmSync(aligned.dir, { recursive: true, force: true });
  });

  it('sends the rig its own model version, not the generation one', () => {
    // Two date-stamped ids in one pipeline; the server's own default is
    // rejected, so it has to be sent and it has to be the right one.
    scriptSuccess(harness.fake);
    seedJob(harness);
    return harness.pipeline.run('job-1').then(() => {
      const body = harness.fake.callsTo('/animations/rig')[0]?.body as Record<string, unknown>;
      expect(body['model']).toBe('v2.5-20260210');
      expect(body['model']).not.toBe('P1-20260311');
      expect(body['spec']).toBe('mixamo');
      expect(body['input']).toBe('task-1');
    });
  });

  it('rigs with the spec the job was created with, not the one the server has now', async () => {
    // The reason this matters: `spec` decides what the skeleton is called, and
    // a rig that comes back in a generator's own vocabulary answers to none of
    // the names the unit format addresses bones by. A config edit between
    // submitting a job and resuming it must not rig half a roster each way.
    scriptSuccess(harness.fake);
    const job = createJob(
      {
        id: 'job-1',
        unitId: 'grunt',
        skeletonId: 'biped',
        establishesRigFamily: true,
        referenceImageSha256: HASH,
        params: params({ rigSpec: 'tripo' }),
      },
      0,
    );
    harness.store.saveReferenceImage('job-1', 'ref.png', 'image/png', new Uint8Array([1]));
    harness.store.saveJob(job);
    await harness.pipeline.run('job-1');
    const body = harness.fake.callsTo('/animations/rig')[0]?.body as Record<string, unknown>;
    expect(body['spec']).toBe('tripo');
  });

  it('polls until a task finishes', async () => {
    harness.fake
      .script('/generation/image-to-model', { pollsBeforeDone: 3, creditsConsumed: 20, modelUrl: MESH_URL })
      .script('/animations/rig-check', { creditsConsumed: 0, riggable: true, rigType: 'biped' })
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
    // The mesh at 50 fits under 60; the rig would take the run to 75.
    const tight = build({ STUDIO_CEILING_PER_RUN: '60' });
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
      .script('/generation/image-to-model', { creditsConsumed: 50, modelUrl: MESH_URL })
      .script('/animations/rig-check', { creditsConsumed: 0, riggable: true, rigType: 'biped' })
      .script('/animations/rig', { status: 'failed', message: 'internal error', creditsConsumed: 25 });
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
      .script('/animations/rig-check', { creditsConsumed: 0, riggable: true, rigType: 'biped' })
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
      .script('/animations/rig-check', { creditsConsumed: 0, riggable: true, rigType: 'biped' })
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

  it('resumes a blocked job from where the ceiling stopped it, without re-spending', async () => {
    // The real case: image-to-model and the rig succeed, the retarget is refused
    // for want of headroom, the ceiling is raised, and the rest runs. The two
    // paid calls already made must not be made again.
    // 100 is exactly the case that turned up in real use: the mesh (50) and the
    // rig (25) both fit, and the two retargets projected at 25 each would not.
    const tight = build({ STUDIO_CEILING_PER_RUN: '100' });
    scriptSuccess(tight.fake);
    seedJob(tight);

    const blocked = await tight.pipeline.run('job-1');
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.stage).toBe('retarget');
    const spentBefore = blocked?.creditsSpent ?? 0;
    expect(tight.fake.callsTo('/animations/retarget')).toHaveLength(0);

    // Raising the ceiling is a restart in real life; here it is a new pipeline
    // over the same store, which is the same thing from the job's point of view.
    const roomier = loadStudioConfig(
      { TRIPO_API_KEY: 'tsk_secret', STUDIO_DATA_DIR: tight.dir, STUDIO_CEILING_PER_RUN: '500' } as NodeJS.ProcessEnv,
      tight.dir,
    );
    const client = new TripoClient({
      apiKey: 'tsk_secret',
      baseUrl: 'https://openapi.example/v3',
      fetch: tight.fake.fetch,
    });
    const resumed = new StudioPipeline({
      client,
      store: tight.store,
      config: roomier,
      now: () => 0,
      sleep: () => Promise.resolve(),
      writeArtifact: (jobId, filename, bytes) => tight.store.writeArtifact(jobId, filename, bytes),
    });

    expect(resumed.unblock('job-1')).not.toBeNull();
    await resumed.run('job-1');

    const finished = tight.store.getJob('job-1');
    expect(finished?.status).toBe('succeeded');
    // The stages already paid for were not repeated.
    expect(tight.fake.callsTo('/generation/image-to-model')).toHaveLength(1);
    expect(tight.fake.callsTo('/animations/rig')).toHaveLength(1);
    expect(tight.fake.callsTo('/animations/retarget')).toHaveLength(2);
    expect(finished?.creditsSpent).toBeGreaterThan(spentBefore);
    rmSync(tight.dir, { recursive: true, force: true });
  });

  it('blocks again on resume when the ceiling was not actually raised', async () => {
    // Pressing the button is not an authorisation to spend.
    const tight = build({ STUDIO_CEILING_PER_RUN: '100' });
    scriptSuccess(tight.fake);
    seedJob(tight);
    await tight.pipeline.run('job-1');

    tight.pipeline.unblock('job-1');
    await tight.pipeline.run('job-1');
    expect(tight.store.getJob('job-1')?.status).toBe('blocked');
    expect(tight.fake.callsTo('/animations/retarget')).toHaveLength(0);
    rmSync(tight.dir, { recursive: true, force: true });
  });

  it('never resumes a failed job through the blocked path', async () => {
    // The whole reason blocked and failed are different states. `resume` is for a
    // job that was stopped before spending; a failure goes through `retry`, which
    // is priced and confirmed separately.
    harness.fake
      .script('/generation/image-to-model', { creditsConsumed: 20, modelUrl: MESH_URL })
      .script('/animations/rig-check', { creditsConsumed: 0, riggable: true, rigType: 'biped' })
      .script('/animations/rig', { status: 'failed', message: 'internal error' });
    seedJob(harness);
    await harness.pipeline.run('job-1');
    expect(harness.store.getJob('job-1')?.status).toBe('failed');

    expect(harness.pipeline.unblock('job-1')).toBeNull();
    expect(harness.store.getJob('job-1')?.status).toBe('failed');
    expect(harness.fake.callsTo('/animations/rig')).toHaveLength(1);
  });

  it('nothing puts a failed job back on its own', async () => {
    // The rule that matters: no timer, no loop, no boot-time sweep picks a
    // failure back up. `retry` exists, and only a person reaches it.
    harness.fake
      .script('/generation/image-to-model', { creditsConsumed: 50, modelUrl: MESH_URL })
      .script('/animations/rig-check', { creditsConsumed: 0, riggable: true, rigType: 'biped' })
      .script('/animations/rig', { status: 'failed', message: 'internal error' });
    seedJob(harness);
    await harness.pipeline.run('job-1');

    const before = harness.fake.calls.length;
    // A restart is the loop most likely to get this wrong: it sweeps everything
    // that was mid-flight, and a failed job must not be in that set.
    restart(harness).resume();
    await harness.pipeline.run('job-1');
    expect(harness.fake.calls.length).toBe(before);
    expect(harness.store.getJob('job-1')?.status).toBe('failed');
  });

  it('will not resume a job that is merely running or already done', async () => {
    scriptSuccess(harness.fake);
    seedJob(harness);
    await harness.pipeline.run('job-1');
    expect(harness.pipeline.unblock('job-1')).toBeNull();
    expect(harness.pipeline.unblock('no-such-job')).toBeNull();
  });

  it('carries on from a failed retarget without re-buying the mesh or the rig', async () => {
    // The reported bug. A retarget that fails leaves a mesh and a rig that were
    // paid for and are on disk, and before this the only way forward was a new
    // job that bought both again -- 75 credits to recover from a 25 credit call
    // going wrong.
    scriptSuccess(harness.fake);
    harness.fake.script('/animations/retarget', { status: 'failed', message: 'preset unavailable' });
    seedJob(harness);
    await harness.pipeline.run('job-1');

    const failed = harness.store.getJob('job-1') as Job;
    expect(failed.status).toBe('failed');
    expect(failed.artifacts.meshGlb).toContain('mesh.glb');
    expect(failed.artifacts.riggedGlb).toContain('rigged.glb');

    harness.fake.script('/animations/retarget', { creditsConsumed: 25, modelUrl: CLIP_URL });
    expect(harness.pipeline.retry('job-1')).not.toBeNull();
    const finished = await harness.pipeline.run('job-1');

    expect(finished?.status).toBe('succeeded');
    // The two calls that matter: neither was made a second time.
    expect(harness.fake.callsTo('/generation/image-to-model')).toHaveLength(1);
    expect(harness.fake.callsTo('/animations/rig')).toHaveLength(1);
    expect(Object.keys(finished?.artifacts.clipGlbs ?? {})).toEqual(['idle', 'run']);
  });

  it('forgets a task the API called failed, so a retry submits instead of re-polling', async () => {
    // Without this the retry has a button that cannot work: `paidCall` would
    // resume the dead task id, poll it, get the same failure, and fail again --
    // forever, and free, which is its own kind of maddening.
    scriptSuccess(harness.fake);
    harness.fake.script('/animations/rig', { status: 'failed', message: 'internal error' });
    seedJob(harness);
    await harness.pipeline.run('job-1');
    expect((harness.store.getJob('job-1') as Job).inFlight['rig']).toBeUndefined();
  });

  it('keeps a task we merely gave up on, because it may still be running', async () => {
    // The other half of the same rule, and the expensive half. A timeout is our
    // impatience, not the API's verdict: the task may yet succeed and will be
    // billed either way, so its id is worth keeping and re-polling.
    const slow = build();
    scriptSuccess(slow.fake);
    slow.fake.script('/animations/rig', { pollsBeforeDone: 10_000 });
    seedJob(slow);
    await slow.pipeline.run('job-1');

    const job = slow.store.getJob('job-1') as Job;
    expect(job.status).toBe('failed');
    expect(job.message).toContain('timed out');
    expect(job.inFlight['rig']).toBeDefined();
    rmSync(slow.dir, { recursive: true, force: true });
  });

  it('retries only a failed job, and only when told to', async () => {
    scriptSuccess(harness.fake);
    seedJob(harness);
    expect(harness.pipeline.retry('no-such-job')).toBeNull();
    await harness.pipeline.run('job-1');
    expect(harness.pipeline.retry('job-1')).toBeNull();
    expect(harness.store.getJob('job-1')?.status).toBe('succeeded');
  });

  it('reports why a task failed, not the word "failed"', async () => {
    // The reported problem: "Auto-rig · failed · 31s / task failed", and that
    // was the whole explanation. Everything the API said about it was being
    // dropped on the floor.
    scriptSuccess(harness.fake);
    harness.fake.script('/animations/rig', {
      status: 'failed',
      message: 'mesh has disconnected components',
    });
    seedJob(harness);
    const job = await harness.pipeline.run('job-1');

    const step = job?.steps.find((entry) => entry.stage === 'rig');
    expect(step?.error).toContain('mesh has disconnected components');
    // And the task id, because a failure nobody can explain is one somebody
    // will want to ask the API about directly.
    expect(step?.error).toMatch(/task task-\d+/);
  });

  it('tells the four terminal statuses apart, because they need different fixes', async () => {
    for (const [rawStatus, needle] of [
      ['banned', 'content moderation'],
      ['expired', 'aged out'],
      ['cancelled', 'cancelled'],
    ] as const) {
      const one = build();
      scriptSuccess(one.fake);
      one.fake.script('/animations/rig', { rawStatus });
      seedJob(one);
      const job = await one.pipeline.run('job-1');
      expect(job?.steps.find((entry) => entry.stage === 'rig')?.error, rawStatus).toContain(needle);
      rmSync(one.dir, { recursive: true, force: true });
    }
  });

  it('falls back to the raw record when no field it knows about is filled in', async () => {
    // The failure worth keeping the record for is exactly the one whose cause is
    // not in any field we thought to read.
    scriptSuccess(harness.fake);
    harness.fake.script('/animations/rig', { status: 'failed', extra: { unexpected_field: 'the real reason' } });
    seedJob(harness);
    const job = await harness.pipeline.run('job-1');
    expect(job?.steps.find((entry) => entry.stage === 'rig')?.error).toContain('the real reason');
  });

  it('reads a reason out of a field other than `message`', async () => {
    scriptSuccess(harness.fake);
    harness.fake.script('/animations/rig', { status: 'failed', extra: { error_msg: 'rig backend unavailable' } });
    seedJob(harness);
    const job = await harness.pipeline.run('job-1');
    expect(job?.steps.find((entry) => entry.stage === 'rig')?.error).toContain('rig backend unavailable');
  });

  it('says whether the source mesh is still alive, since the fixes differ', async () => {
    // A stale input means "start again from the image" and a mesh the rig
    // cannot handle means "generate another mesh". Identical from the outside.
    scriptSuccess(harness.fake);
    harness.fake.script('/animations/rig', { status: 'failed', message: 'boom' });
    seedJob(harness);
    const alive = await harness.pipeline.run('job-1');
    expect(alive?.steps.find((entry) => entry.stage === 'rig')?.error).toContain('still fine');

    // And now with the mesh task itself aged out, which is the case a retry
    // cannot fix and would keep paying to discover. Seeded straight to the rig
    // rather than played through, so the mesh task is one this test named and
    // can age out on purpose.
    const stale = build();
    scriptSuccess(stale.fake);
    stale.fake.script('/animations/rig', { status: 'failed', message: 'boom' });
    stale.fake.rescript('task-mesh', { rawStatus: 'expired' });
    seedJob(stale);
    stale.store.saveJob({
      ...(stale.store.getJob('job-1') as Job),
      status: 'running',
      steps: (stale.store.getJob('job-1') as Job).steps.map((step) =>
        step.stage === 'imageToModel'
          ? { ...step, status: 'done' as const, taskId: 'task-mesh' }
          : step.stage === 'rigCheck'
            ? { ...step, status: 'done' as const, taskId: 'task-check' }
            : step,
      ),
    });
    await stale.pipeline.run('job-1');
    const failure = stale.store.getJob('job-1')?.steps.find((entry) => entry.stage === 'rig')?.error ?? '';
    expect(failure).toContain('no longer usable');
    expect(failure).toContain('Start a new generation');
    rmSync(stale.dir, { recursive: true, force: true });
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

describe('resuming without paying twice', () => {
  it('polls a task that was already submitted instead of buying another', async () => {
    // The window that used to cost money: the submit returned, the id was on
    // disk, and the process died during the poll. A restart re-submitted.
    scriptSuccess(harness.fake);
    seedJob(harness);
    harness.store.saveJob({
      ...(harness.store.getJob('job-1') as Job),
      status: 'running',
      stage: 'imageToModel',
      steps: (harness.store.getJob('job-1') as Job).steps.map((step) =>
        step.stage === 'imageToModel' ? { ...step, status: 'running', taskId: 'task-99' } : step,
      ),
      inFlight: { imageToModel: 'task-99' },
    });

    await restart(harness).run('job-1');
    // Nothing was submitted to the generation endpoint at all -- the existing
    // task was polled.
    expect(harness.fake.callsTo('/generation/image-to-model')).toHaveLength(0);
    expect(harness.fake.callsTo('/tasks/task-99').length).toBeGreaterThan(0);
  });

  it('keeps every clip it has already downloaded, and buys only the rest', async () => {
    // A five-clip retarget interrupted after two. The old code re-ran the whole
    // set; there is no more expensive bug in this pipeline.
    scriptSuccess(harness.fake);
    const many = createJob(
      {
        id: 'job-many',
        unitId: 'grunt',
        skeletonId: 'biped',
        establishesRigFamily: true,
        referenceImageSha256: HASH,
        params: params({ clipIntents: ['idle', 'walk', 'run', 'jump', 'slash'] }),
      },
      0,
    );
    harness.store.saveReferenceImage('job-many', 'ref.png', 'image/png', new Uint8Array([1]));
    harness.store.saveJob(many);
    await harness.pipeline.run('job-many');
    expect(harness.fake.callsTo('/animations/retarget')).toHaveLength(5);

    // Now a second job that already has two of the five on disk.
    const partial = createJob(
      {
        id: 'job-partial',
        unitId: 'grunt2',
        skeletonId: 'biped',
        establishesRigFamily: true,
        referenceImageSha256: HASH,
        params: params({ clipIntents: ['idle', 'walk', 'run', 'jump', 'slash'] }),
      },
      0,
    );
    harness.store.saveReferenceImage('job-partial', 'ref.png', 'image/png', new Uint8Array([1]));
    const done = harness.store.getJob('job-many') as Job;
    harness.store.saveJob({
      ...partial,
      status: 'running',
      stage: 'retarget',
      rigType: 'biped',
      steps: partial.steps.map((step) =>
        step.stage === 'retarget'
          ? { ...step, status: 'running' as const }
          : { ...step, status: 'done' as const, taskId: `${step.stage}-task` },
      ),
      artifacts: {
        meshGlb: done.artifacts.meshGlb,
        riggedGlb: done.artifacts.riggedGlb,
        clipGlbs: {
          idle: done.artifacts.clipGlbs['idle'] ?? '',
          walk: done.artifacts.clipGlbs['walk'] ?? '',
        },
      },
    });

    const before = harness.fake.callsTo('/animations/retarget').length;
    await restart(harness).run('job-partial');
    const bought = harness.fake.callsTo('/animations/retarget').length - before;
    expect(bought).toBe(3);
    expect(Object.keys((harness.store.getJob('job-partial') as Job).artifacts.clipGlbs).sort()).toEqual([
      'idle',
      'jump',
      'run',
      'slash',
      'walk',
    ]);
  });

  it('records a re-polled task charge once, not twice', async () => {
    scriptSuccess(harness.fake);
    seedJob(harness);
    await harness.pipeline.run('job-1');
    const entries = harness.store.listLedger().length;
    const spent = (harness.store.getJob('job-1') as Job).creditsSpent;

    // Re-running a finished job must add nothing; the ledger is the only record
    // of what was spent and a duplicate inflates every ceiling check built on it.
    await restart(harness).run('job-1');
    expect(harness.store.listLedger()).toHaveLength(entries);
    expect((harness.store.getJob('job-1') as Job).creditsSpent).toBe(spent);
  });

  it('has written the charge before the file, so a crash between them under-reports nothing', async () => {
    // The ledger entry lands before the download. A process that died in the
    // gap would leave a job whose spend is recorded and whose file is not --
    // which is recoverable. The other order is not.
    scriptSuccess(harness.fake);
    seedJob(harness);
    const order: string[] = [];
    const spy = new StudioPipeline({
      client: new TripoClient({
        apiKey: 'tsk_secret',
        baseUrl: 'https://openapi.example/v3',
        fetch: async (url, init) => {
          if (url.startsWith('https://cdn.example')) {
            order.push(`download:${harness.store.listLedger().length}`);
          }
          return harness.fake.fetch(url, init);
        },
      }),
      store: harness.store,
      config: harness.config,
      now: () => 0,
      sleep: () => Promise.resolve(),
      writeArtifact: (jobId, filename, bytes) => harness.store.writeArtifact(jobId, filename, bytes),
    });
    await spy.run('job-1');
    // The first download happened with the mesh's charge already in the ledger.
    expect(order[0]).toBe('download:1');
  });

  it('leaves nothing in flight once a job has succeeded', async () => {
    scriptSuccess(harness.fake);
    seedJob(harness);
    const job = await harness.pipeline.run('job-1');
    expect(job?.inFlight).toEqual({});
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
