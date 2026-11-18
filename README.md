# MediaLab Downloader

برنامج تحميل لويندوز (Rust + Slint) مع إضافة للمتصفح.
A Windows download manager (Rust + Slint) with a browser extension.

## Build (GitHub Actions)
1. Push to `main` (or trigger `.github/workflows/build-windows.yml` manually via Actions).
2. Add the required repository secret `UPDATE_SIGNING_KEY` (64-character hex Ed25519 seed; generate with
   `cargo run -p swiftget-engine --example sign_update -- --generate-key`).
3. The workflow builds slim FFmpeg (with LAME & OpenH264), builds `MediaLabDownloader.exe` & `medialab-host.exe`,
   packages `MediaLab-Downloader-Setup.exe`, creates a signed `version.json`, and publishes both to GitHub Releases.

## Build locally
`BUILD.bat` (Windows) – see `build-windows.ps1`.

## Extension
`extension/` – Chrome/Edge: `chrome://extensions` > Developer mode > Load unpacked.
It talks to the MediaLab Downloader app (install the app first); `medialab-host.exe` is the native helper.

## Origin
Based on Ezoo Download by Ahmed Ezzat (Ezoo Tech), used and modified with the author's permission.
