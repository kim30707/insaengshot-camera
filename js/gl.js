// WebGL 렌더러: 카메라 프레임을 잘라내고(구도), 선택한 보정을 적용하고, Lab 공간에서 색감을 옮겨 그린다.
// 미리보기와 촬영이 같은 셰이더를 쓰므로 보이는 그대로 저장된다.

const VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec4 uCrop;      // x, y, w, h (0~1, 위쪽이 0)
uniform float uMirror;
uniform float uAspect;   // 원본 프레임 가로/세로

// 좋아하는 사진의 색감으로 옮기기
uniform vec3 uMean;
uniform vec3 uScale;
uniform vec3 uShift;
uniform float uOn;

// 보정(선택 기능)
uniform vec4 uEyes;      // 왼눈 xy, 오른눈 xy (원본 uv)
uniform vec4 uJaws;      // 양쪽 턱선 xy
uniform vec2 uFaceC;     // 얼굴 아래쪽 중심
uniform vec3 uWarp;      // 눈 반경, 턱 반경, 사용 여부
uniform vec2 uWarpK;     // 눈 크게, 얼굴 갸름하게 세기
uniform vec2 uBeauty;    // 피부 매끈, 화사
uniform float uBlurR;    // 피부 매끈 반경
uniform vec4 uAdj;       // 밝기 배율, 대비, 채도, 색온도
uniform float uFade;
uniform vec4 uNose;      // 양쪽 콧볼 xy
uniform vec2 uNoseC;     // 코 중심
uniform vec2 uNoseK;     // 콧볼 반경, 세기
uniform vec3 uFinish;    // 선명, 활기, 비네팅
uniform vec2 uTexel;     // 원본 1픽셀 크기

vec3 toLin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 fwd(vec3 t) {
  return mix(7.787 * t + 16.0 / 116.0, pow(max(t, vec3(1e-6)), vec3(1.0 / 3.0)), step(vec3(0.008856), t));
}
vec3 inv(vec3 t) {
  return mix((t - 16.0 / 116.0) / 7.787, t * t * t, step(vec3(0.206893), t));
}
vec3 rgb2lab(vec3 c) {
  vec3 l = toLin(c);
  vec3 xyz = vec3(
    dot(l, vec3(0.4124564, 0.3575761, 0.1804375)) / 0.95047,
    dot(l, vec3(0.2126729, 0.7151522, 0.0721750)),
    dot(l, vec3(0.0193339, 0.1191920, 0.9503041)) / 1.08883);
  vec3 f = fwd(xyz);
  return vec3(116.0 * f.y - 16.0, 500.0 * (f.x - f.y), 200.0 * (f.y - f.z));
}
vec3 lab2rgb(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0;
  vec3 f = vec3(fy + lab.y / 500.0, fy, fy - lab.z / 200.0);
  vec3 xyz = inv(f) * vec3(0.95047, 1.0, 1.08883);
  vec3 l = vec3(
    dot(xyz, vec3( 3.2404542, -1.5371385, -0.4985314)),
    dot(xyz, vec3(-0.9692660,  1.8760108,  0.0415560)),
    dot(xyz, vec3( 0.0556434, -0.2040259,  1.0572252)));
  return toSrgb(l);
}

// 눈 주변을 살짝 키우고 턱선을 얼굴 중심 쪽으로 당긴다. 계산은 가로세로 같은 단위에서 한다.
vec2 bulge(vec2 p, vec2 e, float r, float k) {
  vec2 d = p - e;
  float t = length(d) / r;
  if (t < 1.0) { float s = 1.0 - t; p = e + d * (1.0 - k * s * s); }
  return p;
}
vec2 pull(vec2 p, vec2 j, vec2 c, float r, float k) {
  float t = length(p - j) / r;
  if (t < 1.0) { float w = 1.0 - t * t; p -= (c - j) * k * w * w; }
  return p;
}
vec2 warp(vec2 uv) {
  if (uWarp.z < 0.5) return uv;
  vec2 a = vec2(uAspect, 1.0);
  vec2 p = uv * a;
  p = bulge(p, uEyes.xy * a, uWarp.x, uWarpK.x);
  p = bulge(p, uEyes.zw * a, uWarp.x, uWarpK.x);
  p = pull(p, uJaws.xy * a, uFaceC * a, uWarp.y, uWarpK.y);
  p = pull(p, uJaws.zw * a, uFaceC * a, uWarp.y, uWarpK.y);
  p = pull(p, uNose.xy * a, uNoseC * a, uNoseK.x, uNoseK.y);
  p = pull(p, uNose.zw * a, uNoseC * a, uNoseK.x, uNoseK.y);
  return p / a;
}

// 피부색 영역(0~1). 피부만 매끈하게 하고 머리카락·배경의 선명함은 지킨다.
float skin(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  float cb = (c.b - y) * 0.564 + 0.5;
  float cr = (c.r - y) * 0.713 + 0.5;
  float m = smoothstep(0.29, 0.35, cb) * (1.0 - smoothstep(0.49, 0.54, cb))
          * smoothstep(0.50, 0.54, cr) * (1.0 - smoothstep(0.67, 0.73, cr));
  return m * smoothstep(0.12, 0.25, y);
}

void main() {
  float u = mix(vUv.x, 1.0 - vUv.x, uMirror);
  float v = 1.0 - vUv.y;
  vec2 uv = warp(vec2(uCrop.x + u * uCrop.z, uCrop.y + v * uCrop.w));
  vec3 c = texture2D(uTex, uv).rgb;

  if (uBeauty.x > 0.001 || uBeauty.y > 0.001) {
    float m = skin(c);
    if (uBeauty.x > 0.001) {
      // 색이 비슷한 주변만 섞어 윤곽은 남기고 잡티·모공만 흐리게 한다.
      vec3 sum = c;
      float wsum = 1.0;
      for (int i = 0; i < 18; i++) {
        float fi = float(i);
        float ring = 1.0 + floor(fi / 6.0);
        float ang = fi * 1.0472 + ring * 0.5;
        vec2 off = vec2(cos(ang) / uAspect, sin(ang)) * uBlurR * ring / 3.0;
        vec3 s = texture2D(uTex, uv + off).rgb;
        vec3 d = s - c;
        float w = exp(-dot(d, d) * 70.0);
        sum += s * w;
        wsum += w;
      }
      c = mix(c, sum / wsum, uBeauty.x * m);
    }
    if (uBeauty.y > 0.001) {
      vec3 lifted = 1.0 - (1.0 - c) * (1.0 - c);
      c = mix(c, lifted, uBeauty.y * 0.38 * max(m, 0.3));
    }
  }

  if (uFinish.x > 0.001) {
    // 선명: 주변 평균과의 차이를 더해 윤곽을 살린다.
    vec2 t = uTexel * 1.5;
    vec3 avg = (texture2D(uTex, uv + vec2(t.x, 0.0)).rgb + texture2D(uTex, uv - vec2(t.x, 0.0)).rgb
              + texture2D(uTex, uv + vec2(0.0, t.y)).rgb + texture2D(uTex, uv - vec2(0.0, t.y)).rgb) * 0.25;
    c += (c - avg) * uFinish.x * 1.6;
  }

  if (uOn > 0.5) {
    vec3 lab = rgb2lab(c);
    lab = (lab - uMean) * uScale + uMean + uShift;
    lab.x = clamp(lab.x, 0.0, 100.0);
    c = lab2rgb(lab);
  }

  c *= uAdj.x;
  c.r += uAdj.w * 0.08;
  c.b -= uAdj.w * 0.08;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, uAdj.z);
  c = (c - 0.5) * uAdj.y + 0.5;
  c = mix(c, c * 0.82 + 0.13, uFade);
  if (uFinish.y != 0.0) {
    // 활기: 이미 진한 색은 덜, 옅은 색은 더 살린다.
    float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
    float l2 = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l2), c, 1.0 + uFinish.y * (1.0 - (mx - mn)));
  }
  if (uFinish.z > 0.001) {
    float d = distance(vUv, vec2(0.5)) * 1.414;
    c *= 1.0 - uFinish.z * 0.75 * smoothstep(0.45, 1.0, d);
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

const UNIFORMS = [
  'uTex', 'uCrop', 'uMirror', 'uAspect', 'uMean', 'uScale', 'uShift', 'uOn',
  'uEyes', 'uJaws', 'uFaceC', 'uWarp', 'uWarpK', 'uBeauty', 'uBlurR', 'uAdj', 'uFade',
  'uNose', 'uNoseC', 'uNoseK', 'uFinish', 'uTexel',
];

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: !!opts.preserve, antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL을 사용할 수 없습니다');
    this.gl = gl;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of UNIFORMS) this.u[n] = gl.getUniformLocation(p, n);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(this.u.uTex, 0);
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  // crop: {x,y,w,h} 0~1 정규화(원본 기준)
  // fx: { aspect, color?, adj?, fade?, smooth?, bright?, blurR?, face?, eyeK?, slimK?, noseK?, sharp?, vib?, vig? }
  //     color·보정 항목이 없으면 원본 그대로 그린다.
  draw(source, crop, mirror, fx) {
    const gl = this.gl, u = this.u;
    const A = fx.aspect;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform4f(u.uCrop, crop.x, crop.y, crop.w, crop.h);
    gl.uniform1f(u.uMirror, mirror ? 1 : 0);
    gl.uniform1f(u.uAspect, A);
    if (fx.color) {
      gl.uniform3fv(u.uMean, fx.color.mean);
      gl.uniform3fv(u.uScale, fx.color.scale);
      gl.uniform3fv(u.uShift, fx.color.shift);
      gl.uniform1f(u.uOn, 1);
    } else {
      gl.uniform1f(u.uOn, 0);
    }
    const f = fx.face;
    const warpOn = f && ((fx.eyeK || 0) > 0.001 || (fx.slimK || 0) > 0.001 || (fx.noseK || 0) > 0.001);
    if (warpOn) {
      // f: [왼눈x,y, 오른눈x,y, 턱x,y, 턱x,y, 중심x,y, 눈사이거리] — x는 세로 기준 단위라 aspect로 나눠 uv로 바꾼다.
      gl.uniform4f(u.uEyes, f[0] / A, f[1], f[2] / A, f[3]);
      gl.uniform4f(u.uJaws, f[4] / A, f[5], f[6] / A, f[7]);
      gl.uniform2f(u.uFaceC, f[8] / A, f[9]);
      gl.uniform3f(u.uWarp, f[10] * 0.42, f[10] * 1.0, 1);
      gl.uniform2f(u.uWarpK, fx.eyeK || 0, fx.slimK || 0);
      gl.uniform4f(u.uNose, f[11] / A, f[12], f[13] / A, f[14]);
      gl.uniform2f(u.uNoseC, f[15] / A, f[16]);
      gl.uniform2f(u.uNoseK, f[10] * 0.34, fx.noseK || 0);
    } else {
      gl.uniform3f(u.uWarp, 1, 1, 0);
    }
    gl.uniform2f(u.uBeauty, fx.smooth || 0, fx.bright || 0);
    gl.uniform1f(u.uBlurR, fx.blurR || 0.006);
    const adj = fx.adj || [1, 1, 1, 0];
    gl.uniform4f(u.uAdj, adj[0], adj[1], adj[2], adj[3]);
    gl.uniform1f(u.uFade, fx.fade || 0);
    gl.uniform3f(u.uFinish, fx.sharp || 0, fx.vib || 0, fx.vig || 0);
    gl.uniform2f(u.uTexel, 1 / (source.videoWidth || source.width || 1000), 1 / (source.videoHeight || source.height || 1000));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
