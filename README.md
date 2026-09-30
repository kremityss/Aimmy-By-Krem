# Aimmy By Krem — Raven Edition

Cross-device xCloud vision/control userscript rebuilt for Krem. **No ESP32-S3 is required.** Browser/local input is the default path; RavenLink hardware is optional.

## Targets
- Windows / Chrome / Edge
- ChromeOS / Chromebook
- Android Chromium browsers with userscript support
- iPhone / iPad through a userscript-capable browser/extension path
- Desktop keyboard + mouse
- Touch
- Gamepad/controller telemetry
- Optional ESP32-S3 RavenLink bridge

## Runtime
The browser build runs inference locally on the device. It selects the fastest available TensorFlow.js backend in this order:

1. WebGPU
2. WebGL
3. CPU fallback

Default model: MoveNet Lightning for low-latency pose detection. A quality preset can switch to MoveNet Thunder.

## Raven UI
The old Aimmy UI is not used. Raven Edition has:
- Dashboard
- Aim
- Vision
- Visuals
- Input
- ESP32-S3
- Performance
- Device
- Settings

The HUD reports measured stream FPS, model FPS, inference latency, selected backend, device capabilities, and bridge state. If no ESP32 is connected, Raven continues on the local browser input adapter automatically.

## Files
- `RavenAimmy.user.js` — self-contained production userscript
- `esp32s3/RavenLink_ESP32S3.ino` — optional Wi-Fi bridge firmware
- `docs/ARCHITECTURE.md` — runtime design and platform limitations

## Upstream research
This rewrite was informed by the public `drixpyyy/aimmy.js` project (including the GPU, CPU, Pose, experimental, and latency variants). The Raven implementation is reorganized rather than copying its old UI/runtime wholesale.

## Important browser limitation
Synthetic JavaScript pointer/gamepad events are not equivalent to trusted physical input on every browser or cloud-game client. Raven therefore separates detection, target calculation, UI, and output adapters. On platforms where browser-generated input is restricted, use a supported physical/controller path or the optional ESP32-S3 bridge.

## Install
Install `RavenAimmy.user.js` in a userscript manager, open Xbox Cloud Gaming, and use **Alt + Shift + R** to toggle the Raven panel.

