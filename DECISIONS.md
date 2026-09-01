# Engineering Decision Log

Short record of architectural choices — especially dependencies, frame/time
representation, cross-window communication, sync strategy, persistence, and
FFmpeg/mpv filter use. Newest first.

---

## Deep QC (v0.7.0)

### Analysis-only lavfi filter, armed only by an explicit start — never by config

`@iinfoqc:lavfi=[signalstats=stat=tout+vrep+brng, freezedetect=d=…]` — the
picture passes through untouched; each sub-filter attaches `lavfi.*` frame
metadata. `tickQC()` mirrors `tickScope()` / `tickFilter()` (reconcile the graph
string against config + `fileGen`, remove-now/add-next-tick, self-heal). Gated on
`wantWindow && qcRunning`.

`signalstats=stat=tout+vrep+brng` is expensive — real per-pixel work every
frame that forces the frame through system memory, defeating hardware-decode
passthrough on large files. The first cut gated the filter on the panel being
*open* (`panels.deepqc`), matching the audio-meter panels. That's wrong for a
filter this heavy: a panel checkbox is sticky config, so it silently re-armed
the analysis on *every* file opened afterwards, including ones the user had no
intent of QC'ing — reported live as "poor performance out the box" opening
large files. Deep QC is now a **deliberate, user-started pass**: `qcRunning` is
a plain runtime flag, set `true` only by the panel's ▶ Start analysis button
(`iinfo-deepqc {op:"start"}`) and never derived from panel visibility, never
restored from persisted config (`normalizeDeep()` only carries detector
settings — thresholds/toggles — which are inert at rest). It stops itself
(`stopQC()`) on file change, end of file, panel/window close, or ■ Stop; a
relaunch always starts idle. No new permission — `vf add`/`remove` is labelled,
the user's own chain is untouched.

### The metadata→event bridge is pure, tested, and inlined

`lib/deepqc.js` — `analyze(meta, state, opts, posMs) -> {events, state}`. No DOM,
no `iina`, no I/O; `state` is plain-serialisable; `analyze` never mutates its
input. `main.js` inlines it verbatim (IINA's `require()` can't be trusted to
return `module.exports` — same call as `lib/sync.js` in `global.js`);
`test/deepqc-inline.test.js` drift-guards the copy against `test/deepqc.test.js`.
`main.js` finalises the partial events (id / ts / frame / tc), buffers them, and
every ~1.5 s merges the batch into `qcList` (dedup key
`source|type|round(tMs/500)`) → bumps `qcGen` → persists → the webview adopts on
its next poll. Deep-QC events are ordinary QC events (`ui/events.js`) with
`source ∈ {video, signalstats, freezedetect}` and `meta.auto = true`, so the
timeline, list filter and export were already done.

### signalstats is sampled; freeze/black are span- or dedup-based

`signalstats` emits fresh BRNG/TOUT/VREP/YMAX every frame, so the poll samples
them and coalesces per-metric **spans** (open on the first dirty sample, close
after a clean gap > 1 s, drop spans < 300 ms, merge spans < 1 s apart). Spans are
finalised (`deepqc.flush`) only at real stop points — pause / file change /
teardown — never on the periodic buffer flush, or one ongoing violation would
split. **Black** is derived from a sustained low `YMAX` (depth-aware ceiling)
rather than `blackdetect`, because a per-frame signalstats value can't be missed
by the poll the way `blackdetect`'s sparse `black_start` can. **Freeze** still
needs `freezedetect`; mpv keeps the last metadata dict, so `freeze_start` is
re-read across polls and deduped on its value, with a corrected duration emitted
once `freeze_end` lands.

### Ships experimental; mpv's watch-later can resurrect a labelled filter

Deep QC ships behind **Tools ▸ Appearance ▸ Experimental features** (default
off) — the panel is filtered out of the drawer and `startQC()` refuses unless
`lastConfig.settings.experimental`. On a stitched/panoramic source (an 8400×1344
clip in live testing) `signalstats=stat=tout+vrep+brng` pushed IINA past 300 %
CPU on its own; the feature is genuinely useful but its performance envelope
isn't settled, so it stays opt-in-behind-a-flag alongside A/B Visual Compare.

Live testing also turned up an mpv-level trap unrelated to our gating: IINA's
default `watch-later-options` list includes `vf` and `af`, so mpv **saves the
current filter chain into that file's resume config and re-applies it verbatim
when the same file is next opened** — before any plugin JS runs. A file closed
while `@iinfoqc` (or `@iinfoscope`) happened to be active gets that filter baked
into its watch-later state and briefly re-armed at t≈0 on reopen. `stopQC()` /
`tickScope()` from `iina.file-loaded` strip it within ~1 s (before real decode
traffic), so the practical cost is near zero, but it's why "it's running and I
didn't start it" can still appear to happen. Not worth fighting from the plugin
(no clean API to edit IINA's watch-later-options); documented here so it isn't
re-diagnosed from scratch.

## Video Scopes (v0.6.0)

### mpv renders the scope, on the video — same lifecycle as the audio filter

A labelled `@iinfoscope` `vf` filter (`split` → scope → `overlay` / `pad` +
`scale2ref`). `tickScope()` mirrors `tickFilter()` exactly — reconciles the
running graph string against `scopeCfg` + `fileGen` from `collect()` **and** the
1 Hz watchdog, remove-now/add-next-tick on any change. Not gated on the inspector
window (the video is the consumer), so `⌥⇧W` works fullscreen. `vf add`/`remove`
via `mpv.command`, labelled — the user's own `vf` chain is untouched. No new
permission. This is the reusable video-lavfi pattern; a future live A/B compare
(`blend=difference` with an `--external-file`) is the same shape.

### Docked layouts pad + scale2ref, never hstack/vstack

`vstack`/`hstack` require identical pixel formats, which would force the picture
through a lossy `format=yuv420p`. Instead: `pad` the picture (keeping its native
format / bit depth), `scale2ref` the scope into the strip `pad` added, `overlay`
it there. Even strip height via `ceil(ih*(1+frac)/2)*2`.

### Readability > minimalism

mpv's `waveform` defaults (`intensity=0.04`, `bgopacity=0.3`) are invisible over
dark footage. IINfo forces `bgopacity=1`, exposes `intensity` as a Brightness
slider (default 0.18), frames the overlay box, and offers sizes to XXL. The
scope is a QC instrument — it needs to read at a glance, not blend in.

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
`num`/`str`/`flag`/`native`, which return `null` once `alive` is false.

**`alive` must flip on `iina.window-will-close`, not just `mpv.shutdown`.** v0.7.0
shipped with `stopQC()` calling `native("vf")` (via `qcPresent()`) on the
`mpv.end-file` / `mpv.shutdown` / teardown paths — and on every quit IINA
delivered a `MPVController.handleEvent` (end-file, or an `audio-params.changed`
with the params going null) to our still-registered listener *after* the mpv
handle was gone → `mpv_get_property` SIGSEGV, four crash reports, identical
stack. `mpv.shutdown` / `iina.window-did-close` were too late: in every observed
session `window-will-close` fires 20 ms – 4 s before `Player has shutdown`, so
that is where `alive` now flips (and `afActive`/`armedGen` reset). `goodbye` and
the `mpv.shutdown` handler also set `alive = false` as their first line, before
any read. The rules that follow from this:

- No mpv-event handler (`on("mpv.*")`) may read or command mpv without an
  `if (!alive) return` at the top — `video-params.changed` always had it;
  `audio-params.changed` and the deep-QC `end-file` handler now do too.
- `stopQC()` never probes mpv (`native("vf")`); it removes `@iinfoqc` only when
  `alive && qcArmedSig` (the label we set on our own `vf add`). `mpv.end-file`
  does no mpv work at all — just `qcRunning = false` + a pure `flushQC`.
- `alive` is recovered on `iina.file-loaded` and `iinfo-ready` (both unambiguous
  "player is up" signals) so a *transient* `window-will-close` — inspector still
  open, no real shutdown — self-heals: metering/scope/QC filters reinstall on the
  next `tickFilter`/`tickScope`/`tickQC`, and the 1 Hz watchdog also mops up any
  `@iinfo` / `@iinfoqc` that mpv's watch-later restored while the inspector was
  closed.

### Ganged play/pause → explicit verbs, never a toggle

`toggle-pause` flips each player relative to *its own* state, so if A and B
weren't already identical, one ends up playing while the other pauses. The
inspector resolves the button to an explicit `play` / `pause` from its own known
state and the global entry relays that same verb to both — they always converge.

### IINA global-entry IPC — the constraints we hit

Discovered by testing in live IINA 1.4.4 (all undocumented):

0. **(v0.5.0)** The callback scope flakiness (#4 below) is worse than "custom
   top-level bindings" — under load it drops **JS built-ins**. Seen live:
   `onBeat` throwing `ReferenceError: Can't find variable: String` ~8×/s, which
   aborted every beat, stalled the registry, and got players swept. Fix: alias
   the built-ins the handlers touch (`String`, `Object`, `Date`) into
   **module-level** `var`s (which survive reliably, as `sync` does) and use those
   — `_String(x)`, `_Object.assign`, `_Date.now()`.


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
