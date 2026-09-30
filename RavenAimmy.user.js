// ==UserScript==
// @name         Aimmy By Krem — Raven Edition
// @namespace    https://github.com/kremityss/Aimmy-By-Krem
// @version      1.2.0
// @description  Raven-branded local vision/control dashboard for Xbox Cloud Gaming with desktop, touch, controller, and optional ESP32-S3 support.
// @author       Kremityss
// @match        https://www.xbox.com/*/play/*
// @match        https://www.xbox.com/play/*
// @match        https://xbox.com/*/play/*
// @require      https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const BUILD = '1.2.0';
  const NS = '__RAVEN_AIMMY__';
  if (window[NS]?.destroy) window[NS].destroy();

  const CDN = {
    tf: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js',
    webgpu: 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgpu@4.22.0/dist/tf-backend-webgpu.min.js',
    pose: 'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js',
    ort: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.js'
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
      this.key = 'ravenAimmy.v3';
      this.defaults = {
        ui: { open: true, scale: 1, opacity: .96, compactHud: true, autoScale: true },
        aim: {
          enabled: true,
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
          engine: 'auto',
          model: 'lightning',
          yoloUrl: '',
          yoloConfidence: .12,
          yoloIou: .45,
          yoloInputSize: 640,
          backend: 'auto',
          minScore: .16,
          keypointScore: .16,
          intervalMs: 0,
          maxPoses: 1,
          crop: 'video',
          adaptive: true,
          targetFps: 45
        },
        visuals: {
          enabled: true,
          boxes: true,
          skeleton: false,
          tracers: false,
          keypoints: false,
          fov: true,
          targetLine: true,
          rgb: false,
          lineWidth: 1.5,
          hud: true
        },
        input: {
          adapter: 'auto',
          mouseGain: 1,
          controllerGain: 1,
          touchGain: .85,
          mobileTouch: true,
          touchAssistStrength: .72,
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
          overlayFps: 30,
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
      const viewportWidth = Math.max(1, window.innerWidth || screen.width);
      const viewportHeight = Math.max(1, window.innerHeight || screen.height);
      const shortSide = Math.min(viewportWidth, viewportHeight);
      const orientation = viewportWidth >= viewportHeight ? 'landscape' : 'portrait';
      const screenInfo = `${screen.width}×${screen.height} @${window.devicePixelRatio.toFixed(2)}x • ${orientation}`;
      const gpu = await DeviceProfile.gpuName();
      return {
        ua, platform, mobile, ios, android, chromeOS, windows, touch, memory, cores, gpu,
        viewportWidth, viewportHeight, shortSide, orientation, screenInfo,
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
      this.log('Pose runtime ready');
    }
    async ensureOrt() {
      if (!window.ort) {
        this.log('Loading ONNX Runtime Web');
        await this.loadScript(CDN.ort, () => !!window.ort);
      }
      try {
        const base='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
        ort.env.logLevel='warning';
        ort.env.wasm.wasmPaths=base;
        ort.env.wasm.simd=true;
        ort.env.wasm.numThreads=crossOriginIsolated
          ? Math.max(1,Math.min(4,(navigator.hardwareConcurrency||2)-1))
          : 1;
        if (ort.env.webgpu) {
          ort.env.webgpu.powerPreference='high-performance';
          ort.env.webgpu.validateInputContent=false;
        }
      } catch(e) { this.log(`ORT env setup: ${e.message}`); }
      this.log(`ONNX Runtime ready ${ort.env?.versions?.web||''}`.trim());
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
      const minInterval = Math.max(cfg.intervalMs, 1000 / clamp(cfg.targetFps, 6, this.app.device?.mobile ? 30 : 60));
      if (t - this.lastRun < minInterval) return null;
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


  class Yolo26Runtime {
    constructor(app) {
      this.app = app;
      this.session = null;
      this.ready = false;
      this.busy = false;
      this.modelName = 'Fortnite YOLO11n • not loaded';
      this.backend = 'none';
      this.inputName = null;
      this.outputName = null;
      this.inputSize = 0;
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.detections = [];
      this.lastBox = null;
      this.lastRun = 0;
      this.lastFinish = 0;
      this.inferAvg = new RingAverage(18);
      this.fpsAvg = new RingAverage(18);
      this.objectUrl = null;
      this.sourceName = '';
      this.lastTransform = null;
      this.cacheDb = 'ravenAimmyModels';
      this.cacheKey = 'fortnite-primary';
      this.status = 'idle';
      this.lastError = '';
      this.providerAttempts = [];
      this.dynamicFpsCap = 60;
      this.warmupMs = 0;
      this.outputShape = '—';
      this.maxScore = 0;
      this.rawRows = 0;
    }
    get inferenceMs() { return this.inferAvg.value; }
    get modelFps() { return this.fpsAvg.value; }
    async load(source, name='Fortnite YOLO11n') {
      if (!source) throw new Error('Choose a Fortnite ONNX model file or URL first');
      this.status='loading'; this.lastError=''; this.providerAttempts=[];
      await this.app.loader.ensureOrt();
      if (this.objectUrl) { try { URL.revokeObjectURL(this.objectUrl); } catch {} this.objectUrl=null; }
      this.ready=false; this.session=null; this.backend='none'; this.detections=[]; this.lastBox=null;

      const plans=[];
      if (this.app.device.webgpu) {
        const webgpu={name:'webgpu',preferredLayout:'NCHW',validationMode:'disabled',storageBufferCacheMode:'simple',uniformBufferCacheMode:'simple'};
        plans.push({label:'webgpu+capture',backend:'webgpu',options:{executionProviders:[webgpu,'wasm'],graphOptimizationLevel:'all',enableGraphCapture:true}});
        plans.push({label:'webgpu',backend:'webgpu',options:{executionProviders:[webgpu,'wasm'],graphOptimizationLevel:'all'}});
      }
      plans.push({label:'wasm',backend:'wasm',options:{executionProviders:['wasm'],graphOptimizationLevel:'all'}});

      let lastError=null;
      for (const plan of plans) {
        try {
          this.status=`loading:${plan.label}`;
          this.session=await ort.InferenceSession.create(source,plan.options);
          this.backend=plan.backend;
          this.providerAttempts.push(`${plan.label}:ok`);
          break;
        } catch(e) {
          lastError=e;
          this.providerAttempts.push(`${plan.label}:fail`);
          this.app.log(`YOLO ${plan.label} failed: ${e.message}`);
        }
      }

      if (!this.session) {
        this.status='error';
        this.lastError=lastError?.message||'Fortnite ONNX session failed to load';
        throw lastError||new Error(this.lastError);
      }

      this.inputName=this.session.inputNames[0];
      this.outputName=this.session.outputNames[0];
      const meta=this.session.inputMetadata?.[this.inputName];
      const dims=meta?.dimensions || meta?.dims || [];
      const fixedH=Number(dims?.[2]), fixedW=Number(dims?.[3]);
      this.inputSize=(Number.isFinite(fixedH)&&fixedH>0&&fixedH===fixedW)?fixedH:640;
      this.canvas.width=this.inputSize; this.canvas.height=this.inputSize;
      this.ctx.imageSmoothingEnabled=true;
      this.ctx.imageSmoothingQuality='low';
      this.modelName=name;
      this.sourceName=name;
      this.inferAvg.clear(); this.fpsAvg.clear(); this.dynamicFpsCap=60;

      try {
        this.status='warming';
        const warm=new ort.Tensor('float32',new Float32Array(3*this.inputSize*this.inputSize),[1,3,this.inputSize,this.inputSize]);
        const wt=now();
        await this.session.run({[this.inputName]:warm});
        this.warmupMs=now()-wt;
      } catch(e) {
        this.app.log(`YOLO warmup skipped: ${e.message}`);
      }

      this.ready=true;
      this.status='ready';
      this.app.toast(`${name} • ${this.backend.toUpperCase()}`);
      this.app.ui?.render();
    }
    async loadFile(file) {
      if (!file) return;
      const buf=await file.arrayBuffer();
      await this.load(buf, file.name || 'Fortnite YOLO11n');
      try { await this.cacheModel(buf,file.name||'weights-3.onnx'); } catch(e) { this.app.log(`Model cache: ${e.message}`); }
    }
    async cacheModel(buffer,name) {
      return await new Promise((resolve,reject)=>{
        const req=indexedDB.open(this.cacheDb,1);
        req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('models'))db.createObjectStore('models');};
        req.onerror=()=>reject(req.error||new Error('IndexedDB open failed'));
        req.onsuccess=()=>{const db=req.result,tx=db.transaction('models','readwrite');tx.objectStore('models').put({name,buffer,ts:Date.now()},this.cacheKey);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error||new Error('Model cache write failed'));};};
      });
    }
    async loadCached() {
      const entry=await new Promise((resolve,reject)=>{
        const req=indexedDB.open(this.cacheDb,1);
        req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('models'))db.createObjectStore('models');};
        req.onerror=()=>reject(req.error||new Error('IndexedDB open failed'));
        req.onsuccess=()=>{const db=req.result,tx=db.transaction('models','readonly'),get=tx.objectStore('models').get(this.cacheKey);get.onsuccess=()=>{const v=get.result;db.close();resolve(v||null);};get.onerror=()=>{db.close();reject(get.error||new Error('Model cache read failed'));};};
      });
      if(!entry?.buffer) return false;
      await this.load(entry.buffer,entry.name||'Fortnite YOLO11n');
      return true;
    }
    async loadUrl(url) {
      const clean=(url||'').trim();
      if (!clean) throw new Error('YOLO URL is empty');
      await this.load(clean, 'Fortnite YOLO11n');
    }
    async preprocess(video) {
      const n=this.inputSize;
      const vw=video.videoWidth, vh=video.videoHeight;
      const scale=Math.min(n/vw,n/vh);
      const dw=Math.round(vw*scale), dh=Math.round(vh*scale);
      const px=Math.floor((n-dw)/2), py=Math.floor((n-dh)/2);
      const c=this.ctx;
      c.save(); c.fillStyle='rgb(114,114,114)'; c.fillRect(0,0,n,n); c.drawImage(video,0,0,vw,vh,px,py,dw,dh); c.restore();
      this.lastTransform={scale,px,py,vw,vh};
      const imageData=c.getImageData(0,0,n,n);
      if (ort.Tensor?.fromImage) {
        return await ort.Tensor.fromImage(imageData,{
          tensorFormat:'RGB',
          tensorLayout:'NCHW',
          dataType:'float32',
          norm:{mean:255,bias:0}
        });
      }
      const rgba=imageData.data, area=n*n, data=new Float32Array(area*3);
      for(let i=0,j=0;i<area;i++,j+=4){data[i]=rgba[j]/255;data[area+i]=rgba[j+1]/255;data[area*2+i]=rgba[j+2]/255;}
      return new ort.Tensor('float32',data,[1,3,n,n]);
    }
    toVideoBox(x1,y1,x2,y2,score,classId) {
      const t=this.lastTransform; if(!t) return null;
      const maxCoord=Math.max(Math.abs(x1),Math.abs(y1),Math.abs(x2),Math.abs(y2));
      if(maxCoord<=2){x1*=this.inputSize;y1*=this.inputSize;x2*=this.inputSize;y2*=this.inputSize;}
      x1=clamp((x1-t.px)/t.scale,0,t.vw); y1=clamp((y1-t.py)/t.scale,0,t.vh);
      x2=clamp((x2-t.px)/t.scale,0,t.vw); y2=clamp((y2-t.py)/t.scale,0,t.vh);
      const w=x2-x1,h=y2-y1;
      if(w<3||h<3) return null;
      return {x:x1,y:y1,w,h,score,classId};
    }
    iou(a,b) {
      const x1=Math.max(a.x,b.x),y1=Math.max(a.y,b.y),x2=Math.min(a.x+a.w,b.x+b.w),y2=Math.min(a.y+a.h,b.y+b.h);
      const inter=Math.max(0,x2-x1)*Math.max(0,y2-y1);
      return inter/(a.w*a.h+b.w*b.h-inter+1e-6);
    }
    nms(boxes,iouThreshold) {
      const sorted=boxes.sort((a,b)=>b.score-a.score), out=[];
      while(sorted.length && out.length<64){
        const best=sorted.shift(); out.push(best);
        for(let i=sorted.length-1;i>=0;i--) if(sorted[i].classId===best.classId && this.iou(best,sorted[i])>iouThreshold) sorted.splice(i,1);
      }
      return out;
    }
    parse(tensor) {
      const d=tensor.data, dims=tensor.dims||[], conf=this.app.store.data.vision.yoloConfidence, out=[];
      this.outputShape=dims.length?dims.join('×'):'unknown';
      this.maxScore=0;
      this.rawRows=0;
      if(dims.length>=2 && dims[dims.length-1]===6){
        const rows=d.length/6; this.rawRows=rows;
        for(let i=0;i<rows;i++){
          const o=i*6, score=d[o+4]; if(Number.isFinite(score)) this.maxScore=Math.max(this.maxScore,score); if(score<conf) continue;
          const b=this.toVideoBox(d[o],d[o+1],d[o+2],d[o+3],score,Math.round(d[o+5]));
          if(b) out.push(b);
        }
        // This Fortnite export reports output0 [1,300,6] with export-time NMS enabled.
        // Do not run a second NMS pass in JavaScript.
        return out;
      }
      if(dims.length===3 && dims[1]<dims[2]){
        const channels=dims[1], count=dims[2], classes=channels-4; this.rawRows=count;
        for(let i=0;i<count;i++){
          let score=-Infinity, cls=-1;
          for(let c=0;c<classes;c++){const v=d[(4+c)*count+i];if(v>score){score=v;cls=c;}}
          if(Number.isFinite(score)) this.maxScore=Math.max(this.maxScore,score); if(score<conf) continue;
          const cx=d[i],cy=d[count+i],w=d[count*2+i],h=d[count*3+i];
          const b=this.toVideoBox(cx-w/2,cy-h/2,cx+w/2,cy+h/2,score,cls); if(b) out.push(b);
        }
        return this.nms(out,this.app.store.data.vision.yoloIou);
      }
      if(dims.length===3 && dims[2]>=6){
        const count=dims[1], channels=dims[2], classes=channels-4; this.rawRows=count;
        for(let i=0;i<count;i++){
          const o=i*channels; let score=-Infinity, cls=-1;
          for(let c=0;c<classes;c++){const v=d[o+4+c];if(v>score){score=v;cls=c;}}
          if(Number.isFinite(score)) this.maxScore=Math.max(this.maxScore,score); if(score<conf) continue;
          const cx=d[o],cy=d[o+1],w=d[o+2],h=d[o+3];
          const b=this.toVideoBox(cx-w/2,cy-h/2,cx+w/2,cy+h/2,score,cls); if(b) out.push(b);
        }
        return this.nms(out,this.app.store.data.vision.yoloIou);
      }
      this.app.log(`Unsupported YOLO output shape: ${JSON.stringify(dims)}`);
      return [];
    }
    async run(video) {
      if(!this.ready||this.busy||!video) return null;
      const cfg=this.app.store.data.vision,t=now();
      const requested=clamp(cfg.targetFps,6,60);
      const effective=Math.max(6,Math.min(requested,this.dynamicFpsCap));
      const minInterval=Math.max(cfg.intervalMs,1000/effective);
      if(t-this.lastRun<minInterval) return null;
      if(document.hidden&&this.app.store.data.perf.suspendWhenHidden) return null;
      this.lastRun=t; this.busy=true;
      const start=now();
      try{
        const input=await this.preprocess(video);
        const outputs=await this.session.run({[this.inputName]:input});
        const elapsed=now()-start;
        this.inferAvg.push(elapsed);
        const sustainable=clamp(Math.floor(1000/Math.max(1,elapsed+2)),6,60);
        this.dynamicFpsCap=lerp(this.dynamicFpsCap,sustainable,.18);
        if(this.lastFinish)this.fpsAvg.push(1000/Math.max(1,now()-this.lastFinish));
        this.lastFinish=now();
        const tensor=outputs[this.outputName]||outputs[Object.keys(outputs)[0]];
        this.detections=this.parse(tensor);
        this.lastBox=this.bestDetection()||this.detections[0]||null;
        return this.detections;
      }catch(e){this.lastError=e.message;this.status='error';this.app.log(`YOLO inference: ${e.message}`);return null;}
      finally{this.busy=false;}
    }
    aimPoint(box) {
      if(!box) return null;
      const mode=this.app.store.data.aim.target;
      const ratio=mode==='head'?.18:mode==='chest'?.38:.62;
      return {x:box.x+box.w*.5,y:box.y+box.h*ratio,score:box.score};
    }
    bestDetection() {
      const v=this.app.locator.video;if(!v||!this.detections.length)return null;
      const cx=v.videoWidth/2,cy=v.videoHeight/2;
      return this.detections.reduce((best,b)=>{
        const p=this.aimPoint(b),dist=Math.hypot(p.x-cx,p.y-cy);
        const weighted=dist/(.25+b.score);
        return !best||weighted<best.weighted?{box:b,weighted}:best;
      },null)?.box||null;
    }
    targetPoint() { return this.aimPoint(this.bestDetection()); }
    dispose() { try{this.session?.release?.();}catch{} this.session=null;this.ready=false;this.status='idle';this.detections=[]; }
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
          this.touchStart = { x:t.clientX, y:t.clientY, id:t.identifier ?? 1, target:t.target || e.target };
          if (this.app.store.data.aim.touchHold) this.app.activation.touchAim = true;
        }
      };
      const onMove = e => {
        if (!this.touchStart) return;
        const t = e.touches?.[0];
        if (t) this.touchStart = { x:t.clientX, y:t.clientY, id:t.identifier ?? 1, target:t.target || e.target };
      };
      const onEnd = () => { this.touchStart = null; this.app.activation.touchAim = false; };
      window.addEventListener('touchstart', onStart, {capture:true,passive:true});
      window.addEventListener('touchmove', onMove, {capture:true,passive:true});
      window.addEventListener('touchend', onEnd, {capture:true,passive:true});
      window.addEventListener('touchcancel', onEnd, {capture:true,passive:true});
      this._touchHandlers = [onStart,onMove,onEnd];
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
      else if (adapter === 'pointer' && source === 'touch' && this.app.store.data.input.mobileTouch) this.mobileDelta(this.smoothed.x, this.smoothed.y);
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
      const el = document.pointerLockElement || $('#game-stream') || video || document.body;
      if (!video || !el) return;
      const rect = video.getBoundingClientRect();
      const mx=Math.round(dx), my=Math.round(dy);
      const init={bubbles:true,cancelable:true,clientX:rect.left+rect.width/2+dx,clientY:rect.top+rect.height/2+dy,buttons:1};
      const p = new PointerEvent('pointermove',{...init,pointerType:'mouse',isPrimary:true});
      try { Object.defineProperty(p,'movementX',{value:mx}); Object.defineProperty(p,'movementY',{value:my}); } catch {}
      el.dispatchEvent(p);
      const m = new MouseEvent('mousemove',init);
      try { Object.defineProperty(m,'movementX',{value:mx}); Object.defineProperty(m,'movementY',{value:my}); } catch {}
      el.dispatchEvent(m);
      if (el !== document) document.dispatchEvent(m);
    }
    mobileDelta(dx,dy) {
      const video=this.app.locator.video, touch=this.touchStart;
      if(!video||!touch) return;
      const strength=clamp(this.app.store.data.input.touchAssistStrength,.05,1);
      const nx=clamp(touch.x+dx*strength,0,innerWidth), ny=clamp(touch.y+dy*strength,0,innerHeight);
      const el=document.elementFromPoint(touch.x,touch.y)||touch.target||video;
      const p=new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerType:'touch',pointerId:touch.id||1,isPrimary:true,clientX:nx,clientY:ny,buttons:1});
      try { Object.defineProperty(p,'movementX',{value:Math.round(dx*strength)}); Object.defineProperty(p,'movementY',{value:Math.round(dy*strength)}); } catch {}
      el.dispatchEvent(p);
      try {
        if (typeof Touch==='function' && typeof TouchEvent==='function') {
          const t=new Touch({identifier:touch.id||1,target:el,clientX:nx,clientY:ny,screenX:nx,screenY:ny,pageX:nx,pageY:ny,radiusX:1,radiusY:1,rotationAngle:0,force:.5});
          el.dispatchEvent(new TouchEvent('touchmove',{bubbles:true,cancelable:true,touches:[t],targetTouches:[t],changedTouches:[t]}));
        }
      } catch {}
    }
    destroy() {
      cancelAnimationFrame(this.gamepadLoop);
      if (this._touchHandlers) {
        window.removeEventListener('touchstart', this._touchHandlers[0], true);
        window.removeEventListener('touchmove', this._touchHandlers[1], true);
        window.removeEventListener('touchend', this._touchHandlers[2], true);
        window.removeEventListener('touchcancel', this._touchHandlers[2], true);
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
      this.resize=()=>{ const dpr=this.app.device?.mobile?1:Math.min(devicePixelRatio||1,1.5); this.canvas.width=innerWidth*dpr; this.canvas.height=innerHeight*dpr; this.canvas.style.width=innerWidth+'px'; this.canvas.style.height=innerHeight+'px'; this.ctx.setTransform(dpr,0,0,dpr,0,0); };
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
      if(this.app.yolo.ready && this.app.store.data.vision.engine!=='pose'){
        const video=this.app.locator.video;
        const projectYolo=p=>({x:rect.left+(p.x/video.videoWidth)*rect.width,y:rect.top+(p.y/video.videoHeight)*rect.height});
        for(const b of this.app.yolo.detections){
          const A=projectYolo({x:b.x,y:b.y}),B=projectYolo({x:b.x+b.w,y:b.y+b.h});
          const x=A.x,y=A.y,w=B.x-A.x,h=B.y-A.y,L=Math.min(20,Math.max(7,Math.min(w,h)*.22));
          if(cfg.boxes){
            c.beginPath();
            c.moveTo(x+L,y);c.lineTo(x,y);c.lineTo(x,y+L);c.moveTo(x+w-L,y);c.lineTo(x+w,y);c.lineTo(x+w,y+L);
            c.moveTo(x,y+h-L);c.lineTo(x,y+h);c.lineTo(x+L,y+h);c.moveTo(x+w-L,y+h);c.lineTo(x+w,y+h);c.lineTo(x+w,y+h-L);c.stroke();
          }
          c.globalAlpha=.88;c.font='10px ui-monospace,monospace';c.fillText(`AI ${Math.round(b.score*100)}%`,x+3,Math.max(12,y-4));c.globalAlpha=1;
        }
        const yp=this.app.yolo.targetPoint(), yt=yp?this.app.input.mapTarget(yp):null;
        if(yt&&cfg.targetLine&&this.app.activation.active()){c.globalAlpha=.7;c.beginPath();c.moveTo(center.x,center.y);c.lineTo(yt.x,yt.y);c.stroke();c.globalAlpha=1;}
        return;
      }
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
      this.shadow.innerHTML=`<style>${this.css()}</style><button class="orb" title="Raven" aria-label="Toggle Raven">R</button><section class="panel"><aside><div class="brand"><b>RAVEN AI</b><span>GPT-STYLE • AI AIMBOT</span></div><nav></nav><div class="sidefoot"><span class="dot"></span><span class="bridge-state">LOCAL</span><small>v${BUILD}</small></div></aside><main><header><div><h1>AI AIMBOT // RAVEN</h1><p>NEURAL DETECTOR • LOCAL CONTROL CORE</p></div><div class="header-actions"><span class="chip backend">BOOT</span><button class="min">—</button></div></header><div class="content"></div></main></section><div class="toast"></div>`;
      this.panel=this.shadow.querySelector('.panel'); this.panel.style.display=this.app.store.data.ui.open?'flex':'none';
      this.shadow.querySelector('.orb').onclick=()=>this.toggle(); this.shadow.querySelector('.min').onclick=()=>this.toggle();
      const tabs=[['Dashboard','STATUS','HOME'],['Aim','AIMBOT','AIM'],['Vision','AI MODEL','AI'],['Visuals','ESP / VIS','ESP'],['Input','INPUT','IN'],['ESP32-S3','HARDWARE','HW'],['Performance','PERF','FPS'],['Device','DEVICE','DEV'],['Settings','CONFIG','CFG']];
      const nav=this.shadow.querySelector('nav');
      const openTab=(key,b,e)=>{
        e?.preventDefault?.(); e?.stopPropagation?.();
        this.activeTab=key;
        $$('nav button',this.shadow).forEach(x=>x.classList.toggle('active',x===b));
        try{this.render();}catch(err){this.showRenderError(err);}
      };
      tabs.forEach(([key,label,short],i)=>{
        const b=document.createElement('button');
        b.type='button'; b.textContent=label; b.dataset.short=short; b.dataset.tab=key;
        b.className=i===0?'active':'';
        b.addEventListener('pointerdown',e=>openTab(key,b,e),{passive:false});
        b.addEventListener('click',e=>openTab(key,b,e),{passive:false});
        nav.appendChild(b);
      });
      this.drag(); this.applyViewport(); this._resize=()=>this.applyViewport(); addEventListener('resize',this._resize); addEventListener('orientationchange',this._resize); this.render();
      this.statusTimer=setInterval(()=>this.renderStatus(),1000);
    }
    css(){return `:host{all:initial;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e9f4f1;--bg:#080b0f;--panel:#0d1117;--line:#27323c;--muted:#7e8a96;--ai:#10a37f}.orb{position:fixed;right:12px;top:42%;width:42px;height:42px;border-radius:6px;border:1px solid #2d4246;background:#0d1517;color:#8fffdc;font:900 15px ui-monospace,monospace;box-shadow:0 0 20px #10a37f35}.panel{position:fixed;display:flex;background:#090d12f7;border:1px solid #2b3741;border-radius:6px;overflow:hidden;box-shadow:0 24px 80px #000c;backdrop-filter:blur(14px)}.panel aside{width:150px;background:#0b1016;border-right:1px solid var(--line);display:flex;flex-direction:column}.brand{padding:14px 12px 12px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#101820,#0b1016)}.brand b{display:block;color:#dffbf2;font:900 15px ui-monospace,monospace;letter-spacing:1px}.brand span{display:block;margin-top:3px;color:#5fae9a;font:700 8px ui-monospace,monospace;letter-spacing:.7px}.panel nav{padding:6px;display:grid;gap:2px}.panel nav button{border:1px solid transparent;background:transparent;color:#85939f;text-align:left;padding:8px 9px;border-radius:3px;font:700 10px ui-monospace,monospace;letter-spacing:.4px}.panel nav button.active,.panel nav button:hover{background:#10241f;color:#9affdf;border-color:#1f5447;box-shadow:inset 2px 0 var(--ai)}.sidefoot{margin-top:auto;padding:9px;display:grid;grid-template-columns:auto 1fr auto;gap:6px;align-items:center;color:#70808d;font:700 8px ui-monospace,monospace;border-top:1px solid var(--line)}.dot{width:6px;height:6px;background:#4cff9a;border-radius:50%;box-shadow:0 0 7px #4cff9a88}main{flex:1;min-width:0;display:flex;flex-direction:column;background:#0a0e13}header{height:48px;border-bottom:1px solid var(--line);display:flex;align-items:center;padding:0 12px;justify-content:space-between;cursor:move;background:#0d131a}header h1{font:800 11px ui-monospace,monospace;letter-spacing:1px;margin:0;color:#dffbf2}header p{margin:2px 0 0;color:#63717e;font:700 8px ui-monospace,monospace;letter-spacing:.5px}.header-actions{display:flex;gap:6px;align-items:center}.chip{padding:5px 7px;border-radius:3px;background:#0b1a17;border:1px solid #1f493f;color:#7fe8c8;font:800 8px ui-monospace,monospace}.min{border:1px solid #33414d;background:#111820;color:#b8c4cc;border-radius:3px;width:26px;height:24px}.content{padding:9px;overflow:auto;flex:1;background:linear-gradient(180deg,#0a0e13,#080b0f)}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:7px}.card{grid-column:span 6;background:#0d1319;border:1px solid #25313b;border-radius:4px;padding:10px;box-shadow:inset 0 1px #ffffff05}.card.full{grid-column:1/-1}.card.third{grid-column:span 4}.card h3{margin:0 0 8px;padding-bottom:6px;border-bottom:1px solid #202a33;color:#60dcb9;font:800 9px ui-monospace,monospace;letter-spacing:.8px}.metric{font:900 22px ui-monospace,monospace;color:#dffbf2}.muted{color:var(--muted);font-size:10px;line-height:1.35}.row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:7px 0}.row label{font:650 10px ui-monospace,monospace;color:#b8c4cc}.toggle{appearance:none;width:34px;height:17px;border-radius:2px;background:#1b252d;border:1px solid #33414c;position:relative}.toggle:after{content:"";position:absolute;width:11px;height:11px;border-radius:1px;background:#7d8992;top:2px;left:2px}.toggle:checked{background:#10382f;border-color:#1d705d}.toggle:checked:after{left:18px;background:#7fffd7;box-shadow:0 0 7px #10a37f}.range{width:100%;height:4px;accent-color:var(--ai)}select,input[type=text],input[type=number],input[type=file]{max-width:58%;background:#080c10;border:1px solid #2b3944;color:#dce7ec;border-radius:3px;padding:6px 7px;font:600 9px ui-monospace,monospace;outline:none}input[type=file]{padding:4px}select:focus,input:focus{border-color:#2f8d76}.btn{border:1px solid #34434f;background:#121a21;color:#c8d4da;border-radius:3px;padding:7px 9px;font:800 9px ui-monospace,monospace}.btn.primary{background:#10392f;border-color:#267762;color:#9affdf}.statline{display:grid;grid-template-columns:1fr auto;gap:8px;padding:5px 0;border-bottom:1px solid #1d262e;font:600 9px ui-monospace,monospace}.statline:last-child{border:0}.statline span:last-child{color:#c5d1d7;text-align:right}.danger{color:#ff6f83}.good{color:#74f2b6}.toast{position:fixed;left:50%;bottom:20px;transform:translate(-50%,14px);opacity:0;pointer-events:none;padding:8px 11px;border-radius:3px;background:#0d1516ee;border:1px solid #2b6556;color:#b9ffe9;font:800 9px ui-monospace,monospace;transition:.15s;z-index:2147483647}.toast.show{opacity:1;transform:translate(-50%,0)}@media(max-width:760px){.panel{border-radius:3px;flex-direction:column}.panel aside{width:100%;height:58px;border-right:0;border-bottom:1px solid var(--line);display:block;flex-shrink:0;overflow:hidden}.brand{display:none}.panel nav{box-sizing:border-box;width:100%;height:58px;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));grid-template-rows:repeat(2,24px);overflow:hidden;padding:4px;gap:2px}.panel nav button{min-width:0;width:100%;text-align:center;padding:2px 1px;font-size:0;touch-action:manipulation}.panel nav button:before{content:attr(data-short);font-size:8px;line-height:1}.sidefoot{display:none}main{min-height:0}.card,.card.third{grid-column:1/-1}header{height:42px;padding:0 8px}header p{display:none}.content{padding:6px}.row{margin:6px 0}.orb{right:6px;top:auto;bottom:74px;width:38px;height:38px}.metric{font-size:18px}select,input[type=text],input[type=number],input[type=file]{max-width:60%}}`;}
    applyViewport(){const w=Math.max(320,innerWidth),h=Math.max(320,innerHeight),mobile=this.app.device?.mobile||w<760;this.host.dataset.mode=mobile?'mobile':'desktop';if(mobile){this.panel.style.left='3px';this.panel.style.top='3px';this.panel.style.width=Math.max(312,w-6)+'px';this.panel.style.height=Math.max(300,h-6)+'px';this.panel.style.transform='none';}else{const pw=Math.min(820,w-28),ph=Math.min(560,h-54);this.panel.style.width=pw+'px';this.panel.style.height=ph+'px';this.panel.style.left=Math.max(8,(w-pw)/2)+'px';this.panel.style.top=Math.max(18,(h-ph)/2)+'px';this.panel.style.transform='none';}}
    drag(){let sx=0,sy=0,sl=0,st=0,drag=false;const h=this.shadow.querySelector('header');h.addEventListener('pointerdown',e=>{if(e.target.closest('button'))return;drag=true;sx=e.clientX;sy=e.clientY;const r=this.panel.getBoundingClientRect();sl=r.left;st=r.top;h.setPointerCapture?.(e.pointerId)});h.addEventListener('pointermove',e=>{if(!drag)return;const x=clamp(sl+e.clientX-sx,0,innerWidth-100),y=clamp(st+e.clientY-sy,0,innerHeight-60);this.panel.style.left=x+'px';this.panel.style.top=y+'px'});h.addEventListener('pointerup',()=>drag=false);}
    toast(msg){const t=this.shadow.querySelector('.toast');t.textContent=msg;t.classList.add('show');clearTimeout(this._toastTimer);this._toastTimer=setTimeout(()=>t.classList.remove('show'),2200);}
    showRenderError(err){this.app.uiError=err?.message||String(err);const c=this.shadow.querySelector('.content');if(c)c.innerHTML=`<div class="card full"><h3>UI ERROR</h3><div class="danger">${this.app.uiError}</div><div class="muted">Tab input is still active. Select another tab or reload Raven.</div></div>`;this.app.log(`UI render: ${this.app.uiError}`);}
    bindToggle(id,obj,key,onChange){const el=this.shadow.getElementById(id);if(!el)return;el.checked=!!obj[key];el.onchange=()=>{obj[key]=el.checked;this.app.store.save();onChange?.(el.checked);};}
    bindRange(id,obj,key,fmt,onChange){const el=this.shadow.getElementById(id),out=this.shadow.getElementById(id+'-v');if(!el)return;el.value=obj[key];const paint=()=>{obj[key]=Number(el.value);if(out)out.textContent=fmt?fmt(obj[key]):obj[key];this.app.store.save();onChange?.(obj[key]);};paint();el.oninput=paint;}
    bindSelect(id,obj,key,onChange){const el=this.shadow.getElementById(id);if(!el)return;el.value=obj[key];el.onchange=()=>{obj[key]=el.value;this.app.store.save();onChange?.(el.value);};}
    render(){const c=this.shadow.querySelector('.content');try{const a=this.app,s=a.store.data;
      const toggle=(id,label,val)=>`<div class="row"><label for="${id}">${label}</label><input id="${id}" class="toggle" type="checkbox" ${val?'checked':''}></div>`;
      const range=(id,label,val,min,max,step=1,suffix='')=>`<div class="row"><label>${label}</label><span class="muted" id="${id}-v">${val}${suffix}</span></div><input id="${id}" class="range" type="range" min="${min}" max="${max}" step="${step}" value="${val}">`;
      const select=(id,label,val,opts)=>`<div class="row"><label>${label}</label><select id="${id}">${opts.map(o=>`<option value="${o[0]}" ${o[0]===val?'selected':''}>${o[1]}</option>`).join('')}</select></div>`;
      if(this.activeTab==='Dashboard') c.innerHTML=`<div class="grid"><div class="card third"><h3>MODEL FPS</h3><div class="metric m-model">${a.activeVision.modelFps.toFixed(1)}</div><div class="muted">local inference</div></div><div class="card third"><h3>INFERENCE</h3><div class="metric m-ms">${a.activeVision.inferenceMs.toFixed(1)} ms</div><div class="muted">rolling average</div></div><div class="card third"><h3>STREAM FPS</h3><div class="metric m-stream">${a.metrics.streamFps.toFixed(0)}</div><div class="muted">video callback</div></div><div class="card full"><h3>SESSION</h3><div class="statline"><span>Vision model</span><span class="s-model">${a.activeVision.modelName}</span></div><div class="statline"><span>Backend</span><span class="s-backend">${a.activeVision.backend}</span></div><div class="statline"><span>Input adapter</span><span class="s-input">${a.input.resolveAdapter()}</span></div><div class="statline"><span>ESP32-S3</span><span class="s-bridge">${a.bridge.connected?'Connected':'Offline'}</span></div><div class="statline"><span>Controller</span><span class="s-controller">${a.controllerName}</span></div></div><div class="card full"><h3>MASTER</h3>${toggle('masterAim','Aim engine',s.aim.enabled)}${toggle('masterVision','Vision engine',s.vision.enabled)}${toggle('masterVisuals','Overlay',s.visuals.enabled)}</div></div>`;
      if(this.activeTab==='Aim') c.innerHTML=`<div class="grid"><div class="card full"><h3>AIM ENGINE</h3>${toggle('aimEnabled','Enabled',s.aim.enabled)}${select('activation','Activation',s.aim.activation,[['hold','Hold input'],['toggle','Toggle (F8)'],['always','Always']])}${select('aimTarget','Aim point',s.aim.target,[['head','Head'],['chest','Chest'],['hip','Hip']])}${range('fov','FOV radius',s.aim.fov,40,380,1,' px')}${range('smooth','Smoothing',s.aim.smoothing,.02,1,.01,'')}${range('maxstep','Max step',s.aim.maxStep,2,80,1,' px')}${range('deadzone','Deadzone',s.aim.deadzone,0,20,.5,' px')}${range('pred','Prediction',s.aim.predictionMs,0,150,1,' ms')}</div></div>`;
      if(this.activeTab==='Vision') c.innerHTML=`<div class="grid"><div class="card full"><h3>AI DETECTOR</h3>${toggle('visionEnabled','Detector enabled',s.vision.enabled)}${select('engine','Detection engine',s.vision.engine,[['auto','Auto • Fortnite YOLO first'],['yolo26','Fortnite YOLO11n'],['pose','MoveNet fallback']])}<div class="row"><label>Fortnite ONNX URL</label><input id="yolourl" type="text" value="${s.vision.yoloUrl||''}" placeholder="raw .onnx URL"></div><div class="row"><label>Local Fortnite model</label><input id="yolofile" type="file" accept=".onnx,application/octet-stream"></div>${range('yoloconf','YOLO confidence',s.vision.yoloConfidence,.05,.9,.01,'')}${range('yoloiou','YOLO NMS IoU',s.vision.yoloIou,.1,.9,.01,'')}${select('model','Pose fallback',s.vision.model,[['lightning','MoveNet Lightning • fast'],['thunder','MoveNet Thunder • quality']])}${select('backend','Pose backend',s.vision.backend,[['auto','Auto • WebGPU first'],['webgpu','WebGPU'],['webgl','WebGL'],['cpu','CPU']])}${range('score','Minimum pose score',s.vision.minScore,.05,.9,.01,'')}${range('kpscore','Keypoint score',s.vision.keypointScore,.05,.9,.01,'')}${toggle('adaptive','Adaptive inference scheduler',s.vision.adaptive)}${range('targetfps','Target model FPS',s.vision.targetFps,6,60,1,' fps')}<div class="row"><button class="btn primary" id="loadYolo">LOAD FORTNITE MODEL</button><button class="btn" id="reloadModel">LOAD POSE FALLBACK</button></div><div class="statline"><span>Active model</span><span>${a.activeVision.modelName}</span></div><div class="statline"><span>Runtime</span><span>${a.activeVision.backend}</span></div><div class="statline"><span>Detections</span><span>${a.yolo.ready?a.yolo.detections.length:(a.vision.lastPose?1:0)}</span></div></div></div>`;
      if(this.activeTab==='Visuals') c.innerHTML=`<div class="grid"><div class="card full"><h3>OVERLAY</h3>${toggle('visualEnabled','Enabled',s.visuals.enabled)}${toggle('boxes','Corner boxes',s.visuals.boxes)}${toggle('skel','Skeleton',s.visuals.skeleton)}${toggle('points','Keypoints',s.visuals.keypoints)}${toggle('fovvis','FOV circle',s.visuals.fov)}${toggle('tline','Target line',s.visuals.targetLine)}${toggle('rgb','RGB accent',s.visuals.rgb)}${range('linewidth','Line width',s.visuals.lineWidth,.5,4,.1,' px')}</div></div>`;
      if(this.activeTab==='Input') c.innerHTML=`<div class="grid"><div class="card full"><h3>INPUT ROUTER</h3>${select('adapter','Output adapter',s.input.adapter,[['auto','Auto'],['pointer','Browser pointer'],['esp32','ESP32-S3']])}${range('mousegain','Mouse gain',s.input.mouseGain,.1,3,.05,'×')}${range('controllergain','Controller gain',s.input.controllerGain,.1,3,.05,'×')}${range('touchgain','Touch gain',s.input.touchGain,.1,3,.05,'×')}${toggle('invertY','Invert Y',s.input.invertY)}${toggle('mobileTouch','Mobile touch assist',s.input.mobileTouch)}${toggle('touchHold','Touch hold activation',s.aim.touchHold)}${range('touchstrength','Touch assist strength',s.input.touchAssistStrength,.05,1,.05,'')}${range('controllerbtn','Controller aim button',s.aim.controllerButton,0,16,1,'') }<div class="statline"><span>Detected controller</span><span>${a.controllerName}</span></div><div class="statline"><span>Touch</span><span>${a.device.touch?'Yes':'No'}</span></div><div class="muted">Activation supports right mouse hold, controller trigger button index ${s.aim.controllerButton}, touch hold on the right side, F8 toggle, or always-on mode.</div></div></div>`;
      if(this.activeTab==='ESP32-S3') c.innerHTML=`<div class="grid"><div class="card full"><h3>RAVENLINK</h3>${toggle('espEnabled','Enable bridge',s.esp32.enabled)}<div class="row"><label>WebSocket URL</label><input id="espurl" type="text" value="${s.esp32.url}"></div>${range('esphz','Send rate',s.esp32.sendHz,20,240,1,' Hz')}<div class="row"><button class="btn primary" id="espConnect">CONNECT</button><button class="btn" id="espPing">PING</button><span class="muted">${a.bridge.connected?'ONLINE':'OFFLINE'}${a.bridge.latency!=null?` • ${a.bridge.latency.toFixed(1)} ms`:''}</span></div><div class="muted">Wi-Fi/WebSocket is the portable browser path. iOS browsers do not expose the same USB/BLE browser APIs as desktop Chromium, so RavenLink uses network transport here.</div></div></div>`;
      if(this.activeTab==='Performance') c.innerHTML=`<div class="grid"><div class="card full"><h3>PERFORMANCE POLICY</h3>${toggle('highperf','High performance',s.perf.highPerformance)}${toggle('suspend','Suspend inference when hidden',s.perf.suspendWhenHidden)}${toggle('adaptive2','Adaptive scheduler',s.vision.adaptive)}${range('overlayfps','Overlay FPS cap',s.perf.overlayFps,15,120,1,' fps')}<div class="statline"><span>Tensor backend</span><span>${a.activeVision.backend}</span></div><div class="statline"><span>Model FPS</span><span>${a.activeVision.modelFps.toFixed(1)}</span></div><div class="statline"><span>Inference</span><span>${a.activeVision.inferenceMs.toFixed(1)} ms</span></div><div class="statline"><span>Render FPS</span><span>${a.metrics.renderFps.toFixed(0)}</span></div></div></div>`;
      if(this.activeTab==='Device') c.innerHTML=`<div class="grid"><div class="card full"><h3>DEVICE DETECTION</h3>${Object.entries({Platform:a.device.label,CPU:`${a.device.cores??'Unknown'} logical cores`,Memory:a.device.memory?`${a.device.memory} GB hint`:'Unavailable',GPU:a.device.gpu,Screen:a.device.screenInfo,Viewport:`${a.device.viewportWidth}×${a.device.viewportHeight} • ${a.device.orientation}`,WebGPU:a.device.webgpu?'Supported':'Unavailable',Touch:a.device.touch?'Supported':'No',GamepadAPI:a.device.gamepad?'Supported':'Unavailable',VideoFrameCallback:a.device.rvfc?'Supported':'Unavailable'}).map(([k,v])=>`<div class="statline"><span>${k}</span><span>${v}</span></div>`).join('')}</div></div>`;
      if(this.activeTab==='Settings') c.innerHTML=`<div class="grid"><div class="card full"><h3>RAVEN</h3><div class="statline"><span>Build</span><span>${BUILD}</span></div><div class="statline"><span>Toggle UI</span><span>Alt + Shift + R</span></div><div class="statline"><span>Toggle aim</span><span>F8</span></div><div class="row"><button class="btn" id="reset">RESET SETTINGS</button><button class="btn danger" id="destroy">UNLOAD RAVEN</button></div><div class="muted">Settings are stored locally in this browser. Inference stays on-device; model/runtime assets are fetched from pinned CDN URLs and then use normal browser caching.</div></div></div>`;
      this.bindCurrent(); this.renderStatus();
      }catch(e){this.showRenderError(e);}
    }
    bindCurrent(){const s=this.app.store.data;
      [['masterAim',s.aim,'enabled'],['aimEnabled',s.aim,'enabled'],['masterVision',s.vision,'enabled'],['visionEnabled',s.vision,'enabled'],['masterVisuals',s.visuals,'enabled'],['visualEnabled',s.visuals,'enabled'],['adaptive',s.vision,'adaptive'],['adaptive2',s.vision,'adaptive'],['boxes',s.visuals,'boxes'],['skel',s.visuals,'skeleton'],['points',s.visuals,'keypoints'],['fovvis',s.visuals,'fov'],['tline',s.visuals,'targetLine'],['rgb',s.visuals,'rgb'],['invertY',s.input,'invertY'],['mobileTouch',s.input,'mobileTouch'],['touchHold',s.aim,'touchHold'],['espEnabled',s.esp32,'enabled'],['highperf',s.perf,'highPerformance'],['suspend',s.perf,'suspendWhenHidden']].forEach(x=>this.bindToggle(...x,x[0]==='espEnabled'?v=>v?this.app.bridge.connect():this.app.bridge.disconnect():null));
      [['fov',s.aim,'fov',v=>`${v|0} px`],['smooth',s.aim,'smoothing',v=>v.toFixed(2)],['maxstep',s.aim,'maxStep',v=>`${v|0} px`],['deadzone',s.aim,'deadzone',v=>`${v.toFixed(1)} px`],['pred',s.aim,'predictionMs',v=>`${v|0} ms`],['controllerbtn',s.aim,'controllerButton',v=>`${v|0}`],['score',s.vision,'minScore',v=>v.toFixed(2)],['kpscore',s.vision,'keypointScore',v=>v.toFixed(2)],['yoloconf',s.vision,'yoloConfidence',v=>v.toFixed(2)],['yoloiou',s.vision,'yoloIou',v=>v.toFixed(2)],['targetfps',s.vision,'targetFps',v=>`${v|0} fps`],['linewidth',s.visuals,'lineWidth',v=>`${v.toFixed(1)} px`],['mousegain',s.input,'mouseGain',v=>`${v.toFixed(2)}×`],['controllergain',s.input,'controllerGain',v=>`${v.toFixed(2)}×`],['touchgain',s.input,'touchGain',v=>`${v.toFixed(2)}×`],['touchstrength',s.input,'touchAssistStrength',v=>v.toFixed(2)],['esphz',s.esp32,'sendHz',v=>`${v|0} Hz`],['overlayfps',s.perf,'overlayFps',v=>`${v|0} fps`]].forEach(x=>this.bindRange(...x));
      this.bindSelect('activation',s.aim,'activation');this.bindSelect('aimTarget',s.aim,'target');this.bindSelect('adapter',s.input,'adapter');
      this.bindSelect('engine',s.vision,'engine',()=>this.app.ensureDetector());
      this.bindSelect('model',s.vision,'model',()=>this.app.vision.loadModel(true)); this.bindSelect('backend',s.vision,'backend',()=>this.app.vision.loadModel(true));
      const rm=this.shadow.getElementById('reloadModel');if(rm)rm.onclick=async()=>{await this.app.loader.ensure();await this.app.vision.loadModel(true);s.vision.engine='pose';this.app.store.save();this.render();};
      const yu=this.shadow.getElementById('yolourl');if(yu)yu.onchange=()=>{s.vision.yoloUrl=yu.value.trim();this.app.store.save();};
      const yf=this.shadow.getElementById('yolofile');if(yf)yf.onchange=async()=>{const file=yf.files?.[0];if(!file)return;try{await this.app.yolo.loadFile(file);s.vision.engine='yolo26';this.app.store.save();this.render();}catch(e){this.app.toast(`YOLO load failed: ${e.message}`);}};
      const yl=this.shadow.getElementById('loadYolo');if(yl)yl.onclick=async()=>{try{const file=yf?.files?.[0];if(file)await this.app.yolo.loadFile(file);else await this.app.yolo.loadUrl(yu?.value||s.vision.yoloUrl);s.vision.engine='yolo26';s.vision.yoloUrl=yu?.value.trim()||s.vision.yoloUrl;this.app.store.save();this.render();}catch(e){this.app.toast(`YOLO load failed: ${e.message}`);}};
      const url=this.shadow.getElementById('espurl');if(url)url.onchange=()=>{s.esp32.url=url.value.trim();this.app.store.save();};
      const ec=this.shadow.getElementById('espConnect');if(ec)ec.onclick=()=>this.app.bridge.connect(); const ep=this.shadow.getElementById('espPing');if(ep)ep.onclick=()=>this.app.bridge.ping();
      const reset=this.shadow.getElementById('reset');if(reset)reset.onclick=()=>{this.app.store.reset();this.app.toast('Settings reset');this.render();};
      const destroy=this.shadow.getElementById('destroy');if(destroy)destroy.onclick=()=>this.app.destroy();
    }
    renderStatus(){const a=this.app;const b=this.shadow.querySelector('.backend');if(b)b.textContent=`${a.activeVision.backend.toUpperCase()} • ${a.activeVision.modelFps.toFixed(0)} FPS`;const bs=this.shadow.querySelector('.bridge-state');if(bs)bs.textContent=a.bridge.connected?'ESP32 ONLINE':'LOCAL';const dot=this.shadow.querySelector('.dot');if(dot)dot.style.background=(a.yolo.ready||a.vision.detector)?'#4cff9a':'#ffb84c';const set=(q,v)=>{const e=this.shadow.querySelector(q);if(e)e.textContent=v};set('.m-model',a.activeVision.modelFps.toFixed(1));set('.m-ms',`${a.activeVision.inferenceMs.toFixed(1)} ms`);set('.m-stream',a.metrics.streamFps.toFixed(0));set('.s-model',a.activeVision.modelName);set('.s-backend',a.activeVision.backend);set('.s-input',a.input.resolveAdapter());set('.s-bridge',a.bridge.connected?'Connected':'Offline');set('.s-controller',a.controllerName);}
    destroy(){clearInterval(this.statusTimer);if(this._resize){removeEventListener('resize',this._resize);removeEventListener('orientationchange',this._resize);}this.host.remove();}
  }

  class RavenApp {
    constructor(){this.running=true;this.store=new RavenStore();this.logs=[];this.device=null;this.controllerName='None';this.detectorError='';this.uiError='';this.locator=new VideoLocator();this.loader=new LibraryLoader(m=>this.log(m));this.vision=new VisionRuntime(this);this.yolo=new Yolo26Runtime(this);this.bridge=new RavenBridge(this);this.activation=null;this.input=null;this.metrics=new StreamMetrics(this);this.overlay=null;this.ui=null;this.loopHandle=0;this.lastOverlay=0;}
    log(m){this.logs.push({t:Date.now(),m});if(this.logs.length>100)this.logs.shift();console.info('[Raven]',m);}
    toast(m){this.ui?.toast(m);}
    async boot(){
      this.device=await DeviceProfile.detect();
      this.applyDeviceTuning();
      this.activation=new ActivationState(this);
      this.input=new InputRouter(this);
      this.overlay=new Overlay(this);
      this.ui=new RavenUI(this);
      this.toast(`Raven ${BUILD} • ${this.device.label}`);
      try{await this.ensureDetector();this.detectorError='';}
      catch(e){this.detectorError=e?.message||String(e);this.log(`Detector boot: ${this.detectorError}`);this.toast('Detector not ready • open AI tab');}
      await this.waitForVideo();
      if(this.store.data.esp32.enabled) this.bridge.connect();
      this.loop();
    }
    applyDeviceTuning(){
      const s=this.store.data, d=this.device;
      const low=(d.cores&&d.cores<=4)||(d.memory&&d.memory<=4);
      if(d.mobile){
        s.vision.targetFps=d.webgpu?(low?30:45):(low?12:20);
        s.vision.intervalMs=0;
        s.perf.overlayFps=d.webgpu?30:20;
        s.visuals.skeleton=false; s.visuals.keypoints=false; s.visuals.rgb=false;
        s.aim.fov=clamp(Math.round(d.shortSide*.22),90,190);
        s.input.mobileTouch=true;
      }else{
        s.vision.targetFps=d.webgpu?60:30;
        s.vision.intervalMs=0;
        s.perf.overlayFps=d.webgpu?60:30;
      }
      this.store.save();
    }
    get activeVision(){ if(this.yolo.ready&&this.store.data.vision.engine!=='pose')return this.yolo;if(this.vision.detector)return this.vision;return this.yolo; }
    async ensureDetector(){
      const cfg=this.store.data.vision;
      this.detectorError='';
      if(cfg.engine==='yolo26'||cfg.engine==='auto'){
        if(cfg.yoloUrl){
          try{await this.yolo.loadUrl(cfg.yoloUrl);return;}catch(e){this.detectorError=e.message;this.log(`YOLO URL load failed: ${e.message}`);}
        }
        try{if(await this.yolo.loadCached()) return;}catch(e){this.detectorError=e.message;this.log(`Cached YOLO load failed: ${e.message}`);}
        if(cfg.engine==='yolo26') throw new Error(this.detectorError||'Fortnite model not loaded. Pick weights-3.onnx in AI MODEL.');
      }
      try{await this.loader.ensure();await this.vision.loadModel();this.detectorError='';}
      catch(e){this.detectorError=e.message;throw e;}
    }
    async waitForVideo(){for(let i=0;i<180&&this.running;i++){const v=this.locator.find();if(v){this.metrics.start(v);this.toast('xCloud stream attached');return v;}await sleep(500);}this.log('No live video found yet; continuing discovery in loop.');return null;}
    loop=async()=>{
      if(!this.running)return;
      let video=this.locator.video;
      if(!video||!document.contains(video)||video.readyState<2){const old=video;video=this.locator.find();if(video&&video!==old)this.metrics.start(video);}
      let target=null;
      if(video&&this.yolo.ready&&this.store.data.vision.engine!=='pose'){
        const detections=await this.yolo.run(video);
        if(detections?.length) target=this.yolo.targetPoint();
      }else if(video&&this.vision.detector){
        const pose=await this.vision.run(video);
        if(pose) target=this.vision.targetPoint(pose);
      }
      if(target) await this.input.apply(target);
      const t=now(), cap=clamp(this.store.data.perf.overlayFps,15,120);if(t-this.lastOverlay>=1000/cap){this.lastOverlay=t;this.overlay.draw();}
      this.loopHandle=requestAnimationFrame(this.loop);
    }
    destroy(){if(!this.running)return;this.running=false;cancelAnimationFrame(this.loopHandle);this.metrics.stop();this.bridge.disconnect();this.input?.destroy();this.activation?.destroy();this.overlay?.destroy();this.ui?.destroy();try{this.vision.detector?.dispose?.();}catch{}try{this.yolo?.dispose?.();}catch{}delete window[NS];console.info('[Raven] Unloaded');}
  }

  const app=new RavenApp();
  window[NS]=app;
  app.boot().catch(e=>{console.error('[Raven] Boot failed',e);app.toast?.(`Boot failed: ${e.message}`);});
})();
