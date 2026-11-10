// 인물 자세 인식(MediaPipe Pose, 기기 안에서만 실행)과 구도 계산.
import { FilesetResolver, PoseLandmarker } from '../vendor/vision_bundle.mjs';

let fileset = null;
let imageDet = null;
let videoDet = null;

async function create(mode) {
  if (!fileset) fileset = await FilesetResolver.forVisionTasks(new URL('../vendor/wasm', import.meta.url).href);
  const base = {
    runningMode: mode,
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
  const modelAssetPath = new URL('../vendor/pose_landmarker_lite.task', import.meta.url).href;
  try {
    return await PoseLandmarker.createFromOptions(fileset, { ...base, baseOptions: { modelAssetPath, delegate: 'GPU' } });
  } catch {
    return await PoseLandmarker.createFromOptions(fileset, { ...base, baseOptions: { modelAssetPath, delegate: 'CPU' } });
  }
}

export async function initPose() {
  if (!imageDet) imageDet = await create('IMAGE');
  if (!videoDet) videoDet = await create('VIDEO');
}

// 결과: [[x, y, visible], ...] 33개. x, y는 프레임 기준 0~1.
function pack(result) {
  const lms = result && result.landmarks && result.landmarks[0];
  if (!lms) return null;
  return lms.map((l) => {
    const inFrame = l.x > -0.02 && l.x < 1.02 && l.y > -0.02 && l.y < 1.02;
    return [l.x, l.y, (l.visibility ?? 1) > 0.5 && inFrame ? 1 : 0];
  });
}

export function detectImage(source) {
  return pack(imageDet.detect(source));
}
export function detectVideo(source, ts) {
  return pack(videoDet.detectForVideo(source, ts));
}

export const LIMBS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
];

export const SHOT_LABEL = {
  full: '전신',
  knee: '무릎 위',
  half: '상반신',
  bust: '가슴 위',
  face: '얼굴 클로즈업',
  scene: '풍경·사물',
};

export function shotType(pts) {
  const v = (i) => pts[i][2];
  if (v(27) || v(28)) return 'full';
  if (v(25) || v(26)) return 'knee';
  if (v(23) || v(24)) return 'half';
  if (v(11) && v(12)) return 'bust';
  return 'face';
}

// 구도 비교에 쓰는 기준점과 길이. 단위는 "프레임 높이 = 1" (x는 aspect를 곱해 같은 단위로 맞춘다).
export function measure(pts, aspect) {
  const p = (i) => ({ x: pts[i][0] * aspect, y: pts[i][1], v: pts[i][2] });
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const ls = p(11), rs = p(12), lh = p(23), rh = p(24), nose = p(0), le = p(7), re = p(8);
  const m = {};
  if (ls.v && rs.v) { m.sh = mid(ls, rs); m.shoulderW = d(ls, rs); }
  if (lh.v && rh.v) m.hip = mid(lh, rh);
  if (nose.v) m.nose = nose;
  if (m.sh && m.hip) m.torso = d(m.sh, m.hip);
  if (m.sh && m.nose) m.neck = d(m.sh, m.nose);
  if (le.v && re.v) m.face = d(le, re);
  return m;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// 디지털 확대는 이 배율까지만 허용한다. 그보다 멀면 찍는 사람이 다가가야 한다.
export const ZOOM_MAX = 1.35;
export const ZOOM_MIN = 0.92;

// 좋아하는 사진(ref)과 같은 구도가 되도록 현재 프레임에서 잘라낼 영역을 구한다.
// 반환: crop(px), z(필요 배율: >1이면 피사체가 작다 = 더 가까이), dx/dy(프레임 밖으로 벗어난 정도)
export function solveCrop(ref, liveM, vw, vh, mirror) {
  const ar = ref.aspect;
  const Hmax = Math.min(vh, vw / ar);
  const center = () => ({ x: (vw - Hmax * ar) / 2, y: (vh - Hmax) / 2, w: Hmax * ar, h: Hmax });
  if (!ref.m || !liveM) return { crop: center(), matched: false };

  const key = ['torso', 'neck', 'shoulderW', 'face'].find((k) => ref.m[k] > 0.02 && liveM[k] > 0.005);
  const anchor = ref.m.sh && liveM.sh ? 'sh' : ref.m.nose && liveM.nose ? 'nose' : null;
  if (!key || !anchor) return { crop: center(), matched: false };

  const Hdes = (liveM[key] * vh) / ref.m[key];
  const z = Hmax / Hdes;
  const H = clamp(Hdes, Hmax / ZOOM_MAX, Hmax);
  const W = H * ar;
  let ax = ref.m[anchor].x / ar;
  if (mirror) ax = 1 - ax;
  const ay = ref.m[anchor].y;
  const lx = liveM[anchor].x * vh, ly = liveM[anchor].y * vh;
  const x0d = lx - ax * W, y0d = ly - ay * H;
  const x0 = clamp(x0d, 0, vw - W), y0 = clamp(y0d, 0, vh - H);
  return {
    crop: { x: x0, y: y0, w: W, h: H },
    matched: true,
    z,
    dx: (x0d - x0) / W,
    dy: (y0d - y0) / H,
    key,
  };
}

// 팔다리 방향이 얼마나 비슷한지(0~1). 비교할 관절이 부족하면 null.
export function poseSimilarity(refPts, refAspect, livePts, liveAspect, mirror) {
  let sum = 0, n = 0;
  for (const [a, b] of LIMBS) {
    if (!(refPts[a][2] && refPts[b][2] && livePts[a][2] && livePts[b][2])) continue;
    const rx = (refPts[b][0] - refPts[a][0]) * refAspect, ry = refPts[b][1] - refPts[a][1];
    let lx = (livePts[b][0] - livePts[a][0]) * liveAspect;
    const ly = livePts[b][1] - livePts[a][1];
    if (mirror) lx = -lx;
    const rn = Math.hypot(rx, ry), ln = Math.hypot(lx, ly);
    if (rn < 1e-4 || ln < 1e-4) continue;
    sum += (rx * lx + ry * ly) / (rn * ln);
    n++;
  }
  if (n < 3) return null;
  return clamp(sum / n, 0, 1);
}
