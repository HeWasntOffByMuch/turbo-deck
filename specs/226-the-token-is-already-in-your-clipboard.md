# 226 — The token is already in your clipboard

## Problem

The admin console is gated on a JWT, and the server signs a throwaway one
**per boot** unless `ADMIN_SECRET` is set — so pasting a token is not a
first-run chore, it is the first thing an operator does every single time they
restart the server. Spec 154 made the page remember the last one in
`localStorage` and reconnect with it on load, which helps exactly until the
next boot, at which point the remembered token is the one thing on the page
guaranteed to be wrong.

What that costs, per boot:

- **The field is full of the stale token.** It is ~200 characters of base64 in
  a one-line box, so clicking it puts a caret somewhere in the middle of it.
  Replacing it means selecting all of it first, and a click-drag that stops
  short leaves the new token spliced into the middle of the old one. The server
  answers `bad signature`, which is true and describes none of that.
- **The operator has already copied it.** The flow is: read the token off the
  server's boot output, copy it, alt-tab to the browser. At the moment the tab
  regains focus the browser is holding the exact string the page needs, and
  nothing looks at it.
- **The connect bar is in the way for the rest of the session.** A full-width
  row holding a URL and a 200-character secret is useful for about four seconds
  and then sits above the player table for an hour, while the two things an
  operator watches — the status and the live count — are pills that scroll away
  with everything else.

## Shape

### The token is parsed on the page

The console already speaks the wire by hand; it now reads the token by hand
too, in the `token()` helper beside `W`/`Rd`:

```js
// null unless this is a token this page could actually use.
function readToken(text) -> { sub, role, iat, exp, raw } | null
```

Three base64url segments, a header whose `typ` is `JWT`, and a payload with a
string `sub`, a string `role` equal to `admin`, and numeric `iat`/`exp` — the
same fields `verifyToken` reads in `admin/auth.ts`, minus the signature, which
the page has no secret to check and no business judging.

That parse is what makes every rule below expressible, and one of them is a
safety rule rather than a convenience: **the clipboard is offered, never
trusted.** A clipboard holding a password, an ssh key, a URL or the last line
of a chat is not an admin token, so it is never put in the field and never sent
to the server.

### Three ways a token arrives, one rule for what happens next

```js
offerToken(text, source) -> 'adopted' | 'same' | 'expired' | 'invalid'
```

- **`same` — the field already holds it.** Nothing happens. This is the whole
  of "paste it if the page hasn't got it", and it is also what stops a
  paste-and-connect loop by construction: adopting *fills the field*, so the
  next read of the same clipboard compares equal and does nothing.
- **`expired`** — refused here rather than at the server, naming how long ago
  it lapsed. "bad token" from the server and "you copied yesterday's token" are
  one message and two different fixes. Refused rather than pasted, because
  writing a dead token over a possibly-live one is destructive.
- **`invalid`** — not a token; the field is untouched.
- **`adopted`** — the field is filled and the page connects.

The three sources are the automatic clipboard read, the **paste token** button,
and an ordinary <kbd>Ctrl</kbd>+<kbd>V</kbd> into the field. A native paste
needs no permission from anybody, so it is the path that always works, and it
connects on its own for the same reason the other two do: a whole valid admin
token arriving in that box is not ambiguous about what the operator wants next.

### What automatic may not do

- **It never disturbs a live session.** An automatic read acts only while the
  page is not authenticated. A token copied while connected is the operator's
  to apply, through the button.
- **It never overwrites a field somebody is typing in.** If `#token` has focus,
  the automatic path stands down. The button does not, because pressing it is
  the ask.
- **It is an opportunity, not a requirement.** Reads are attempted on load and
  on window focus — the moment the operator alt-tabs back from the terminal —
  guarded on `document.hasFocus()`, since a read for an unfocused document
  rejects and would spend the attempt. Any rejection **disarms the automatic
  path for the session** and leaves the button: Chromium wants a permission,
  Firefox and Safari want a gesture, and a page that re-asks on every alt-tab
  is worse than one that asks once and then offers a button.
- **It is silent when it finds nothing.** A clipboard usually holds something
  that is not a token, and a line about it per alt-tab is noise. An *asked-for*
  read says why it refused; an automatic one says nothing unless it acted.

### A click that enters the field selects all of it

For `#url` and `#token` — the two fields whose value is replaced wholesale
rather than edited. A click *inside* an already-focused field still places a
caret, so a deliberate drag-select or a correction to one character works as it
always did.

Selecting on `focus` alone does not survive: the `mouseup` that ends the click
collapses the selection to a caret. So the mouseup that **entered** the field
is the one that is defaulted-out, and only that one.

### The connect bar is only there while it is needed

The page gets two connection states rather than one row that is always open:

- **not authenticated** — the URL, the token, `paste token`, `connect`, and one
  dim line saying the server prints a fresh token on every boot and that one on
  the clipboard will be picked up on its own.
- **authenticated** — the row collapses to a strip naming the token's subject
  and what is left of its life (`dev · 11h left`), with `change` to reopen it
  and `disconnect` beside it. Both facts come from the token the page is already
  holding; nothing new crosses the wire.

The rest of the layout pass is ordinary housekeeping and changes no behaviour:
the header is sticky and carries the status and the live count, so the two
things an operator watches stay on screen while a long roster scrolls; the
player table's head is sticky within a bounded scroll region, so the actions
beside it cannot be pushed off the bottom by a busy server; and the log becomes
a titled, resizable panel with a `clear`.

## Invariants tested

Everything here is presentation in a static file with a hand-written codec, so
the checks are in `scripts/probe-admin-console.ts`, which already stands up a
real server and drives the real page. Added to it, ahead of the existing
sections because they are the connect flow:

- **Clicking the token field selects the whole value**, and a second click
  inside it does not.
- **A clipboard holding junk is not pasted and opens no socket** — the field is
  untouched and the status stays `disconnected`.
- **A clipboard holding an expired admin token is refused with a reason**, and
  leaves the field alone.
- **A clipboard holding a live admin token is pasted and connects**, with
  nothing typed and nothing clicked.
- **Adoption is idempotent**: a second read of the same clipboard neither
  reconnects nor logs a second paste.
- **The connect bar collapses once authenticated** and the strip names the
  token's subject.

The existing checks stay as they are, and the screenshot is still taken from
the page an operator actually works in.

## Out of scope

- **Writing to the clipboard**, and any handling of the token beyond the field
  it is typed into. The page reads; it does not offer to copy anything back.
- **Reconnecting on a dropped socket.** The console still disconnects when the
  server goes away and waits to be told to try again; that is a different
  feature with its own failure modes.
- **Any change to the wire, the token format, or `admin/auth.ts`.** The page
  learns to read a token it is already being handed; the server is untouched,
  and the signature is still the only thing that grants anything.
- **A login page, or a token that is not pasted.** Spec 154 said the token
  stays a pasted JWT over the same socket, and it still is — this spec is about
  the pasting.
- **Replacing the world tools, the config panel or the audit table.** They keep
  their behaviour; the layout pass reaches their spacing and nothing else.
