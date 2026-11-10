// WebGL 렌더러: 카메라 프레임을 잘라내고(구도) Lab 공간에서 색감을 옮겨 그린다.
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
uniform vec3 uMean;      // 현재 화면의 Lab 평균
uniform vec3 uScale;     // 대비 비율
uniform vec3 uShift;     // 평균 이동
uniform float uOn;

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
void main() {
  float u = mix(vUv.x, 1.0 - vUv.x, uMirror);
  float v = 1.0 - vUv.y;
  vec2 uv = vec2(uCrop.x + u * uCrop.z, uCrop.y + v * uCrop.w);
  vec3 c = texture2D(uTex, uv).rgb;
  if (uOn > 0.5) {
    vec3 lab = rgb2lab(c);
    lab = (lab - uMean) * uScale + uMean + uShift;
    lab.x = clamp(lab.x, 0.0, 100.0);
    c = lab2rgb(lab);
  }
  gl_FragColor = vec4(c, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

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
    for (const n of ['uTex', 'uCrop', 'uMirror', 'uMean', 'uScale', 'uShift', 'uOn']) this.u[n] = gl.getUniformLocation(p, n);
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

  // crop: {x,y,w,h} 0~1 정규화(소스 기준), color: transferParams 결과 또는 null
  draw(source, crop, mirror, color) {
    const gl = this.gl, u = this.u;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform4f(u.uCrop, crop.x, crop.y, crop.w, crop.h);
    gl.uniform1f(u.uMirror, mirror ? 1 : 0);
    if (color) {
      gl.uniform3fv(u.uMean, color.mean);
      gl.uniform3fv(u.uScale, color.scale);
      gl.uniform3fv(u.uShift, color.shift);
      gl.uniform1f(u.uOn, 1);
    } else {
      gl.uniform1f(u.uOn, 0);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
