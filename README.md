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



## Fortnite model currently supported

The inspected `weights-3.onnx` upload is a fixed-size **Ultralytics YOLO11n detection model** with one class: `enemy`.

Runtime contract:

- Input: `images` → `float32 [1,3,640,640]`
- Layout: NCHW
- Normalization: RGB / 255
- Output: `output0` → `float32 [1,300,6]`
- Output row: `[x1, y1, x2, y2, confidence, class_id]`
- Export-time NMS: enabled
- Class 0: `enemy`

Raven 1.1.1 detects this shape directly and skips a second JavaScript NMS pass. The model can be loaded from the **AI MODEL** tab using the local file picker. After a successful local load, Raven caches the model in IndexedDB as the primary Fortnite model so it can be reused on later sessions without selecting it again.

The model file itself is not committed into this repository. Its inspected metadata and SHA-256 fingerprint are recorded in `models/weights-3.meta.json`.

## Mobile performance profile

On iOS and Android, Raven automatically uses a lower-overhead profile:

- adaptive detector FPS cap based on available CPU/memory hints
- 1× overlay DPR instead of a high-DPI full-screen canvas
- skeleton/keypoint/RGB effects disabled by default
- viewport/orientation-aware full-screen menu sizing
- horizontal touch-friendly ImGui-style navigation
- right-side touch activation for camera/aim region
- separate touch gain and touch-assist strength controls
- local browser input remains the default; ESP32-S3 is optional

