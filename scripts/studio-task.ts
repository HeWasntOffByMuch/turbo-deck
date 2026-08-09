/**
 * Ask the API what actually happened to a task.
 *
 *   npx tsx scripts/studio-task.ts <task-id>
 *   npx tsx scripts/studio-task.ts --job <job-id>     # every task the job made
 *   npx tsx scripts/studio-task.ts --failed           # every failed job's tasks
 *
 * Written after a rig came back as "Auto-rig · failed · 31s / task failed" and
 * that was the entire explanation. The pipeline now keeps the raw record, but
 * that only helps failures from here on; the jobs already on disk have a task id
 * and nothing else, and the task id is enough to go and ask.
 *
 * Free: reading a task costs nothing, and this never submits anything. It reads
 * the key from the environment the same way the server does, and prints the
 * record with the key redacted out of it.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStudioConfig } from '../src/server/studio/config.js';
import { studioPaths, StudioStore } from '../src/server/studio/store.js';
import { TripoClient } from '../src/server/studio/tripo.js';
import type { Job } from '../src/server/studio/types.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every task a job submitted, newest stage last, with what we recorded about it. */
function tasksOf(job: Job): { readonly stage: string; readonly taskId: string; readonly status: string }[] {
  const found: { stage: string; taskId: string; status: string }[] = [];
  for (const step of job.steps) {
    if (step.taskId) found.push({ stage: step.stage, taskId: step.taskId, status: step.status });
  }
  // In-flight entries are keyed by call rather than by stage, so a retarget that
  // died mid-set has ids here that no step record names.
  for (const [key, taskId] of Object.entries(job.inFlight ?? {})) {
    if (!found.some((entry) => entry.taskId === taskId)) found.push({ stage: key, taskId, status: 'in-flight' });
  }
  return found;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = loadStudioConfig(process.env, join(repoRoot, '.studio'));
  if (config.apiKey === null) {
    console.error('TRIPO_API_KEY is not set, so there is nothing to ask with.');
    process.exitCode = 1;
    return;
  }

  const client = new TripoClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    fetch: (url, init) => fetch(url, init),
  });

  const store = new StudioStore(studioPaths(config.dataDir));
  store.load();

  const wanted: { readonly label: string; readonly taskId: string }[] = [];
  const jobFlag = args.indexOf('--job');

  if (args.includes('--failed')) {
    for (const job of store.listJobs()) {
      if (job.status !== 'failed') continue;
      for (const task of tasksOf(job)) wanted.push({ label: `${job.unitId} ${job.id.slice(0, 8)}/${task.stage} (${task.status})`, taskId: task.taskId });
    }
  } else if (jobFlag >= 0) {
    const id = args[jobFlag + 1] ?? '';
    const job = store.listJobs().find((candidate) => candidate.id === id || candidate.id.startsWith(id));
    if (!job) {
      console.error(`no job matching "${id}" in ${config.dataDir}`);
      process.exitCode = 1;
      return;
    }
    for (const task of tasksOf(job)) wanted.push({ label: `${job.unitId}/${task.stage} (${task.status})`, taskId: task.taskId });
  } else {
    for (const id of args.filter((arg) => !arg.startsWith('--'))) wanted.push({ label: 'task', taskId: id });
  }

  if (wanted.length === 0) {
    console.error('nothing to look up. Pass a task id, `--job <id>`, or `--failed`.');
    process.exitCode = 1;
    return;
  }

  for (const { label, taskId } of wanted) {
    console.log(`\n=== ${label} · ${taskId} ===`);
    try {
      // Paced by hand: the API asks for about one request a second, and this
      // walks a whole job's worth.
      const record = await client.rawTask(taskId);
      console.log(JSON.stringify(record, null, 2));
    } catch (cause) {
      console.error(`  could not read it: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    await new Promise((done) => setTimeout(done, 1100));
  }
}

await main();
