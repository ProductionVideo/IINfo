# Engineering Decision Log

Short record of architectural choices — especially dependencies, frame/time
representation, cross-window communication, sync strategy, persistence, and
FFmpeg/mpv filter use. Newest first.

---

## A/B Visual Compare (v0.5.0)

### Paused frame-grab + canvas, not live video compositing

IINA plugins can't composite video. Two viable routes: (a) `screenshot` A and B
and composite the stills, or (b) load B as an `--external-file` into one window
and blend live with mpv `lavfi-complex`. Chose **(a)**: it's frame-exact,
fully controllable, carries no risk to mpv's playback, keeps the two-window A/B
model, and matches IINfo's contract that "frame accuracy lives in the stopped
state". Live blending stays a possible later "advanced" mode.

### Rendered as an overlay on window A

IINA's `overlay` is an HTML web view *on top of a player window* — so the
composite shows full-size where your eyes already are. Only **A's** `main.js`
touches `overlay`; `global.js` designates A and orchestrates. `overlay.loadFile`
clears listeners exactly like `standaloneWindow`, so `wireOverlay()` +
`OV_PINS[]` re-registers after every load (same GC-pin discipline).

### Frames move through the shared `@tmp` dir, not messages

A and B's `main.js` are the same plugin → same `@tmp/`. Each grabber writes
`@tmp/iinfo-vc-{A,B}.png`; A reads **both** directly (no image bytes shuttled
between windows). A then base64s them (JavaScriptCore has no `btoa` → inline
encoder) into data URIs for `overlay.postMessage`. `screenshot-to-file` returns
before the file is flushed, hence a 180 ms grabber delay + A-side read retry.

Grabs are debounced (~320 ms) and fire on `vcompare` toggle, every ganged
step/seek/pause, and a manual refresh. Enabling Visual Compare force-links
transport. A dropped/collapsed pair, a swap, or a file change tears it down.

### Difference needs matching raster size

`ui/vcfit.js` `diffAllowed()` — a per-pixel diff of two differently-sized
frames is a diff of a resample, so Difference is disabled (with a notice) when
A and B natural sizes differ; flicker/wipe/onion scale B into A's box.

### Message size

A 4K PNG frame base64 ≈ 4–11 MB per `overlay.postMessage`. Acceptable for a
deliberate paused op; if it's slow live, fall back to `screenshot-format`
webp/jpg q≈95 (flicker/wipe/onion unaffected; add a small threshold to the
difference view to hide codec noise).

## A/B Technical Diff (v0.4.0)

### Tech metadata rides `iinfo/hello`, not the beats

Codec / resolution / pixfmt / colour / audio params are stable per file, so
`main.js` `gMeta().tech` is sent on `iinfo/hello` (on load, and again on
`mpv.video-params` / `audio-params` change — those often aren't ready at
`iina.file-loaded`). `global.js` already merges arbitrary hello fields into the
registry; its per-player compare summary gained one line (`tech`). The diff
itself is **pure web-view logic** — `ui/abtech.js` picks A's and B's `tech` out
of `state.compare.players` by id. No new message, no `global.js` maths.

### `ui/abtech.js` owns all formatting + tolerances

`rows(a,b)` returns the labelled, formatted, `differ`-flagged table (or `null`
when either side has no metadata yet). fps compared within 0.01; **bitrate rows**
are `approx` and only flag a difference beyond 10 % (mpv's `video-bitrate` /
`audio-bitrate` are rolling estimates). Bit depth is derived — video from the
pixel-format suffix (`…p10le` → 10-bit), audio from the PCM codec name
(`pcm_s24le` → 24-bit; `audio-params/format` can't tell 24 from 32).

### Future: differences → QC events

Not built. The panel could offer "Mark all differences" → one
`QCE.create({ source:"compare", type:"technical-difference",
meta:{ field, a, b } })` per flagged row. `ui/events.js` already accepts that
shape; `type` and `meta` are free-form.

## QC Markers (v0.3.0)

### Generic QC event model, not a marker-specific store

`ui/events.js` is a pure module (`create` / `update` / `sort` / `filter` /
`prev` / `next` / `serialize` / `toCSV` / `toReport`) with an open `source`
list and an extensible `meta {}`. Manual markers are just the first producer;
audio-clip / freeze / black-frame / A-B-difference analysers will call
`create()` with a different `source` and land on the same timeline, filter and
export with no schema change. Event shape:
`{ id, source, type, tMs, frame, fps, tc, durMs, category, severity, note,
resolved, ts, ref, meta }`.

### The web view owns the list; main.js is thin

While the inspector is open it holds the canonical list (it already receives
frame / tc / fps / path / A-B state each poll), edits it, and pushes the whole
serialized blob up on every change (debounced, flushed on close). `main.js`
only: loads on file-load and hands it down via the poll payload; writes what
the web view sends straight to disk; captures a minimal well-formed marker for
the `⌥⇧M` menu path (inspector closed). It never sorts / filters / formats.
Keeps the most crash-prone file small and mirrors how `d.compare` already
flows. Cost: the list only persists while / just after the inspector is open
(plus the tiny standalone path).

### Persistence — internal by default, opt-in sidecar

Default: `@data/qc-<fingerprint>.json`, fingerprint = djb2(`filename|size`).
No writes next to masters; works on read-only / NAS; more robust to a file
move than an absolute path. A Settings toggle ("Store QC markers beside media")
switches reads/writes to `<media>.iinfo.json`; an existing sidecar is honoured
even with the toggle off; a sidecar write that fails (read-only volume) falls
back to `@data` and flags it. Network media → internal only. `Export ▾ ▸ Save
sidecar` always works regardless of the toggle. The serialized `media {}` block
(path / filename / size / durationMs / fps) is for humans and future
re-matching; load-time matching is the fingerprint (or the sidecar's own path).
Flat files in `@data/` (not a subdir) because the plugin file API has no mkdir.

### Dependencies — all in-house

The repo is zero-runtime-dep with no bundler; an npm lib would force a build
step for the web view. Per the brief's investigate-then-decide rule:

| Problem | Candidate(s) | Licence | Maintenance | Weight | Decision | Reason |
|---|---|---|---|---|---|---|
| Timeline marker clustering | d3-array, custom | — | — | — | in-house (~15 lines: sort + %-gap) | trivial; no edge case a lib handles better |
| CSV serialization | papaparse, csv-stringify | MIT | active | 50–200 KB | in-house `toCSV` (~12 lines, RFC-4180) | need only quote-on-demand of one flat table |
| Persistence helpers | lowdb, conf | MIT | active | 20 KB+ | `iina.file` + djb2 fingerprint | platform API already covers read/write/exists |

## A/B Compare (v0.2.0)

### Cross-window coordination → IINA global entry, not a "leader" player

**Problem:** A/B compare needs state shared across two IINA player windows. Each
window has its own `main.js` instance with no shared memory.

**Options:** (a) elect one window as coordinator and have the other talk to it via
some side channel; (b) IINA's global entry (`globalEntry` in Info.json) — a single
JS context loaded at app start that can address every window's `main.js` by id.

**Chosen:** (b). It is IINA's only real cross-window channel, it outlives any
single window closing, and it needs no election / hand-off logic. Cost: an
always-on background context (negligible) and a required IINA restart to load it.

### Frame/time representation → integer frame offset + rational fps, elapsed fallback

`lib/sync.js` holds the offset as an integer `offsetFrames` plus the rational fps
(`rationalize()` snaps 23.976/29.97/59.94 to their exact `n/1001` form).
`offsetSec` is *derived* each time, never accumulated — hammering `+1f` ten times
gives exactly `10 / fps`, not ten floating adds. When fps is unknown or A/B
differ, `mode` switches to `"elapsed"` and the offset is a raw seconds delta
(± buttons step by `1/fpsB`). `timeToFrame` is `floor(t·fps)`, the exact inverse
of the frame-centre `frameToTime`.

### Playback drift → snap on stop, no background watch

Two independent mpv instances can't be sample-locked during playback, so ganged
play is explicitly best-effort. The frame accuracy lives in the *stopped* state:
every ganged `pause` (and `Re-sync B`, and any offset change while linked) runs
`alignBoth()` — read A's position, snap A to its exact frame, seek B to that
frame ± the offset, also frame-exact. A live "B … off sync" readout (from the
~4 Hz beats) shows drift between snaps. The earlier always-on 2 s drift-watch
round-trip was removed — it added constant IPC noise and a persistent failure
surface for no real benefit over snap-on-stop.

### Offset UI → Set-as-sync + Reset, no "Re-sync"

Two buttons, not three. **Set current as sync** captures B's current distance
from A as the zero offset; **Reset** zeroes it (B lines back up with A). A
standalone "Re-sync B" (snap to A + current offset) tested as confusing — its
job is already covered by the automatic align-on-pause plus the live "B ±Nf off"
readout, so it was dropped.

### Stop touching mpv during teardown → `alive` gate

A timer callback that calls `mpv.getNumber` on a freed mpv handle segfaults, and
a native crash is not catchable from JS. Every mpv read in `main.js` goes through
`num`/`str`/`flag`/`native`, which now return `null` once `alive` is false;
`alive` flips on `mpv.shutdown` / `iina.window-did-close`, which also
`clearInterval`s the beat timer.

### Ganged play/pause → explicit verbs, never a toggle

`toggle-pause` flips each player relative to *its own* state, so if A and B
weren't already identical, one ends up playing while the other pauses. The
inspector resolves the button to an explicit `play` / `pause` from its own known
state and the global entry relays that same verb to both — they always converge.

### IINA global-entry IPC — the constraints we hit

Discovered by testing in live IINA 1.4.4 (all undocumented):

1. **`require()` doesn't return `module.exports`.** It loads the file and hands
   back `undefined`. `lib/sync.js` is therefore *inlined* verbatim into
   `global.js` (and `main.js` doesn't need it). `lib/sync.js` stays as the
   `npm test` target; `test/global-inline.test.js` asserts the copy matches.
2. **`global.postMessage(target, …)` only reaches plugin-*created* players when
   `target` is `null` or a number.** For user-opened windows the only thing that
   routes is a **string** target (matched against `PlayerCore.label`). The label
   is exactly the sender id `onMessage` gives us, so we address windows by it.
3. **child→parent delivery is synchronous.** If the global entry posts back to a
   player from inside a message handler that a player triggered (e.g. replying to
   a `hello` sent during that player's own init), IINA force-unwraps
   `pc.plugins.first{…}` on the not-yet-wired player and **traps the whole
   process**. Every global→player send is wrapped in `defer()` (`setTimeout 0`).
4. **`onMessage` callbacks only see bindings reachable from init code.** A
   top-level `let`/function referenced only from other callbacks throws "Can't
   find variable" when the callback runs (hit this with `statePromises`, then
   again with the handler functions themselves via one-line shims). Fix: the
   **entire controller is one IIFE closure** and handlers are registered by
   name (`onMsg("iinfo/gang", onGang)`, never `function(c){ onGang(c) }`).
5. **No state round-trips.** An earlier design had the global entry ask each
   player for its position and wait for the reply (`report-state` /
   `iinfo/state`). That reply handler was the thing constantly hitting #4, and
   the pattern is fragile regardless. A and B positions now come straight from
   the ~4 Hz beats already in the registry — Set-as-sync / Re-sync / align read
   `players[id].pos` and never wait. `main.js` fires an extra beat right after
   every `gang-exec` so the registry is fresh before the debounced align runs.

### No bundler

`lib/sync.js` is a CommonJS module loaded by `main.js` / `global.js` via IINA's
`require()` and by `node --test`. Two small modules don't justify a build step or
a committed `dist/`. If `require()` proves unreliable inside IINA, each entry
carries a tiny inline fallback for the functions it needs (`global.js` already
does).

### Compare UI → a panel in the existing inspector, not a second window

Reuses the ~25 Hz poll pipeline (`d.compare` rides the existing data payload),
the panel system, the visual language, and per-window lifecycle. A second
standalone window would double the window-management + crash surface.

### Deferred: QC markers → sidecar JSON

Not built in v0.2.0. When it lands: `<mediafile>.iinfo.json` next to the media
(survives reopen, travels with the file, reproducible reports), falling back to
the plugin data dir on read-only volumes. Event schema designed up front so
auto-generated QC events share it:
`{ id, type, source, tMs, frame, tc, durMs?, category, note, severity, resolved,
ref?, meta }`.
