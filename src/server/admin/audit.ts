/**
 * The admin audit log (spec 056): who did what, when, and whether it was
 * allowed.
 *
 * Rejections are recorded as well as successes -- a refused kick from an
 * expired token is exactly the event an accountability log exists to preserve,
 * and a log that only holds successes cannot tell you someone was trying.
 *
 * Writes go through the {@link DataStore}, so moving the log to Postgres is a
 * store swap and not a change here.
 */

import type { DataStore } from '../state/store.js';
import type { AuditEntry } from '../state/types.js';

export type Clock = () => number;

export class AuditLog {
  constructor(
    private readonly store: DataStore,
    private readonly now: Clock = () => Date.now(),
  ) {}

  async record(
    actor: string,
    action: string,
    target: string,
    detail: string,
    accepted: boolean,
  ): Promise<AuditEntry> {
    const entry: AuditEntry = { at: this.now(), actor, action, target, detail, accepted };
    await this.store.appendAudit(entry);
    return entry;
  }

  /** Most recent first. */
  recent(limit: number): Promise<readonly AuditEntry[]> {
    return this.store.listAudit(limit);
  }
}
