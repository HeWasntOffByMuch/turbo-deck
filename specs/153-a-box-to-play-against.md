# 153 — A box to play against

## Problem

`deploy-pages.yml` has published the client on every push to `main` since it was
written, and there has never been anywhere for it to connect. The page loads,
runs the loopback server in the tab, and that is the whole multiplayer story:
`?server=` exists (spec 144) but names a host that only exists on somebody's
laptop.

Nothing in the tree says how the authoritative server is *run* — no image, no
service, no deploy. That gap has a shape worth writing down, because the answer
is constrained rather than a matter of taste:

- The tick loop is a `setInterval` polling twice per 16.7ms tick, advancing a
  world whether or not anybody is connected, so **nothing that scales to zero
  can host this.** Lambda,
  Workers, Vercel functions and every "serverless" tier are out by construction,
  not by preference.
- `MemoryDataStore` is the only `DataStore` that ships, so the world *is* the
  process. There is no database to attach and nothing to back up; a restart is a
  fresh world, which is a decision spec 056 already made.
- One process is one world. There is no sharding and no session affinity to
  arrange, so a load balancer would have nothing to balance.
- The client is served from `https://` on Pages, so the socket must be `wss://`
  and something has to terminate TLS.

Measured on the shipped map before choosing any of this, so the sizing is a
number rather than a guess (`npm run server` plus `npm run server:bots`):

| | idle | 16 bots |
|---|---|---|
| CPU (one core) | 1.4% | 14% |
| RSS | 129 MB | 163 MB |
| Traffic | — | ~15 KB/s per player |

So ~0.8% of a core and ~2 MB per connected player. The smallest shared-vCPU box
anybody sells covers dozens of players; **bandwidth is the resource that binds
first**, since 20Hz deltas to twenty players around the clock is ~780 GB/month.
That is what picks a host with traffic included over a host that meters egress,
and it is why this spec buys a box rather than a platform.

## Shape

Hosting, as four committed files and no runtime code:

- `Dockerfile` — `node:22-slim`, `npm ci`, run `src/server/index.ts` through
  `tsx`. No compile step: the server half of the tree is typechecked in CI and
  `tsc` here would have to emit the renderer's half too.
- `compose.yml` — the server plus Caddy, which terminates TLS and proxies both
  the socket and the admin/studio HTTP onto it. `restart: unless-stopped` and a
  healthcheck are the whole uptime story.
- `deploy/Caddyfile` — one site block; the certificate is ACME and never touches
  the repository.
- `.github/workflows/deploy-server.yml` — build the image, push it to GHCR, then
  `docker compose pull && up -d` over SSH. Manual dispatch plus pushes to `main`
  that touch the server.

One runtime addition, in the Node CLI half only:

```ts
// src/server/index.ts, before the studio router sees the request
GET /healthz  ->  200 {"ok":true,"tick":<number>,"players":<number>}
```

`index.ts` is the file that already owns everything non-portable (the `ws`
transport, `node:crypto`, the HTTP server), so a health route costs the portable
half nothing.

And the client learns a default server, so a published page dials something:

```ts
planConnection(
  search: string,
  origin: OriginLike,
  storage: StorageLike,
  newId: () => string,
  defaultServer = '',   // new: a URL baked in at build time, or empty
): ConnectionPlan
```

The rule, in order: an explicit `?server=` wins; `?server=local` (or `off`)
forces the loopback even when a default exists; no `server` param at all takes
`defaultServer` if it is non-empty, and is single-player when it is not. The
value reaches the call site as `import.meta.env.VITE_SERVER_URL`, read in
`view.ts` — `connection.ts` stays pure and takes it as an argument, like
everything else it is handed.

`?server=local` is the half that has to exist rather than the half that is
convenient: every preview script drives the built or served page with no query
string, and a default that could not be turned off would point all of them at a
production server the moment one was configured.

## Invariants tested

- No `server` param and an empty default is `{ mode: 'loopback' }` — today's
  behaviour, unchanged, so single-player still needs nothing.
- No `server` param and a non-empty default is `remote` at exactly that URL.
- An explicit `?server=wss://host` beats the default.
- `?server=local` and `?server=off` are loopback *even with a default set*, and
  are not treated as hostnames.
- A default is normalised the same way an explicit value is: `https://host`
  becomes `wss://host`, and a value that is not a URL falls back to the same
  origin rather than being dialled literally.
- Identity is unchanged on the defaulted path: the id and name still come from
  storage, and a resume token still travels.

## Out of scope

- A persistent `DataStore`. The world is still the process; spec 056's seam is
  where that lands when it lands.
- More than one server process, sharding, or anything that needs affinity.
- Provisioning the box. The runbook is prose in `docs/hosting.md`; there is no
  Terraform here for one machine.
- Secrets. `ADMIN_SECRET` and `TRIPO_API_KEY` are deploy-time environment, and
  the workflow reads them from repository secrets.
- Choosing the region in code. Latency is geography, and the numbers that make
  it a non-decision for this game (50ms between deltas, 200ms of rewind) are in
  `docs/hosting.md` rather than in a constant.
