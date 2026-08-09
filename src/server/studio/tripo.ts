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
 * ## What the wire actually is, and how it was established
 *
 * The first real call corrected most of this file, which is exactly what the
 * quarantine was for. `POST /upload` came back `No endpoint found`, and the
 * shapes below were then cross-checked against several independent published
 * v3 integrations that agree with each other:
 *
 * | call | shape |
 * |---|---|
 * | base URL | `https://openapi.tripo3d.ai/v3` |
 * | auth | `Authorization: Bearer <key>` |
 * | upload (free) | `POST /files`, multipart field `file` -> `data.file_token` |
 * | image to model | `POST /generation/image-to-model` `{input, model, face_limit, texture, pbr}` |
 * | rig check (free) | `POST /animations/rig-check` `{input}` -> `output.{riggable, rig_type}` |
 * | rig | `POST /animations/rig` `{input, model, spec, out_format}` |
 * | retarget | `POST /animations/retarget` `{input, animations, out_format}` |
 * | poll | `GET /tasks/{task_id}`, plural, no faster than ~3s |
 * | envelope | `{ code, data }`, `code === 0` on success |
 * | spend | `data.credits_consumed` |
 * | model url | `data.output.model_url`, expiring in ~5 minutes |
 *
 * Four of these were wrong in the first draft and are worth naming, because
 * each is a different kind of mistake:
 *
 *  - **`/upload` is `/files`.** A guessed path, and the one that failed first.
 *  - **`input` is a bare token or task id**, not an object wrapping one.
 *  - **`model`, not `model_version`.** And the rig takes its *own* model
 *    version, which is not the generation one -- see {@link RigRequest}.
 *  - **Retarget takes one animation per call.** The v2-era batching this was
 *    written around does not exist. That is a *cost* correction, not a shape
 *    one: five clips are five calls, and {@link RETARGET_BATCH_SIZE} moving to 1
 *    is what keeps the projection and the ceilings honest about it. The preset
 *    is a bare `preset:walk` -- see {@link BIPED_ANIMATION_PRESETS} for the
 *    names a biped actually has.
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
  /**
   * The rig the check recommends: `biped`, `quadruped`, `avian` and so on.
   *
   * Read rather than assumed, and then carried all the way to the retarget --
   * not into the preset name, which is bare, but into *which vocabulary the
   * names are checked against*. A biped's presets are known
   * ({@link BIPED_ANIMATION_PRESETS}); anything else is passed through
   * unchecked rather than refused against a list nobody has confirmed.
   */
  readonly rigType: string | null;
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
  /**
   * The **rig** model version, which is not the generation model version.
   *
   * Two different date-stamped ids in one pipeline, and passing the generation
   * one here is rejected -- as is letting the server pick its own default. It is
   * configuration rather than a constant for the same reason the prices are.
   */
  readonly modelVersion: string;
  /** `mixamo` for a biped: the naming contract the whole roster shares. */
  readonly spec: string;
  readonly outFormat: 'glb';
}

export interface RetargetRequest {
  readonly sourceTaskId: string;
  /**
   * Exactly one, as a bare preset name: `preset:walk`.
   *
   * An array because the field is one, not because more than one fits. See
   * {@link RETARGET_BATCH_SIZE}.
   */
  readonly animations: readonly string[];
  readonly outFormat: 'glb';
}

/**
 * The animations a biped rig can actually be given.
 *
 * The real vocabulary, and the reason it is written down rather than left to
 * whatever somebody types: retarget is a paid call per clip, so a name the API
 * does not know is not a validation error, it is a charge for nothing. Holding
 * the list here lets an unknown intent be refused *before* anything is sent.
 *
 * Note what is not in it. There is no `attack` and no `death` -- the nearest are
 * `slash` and `fall`, and those are the names to use rather than a mapping
 * somebody invented. `fall` in particular is a fall, not necessarily a death, and
 * quietly aliasing one to the other would put the wrong animation on a corpse.
 */
export const BIPED_ANIMATION_PRESETS: readonly string[] = [
  'idle',
  'walk',
  'run',
  'dive',
  'climb',
  'jump',
  'slash',
  'shoot',
  'hurt',
  'fall',
  'turn',
];

/**
 * A clip intent turned into the preset name the API wants.
 *
 * Just `preset:<name>` -- **not** namespaced by rig type. An earlier draft sent
 * `preset:biped:walk` on the strength of a third-party integration note; the
 * real API takes the bare form.
 */
export function presetFor(intent: string): string {
  return `preset:${intent}`;
}

/**
 * The presets a rig type is known to have, or null when we do not know.
 *
 * Null is a real answer and is treated as one: only the biped list has been
 * confirmed, so a quadruped's intents are passed through unchecked rather than
 * refused against a list that was guessed. Refusing on an invented list would
 * block work that would have succeeded, which is the opposite failure but still
 * a failure.
 */
export function knownPresetsFor(rigType: string | null): readonly string[] | null {
  return rigType === null || rigType === 'biped' ? BIPED_ANIMATION_PRESETS : null;
}

/** Intents this rig has no preset for. Empty when the vocabulary is unknown. */
export function unknownPresets(rigType: string | null, intents: readonly string[]): readonly string[] {
  const known = knownPresetsFor(rigType);
  if (known === null) return [];
  return intents.filter((intent) => !known.includes(intent));
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
 * Splits a clip list into calls.
 *
 * One clip per call, since {@link RETARGET_BATCH_SIZE} is 1 -- the API rejects a
 * multi-preset batch. Kept as a split rather than collapsed into a map because
 * the cost projection calls the same function: what the client does and what the
 * ceiling was checked against have to be the same number, and a batch size that
 * changes again should change both at once.
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
    // `/files`, not `/upload` -- the latter is what the first real attempt tried
    // and it answered "No endpoint found". The only call here that returns
    // something other than a task id.
    const envelope = await this.request('/files', { method: 'POST', body: form });
    const token = asString(envelope.data?.['file_token']);
    if (token === null) throw new TripoError('/files: response carried no file_token', null, null);
    return token;
  }

  imageToModel(request: ImageToModelRequest): Promise<TaskHandle> {
    return this.submit('/generation/image-to-model', {
      // `input` is the bare file token and `model` is the field name -- both
      // were wrong in the first draft, which had the v2 shapes.
      input: request.fileToken,
      model: request.modelVersion,
      face_limit: request.faceLimit,
      texture: request.texture,
      pbr: request.pbr,
    });
  }

  /** Free, so it is never skipped: it is what stops a rig call that cannot work. */
  rigCheck(sourceTaskId: string): Promise<TaskHandle> {
    return this.submit('/animations/rig-check', { input: sourceTaskId });
  }

  rig(request: RigRequest): Promise<TaskHandle> {
    return this.submit('/animations/rig', {
      input: request.sourceTaskId,
      model: request.modelVersion,
      // The shared-skeleton constraint starts here: one naming spec for the
      // whole roster, so clips bind by bone name across every unit.
      spec: request.spec,
      out_format: request.outFormat,
    });
  }

  retarget(request: RetargetRequest): Promise<TaskHandle> {
    if (request.animations.length > RETARGET_BATCH_SIZE) {
      throw new TripoError(
        `retarget takes ${RETARGET_BATCH_SIZE} animation per call, got ${request.animations.length}`,
        null,
        null,
      );
    }
    return this.submit('/animations/retarget', {
      input: request.sourceTaskId,
      // Plain preset strings. The `{animation, bake_animation}` objects the
      // first draft sent were a v2-era shape.
      animations: [...request.animations],
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
      // `model_url` is the v3 spelling; the other two are accepted because the
      // cost of being wrong here is asymmetric. Missing the URL turns a paid
      // success into "nothing was saved" five minutes later, and accepting a
      // second spelling costs nothing. Credits get no such latitude -- a wrong
      // default there would quietly corrupt the ledger instead of failing.
      modelUrl: asString(output['model_url']) ?? asString(output['model']) ?? asString(output['pbr_model']),
      riggable: typeof output['riggable'] === 'boolean' ? output['riggable'] : null,
      rigType: asString(output['rig_type']),
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
