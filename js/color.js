// 색 공간 계산: sRGB <-> CIE Lab(D65), 영역 통계, 색감 옮기기(Reinhard) 파라미터.

function lin(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function f(t) {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

export function rgbToLab(r, g, b) {
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// ImageData의 일부(rect: 0~1 정규화)에서 Lab 평균/표준편차를 구한다.
export function labStats(img, rect) {
  const { width: W, height: H, data } = img;
  const x0 = rect ? Math.max(0, Math.floor(rect.x * W)) : 0;
  const y0 = rect ? Math.max(0, Math.floor(rect.y * H)) : 0;
  const x1 = rect ? Math.min(W, Math.ceil((rect.x + rect.w) * W)) : W;
  const y1 = rect ? Math.min(H, Math.ceil((rect.y + rect.h) * H)) : H;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 6000)));
  let n = 0;
  const s = [0, 0, 0], q = [0, 0, 0];
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * W + x) * 4;
      const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
      for (let k = 0; k < 3; k++) { s[k] += lab[k]; q[k] += lab[k] * lab[k]; }
      n++;
    }
  }
  if (!n) return { mean: [50, 0, 0], std: [20, 10, 10] };
  const mean = s.map((v) => v / n);
  const std = q.map((v, k) => Math.sqrt(Math.max(0, v / n - mean[k] * mean[k])));
  return { mean, std };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// 지금 화면(src)의 색 분포를 좋아하는 사진(dst) 쪽으로 옮기는 파라미터.
// 과한 보정으로 피부색이 깨지지 않게 이동량과 대비 비율을 제한한다.
export function transferParams(src, dst, strength) {
  const lim = [22, 14, 14];
  const scale = [1, 1, 1], shift = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const ratio = clamp(dst.std[k] / Math.max(src.std[k], 1e-3), 0.7, 1.5);
    scale[k] = 1 + (ratio - 1) * strength;
    shift[k] = clamp(dst.mean[k] - src.mean[k], -lim[k], lim[k]) * strength;
  }
  return { mean: src.mean.slice(), scale, shift };
}

export function lerpStats(a, b, t) {
  if (!a) return b;
  return {
    mean: a.mean.map((v, k) => v + (b.mean[k] - v) * t),
    std: a.std.map((v, k) => v + (b.std[k] - v) * t),
  };
}
