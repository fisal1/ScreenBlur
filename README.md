# ScreenBlur (POC)

Detects explicit content on screen and blurs only the areas where it appears; the rest of the
screen stays untouched. Everything runs locally; no frames leave the device. See
[docs/RFC.md](docs/RFC.md) (rev 2) for the original design.

## Run

`start.ps1` uses Node.js from PATH if installed; otherwise it downloads a portable copy into
`tools/node` on first run. Dependencies, the Electron binary and the model are also fetched on
first run, so nothing needs to be installed system-wide.

```powershell
.\start.ps1            # run the app (tray icon appears)
.\start.ps1 verbose    # run and log every inference result with the blurred areas
.\start.ps1 selftest   # Phase 0 checks; writes selftest-results.json (screen flashes magenta twice)
.\start.ps1 test       # unit tests
```

Test mode, safe to try without explicit content: faces are treated as targets and get blurred.

```powershell
.\node_modules\electron\dist\electron.exe . --detect-faces --verbose
```

## How it works

1. A hidden window captures the primary display at the model input size (960x544 on 16:9) and
   sends each new frame as soon as the capture stream delivers it (up to 30 fps). The model runs
   on the fastest device found at startup: GPU via DirectML if available, otherwise CPU.
2. The NudeNet detector finds exposed body parts; overlapping boxes are merged and each box is
   padded by 20% so small movements don't expose its edges.
3. Each area is covered with the animated GIF in `assets/patch.gif` (cropped to fit). If that
   file is missing, the area gets a blur instead: a tiny averaged-color grid of what's
   underneath, drawn scaled up and blurred, so it can't be seen through. The GIF is not in git
   (third-party content); put any GIF at `assets/patch.gif` to use it.
4. A transparent, click-through window that is excluded from screen capture draws the patches.
5. Areas are tracked individually: one appears when its score reaches the threshold, follows the
   content while its score stays above half the threshold, and disappears 1.5 s after it was last
   confirmed.
6. Each area's speed is estimated from successive detections. Between updates the overlay keeps
   moving the patch at 60 fps, and stretches it to cover both where the content was and where it
   is predicted to be, so moving video stays covered.

Measured on a Ryzen 7 4800H + RTX 3050 laptop: ~29 updates/s, ~18 ms per frame on the GPU
(CPU only: ~6 updates/s).

## Controls

| Hotkey | Action |
| :-- | :-- |
| `Ctrl+Alt+B` | Toggle protection on/off |
| `Ctrl+Alt+W` | "This was wrong" - remove all blurred areas and block new ones for 10 s |
| `Ctrl+Alt+O` | Show/hide a test patch in the middle of the screen |

Left-click the tray icon (or choose **Settings...**) to open the settings window, where a slider
sets the score (5-95%) at which an area is blurred, with a live meter of the highest score on
screen. The setting is saved in `%APPDATA%\screenblur\settings.json`.

The tray menu also has sensitivity presets (Strict 20% / Balanced 30% / Relaxed 45%), snooze
(5 / 15 / 60 min) and quit. Hovering over the tray icon shows how many areas are blurred.

## Structure

```
src/
  main/                   Electron main process
    index.js              entry point (normal run or --selftest)
    config.js             all tunable settings and paths
    screenblur-app.js     orchestrates capture -> inference -> region tracking -> overlay
    region-tracker.js     per-area hysteresis, stale-result filter, "this was wrong"
    sensitivity.js        threshold percentage, presets and limits
    model-input.js        model input size for a display (keeps aspect ratio)
    capture-host.js       hidden capture window lifecycle
    inference-host.js     inference utility process lifecycle (auto-restart)
    overlay.js            capture-excluded, click-through overlay window
    tray.js, tray-icon.js tray menu and generated icons
    settings-window.js    settings window (sensitivity slider, live score)
    settings-store.js     saved settings (JSON in userData)
    hotkeys.js            global shortcuts
    self-test.js          Phase 0 checks
  inference/              utility process
    worker.js             receives frames, runs the model, reports results
    nudenet.js            NudeNet preprocessing, box decoding and NMS
    regions.js            padding, screen-normalized boxes and blur mosaics
    backend-selector.js   picks the fastest execution provider (DirectML GPU or CPU)
  renderer/
    capture/              hidden page: screen stream -> model input frames
    overlay/              overlay page: draws the blurred patches
    settings/             settings page
  shared/
    messages.js           message and IPC channel names
    geometry.js           box helpers (IoU, padding, clamping)
    motion.js             motion prediction shared by the tracker and the overlay
assets/patch.gif          GIF shown over detected areas (local only, not in git)
docs/RFC.md               design document
scripts/fetch-model.js    downloads and verifies the model
scripts/score-image.js    diagnostic: score an image the way the app would
test/                     unit tests (node:test)
models/                   NudeNet 320n ONNX model (downloaded)
tools/                    say.ps1 (speech updates); portable Node.js is downloaded here
```

## POC limitations

- Primary display only.
- Windows only; macOS content protection is not yet verified.
- Fast motion: in a test with a face moving at 600 px/s inside a page, the face was fully covered
  about half the time and the median uncovered strip was 0 px, but 10% of the time up to ~50 px
  of the leading edge showed. Sudden direction changes are the hardest case.
- Content animated on its own GPU layer (e.g. CSS `will-change: transform`) may not produce new
  capture frames on some systems, so it is checked only 2 times per second. Normal `<video>`
  playback was captured at the full rate in testing.
- Without a usable GPU the model runs on the CPU at ~6 updates/s.
- The detector finds body parts, so content without a clearly visible part may not be blurred.
- Thresholds need tuning with real content. The Strict 20% preset can blur innocent things
  (in testing, hair in a close-up portrait scored 20%).
- DRM-protected video captures as black and cannot be detected.
- Images shown smaller than ~250 px tall may be missed. Raise `modelInput.longSide` in
  `src/main/config.js` for more detail at more CPU cost.

## Diagnostics

Score an image file the way the app would see it on screen and list the areas it would blur:

```powershell
.\node_modules\electron\dist\electron.exe scripts\score-image.js "C:\path\to\image.jpg" --screen 1920x1080
```
