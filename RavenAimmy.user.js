// ==UserScript==
// @name         Aimmy By Krem — Raven Edition
// @namespace    https://github.com/kremityss/Aimmy-By-Krem
// @version      1.0.1
// @description  Raven-branded local vision/control dashboard for Xbox Cloud Gaming with desktop, touch, controller, and optional ESP32-S3 support.
// @author       Kremityss
// @match        https://www.xbox.com/*/play/*
// @match        https://www.xbox.com/play/*
// @match        https://xbox.com/*/play/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const BUILD = '1.0.1';
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
          adapter: 'pointer',
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
      this.prevAimPoint = null;
      this.prevAimAt = 0;
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
      const point = { x:p.x, y:p.y + aim.headOffset, score:p.score ?? 1 };
      const t = now();
      const dt = t - this.prevAimAt;
      if (this.prevAimPoint && dt > 0 && dt < 250 && aim.predictionMs > 0) {
        const vx = (point.x - this.prevAimPoint.x) / dt;
        const vy = (point.y - this.prevAimPoint.y) / dt;
        point.x += vx * aim.predictionMs;
        point.y += vy * aim.predictionMs;
      }
      this.prevAimPoint = { x:p.x, y:p.y + aim.headOffset };
      this.prevAimAt = t;
      return point;
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

  class ActivationState {
    constructor(app) {
      this.app = app; this.mouseRight = false; this.touchAim = false; this.toggle = false; this.gpAim = false;
      this.down = e => {
        if (e.button === 2) this.mouseRight = true;
        if (e.code === 'AltLeft' || e.code === 'AltRight') this.alt = true;
        if (e.shiftKey && e.altKey && e.code === 'KeyR') { e.preventDefault(); app.ui.toggle(); }
        if (e.code === 'F8') { e.preventDefault(); this.toggle = !this.toggle; app.toast(`Aim ${this.toggle?'armed':'disarmed'}`); }
      };
      this.up = e => { if (e.button === 2) this.mouseRight = false; };
      window.addEventListener('pointerdown', this.down, true);
      window.addEventListener('pointerup', this.up, true);
      window.addEventListener('keydown', this.down, true);
      window.addEventListener('keyup', this.up, true);
    }
    source() {
      if (this.gpAim) return 'controller';
      if (this.touchAim) return 'touch';
      return 'mouse';
    }
    active() {
      const c = this.app.store.data.aim;
      if (!c.enabled) return false;
      if (c.activation === 'always') return true;
      if (c.activation === 'toggle') return this.toggle;
      return this.mouseRight || this.touchAim || this.gpAim;
    }
    destroy() {
      window.removeEventListener('pointerdown', this.down, true); window.removeEventListener('pointerup', this.up, true);
      window.removeEventListener('keydown', this.down, true); window.removeEventListener('keyup', this.up, true);
    }
  }

  class InputRouter {
    constructor(app) {
      this.app = app;
      this.lastTarget = null;
      this.smoothed = {x:0,y:0};
      this.lastSend = 0;
      this.gamepadLoop = 0;
      this.touchStart = null;
      this.bindTouch();
      this.pollGamepad();
    }
    bindTouch() {
      const onStart = e => {
        if (!this.app.device.touch || this.app.ui.containsEvent(e)) return;
        const t = e.touches?.[0]; if (!t) return;
        const rect = this.app.locator.updateRect(); if (!rect) return;
        if (t.clientX > rect.left + rect.width * .48) {
          this.touchStart = { x:t.clientX, y:t.clientY };
          if (this.app.store.data.aim.touchHold) this.app.activation.touchAim = true;
        }
      };
      const onEnd = () => { this.touchStart = null; this.app.activation.touchAim = false; };
      window.addEventListener('touchstart', onStart, {capture:true,passive:true});
      window.addEventListener('touchend', onEnd, {capture:true,passive:true});
      window.addEventListener('touchcancel', onEnd, {capture:true,passive:true});
      this._touchHandlers = [onStart,onEnd];
    }
    pollGamepad() {
      const loop = () => {
        const pads = navigator.getGamepads?.() || [];
        const gp = [...pads].find(Boolean);
        if (gp) {
          const idx = this.app.store.data.aim.controllerButton;
          this.app.activation.gpAim = !!gp.buttons?.[idx]?.pressed;
          this.app.controllerName = gp.id || 'Gamepad';
        } else {
          this.app.activation.gpAim = false; this.app.controllerName = 'None';
        }
        if (this.app.running) this.gamepadLoop = requestAnimationFrame(loop);
      };
      this.gamepadLoop = requestAnimationFrame(loop);
    }
    mapTarget(point) {
      const video = this.app.locator.video, rect = this.app.locator.updateRect();
      if (!video || !rect || !point) return null;
      const sx = rect.width / video.videoWidth;
      const sy = rect.height / video.videoHeight;
      return { x: rect.left + point.x * sx, y: rect.top + point.y * sy };
    }
    async apply(point) {
      if (!point || !this.app.activation.active()) return;
      const rect = this.app.locator.updateRect(); if (!rect) return;
      const target = this.mapTarget(point); if (!target) return;
      const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
      let dx = target.x-cx, dy = target.y-cy;
      const inputCfg = this.app.store.data.input;
      const source = this.app.activation.source();
      const gain = source === 'controller' ? inputCfg.controllerGain : source === 'touch' ? inputCfg.touchGain : inputCfg.mouseGain;
      dx *= gain; dy *= gain;
      const dist = Math.hypot(dx,dy);
      const cfg = this.app.store.data.aim;
      if (dist > cfg.fov || dist < cfg.deadzone) return;
      const scale = clamp(cfg.smoothing, .01, 1);
      dx = clamp(dx*scale, -cfg.maxStep, cfg.maxStep);
      dy = clamp(dy*scale, -cfg.maxStep, cfg.maxStep);
      if (this.app.store.data.input.invertY) dy = -dy;
      this.smoothed.x = lerp(this.smoothed.x, dx, .6);
      this.smoothed.y = lerp(this.smoothed.y, dy, .6);
      const adapter = this.resolveAdapter();
      if (adapter === 'esp32') this.app.bridge.sendAim(this.smoothed.x, this.smoothed.y, this.app.activation.active());
      else if (adapter === 'pointer') this.pointerDelta(this.smoothed.x, this.smoothed.y);
    }
    resolveAdapter() {
      const selected = this.app.store.data.input.adapter;

      // Browser/local input is always the safe fallback. ESP32 is an optional
      // accelerator/output bridge and must never be required for Raven to run.
      if (selected === 'esp32') {
        return this.app.store.data.esp32.enabled && this.app.bridge.connected
          ? 'esp32'
          : 'pointer';
      }

      if (selected === 'auto') {
        return this.app.store.data.esp32.enabled && this.app.bridge.connected
          ? 'esp32'
          : 'pointer';
      }

      return 'pointer';
    }
    pointerDelta(dx,dy) {
      const video = this.app.locator.video;
      const el = document.pointerLockElement || $('#game-stream') || video;
      if (!el) return;
      const rect = video.getBoundingClientRect();
      const evt = new PointerEvent('pointermove', {
        bubbles:true, cancelable:true, pointerType:'mouse', isPrimary:true,
        clientX: rect.left+rect.width/2+dx,
        clientY: rect.top+rect.height/2+dy,
        movementX: Math.round(dx),
        movementY: Math.round(dy)
      });
      el.dispatchEvent(evt);
    }
    destroy() {
      cancelAnimationFrame(this.gamepadLoop);
      if (this._touchHandlers) {
        window.removeEventListener('touchstart', this._touchHandlers[0], true);
        window.removeEventListener('touchend', this._touchHandlers[1], true);
        window.removeEventListener('touchcancel', this._touchHandlers[1], true);
      }
    }
  }

  class RavenBridge {
    constructor(app) { this.app=app; this.ws=null; this.connected=false; this.latency=null; this.lastPing=0; this.seq=0; this.lastAim=0; this.reconnectTimer=0; this.generation=0; }
    connect() {
      this.disconnect();
      const generation = ++this.generation;
      if (!this.app.store.data.esp32.enabled) return;
      try {
        const ws = new WebSocket(this.app.store.data.esp32.url);
        this.ws = ws;
        ws.onopen = () => { this.connected=true; this.app.toast('ESP32-S3 connected'); this.ping(); this.app.ui.renderStatus(); };
        ws.onmessage = e => {
          try {
            const m=JSON.parse(e.data);
            if (m.type==='pong' && m.t) this.latency = now()-m.t;
          } catch {}
        };
        ws.onclose = () => { if (generation !== this.generation) return; this.connected=false; this.app.ui.renderStatus(); if (this.app.running && this.app.store.data.esp32.reconnect) this.reconnectTimer=setTimeout(()=>this.connect(),1800); };
        ws.onerror = () => { this.connected=false; };
      } catch(e) { this.app.log(`ESP32 bridge: ${e.message}`); }
    }
    disconnect() {
      clearTimeout(this.reconnectTimer);
      this.generation++;
      try { this.ws?.close(); } catch {}
      this.ws=null; this.connected=false;
    }
    send(obj) { if (this.connected && this.ws?.readyState===WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
    ping() { const t=now(); this.lastPing=t; this.send({type:'ping',t}); }
    sendAim(dx,dy,active) {
      const hz=clamp(this.app.store.data.esp32.sendHz,20,240), t=now();
      if (t-this.lastAim < 1000/hz) return; this.lastAim=t;
      this.send({type:'aim',seq:++this.seq,dx:Math.round(dx),dy:Math.round(dy),active:!!active,t});
    }
  }

  class Overlay {
    constructor(app) {
      this.app=app;
      this.canvas=document.createElement('canvas');
      Object.assign(this.canvas.style,{position:'fixed',inset:'0',width:'100vw',height:'100vh',zIndex:'2147483000',pointerEvents:'none'});
      this.ctx=this.canvas.getContext('2d');
      document.documentElement.appendChild(this.canvas);
      this.resize=()=>{ const dpr=Math.min(devicePixelRatio||1,2); this.canvas.width=innerWidth*dpr; this.canvas.height=innerHeight*dpr; this.canvas.style.width=innerWidth+'px'; this.canvas.style.height=innerHeight+'px'; this.ctx.setTransform(dpr,0,0,dpr,0,0); };
      this.resize(); addEventListener('resize',this.resize);
    }
    draw() {
      const c=this.ctx, cfg=this.app.store.data.visuals; c.clearRect(0,0,innerWidth,innerHeight);
      if (!cfg.enabled) return;
      const rect=this.app.locator.updateRect(); if (!rect) return;
      const hue=(now()/18)%360; const accent=cfg.rgb?`hsl(${hue} 100% 60%)`:'#ff263b';
      const center={x:rect.left+rect.width/2,y:rect.top+rect.height/2};
      c.lineWidth=cfg.lineWidth; c.strokeStyle=accent; c.fillStyle=accent;
      if (cfg.fov) { c.globalAlpha=.65; c.beginPath(); c.arc(center.x,center.y,this.app.store.data.aim.fov,0,Math.PI*2); c.stroke(); c.globalAlpha=1; }
      const pose=this.app.vision.lastPose; if (!pose) return;
      const kp=pose.keypoints||[], min=this.app.store.data.vision.keypointScore;
      const map=Object.fromEntries(kp.map(k=>[k.name,k]));
      const project=p=>({x:rect.left+(p.x/this.app.locator.video.videoWidth)*rect.width,y:rect.top+(p.y/this.app.locator.video.videoHeight)*rect.height});
      const valid=p=>p&&(p.score??0)>=min;
      if (cfg.skeleton) {
        const bones=[['left_shoulder','right_shoulder'],['left_shoulder','left_elbow'],['left_elbow','left_wrist'],['right_shoulder','right_elbow'],['right_elbow','right_wrist'],['left_shoulder','left_hip'],['right_shoulder','right_hip'],['left_hip','right_hip'],['left_hip','left_knee'],['left_knee','left_ankle'],['right_hip','right_knee'],['right_knee','right_ankle']];
        c.globalAlpha=.9;
        for (const [a,b] of bones) if(valid(map[a])&&valid(map[b])) { const A=project(map[a]),B=project(map[b]); c.beginPath(); c.moveTo(A.x,A.y);c.lineTo(B.x,B.y);c.stroke(); }
        c.globalAlpha=1;
      }
      if (cfg.keypoints) for(const p of kp) if(valid(p)){const P=project(p);c.beginPath();c.arc(P.x,P.y,2.5,0,Math.PI*2);c.fill();}
      if (cfg.boxes && this.app.vision.lastBox) {
        const b=this.app.vision.lastBox, A=project({x:b.x,y:b.y}), B=project({x:b.x+b.w,y:b.y+b.h});
        const x=A.x,y=A.y,w=B.x-A.x,h=B.y-A.y,L=Math.min(18,Math.min(w,h)*.22);
        c.beginPath();
        c.moveTo(x+L,y);c.lineTo(x,y);c.lineTo(x,y+L); c.moveTo(x+w-L,y);c.lineTo(x+w,y);c.lineTo(x+w,y+L);
        c.moveTo(x,y+h-L);c.lineTo(x,y+h);c.lineTo(x+L,y+h); c.moveTo(x+w-L,y+h);c.lineTo(x+w,y+h);c.lineTo(x+w,y+h-L); c.stroke();
      }
      const tp=this.app.vision.targetPoint(pose), target=tp?this.app.input.mapTarget(tp):null;
      if (target && cfg.targetLine && this.app.activation.active()) { c.globalAlpha=.75;c.beginPath();c.moveTo(center.x,center.y);c.lineTo(target.x,target.y);c.stroke();c.globalAlpha=1; }
    }
    destroy(){ removeEventListener('resize',this.resize); this.canvas.remove(); }
  }

  class RavenUI {
    constructor(app) { this.app=app; this.host=null; this.shadow=null; this.panel=null; this.activeTab='Dashboard'; this.statusTimer=0; this.build(); }
    containsEvent(e){ return !!(this.host && e.composedPath?.().includes(this.host)); }
    toggle(){ this.app.store.data.ui.open=!this.app.store.data.ui.open; this.app.store.save(); this.panel.style.display=this.app.store.data.ui.open?'flex':'none'; }
    build(){
      this.host=document.createElement('div'); this.host.id='raven-aimmy-root'; this.host.style.position='fixed'; this.host.style.zIndex='2147483646'; this.host.style.left='0'; this.host.style.top='0';
      this.shadow=this.host.attachShadow({mode:'open'}); document.documentElement.appendChild(this.host);
      this.shadow.innerHTML=`<style>${this.css()}</style><button class="orb" title="Raven" aria-label="Toggle Raven">R</button><section class="panel"><aside><div class="brand"><b>RAVEN</b><span>AIMMY • KREM</span></div><nav></nav><div class="sidefoot"><span class="dot"></span><span class="bridge-state">LOCAL</span><small>v${BUILD}</small></div></aside><main><header><div><h1>RAVEN ENGINE</h1><p>LOCAL VISION CONTROL CORE</p></div><div class="header-actions"><span class="chip backend">BOOT</span><button class="min">—</button></div></header><div class="content"></div></main></section><div class="toast"></div>`;
      this.panel=this.shadow.querySelector('.panel'); this.panel.style.display=this.app.store.data.ui.open?'flex':'none';
      this.shadow.querySelector('.orb').onclick=()=>this.toggle(); this.shadow.querySelector('.min').onclick=()=>this.toggle();
      const tabs=['Dashboard','Aim','Vision','Visuals','Input','ESP32-S3','Performance','Device','Settings'];
      const nav=this.shadow.querySelector('nav');
      const short=['HOME','AIM','AI','VIS','IN','S3','FPS','DEV','SET'];
      tabs.forEach((t,i)=>{const b=document.createElement('button');b.textContent=t;b.dataset.short=short[i];b.className=i===0?'active':'';b.onclick=()=>{this.activeTab=t;$$('nav button',this.shadow).forEach(x=>x.classList.toggle('active',x===b));this.render();};nav.appendChild(b);});
      this.drag(); this.render();
      this.statusTimer=setInterval(()=>this.renderStatus(),500);
    }
    css(){return `:host{all:initial;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f5f7fb;--bg:#090a0d;--panel:#111319;--panel2:#171a21;--line:#262a34;--muted:#858b99;--red:#f3263e;--red2:#a80f24}.orb{position:fixed;right:14px;top:42%;width:46px;height:46px;border-radius:15px;border:1px solid #ffffff1b;background:linear-gradient(145deg,#241117,#090a0d);color:#fff;font-weight:950;box-shadow:0 14px 40px #0009,0 0 26px #f3263e33;backdrop-filter:blur(16px)}.panel{position:fixed;left:24px;top:70px;width:min(860px,calc(100vw - 36px));height:min(600px,calc(100vh - 110px));display:flex;background:#090a0df2;border:1px solid #ffffff12;border-radius:22px;overflow:hidden;box-shadow:0 32px 90px #000b,0 0 0 1px #000;backdrop-filter:blur(24px);transform:scale(var(--scale,1));transform-origin:top left}.panel aside{width:176px;background:linear-gradient(180deg,#15171d,#0b0c10);border-right:1px solid var(--line);display:flex;flex-direction:column}.brand{padding:22px 18px 18px;border-bottom:1px solid var(--line)}.brand b{display:block;font-size:25px;letter-spacing:4px}.brand span{font-size:9px;letter-spacing:2px;color:#9a9fac}.panel nav{padding:10px;display:grid;gap:5px}.panel nav button{border:0;background:transparent;color:#8c92a0;text-align:left;padding:11px 12px;border-radius:10px;font-weight:750;font-size:12px;letter-spacing:.3px}.panel nav button.active,.panel nav button:hover{background:linear-gradient(90deg,#f3263e20,transparent);color:#fff;box-shadow:inset 2px 0 var(--red)}.sidefoot{margin-top:auto;padding:16px;display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;color:#737987;font-size:10px;border-top:1px solid var(--line)}.dot{width:7px;height:7px;background:#4cff7a;border-radius:50%;box-shadow:0 0 10px #4cff7a88}main{flex:1;min-width:0;display:flex;flex-direction:column}header{height:72px;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 22px;justify-content:space-between;cursor:move}header h1{font-size:14px;letter-spacing:2.8px;margin:0}header p{margin:4px 0 0;color:var(--muted);font-size:9px;letter-spacing:1.5px}.header-actions{display:flex;gap:9px;align-items:center}.chip{padding:7px 9px;border-radius:8px;background:#ffffff09;border:1px solid #ffffff0f;color:#a9afbb;font-size:9px;font-weight:800}.min{border:1px solid #ffffff12;background:#ffffff08;color:#fff;border-radius:8px;width:30px;height:30px}.content{padding:18px;overflow:auto;flex:1;background:radial-gradient(circle at 90% 0%,#f3263e0e,transparent 35%)}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}.card{grid-column:span 6;background:linear-gradient(180deg,#151820,#111319);border:1px solid #ffffff0d;border-radius:16px;padding:15px;box-shadow:0 12px 32px #0004}.card.full{grid-column:1/-1}.card.third{grid-column:span 4}.card h3{margin:0 0 12px;font-size:10px;letter-spacing:1.4px;color:#8f96a5}.metric{font-size:26px;font-weight:850;letter-spacing:-1px}.muted{color:var(--muted);font-size:11px;line-height:1.5}.row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0}.row label{font-size:12px;font-weight:650}.toggle{appearance:none;width:42px;height:23px;border-radius:20px;background:#2a2e38;position:relative;transition:.18s}.toggle:after{content:"";position:absolute;width:17px;height:17px;border-radius:50%;background:#aeb4c0;top:3px;left:3px;transition:.18s}.toggle:checked{background:#8e1426;box-shadow:0 0 18px #f3263e2e}.toggle:checked:after{left:22px;background:#fff}.range{width:100%;accent-color:var(--red)}select,input[type=text],input[type=number]{background:#090b10;border:1px solid #303541;color:#eef1f6;border-radius:10px;padding:9px 10px;font-size:11px;outline:none}select:focus,input:focus{border-color:#f3263e88}.btn{border:1px solid #ffffff12;background:#1b1e26;color:#fff;border-radius:10px;padding:9px 12px;font-size:10px;font-weight:800}.btn.primary{background:linear-gradient(180deg,#ef2a42,#a70f25);border-color:#ff5367}.statline{display:grid;grid-template-columns:1fr auto;gap:8px;padding:7px 0;border-bottom:1px solid #ffffff08;font-size:11px}.statline:last-child{border:0}.statline span:last-child{color:#c8cdd7;text-align:right}.bar{height:5px;border-radius:8px;background:#252a34;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,#9e1327,#ff3049);width:50%}.danger{color:#ff6d7e}.good{color:#65f38b}.toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,20px);opacity:0;pointer-events:none;padding:10px 14px;border-radius:11px;background:#111319ee;border:1px solid #ffffff14;color:#fff;font:700 11px Inter,sans-serif;transition:.2s;z-index:2147483647}.toast.show{opacity:1;transform:translate(-50%,0)}@media(max-width:700px){.panel{left:8px;top:52px;width:calc(100vw - 16px);height:calc(100vh - 70px);border-radius:18px}.panel aside{width:76px}.brand{padding:16px 10px}.brand b{font-size:16px;letter-spacing:2px}.brand span{display:none}.panel nav button{font-size:0;text-align:center;padding:10px 4px}.panel nav button:before{content:attr(data-short);font-size:10px}.sidefoot small,.bridge-state{display:none}.card,.card.third{grid-column:1/-1}header{height:62px;padding:0 14px}.content{padding:11px}.orb{right:9px;top:auto;bottom:88px;width:42px;height:42px}}`;}
    drag(){let sx=0,sy=0,sl=0,st=0,drag=false;const h=this.shadow.querySelector('header');h.addEventListener('pointerdown',e=>{if(e.target.closest('button'))return;drag=true;sx=e.clientX;sy=e.clientY;const r=this.panel.getBoundingClientRect();sl=r.left;st=r.top;h.setPointerCapture?.(e.pointerId)});h.addEventListener('pointermove',e=>{if(!drag)return;const x=clamp(sl+e.clientX-sx,0,innerWidth-100),y=clamp(st+e.clientY-sy,0,innerHeight-60);this.panel.style.left=x+'px';this.panel.style.top=y+'px'});h.addEventListener('pointerup',()=>drag=false);}
    toast(msg){const t=this.shadow.querySelector('.toast');t.textContent=msg;t.classList.add('show');clearTimeout(this._toastTimer);this._toastTimer=setTimeout(()=>t.classList.remove('show'),1900);}
    bindToggle(id,obj,key,onChange){const el=this.shadow.getElementById(id);if(!el)return;el.checked=!!obj[key];el.onchange=()=>{obj[key]=el.checked;this.app.store.save();onChange?.(el.checked);};}
    bindRange(id,obj,key,fmt,onChange){const el=this.shadow.getElementById(id),out=this.shadow.getElementById(id+'-v');if(!el)return;el.value=obj[key];const paint=()=>{obj[key]=Number(el.value);if(out)out.textContent=fmt?fmt(obj[key]):obj[key];this.app.store.save();onChange?.(obj[key]);};paint();el.oninput=paint;}
    bindSelect(id,obj,key,onChange){const el=this.shadow.getElementById(id);if(!el)return;el.value=obj[key];el.onchange=()=>{obj[key]=el.value;this.app.store.save();onChange?.(el.value);};}
    render(){const a=this.app,s=a.store.data,c=this.shadow.querySelector('.content');
      const toggle=(id,label,val)=>`<div class="row"><label for="${id}">${label}</label><input id="${id}" class="toggle" type="checkbox" ${val?'checked':''}></div>`;
      const range=(id,label,val,min,max,step=1,suffix='')=>`<div class="row"><label>${label}</label><span class="muted" id="${id}-v">${val}${suffix}</span></div><input id="${id}" class="range" type="range" min="${min}" max="${max}" step="${step}" value="${val}">`;
      const select=(id,label,val,opts)=>`<div class="row"><label>${label}</label><select id="${id}">${opts.map(o=>`<option value="${o[0]}" ${o[0]===val?'selected':''}>${o[1]}</option>`).join('')}</select></div>`;
      if(this.activeTab==='Dashboard') c.innerHTML=`<div class="grid"><div class="card third"><h3>MODEL FPS</h3><div class="metric m-model">${a.vision.modelFps.toFixed(1)}</div><div class="muted">local inference</div></div><div class="card third"><h3>INFERENCE</h3><div class="metric m-ms">${a.vision.inferenceMs.toFixed(1)} ms</div><div class="muted">rolling average</div></div><div class="card third"><h3>STREAM FPS</h3><div class="metric m-stream">${a.metrics.streamFps.toFixed(0)}</div><div class="muted">video callback</div></div><div class="card full"><h3>SESSION</h3><div class="statline"><span>Vision model</span><span class="s-model">${a.vision.modelName}</span></div><div class="statline"><span>Backend</span><span class="s-backend">${a.vision.backend}</span></div><div class="statline"><span>Input adapter</span><span class="s-input">${a.input.resolveAdapter()}</span></div><div class="statline"><span>ESP32-S3</span><span class="s-bridge">${a.bridge.connected?'Connected':'Offline'}</span></div><div class="statline"><span>Controller</span><span class="s-controller">${a.controllerName}</span></div></div><div class="card full"><h3>MASTER</h3>${toggle('masterAim','Aim engine',s.aim.enabled)}${toggle('masterVision','Vision engine',s.vision.enabled)}${toggle('masterVisuals','Overlay',s.visuals.enabled)}</div></div>`;
      if(this.activeTab==='Aim') c.innerHTML=`<div class="grid"><div class="card full"><h3>AIM ENGINE</h3>${toggle('aimEnabled','Enabled',s.aim.enabled)}${select('activation','Activation',s.aim.activation,[['hold','Hold input'],['toggle','Toggle (F8)'],['always','Always']])}${select('aimTarget','Aim point',s.aim.target,[['head','Head'],['chest','Chest'],['hip','Hip']])}${range('fov','FOV radius',s.aim.fov,40,380,1,' px')}${range('smooth','Smoothing',s.aim.smoothing,.02,1,.01,'')}${range('maxstep','Max step',s.aim.maxStep,2,80,1,' px')}${range('deadzone','Deadzone',s.aim.deadzone,0,20,.5,' px')}${range('pred','Prediction',s.aim.predictionMs,0,150,1,' ms')}</div></div>`;
      if(this.activeTab==='Vision') c.innerHTML=`<div class="grid"><div class="card full"><h3>LOCAL MODEL</h3>${toggle('visionEnabled','Vision engine',s.vision.enabled)}${select('model','Model',s.vision.model,[['lightning','MoveNet Lightning • fast'],['thunder','MoveNet Thunder • quality']])}${select('backend','Backend',s.vision.backend,[['auto','Auto • WebGPU first'],['webgpu','WebGPU'],['webgl','WebGL'],['cpu','CPU']])}${range('score','Minimum pose score',s.vision.minScore,.05,.9,.01,'')}${range('kpscore','Keypoint score',s.vision.keypointScore,.05,.9,.01,'')}${toggle('adaptive','Adaptive inference scheduler',s.vision.adaptive)}${range('targetfps','Target model FPS',s.vision.targetFps,10,120,1,' fps')}<div class="row"><button class="btn primary" id="reloadModel">RELOAD MODEL</button><span class="muted">${a.vision.modelName} • ${a.vision.backend}</span></div></div></div>`;
      if(this.activeTab==='Visuals') c.innerHTML=`<div class="grid"><div class="card full"><h3>OVERLAY</h3>${toggle('visualEnabled','Enabled',s.visuals.enabled)}${toggle('boxes','Corner boxes',s.visuals.boxes)}${toggle('skel','Skeleton',s.visuals.skeleton)}${toggle('points','Keypoints',s.visuals.keypoints)}${toggle('fovvis','FOV circle',s.visuals.fov)}${toggle('tline','Target line',s.visuals.targetLine)}${toggle('rgb','RGB accent',s.visuals.rgb)}${range('linewidth','Line width',s.visuals.lineWidth,.5,4,.1,' px')}</div></div>`;
      if(this.activeTab==='Input') c.innerHTML=`<div class="grid"><div class="card full"><h3>INPUT ROUTER</h3>${select('adapter','Output adapter',s.input.adapter,[['auto','Auto'],['pointer','Browser pointer'],['esp32','ESP32-S3']])}${range('mousegain','Mouse gain',s.input.mouseGain,.1,3,.05,'×')}${range('controllergain','Controller gain',s.input.controllerGain,.1,3,.05,'×')}${range('touchgain','Touch gain',s.input.touchGain,.1,3,.05,'×')}${toggle('invertY','Invert Y',s.input.invertY)}${toggle('touchHold','Touch hold activation',s.aim.touchHold)}${range('controllerbtn','Controller aim button',s.aim.controllerButton,0,16,1,'') }<div class="statline"><span>Detected controller</span><span>${a.controllerName}</span></div><div class="statline"><span>Touch</span><span>${a.device.touch?'Yes':'No'}</span></div><div class="muted">Activation supports right mouse hold, controller trigger button index ${s.aim.controllerButton}, touch hold on the right side, F8 toggle, or always-on mode.</div></div></div>`;
      if(this.activeTab==='ESP32-S3') c.innerHTML=`<div class="grid"><div class="card full"><h3>RAVENLINK</h3>${toggle('espEnabled','Enable bridge',s.esp32.enabled)}<div class="row"><label>WebSocket URL</label><input id="espurl" type="text" value="${s.esp32.url}"></div>${range('esphz','Send rate',s.esp32.sendHz,20,240,1,' Hz')}<div class="row"><button class="btn primary" id="espConnect">CONNECT</button><button class="btn" id="espPing">PING</button><span class="muted">${a.bridge.connected?'ONLINE':'OFFLINE'}${a.bridge.latency!=null?` • ${a.bridge.latency.toFixed(1)} ms`:''}</span></div><div class="muted">Wi-Fi/WebSocket is the portable browser path. iOS browsers do not expose the same USB/BLE browser APIs as desktop Chromium, so RavenLink uses network transport here.</div></div></div>`;
      if(this.activeTab==='Performance') c.innerHTML=`<div class="grid"><div class="card full"><h3>PERFORMANCE POLICY</h3>${toggle('highperf','High performance',s.perf.highPerformance)}${toggle('suspend','Suspend inference when hidden',s.perf.suspendWhenHidden)}${toggle('adaptive2','Adaptive scheduler',s.vision.adaptive)}${range('overlayfps','Overlay FPS cap',s.perf.overlayFps,15,120,1,' fps')}<div class="statline"><span>Tensor backend</span><span>${a.vision.backend}</span></div><div class="statline"><span>Model FPS</span><span>${a.vision.modelFps.toFixed(1)}</span></div><div class="statline"><span>Inference</span><span>${a.vision.inferenceMs.toFixed(1)} ms</span></div><div class="statline"><span>Render FPS</span><span>${a.metrics.renderFps.toFixed(0)}</span></div></div></div>`;
      if(this.activeTab==='Device') c.innerHTML=`<div class="grid"><div class="card full"><h3>DEVICE DETECTION</h3>${Object.entries({Platform:a.device.label,CPU:`${a.device.cores??'Unknown'} logical cores`,Memory:a.device.memory?`${a.device.memory} GB hint`:'Unavailable',GPU:a.device.gpu,Screen:a.device.screenInfo,WebGPU:a.device.webgpu?'Supported':'Unavailable',Touch:a.device.touch?'Supported':'No',GamepadAPI:a.device.gamepad?'Supported':'Unavailable',VideoFrameCallback:a.device.rvfc?'Supported':'Unavailable'}).map(([k,v])=>`<div class="statline"><span>${k}</span><span>${v}</span></div>`).join('')}</div></div>`;
      if(this.activeTab==='Settings') c.innerHTML=`<div class="grid"><div class="card full"><h3>RAVEN</h3><div class="statline"><span>Build</span><span>${BUILD}</span></div><div class="statline"><span>Toggle UI</span><span>Alt + Shift + R</span></div><div class="statline"><span>Toggle aim</span><span>F8</span></div><div class="row"><button class="btn" id="reset">RESET SETTINGS</button><button class="btn danger" id="destroy">UNLOAD RAVEN</button></div><div class="muted">Settings are stored locally in this browser. Inference stays on-device; model/runtime assets are fetched from pinned CDN URLs and then use normal browser caching.</div></div></div>`;
      this.bindCurrent(); this.renderStatus();
    }
    bindCurrent(){const s=this.app.store.data;
      [['masterAim',s.aim,'enabled'],['aimEnabled',s.aim,'enabled'],['masterVision',s.vision,'enabled'],['visionEnabled',s.vision,'enabled'],['masterVisuals',s.visuals,'enabled'],['visualEnabled',s.visuals,'enabled'],['adaptive',s.vision,'adaptive'],['adaptive2',s.vision,'adaptive'],['boxes',s.visuals,'boxes'],['skel',s.visuals,'skeleton'],['points',s.visuals,'keypoints'],['fovvis',s.visuals,'fov'],['tline',s.visuals,'targetLine'],['rgb',s.visuals,'rgb'],['invertY',s.input,'invertY'],['touchHold',s.aim,'touchHold'],['espEnabled',s.esp32,'enabled'],['highperf',s.perf,'highPerformance'],['suspend',s.perf,'suspendWhenHidden']].forEach(x=>this.bindToggle(...x,x[0]==='espEnabled'?v=>v?this.app.bridge.connect():this.app.bridge.disconnect():null));
      [['fov',s.aim,'fov',v=>`${v|0} px`],['smooth',s.aim,'smoothing',v=>v.toFixed(2)],['maxstep',s.aim,'maxStep',v=>`${v|0} px`],['deadzone',s.aim,'deadzone',v=>`${v.toFixed(1)} px`],['pred',s.aim,'predictionMs',v=>`${v|0} ms`],['controllerbtn',s.aim,'controllerButton',v=>`${v|0}`],['score',s.vision,'minScore',v=>v.toFixed(2)],['kpscore',s.vision,'keypointScore',v=>v.toFixed(2)],['targetfps',s.vision,'targetFps',v=>`${v|0} fps`],['linewidth',s.visuals,'lineWidth',v=>`${v.toFixed(1)} px`],['mousegain',s.input,'mouseGain',v=>`${v.toFixed(2)}×`],['controllergain',s.input,'controllerGain',v=>`${v.toFixed(2)}×`],['touchgain',s.input,'touchGain',v=>`${v.toFixed(2)}×`],['esphz',s.esp32,'sendHz',v=>`${v|0} Hz`],['overlayfps',s.perf,'overlayFps',v=>`${v|0} fps`]].forEach(x=>this.bindRange(...x));
      this.bindSelect('activation',s.aim,'activation');this.bindSelect('aimTarget',s.aim,'target');this.bindSelect('adapter',s.input,'adapter');
      this.bindSelect('model',s.vision,'model',()=>this.app.vision.loadModel(true)); this.bindSelect('backend',s.vision,'backend',()=>this.app.vision.loadModel(true));
      const rm=this.shadow.getElementById('reloadModel');if(rm)rm.onclick=()=>this.app.vision.loadModel(true);
      const url=this.shadow.getElementById('espurl');if(url)url.onchange=()=>{s.esp32.url=url.value.trim();this.app.store.save();};
      const ec=this.shadow.getElementById('espConnect');if(ec)ec.onclick=()=>this.app.bridge.connect(); const ep=this.shadow.getElementById('espPing');if(ep)ep.onclick=()=>this.app.bridge.ping();
      const reset=this.shadow.getElementById('reset');if(reset)reset.onclick=()=>{this.app.store.reset();this.app.toast('Settings reset');this.render();};
      const destroy=this.shadow.getElementById('destroy');if(destroy)destroy.onclick=()=>this.app.destroy();
    }
    renderStatus(){const a=this.app;const b=this.shadow.querySelector('.backend');if(b)b.textContent=`${a.vision.backend.toUpperCase()} • ${a.vision.modelFps.toFixed(0)} FPS`;const bs=this.shadow.querySelector('.bridge-state');if(bs)bs.textContent=a.bridge.connected?'ESP32 ONLINE':'LOCAL';const dot=this.shadow.querySelector('.dot');if(dot)dot.style.background=a.vision.detector?'#4cff7a':'#ffb84c';const set=(q,v)=>{const e=this.shadow.querySelector(q);if(e)e.textContent=v};set('.m-model',a.vision.modelFps.toFixed(1));set('.m-ms',`${a.vision.inferenceMs.toFixed(1)} ms`);set('.m-stream',a.metrics.streamFps.toFixed(0));set('.s-model',a.vision.modelName);set('.s-backend',a.vision.backend);set('.s-input',a.input.resolveAdapter());set('.s-bridge',a.bridge.connected?'Connected':'Offline');set('.s-controller',a.controllerName);}
    destroy(){clearInterval(this.statusTimer);this.host.remove();}
  }

  class RavenApp {
    constructor(){this.running=true;this.store=new RavenStore();this.logs=[];this.device=null;this.controllerName='None';this.locator=new VideoLocator();this.loader=new LibraryLoader(m=>this.log(m));this.vision=new VisionRuntime(this);this.bridge=new RavenBridge(this);this.activation=null;this.input=null;this.metrics=new StreamMetrics(this);this.overlay=null;this.ui=null;this.loopHandle=0;this.lastOverlay=0;}
    log(m){this.logs.push({t:Date.now(),m});if(this.logs.length>100)this.logs.shift();console.info('[Raven]',m);}
    toast(m){this.ui?.toast(m);}
    async boot(){
      this.device=await DeviceProfile.detect();
      this.activation=new ActivationState(this);
      this.input=new InputRouter(this);
      this.overlay=new Overlay(this);
      this.ui=new RavenUI(this);
      this.toast(`Raven ${BUILD} • ${this.device.label}`);
      await this.loader.ensure();
      await this.vision.loadModel();
      await this.waitForVideo();
      if(this.store.data.esp32.enabled) this.bridge.connect();
      this.loop();
    }
    async waitForVideo(){for(let i=0;i<180&&this.running;i++){const v=this.locator.find();if(v){this.metrics.start(v);this.toast('xCloud stream attached');return v;}await sleep(500);}this.log('No live video found yet; continuing discovery in loop.');return null;}
    loop=async()=>{
      if(!this.running)return;
      let video=this.locator.video;
      if(!video||!document.contains(video)||video.readyState<2){const old=video;video=this.locator.find();if(video&&video!==old)this.metrics.start(video);}
      if(video&&this.vision.detector){const pose=await this.vision.run(video);if(pose){const target=this.vision.targetPoint(pose);if(target)await this.input.apply(target);}}
      const t=now(), cap=clamp(this.store.data.perf.overlayFps,15,120);if(t-this.lastOverlay>=1000/cap){this.lastOverlay=t;this.overlay.draw();}
      this.loopHandle=requestAnimationFrame(this.loop);
    }
    destroy(){if(!this.running)return;this.running=false;cancelAnimationFrame(this.loopHandle);this.metrics.stop();this.bridge.disconnect();this.input?.destroy();this.activation?.destroy();this.overlay?.destroy();this.ui?.destroy();try{this.vision.detector?.dispose?.();}catch{}delete window[NS];console.info('[Raven] Unloaded');}
  }

  const app=new RavenApp();
  window[NS]=app;
  app.boot().catch(e=>{console.error('[Raven] Boot failed',e);app.toast?.(`Boot failed: ${e.message}`);});
})();
