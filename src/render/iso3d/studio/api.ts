/**
 * Talking to the studio service from the browser (spec 109).
 *
 * This is the first thing in the client that speaks HTTP to the game server at
 * all -- the Play tab runs a server *in the tab* over a loopback transport, and
 * `npm run dev` and `npm run server` have never needed each other before. So the
 * failure modes deserve more care than a `catch` that says "failed to fetch":
 *
 *  - the server is not running,
 *  - it is running and no token has been pasted,
 *  - a token has been pasted and it is wrong or expired,
 *
 * are three different problems with three different fixes, and one message for
 * all three tells you none of them. {@link StudioApiError} carries the kind so
 * the panel can say which.
 *
 * The token is the admin JWT the server prints at boot, kept in `localStorage`
 * exactly as the admin console already does it. It is never put in a URL: a
 * token in a query string ends up in access logs and in `Referer` headers, and
 * this one authorises spending money.
 */

import type { CostProjection } from '../../../server/studio/pricing.js';
import type { Ceilings, CreditSummary } from '../../../server/studio/ledger.js';
import type { JobArtifacts, JobStatus, Stage, StepRecord } from '../../../server/studio/types.js';
import type { Issue } from '../../../units/index.js';

const TOKEN_KEY = 'turbo-deck.studio.token';

export type ApiErrorKind = 'offline' | 'unauthorized' | 'refused' | 'server';

export class StudioApiError extends Error {
  constructor(
    message: string,
    readonly kind: ApiErrorKind,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'StudioApiError';
  }

  /** What to actually do about it, for the banner. */
  get remedy(): string {
    switch (this.kind) {
      case 'offline':
        return 'The authoring server is not answering. Run `npm run server` in another terminal and reload.';
      case 'unauthorized':
        return 'Paste the admin token the server printed at boot into the field above.';
      case 'refused':
        return this.message;
      case 'server':
        return `The server returned an error: ${this.message}`;
    }
  }
}

export interface JobView {
  readonly id: string;
  readonly unitId: string;
  readonly skeletonId: string;
  readonly establishesRigFamily: boolean;
  readonly status: JobStatus;
  readonly stage: Stage | null;
  readonly steps: readonly StepRecord[];
  readonly creditsSpent: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly message: string | null;
  readonly cacheKey: string;
  readonly referenceImageSha256: string;
  readonly params: {
    readonly modelVersion: string;
    readonly faceLimit: number;
    readonly clipIntents: readonly string[];
  };
  readonly artifacts: JobArtifacts;
}

export interface StudioConfigView {
  readonly keyConfigured: boolean;
  readonly modelVersion: string;
  readonly defaultFaceLimit: number;
  readonly ceilings: Ceilings;
  readonly prices: Record<string, number>;
  readonly maxTimeScale: number;
  readonly webhook: boolean;
}

export interface EstimateResult {
  readonly cached: boolean;
  readonly job?: JobView;
  readonly projection: CostProjection;
  readonly confirmationToken?: string;
  readonly expiresAtMs?: number;
  readonly credits?: CreditSummary;
}

export interface ExportResultView {
  readonly unitDir: string;
  readonly written: readonly string[];
  readonly pending: readonly string[];
  readonly issues: readonly Issue[];
  readonly ok: boolean;
}

export interface GenerationRequest {
  readonly unitId: string;
  readonly skeletonId: string;
  readonly referenceImageSha256: string;
  readonly faceLimit: number;
  readonly clipIntents: readonly string[];
  readonly establishesRigFamily: boolean;
}

export function loadToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    // Private browsing, or storage disabled. The field still works for the
    // session; it just will not survive a reload.
    return '';
  }
}

export function saveToken(token: string): void {
  try {
    if (token === '') localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* nothing to do; the in-memory token still works */
  }
}

export class StudioApi {
  private token: string;

  constructor(private readonly base = '/api/studio') {
    this.token = loadToken();
  }

  setToken(token: string): void {
    this.token = token.trim();
    saveToken(this.token);
  }

  get hasToken(): boolean {
    return this.token !== '';
  }

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.hasToken) {
      throw new StudioApiError('no admin token', 'unauthorized');
    }
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
      });
    } catch {
      // A rejected fetch here means the socket never opened: either nothing is
      // listening, or the dev proxy has nowhere to forward to. Both are "start
      // the server", and neither is anything the user typed wrong.
      throw new StudioApiError('the authoring server did not answer', 'offline');
    }

    const text = await response.text();
    let body: unknown = null;
    let parsed = true;
    try {
      body = text === '' ? null : (JSON.parse(text) as unknown);
    } catch {
      parsed = false;
    }

    if (response.ok) return body ?? {};

    /**
     * Every failure the studio API produces carries a JSON `error` string --
     * `sendJson` is the only way anything in `routes.ts` answers, and the
     * router's own catch-all wraps a thrown error the same way. So a failure
     * *without* one did not come from the studio API at all: it is a dev
     * server's SPA fallback, a proxy error page, or `vite preview` answering an
     * unknown path with an empty 500.
     *
     * That distinction is worth making because the two have completely
     * different fixes. "The server returned an error" sends a reader looking for
     * a bug in code that never ran; "start `npm run server`" is the actual
     * remedy, and it is what this case gets.
     */
    const message = parsed && body !== null ? (body as { error?: string }).error : undefined;
    if (message === undefined) {
      throw new StudioApiError(
        `HTTP ${response.status} with no studio error in it, so the request did not reach the authoring server`,
        'offline',
        response.status,
      );
    }

    if (response.status === 401) throw new StudioApiError(message, 'unauthorized', 401);
    // 4xx that is not an auth problem is the server declining on purpose -- a
    // spent token, a ceiling, a job in the wrong state. Its own words are the
    // best message there is, so they are passed through untouched.
    if (response.status < 500) throw new StudioApiError(message, 'refused', response.status);
    throw new StudioApiError(message, 'server', response.status);
  }

  private json(path: string, body: unknown): Promise<unknown> {
    return this.call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  config(): Promise<StudioConfigView> {
    return this.call('/config') as Promise<StudioConfigView>;
  }

  credits(): Promise<CreditSummary> {
    return this.call('/credits') as Promise<CreditSummary>;
  }

  async jobs(): Promise<readonly JobView[]> {
    const body = (await this.call('/jobs')) as { jobs?: JobView[] };
    return body.jobs ?? [];
  }

  uploadImage(bytes: ArrayBuffer, filename: string, contentType: string): Promise<{ sha256: string; bytes: number }> {
    return this.call(`/images?filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: bytes,
    }) as Promise<{ sha256: string; bytes: number }>;
  }

  estimate(request: GenerationRequest): Promise<EstimateResult> {
    return this.json('/estimate', request) as Promise<EstimateResult>;
  }

  /** The second half of the two-call spend path; the token comes from `estimate`. */
  createJob(request: GenerationRequest, confirmationToken: string): Promise<{ cached: boolean; job: JobView }> {
    return this.json('/jobs', { ...request, confirmationToken }) as Promise<{ cached: boolean; job: JobView }>;
  }

  /** Carries a blocked job on. Refused for anything that is not blocked. */
  resume(jobId: string): Promise<JobView> {
    return this.call(`/jobs/${encodeURIComponent(jobId)}/resume`, { method: 'POST' }) as Promise<JobView>;
  }

  cancel(jobId: string): Promise<JobView> {
    return this.call(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }) as Promise<JobView>;
  }

  /** Writes an authored document back to disk, validated server-side first. */
  async saveDocument(path: string, doc: unknown): Promise<ExportResultView & { path: string }> {
    const body = (await this.call(`/documents?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc }),
    })) as { ok: boolean; path: string; issues: readonly Issue[] };
    return { ...body, written: [], pending: [], unitDir: '' };
  }

  exportJob(jobId: string, options: { skeletonRef?: string; clipLibId?: string } = {}): Promise<ExportResultView> {
    return this.json('/export', { jobId, ...options }) as Promise<ExportResultView>;
  }
}
