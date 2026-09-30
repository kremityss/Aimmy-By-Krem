# Raven Aimmy Architecture

## Design goal
Raven Edition separates capture/detection, target selection, presentation, and input output. This matters because xCloud runs in different browser environments and the same synthetic input path does not behave identically on iOS, Android, ChromeOS, and desktop browsers.

## Browser runtime
`RavenAimmy.user.js` is intentionally self-contained. It dynamically loads pinned TensorFlow.js assets and performs inference locally in the browser.

### Backend selection
1. WebGPU when registered and usable.
2. WebGL fallback.
3. CPU fallback.

The dashboard reports the backend that TensorFlow.js actually selected.

### Models
- MoveNet Lightning: default low-latency profile.
- MoveNet Thunder: higher-cost quality profile.

The current build uses single-pose inference because the xCloud crosshair workflow benefits more from low latency than multiple concurrent pose candidates. The runtime is structured so a multi-pose detector can be added later without replacing the UI/input stack.

## Scheduler
The detector is guarded against overlapping inference. Measured inference latency is fed into an adaptive interval so slower devices back off rather than building a queue of stale frames. Faster devices can run without an artificial interval.

## Inputs
Raven has an input router instead of one hard-coded mouse simulator. The browser pointer adapter is the default and does not require external hardware.

- Browser pointer adapter
- Touch activation on the right-hand camera region
- Gamepad trigger activation through Gamepad API
- ESP32-S3 WebSocket output adapter (optional)

Browser-dispatched events are synthetic. Some sites/browsers ignore or treat them differently from trusted hardware input. Raven still starts and operates without ESP32 hardware; if an ESP32 adapter is selected but unavailable, the runtime falls back to the browser pointer adapter. The ESP32-S3 route only exists for setups that specifically want a physical USB HID endpoint.

## ESP32-S3
`esp32s3/RavenLink_ESP32S3.ino` starts a Wi-Fi AP named `RavenLink-S3`, a WebSocket server on port `7878`, and a native USB HID mouse.

Default network:
- SSID: `RavenLink-S3`
- Password: `ravenengine`
- Expected AP IP: usually `192.168.4.1`
- Raven URL: `ws://192.168.4.1:7878/ws`

Dependencies:
- Arduino-ESP32 core for ESP32-S3
- `arduinoWebSockets` / `WebSocketsServer.h`
- Native ESP32-S3 USB support

The firmware clamps each motion packet to the signed HID range and stops output after 250 ms without a fresh active packet.

## Platform notes
### Windows / ChromeOS
Best browser path when WebGPU is available. Gamepad API and pointer events are normally present in Chromium.

### Android
WebGPU/WebGL capability varies by browser/GPU. Touch activation is supported. Userscript injection requires a browser/userscript environment that allows page scripts.

### iPhone / iPad
The userscript can provide UI, local inference, and network communication when the chosen browser/extension allows injection. Browser security restrictions can prevent JavaScript-generated pointer events from acting like trusted camera input. The ESP32-S3 network + USB HID path is the intended hardware-assisted output route when direct browser input is insufficient.

## Upstream
The public `drixpyyy/aimmy.js` repository was inspected for feature ideas including CPU/GPU variants, MoveNet pose use, controller handling, overlays, and xCloud latency tuning. Its repository did not declare a license when Raven Edition was created, so this repository uses a new implementation rather than copying the upstream files wholesale.
