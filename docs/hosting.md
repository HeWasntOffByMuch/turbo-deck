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
constant 1.4% and 129 MB.

Two ceilings follow, and they are not the same number. The tick loop, the
socket reads and the broadcast all run on **one thread**, so the sim gets one
core however many the box has: at 0.8% each, a core saturates somewhere around
**100-120 players**, and a second vCPU buys headroom for the OS and Caddy
rather than more players. Traffic runs out much later — 15 KB/s each is ~39 GB
per player-month, so a 20 TB allowance covers roughly 500 continuously
connected players. **CPU is the capacity ceiling; bandwidth is the cost
ceiling**, and which one you notice depends on whether you are counting players
or reading an invoice.

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
| OVH VPS-1, Warsaw (4 vCPU, 8 GB, unmetered) | 44.53 zł inc. VAT | included | **~€10.5** |
| Hetzner CX23 (2 vCPU, 4 GB, 20 TB traffic) | €5.49 | included | **~€6** |
| Fly.io shared-cpu-1x 512 MB, `waw` | ~$3 | ~$16 at $0.02/GB | ~$19 |
| DigitalOcean basic droplet (1 vCPU, 1 GB) | $6 | included in 1 TB | ~$6 |
| AWS Lightsail 1 GB | $5 | included in 2 TB | ~$5 |
| AWS EC2 t4g.small + egress | ~$12 | ~$70 at $0.09/GB | ~$82 |

Prices as of August 2026, and **re-check them before ordering**: Hetzner raised
cloud prices twice this year, ~30-50% on 1 April and another 30-38% on the CX
and CAX lines on 15 June (the CPX and CCX lines roughly doubled to tripled in
the same round). Third-party comparison sites are full of both pre-increase
numbers and post-increase ones with no dates on them.

Fly's convenience is real — it owns TLS, restarts and OS patching, and it has a
Warsaw region. It is also priced per GB, and this game's whole job is sending
GBs of deltas.

## What this actually runs on

**OVHcloud VPS-1, Warsaw, Ubuntu Server 24.04 LTS.** Chosen and ordered; the
runbook below is written against it.

| | |
|---|---|
| vCPU | 4, x86-64 (**the architecture the deploy builds for**) |
| RAM | 8 GB |
| Disk | 75 GB NVMe |
| Traffic | unlimited, capped at 400 Mbit/s |
| Price | 44.53 zł/month inc. VAT, ~€10.5 |
| Location | Warsaw — the only option here that is in the same country as the players |

Three properties earned it over the cheaper boxes below. **Unlimited traffic**
retires the resource that made the host choice interesting at all — 400 Mbit/s
is ~3,300 players' worth of deltas at 120 kbit/s each, thirty times what one
core can simulate. **Warsaw** turns the ~25ms to German datacentres into ~5ms;
not decisive on its own, per the latency note below, but free here. And
**anti-DDoS is standard**, which is the one risk self-hosting could not
mitigate at any price.

Against the measured numbers it is roughly 4x the RAM and 4x the cores this
server can use, which is fine: nothing cheaper is meaningfully cheaper once
the alternatives are priced honestly, and headroom on the box that hosts a live
playtest is not the place to economise.

### The cheaper alternative, if that price stops being worth it

**Hetzner Cloud CX23** — 2 shared Intel vCPU, 4 GB, 40 GB NVMe, 20 TB traffic,
€5.49/month plus €0.50 for the primary IPv4, in Falkenstein (`fsn1`), Nuremberg
(`nbg1`) or Helsinki (`hel1`). About half the money for a box that still
comfortably clears what one core can simulate. Two near-misses in the same
catalogue, so they are ruled out rather than reconsidered later:

- **CAX11** (€5.99, 2 vCPU, 4 GB, 20 TB) is the Arm64/Ampere equivalent — fifty
  cents more, and the deploy workflow builds an **amd64** image. Going Arm means
  adding `platforms: linux/arm64` to the build step; without that the container
  dies with `exec format error`, which reads like a broken image rather than a
  wrong architecture. Choose x86 unless something else forces the issue.
- **CPX11** (€5.99, 2 vCPU AMD, 2 GB) includes **1 TB** of traffic, not 20. It
  is more money for less RAM and 5% of the allowance, which twenty players would
  exhaust in a fortnight.

CX and CAX are EU-only (Germany and Finland), and Hetzner runs its cloud close
enough to capacity that stock is a real consideration — see below.

### If Hetzner has nothing in stock

This happens regularly and is not an account problem: Hetzner runs its cloud
close to capacity, individual types go out of stock per location, and they
usually return within hours. The Arm line in particular is out everywhere often
enough that it cannot be planned around. Before assuming anything is wrong:

- Try the other two locations. Falkenstein is the tightest; Nuremberg and
  Helsinki frequently have what it does not.
- Check a stock tracker (`radar.iodev.org/cloud-status`) rather than clicking
  around the order page, and try again in a few hours.
- If *everything* is greyed out and no location works, it is probably the
  account rather than the stock — a new Hetzner account is limited until
  identity and payment verification complete, which presents as an order page
  where nothing can be created.

### A note on the prices in this document

44.53 zł is what OVH's Polish checkout actually charges, not the ~€6 an earlier
draft of this file took from a comparison site: those quote net, and Polish VAT
is 23%. Assume the same gap applies to every other figure here — they are all
list prices from vendor pages and comparison sites, and none of them is a quote.

Worth confirming at OVH's own checkout: whether that rate is month-to-month or
a 12-month commitment, since the order page shows both. Provisioning also takes
minutes rather than the seconds a Hetzner box takes; that is normal, not a
failed order.

### Which distribution

**Ubuntu Server 24.04 LTS.** Every command in the runbook below is written for
it — `apt`, `ufw`, `docker.io`, `unattended-upgrades` — and Docker's own
packaging targets Ubuntu and Debian first. Free security maintenance runs to
May 2029, and ten years with Ubuntu Pro, which is free for personal use on up
to five machines. Take the LTS, not a 25.x interim release: those are supported
for nine months, which converts a server you wanted to forget about into an
annual reinstall.

The rest of OVH's menu, so the choice is made rather than defaulted into:

- **Debian** — the other right answer, and marginally leaner for a box that
  only runs containers. Same `apt`, same `ufw`, so the runbook survives nearly
  unchanged. Pick it over Ubuntu only if you already prefer it.
- **AlmaLinux / RockyLinux** — solid RHEL rebuilds with ten-year lifecycles,
  and entirely reasonable servers. But they are `dnf`, `firewalld`, SELinux
  enforcing and Podman-by-default, so every command below changes and the
  SELinux labelling on bind mounts becomes something you have to know about.
  Correct in a RHEL-shaped shop; pure friction here.
- **Fedora** — no. A ~13-month support life means reinstalling annually, and it
  is a distribution for tracking what is new, which is the opposite of what a
  game server is for.
- **CloudLinux** — built for shared web hosting, per-tenant resource limits and
  control panels, and licensed commercially. Nothing to do with this.

Also decline any image sold "with cPanel/Plesk". This box runs two containers.

Also worth knowing: **none of this repo is Hetzner-specific.** The image, the
compose file, the Caddy config and the deploy workflow want an Ubuntu box with
Docker and an SSH key. Only this document names a vendor.

### Self-hosting on a machine you already own

Not the path taken — the VPS above is — but kept, because the pipeline supports
it without a single change and the old tower is the obvious staging server.
Everything below applies whenever a box you own is the target.

**Bandwidth is a non-issue.** At 120 kbit/s per player, a hundred players is
~12 Mbit/s upstream. A gigabit line is three orders of magnitude past what this
game can produce, and even a modest upstream would do. Check that the line is
symmetric, and then stop thinking about it.

**Compute is a modest argument, not a big one.** CPU is this server's capacity
ceiling, and a desktop core beats a shared vCPU that is oversubscribed by
design — but by less than it sounds. A 2014-era Haswell i5/i7 turboing to
~3.5-3.9 GHz is roughly on par with an uncontended cloud vCPU and perhaps half
again as fast as a busy one. Call it par to 1.5x, not the two or three times an
older draft of this document claimed. What the old box really has is RAM and
disk nobody is metering.

**"Just power cost" is usually not cheaper.** Polish all-in electricity is
~1.04-1.32 PLN/kWh in 2026 (energy plus distribution, the second being over
half the bill). Continuous draw, at ~1.15 PLN and ~4.25 PLN/EUR:

| Machine | Idle draw | Per month |
|---|---|---|
| Mini-PC, NUC, laptop | ~15 W | ~12 PLN / **€3** |
| Modern-ish small desktop | ~35 W | ~29 PLN / **€7** |
| Typical old desktop | ~60 W | ~50 PLN / **€12** |
| Old desktop with a dedicated GPU | ~120 W | ~99 PLN / **€23** |

The server is close to idle-plus-a-few-watts under real load — 16 players cost
14% of one core — so those idle figures are the figures. A typical tower costs
**more in electricity than the VPS costs in total**, and only a low-power box,
or one already running 24/7 for other reasons, is genuinely cheaper. Measure
yours with a plug meter rather than taking a row from this table.

**Three things to verify before it can work at all:**

- **A public IPv4 that reaches you.** Behind CGNAT, no port forward exists and
  the whole approach is dead without a tunnel. A commercial line usually
  includes a static address; confirm it.
- **Inbound 443 *and* 80.** Caddy proves the domain over ACME on port 80 or
  443. If the ISP blocks 80, switch it to a DNS-01 challenge; if the address is
  dynamic, add a DDNS updater and expect the occasional certificate scramble.
- **Somewhere isolated to put it.** This box accepts connections from the
  internet and sits on your LAN. A separate VLAN or the router's DMZ, plus the
  `ufw` rules in the runbook, is the difference between exposing a game server
  and exposing a network.

**What you are actually buying from a VPS**, given the above, is not compute:

- **Blast radius.** A game server's address is a target, and a line under
  attack is your internet under attack — the office, not just the game. On a
  VPS the worst case is a box you can rebuild.
- **Uptime that is not your problem.** Power cuts, ISP maintenance, a router
  reboot, somebody unplugging it. Fine for a session you are present for; a
  different thing when players expect it to be there.

So: **self-host it now**, point `DEPLOY_HOST` at it, and get the game in front
of people this week. Move it to a rented box at the point where strangers are
connecting or where it needs to be up while you sleep — and note that running
both is normal, since the old machine makes an excellent staging server once
the public one exists.

### If the box is a decade old

Five things, in the order they pay off:

- **Pull the graphics card out.** This server renders nothing — it is Node and
  a socket — and a discrete GPU of that era idles at 10-25 W for no reason at
  all, which is €2-6 a month of nothing. Check the CPU has integrated graphics
  first: most desktop i5/i7 parts do, but an `-E`/X99 or an FX will not POST
  without a card in it.
- **Set the BIOS to power on after AC loss** (`Restore on AC/Power Loss` →
  `Power On`), and disable suspend in the OS. Otherwise the first power cut
  ends with a server that is off until somebody walks over to it, which is the
  single most common way a self-hosted box quietly stops existing.
- **Measure the wall draw** with a plug meter rather than trusting the table
  above. A twelve-year-old PSU is also running at the bad end of its efficiency
  curve at these loads, so the wall figure is worse than the parts suggest.
- **Boot off an SSD if it is still on a spinning disk.** A twelve-year-old HDD
  running continuously is the component most likely to end this. It is worth
  noting what that failure actually costs, though: the world lives in RAM
  (`MemoryDataStore`), so a dead disk costs an OS reinstall and a `compose up`,
  not a world.
- **Dust it and repaste it.** It will be running a tick loop continuously, and
  it is the only thing here with fans.

### If it currently runs Windows

**Wipe it and install Ubuntu Server 24.04.** Not because Linux is nicer, but
because of a date: free Windows 10 support ended on 14 October 2025, the
consumer ESU that bridges the gap runs out on **13 October 2026**, and there is
no consumer option after that — you cannot keep paying. Hardware of this age
also fails Windows 11's requirements, so there is no upgrade path either. An
unpatched Windows with ports forwarded to it from the internet is a bad thing
to own, and that is precisely what this machine would become before the year is
out.

Ubuntu Server 24.04 LTS is security-maintained until May 2029, free, and ten
years with Ubuntu Pro, which is also free for personal use on up to five
machines. It is what every command in the runbook below assumes.

What you give up is the Windows remoting you already have. The replacement is
SSH, and for a box that only ever runs `docker compose` it is the better tool —
no session to keep alive, and it is what the deploy uses anyway. Install with
"Ubuntu Server (minimized)", tick OpenSSH during setup, and paste in a public
key rather than choosing a password.

If the machine has another job and cannot be wiped, in preference order:

- **A Hyper-V VM running Ubuntu Server.** Windows Pro has Hyper-V built in.
  Give the VM an *external* virtual switch so it gets its own address on the
  LAN and the port forward can point straight at it, and set its automatic
  start action to "Always start". Every command below then applies unchanged
  inside the VM, and the game server is isolated from the Windows install
  rather than sharing it. This is the only keep-Windows option that does not
  bend the rest of this document.
- **WSL2 with Docker.** Fine for trying it out tonight, poor as a permanent
  answer: WSL does not start at boot without a scheduled task, port forwarding
  from the Windows host into the WSL network needs its own setup and does not
  survive a reboot cleanly, and Docker Desktop's licence is not free for
  companies past a size threshold.

Either way the Windows-10 clock is still running, so treat these as ways to
schedule the reinstall rather than avoid it.

### The network side, for a box on your own line

- **Forward 80 and 443 to it, and nothing else.** Port 80 is not optional:
  Caddy proves the domain over ACME on it. If the ISP blocks 80, switch Caddy
  to a DNS-01 challenge instead.
- **Do not forward 22.** Set the `DEPLOY_RUNNER` repository variable to a
  self-hosted GitHub Actions runner's label instead, and run that runner on the
  box. It polls GitHub outbound, so the rollout needs no inbound port, no key
  in a secret, and no SSH exposed to the internet at all — the deploy workflow
  takes that path automatically when the variable is set. Keep SSH for
  yourself, on the LAN.
- **Put it somewhere its own.** A separate VLAN, or the router's DMZ. This
  machine accepts connections from strangers; the rest of the network should
  not be reachable from it.
- **Point an A record at your static address** and use that name as
  `SERVER_DOMAIN`, rather than the bare IP — the certificate is issued against
  a name, and a name is also what lets you move the whole thing to a rented box
  later without every player needing a new URL.

**Latency is not what picks the host either.** Falkenstein is ~25ms from Poland
against ~5ms for a Warsaw datacenter, and that 20ms is worth less than it sounds:
deltas go out every 50ms (`BROADCAST_EVERY_N_TICKS` = 3 at 60Hz), and
`MAX_REWIND_TICKS` gives the server 200ms of lag compensation (spec 149). A 20ms
difference is under two ticks and inside a budget the netcode already spends.
Pick the region nearest your players and stop thinking about it; the thing that
would actually hurt is hosting in `us-east` and playing from Europe.

## The runbook

### Once, on the box

Any box from above — rented or your own — on Ubuntu 24.04. Nothing below this
line is vendor-specific.

```sh
# as root
adduser --disabled-password --gecos '' deploy
apt update && apt install -y docker.io docker-compose-v2 unattended-upgrades
systemctl enable --now docker
usermod -aG docker deploy          # after docker exists, or the group does not

ufw default deny incoming && ufw default allow outgoing
ufw allow 80/tcp && ufw allow 443/tcp
# SSH: on a rented box the deploy comes in this way, so allow it from anywhere.
ufw allow 22/tcp
# On your own box, prefer restricting it to the LAN -- the deploy uses a
# self-hosted runner there and needs no inbound SSH at all:
# ufw allow from 192.168.0.0/16 to any port 22 proto tcp
ufw enable
```

`unattended-upgrades` is the whole OS-patching story; it is the one piece of
owning a box that cannot be skipped.

Point an A record at the box — at the rented box's address, or at your static
one with 80 and 443 forwarded — then as `deploy`:

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

Both paths need these:

| Where | Name | Value |
|---|---|---|
| Variable | `DEPLOY_ENABLED` | `true` — until this is set, the deploy job skips |
| Variable | `PLAY_SERVER_URL` | `wss://play.example.com/ws` — what the Pages build bakes in |

**A rented box** (GitHub connects in over SSH) additionally needs:

| Where | Name | Value |
|---|---|---|
| Secret | `DEPLOY_HOST` | the box's address |
| Secret | `DEPLOY_USER` | `deploy` |
| Secret | `DEPLOY_DOMAIN` | `play.example.com` |
| Secret | `DEPLOY_SSH_KEY` | a deploy-only private key, whose public half is in `~deploy/.ssh/authorized_keys` |
| Secret | `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan play.example.com` output, so the deploy does not trust DNS |

**Your own box** (a runner on the machine polls GitHub) needs none of those —
no key, no exposed SSH — just:

| Where | Name | Value |
|---|---|---|
| Variable | `DEPLOY_RUNNER` | the runner's label, e.g. `self-hosted` |
| Variable | `DEPLOY_DIR` | where `compose.yml` lives, if not `~/turbo-deck` |

Install the runner from the repository's *Settings → Actions → Runners*, as the
same user that owns `~/turbo-deck` and is in the `docker` group, and register it
as a service (`./svc.sh install && ./svc.sh start`) so it survives a reboot.

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
