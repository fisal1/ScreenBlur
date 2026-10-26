# ScreenBlur (POC)

Detects explicit content on screen and covers it with a calm overlay. Everything runs locally; no frames leave the device. See [docs/RFC.md](docs/RFC.md) (rev 2) for the design.

## Run

`start.ps1` uses Node.js from PATH if installed; otherwise it downloads a portable copy into
`tools/node` on first run. Dependencies, the Electron binary and the model are also fetched on
first run, so nothing needs to be installed system-wide.

```powershell
.\start.ps1            # run the app (tray icon appears)
.\start.ps1 verbose    # run and log every inference result
.\start.ps1 selftest   # Phase 0 checks; writes selftest-results.json (screen flashes magenta twice)
.\start.ps1 test       # unit tests
```

## Controls

| Hotkey | Action |
| :-- | :-- |
| `Ctrl+Alt+B` | Toggle protection on/off |
| `Ctrl+Alt+W` | "This was wrong" - hide the overlay and suppress it for 10 s |
| `Ctrl+Alt+O` | Show/hide a test overlay |

Left-click the tray icon (or choose **Settings...**) to open the settings window, where a slider
sets the score (5-95%) at which the screen is blurred, with a live meter of the current score.
The blur hides again once the score drops below half that value. The setting is saved in
`%APPDATA%\screenblur\settings.json`.

The tray menu also has sensitivity presets (Strict 20% / Balanced 30% / Relaxed 45%), snooze
(5 / 15 / 60 min) and quit.

## Structure

```
src/
  main/                   Electron main process
    index.js              entry point (normal run or --selftest)
    config.js             all tunable settings and paths
    screenblur-app.js     orchestrates capture -> inference -> decision -> overlay
    decision-engine.js    asymmetric hysteresis + stale-result filter
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
    nudenet.js            NudeNet preprocessing and scoring
  renderer/
    capture/              hidden page: screen stream -> 320x320 frames
    overlay/              overlay page
    settings/             settings page
  shared/messages.js      message and IPC channel names
docs/RFC.md               design document
scripts/fetch-model.js    downloads and verifies the model
test/                     unit tests (node:test)
models/                   NudeNet 320n ONNX model (downloaded)
tools/                    say.ps1 (speech updates); portable Node.js is downloaded here
```

## POC limitations

- Primary display only.
- Full-screen overlay only (no per-region boxes yet).
- Windows only; macOS content protection is not yet verified.
- Thresholds are initial guesses for NudeNet's detector confidences and need tuning with real content.
- DRM-protected video captures as black and cannot be detected.
- The screen is scaled to 960x544 (on 16:9) for the model. Images shown smaller than ~250 px tall
  may be missed. Raise `modelInput.longSide` in `src/main/config.js` for more detail at more CPU cost.

## Diagnostics

Score an image file the way the app would see it on screen:

```powershell
.\node_modules\electron\dist\electron.exe scripts\score-image.js "C:\path\to\image.jpg" --screen 1920x1080
```
