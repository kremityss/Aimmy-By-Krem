// ==UserScript==
// @name         Aimmy By Krem — Raven Edition
// @namespace    https://github.com/kremityss/Aimmy-By-Krem
// @version      1.0.0
// @description  Raven-branded local vision/control dashboard for Xbox Cloud Gaming with desktop, touch, controller, and ESP32-S3 adapters.
// @author       Kremityss
// @match        https://www.xbox.com/*/play/*
// @match        https://www.xbox.com/play/*
// @match        https://xbox.com/*/play/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const BUILD = '1.0.0';
  const NS = '__RAVEN_AIMMY__';
  if (window[NS]?.destroy) window[NS].destroy();

  const CDN = {
    tf: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
    webgpu: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgpu@4.22.0/dist/tf-backend-webgpu.min.js',
    pose: 'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js'
  };

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const now = () => performance.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = (q, root = document) => root.querySelector(q);
  const $$ = (q, root = document) => [...root.querySelectorAll(q)];

  class RingAverage {
    constructor(size = 30) { this.size = size; this.values = []; }
    push(v) { this.values.push(v); if (this.values.length > this.size) this.values.shift(); }
    get value() { return this.values.length ? this.values.reduce((a,b)=>a+b,0) / this.values.length : 0; }
    clear() { this.values.length = 0; }
  }

  class RavenStore {
    constructor() {
      this.key = 'ravenAimmy.v1';
      this.defaults = {
        ui: { open: true, scale: 1, opacity: .96, compactHud: true },
        aim: {
          enabled: false,
          activation: 'hold',
          activationKey: 'MouseRight',
          controllerButton: 6,
          touchHold: true,
          fov: 165,
          smoothing: 0.38,
          maxStep: 34,
          deadzone: 2.5,
          target: 'head',
          headOffset: 0,
          predictionMs: 35,
          priority: 'crosshair',
          stickyMs: 180
        },
        vision: {
          enabled: true,
          model: 'lightning',
          backend: 'auto',
          minScore: .24,
          keypointScore: .22,
          intervalMs: 0,
          maxPoses: 1,
          crop: 'video',
          adaptive: true,
          targetFps: 45
        },
        visuals: {
          enabled: true,
          boxes: true,
          skeleton: true,
          tracers: false,
          keypoints: false,
          fov: true,
          targetLine: true,
          rgb: true,
          lineWidth: 1.5,
          hud: true
        },
        input: {
          adapter: 'auto',
          mouseGain: 1,
          controllerGain: 1,
          touchGain: 1,
          invertY: false
        },
        esp32: {
          enabled: false,
          url: 'ws://192.168.4.1:7878/ws',
          reconnect: true,
          sendHz: 120,
          mode: 'delta'
        },
        perf: {
          highPerformance: true,
          suspendWhenHidden: true,
          overlayFps: 60,
          renderEveryDetection: false,
          preferLowPower: false
        }
      };
      this.data = this.load();
    }
    load() {
      try { return this.merge(structuredClone(this.defaults), JSON.parse(localStorage.getItem(this.key) || '{}')); }
      catch { return structuredClone(this.defaults); }
    }
    merge(base, patch) {
      for (const [k,v] of Object.entries(patch || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v) && base[k]) this.merge(base[k], v);
        else base[k] = v;
      }
      return base;
    }
    save() { localStorage.setItem(this.key, JSON.stringify(this.data)); }
    reset() { this.data = structuredClone(this.defaults); this.save(); }
  }

  class DeviceProfile {
    static async detect() {
      const ua = navigator.userAgent;
      const platform = navigator.userAgentData?.platform || navigator.platform || 'Unknown';
      const mobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod/i.test(ua);
      const ios = /iPhone|iPad|iPod/i.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const android = /Android/i.test(ua);
      const chromeOS = /CrOS/i.test(ua);
      const windows = /Windows/i.test(ua);
      const touch = navigator.maxTouchPoints > 0;
      const memory = navigator.deviceMemory || null;
      const cores = navigator.hardwareConcurrency || null;
      const screenInfo = `${screen.width}×${screen.height} @${window.devicePixelRatio.toFixed(2)}x`;
      const gpu = await DeviceProfile.gpuName();
      return {
        ua, platform, mobile, ios, android, chromeOS, windows, touch, memory, cores, gpu,
        screenInfo,
        webgpu: !!navigator.gpu,
        gamepad: 'getGamepads' in navigator,
        pointer: 'PointerEvent' in window,
        offscreen: 'OffscreenCanvas' in window,
        rvfc: 'requestVideoFrameCallback' in HTMLVideoElement.prototype,
        ws: 'WebSocket' in window,
        label: ios ? 'iOS/iPadOS' : android ? 'Android' : chromeOS ? 'ChromeOS' : windows ? 'Windows' : platform
      };
    }
    static async gpuName() {
      try {
        if (!navigator.gpu) return 'WebGPU unavailable';
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) return 'No WebGPU adapter';
        const info = adapter.info || {};
        return info.description || info.device || info.vendor || 'WebGPU GPU';
      } catch { return 'GPU unavailable'; }
    }
  }

  class LibraryLoader {
    constructor(log) { this.log = log; }
    loadScript(src, test) {
      if (test?.()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const found = [...document.scripts].find(s => s.src === src);
        if (found) {
          const timer = setInterval(() => { if (test?.()) { clearInterval(timer); resolve(); } }, 50);
          setTimeout(() => { clearInterval(timer); test?.() ? resolve() : reject(new Error(`Timeout: ${src}`)); }, 15000);
          return;
        }
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
      });
    }
    async ensure() {
      this.log('Loading TensorFlow.js');
      await this.loadScript(CDN.tf, () => !!window.tf);
      try { await this.loadScript(CDN.webgpu, () => !!window.tf?.findBackend?.('webgpu')); } catch {}
      await this.loadScript(CDN.pose, () => !!window.poseDetection);
      this.log('Vision libraries ready');
    }
  }

  class VideoLocator {
    constructor() { this.video = null; this.rect = null; }
    find() {
      const candidates = $$('video').filter(v => v.videoWidth > 0 && v.videoHeight > 0 && v.getBoundingClientRect().width > 200);
      this.video = candidates.sort((a,b) => (b.getBoundingClientRect().width*b.getBoundingClientRect().height) - (a.getBoundingClientRect().width*a.getBoundingClientRect().height))[0] || null;
      this.rect = this.video?.getBoundingClientRect() || null;
      return this.video;
    }
    updateRect() { if (this.video) this.rect = this.video.getBoundingClientRect(); return this.rect; }
  }

  class VisionRuntime {
    constructor(app) {
      this.app = app;
      this.detector = null;
      this.backend = 'none';
      this.modelName = 'none';
      this.busy = false;
      this.lastRun = 0;
      this.lastPose = null;
      this.lastBox = null;
      this.inferAvg = new RingAverage(24);
      this.fpsAvg = new RingAverage(24);
      this.lastFinish = 0;
      this.frameCounter = 0;
    }
    async configureBackend() {
      const tf = window.tf;
      const pref = this.app.store.data.vision.backend;
      const order = pref === 'auto' ? ['webgpu','webgl','cpu'] : [pref, 'webgl', 'cpu'];
      for (const b of [...new Set(order)]) {
        try {
          if (!tf.findBackend(b) && b !== 'cpu') continue;
          if (await tf.setBackend(b)) {
            await tf.ready();
            this.backend = tf.getBackend();
            if (this.backend === 'webgl') {
              try { tf.env().set('WEBGL_PACK', true); } catch {}
              try { tf.env().set('WEBGL_FORCE_F16_TEXTURES', true); } catch {}
            }
            return;
          }
        } catch (e) { this.app.log(`Backend ${b} failed: ${e.message}`); }
      }
      throw new Error('No TensorFlow.js backend available');
    }
    async loadModel(force = false) {
      if (this.detector && !force) return;
      if (this.detector?.dispose) this.detector.dispose();
      this.detector = null;
      await this.configureBackend();
      const cfg = this.app.store.data.vision;
      const modelType = cfg.model === 'thunder'
        ? poseDetection.movenet.modelType.SINGLEPOSE_THUNDER
        : poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING;
      const options = { modelType, enableSmoothing: false, minPoseScore: cfg.minScore };
      this.detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, options);
      this.modelName = cfg.model === 'thunder' ? 'MoveNet Thunder' : 'MoveNet Lightning';
      this.inferAvg.clear(); this.fpsAvg.clear();
      this.app.toast(`${this.modelName} • ${this.backend.toUpperCase()}`);
    }
    async run(video) {
      const cfg = this.app.store.data.vision;
      if (!cfg.enabled || this.busy || !this.detector || !video) return null;
      const t = now();
      if (cfg.intervalMs > 0 && t - this.lastRun < cfg.intervalMs) return null;
      if (document.hidden && this.app.store.data.perf.suspendWhenHidden) return null;
      this.lastRun = t;
      this.busy = true;
      const start = now();
      try {
        const poses = await this.detector.estimatePoses(video, { maxPoses: cfg.maxPoses, flipHorizontal: false });
        const elapsed = now() - start;
        this.inferAvg.push(elapsed);
        if (this.lastFinish) this.fpsAvg.push(1000 / Math.max(1, now() - this.lastFinish));
        this.lastFinish = now();
        const pose = poses?.[0] || null;
        this.lastPose = pose;
        this.lastBox = pose ? this.boxFromPose(pose) : null;
        this.adapt(elapsed);
        return pose;
      } catch (e) {
        this.app.log(`Inference error: ${e.message}`);
        return null;
      } finally { this.busy = false; }
    }
    adapt(ms) {
      const cfg = this.app.store.data.vision;
      if (!cfg.adaptive) return;
      const targetMs = 1000 / clamp(cfg.targetFps, 10, 120);
      if (ms > targetMs * 1.6 && cfg.intervalMs < 50) cfg.intervalMs = Math.min(50, cfg.intervalMs + 2);
      else if (ms < targetMs * .75 && cfg.intervalMs > 0) cfg.intervalMs = Math.max(0, cfg.intervalMs - 1);
    }
    boxFromPose(pose) {
      const k = pose.keypoints?.filter(p => (p.score ?? 0) >= this.app.store.data.vision.keypointScore) || [];
      if (!k.length) return null;
      const xs = k.map(p=>p.x), ys = k.map(p=>p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs)-Math.min(...xs), h: Math.max(...ys)-Math.min(...ys) };
    }
    targetPoint(pose) {
      if (!pose?.keypoints?.length) return null;
      const map = Object.fromEntries(pose.keypoints.map(k => [k.name, k]));
      const min = this.app.store.data.vision.keypointScore;
      const valid = k => k && (k.score ?? 0) >= min;
      const aim = this.app.store.data.aim;
      let p = null;
      if (aim.target === 'head') {
        p = valid(map.nose) ? map.nose : valid(map.left_eye) ? map.left_eye : map.right_eye;
      } else if (aim.target === 'chest') {
        const a = map.left_shoulder, b = map.right_shoulder;
        if (valid(a) && valid(b)) p = { x:(a.x+b.x)/2, y:(a.y+b.y)/2, score:Math.min(a.score,b.score) };
      } else if (aim.target === 'hip') {
        const a = map.left_hip, b = map.right_hip;
        if (valid(a) && valid(b)) p = { x:(a.x+b.x)/2, y:(a.y+b.y)/2, score:Math.min(a.score,b.score) };
      }
      if (!p) return null;
      return { x:p.x, y:p.y + aim.headOffset, score:p.score ?? 1 };
    }
    get inferenceMs() { return this.inferAvg.value; }
    get modelFps() { return this.fpsAvg.value; }
  }

  class StreamMetrics {
    constructor(app) {
      this.app = app; this.streamFps = 0; this.renderFps = 0; this.frame = 0; this.last = now(); this.lastVideoTime = 0;
      this._raf = 0; this._videoCallback = 0;
    }
    start(video) {
      this.stop();
      const renderLoop = t => {
        this.frame++;
        if (t - this.last >= 1000) { this.renderFps = this.frame * 1000 / (t-this.last); this.frame=0; this.last=t; }
        this._raf = requestAnimationFrame(renderLoop);
      };
      this._raf = requestAnimationFrame(renderLoop);
      if (video?.requestVideoFrameCallback) {
        let vf=0, start=now();
        const tick = () => {
          vf++;
          const t = now();
          if (t-start >= 1000) { this.streamFps = vf*1000/(t-start); vf=0; start=t; }
          if (this.app.running && this.app.locator.video === video) this._videoCallback = video.requestVideoFrameCallback(tick);
        };
        this._videoCallback = video.requestVideoFrameCallback(tick);
      }
    }
    stop() {
      if (this._raf) cancelAnimationFrame(this._raf);
      const v = this.app.locator.video;
      if (this._videoCallback && v?.cancelVideoFrameCallback) try { v.cancelVideoFrameCallback(this._videoCallback); } catch {}
    }
  }
