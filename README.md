# ScreenBlur (POC)

Detects explicit content on screen and blurs only the areas where it appears; the rest of the
screen stays untouched. Everything runs locally; no frames leave the device. See
[docs/RFC.md](docs/RFC.md) (rev 2) for the original design.

## Install

Download the installer for your system from the
[Releases page](https://github.com/fisal1/ScreenBlur/releases). ScreenBlur runs in the system
tray / menu bar; left-click its icon for settings.

| System | File | Notes |
| :-- | :-- | :-- |
| Windows 10 2004+ / 11 (x64) | `ScreenBlur.Setup.x.y.z.exe` | Not code-signed: on "Windows protected your PC" choose **More info > Run anyway**. |
| macOS 12+ on Apple Silicon (M1 or later) | `ScreenBlur-x.y.z-arm64.dmg` | Not notarized: after copying to Applications, right-click the app > **Open** (or run `xattr -cr /Applications/ScreenBlur.app`). Allow **Screen Recording** when asked, then reopen ScreenBlur. Intel Macs are not supported (no ONNX Runtime build). |
| Linux x64 | `ScreenBlur-x.y.z.AppImage` or `screenblur_x.y.z_amd64.deb` | AppImage: `chmod +x` it and run. Needs a desktop with a compositor; on GNOME the tray icon needs the AppIndicator extension. On Wayland, the system asks which screen to share each time ScreenBlur starts. |

### Platform differences

| | Windows | macOS | Linux |
| :-- | :-- | :-- | :-- |
| GPU acceleration | DirectML (any GPU) | CoreML | CPU in the installers; CUDA when run from source with CUDA installed |
| Overlay hidden from its own capture | Yes (verified) | Unverified; assumed no | No |
| Tested on real hardware | Yes | Built and unit-tested in CI only | Built and unit-tested in CI only |

Where the overlay shows up in ScreenBlur's own capture (macOS, Linux), the detector can't see
content under a patch. Covered areas are then held until the scene changes or for up to 8 s,
after which the patch is briefly lifted to re-check. Run the self-test (below) on a Mac; if its
content-protection check passes, start ScreenBlur with `--overlay-hidden-from-capture`.

## Run from source

`start.ps1` (Windows) and `start.sh` (macOS, Linux) use Node.js from PATH if installed;
otherwise they download a portable copy into `tools/node` on first run. Dependencies, the
Electron binary and the model are also fetched on first run.

```powershell
.\start.ps1            # run the app (tray icon appears)
.\start.ps1 verbose    # run and log every inference result with the blurred areas
.\start.ps1 selftest   # Phase 0 checks; writes selftest-results.json (screen flashes magenta twice)
.\start.ps1 test       # unit tests
```

On macOS and Linux use `./start.sh` with the same arguments.

Test mode, safe to try without explicit content: faces are treated as targets and get blurred
(NudeNet only; the EraX models have no face class).

```powershell
.\node_modules\electron\dist\electron.exe . --detect-faces --verbose
```

Other flags: `--overlay-hidden-from-capture` / `--overlay-visible-to-capture` override the
platform assumption above (the latter also lets Windows imitate macOS/Linux for testing).
`--chromium-gpu` turns Chromium's GPU acceleration back on (off by default to save ~105 MB;
the model still uses the GPU through ONNX Runtime).

### Models and performance mode

Settings > Engine chooses the detection model and the performance mode (both restart the app):

| Model | Detects | Time per check, RTX 3050 / CPU (light mode) |
| :-- | :-- | :-- |
| NudeNet 320n (default) | exposed body parts | 19 ms / 37 ms |
| EraX nano | nipple, penis, vagina, anus, sexual activity | 16 ms / 36 ms |
| EraX small | same, more accurate | 25 ms / 93 ms |

| Mode | Device | Updates/s | Memory | CPU, video / still screen |
| :-- | :-- | :-- | :-- | :-- |
| Best (default) | GPU if available | ~27 | ~630-670 MB | ~7-8% / ~3-7% |
| Light | CPU only | ~14 | ~310-350 MB | ~13% / ~5-8% |

Measured on a Ryzen 7 4800H (16 threads) + RTX 3050 laptop; memory is private memory of all
processes. In Best mode ~230 MB of it is the GPU driver for DirectML. The fastest device is
measured once per model and remembered, so later starts load only that device.

### Comparing models on your own images

```powershell
.\node_modules\electron\dist\electron.exe scripts\compare-models.js "C:\path\to\images" --out "C:\path\to\results"
```

Runs every model on each image as the app would see it on a 1920x1080 screen (`--alone` scores
the image filling the model input instead) and prints each model's score, areas and speed, plus
a summary of how many images each model would blur at `--threshold` (default 30). With `--out`
it saves a side-by-side picture per image with each model's boxes, and `summary.csv`.
Everything stays on your computer. The EraX models are converted from PyTorch with
`uv run scripts/convert-erax.py` (already done; the converted files are downloaded by
`scripts/fetch-model.js`).

## Build installers

```powershell
npm run dist:win     # Windows installer (on Windows)
npm run dist:mac     # macOS .dmg (on a Mac)
npm run dist:linux   # Linux AppImage + .deb (on Linux)
```

Installers land in `dist/`. Each OS can only build its own installer, so
`.github/workflows/build.yml` builds all three on GitHub Actions for every push and publishes
them as a GitHub Release when a version tag (`v*`) is pushed. `build/icon.png` is generated by
`electron scripts/make-icon.js`.

## How it works

1. A hidden window captures the primary display at the model input size (960x544 on 16:9) and
   sends each new frame as soon as the capture stream delivers it (up to 30 fps). The model runs
   on the fastest device found at startup (GPU via DirectML, CoreML or CUDA, otherwise CPU).
2. The detection model (NudeNet or EraX, see Settings) finds explicit areas; overlapping boxes
   are merged and each box is padded by 20% so small movements don't expose its edges.
3. Each area is covered according to Settings > Cover style: the default GIF
   (`assets/patch.gif`), your own GIF or image, or a blur (a tiny averaged-color grid of what's
   underneath, drawn scaled up and blurred, so it can't be seen through). Images are cropped to
   fit and animated GIFs keep animating.
4. A transparent, click-through window that is excluded from screen capture draws the patches.
5. Areas are tracked individually: one appears when its score reaches the threshold, follows the
   content while its score stays above half the threshold, and disappears 1.5 s after it was last
   confirmed.
6. Each area's speed is estimated from successive detections. Between updates the overlay keeps
   moving the patch at 60 fps, and stretches it to cover both where the content was and where it
   is predicted to be, so moving video stays covered.

See "Models and performance mode" for measured speed, memory and CPU use.

## Controls

| Hotkey | Action |
| :-- | :-- |
| `Ctrl+Alt+B` | Toggle protection on/off |
| `Ctrl+Alt+W` | "This was wrong" - remove all blurred areas and block new ones for 10 s |
| `Ctrl+Alt+O` | Show/hide a test patch in the middle of the screen |

Left-click the tray icon (or choose **Settings...**) to open the settings window: a slider sets
the score (5-95%) at which an area is blurred, with a live meter of the highest score on screen,
Cover style chooses what covers detected areas (default GIF, your own GIF / PNG / JPG / WebP up
to 25 MB, or blur; applies immediately, with a "Preview on screen" button), and the Engine
section picks the model and performance mode. Settings are saved in
`%APPDATA%\ScreenBlur\settings.json`; a copy of your chosen image is kept in
`%APPDATA%\ScreenBlur\patches\`, so moving or deleting the original doesn't matter.

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
    settings-window.js    settings window (sensitivity, live score, engine)
    engine-profile.js     model + performance mode -> devices, input size, frame rate
    settings-store.js     saved settings (JSON in userData)
    patch-store.js        cover style: default GIF, the user's image (validated copy) or blur
    window-utils.js       guards against using windows Electron already destroyed
    hotkeys.js            global shortcuts
    self-test.js          Phase 0 checks
    platform.js           per-OS differences (GPU backends, overlay capture, permissions)
    permissions.js        macOS Screen Recording permission prompt
  inference/              utility process
    worker.js             receives frames, runs the model, reports results
    models.js             the detection models (files, classes, which classes to blur)
    yolo.js               YOLO preprocessing, box decoding and NMS
    regions.js            padding, screen-normalized boxes and blur mosaics
    backend-selector.js   picks the fastest execution provider (DirectML, CoreML, CUDA or CPU)
  renderer/
    capture/              hidden page: screen stream -> model input frames
    overlay/              overlay page: draws the blurred patches
    settings/             settings page
  shared/
    messages.js           message and IPC channel names
    geometry.js           box helpers (IoU, padding, clamping)
    motion.js             motion prediction shared by the tracker and the overlay
assets/patch.gif          GIF shown over detected areas
docs/RFC.md               design document
scripts/fetch-model.js    downloads and verifies the models
scripts/compare-models.js compares the models on your own images
scripts/convert-erax.py   converts the EraX PyTorch weights to ONNX (uv run)
scripts/after-pack.js     keeps only the packaged platform's ONNX Runtime binaries
scripts/make-icon.js      draws build/icon.png
build/icon.png            app icon (installers derive .ico/.icns from it)
.github/workflows/        CI: test + build installers on Windows, macOS, Linux; release on tags
test/                     unit tests (node:test)
models/                   ONNX models (downloaded)
LICENSE                   AGPL-3.0
THIRD_PARTY_NOTICES.md    licenses of the models, libraries and GIF
tools/                    say.ps1 (speech updates); portable Node.js is downloaded here
```

## POC limitations

- Primary display only.
- Only the Windows build has been run on real hardware. The macOS and Linux builds are compiled
  and unit-tested in CI but untested as apps (see "Platform differences").
- Installers are not code-signed or notarized, so each OS shows a warning on first launch.
- Fast motion: in a test with a face moving at 600 px/s inside a page, the face was fully covered
  about half the time and the median uncovered strip was 0 px, but 10% of the time up to ~50 px
  of the leading edge showed. Sudden direction changes are the hardest case.
- Content animated on its own GPU layer (e.g. CSS `will-change: transform`) may not produce new
  capture frames on some systems, so it is checked only 2 times per second. Normal `<video>`
  playback was captured at the full rate in testing.
- Without a usable GPU, or in light mode, the model runs on the CPU at ~14 updates/s.
- Model accuracy on real explicit content has not been measured by the developers; use
  `scripts/compare-models.js` on your own test images. In one test NudeNet flagged the app icon
  (a pink circle) as exposed buttocks at 40%; the EraX models scored it 5%.
- The detector finds body parts, so content without a clearly visible part may not be blurred.
- Thresholds need tuning with real content. The Strict 20% preset can blur innocent things
  (in testing, hair in a close-up portrait scored 20%).
- DRM-protected video captures as black and cannot be detected.
- Images shown smaller than ~250 px tall may be missed. Raise `modelInput.longSide` in
  `src/main/config.js` for more detail at more CPU cost.

## License

ScreenBlur is free software under the [GNU AGPL v3.0 or later](LICENSE): you can use, change and
share it, and anyone who distributes it (or runs a modified version as a network service) must
share their source code under the same license. The bundled models and libraries have their own
licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
