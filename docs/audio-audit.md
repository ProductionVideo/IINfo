# Audio QC panel — red-state audit (M1.1.2)

Read-only investigation. **No audio code changed in this pass.** This is the
input for the later Audio QC Presentation redesign.

The complaint: across hundreds of clips the Audio Levels / Waveform panels show
**red** far too often, and the UI implies red = clipping. That claim is not
credible for most of the tested material.

## What actually drives red

| Surface | Source value | What it is | Threshold for red | Code |
|---|---|---|---|---|
| **Audio Levels** — numeric value gets `.clip`, footnote flips to "⚠ peak ≥ 0 dBFS — clipping" | `meterModel[ch].peak`, eased from `lavfi.astats.<ch>.Peak_level` | **sample** peak of the last ~1024-sample analysis window, in dBFS | `m.peak > -0.1` | `ui/inspector.js` ~506 / ~525 |
| **Essentials strip** — `peak … dBFS` chip | same `Peak_level` (via `meterModel[*].peakT`) | same | `pk > -0.1` → `bad`; `pk > -3` → `warn` | `ui/inspector.js` ~1564 |
| **Audio Waveform** — column painted red | `lavfi.astats.<ch>.Min_level` / `Max_level` | **raw linear** sample extremes, range ±1.0 | `max(\|min\|, \|max\|) >= 0.999` (≈ −0.0087 dBFS) | `ui/inspector.js` ~105 / ~198 |
| **EBU R128** — True peak row `bad` | `lavfi.r128.true_peak*` | inter-sample true peak, dBTP | `tp > -1` | `ui/inspector.js` ~527 |

The analysis filter is
`@iinfo:lavfi=[asetnsamples=n=1024:p=0,astats=metadata=1:reset=1,ebur128=metadata=1:peak=true]`
(`main.js` ~41), read once per ~25 Hz poll via `af-metadata/iinfo`.

## Why it fires on non-clipping material

1. **It is sample peak, sampled in tiny windows, treated as an instantaneous
   flag — not a QC event.** `astats reset=1` over `asetnsamples=1024` reports the
   single loudest sample of each ~21 ms window (48 kHz). Any master that has been
   normalised or limited to the usual −1 … −0.1 dBFS ceiling — i.e. most
   delivered mixes and virtually all music — will, in *some* 21 ms window, put a
   sample within 0.1 dB of full scale. One sample near full scale is not
   clipping.
2. **`−0.1 dBFS` is far too tight for a "clipping" claim.** A perfectly compliant
   −1 dBTP master routinely has individual sample peaks above −0.1 dBFS. The
   threshold catches "mastered at a normal level", not "clipped".
3. **The waveform's `0.999` linear test (≈ −0.009 dBFS)** is tighter still, so
   any normalised-to-0 file paints red on nearly every column.
4. **No latch / hold.** Red is the *eased instantaneous* `m.peak`, so it strobes
   in and out rather than reporting "an over happened here". There is no
   retained "this file clipped" state.
5. **`parseDb` sentinels are handled** (`-inf` / `nan` → `−Infinity`), so silence
   is safe — but `astats` emits `Peak_level` `0.000000` for any window that
   touches format maximum, which becomes exactly 0 dBFS → red. The dB values
   themselves are correct; **no scaling or conversion bug was found.** The
   problem is threshold + semantics, not arithmetic.
6. **True-peak `> −1` = "bad"** over-claims. −1 dBTP is a *recommendation
   ceiling* (EBU R128), not a defect, and several delivery specs sit at −2 dBTP;
   material at −0.9 dBTP is fine for many targets and should not read as an
   error.

## Conclusion (for the later redesign — not this pass)

The measurements are sound. The **thresholds and the word "clipping"** are the
defect. When the presentation redesign happens it should:

- Separate **"near full scale"** (a neutral readout: `PEAK −0.1 dBFS`) from a
  genuine **over** condition.
- Only show a latched **CLIP** indicator when the condition is trustworthy — e.g.
  true peak `> 0 dBTP`, or ≥ N consecutive full-scale samples if that is cheaply
  obtainable from existing metadata — and otherwise not make the claim. Retain
  the latch until reset / file change.
- Move warn / error bands to values that mean something for QC (headroom,
  delivery-spec ceilings), configurable target rather than a hard −0.1.
- Use real channel labels from `audio-params/hr-channels` (`L R C LFE Ls Rs`)
  instead of `ch0 ch1`.
- Add **no** new filters, **no** higher analysis rate, **no** FFT — DOM/CSS and
  threshold logic only.

## To capture during live testing

Open the Audio Levels panel on ~6 representative normal clips and record, for
each red state seen: the `Peak_level` (per channel), the `r128.true_peak`, and a
one-line description of the material. Append below.

| Clip | material | `Peak_level` (L / R) | `true_peak` | genuinely clipped? |
|---|---|---|---|---|
| _(to fill in)_ | | | | |
