# Hosting the server

Spec 153. What the server needs, what that rules out, what it costs, and the
runbook for the box it actually runs on.

## What this workload is

Measured before anything was chosen, on the shipped `maps/arena.json`, with
`npm run server` on one side and `npm run server:bots -- --count 16` on the
other:

| | idle | 16 players |
|---|---|---|
| CPU, share of one core | 1.4% | 14% |
| RSS | 129 MB | 163 MB |
| Traffic | — | ~15 KB/s per player |

So roughly **0.8% of a core and 2 MB per connected player**, on top of a
constant 1.4% and 129 MB. Fifty players is about half a core. The smallest box
anybody sells is enough compute; what runs out first is bandwidth.

Four properties decide the hosting shape, and none of them is a preference:

- **It never idles.** `TickLoop` advances the world 60 times a second whether or
  not anybody is connected. Nothing that scales to zero can host this — no
  Lambda, no Cloudflare Workers, no Vercel functions. It needs a process that
  stays up.
- **The world is the process.** `MemoryDataStore` is the only `DataStore` that
  ships (spec 056 built the seam; nothing has filled it). There is no database
  to attach, nothing to back up, and a restart is a fresh world.
- **One process is one world.** No sharding, no session affinity, nothing for a
  load balancer to balance. Scaling up means a bigger box, not more boxes.
- **The client is on `https://`.** GitHub Pages serves the game over TLS, so the
  socket must be `wss://` or the browser refuses it as mixed content.

## Why a box rather than a platform

Bandwidth. At 20Hz deltas and ~15 KB/s per player, twenty players around the
clock is **~780 GB/month**. Metered egress is what that costs on each kind of
host:

| | compute | 780 GB egress | total |
|---|---|---|---|
| Hetzner CX22 (2 vCPU, 4 GB, 20 TB traffic) | ~€4.50 | included | **~€4.50** |
| Fly.io shared-cpu-1x 512 MB, `waw` | ~$3 | ~$16 at $0.02/GB | ~$19 |
| DigitalOcean basic droplet (1 vCPU, 1 GB) | $6 | included in 1 TB | ~$6 |
| AWS Lightsail 1 GB | $5 | included in 2 TB | ~$5 |
| AWS EC2 t4g.small + egress | ~$12 | ~$70 at $0.09/GB | ~$82 |

Prices as of August 2026 and worth re-checking — Hetzner raised cloud prices
30-50% on 1 April 2026, so the CX22 is ~€4.50 rather than the €3.29 that older
comparisons quote. Fly's convenience is real (it owns TLS, restarts and OS
patching, and it has a Warsaw region); it is priced per GB, and this game's
whole job is sending GBs of deltas.

**Latency is not what picks the host.** Falkenstein is ~25ms from Poland against
~5ms for a Warsaw datacenter, and that 20ms is worth less here than it sounds:
deltas go out every 50ms (`BROADCAST_EVERY_N_TICKS` = 3 at 60Hz), and
`MAX_REWIND_TICKS` gives the server 200ms of lag compensation (spec 149). A 20ms
difference is under two ticks and inside a budget the netcode already spends.
Pick the region nearest your players and stop thinking about it; the thing that
would actually hurt is hosting in `us-east` and playing from Europe.

## The runbook

### Once, on the box

A CX22 in Falkenstein or Helsinki, Ubuntu 24.04. From a fresh machine:

```sh
# as root
adduser --disabled-password --gecos '' deploy
usermod -aG docker deploy          # after docker is installed, below
apt update && apt install -y docker.io docker-compose-v2 unattended-upgrades
systemctl enable --now docker

ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
```

`unattended-upgrades` is the whole OS-patching story; it is the one piece of
owning a box that cannot be skipped.

Point an A record at the box (`play.example.com`), then as `deploy`:

```sh
mkdir ~/turbo-deck && cd ~/turbo-deck
# compose.yml and deploy/Caddyfile come from this repo; nothing else does.
curl -O https://raw.githubusercontent.com/HeWasntOffByMuch/turbo-deck/main/compose.yml
mkdir -p deploy && curl -o deploy/Caddyfile \
  https://raw.githubusercontent.com/HeWasntOffByMuch/turbo-deck/main/deploy/Caddyfile

cat > .env <<'EOF'
SERVER_DOMAIN=play.example.com
# Leave ADMIN_SECRET unset unless you want the admin console: the server still
# demands a signed token, it just mints a throwaway key per boot so nobody can
# make one. Set it to a long random string to use /admin.
ADMIN_SECRET=
# A game server has no reason to hold the Tripo key. Leave it empty and the
# Studio routes mount and refuse (spec 108).
TRIPO_API_KEY=
EOF
chmod 600 .env

docker compose up -d
curl -s https://play.example.com/healthz     # {"ok":true,"tick":...,"players":0}
```

### Once, in the repository

| Where | Name | Value |
|---|---|---|
| Variable | `DEPLOY_ENABLED` | `true` — until this is set, the deploy job skips |
| Variable | `PLAY_SERVER_URL` | `wss://play.example.com/ws` — what the Pages build bakes in |
| Secret | `DEPLOY_HOST` | the box's address |
| Secret | `DEPLOY_USER` | `deploy` |
| Secret | `DEPLOY_DOMAIN` | `play.example.com` |
| Secret | `DEPLOY_SSH_KEY` | a deploy-only private key, whose public half is in `~deploy/.ssh/authorized_keys` |
| Secret | `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan play.example.com` output, so the deploy does not trust DNS |

### Then

`.github/workflows/deploy-server.yml` builds the image, pushes it to GHCR and
rolls it out on every push to `main` that touches the server, or on manual
dispatch. It typechecks and tests before publishing anything, and after the
rollout it polls `/healthz` twice and requires the **tick to have advanced** —
a process that boots and then freezes still answers a port check, and that is
the failure worth catching.

To roll back, put an older image back by digest or sha:

```sh
cd ~/turbo-deck
SERVER_IMAGE=ghcr.io/hewasntoffbymuch/turbo-deck:<sha> docker compose up -d server
```

### Playing against it

The published page dials `PLAY_SERVER_URL` on its own once that variable is set.
Otherwise, or to reach a different box:

- `https://hewasntoffbymuch.github.io/turbo-deck/?server=wss://play.example.com/ws`
- `?server=local` forces single-player on a build that has a server baked in —
  which is what every `scripts/preview-*.ts` relies on.

## Monitoring

`/healthz` returns `{"ok":true,"tick":N,"players":N}`. Point any uptime monitor
at it. The useful alert is not "did it answer" but **"is `tick` larger than it
was last time"** — the process can be up with a stopped loop, and only the tick
distinguishes the two. The container healthcheck in `compose.yml` is the weaker
check by design; it restarts a process that has stopped answering at all.

## What is deliberately not here

- **A persistent world.** `MemoryDataStore` means a deploy is a wipe. Filling
  spec 056's seam with a real store is the prerequisite for anything else.
- **More than one server.** Two processes are two worlds. Sharding is a design
  problem, not a hosting one.
- **Provisioning as code.** One machine, a runbook. Terraform for a single box
  costs more than it saves.
- **Autoscaling.** There is nothing to scale: the sim's cost is the world, not
  the connections, and it runs at 60Hz with nobody watching.
