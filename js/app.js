import * as store from './store.js';
import { Renderer } from './gl.js';
import { labStats, transferParams, lerpStats } from './color.js';
import {
  initPose, detectImage, detectVideo, measure, shotType, solveCrop, poseSimilarity,
  LIMBS, SHOT_LABEL, ZOOM_MAX, ZOOM_MIN,
} from './pose.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const HOLD_MS = 900;        // 자리가 맞은 채로 이만큼 유지되면 자동 촬영
const REARM_MS = 5000;      // 같은 자리에 계속 있으면 이 간격으로 한 장씩 더 찍는다

// 보정 필터: 밝기(스톱), 대비, 채도, 색온도, 바랜 느낌
const FILTERS = {
  none: { name: '없음' },
  bright: { name: '화사', exp: 0.18, con: 0.95, sat: 1.05, temp: 0.05, fade: 0.04 },
  film: { name: '필름', con: 0.92, sat: 0.9, temp: 0.15, fade: 0.1 },
  cool: { name: '쿨', exp: 0.05, sat: 0.95, temp: -0.25 },
  warm: { name: '웜', sat: 1.05, temp: 0.3 },
  vivid: { name: '선명', con: 1.15, sat: 1.2 },
  mono: { name: '흑백', con: 1.1, sat: 0 },
  vintage: { name: '빈티지', con: 0.9, sat: 0.75, temp: 0.25, fade: 0.16, vig: 0.35 },
  cream: { name: '크림', exp: 0.22, con: 0.9, sat: 0.92, temp: 0.12, fade: 0.08 },
  fresh: { name: '청량', exp: 0.1, con: 1.05, sat: 1.08, temp: -0.15, vib: 0.3 },
  sunset: { name: '노을', con: 1.05, sat: 1.12, temp: 0.42, vig: 0.2 },
  mood: { name: '무드', exp: -0.15, con: 1.12, sat: 0.85, temp: -0.05, fade: 0.06, vig: 0.45 },
  pop: { name: '팝', con: 1.1, sat: 1.1, vib: 0.5 },
  monoFilm: { name: '필름 흑백', con: 0.95, sat: 0, fade: 0.14, vig: 0.4 },
};
// 한 번에 맞추는 뷰티 조합
const BEAUTY_PRESETS = [
  ['자연스럽게', { smooth: 35, bright: 20, slim: 15, eye: 10, nose: 0 }],
  ['뽀샤시', { smooth: 70, bright: 55, slim: 30, eye: 20, nose: 15 }],
  ['또렷하게', { smooth: 25, bright: 15, slim: 25, eye: 30, nose: 20 }],
];
const FX_DEFAULT = { on: false, smooth: 45, bright: 30, slim: 30, eye: 20, nose: 0, filter: 'none', filterAmt: 80, exp: 0, con: 0, sat: 0, temp: 0, vib: 0, sharp: 0, vig: 0 };
const FX_SLIDERS = {
  beauty: [['smooth', '피부 매끈하게', 0], ['bright', '화사하게', 0], ['slim', '얼굴 갸름하게', 0], ['eye', '눈 크게', 0], ['nose', '콧볼 줄이기', 0]],
  adjust: [['exp', '밝기', -100], ['con', '대비', -100], ['sat', '채도', -100], ['vib', '활기', -100], ['temp', '따뜻함', -100], ['sharp', '선명하게', 0], ['vig', '비네팅', 0]],
};
const RATIOS = [['3:4', 3 / 4], ['9:16', 9 / 16], ['1:1', 1], ['4:3', 4 / 3]];
const ZOOMS = [1, 2, 3];
// 가이드 없이 찍는 일반 촬영용 목표(구도·색감 맞춤 없음)
const PLAIN = { id: 'plain', plain: true, aspect: store.getPref('plainAspect', 3 / 4), m: null, pts: null, lab: null, shot: 'scene' };

const S = {
  fx: { ...FX_DEFAULT, ...store.getPref('fx', {}) },
  tapShot: store.getPref('tapShot', false), mirrorSave: store.getPref('mirrorSave', true), stamp: store.getPref('stamp', false), fxBypass: false,
  timer: store.getPref('timer', 0), countdown: 0, zoom: 1, torch: false, face: null, faceMiss: 0,
  refs: [], shots: [],
  target: null, pinnedId: null,
  facing: 'environment',
  auto: store.getPref('auto', true),
  voice: store.getPref('voice', false),
  ghost: store.getPref('ghost', false),
  color: store.getPref('color', true),
  running: false, stream: null, track: null, src: null,
  live: null, sol: null, cropS: null,
  zS: null, dxS: 0, dyS: 0,
  liveStats: null, roll: null,
  lastDet: 0, lastStats: 0, lastExp: 0, ev: 0, expCap: null,
  alignedSince: 0, lastAlignedAt: 0, armed: true, lastShotAt: 0, misalignedSince: 0,
  hintKey: '', hintPending: '', hintPendingAt: 0, lastSpoken: 0,
  viewIdx: 0, busy: false,
};

const video = document.createElement('video');
video.playsInline = true;
video.muted = true;
video.setAttribute('playsinline', '');

const detCanvas = document.createElement('canvas');
const detCtx = detCanvas.getContext('2d', { willReadFrequently: true });
const tinyCanvas = document.createElement('canvas');
tinyCanvas.width = tinyCanvas.height = 12;
const tinyCtx = tinyCanvas.getContext('2d', { willReadFrequently: true });

let viewR = null, capR = null, audioCtx = null, wakeLock = null, poseReady = null;

/* ------------------------------------------------------------------ */
/* 공통                                                                */
/* ------------------------------------------------------------------ */

let toastTimer = 0;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function ensurePose() {
  if (!poseReady) poseReady = initPose();
  return poseReady;
}

async function loadBitmap(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function layoutSignature(ctx, sx, sy, sw, sh, srcEl, mirror) {
  tinyCtx.save();
  if (mirror) { tinyCtx.translate(12, 0); tinyCtx.scale(-1, 1); }
  tinyCtx.drawImage(srcEl, sx, sy, sw, sh, 0, 0, 12, 12);
  tinyCtx.restore();
  const d = tinyCtx.getImageData(0, 0, 12, 12).data;
  const g = new Array(144);
  let mean = 0;
  for (let i = 0; i < 144; i++) { g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; mean += g[i]; }
  mean /= 144;
  let v = 0;
  for (let i = 0; i < 144; i++) { g[i] -= mean; v += g[i] * g[i]; }
  const n = Math.sqrt(v) || 1;
  return g.map((x) => x / n);
}

/* ------------------------------------------------------------------ */
/* 좋아하는 사진 분석                                                   */
/* ------------------------------------------------------------------ */

async function analyze(blob) {
  await ensurePose();
  const bmp = await loadBitmap(blob);
  const W = bmp.width, H = bmp.height;
  const aspect = clamp(W / H, 9 / 16, 16 / 9);
  // 극단적인 비율(파노라마 등)은 가운데를 잘라서 쓴다.
  let sw = W, sh = H;
  if (W / H > aspect) sw = H * aspect; else if (W / H < aspect) sh = W / aspect;
  const sx = (W - sw) / 2, sy = (H - sh) / 2;

  const scale = Math.min(1, 900 / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();

  const pts = detectImage(c);
  const sc = document.createElement('canvas');
  const k = Math.min(1, 160 / Math.max(c.width, c.height));
  sc.width = Math.max(1, Math.round(c.width * k));
  sc.height = Math.max(1, Math.round(c.height * k));
  const sctx = sc.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(c, 0, 0, sc.width, sc.height);
  const lab = labStats(sctx.getImageData(0, 0, sc.width, sc.height));
  const layout = layoutSignature(ctx, 0, 0, c.width, c.height, c, false);
  const thumb = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));

  // 어깨조차 안 보이면 인물 사진으로 보지 않는다.
  const person = pts && (pts[11][2] || pts[12][2] || pts[0][2]) ? pts : null;
  return {
    id: store.newId(),
    blob: thumb,
    aspect: c.width / c.height,
    lab,
    pts: person,
    shot: person ? shotType(person) : 'scene',
    layout,
    createdAt: Date.now(),
  };
}

function hydrateRef(r) {
  r.url = URL.createObjectURL(r.blob);
  r.m = r.pts ? measure(r.pts, r.aspect) : null;
  // 기준 길이를 하나도 못 구한 인물 사진은 풍경처럼 다룬다.
  if (r.m && !(r.m.torso || r.m.neck || r.m.shoulderW || r.m.face)) r.m = null;
  return r;
}

async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('image/'));
  if (!list.length) return;
  const status = $('analyzing');
  status.hidden = false;
  let done = 0, failed = 0;
  for (const f of list) {
    status.textContent = `사진을 분석하고 있어요 (${done + 1}/${list.length})`;
    try {
      const ref = await analyze(f);
      await store.put('refs', { ...ref });
      S.refs.push(hydrateRef(ref));
      renderHome();
    } catch (e) {
      console.error(e);
      failed++;
    }
    done++;
  }
  status.hidden = true;
  if (failed) toast(`${failed}장은 읽지 못했어요. 다른 사진으로 시도해 주세요.`, 3200);
}

/* ------------------------------------------------------------------ */
/* 취향 요약과 자동 목표 선택                                           */
/* ------------------------------------------------------------------ */

function dominantShot() {
  const persons = S.refs.filter((r) => r.m);
  if (!persons.length) return null;
  const counts = {};
  for (const r of persons) counts[r.shot] = (counts[r.shot] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { shot: top[0], count: top[1], total: S.refs.length, group: persons.filter((r) => r.shot === top[0]) };
}

// 가장 많이 좋아한 구도(예: 상반신) 중에서 가장 대표적인 한 장을 목표로 삼는다.
function autoTarget() {
  if (!S.refs.length) return null;
  const dom = dominantShot();
  if (!dom) return S.refs[S.refs.length - 1];
  const feat = (r) => {
    const a = r.m.sh || r.m.nose || { x: r.aspect / 2, y: 0.4 };
    return [a.x / r.aspect, a.y, r.m.shoulderW || (r.m.face || 0.1) * 2];
  };
  const fs = dom.group.map(feat);
  let best = 0, bestSum = Infinity;
  fs.forEach((f, i) => {
    const sum = fs.reduce((s, g) => s + Math.hypot(f[0] - g[0], f[1] - g[1], f[2] - g[2]), 0);
    if (sum < bestSum) { bestSum = sum; best = i; }
  });
  return dom.group[best];
}

function tasteText() {
  const dom = dominantShot();
  const n = S.refs.length;
  const L = S.refs.reduce((s, r) => s + r.lab.mean[0], 0) / n;
  const b = S.refs.reduce((s, r) => s + r.lab.mean[2], 0) / n;
  const tone = [
    L > 62 ? '밝은 톤' : L < 45 ? '차분하고 어두운 톤' : '자연스러운 밝기',
    b > 10 ? '따뜻한 색감' : b < 2 ? '시원한 색감' : '중립 색감',
  ].join(' · ');
  if (!dom) return { main: '풍경·사물 사진을 좋아하시네요', sub: `${n}장 · ${tone}` };
  return {
    main: `주로 ${SHOT_LABEL[dom.shot]} 사진을 좋아하시네요`,
    sub: `${n}장 중 ${dom.count}장이 ${SHOT_LABEL[dom.shot]} · ${tone}`,
  };
}

/* ------------------------------------------------------------------ */
/* 홈 화면                                                             */
/* ------------------------------------------------------------------ */

function renderHome() {
  const grid = $('refGrid');
  grid.textContent = '';
  for (const r of S.refs) {
    const card = document.createElement('div');
    card.className = 'ref-card';
    const img = document.createElement('img');
    img.src = r.url;
    img.alt = `좋아하는 사진 (${SHOT_LABEL[r.shot]})`;
    const tag = document.createElement('span');
    tag.className = 'ref-tag';
    tag.textContent = SHOT_LABEL[r.shot];
    const del = document.createElement('button');
    del.className = 'ref-del';
    del.textContent = '×';
    del.setAttribute('aria-label', '이 사진 빼기');
    del.onclick = async () => {
      await store.del('refs', r.id);
      URL.revokeObjectURL(r.url);
      S.refs = S.refs.filter((x) => x.id !== r.id);
      if (S.pinnedId === r.id) S.pinnedId = null;
      renderHome();
    };
    card.append(img, tag, del);
    grid.append(card);
  }
  const add = document.createElement('label');
  add.className = 'ref-add';
  add.htmlFor = 'filePick';
  const plus = document.createElement('span');
  plus.textContent = '+';
  add.append(plus, document.createTextNode('사진 추가'));
  grid.append(add);

  const has = S.refs.length > 0;
  $('empty').hidden = has;
  $('taste').hidden = !has;
  $('refCount').textContent = has ? `${S.refs.length}장` : '';
  $('openCam').textContent = has ? '카메라 열기' : '일반 카메라로 열기';
  if (has) {
    const t = tasteText();
    $('tasteMain').textContent = t.main;
    $('tasteSub').textContent = t.sub;
  }
}

/* ------------------------------------------------------------------ */
/* 카메라                                                              */
/* ------------------------------------------------------------------ */

const testSrc = new URLSearchParams(location.search).get('src');

function stopStream() {
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  S.stream = null;
  S.track = null;
}

async function startSource() {
  stopStream();
  $('camError').hidden = true;
  if (testSrc) {
    // 개발 확인용: 카메라 대신 파일을 입력으로 쓴다 (?src=경로).
    if (/\.(mp4|mov|webm)$/i.test(testSrc)) {
      video.src = testSrc;
      video.loop = true;
      await video.play();
      S.src = { el: video, w: () => video.videoWidth, h: () => video.videoHeight, ready: () => video.readyState >= 2 };
    } else {
      const img = new Image();
      img.src = testSrc;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      S.src = { el: c, w: () => c.width, h: () => c.height, ready: () => true };
    }
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: S.facing }, width: { ideal: 3840 }, height: { ideal: 2160 } },
  });
  S.stream = stream;
  S.track = stream.getVideoTracks()[0];
  S.ev = 0;
  S.expCap = null;
  try {
    const caps = S.track.getCapabilities ? S.track.getCapabilities() : {};
    if (caps.exposureCompensation) S.expCap = caps.exposureCompensation;
    S.torch = false;
    $('tTorch').hidden = !caps.torch;
    setToggle('tTorch', false);
  } catch { /* 지원하지 않는 기기 */ }
  video.srcObject = stream;
  await video.play();
  S.src = { el: video, w: () => video.videoWidth, h: () => video.videoHeight, ready: () => video.readyState >= 2 && video.videoWidth > 0 };
}

function showCamError(e) {
  const box = $('camError');
  box.textContent = '';
  const b = document.createElement('b');
  const s = document.createElement('span');
  if (e.name === 'NotAllowedError') {
    b.textContent = '카메라 권한이 필요해요';
    s.textContent = '브라우저 설정에서 이 사이트의 카메라 사용을 허용한 뒤 다시 열어 주세요.';
  } else if (e.name === 'InsecureContext') {
    b.textContent = '보안 연결(https)에서만 카메라를 쓸 수 있어요';
    s.textContent = '주소가 https:// 로 시작하는지 확인해 주세요.';
  } else if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') {
    b.textContent = '카메라를 찾지 못했어요';
    s.textContent = '카메라가 있는 기기에서 열어 주세요.';
  } else {
    b.textContent = '카메라를 열지 못했어요';
    s.textContent = String(e.message || e);
  }
  box.append(b, s);
  box.hidden = false;
}

function mirrored() {
  return !testSrc && S.facing === 'user';
}

function pickTarget() {
  const pinned = S.pinnedId && S.refs.find((r) => r.id === S.pinnedId);
  const t = S.pinnedId === 'plain' || !S.refs.length ? PLAIN : pinned || autoTarget();
  if (t !== S.target) {
    S.target = t;
    S.cropS = null;
    S.zS = null;
    S.alignedSince = 0;
    S.sceneSim = null;
    if (t.url) $('ghostImg').src = t.url;
    layoutFinder();
  }
  $('ghostImg').hidden = !S.ghost || !!t.plain;
  $('plainBar').hidden = !t.plain;
  if (t.plain) { $('gauge').hidden = true; renderPlainBar(); }
  renderStrip();
}

function renderStrip() {
  const strip = $('strip');
  strip.textContent = '';
  const auto = document.createElement('button');
  auto.className = 'strip-item' + (S.pinnedId ? '' : ' on');
  if (!S.refs.length) auto.hidden = true;
  auto.textContent = '내 취향 자동';
  auto.onclick = () => { S.pinnedId = null; pickTarget(); };
  if (S.refs.length) strip.append(auto);
  const plain = document.createElement('button');
  plain.className = 'strip-item' + (S.target && S.target.plain ? ' on' : '');
  plain.textContent = '가이드 없음';
  plain.onclick = () => { S.pinnedId = 'plain'; pickTarget(); };
  strip.append(plain);
  for (const r of S.refs) {
    const b = document.createElement('button');
    b.className = 'strip-item' + (S.pinnedId === r.id ? ' on' : '');
    b.setAttribute('aria-label', `${SHOT_LABEL[r.shot]} 사진처럼 찍기`);
    const img = document.createElement('img');
    img.src = r.url;
    img.alt = '';
    b.append(img);
    b.onclick = () => { S.pinnedId = r.id; pickTarget(); };
    strip.append(b);
  }
}

function layoutFinder() {
  if (!S.target) return;
  const stage = $('stage').getBoundingClientRect();
  if (!stage.width || !stage.height) return;
  const ar = S.target.aspect;
  const w = Math.min(stage.width, stage.height * ar);
  const h = w / ar;
  const f = $('finder');
  f.style.width = `${w}px`;
  f.style.height = `${h}px`;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (viewR) viewR.resize(pw, ph);
  const ov = $('overlay');
  ov.width = pw;
  ov.height = ph;
}

function setToggle(id, on) {
  $(id).setAttribute('aria-pressed', on ? 'true' : 'false');
}

async function openCamera() {
  $('home').hidden = true;
  $('camera').hidden = false;
  setToggle('tAuto', S.auto);
  setToggle('tVoice', S.voice);
  setToggle('tGhost', S.ghost);
  setToggle('tColor', S.color);
  setToggle('tTap', S.tapShot);
  setToggle('tMirror', S.mirrorSave);
  setToggle('tStamp', S.stamp);
  showPanel(null);
  renderTimer();
  renderFx();
  setHint('카메라를 준비하고 있어요', '', false, 'init', true);

  // 사용자 터치 직후에만 허용되는 것들을 여기서 요청한다.
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* 소리 없이 진행 */ }
  requestMotion();
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* 화면 꺼짐 방지 미지원 */ }

  try {
    if (!viewR) viewR = new Renderer($('view'));
    if (!capR) capR = new Renderer(document.createElement('canvas'), { preserve: true });
    S.target = null;
    pickTarget();
    await Promise.all([ensurePose(), startSource()]);
  } catch (e) {
    console.error(e);
    showCamError(e);
    return;
  }
  layoutFinder();
  S.running = true;
  S.armed = true;
  requestAnimationFrame(frame);
}

function closeCamera() {
  S.running = false;
  stopStream();
  try { wakeLock?.release(); } catch { /* 무시 */ }
  wakeLock = null;
  window.speechSynthesis?.cancel();
  cancelCountdown();
  $('camera').hidden = true;
  $('home').hidden = false;
  renderHome();
}

/* 기울기 센서: 화면 평면 안에서 중력 방향이 얼마나 틀어졌는지(도). */
let motionBound = false;
function requestMotion() {
  if (motionBound || typeof DeviceMotionEvent === 'undefined') return;
  const bind = () => {
    motionBound = true;
    window.addEventListener('devicemotion', (e) => {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null) return;
      if (Math.hypot(g.x, g.y) < 3) { S.roll = null; return; } // 폰이 거의 눕혀진 상태
      let deg = (Math.atan2(g.x, g.y) * 180) / Math.PI;
      deg = ((deg % 90) + 90) % 90;
      if (deg > 45) deg -= 90;
      S.roll = S.roll == null ? deg : S.roll + (deg - S.roll) * 0.25;
    });
  };
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission().then((r) => { if (r === 'granted') bind(); }).catch(() => {});
  } else {
    bind();
  }
}

/* ------------------------------------------------------------------ */
/* 안내 문구                                                           */
/* ------------------------------------------------------------------ */

function setHint(text, sub, ok, key, force) {
  const now = performance.now();
  if (!force && key !== S.hintKey) {
    // 문구가 깜빡이지 않게 같은 상태가 0.2초 이어질 때만 바꾼다.
    if (S.hintPending !== key) { S.hintPending = key; S.hintPendingAt = now; return; }
    if (now - S.hintPendingAt < 200) return;
  }
  const changed = key !== S.hintKey;
  S.hintKey = key;
  S.hintPending = key;
  const h = $('hint');
  h.textContent = text;
  h.classList.toggle('ok', !!ok);
  $('hintSub').textContent = sub || '';
  if (changed && S.voice && window.speechSynthesis && now - S.lastSpoken > 1800) {
    S.lastSpoken = now;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    u.rate = 1.1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }
}

function renderChips(chips) {
  const box = $('chips');
  const sig = chips.map((c) => c.t + c.s).join('|');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.textContent = '';
  for (const c of chips) {
    const el = document.createElement('span');
    el.className = `chip ${c.s}`;
    el.textContent = c.t;
    box.append(el);
  }
}

const DIR_WORD = { L: '왼쪽으로', R: '오른쪽으로', U: '위로', D: '아래로' };

// 현재 상태를 평가해 안내 문구·칩·정렬 여부를 정한다.
function evaluate(now) {
  const ref = S.target, sol = S.sol;
  const label = SHOT_LABEL[ref.shot];
  const chips = [];
  const out = { aligned: false, arrow: null };
  let hint = null;

  // 수평
  let levelBad = false;
  if (S.roll != null) {
    const a = Math.abs(S.roll);
    chips.push({ t: a < 3.5 ? '수평 맞음' : `수평 ${a.toFixed(0)}°`, s: a < 3.5 ? 'ok' : 'bad' });
    levelBad = a > 5;
  }
  // 밝기
  let dark = false;
  if (S.liveStats && ref.lab) {
    const diff = S.liveStats.mean[0] - ref.lab.mean[0];
    dark = S.liveStats.mean[0] < 16;
    chips.push(diff < -20 ? { t: '어두워요', s: 'bad' } : diff > 22 ? { t: '밝아요', s: 'bad' } : { t: '밝기 맞음', s: 'ok' });
  }

  if (ref.plain) {
    hint = ['', '', 'plain'];
  } else if (!ref.m) {
    // 풍경·사물: 사진을 겹쳐 보고 직접 누른다.
    $('gauge').hidden = true;
    let sim = null;
    if (S.sceneSim != null) {
      sim = S.sceneSim;
      chips.unshift({ t: `구도 닮음 ${Math.round(clamp(sim, 0, 1) * 100)}%`, s: sim > 0.55 ? 'ok' : 'bad' });
    }
    if (dark) hint = ['너무 어두워요', '밝은 곳으로 옮겨 주세요', 'dark'];
    else if (levelBad) hint = ['폰을 똑바로 세워 주세요', '', 'level'];
    else if (sim != null && sim > 0.55) { hint = ['좋아요, 지금 누르세요', '', 'scene-ok']; out.ok = true; }
    else hint = ['겹쳐 보이는 사진에 맞춰 보세요', '좋아하는 사진과 비슷한 자리에 놓이게 움직이세요', 'scene'];
    out.sceneReady = sim != null && sim > 0.55 && !dark && !levelBad;
  } else if (!sol || !sol.matched) {
    $('gauge').hidden = true;
    hint = ['사람을 화면에 담아 주세요', `${label} 구도로 맞춰 드릴게요`, 'noperson'];
    chips.unshift({ t: '인물 찾는 중', s: 'bad' });
  } else {
    const z = S.zS, dx = S.dxS, dy = S.dyS;
    const distOk = z >= ZOOM_MIN && z <= ZOOM_MAX;
    const posOk = Math.abs(dx) < 0.045 && Math.abs(dy) < 0.045;
    chips.unshift({ t: posOk ? '위치 맞음' : '위치 조정', s: posOk ? 'ok' : 'bad' });
    chips.unshift({ t: distOk ? '거리 맞음' : z > ZOOM_MAX ? '멀어요' : '가까워요', s: distOk ? 'ok' : 'bad' });

    // 거리 게이지
    const gauge = $('gauge');
    gauge.hidden = false;
    const pos = clamp(50 - Math.log2(z) * 30, 4, 96);
    const dot = $('gaugeDot');
    dot.style.left = `${pos}%`;
    dot.classList.toggle('ok', distOk);

    if (S.live && ref.pts) {
      const sim = poseSimilarity(ref.pts, ref.aspect, S.live.pts, S.live.aspect, mirrored());
      if (sim != null) chips.push({ t: `포즈 ${Math.round(sim * 100)}%`, s: sim >= 0.8 ? 'ok' : 'bad' });
    }

    if (!distOk) {
      if (z > ZOOM_MAX) {
        const how = z > 2.4 ? '훨씬 더 가까이 가세요' : z > 1.7 ? '더 가까이 가세요' : '조금만 더 가까이';
        const sub = ref.shot === 'full' ? '전신이 화면에 꽉 차는 거리까지' : `${label}만 화면에 차는 거리까지`;
        hint = [how, sub, 'far'];
        out.arrow = 'IN';
      } else {
        const how = z < 0.6 ? '많이 뒤로 물러나세요' : '뒤로 조금 물러나세요';
        hint = [how, `${label}이(가) 다 들어오는 거리까지`, 'near'];
        out.arrow = 'OUT';
      }
    } else if (!posOk) {
      let dir;
      if (Math.abs(dx) >= Math.abs(dy)) dir = (dx < 0) !== mirrored() ? 'L' : 'R';
      else dir = dy < 0 ? 'U' : 'D';
      hint = [`폰을 ${DIR_WORD[dir]} 조금만`, '인물이 좋아하는 사진과 같은 자리에 오도록', `pos-${dir}`];
      out.arrow = dir;
    } else if (levelBad) {
      hint = ['폰을 똑바로 세워 주세요', '', 'level'];
    } else if (dark) {
      hint = ['너무 어두워요', '밝은 곳으로 옮겨 주세요', 'dark'];
    } else {
      out.aligned = true;
    }
  }

  // 자동 촬영 판정
  if (out.aligned) {
    if (!S.alignedSince) S.alignedSince = now;
    S.lastAlignedAt = now;
    S.misalignedSince = 0;
  } else {
    if (S.alignedSince && now - S.lastAlignedAt > 180) S.alignedSince = 0;
    if (!S.misalignedSince) S.misalignedSince = now;
    if (!S.armed && now - S.misalignedSince > 400) S.armed = true;
  }
  if (!S.armed && now - S.lastShotAt > REARM_MS) S.armed = true;

  const holding = S.alignedSince > 0;
  const p = holding ? clamp((now - S.alignedSince) / HOLD_MS, 0, 1) : 0;
  out.progress = S.auto && S.armed ? p : 0;
  if (holding) {
    if (!S.auto) hint = ['지금이에요, 버튼을 누르세요', '', 'ready-manual'];
    else if (S.armed) hint = ['좋아요! 그대로 멈춰 주세요', '곧 자동으로 찍혀요', 'ready'];
    else hint = ['찍었어요', '그대로 있으면 5초 뒤 한 장 더 찍어요', 'shot'];
    out.ok = true;
  }
  if (!hint) hint = ['', '', 'none'];
  setHint(hint[0], hint[1], out.ok, hint[2]);
  renderChips(chips);
  $('finder').classList.toggle('ok', !!out.ok);
  $('shutter').classList.toggle('ok', !!out.ok);
  $('ringFg').style.strokeDashoffset = String(289 * (1 - out.progress));

  if (S.auto && S.armed && holding && p >= 1 && !S.busy) {
    S.armed = false;
    S.lastShotAt = now;
    capture();
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 화면 그리기                                                         */
/* ------------------------------------------------------------------ */

function drawOverlay(state) {
  const ov = $('overlay');
  const ctx = ov.getContext('2d');
  const W = ov.width, H = ov.height;
  const u = W / 400; // 400px 폭 기준 굵기
  ctx.clearRect(0, 0, W, H);
  const ref = S.target;
  const color = state.ok ? '#58e09a' : '#ffc24a';

  // 좋아하는 사진의 인물 윤곽(목표 자리)
  if (ref.pts) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 3 * u;
    ctx.lineCap = 'round';
    ctx.setLineDash([9 * u, 8 * u]);
    ctx.beginPath();
    for (const [a, b] of LIMBS) {
      const p = ref.pts[a], q = ref.pts[b];
      if (!(p[2] && q[2])) continue;
      ctx.moveTo(p[0] * W, p[1] * H);
      ctx.lineTo(q[0] * W, q[1] * H);
    }
    ctx.stroke();
    if (ref.m.nose) {
      const r = (ref.m.face ? ref.m.face * 0.75 : ref.m.shoulderW ? ref.m.shoulderW * 0.33 : 0.06) * H;
      ctx.beginPath();
      ctx.arc((ref.m.nose.x / ref.aspect) * W, ref.m.nose.y * H, Math.max(r, 10 * u), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 3분할선
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1 * u;
  ctx.beginPath();
  for (const t of [1 / 3, 2 / 3]) {
    ctx.moveTo(W * t, 0); ctx.lineTo(W * t, H);
    ctx.moveTo(0, H * t); ctx.lineTo(W, H * t);
  }
  ctx.stroke();
  ctx.restore();

  // 수평선
  if (S.roll != null) {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((S.roll * Math.PI) / 180);
    ctx.strokeStyle = Math.abs(S.roll) < 3.5 ? '#58e09a' : '#ffc24a';
    ctx.lineWidth = 2.5 * u;
    ctx.beginPath();
    ctx.moveTo(-46 * u, 0); ctx.lineTo(-14 * u, 0);
    ctx.moveTo(14 * u, 0); ctx.lineTo(46 * u, 0);
    ctx.stroke();
    ctx.restore();
  }

  // 움직일 방향 화살표
  if (state.arrow) {
    const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 180);
    ctx.save();
    ctx.strokeStyle = '#ffc24a';
    ctx.globalAlpha = pulse;
    ctx.lineWidth = 7 * u;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const s = 22 * u;
    const chevron = (cx, cy, ang) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(-s * 0.5, -s); ctx.lineTo(s * 0.5, 0); ctx.lineTo(-s * 0.5, s);
      ctx.stroke();
      ctx.restore();
    };
    const m = 34 * u;
    if (state.arrow === 'L') chevron(m, H / 2, Math.PI);
    else if (state.arrow === 'R') chevron(W - m, H / 2, 0);
    else if (state.arrow === 'U') chevron(W / 2, m + 70 * u, -Math.PI / 2);
    else if (state.arrow === 'D') chevron(W / 2, H - m - 40 * u, Math.PI / 2);
    else if (state.arrow === 'IN') {
      // 다가가기: 네 모서리에서 안쪽으로
      chevron(m, m + 70 * u, Math.PI / 4); chevron(W - m, m + 70 * u, (3 * Math.PI) / 4);
      chevron(m, H - m - 40 * u, -Math.PI / 4); chevron(W - m, H - m - 40 * u, (-3 * Math.PI) / 4);
    } else if (state.arrow === 'OUT') {
      chevron(m, m + 70 * u, (-3 * Math.PI) / 4); chevron(W - m, m + 70 * u, -Math.PI / 4);
      chevron(m, H - m - 40 * u, (3 * Math.PI) / 4); chevron(W - m, H - m - 40 * u, Math.PI / 4);
    }
    ctx.restore();
  }
}

function currentColor() {
  if (!S.color || !S.liveStats || !S.target || !S.target.lab) return null;
  return transferParams(S.liveStats, S.target.lab, 0.75);
}

/* 보정(선택 기능): 꺼져 있으면 아래 값은 전혀 적용되지 않는다. */

// 눈·입 위치에서 얼굴 변형 기준점을 구해 부드럽게 따라가게 한다. 단위는 "프레임 높이 = 1".
function updateFace(pts, aspect) {
  if (!pts || !(pts[2][2] && pts[5][2] && pts[9][2] && pts[10][2])) {
    if (++S.faceMiss > 6) S.face = null;
    return;
  }
  S.faceMiss = 0;
  const P = (i) => [pts[i][0] * aspect, pts[i][1]];
  const eL = P(2), eR = P(5), mL = P(9), mR = P(10);
  const eyeMid = [(eL[0] + eR[0]) / 2, (eL[1] + eR[1]) / 2];
  const c = [(mL[0] + mR[0]) / 2, (mL[1] + mR[1]) / 2];
  const ed = Math.hypot(eL[0] - eR[0], eL[1] - eR[1]);
  let dn = [c[0] - eyeMid[0], c[1] - eyeMid[1]];
  const n = Math.hypot(dn[0], dn[1]) || 1;
  dn = [dn[0] / n, dn[1] / n];
  const side = [dn[1], -dn[0]];
  const jaw = (k) => [c[0] + side[0] * ed * 0.85 * k + dn[0] * ed * 0.15, c[1] + side[1] * ed * 0.85 * k + dn[1] * ed * 0.15];
  // 코가 안 잡히면 눈과 입 사이로 추정한다.
  const nose = pts[0][2] ? P(0) : [eyeMid[0] + dn[0] * ed * 0.6, eyeMid[1] + dn[1] * ed * 0.6];
  const wing = (k) => [nose[0] + side[0] * ed * 0.3 * k + dn[0] * ed * 0.08, nose[1] + side[1] * ed * 0.3 * k + dn[1] * ed * 0.08];
  const f = [...eL, ...eR, ...jaw(1), ...jaw(-1), ...c, ed, ...wing(1), ...wing(-1), ...nose];
  S.face = S.face ? S.face.map((v, i) => v + (f[i] - v) * 0.5) : f;
}

function buildFx(aspect) {
  const fx = { aspect, color: currentColor() };
  const b = S.fx;
  if (!b.on || S.fxBypass) return fx;
  const F = FILTERS[b.filter] || FILTERS.none;
  const a = b.filterAmt / 100;
  const exp = (F.exp || 0) * a + (b.exp / 100) * 0.6;
  fx.adj = [
    Math.pow(2, exp),
    (1 + ((F.con ?? 1) - 1) * a) * (1 + (b.con / 100) * 0.4),
    (1 + ((F.sat ?? 1) - 1) * a) * (1 + (b.sat / 100) * 0.6),
    (F.temp || 0) * a + (b.temp / 100) * 0.6,
  ];
  fx.fade = (F.fade || 0) * a;
  fx.vib = (F.vib || 0) * a + (b.vib / 100) * 0.8;
  fx.vig = Math.min(1, (F.vig || 0) * a + b.vig / 100);
  fx.sharp = b.sharp / 100;
  fx.smooth = b.smooth / 100;
  fx.bright = b.bright / 100;
  if (S.face) {
    fx.face = S.face;
    fx.eyeK = (b.eye / 100) * 0.3;
    fx.slimK = (b.slim / 100) * 0.14;
    fx.noseK = (b.nose / 100) * 0.16;
    fx.blurR = S.face[10] * 0.12;
  }
  return fx;
}

let fxTab = 'beauty';
function saveFx() { store.setPref('fx', S.fx); }
function syncFxSwitch() {
  $('fxOn').checked = S.fx.on;
  $('fxBtn').classList.toggle('on', S.fx.on);
  $('fxBody').classList.toggle('off', !S.fx.on);
}

function renderFx() {
  syncFxSwitch();
  const tabs = $('fxTabs');
  tabs.textContent = '';
  for (const [key, name] of [['beauty', '뷰티'], ['filter', '필터'], ['adjust', '조정']]) {
    const b = document.createElement('button');
    b.textContent = name;
    b.className = key === fxTab ? 'on' : '';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', key === fxTab ? 'true' : 'false');
    b.onclick = () => { fxTab = key; renderFx(); };
    tabs.append(b);
  }
  const body = $('fxBody');
  body.textContent = '';
  const slider = (key, label, min) => {
    const row = document.createElement('div');
    row.className = 'fx-row';
    const l = document.createElement('label');
    l.textContent = label;
    l.htmlFor = `fx-${key}`;
    const input = document.createElement('input');
    input.type = 'range';
    input.id = `fx-${key}`;
    input.min = String(min);
    input.max = '100';
    input.value = String(S.fx[key]);
    const out = document.createElement('output');
    out.textContent = String(S.fx[key]);
    input.oninput = () => {
      S.fx[key] = Number(input.value);
      out.textContent = input.value;
      S.fx.on = true; // 값을 만지면 보정을 켠다
      syncFxSwitch();
      saveFx();
    };
    row.append(l, input, out);
    body.append(row);
  };
  if (fxTab === 'filter') {
    const list = document.createElement('div');
    list.className = 'fx-filters';
    for (const [key, f] of Object.entries(FILTERS)) {
      const b = document.createElement('button');
      b.textContent = f.name;
      b.className = S.fx.filter === key ? 'on' : '';
      b.onclick = () => { S.fx.filter = key; if (key !== 'none') S.fx.on = true; saveFx(); renderFx(); };
      list.append(b);
    }
    const rnd = document.createElement('button');
    rnd.textContent = '무작위';
    rnd.onclick = () => {
      const keys = Object.keys(FILTERS).filter((k) => k !== 'none' && k !== S.fx.filter);
      S.fx.filter = keys[Math.floor(Math.random() * keys.length)];
      S.fx.on = true;
      saveFx();
      renderFx();
    };
    list.prepend(rnd);
    body.append(list);
    slider('filterAmt', '필터 세기', 0);
    list.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  } else {
    if (fxTab === 'beauty') {
      const row = document.createElement('div');
      row.className = 'fx-presets';
      for (const [name, values] of BEAUTY_PRESETS) {
        const b = document.createElement('button');
        b.textContent = name;
        b.onclick = () => { Object.assign(S.fx, values, { on: true }); saveFx(); renderFx(); };
        row.append(b);
      }
      body.append(row);
    }
    for (const [key, label, min] of FX_SLIDERS[fxTab]) slider(key, label, min);
    if (fxTab === 'beauty') {
      const note = document.createElement('p');
      note.className = 'fx-note';
      note.textContent = '갸름하게·눈 크게·콧볼은 얼굴이 정면으로 보일 때 적용됩니다.';
      body.append(note);
    }
  }
}

// 보정·설정 패널은 평소에 숨겨 두고 버튼을 누르면 펼친다. name: 'fx' | 'opt' | null
function showPanel(name) {
  $('fxPanel').hidden = name !== 'fx';
  $('optPanel').hidden = name !== 'opt';
  $('fxBtn').setAttribute('aria-expanded', name === 'fx' ? 'true' : 'false');
  $('optBtn').setAttribute('aria-expanded', name === 'opt' ? 'true' : 'false');
  $('camBottom').classList.toggle('fx-open', !!name);
  if (name === 'fx') renderFx();
  layoutFinder();
}

/* 일반 촬영: 화면 비율과 줌 */
function renderPlainBar() {
  const seg = (id, items, isOn, pick) => {
    const box = $(id);
    box.textContent = '';
    for (const [label, value] of items) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = isOn(value) ? 'on' : '';
      b.onclick = () => { pick(value); renderPlainBar(); };
      box.append(b);
    }
  };
  seg('ratioSeg', RATIOS, (v) => Math.abs(v - PLAIN.aspect) < 0.01, (v) => {
    PLAIN.aspect = v;
    store.setPref('plainAspect', v);
    S.cropS = null;
    layoutFinder();
  });
  seg('zoomSeg', ZOOMS.map((z) => [`${z}x`, z]), (v) => v === S.zoom, (v) => { S.zoom = v; });
}

/* 타이머 */
function renderTimer() {
  $('tTimer').textContent = S.timer ? `타이머 ${S.timer}초` : '타이머 끔';
  setToggle('tTimer', S.timer > 0);
}
let countdownTimer = 0;
function cancelCountdown() {
  clearInterval(countdownTimer);
  S.countdown = 0;
  $('countdown').hidden = true;
}
function shootNow() {
  S.lastShotAt = performance.now();
  S.armed = false;
  capture();
}
function onShutter() {
  if (S.countdown) { cancelCountdown(); return; } // 다시 누르면 취소
  if (!S.timer) { shootNow(); return; }
  S.countdown = S.timer;
  const el = $('countdown');
  el.textContent = String(S.countdown);
  el.hidden = false;
  countdownTimer = setInterval(() => {
    S.countdown -= 1;
    if (S.countdown <= 0) { cancelCountdown(); shootNow(); } else el.textContent = String(S.countdown);
  }, 1000);
}

function cropNorm(vw, vh) {
  const c = S.cropS;
  return { x: c.x / vw, y: c.y / vh, w: c.w / vw, h: c.h / vh };
}

let lastState = { ok: false, arrow: null, progress: 0 };

function frame(now) {
  if (!S.running) return;
  requestAnimationFrame(frame);
  if (!$('viewer').hidden) { S.alignedSince = 0; return; } // 사진을 보는 동안에는 찍지 않는다
  const src = S.src;
  if (!src || !src.ready() || !S.target) return;
  const vw = src.w(), vh = src.h();
  const mirror = mirrored();

  if (now - S.lastDet > 66) {
    S.lastDet = now;
    const k = 320 / Math.max(vw, vh);
    const dw = Math.round(vw * k), dh = Math.round(vh * k);
    if (detCanvas.width !== dw || detCanvas.height !== dh) { detCanvas.width = dw; detCanvas.height = dh; }
    detCtx.drawImage(src.el, 0, 0, dw, dh);
    let pts = null;
    try { pts = detectVideo(detCanvas, now); } catch (e) { console.error(e); }
    S.live = pts ? { pts, aspect: vw / vh, m: measure(pts, vw / vh) } : null;
    updateFace(pts, vw / vh);
    if (S.target.plain) {
      const ar = S.target.aspect;
      const H = Math.min(vh, vw / ar) / S.zoom, W = H * ar;
      S.sol = { crop: { x: (vw - W) / 2, y: (vh - H) / 2, w: W, h: H }, matched: false };
    } else {
      S.sol = solveCrop(S.target, S.live && S.live.m, vw, vh, mirror);
    }
    if (S.sol.matched) {
      const a = 0.35;
      S.zS = S.zS == null ? S.sol.z : S.zS + (S.sol.z - S.zS) * a;
      S.dxS += (S.sol.dx - S.dxS) * a;
      S.dyS += (S.sol.dy - S.dyS) * a;
    } else {
      S.zS = null; S.dxS = 0; S.dyS = 0;
    }

    if (now - S.lastStats > 280 && S.cropS) {
      S.lastStats = now;
      const img = detCtx.getImageData(0, 0, dw, dh);
      const cn = cropNorm(vw, vh);
      S.liveStats = lerpStats(S.liveStats, labStats(img, cn), 0.35);
      if (!S.target.m && S.target.layout) {
        const sig = layoutSignature(detCtx, cn.x * dw, cn.y * dh, cn.w * dw, cn.h * dh, detCanvas, mirror);
        let dot = 0;
        for (let i = 0; i < 144; i++) dot += sig[i] * S.target.layout[i];
        S.sceneSim = S.sceneSim == null ? dot : S.sceneSim + (dot - S.sceneSim) * 0.4;
      } else {
        S.sceneSim = null;
      }
      tuneExposure(now);
    }
    lastState = evaluate(now);
  }

  // 잘라낼 영역을 부드럽게 따라가게 한다.
  const t = S.sol ? S.sol.crop : null;
  if (t) {
    if (!S.cropS) S.cropS = { ...t };
    else for (const key of ['x', 'y', 'w', 'h']) S.cropS[key] += (t[key] - S.cropS[key]) * 0.22;
    // 보간 중에도 프레임 밖으로 나가지 않게
    S.cropS.w = Math.min(S.cropS.w, vw);
    S.cropS.h = Math.min(S.cropS.h, vh);
    S.cropS.x = clamp(S.cropS.x, 0, vw - S.cropS.w);
    S.cropS.y = clamp(S.cropS.y, 0, vh - S.cropS.h);
  }
  if (!S.cropS) return;
  viewR.draw(src.el, cropNorm(vw, vh), mirror, buildFx(vw / vh));
  drawOverlay(lastState);
}

// 기기가 지원하면 노출을 좋아하는 사진의 밝기 쪽으로 조금씩 맞춘다.
function tuneExposure(now) {
  if (!S.track || !S.expCap || !S.liveStats || !S.target.lab || now - S.lastExp < 900) return;
  S.lastExp = now;
  const diff = S.target.lab.mean[0] - S.liveStats.mean[0];
  if (Math.abs(diff) < 8) return;
  const step = S.expCap.step || 0.25;
  const lo = Math.max(S.expCap.min, -1.5), hi = Math.min(S.expCap.max, 1.5);
  const next = clamp(S.ev + Math.sign(diff) * step, lo, hi);
  if (next === S.ev) return;
  S.ev = next;
  S.track.applyConstraints({ advanced: [{ exposureCompensation: next }] }).catch(() => { S.expCap = null; });
}

/* ------------------------------------------------------------------ */
/* 촬영                                                                */
/* ------------------------------------------------------------------ */

function click() {
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    const len = Math.floor(audioCtx.sampleRate * 0.06);
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const n = audioCtx.createBufferSource();
    n.buffer = buf;
    const g = audioCtx.createGain();
    g.gain.value = 0.5;
    n.connect(g).connect(audioCtx.destination);
    n.start(t);
  } catch { /* 소리 없이 진행 */ }
}

async function capture() {
  if (S.busy || !S.cropS || !S.src || !S.src.ready()) return;
  S.busy = true;
  try {
    const vw = S.src.w(), vh = S.src.h();
    let ow = Math.round(S.cropS.w), oh = Math.round(S.cropS.h);
    const k = Math.min(1, capR.maxTex / Math.max(ow, oh));
    ow = Math.round(ow * k); oh = Math.round(oh * k);
    capR.resize(ow, oh);
    capR.draw(S.src.el, cropNorm(vw, vh), mirrored() && S.mirrorSave, buildFx(vw / vh));
    let out = capR.canvas;
    if (S.stamp) {
      // 날짜를 사진 오른쪽 아래에 찍는다.
      out = document.createElement('canvas');
      out.width = ow;
      out.height = oh;
      const c2 = out.getContext('2d');
      c2.drawImage(capR.canvas, 0, 0);
      const d = new Date();
      const text = `${d.getFullYear()}. ${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getDate()).padStart(2, '0')}`;
      const fs = Math.round(Math.min(ow, oh) * 0.042);
      c2.font = `600 ${fs}px ui-monospace, Menlo, monospace`;
      c2.textAlign = 'right';
      c2.textBaseline = 'bottom';
      c2.shadowColor = 'rgba(0,0,0,0.55)';
      c2.shadowBlur = fs * 0.25;
      c2.fillStyle = '#ffb648';
      c2.fillText(text, ow - fs * 0.9, oh - fs * 0.8);
    }
    const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.94));
    if (!blob) throw new Error('사진을 만들지 못했어요');
    const flash = $('flash');
    flash.classList.remove('go');
    void flash.offsetWidth;
    flash.classList.add('go');
    click();
    try { navigator.vibrate?.(60); } catch { /* 진동 미지원 */ }
    const shot = { id: store.newId(), blob, w: ow, h: oh, createdAt: Date.now(), refId: S.target.id };
    await store.put('shots', shot);
    shot.url = URL.createObjectURL(blob);
    S.shots.push(shot);
    updateGalleryThumb();
    toast('찍었어요. 왼쪽 아래에서 확인하세요', 1600);
  } catch (e) {
    console.error(e);
    toast('촬영에 실패했어요. 다시 시도해 주세요.');
  } finally {
    S.busy = false;
  }
}

function updateGalleryThumb() {
  const img = $('galleryThumb');
  const last = S.shots[S.shots.length - 1];
  img.hidden = !last;
  if (last) img.src = last.url;
}

/* ------------------------------------------------------------------ */
/* 찍은 사진 보기                                                      */
/* ------------------------------------------------------------------ */

function openViewer() {
  if (!S.shots.length) { toast('아직 찍은 사진이 없어요'); return; }
  S.viewIdx = S.shots.length - 1;
  $('viewer').hidden = false;
  renderViewer();
}

function renderViewer() {
  if (!S.shots.length) { $('viewer').hidden = true; return; }
  S.viewIdx = clamp(S.viewIdx, 0, S.shots.length - 1);
  const shot = S.shots[S.viewIdx];
  $('viewerImg').src = shot.url;
  $('viewerCount').textContent = `${S.viewIdx + 1} / ${S.shots.length} · ${shot.w}×${shot.h}`;
  $('likeShot').textContent = shot.liked ? '♥ 취향에 추가됨' : '♥ 취향에 추가';
  $('likeShot').disabled = !!shot.liked;
  resetDelete();
  const strip = $('viewerStrip');
  strip.textContent = '';
  S.shots.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'strip-item' + (i === S.viewIdx ? ' on' : '');
    b.setAttribute('aria-label', `${i + 1}번째 사진`);
    const img = document.createElement('img');
    img.src = s.url;
    img.alt = '';
    b.append(img);
    b.onclick = () => { S.viewIdx = i; renderViewer(); };
    strip.append(b);
  });
  strip.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

let delArmed = 0;
function resetDelete() {
  clearTimeout(delArmed);
  delArmed = 0;
  $('delShot').textContent = '삭제';
}

async function saveShot() {
  const shot = S.shots[S.viewIdx];
  const name = `인생샷-${new Date(shot.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '')}.jpg`;
  const file = new File([shot.blob], name, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      if (e.name !== 'AbortError') toast('공유 창을 열지 못했어요. 사진을 길게 눌러 저장해 주세요.', 3200);
    }
    return;
  }
  const a = document.createElement('a');
  a.href = shot.url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}

async function likeShot() {
  const shot = S.shots[S.viewIdx];
  if (shot.liked) return;
  $('likeShot').disabled = true;
  $('likeShot').textContent = '분석 중…';
  try {
    const ref = await analyze(shot.blob);
    await store.put('refs', { ...ref });
    S.refs.push(hydrateRef(ref));
    shot.liked = true;
    const { url, ...plain } = shot;
    await store.put('shots', plain);
    toast('취향에 추가했어요. 다음 촬영부터 반영돼요');
    if (!$('camera').hidden) pickTarget();
  } catch (e) {
    console.error(e);
    toast('추가하지 못했어요');
  }
  renderViewer();
}

async function deleteShot() {
  if (!delArmed) {
    $('delShot').textContent = '한 번 더 누르면 삭제';
    delArmed = setTimeout(resetDelete, 2500);
    return;
  }
  resetDelete();
  const shot = S.shots[S.viewIdx];
  await store.del('shots', shot.id);
  URL.revokeObjectURL(shot.url);
  S.shots.splice(S.viewIdx, 1);
  updateGalleryThumb();
  renderViewer();
}

/* ------------------------------------------------------------------ */
/* 시작                                                                */
/* ------------------------------------------------------------------ */

function bind() {
  $('filePick').addEventListener('change', async (e) => {
    const files = e.target.files;
    await addFiles(files);
    e.target.value = '';
  });
  $('openCam').onclick = openCamera;
  $('closeCam').onclick = closeCamera;
  $('shutter').onclick = onShutter;
  $('fxBtn').onclick = () => showPanel($('fxPanel').hidden ? 'fx' : null);
  $('optBtn').onclick = () => showPanel($('optPanel').hidden ? 'opt' : null);
  $('fxClose').onclick = () => showPanel(null);
  $('optClose').onclick = () => showPanel(null);
  const hold = $('fxHold');
  hold.onpointerdown = (e) => { e.preventDefault(); S.fxBypass = true; };
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) hold.addEventListener(ev, () => { S.fxBypass = false; });
  $('finder').onclick = () => { if (S.tapShot) onShutter(); };
  $('fxOn').onchange = (e) => { S.fx.on = e.target.checked; saveFx(); syncFxSwitch(); };
  $('fxReset').onclick = () => { S.fx = { ...FX_DEFAULT, on: S.fx.on }; saveFx(); renderFx(); };
  $('tTimer').onclick = () => {
    S.timer = S.timer === 0 ? 3 : S.timer === 3 ? 10 : 0;
    store.setPref('timer', S.timer);
    renderTimer();
  };
  $('tTorch').onclick = async () => {
    if (!S.track) return;
    const next = !S.torch;
    try {
      await S.track.applyConstraints({ advanced: [{ torch: next }] });
      S.torch = next;
      setToggle('tTorch', next);
    } catch { toast('이 카메라에서는 조명을 켤 수 없어요'); }
  };
  $('galleryBtn').onclick = openViewer;
  $('flip').onclick = async () => {
    if (testSrc) return;
    S.facing = S.facing === 'environment' ? 'user' : 'environment';
    S.cropS = null;
    try { await startSource(); } catch (e) { showCamError(e); }
  };
  const toggle = (id, key, after) => {
    $(id).onclick = () => {
      S[key] = !S[key];
      store.setPref(key, S[key]);
      setToggle(id, S[key]);
      if (after) after();
    };
  };
  toggle('tAuto', 'auto');
  toggle('tVoice', 'voice', () => { if (!S.voice) window.speechSynthesis?.cancel(); });
  toggle('tGhost', 'ghost', () => { $('ghostImg').hidden = !S.ghost || !!(S.target && S.target.plain); });
  toggle('tColor', 'color');
  toggle('tTap', 'tapShot');
  toggle('tMirror', 'mirrorSave');
  toggle('tStamp', 'stamp');

  $('closeViewer').onclick = () => { $('viewer').hidden = true; };
  $('saveShot').onclick = saveShot;
  $('likeShot').onclick = likeShot;
  $('delShot').onclick = deleteShot;

  window.addEventListener('resize', layoutFinder);
  window.addEventListener('orientationchange', () => setTimeout(layoutFinder, 250));
  document.addEventListener('visibilitychange', async () => {
    if ($('camera').hidden) return;
    if (document.hidden) {
      S.running = false;
    } else if (!S.running) {
      // 다른 앱에 다녀오면 카메라가 끊길 수 있어 다시 연결한다.
      try {
        if (!testSrc && (!S.track || S.track.readyState !== 'live')) await startSource();
        S.running = true;
        requestAnimationFrame(frame);
      } catch (e) { showCamError(e); }
    }
  });
}

async function main() {
  bind();
  try {
    const [refs, shots] = await Promise.all([store.all('refs'), store.all('shots')]);
    S.refs = refs.sort((a, b) => a.createdAt - b.createdAt).map(hydrateRef);
    S.shots = shots.sort((a, b) => a.createdAt - b.createdAt).map((s) => ({ ...s, url: URL.createObjectURL(s.blob) }));
  } catch (e) {
    console.error(e);
    toast('저장된 사진을 불러오지 못했어요');
  }
  renderHome();
  updateGalleryThumb();
  if (S.refs.length) ensurePose().catch(() => {}); // 카메라를 빨리 열 수 있게 미리 준비
}

main();
