/**
 * The Tripo client (spec 108).
 *
 * **This is the only file in the repository that knows Tripo's URLs, field
 * names or status strings.** Everything above it works in the vocabulary
 * declared at the bottom of this file -- `TaskHandle`, `TaskResult`,
 * `RigCheckOutput` -- so when the first real call disagrees with what is written
 * here, the correction is this file and nothing else.
 *
 * That quarantine is not tidiness. This environment's egress policy blocks
 * `openapi.tripo3d.ai`, so nothing here has been executed against the real
 * service; every test drives {@link TripoClient} through an injected fetch. A
 * layer that had spread the API's field names through the pipeline would turn
 * "the docs said `credits_consumed` and the API says `consumed_credits`" into a
 * day of archaeology instead of one line.
 *
 * ## What is assumed, and where it came from
 *
 * From the brief and from the published endpoint list:
 *
 * | assumption | value |
 * |---|---|
 * | base URL | `https://openapi.tripo3d.ai/v3` |
 * | auth | `Authorization: Bearer <key>` |
 * | image to model | `POST /generation/image-to-model` |
 * | rig check (free) | `POST /animations/rig-check` |
 * | rig | `POST /animations/rig`, `spec: "mixamo"`, `out_format: "glb"` |
 * | retarget | `POST /animations/retarget`, batched, <= 5 clips per call |
 * | poll | `GET /tasks/{task_id}` |
 * | envelope | `{ code, data }`, `code === 0` on success |
 * | task id | `data.task_id` |
 * | status | `data.status`: queued / running / success / failed / cancelled / banned |
 * | spend | `data.credits_consumed` |
 * | model url | `data.output.model` (or `.pbr_model`) |
 * | riggable | `data.output.riggable` |
 *
 * Anything the API returns that is not in that table is ignored rather than
 * guessed at. `credits_consumed` in particular is surfaced as `null` when it is
 * absent rather than defaulted to zero: a ledger that quietly records nothing
 * for a call that was billed is worse than one that says it does not know.
 *
 * ## The key
 *
 * Read once, held here, and never put anywhere it could travel: not into an
 * error message, not into a log line, not into a response body. {@link redact}
 * exists because a fetch failure's message can contain the request, and the one
 * time anybody reads an error closely is when they paste it somewhere.
 */

import { canonicalClipIntents } from './cache.js';
import { RETARGET_BATCH_SIZE } from './pricing.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_BASE_URL = 'https://openapi.tripo3d.ai/v3';

/** Where a task has got to, in our words rather than theirs. */
export type TaskState = 'pending' | 'running' | 'succeeded' | 'failed';

export interface TaskHandle {
  readonly taskId: string;
}

export interface TaskResult {
  readonly taskId: string;
  readonly state: TaskState;
  /** 0..1 when the API reports it, else null. */
  readonly progress: number | null;
  /**
   * What the API said it charged, or null when it did not say.
   *
   * Null is a real answer and is stored as one. Defaulting to zero would put a
   * free call and an unreported paid one in the same bucket, and the ledger
   * exists precisely so those cannot be confused.
   */
  readonly creditsConsumed: number | null;
  /** Expires ~5 minutes after success. Download in the same handler; never store. */
  readonly modelUrl: string | null;
  /** Only on a rig-check result. */
  readonly riggable: boolean | null;
  readonly error: string | null;
}

export interface ImageToModelRequest {
  /** From {@link TripoClient.uploadImage}. */
  readonly fileToken: string;
  readonly modelVersion: string;
  readonly faceLimit: number;
  readonly texture: boolean;
  readonly pbr: boolean;
}

export interface RigRequest {
  /** The task whose model output is being rigged. */
  readonly sourceTaskId: string;
  readonly outFormat: 'glb';
}

export interface RetargetRequest {
  readonly sourceTaskId: string;
  /** At most {@link RETARGET_BATCH_SIZE}; {@link batchClips} does the splitting. */
  readonly animations: readonly string[];
  readonly outFormat: 'glb';
}

export class TripoError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: number | null,
  ) {
    super(message);
    this.name = 'TripoError';
  }
}

/**
 * Splits a clip list into calls of at most five.
 *
 * Exported and pure because the cost projection has to agree with what the
 * client actually does -- nine clips is two calls, and a projection that priced
 * nine would be wrong in the direction that makes the ceiling useless.
 */
export function batchClips(intents: readonly string[]): readonly (readonly string[])[] {
  const ordered = canonicalClipIntents(intents);
  const batches: string[][] = [];
  for (let i = 0; i < ordered.length; i += RETARGET_BATCH_SIZE) {
    batches.push(ordered.slice(i, i + RETARGET_BATCH_SIZE));
  }
  return batches;
}

/**
 * Removes anything that looks like the key from a string.
 *
 * Belt and braces: the key is never deliberately put into a message, and this is
 * what catches the time it ends up in one anyway -- a fetch implementation that
 * echoes its headers, a proxy error that quotes the request line.
 */
export function redact(text: string, key: string): string {
  if (key.length === 0) return text;
  return text.split(key).join('<redacted>');
}

interface Envelope {
  readonly code?: number;
  readonly message?: string;
  readonly data?: Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Their status vocabulary, mapped onto ours. Unknown strings are not successes. */
function toState(status: unknown): TaskState {
  switch (status) {
    case 'success':
      return 'succeeded';
    case 'running':
      return 'running';
    case 'queued':
    case 'pending':
      return 'pending';
    case 'failed':
    case 'cancelled':
    case 'banned':
    case 'expired':
      return 'failed';
    default:
      // An unrecognised status is treated as still running rather than as done.
      // The opposite default would have an unknown string look like a success
      // and send the pipeline off to download a URL that is not there.
      return 'running';
  }
}

export interface TripoClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch: FetchLike;
  /** Optional completion callback. Polling is the default and always works. */
  readonly webhookUrl?: string | undefined;
}

export class TripoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly doFetch: FetchLike;
  private readonly webhookUrl: string | undefined;

  constructor(options: TripoClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.doFetch = options.fetch;
    this.webhookUrl = options.webhookUrl;
  }

  private async request(path: string, init: RequestInit): Promise<Envelope> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.doFetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...(init.headers ?? {}) },
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new TripoError(`${path}: ${redact(detail, this.apiKey)}`, null, null);
    }

    const text = await response.text();
    let envelope: Envelope;
    try {
      envelope = JSON.parse(text) as Envelope;
    } catch {
      throw new TripoError(
        `${path}: HTTP ${response.status}, unreadable body: ${redact(text.slice(0, 200), this.apiKey)}`,
        response.status,
        null,
      );
    }

    if (!response.ok || (envelope.code !== undefined && envelope.code !== 0)) {
      const message = envelope.message ?? `HTTP ${response.status}`;
      throw new TripoError(
        `${path}: ${redact(message, this.apiKey)}`,
        response.status,
        envelope.code ?? null,
      );
    }
    return envelope;
  }

  private async submit(path: string, body: Record<string, unknown>): Promise<TaskHandle> {
    const payload = this.webhookUrl === undefined ? body : { ...body, webhook_url: this.webhookUrl };
    const envelope = await this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const taskId = asString(envelope.data?.['task_id']);
    if (taskId === null) throw new TripoError(`${path}: response carried no task_id`, null, null);
    return { taskId };
  }

  /**
   * Uploads the reference image and returns the token the generation call takes.
   *
   * Part of the image-to-model stage rather than a stage of its own: it is free,
   * it has no task to poll, and a progress UI with an "uploading" row that
   * finishes instantly is noise.
   */
  async uploadImage(bytes: Uint8Array, filename: string, contentType: string): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([bytes as unknown as BlobPart], { type: contentType }), filename);
    const envelope = await this.request('/upload', { method: 'POST', body: form });
    const token = asString(envelope.data?.['image_token'] ?? envelope.data?.['file_token']);
    if (token === null) throw new TripoError('/upload: response carried no file token', null, null);
    return token;
  }

  imageToModel(request: ImageToModelRequest): Promise<TaskHandle> {
    return this.submit('/generation/image-to-model', {
      model_version: request.modelVersion,
      file: { type: 'image', file_token: request.fileToken },
      face_limit: request.faceLimit,
      texture: request.texture,
      pbr: request.pbr,
    });
  }

  /** Free, so it is never skipped: it is what stops a rig call that cannot work. */
  rigCheck(sourceTaskId: string): Promise<TaskHandle> {
    return this.submit('/animations/rig-check', { input: { task_id: sourceTaskId } });
  }

  rig(request: RigRequest): Promise<TaskHandle> {
    return this.submit('/animations/rig', {
      input: { task_id: request.sourceTaskId },
      // The shared-skeleton constraint starts here: one naming spec for the
      // whole roster, so clips bind by bone name across every unit.
      spec: 'mixamo',
      out_format: request.outFormat,
    });
  }

  retarget(request: RetargetRequest): Promise<TaskHandle> {
    if (request.animations.length > RETARGET_BATCH_SIZE) {
      throw new TripoError(
        `retarget takes at most ${RETARGET_BATCH_SIZE} animations per call, got ${request.animations.length}`,
        null,
        null,
      );
    }
    return this.submit('/animations/retarget', {
      input: { task_id: request.sourceTaskId },
      animations: request.animations.map((animation) => ({ animation, bake_animation: true })),
      out_format: request.outFormat,
    });
  }

  async task(taskId: string): Promise<TaskResult> {
    const envelope = await this.request(`/tasks/${encodeURIComponent(taskId)}`, { method: 'GET' });
    const data = envelope.data ?? {};
    const output = (data['output'] ?? {}) as Record<string, unknown>;
    const state = toState(data['status']);
    return {
      taskId,
      state,
      progress: asNumber(data['progress']),
      creditsConsumed: asNumber(data['credits_consumed']),
      modelUrl: asString(output['model']) ?? asString(output['pbr_model']),
      riggable: typeof output['riggable'] === 'boolean' ? output['riggable'] : null,
      error: state === 'failed' ? (asString(data['message']) ?? 'task failed') : null,
    };
  }

  /**
   * Fetches a model URL's bytes.
   *
   * Separate from {@link request} because it is not an API call: the URL is
   * pre-signed and short-lived, and sending the key to whatever host it points
   * at would be handing a credential to a CDN.
   */
  async download(url: string): Promise<Uint8Array> {
    const response = await this.doFetch(url, { method: 'GET' });
    if (!response.ok) {
      throw new TripoError(`download failed: HTTP ${response.status}`, response.status, null);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
