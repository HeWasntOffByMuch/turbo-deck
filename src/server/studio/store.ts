/**
 * Where a job survives a restart (spec 108).
 *
 * Two files, and they are different shapes on purpose.
 *
 * `jobs.json` is the queue, rewritten whole on every change through a
 * **temp-write and rename**. Rename is atomic on every filesystem this will run
 * on, so a process killed mid-write leaves the previous file intact rather than
 * a truncated one -- and a truncated queue is a set of paid tasks nobody is
 * polling any more.
 *
 * `ledger.jsonl` is **append-only**, one JSON object per line. A ledger that
 * gets rewritten is a ledger that can lose an entry, and the whole reason to
 * keep one is to be able to say later what was actually spent. Appending also
 * means a partially-written last line loses one entry instead of all of them.
 *
 * Justifying the choice over sqlite, since the brief asked: job volume here is
 * tens. The repo has no native dependencies and no database anywhere;
 * `node:sqlite` on Node 22 is still experimental. A JSON file is greppable and
 * diffable at three in the morning when a paid job has gone wrong, which is the
 * only occasion anybody will ever open it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LedgerEntry } from './ledger.js';
import type { Job } from './types.js';

export interface StudioPaths {
  readonly root: string;
  readonly jobsFile: string;
  readonly ledgerFile: string;
  readonly assetsDir: string;
}

export function studioPaths(root: string): StudioPaths {
  return {
    root,
    jobsFile: join(root, 'jobs.json'),
    ledgerFile: join(root, 'ledger.jsonl'),
    assetsDir: join(root, 'assets'),
  };
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Writes through a sibling temp file and renames over the target.
 *
 * The temp file has to be in the same directory, not in the OS temp dir: rename
 * is only atomic within a filesystem, and `/tmp` is frequently a different one.
 */
function writeAtomic(path: string, contents: string): void {
  ensureDir(dirname(path));
  const temp = `${path}.tmp`;
  writeFileSync(temp, contents, 'utf8');
  renameSync(temp, path);
}

export class StudioStore {
  private jobs: Job[] = [];
  private ledger: LedgerEntry[] = [];

  constructor(readonly paths: StudioPaths) {}

  /**
   * Reads both files.
   *
   * A ledger line that will not parse is skipped and counted rather than
   * throwing: a half-written final line from a kill is the expected damage, and
   * refusing to boot over it would turn a lost entry into a dead server.
   */
  load(): { readonly jobs: number; readonly ledger: number; readonly skippedLedgerLines: number } {
    ensureDir(this.paths.root);
    ensureDir(this.paths.assetsDir);

    this.jobs = [];
    if (existsSync(this.paths.jobsFile)) {
      const text = readFileSync(this.paths.jobsFile, 'utf8');
      const parsed = JSON.parse(text) as { jobs?: Job[] };
      this.jobs = parsed.jobs ?? [];
    }

    this.ledger = [];
    let skipped = 0;
    if (existsSync(this.paths.ledgerFile)) {
      for (const line of readFileSync(this.paths.ledgerFile, 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        try {
          this.ledger.push(JSON.parse(line) as LedgerEntry);
        } catch {
          skipped += 1;
        }
      }
    }

    return { jobs: this.jobs.length, ledger: this.ledger.length, skippedLedgerLines: skipped };
  }

  listJobs(): readonly Job[] {
    return this.jobs;
  }

  getJob(id: string): Job | null {
    return this.jobs.find((job) => job.id === id) ?? null;
  }

  listLedger(): readonly LedgerEntry[] {
    return this.ledger;
  }

  /**
   * Inserts or replaces a job and flushes the queue.
   *
   * Synchronous and flushed on every change, because the one thing this file
   * exists to guarantee is that the record is on disk **before** the request
   * that spends money goes out. A batched or deferred write would give that up
   * for an optimisation nothing here needs.
   */
  saveJob(job: Job): void {
    const index = this.jobs.findIndex((candidate) => candidate.id === job.id);
    if (index >= 0) this.jobs[index] = job;
    else this.jobs.push(job);
    writeAtomic(this.paths.jobsFile, `${JSON.stringify({ jobs: this.jobs }, null, 2)}\n`);
  }

  appendLedger(entry: LedgerEntry): void {
    this.ledger.push(entry);
    ensureDir(dirname(this.paths.ledgerFile));
    appendFileSync(this.paths.ledgerFile, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Where a job's downloaded files go. Created on demand. */
  assetDir(jobId: string): string {
    const dir = join(this.paths.assetsDir, jobId);
    ensureDir(dir);
    return dir;
  }

  /** Writes a downloaded artifact into the job's directory. Returns its path. */
  writeArtifact(jobId: string, filename: string, bytes: Uint8Array): string {
    const path = join(this.assetDir(jobId), filename);
    writeFileSync(path, bytes);
    return path;
  }

  /**
   * Keeps the reference image beside the job.
   *
   * Beside it rather than in a temp dir, because it is the input a resumed job
   * needs: a process restarted between accepting an upload and submitting the
   * generation has to be able to find the picture again. The sidecar carries the
   * filename and content type, which the multipart body had and the bytes on
   * disk do not.
   */
  saveReferenceImage(jobId: string, filename: string, contentType: string, bytes: Uint8Array): string {
    const dir = this.assetDir(jobId);
    const path = join(dir, 'reference.bin');
    writeFileSync(path, bytes);
    writeAtomic(join(dir, 'reference.json'), `${JSON.stringify({ filename, contentType })}\n`);
    return path;
  }

  readReferenceImage(
    jobId: string,
  ): { readonly bytes: Uint8Array; readonly filename: string; readonly contentType: string } | null {
    const dir = join(this.paths.assetsDir, jobId);
    const path = join(dir, 'reference.bin');
    const metaPath = join(dir, 'reference.json');
    if (!existsSync(path) || !existsSync(metaPath)) return null;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      filename?: string;
      contentType?: string;
    };
    return {
      bytes: new Uint8Array(readFileSync(path)),
      filename: meta.filename ?? 'reference.png',
      contentType: meta.contentType ?? 'image/png',
    };
  }
}
