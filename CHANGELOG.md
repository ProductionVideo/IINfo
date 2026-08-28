# Changelog

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
