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

## What this runs on

Any always-on x86-64 box with Docker, a current Ubuntu Server LTS, and a name
pointed at it. The runbook is written against that and nothing narrower,
because the specific box has already changed once: OVH's VPS-1 in Warsaw was
the pick until Warsaw stopped being orderable.

The shortlist, cheapest first. All three clear what one core can simulate, so
this is a question about price and geography rather than capability.

| | Specs | Traffic | Price | Where |
|---|---|---|---|---|
| **Hetzner CX23** | 2 vCPU, 4 GB, 40 GB | 20 TB | €5.49 + €0.50 IPv4 | DE, FI |
| **OVH VPS-1** | 4 vCPU, 8 GB, 75 GB | unmetered, 400 Mbit/s | ~44.53 zł inc. VAT | FR, DE, UK, PL |
| **Scaleway PLAY2** | small, sandbox tier | see their page | from ~€0.014/h, ~€10/mo | **Warsaw**, Paris, AMS |

**Hetzner CX23 is the default recommendation** now that Warsaw is not on the
table: half the price of the others, 20 TB is ~500 player-months of deltas, and
its stock rotates within hours rather than being gone for good. Its ~25ms from
Poland is a non-issue for the reasons in the latency note below — it was never
the deciding factor, and Warsaw was a bonus rather than a requirement.

Take **OVH VPS-1 in another region** (Gravelines, Frankfurt, London) if you
would rather stay with OVH; it is the same product, minus the geography.
Take **Scaleway PLAY2** if being physically in Warsaw turns out to matter after
all — but note their PLAY2 line is explicitly a sandbox tier without the
production SLA their PRO2 instances carry.

### Do not buy OVH Public Cloud for this

It is a different product from the VPS, on the same website, and the trap is
easy to walk into when the VPS you wanted is unavailable. Public Cloud is
elastic, API-driven, hourly-billed infrastructure; comparable instances run
**€32-44/month** against the VPS's ~€10.5, and since 1 October 2026 it bills
à la carte — local storage and the public IPv4 became separate line items on
the gen-3 flavours, so the headline figure is not the total.

Nothing about this server is elastic. It is one process holding one world, and
it wants the cheapest always-on box that clears the bar.

### The Hetzner range in detail

**Hetzner Cloud CX23** — 2 shared Intel vCPU, 4 GB, 40 GB NVMe, 20 TB traffic,
€5.49/month plus €0.50 for the primary IPv4, in Falkenstein (`fsn1`), Nuremberg
(`nbg1`) or Helsinki (`hel1`). Two near-misses in the same catalogue, so they
are ruled out rather than reconsidered later:

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

Every figure here is a list price off a vendor page or a comparison site, and
none of them is a quote. Two failures already, both worth generalising from:

- The OVH VPS was written down as ~€6 from a comparison site quoting **net**
  prices; the Polish checkout charges 44.53 zł, VAT included. Assume a ~23% gap
  on anything not explicitly marked "inc. VAT".
- A named plan in a named region is not a thing you can count on existing. The
  CX22 in an earlier draft had been discontinued, and the Warsaw VPS this
  document recommended for several revisions stopped being orderable. Check the
  order page, not this file.

Also worth confirming at any checkout: whether the rate shown is month-to-month
or a 12-month commitment, since both OVH and Scaleway display both. OVH
provisioning takes minutes rather than the seconds a Hetzner box takes; that is
normal, not a failed order.

### Which distribution, and which image

**Ubuntu Server 26.04 LTS**, plain. Falling back to 24.04 LTS if the vendor's
image list has not caught up yet — both run the runbook below unchanged, since
`apt`, `ufw`, `docker.io` and `unattended-upgrades` are the same on either.

26.04 rather than 24.04 for one reason: it is maintained to **April 2031**
against 24.04's May 2029, and this is a box whose entire purpose is to be
forgotten about. It released on 23 April 2026 and its `.1` point release landed
on 6 August, which is the conventional bar for putting a new LTS on a server —
so that objection has expired. Ten years on either with Ubuntu Pro, free for
personal use on up to five machines.

Take an **LTS**, never an interim release. Those get nine months, which turns a
server you wanted to forget about into an annual reinstall.

**Take the plain image**, not a preconfigured one:

- **Never a cPanel or Plesk image.** Those panels bind ports 80 and 443
  themselves, which is a direct collision with Caddy — the symptom is a
  certificate that will not issue, because the ACME challenge never reaches the
  container. This is a concrete conflict, not general hygiene.
- **Skip the "Docker" ready-to-go image too**, mildly. The runbook installs
  Docker from Ubuntu's own repository; a preinstalled one may come from a
  different source at a different version, and then there are two answers to
  "where did docker come from" on a box that should have one.
- A VPS panel will list a bare **"Ubuntu 26.04"** with no Server/Desktop
  choice, and that is correct — cloud images are headless already. That
  distinction only appears when installing from an ISO, which is the
  self-hosting path further down. Pick the highest LTS version number in the
  plain distribution list and ignore the "apps" or "ready-to-go" tab entirely.

Expect the vendor's image to create a non-root `ubuntu` user holding your SSH
key, with root login disabled. So the steps below marked "as root" start with
`sudo -i`.

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

**Wipe it and install Ubuntu Server LTS.** Not because Linux is nicer, but
because of a date: free Windows 10 support ended on 14 October 2025, the
consumer ESU that bridges the gap runs out on **13 October 2026**, and there is
no consumer option after that — you cannot keep paying. Hardware of this age
also fails Windows 11's requirements, so there is no upgrade path either. An
unpatched Windows with ports forwarded to it from the internet is a bad thing
to own, and that is precisely what this machine would become before the year is
out.

Ubuntu Server 26.04 LTS is security-maintained until April 2031, free, and ten
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

### First, two keys — and it has to be two

Generate them before ordering, because the vendor's panel asks for a public key
at install time.

```sh
# Yours. With a passphrase, because you are there to type it.
ssh-keygen -t ed25519 -C 'me@laptop -> turbo-deck' -f ~/.ssh/turbo-deck

# CI's. No passphrase, because a workflow cannot type one.
ssh-keygen -t ed25519 -N '' -C 'github-actions -> turbo-deck' -f ~/.ssh/turbo-deck-ci
```

Ed25519 rather than RSA: shorter, faster, and no key-size decision to get
wrong. **Never** put your own key in `DEPLOY_SSH_KEY`. A CI key has properties
yours must not have — it sits unencrypted in a repository secret, it is used
unattended, and any workflow that can read secrets can use it — so it exists to
be the thing that gets revoked. Two keys means revoking one is a one-line edit
to `authorized_keys` rather than rotating the key you log into everything with.

Paste `~/.ssh/turbo-deck.pub` — the *personal* one — into OVH's panel at
install time. The CI key goes on the box in the next step, restricted.

### Once, on the box

Any box from above — rented or your own — on an Ubuntu Server LTS. Nothing below this
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

Then give `deploy` both public keys, and shut the door behind them:

```sh
# still as root
install -d -m 700 -o deploy -g deploy ~deploy/.ssh
cat > ~deploy/.ssh/authorized_keys <<'EOF'
ssh-ed25519 AAAA...your-personal-key... me@laptop
restrict ssh-ed25519 AAAA...your-ci-key... github-actions
EOF
chown deploy:deploy ~deploy/.ssh/authorized_keys
chmod 600 ~deploy/.ssh/authorized_keys

# Keys only, from here on.
cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
systemctl restart ssh
```

The `restrict` prefix on the CI key is worth the eleven characters: it turns
off port forwarding, agent forwarding, X11 and pty allocation, none of which a
`docker compose pull` needs, all of which are useful to somebody who has the
key and should not have the box. Running a command over SSH still works —
that is the one thing it leaves.

Verify from your laptop *before* closing the browser-based console, since a
mistake in `sshd_config` locks you out of a box you can otherwise only reach
through the vendor's KVM:

```sh
ssh -i ~/.ssh/turbo-deck deploy@play.example.com 'docker ps'
```

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
| Secret | `DEPLOY_SSH_KEY` | the whole of `~/.ssh/turbo-deck-ci` — the CI key, never yours — including both `-----BEGIN/END-----` lines and the trailing newline |
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
