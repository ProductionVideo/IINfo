# IINfo

A real-time video-QC toolkit that lives inside [IINA](https://iina.io). A
floating, theme-able inspector window reports exactly what the player is decoding
and rendering *right now*, frame by frame — plus A/B version comparison, manual
and automated QC issue marking, and live signal scopes.

<p align="center">
  <img src="docs/hero.png" alt="IINfo inspector window" width="440"><br>
  <img src="docs/waveform.png" alt="Audio waveform and level meters" width="300">
  <img src="docs/settings.png" alt="Panel and display settings" width="300">
</p>

## Inspector panels

A pinned **essentials strip** always shows the critical data — big SMPTE
timecode, frame number, fps, A/V-sync and peak level. Hover it for **copy** / **go**
chips (`c` copies the timecode, `Shift+C` the frame number). Below it every panel
is an independent toggle in **Tools ▸ Panels**, where you can also reorder them;
your layout persists.

| Panel | Contents |
|---|---|
| **Timecode & Frames** | SMPTE timecode (NDF + drop-frame), current / total frame, container fps + source, position / duration / remaining, progress |
| **Frame Metadata** | Picture type (I/P/B), keyframe, progressive / interlaced + field order, repeat flag, GOP / stream SMPTE TC |
| **Video Signal / Color** | Coded vs display size, DAR / PAR, pixel format, chroma + bit depth, chroma siting, range, matrix, primaries, transfer, signal peak, rotation, 3D / alpha |
| **Video Scopes** | Live waveform / RGB parade / vectorscope / histogram, rendered on the picture (see below) |
| **Codec & Bitrate** | Container, file size, codec + decoder, hardware-decode path, live video bitrate sparkline, audio codec + bitrate |
| **A/V Sync & Dropped Frames** | A/V-sync offset (ms) + history, decoder / output drop counts, mistimed / delayed frames, display vs filtered fps, demux cache |
| **A/B Compare** | Line two open windows up as A / B — offset, link transport, step together frame-accurately |
| **A/B Technical Diff** | A and B's codec / resolution / fps / pixel format / bit depth / colour / audio params side by side, every difference flagged |
| **QC Markers** | Mark issues at the exact frame, tag and navigate them, see them on the scrub bar, export |
| **Deep QC** | User-started automated defect detection — freeze / black / broadcast-range / noise / line-repeat — fed onto the QC Markers timeline (see below) |
| **Audio Waveform** | Live scrolling min–max + RMS curves, per channel or summed. Themed accent; red only where a sample clips |
| **Audio Levels** | Per-channel meters — RMS on a theme-accent gradient that turns amber/red only near clip, plus peak and peak-hold ticks |
| **EBU R128 Loudness** | Momentary / Short-term / Integrated LUFS, LRA, True Peak, target reference, momentary sparkline |
| **Audio Format** | Sample rate, channels + layout, sample format, codec, track title / language |

## A/B version compare

Open two versions of a shot in one IINA (both windows in the same process).
Assign them **A** and **B** in the A/B Compare panel, nudge **B** off **A** by
whole frames (or *Set current as sync*), tick **Link transport**, and play /
scrub / frame-step drive both windows. Every stop re-snaps A and B to exact
frames — the accuracy lives in the paused state; ganged playback is best-effort
(two mpv instances can't be sample-locked).

**A/B Technical Diff** lays the two files' technical metadata side by side and
flags every mismatch (colour range, bit depth, codec, audio params…), with a
"differences only" view.

**Visual compare** (experimental — enable it in Tools ▸ Appearance) opens an
overlay on window A with the two aligned frames composited: difference, flicker,
wipe, onion. Paused / stepped only, and still rough on performance.

## QC markers

Notice a problem → `⇧M` in the inspector, or `⌥⇧M` anywhere in IINA → the current
frame is captured instantly with its timecode, frame, fps and (if A/B is linked)
the A and B identities. Tag each marker (category / severity / note), walk them
with Prev / Next, and they show as ticks on the scrub bar — click to seek.
Markers persist per media (in the plugin data folder, or a `<media>.iinfo.json`
sidecar if you turn that on in Tools ▸ Storage) and export from **Tools ▸
Actions** as a report / CSV / full-schema JSON.

## Deep QC

**Tools ▸ Panels ▸ Deep QC**, then **▶ Start analysis**. IINfo runs FFmpeg's own
analysis filters over the video for as long as you leave it running, turning
what they find into QC markers:

- **Freeze / held frames**, **black frames**, **broadcast-range violations**
  (BRNG), **temporal outliers** (noise / dropout, TOUT), **vertical line
  repetition** (VREP).
- Detected issues appear on the **QC Markers** list and the scrub bar as hollow
  ticks — filter the list to **Automatic**, walk them, resolve them, and export
  them alongside the manual markers. **Clear automatic events** wipes them.
- Per-detector toggles and thresholds; a live readout of the luma range, BRNG
  and TOUT.
- **It's a deliberate pass, not a background feature.** Analysis never starts on
  its own — opening the panel, opening a file, or relaunching IINA never arms
  it. It analyses every decoded frame, which forces software paths and costs
  hardware-decode performance, so you start it explicitly, play through the
  section you want checked, then **■ Stop** (or let it stop itself at end of
  file / on close). No new permission.

## Video scopes

**Tools ▸ Panels ▸ Video Scopes** (or `⌥⇧W` to cycle). mpv renders the selected
scope onto the picture in the player window:

- **Waveform** (luma), **RGB Parade**, **Vectorscope**, **Histogram**.
- **Layout** — *Overlay* in a corner, or docked as a *Bottom* / *Side* bar (the
  picture makes room and the scope gets full width/height).
- **Size** S–XXL, **Brightness** (trace intensity), **Corner**, **Opacity**.
- Live during playback. It's a CPU filter, so it can reduce hardware-decode
  performance — set it to Off when you're done.

## Controls & keyboard

**Transport:** skip to start / end · frame step · stateful play/pause · jump bar
(`−10s −1s −10f −5f · +5f +10f +1s +10s`) · exact-frame screenshot · click/drag
scrub bar.

**Go field** — absolute: a timecode (`01:23:45;12`), `#4736` (frame), `50%`,
`90s`. Relative to the current point, repeatable on each Enter: `+5` / `-5`
(seconds), `+#15` / `-#15` (frames), `+2:30`, `+10%`. Or *base ± delta*:
`00:00:05;17 + 2`. Every jump snaps to the nearest frame.

**Keyboard** (inspector window focused — keys are relayed to IINA):
`Space`/`k` play·pause · `←`/`→` seek ∓5 s · `j`/`l` ∓10 s · `,`/`.` frame step ·
`Shift`+`←`/`→` frame step · `m` mute · `[`/`]` speed · `Home`/`End` · `⇧M` mark
QC issue.
**Menu bindings:** `⌥⇧I` toggle inspector · `⌥⇧←/→` frame step · `⌥⇧S`
screenshot · `⌥⇧M` mark QC issue · `⌥⇧W` cycle video scope.

**Tools drawer:** **Panels** (toggle + reorder) · **Appearance** (theme / font /
size / experimental features) · **Storage** (marker location) · **Actions** (copy
QC report, export markers, screenshot).

**Appearance:** Black (OLED, default) / Dark / Graphite / Midnight Blue / Green
Phosphor / Amber CRT / High contrast / Light / Auto · readout font (Courier
default + a dozen mono faces) · text size XS–XXL.

## Install

Requires IINA 1.4.0+.

- **Release:** download `IINfo.iinaplgz` from the
  [latest release](https://github.com/ProductionVideo/IINfo/releases/latest) and open it.
- **From GitHub:** IINA ▸ Settings ▸ Plugins ▸ **+** ▸ `https://github.com/ProductionVideo/IINfo`.
- **Development:** `iina-plugin link /path/to/IINfo`, enable Developer Mode.

**Quit and reopen IINA** after installing or updating — A/B Compare relies on a
global entry that only loads at startup.

Then open a video ▸ **Plugin** menu ▸ **Toggle IINfo Inspector** (`⌥⇧I`).

## How it works

`main.js` runs per player window; a ~30 Hz poll from the web view pulls one JSON
payload of mpv properties. `ui/inspector.{html,css,js}` is a self-contained web
view (no build step) — panels are built once and updated in place,
`requestAnimationFrame` drives the meters and canvases.

Audio metering, video scopes and Deep QC are each a labelled lavfi filter
(`@iinfo`, `@iinfoscope`, `@iinfoqc`) whose entire lifecycle runs from the poll
handler — installed, torn down and reinstalled per clip, retried if it was added
too early — so a close→open or track switch always recovers on the next poll.
Deep QC's `@iinfoqc` is analysis-only (the picture passes through untouched); a
pure, tested bridge (`lib/deepqc.js`) turns its frame metadata into QC events.

A/B Compare adds a **global entry** (`global.js`, one per IINA process): it tracks
every open player window, owns the compare state and the frame maths
(`lib/sync.js`), and relays ganged transport. Manual and automated (Deep QC)
markers ride one generic event model (`ui/events.js`), sharing the same timeline,
filter and export.

Settings persist via `iina.preferences`. Permissions used: `show-osd`,
`file-system` (marker sidecars / exports), `video-overlay` (visual compare).

## Limitations

- Meters / audio waveform update only while audio is playing.
- Ganged A/B playback is best-effort; frame accuracy is in the paused / stepped
  state. Both windows must be in the same IINA process.
- Video scopes, Deep QC and Visual Compare are CPU filters / screenshot-based —
  they can cost hardware-decode performance. Deep QC also samples `signalstats`
  at the poll rate, so very brief transient defects between polls can be missed.
- Timecode uses `container-fps`, falling back to an estimate; drop-frame is
  assumed for the 29.97 / 59.94 family only.
- `video-frame-info` fields vary by mpv build.

## License

MIT — see [LICENSE](LICENSE). Changelog in [CHANGELOG.md](CHANGELOG.md);
engineering notes in [DECISIONS.md](DECISIONS.md).
