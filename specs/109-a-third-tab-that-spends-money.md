# 109 — A third tab that spends money

## Problem

The service from spec 108 has no face. Everything it protects — the projection
before the confirmation, the rig-check that stops before a paid call, the
per-day ceiling — is invisible from a browser, and the whole point of those
interlocks is that a person sees them and decides.

There is also a structural first: **the browser has never spoken HTTP to the
game server.** The Play tab runs a server *in the tab* over a loopback
transport, and `npm run dev` (Vite, :5173) and `npm run server` (:8787) are
separate processes that have never met. Studio is the first thing that needs
both alive at once, and it has to say so clearly when only one is.

## Shape

One entry in `main.ts`'s tab array and one `mountStudio`, mirroring the four
tabs already there. `fullscreen: true`, like Play and Map editor. Nothing about
the shell changes, so the other tabs cannot be disturbed by construction.

### Sections

1. **Ingest** — drag-drop reference images. Hash, dimensions, and the warnings
   below. Per-image form: unit id, rig family, face limit, clip intents.
2. **Generate** — the four steps with live status, the projection before and
   the actual after, cancel, and the queue. The rig-check verdict is given its
   own line, because `riggable: false` is the difference between stopping now
   and paying for a rig that cannot work.
3. **Library** — every generated unit with its provenance, clip list, file
   sizes and total credits.
4. **Preview** — spec 110's, and a placeholder until then.
5. **Export** — stages the `.glb` set into `assets/units/<unitId>/` and writes
   the JSON, then runs the spec 107 validator over the result and shows it.

### What the image checker can and cannot know

The brief asks for a warning on "complex poses, heavy occlusion, low contrast
against background". Two of those three are not measurable from pixels without
a model, and a checker that claimed to detect them would be worse than one that
did not: a green tick that means nothing is how a bad reference image gets
generated twice.

So `image-check.ts` measures what pixels can actually answer —

- too small for the face limit asked of it, or an extreme aspect ratio
- **low contrast between the subject and its background**, as the difference
  between the border's mean colour and the interior's
- a **busy background**, as colour variance around the border, which is the
  honest proxy for the occlusion risk the brief is after
- the subject **touching the frame edge**, which is a cropped limb
- fully opaque where transparency would have helped

— and everything else is a short checklist the panel shows, worded as "check
these yourself" rather than as a result. Pure, and tested against synthetic
images built in the test.

### `establishesRigFamily` is computed, never typed

The shared-skeleton rule is money: the clip library is retargeted onto the
canonical rig **once**. A checkbox the user could tick would make that a matter
of remembering. Instead it is a pure function of the library — the first unit
of a family establishes it, every later one reuses it — so the second unit of a
family cannot be told to retarget even by someone trying.

### Talking to the server

`api.ts` wraps `/api/studio/*`. The admin JWT is pasted in and kept in
`localStorage`, matching how the admin console already works; the server prints
one at boot. A missing or rejected token, and a server that is not running at
all, are three distinct messages, because "start `npm run server`" and "paste a
token" are different actions and a single "failed to fetch" tells you neither.

Vite gets a dev proxy for `/api/studio` so the two ports look like one origin.

### Two server routes this needs

```
GET  /api/studio/jobs/:id/artifacts/:name   the downloaded .glb, for Preview
POST /api/studio/export                     stage into assets/units/, validate
```

Export writes the `cliplib.json` and `unitdef.json` only when it is given clip
durations and a state machine. It will not invent a duration: a clip length is
read off the `.glb`, which is spec 110's job, and a committed document carrying
a made-up number is worse than an absent document. Until then Export stages the
`.glb` files and reports precisely what is still missing.

## Invariants tested

Pure, headless:
- The image checker flags a small image, an extreme aspect, a low-contrast
  subject, a busy background and an edge-touching subject; and says nothing
  about a clean one.
- Its severities are ordered: a blocker outranks a warning outranks a note.
- `establishesRigFamily` is true for the first unit of a family and false once
  one has succeeded; a failed or cancelled job does not establish a family.
- Credit, byte and duration formatting round-trips the values a panel shows,
  including the "lower bound" marker when a call went unpriced.
- Stage labels cover every `Stage` and every `JobStatus`, so a new one cannot
  render as `undefined`.

Against the server:
- Export refuses a job that has not succeeded.
- Export stages every artifact and reports what it wrote.
- Export with no clips writes no cliplib, and says so rather than inventing one.
- The artifact route serves a job's file and refuses a path outside its
  directory.

Untouched:
- Play and Map editor still mount, start and stop; the tab array gains one entry
  and nothing else changes.

## Out of scope

- Everything in spec 110: the turntable, the clip player, the state machine
  graph, the timing bars. Section 4 is a placeholder here.
- Reading a `.glb` at all — tri counts, bone counts and clip durations all come
  from a parsed model, which arrives with the preview and the bake.
- The manifest. Export stages into the repo; regenerating the content-hash
  manifest is spec 112's.
