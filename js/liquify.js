// 터치 보정: 찍은 사진을 손가락으로 밀어서 다듬는다.
// 사진 위에 촘촘한 그물을 씌우고, 민 방향으로 그물의 표본 위치를 옮겨 그린다.

const VS = `
attribute vec2 aPos;
attribute vec2 aUv;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;
const FS = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
void main() {
  gl_FragColor = texture2D(uTex, clamp(vUv, 0.0, 1.0));
}`;

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class Liquify {
  // image: ImageBitmap 또는 img/canvas, w·h: 원본 크기
  constructor(canvas, image, w, h) {
    this.canvas = canvas;
    this.w = w;
    this.h = h;
    this.aspect = w / h;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL을 사용할 수 없습니다');
    this.gl = gl;
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    gl.useProgram(p);

    // 그물: 가로 72칸 기준, 세로는 비율에 맞춘다.
    this.cols = 72;
    this.rows = Math.max(8, Math.min(160, Math.round(72 / this.aspect)));
    const nx = this.cols + 1, ny = this.rows + 1;
    this.n = nx * ny;
    const pos = new Float32Array(this.n * 2);
    this.base = new Float32Array(this.n * 2);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * 2;
      const u = i / this.cols, v = j / this.rows;
      pos[k] = u * 2 - 1;
      pos[k + 1] = 1 - v * 2;
      this.base[k] = u;
      this.base[k + 1] = v;
    }
    const idx = new Uint16Array(this.cols * this.rows * 6);
    let t = 0;
    for (let j = 0; j < this.rows; j++) for (let i = 0; i < this.cols; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
    this.count = idx.length;
    this.disp = new Float32Array(this.n * 2);
    this.uv = new Float32Array(this.n * 2);
    this.history = [];

    const pb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    const pl = gl.getAttribLocation(p, 'aPos');
    gl.enableVertexAttribArray(pl);
    gl.vertexAttribPointer(pl, 2, gl.FLOAT, false, 0, 0);

    this.uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.uv, gl.DYNAMIC_DRAW);
    const ul = gl.getAttribLocation(p, 'aUv');
    gl.enableVertexAttribArray(ul);
    gl.vertexAttribPointer(ul, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

    // 기기 한계보다 큰 사진은 줄여서 올린다.
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    let src = image;
    const k = Math.min(1, this.maxTex / Math.max(w, h));
    if (k < 1) {
      src = document.createElement('canvas');
      src.width = Math.round(w * k);
      src.height = Math.round(h * k);
      src.getContext('2d').drawImage(image, 0, 0, src.width, src.height);
      this.w = src.width;
      this.h = src.height;
    }
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.render();
  }

  // 한 번의 손가락 움직임을 시작할 때 부른다(되돌리기 지점).
  beginStroke() {
    this.history.push(this.disp.slice());
    if (this.history.length > 20) this.history.shift();
  }

  // (x, y)에서 (dx, dy)만큼 민다. 좌표는 사진 기준 0~1, radius는 사진 높이 기준.
  push(x, y, dx, dy, radius, strength) {
    const A = this.aspect, r2 = radius * radius;
    const base = this.base, disp = this.disp;
    for (let i = 0; i < this.n; i++) {
      const k = i * 2;
      const ex = (base[k] - x) * A, ey = base[k + 1] - y;
      const d2 = ex * ex + ey * ey;
      if (d2 >= r2) continue;
      const w = 1 - d2 / r2;
      const f = w * w * strength;
      disp[k] += dx * f;
      disp[k + 1] += dy * f;
    }
    this.render();
  }

  undo() {
    const prev = this.history.pop();
    if (!prev) return false;
    this.disp = prev;
    this.render();
    return true;
  }

  reset() {
    if (!this.changed()) return;
    this.beginStroke();
    this.disp = new Float32Array(this.n * 2);
    this.render();
  }

  changed() {
    for (let i = 0; i < this.disp.length; i++) if (this.disp[i] !== 0) return true;
    return false;
  }

  render() {
    const gl = this.gl;
    for (let i = 0; i < this.uv.length; i++) this.uv[i] = this.base[i] - this.disp[i];
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.uv);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
  }

  // 원본 크기로 다시 그려 JPEG으로 내보낸다.
  async export() {
    const cw = this.canvas.width, ch = this.canvas.height;
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.render();
    const blob = await new Promise((r) => this.canvas.toBlob(r, 'image/jpeg', 0.94));
    this.canvas.width = cw;
    this.canvas.height = ch;
    this.render();
    return { blob, w: this.w, h: this.h };
  }
}
