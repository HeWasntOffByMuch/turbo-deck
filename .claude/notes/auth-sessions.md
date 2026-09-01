# Auth sessions & guest accounts (spec 226) — traced 2026-09-01

Source of truth for a fuller account: see the full assistant report in this
session. Key file:line anchors, kept short for future lookups.

## Schema (`src/server/persistence/migrations.ts`, migration v1)
- `accounts` — `migrations.ts:66-81`. No expiry.
- `players` — `migrations.ts:86-114`. `account_id UNIQUE`, NULL = guest.
- `sessions` — `migrations.ts:119-134`. `token_hash` (sha256, unique), `expires_at`
  (fixed at insert, never slides), `revoked_at` (nullable, set not deleted).
  Partial index `sessions_expiry_idx ... WHERE revoked_at IS NULL` (`:143`).

## Guest creation
- `POST /api/auth/guest` → `http.ts:180-186` → `AuthService.createGuest`
  (`auth-service.ts:186-193`) → creates a `players` row (`account_id NULL`) +
  a `sessions` row via `issue()` (`auth-service.ts:419-446`). No `accounts` row.
- TTL: `DEFAULT_SESSION_TTL_MS = 30 days` (`auth-service.ts:41`).
- Response: `{ session: IssuedSession }` (`http.ts:184`), `IssuedSession` shape
  at `auth-service.ts:74-83`.

## Client-side token storage
- Owner: `src/render/iso3d/world/connection.ts`. `AUTH_TOKEN_KEY =
  'turbo-deck.net.auth'` (`connection.ts:32`), backed by **localStorage**
  (deliberately not sessionStorage — an account is a person, not a tab).
  Writer `rememberAuthToken` (`:286-288`), reader used in `planConnection`
  (`:248`), eraser `forgetAuthToken` (`:291-297`).
- `src/ui/screens/account.ts` touches NO storage — pure screen, credential
  flows live entirely in `connection.ts` + `auth-client.ts`, driven from
  `view.ts` (call sites at `view.ts:410-419, 454, 534, 2264`).
- `StorageLike` interface: `src/ui/core/layout-store.ts:47-51`.

## Expiry / cleanup — sessions are NOT permanent
- `expires_at` fixed at issue (30d), never extended by `touch()`
  (`session-repository.ts:92-94` only bumps `last_seen_at`, every 60s of
  staleness, `TOUCH_INTERVAL_MS` `auth-service.ts:51`).
- Logout = `revoke()`, sets `revoked_at`, row NOT deleted
  (`session-repository.ts:97-104`).
- Hourly sweep deletes rows 7 days past expiry (37d after issue):
  `AuthService.sweepExpiredSessions` (`auth-service.ts:376-385`) →
  `deleteExpiredBefore` (`session-repository.ts:127-129`), scheduled at
  `index.ts:316-320`, `SESSION_SWEEP_MS = 1h` (`config.ts:585`).
- No "prune"/"cleanup" terminology used for sessions anywhere in
  `src/server/auth|persistence` — the codebase's word is "sweep".
- Client fallback on a dead token: forgets it and mints a brand-new guest
  (new `players` row, new id) — see `auth-client.ts:112-118` comment and
  `:126-161`. Old player row is orphaned, unreachable via any stored
  credential.

## `/api/auth/session` and `/api/auth/logout`
- `session`: `http.ts:216-226` → `AuthService.resolve` (`:339-361`), 401
  `{error:'not signed in'}` or 200 `{identity}`. Sole client caller:
  `ensureAuthToken` at `auth-client.ts:127`.
- `logout`: `http.ts:211-215` → `AuthService.logout` (`:364-369`) → revokes by
  token hash, returns bool, row stays. Client `signOutOfAccount`
  (`auth-client.ts:286-297`) ignores the HTTP result and unconditionally
  calls `forgetAuthToken` either way (even on network failure).

## Boot-time reclaim path
1. `planConnection` (`connection.ts:220-259`), called `view.ts:410-419`:
   reads `localStorage[AUTH_TOKEN_KEY]` → `plan.authToken`.
2. `ensureAuthToken` (`view.ts:454`, `auth-client.ts:120-167`): checks stored
   token via `/api/auth/session`; on 401 forgets it and mints a fresh guest
   via `/api/auth/guest`, storing the new token.
3. `authToken` threaded into `new GameClient(...)` (`view.ts:662-687`) →
   `Hello.authToken` (`game-client.ts:1026`, wire field `messages.ts:96`).
4. Server: `GameServer.hello()` (`server.ts:1113-1193`). If `authGate !==
   null` (always true for `npm run server`: `index.ts:267`,
   `persistence/index.ts:79` sets `authGate: auth` = same instance as
   `persistence.auth`), `authGate.resolve(authToken)` OVERRIDES the
   client-sent `playerId` (`server.ts:1189-1190`) — this is the actual
   reclaim mechanism. Null token → connection refused (`:1177-1187`).
   Loopback single-player server never gets an `authGate` (`view.ts:607`),
   so there the client's own `playerId` (sessionStorage) is used as-is.

## Changed by spec 264 (session lifecycle)

- `sessions.touch(id, at, expiresAt)` now slides `expires_at` forward
  (`MAX(expires_at, ?)`, so it only ever grows). The 30d TTL measures
  **absence**, not age -- `auth-service.ts:resolve` passes `at + this.ttl`.
- `ensureAuthToken` (`auth-client.ts`) forgets the stored token on **401 only**.
  Any other non-404 failure (500/502/503/429) returns `{ok:false}` and keeps
  the credential, so a server hiccup no longer mints a replacement guest and
  orphans the old `players` row.
- `Connection.lastInputTick` / `lastInputFacing` (`server.ts`) are stamped by
  `noteActivity`, which refuses `Ping`, `RequestChunk` and a zero-vector
  `Input`. `lastSeenTick` still counts pongs; these deliberately do not.
- `sweepConnections` drops a connection idle for `AFK_TIMEOUT_TICKS` (18_000 =
  5 min) that is not `StatusId.InCombat`, via `drop(connection, 'idle')`.
  `GameServerOptions.afkTimeoutTicks` defaults on; the single-player tab
  (`view.ts`) passes 0, because only the remote path is wrapped in a
  `ReconnectingChannel`.
- `disconnect`'s resume grace is now bought by `InCombat` rather than by the
  manner of leaving. `Goodbye` no longer claims `intentional`; only `drop`
  (kick/ban/flood/idle) does.
