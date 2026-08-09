/**
 * A Tripo the tests can drive (spec 108).
 *
 * A fake `fetch` rather than a fake `TripoClient`, so the real client's URL
 * building, envelope handling, header setting and status mapping are all under
 * test. Faking the client instead would leave the one file that talks to the
 * paid API as the only file with no coverage, which is precisely backwards.
 *
 * Everything is scripted and nothing is timed: a task moves from running to
 * finished when a test says so, or after a set number of polls. That is what
 * lets the retry-never rule, the ceiling stops and the download-before-expiry
 * ordering be asserted in milliseconds.
 */

import type { FetchLike } from './tripo.js';

export interface ScriptedTask {
  /** Polls to report `running` before finishing. */
  readonly pollsBeforeDone?: number;
  readonly status?: 'success' | 'failed';
  readonly creditsConsumed?: number | null;
  readonly modelUrl?: string | null;
  readonly riggable?: boolean;
  readonly message?: string;
}

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
  readonly atMs: number;
}

export class FakeTripo {
  readonly calls: RecordedCall[] = [];
  /** Bytes served for a download, keyed by URL. */
  readonly downloads = new Map<string, Uint8Array>();
  private readonly scripts = new Map<string, ScriptedTask>();
  private readonly polls = new Map<string, number>();
  private nextTaskId = 1;
  /** Which script a newly created task of each endpoint gets. */
  private readonly byEndpoint = new Map<string, ScriptedTask>();
  /** Set to throw on the next submit, for the transport-failure path. */
  networkError: string | null = null;

  constructor(private readonly now: () => number = () => 0) {}

  /** Scripts what a task created by `endpoint` will do. */
  script(endpoint: string, task: ScriptedTask): this {
    this.byEndpoint.set(endpoint, task);
    return this;
  }

  get submitCount(): number {
    return this.calls.filter((call) => call.method === 'POST' && !call.url.includes('/tasks/')).length;
  }

  /**
   * Calls to exactly this endpoint.
   *
   * Compared on the pathname rather than with `includes`, because
   * `/animations/rig` is a substring of `/animations/rig-check` -- and a helper
   * that conflated the free call with the paid one would make the tests that
   * matter most here quietly meaningless.
   */
  callsTo(endpoint: string): RecordedCall[] {
    return this.calls.filter((call) => new URL(call.url).pathname.endsWith(endpoint));
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  readonly fetch: FetchLike = async (url, init) => {
    const method = init.method ?? 'GET';
    let parsed: unknown = null;
    if (typeof init.body === 'string') {
      try {
        parsed = JSON.parse(init.body) as unknown;
      } catch {
        parsed = init.body;
      }
    }
    const headers = (init.headers ?? {}) as Record<string, string>;
    this.calls.push({ url, method, body: parsed, authorization: headers['Authorization'], atMs: this.now() });

    if (this.networkError !== null) {
      const message = this.networkError;
      this.networkError = null;
      throw new Error(message);
    }

    // A download: anything that is not our base URL.
    const served = this.downloads.get(url);
    if (served) {
      return new Response(served as unknown as BodyInit, { status: 200 });
    }

    if (url.includes('/upload')) {
      return this.json({ code: 0, data: { image_token: 'token-1' } });
    }

    const taskMatch = /\/tasks\/([^/?]+)$/.exec(url);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1] ?? '');
      const script = this.scripts.get(taskId) ?? {};
      const seen = (this.polls.get(taskId) ?? 0) + 1;
      this.polls.set(taskId, seen);

      if (seen <= (script.pollsBeforeDone ?? 0)) {
        return this.json({ code: 0, data: { task_id: taskId, status: 'running', progress: 0.5 } });
      }
      const status = script.status ?? 'success';
      const output: Record<string, unknown> = {};
      if (script.modelUrl !== undefined && script.modelUrl !== null) output['model'] = script.modelUrl;
      if (script.riggable !== undefined) output['riggable'] = script.riggable;

      const data: Record<string, unknown> = { task_id: taskId, status, output };
      // Absent rather than zero when the script says null, so the "the API did
      // not tell us what it charged" path is genuinely exercised.
      if (script.creditsConsumed !== null) data['credits_consumed'] = script.creditsConsumed ?? 5;
      if (script.message !== undefined) data['message'] = script.message;
      return this.json({ code: 0, data });
    }

    // A submit. Mint a task id and bind it to whatever this endpoint scripted.
    const endpoint = new URL(url).pathname.replace(/^\/v3/, '');
    const taskId = `task-${this.nextTaskId++}`;
    this.scripts.set(taskId, this.byEndpoint.get(endpoint) ?? {});
    return this.json({ code: 0, data: { task_id: taskId } });
  };
}
