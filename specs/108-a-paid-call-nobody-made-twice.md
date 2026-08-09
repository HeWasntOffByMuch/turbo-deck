# 108 — A paid call nobody made twice

## Problem

Generating a unit costs real money through a third-party API, in four
asynchronous steps, against URLs that expire five minutes after they succeed.
Every failure mode here is expensive rather than merely annoying: a browser
refresh mid-flight orphans a task that was paid for, a double-submitted form
buys the same model twice, a retry loop on a failing call spends until the
credits run out, and a success nobody downloaded in time is money for nothing.

So this spec is not "call the API". It is the accounting and the safety
interlocks around calling it, with the call itself quarantined in one file.

## Shape

A Node-only subtree, `src/server/studio/`, wired in from `src/server/index.ts`
and imported by nothing in the server's portable half — the same boundary that
already lets `GameServer` be bundled into a browser tab for single-player. The
API key is read from the process environment there and never leaves it.

### The interlocks

**Confirmation is a server-issued one-shot token, not a browser boolean.**
`POST /api/studio/estimate` prices a generation and returns
`{ projection, confirmationToken, expiresAtMs }`. `POST /api/studio/jobs` will
not submit without a token it issued, that has not been redeemed, and that has
not expired. A double-submitted form redeems a token that is already gone, and
the second attempt is refused rather than charged.

**Ceilings hard-stop before submitting.** A per-run ceiling and a per-day
ceiling, both configurable, both checked against the projection *plus* what has
already been spent, before any request goes out. Over either, the job is
`blocked` — a state distinct from `failed`, because nothing was attempted.

**Cache by reference image and parameters.** A completed job's cache key is a
canonical, readable string over the image's sha256 and every parameter that
changes the output. An identical request returns the existing job's artifacts
and spends nothing.

**Never auto-retry.** A failed paid call moves the job to `failed` and stops.
Nothing on a timer, no boot-time sweep and no loop anywhere picks it back up.

**But a person may say carry on.** The first draft of this rule said re-running
was a *new job*, and that turned out to be the more expensive answer: a retarget
that fails on its third clip strands a mesh and a rig that were paid for and are
sitting on disk, and a new job buys both again — 75 credits to recover from a 25
credit call going wrong. So a failed job has a `retry` that resumes at the stage
that failed, priced by `projectRemaining` (what is already `done` costs nothing,
and a clip already downloaded is not bought twice) and redeemed with the same
one-shot confirmation token a fresh generation needs. The machine still never
decides to spend again; the operator can, having been shown the number.

Two things make that safe rather than a retry loop with extra steps. Only the
failed stage is rewound — `creditsConsumed` stays on every step, so failing
repeatedly cannot walk past a ceiling. And a task the API itself reported
`failed` is dropped from `inFlight` while one we merely *timed out on* is kept:
the first is a corpse and re-polling it would make the retry unable to move, the
second may still be running and billing, so re-polling it is free where
re-submitting would not be.

**Persist before submit.** The job record is written to disk *before* the
request goes out, never after, so a process that dies mid-call still knows a
task may exist. On boot every non-terminal job resumes polling.

**Download in the same handler as the success.** Model URLs expire in about five
minutes; a URL is never returned to the browser, and never stored as the
artifact. The artifact is the file on disk.

**rig-check is free, so it is never skipped.** `riggable: false` blocks the job
before the rig call, which is not free.

### The shared skeleton

One canonical rig, one retarget of the clip library onto it, and every later
humanoid reuses both. A unit after the first is generated, rigged, and then
*verified* against the canonical bone contract; its own clips are discarded.
`nextStage` is what encodes this: it returns `retarget` only for a job that is
establishing a rig family, and the unitdef's `provenance.tripoTaskIds.retarget`
is empty for every other unit — so a pipeline that started retargeting per unit
shows up as a populated array in a committed file, not as a surprise on a bill.

### Modules

Pure, clock-injected, and lint-guarded as part of the deterministic core — these
are the money decisions and they are all testable in Node with no network:

```ts
jobs.ts        createJob / beginStep / completeStep / failJob / blockJob
               / cancelJob / nextStage / isTerminal        (pure transitions)
ledger.ts      LedgerEntry, runTotal, dayTotal, dayKeyOf, checkCeilings
pricing.ts     projectCost(plan) -> { steps: [...], totalCredits }
cache.ts       cacheKey(referenceImageSha256, params) -> string
pacing.ts      Pacer: earliestNextMs(lastAtMs), keeping outbound under 1/sec
confirm.ts     issue / redeem / expire one-shot confirmation tokens
```

Impure, Node-only, and thin on top of them:

```ts
tripo.ts       THE ONLY FILE THAT KNOWS TRIPO'S PATHS AND FIELD NAMES.
               Takes a fetch-like function, so tests drive a fake.
store.ts       jobs.json (atomic temp-write + rename), ledger.jsonl (append-only)
artifacts.ts   download-on-success to .studio/assets/<jobId>/
pipeline.ts    drives a job through the stages; resumes on boot
routes.ts      /api/studio/*, behind the existing HMAC admin verifier
http.ts        a small router, replacing index.ts's single if/else
```

### Why jobs.json and not sqlite

Job volume is tens, not millions. The repo has zero native dependencies and no
database precedent; `node:sqlite` on Node 22 is still experimental. A JSON file
written atomically is greppable and diffable at three in the morning when a paid
job has gone wrong, which is the only time anybody will read it. The credit
ledger is a separate append-only `.jsonl` for the same reason a ledger is always
append-only: one that gets rewritten is one that can lose an entry.

### Routes

```
POST /api/studio/estimate      price a generation, issue a confirmation token
POST /api/studio/jobs          create + submit, redeeming a token
GET  /api/studio/jobs          the queue
GET  /api/studio/jobs/:id      one job, with per-step status
POST /api/studio/jobs/:id/cancel
GET  /api/studio/credits       running total, per-day total, ceilings, headroom
POST /api/studio/webhook       optional completion callback; polling is default
```

## Invariants tested

Money:
- Submitting without a confirmation token is refused, and nothing is sent.
- A token redeems exactly once; the second attempt is refused.
- An expired token is refused.
- A projection over the per-run ceiling blocks before any request is sent.
- A projection that fits alone but pushes the day over the per-day ceiling
  blocks before any request is sent.
- The day total counts entries by UTC day and ignores other days.
- A failed step never schedules another attempt: no timer, no loop, and a
  restart's resume sweep leaves it alone.
- A retry resumes at the failed stage and re-buys nothing that is already
  `done` — a failed retarget does not pay for the mesh or the rig again.
- A retry is quoted at the remaining cost, not the job's, and clips already on
  disk are not in the quote.
- A task the API called failed is dropped from `inFlight`; a task we timed out
  on is kept, so a retry re-polls it rather than paying for another.
- `retry` refuses anything that is not `failed`, and `resume` refuses anything
  that is not `blocked`.
- An identical request after a success is a cache hit: no request is sent and
  the existing artifacts come back.
- A cache key changes when any parameter that changes the output changes, and
  does not change when an unrelated field does.

Sequence:
- `nextStage` walks imageToModel -> rigCheck -> rig -> retarget -> download.
- rig-check is always visited, and `riggable: false` blocks before `rig`.
- A job reusing an established rig family never reaches `retarget`.
- A terminal job has no next stage, and stepping one is refused.

Durability:
- The job is persisted before the submit call, proven by a fake client that
  asserts the record exists at the moment it is called.
- A store written and reloaded round-trips every job field.
- Non-terminal jobs resume on boot; terminal ones do not.
- An interrupted write leaves the previous file intact (atomic rename).

Transport:
- Every outbound request carries the key; no response body, log line or error
  message ever contains it.
- The pacer never lets two requests inside one second, across all jobs.
- A success downloads immediately, and the stored artifact is a path, never a
  URL.

## Out of scope

- The Studio tab. This spec is the server; nothing renders yet.
- Reading a `.glb`. Bone-contract verification against the canonical skeleton
  needs a parsed model and lands with the bake step; what this spec records is
  the provenance that check will be run against.
- Real calls to Tripo. This environment's egress policy blocks the API host, so
  every test drives a fake client. The wire shapes live in one file precisely so
  that the first real call corrects one file and nothing else.
- Writing the unitdef. Export is the Studio tab's, and it goes through the
  spec 107 validator like everything else.
