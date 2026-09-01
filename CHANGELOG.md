# Changelog

## Unreleased — Milestone 1: config & event-schema consolidation

Internal only; no behaviour change intended.

- **One configuration module.** `ui/config.js` now owns every persisted
  setting, its default and its validation. The scope / Deep-QC / panel defaults
  are no longer copied across `main.js` and `inspector.js`, and the two
  validators that had drifted (one carried the BRNG/TOUT/VREP thresholds, the
  other dropped them) are gone. main.js inlines the module the same way it
  inlines the sync and Deep-QC logic, drift-guarded by a test.
- **One QC event writer.** Manual markers and Deep-QC events are both built and
  serialised through `ui/events.js` now — `main.js` no longer hand-rolls the
  event shape or the marker-file envelope.
- **Per-window inspector geometry.** Window size/position moved out of the
  shared preference blob into their own key, keyed per player. Two inspectors
  open at once (A/B) no longer overwrite each other's frame or bounce position
  between launches. Existing geometry is migrated automatically.
- **UI regression checks in the repo.** `npm run check:ui` runs five headless
  web-view checks (markers, Deep QC, scopes, A/B compare, visual compare).
  Chrome is optional — the command skips cleanly without it.

## 0.7.1

**Fix a crash on quit; size the inspector to the display it opens on.**

- **Crash fix.** v0.7.0 could segfault IINA on quit — a shutdown-time mpv event
  (end-file / audio-params) reached the plugin after the mpv handle was freed and
  a Deep-QC teardown path read a property off it. The plugin now stops touching
  mpv from `iina.window-will-close` onward (the earliest teardown signal), every
  `mpv.*` listener bails when the handle is gone, and it all self-heals if the
  window was only transiently torn down.
- **Default window size.** The first time you open the inspector it now opens a
  quarter of the screen wide and half tall, on whichever display the player is
  on — instead of a fixed 520 × 880. Resize it and that size is remembered as
  before.

## 0.7.0

**Deep QC (experimental) — automated defect detection on the timeline. QC
reports are now Markdown.**

The **Copy QC report** and the marker **Report** export are now Markdown —
headed sections and a marker table that pastes cleanly into a ticket, PR or doc.
CSV and JSON exports are unchanged.

New **Deep QC** panel, behind **Tools ▸ Appearance ▸ Experimental features**
(off by default — it's a heavy per-frame pass, see below). **▶ Start analysis**
runs FFmpeg's own analysis filters over the video for as long as you leave it
running, turning what they find into QC markers:

- **Freeze / held frames** (`freezedetect`) · **black frames** · **broadcast-range
  violations** (BRNG) · **temporal outliers** (TOUT, noise / dropout) · **vertical
  line repetition** (VREP) — via `signalstats` + a luma-black test.
- Detected issues land on the **QC Markers** list and the scrub bar as hollow
  ticks; filter the list to **Automatic**, walk them, resolve them, export them
  with the manual markers. **Clear automatic events** removes them in one click.
- Per-detector toggles + thresholds (Freeze ≥ 1–8 s, Black ≥ 0.2–1 s, Broadcast
  range Limited / Full / Off). Live readout of Y range + BRNG + TOUT.
- **Strictly opt-in, every time:** analysis never starts on its own — not on
  opening the panel, not on loading a file, not on relaunching IINA. It only
  starts on **▶ Start analysis** and stops itself when the file ends, the panel
  or window closes, or you hit **■ Stop**. It analyses every decoded frame,
  which forces software decode paths and costs real performance — especially on
  large frames — so it's a deliberate pass: play through the section you want
  checked, then stop. No new permission.

Internals: a labelled analysis-only `@iinfoqc` vf filter with the same
poll-driven, self-healing lifecycle as the audio filter and video scopes, armed
only by an explicit start/stop message (never by config or panel state); a pure,
tested metadata→event bridge (`lib/deepqc.js`, inlined into `main.js` +
drift-guarded) with span coalescing; `test/deepqc.test.js` +
`test/deepqc-inline.test.js`.

## 0.6.0

**Video Scopes — a live waveform / parade / vectorscope / histogram on the picture.**

New **Video Scopes** panel. mpv renders the selected scope onto the video in the
player window (the first video filter IINfo has used):

- **Waveform** (luma), **RGB Parade**, **Vectorscope**, **Histogram**.
- **Layout** — *Overlay* in a picture corner, or docked as a *Bottom* / *Side*
  bar (the picture makes room, the scope gets full width/height).
- **Size** S–XXL, **Brightness** (trace intensity), **Corner**, **Opacity**.
- `⌥⇧W` cycles the scope — works with the inspector closed / fullscreen.
- Runs live during playback. It's a CPU filter, so it can cost some
  hardware-decode performance; set it to Off when you're done. No new permission.

Internals: a labelled `@iinfoscope` vf filter with the same poll-driven,
self-healing lifecycle as the audio filter; `test/scopes.test.js`. This is also
the groundwork for a future *live* A/B visual compare.

## 0.5.0

**A/V compare stability fix + experimental A/B Visual Compare.**

- **Fix:** the global entry's message callbacks were intermittently losing their
  scope — `onBeat` throwing `ReferenceError: Can't find variable: String` several
  times a second, which stalled the player registry and made linked A/B compare
  drift and churn. The built-ins the handlers use are now pinned into module
  scope.

**A/B Visual Compare (experimental — enable it in Tools ▸ Appearance).**

With A and B assigned, tick **Visual compare** in the A/B Compare panel. An
overlay opens on **window A** with the two aligned frames composited:

- **Difference** — `|A − B|` per pixel (identical = black, changes light up),
  with a gain slider to amplify faint differences.
- **Flicker** — the blink-comparator: alternate A / B at 1–12 Hz. Anything that
  moved jumps; static content is rock steady.
- **Wipe** — a draggable split, A one side, B the other, pixel-aligned.
- **Onion** — A and B blended at an adjustable opacity.
- Plus plain **A** / **B**.

It's a *paused* tool — it re-grabs both frames on pause / frame-step / big seeks
(one grab at a time, ~0.6 s debounce), and enabling it auto-links transport.
Keyboard `1`–`6` for modes, `[` `]` for the slider, `r` to re-grab, `Esc` to
exit. Different resolutions disable Difference (a resample can't be pixel-diffed)
but the other modes still work.

Frames are JPEG `screenshot-to-file` grabs composited in a canvas — no video
compositing. Needs the `video-overlay` permission. **Known: performance is still
rough on 4K/ProRes; that's why it's behind the experimental flag.** Internals:
`ui/vcompare.*`, `ui/vcfit.js` + `test/vcfit.test.js`; see `DECISIONS.md`.

## 0.4.0

**A/B Technical Diff — is B actually the same encode as A?**

New **A/B Technical Diff** panel (off by default). When A and B are both
assigned, it lays their technical metadata side by side and flags every
difference:

- Container, video codec, resolution, aspect / pixel aspect, frame rate,
  duration, frame count, pixel format, **bit depth**, colour range / matrix /
  primaries / transfer, video bitrate.
- Audio codec, sample rate, channels, channel layout, **audio bit depth**,
  audio bitrate.
- Differing rows are highlighted with an `A → B` readout; the header shows the
  count ("matched" / "3 differences"). **Differences only** collapses the table
  to just the mismatches.
- Frame rate is matched within a small tolerance; bitrate rows (mpv reports a
  rolling estimate) only flag past ~10 %.

Internals: `ui/abtech.js` + `test/abtech.test.js`. Technical metadata now rides
the A/B `hello` message; see `DECISIONS.md`.

## 0.3.1

**Toolbar tidy — one "Tools" drawer, tabbed; panels are now reorderable.**

- The **Settings** button is now **Tools**, opening a tabbed drawer:
  **Panels · Appearance · Storage · Actions**.
- **Panels** tab — toggle *and* reorder every panel (`↑ / ↓`, plus *Reset
  order*). Your order persists. The default order is now a reading order (core
  video readouts → A/B Compare + QC Markers → the audio panels) instead of
  newest-on-top.
- **Actions** tab — *Copy QC report*, *Export markers* (report / CSV / JSON /
  save / sidecar), *Exact-frame screenshot*. The toolbar loses its separate
  **Report** button and the QC panel loses its **Export ▾** menu — both live
  here now.
- **Storage** tab — the marker-location toggle, with a clearer explanation.

## 0.3.0

**QC markers — mark a problem at the exact frame, navigate them, export the list.**

Built on a generic QC event model (`ui/events.js`) so the same timeline will
later carry auto-detected events (audio clipping, freezes, black frames, A/B
technical differences).

- **Mark the current frame** — `⇧M` in the inspector, or `⌥⇧M` anywhere in IINA.
  Captures position, exact frame, SMPTE timecode, fps, the media identity and —
  when A/B is linked — the A and B assignment. No dialog; it's instant.
- **QC Markers panel** (off by default; auto-shows the first time you mark).
  Severity dot · timecode · frame · category · note per row; click a row to seek
  there exactly. Inline editor for note / category (Video · Audio · Sync ·
  Colour · Performance · Content · Other) / severity (info · warning · error) /
  resolve. **Prev / Next** walk the list and seek precisely. Filter by
  All / Unresolved / Manual / category.
- **Timeline** — markers show as coloured ticks over the scrub bar; click to
  seek, nearby ticks cluster into a count, the selected one stands taller. The
  timeline follows the panel's filter.
- **Persistence** — markers survive reopening. Kept in the plugin's data folder
  by default (keyed by a filename+size fingerprint); a Settings toggle switches
  to a `<media>.iinfo.json` sidecar that travels with the file.
- **Export ▾** — copy a report / CSV / full-schema JSON, or save a JSON file or
  a `.iinfo.json` sidecar to disk. The top-bar **Report** now includes the
  marker list too.

Needs the `file-system` permission (for sidecar writes). Internals: `ui/events.js`
+ `test/events.test.js` (`npm test`); see `DECISIONS.md`.

## 0.2.0

**A/B compare — line up two IINA windows and step them together, frame-accurately.**

New *global entry* (`global.js`, loaded once at IINA startup) that tracks every
open player window and coordinates a two-window comparison. **Quit and reopen
IINA** after updating so it loads.

- **A/B Compare panel** (off by default — enable it in Settings ▸ Panels).
  Pick any two open windows as A and B; `Swap`, `Unlink`, `Refresh`.
- **Frame offset** — nudge B ±1 / ±5 frames from A, `Reset`, or `Set current as
  sync` to make wherever A and B sit right now the zero point. Frame-quantised,
  shown as `B +2f`. A live **"B … off sync"** readout shows how far B has drifted
  from that point.
- **Link transport** — play/pause, frame step, seek and scrub then drive *both*
  windows. Play/pause is sent as an explicit verb so the two never diverge, and
  **every stop re-snaps A and B to exact frames** the offset apart. `Re-sync B`
  does the same on demand.
- **Different frame rates** are detected (`FPS MISMATCH`); the offset falls back
  to elapsed-time.
- Closing either window, or loading a different file into A/B, updates the pairing
  cleanly and never leaves a dead window selectable.
- Single-player behaviour is unchanged when the panel is off.

Two independent mpv instances can't be sample-locked during playback, so ganged
play is best-effort; the frame accuracy is in the paused / stepped / re-synced
state. Internals: `lib/sync.js` + a `node --test` suite (`npm test`); see
`DECISIONS.md`.

## 0.1.12

**Fix — the real cause of the idle crash.** IINA stores each `onMessage` / menu /
event callback as a `JSManagedValue` anchored only to one of its API objects. If
JavaScriptCore does not treat that object as a GC root (it may not), our callbacks
— anonymous closures with nothing else referencing them — become collectable, and
a full GC (which tends to run once the app has idled) frees them. IINA's
`callListener` then traps dereferencing the now-nil value. Playback state is
irrelevant; it just needs a GC while a message is in flight.

Every callback handed to IINA is now held in a module-level object/array so the GC
can never collect it. Keeps the v0.1.11 "stay quiet while backgrounded" behaviour
as belt-and-braces.

## 0.1.11

**Fix — IINA crashing when idle (4th report, same stack).** IINA's message hub
traps (`SIGTRAP`) when it delivers a standalone-window message to a
garbage-collected callback — it only happens once IINA has been backgrounded a
while, because our inspector keeps polling and every message is a chance to hit
that bug.

The web view now watches the real gap between its own timer ticks. When macOS
backgrounds IINA, WebKit throttles the timer and the gap balloons — the moment we
see that, the web view **goes completely silent** (no polls, no config, no
geometry) until it's running full-speed again, which it detects and resumes on
its own. Also fixes a stray `ReferenceError` (a leftover `active` reference from
v0.1.10) that fired every 2 s.

## 0.1.10

**Fix — v0.1.9 broke the inspector (blank window / no realtime updates).**
IINA's `standaloneWindow.loadFile()` clears every registered message listener.
v0.1.9 moved `loadFile()` to open-time but still registered the handlers once at
plugin start, so `loadFile` wiped them and the web view could not talk to the
plugin. Handlers are now re-registered immediately after every `loadFile()`.

Also reverted the rAF-based "is it painting" gating from v0.1.9 — it could
mis-read a visible-but-not-frontmost window as hidden and throttle updates. The
web view now just polls steadily (WebKit throttles the timer itself when the
window is genuinely hidden), and the crash mitigation is simply: the inspector
page is only loaded while the window is open.

## 0.1.9

**Fixes**

- **IINA crashing when idle** — three crash reports all pointed at IINA delivering
  a message from our standalone web view to a torn-down plugin context. The web
  view is now only loaded while the inspector is open (a blank page is swapped in
  on close), polls at 0.4 Hz instead of 30 Hz whenever it is not actually
  painting, and shuts itself down after 5 minutes hidden.
- **Audio readout intermittently missing after the inspector had been open a
  while** — `iina.window-will-close` (which also fires on transient player-window
  teardown, e.g. when playback stops) was permanently clearing the "window is
  open" flag, so metering never re-armed until you toggled the inspector. It no
  longer touches that flag.
- Metering now follows the web view actually being on screen (rAF running) rather
  than window focus.

**Features**

- **Copy** the current timecode or frame number — hover the essentials readout for
  `copy` / `go` chips, or press `c` (timecode) / `Shift+C` (frame).
- **Go field maths.** Absolute: a timecode, `#frame`, `50%`, `90s`. Relative to
  the current point, repeatable on each Enter: `+5` / `-5` seconds, `+#15` /
  `-#15` frames, `+2:30`, `+10%`. Or base ± delta: `00:00:05;17 + 2`. Every
  jump snaps to a frame.

## 0.1.8

- The inspector window now **remembers its size and position** between sessions.
  Position is only restored if it still lands on a screen (your display setup may
  have changed), otherwise just the size is.
- **Text-size range shifted up** — the old sizes read too small. "Normal" is now
  what was one notch above; the smallest option is the old "Normal".

## 0.1.7

- **Fixed: audio meters dying when jumping between files / after the inspector
  lost focus.** IINA reports the web view "hidden" whenever its window isn't
  frontmost, and v0.1.6 mistook that for "closed". Window state is now pure user
  intent (`wantWindow`) — opened via the toggle, closed via the toggle or the
  window's close button — and nothing about focus, occlusion or playback state
  touches it.
- The plugin tells the web view when it's genuinely open; until then the web view
  ticks at 1 Hz instead of 30 and skips all rendering work.
- Watchdog no longer gives up on the window — if the web view goes quiet it just
  parks the audio filter and re-arms it when polls resume.

## 0.1.6

- **Fixed: the inspector wouldn't open.** `standaloneWindow.loadFile()` runs the
  web view headless at plugin load; its polling was being mistaken for "window is
  open", so the first ⌥⇧I / menu click ran the *close* branch. Window visibility
  (`winShown`) is now tracked strictly from `openWindow`/`closeWindow` plus a
  hidden/close signal from the web view.
- **Fixed: the audio analysis filter was inserted into every video just from the
  plugin being installed.** It now only runs while the inspector is actually on
  screen.
- The web view stops polling while hidden. Added open/close/toggle log lines.

## 0.1.5

- Reverted the HUD/vibrancy window — back to a solid opaque window while the
  "inspector won't open" report is understood.
- Hardened plugin load: `setupWindow`, menu registration, `event.on` and
  `standaloneWindow.open` are each wrapped, so one failure can't stop the
  "Toggle IINfo Inspector" menu item from appearing or the window from opening.
- Startup / ready log lines for the IINA plugin console.

## 0.1.4

- Web view split into `inspector.html` / `.css` / `.js`.
- HUD window — translucent / vibrancy, like IINA's own Inspector.
- Leaner first run: Timecode, Video Signal, Waveform and Levels open by default;
  the rest are one click away and now persist.
- Dead-code and comment pass; smaller data payload.

## 0.1.3

- **Fixed:** meters / waveform going dead after closing a clip and opening another.
  The analysis filter lifecycle is now driven from the poll loop and self-heals;
  `af add` failures show on the panel instead of a silent "waiting".
- **Fixed:** display settings and open panels not surviving a restart
  (`preferences.sync()`).
- **Fixed:** the essentials timecode couldn't be selected — it no longer rebuilds
  every frame. Clicking it (or the frame number) drops it into the Go field.
- Waveform redrawn as smooth min–max + RMS curves; themed accent colour, red only
  on clip.
- Level meters use a theme-accent gradient that shifts to amber/red only in the
  top few dB.
- Default theme is Black (OLED); added Graphite, Midnight Blue, Green Phosphor,
  Amber CRT. Default readout font is Courier.

## 0.1.2

- **Fixed:** Space and the other playback keys scrolled the panel list instead of
  controlling playback while the inspector window was focused — they're now
  relayed to IINA (`Space`, `k`, `←/→`, `j/l`, `,` `.`, `m`, `[` `]`, `Home/End`).
- SVG icons; state-driven play/pause (green "resume" when paused).
- Frame-scale jump buttons (`−10f −5f +5f +10f`); click/drag scrub bar.
- "Panels" button renamed "Settings".

## 0.1.1

- Display settings: theme, readout font, text size — persisted.
- Meters gained an alpha gradient and dB gridlines.

## 0.1.0

- First release. Nine QC panels, pinned essentials strip, scrolling audio waveform,
  level + EBU R128 loudness meters, transport + report controls.
