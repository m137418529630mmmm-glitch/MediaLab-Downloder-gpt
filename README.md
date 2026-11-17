# MediaLab Downloader

برنامج تحميل لويندوز (Rust + Slint) مع إضافة للمتصفح.
A Windows download manager (Rust + Slint) with a browser extension.

## Build (GitHub Actions)
1. Put `.github/workflows/build.yml` and `MediaLab-Downloader-Source.zip` in the repository root and push.
2. The workflow builds ffmpeg, runs the tests and builds the app. Result: `MediaLab-Downloader-Setup.exe` (+ `version.json`) in Releases / Artifacts.
3. Optional secrets: `UPDATE_SIGNING_KEY` (signs updates; make one with
   `cargo run -p swiftget-engine --example sign_update -- --generate-key`), `AMO_JWT_ISSUER` / `AMO_JWT_SECRET` (Firefox signing).

## Build locally
`BUILD.bat` (Windows) – see `build-windows.ps1`.

## Extension
`extension/` – Chrome/Edge: `chrome://extensions` > Developer mode > Load unpacked.
It talks to the MediaLab Downloader app (install the app first); `medialab-host.exe` is the native helper.

## Origin
Based on Ezoo Download by Ahmed Ezzat (Ezoo Tech), used and modified with the author's permission.
