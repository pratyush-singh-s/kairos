import { useEffect, useRef, useState } from "react";
import { glassCapture, glassFrame } from "../../ipc/ui";

/**
 * "Real glass" for the mini timer: copies the screen behind the window (the window itself is hidden
 * from capture) and draws it bent like a thick piece of glass. Near the rim the picture is pulled
 * inwards, and red, green and blue bend by different amounts, so the edge shows chromatic aberration.
 * If Windows refuses the capture, nothing is drawn and the normal blur shows instead.
 */


const VERTEX = `
attribute vec2 a;
varying vec2 uv;
void main() {
  uv = vec2(a.x * 0.5 + 0.5, 0.5 - a.y * 0.5); // y down, like the screen picture
  gl_Position = vec4(a, 0.0, 1.0);
}`;

const FRAGMENT = `
precision highp float;
uniform sampler2D tex;
uniform vec2 size;     // pixels
uniform float radius;  // corner radius, pixels
uniform float edge;    // how far in from the rim the glass bends, pixels
uniform float bend;    // how far the picture is pulled in at the rim, pixels
uniform float split;   // colour split at the rim (chromatic aberration), 0..1
uniform float fog;     // frost: blur radius in pixels (0 = clear glass)
uniform float zoom;    // the whole picture is enlarged so the rim shifts this many pixels (like a real pane)
varying vec2 uv;

float box(vec2 p, vec2 hs, float r) {
  vec2 q = abs(p) - hs + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

vec3 sharpAt(vec2 p) {
  // The picture is BGRA, uploaded as RGBA.
  return texture2D(tex, clamp(p / size, vec2(0.0), vec2(1.0))).bgr;
}

// Frosted glass: a soft (gaussian-weighted) average of 32 points on a spiral around p.
vec3 sampleAt(vec2 p) {
  vec3 c = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < 32; i++) {
    float f = float(i) + 0.5;
    float r = sqrt(f / 32.0);                  // 0..1, even spread over the disc
    float a = f * 2.39996;                     // golden angle
    float w = exp(-r * r * 2.0);
    c += sharpAt(p + fog * r * vec2(cos(a), sin(a))) * w;
    total += w;
  }
  return c / total;
}

void main() {
  vec2 p = uv * size;
  vec2 hs = size * 0.5;
  vec2 rel = p - hs;
  float d = box(rel, hs, radius);            // < 0 inside
  vec2 e = vec2(1.0, 0.0);
  vec2 n = normalize(vec2(box(rel + e.xy, hs, radius) - box(rel - e.xy, hs, radius),
                          box(rel + e.yx, hs, radius) - box(rel - e.yx, hs, radius)) + 1e-6);
  float t = clamp(1.0 + d / edge, 0.0, 1.0);   // 0 in the middle, 1 at the rim
  float k = t * t * bend;
  vec2 off = n * k;
  p = hs + rel * (1.0 - zoom / hs);            // very slight enlargement around the middle
  vec3 col;
  col.r = sampleAt(p - off * (1.0 - split)).r;
  col.g = sampleAt(p - off).g;
  col.b = sampleAt(p - off * (1.0 + split)).b;
  // A little darker so the white time stays readable, and a soft light along the top-left rim.
  col *= 0.82;
  col = mix(col, vec3(0.86, 0.89, 0.94), 0.12); // a light milky haze
  float light = pow(t, 6.0) * max(0.0, dot(-n, normalize(vec2(1.0, 1.0))));
  col += vec3(0.35) * light;
  float alpha = clamp(0.5 - d, 0.0, 1.0);      // smooth rounded corners
  gl_FragColor = vec4(col * alpha, alpha);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error("no shader");
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader error");
  return s;
}

/**
 * `scale` = size of the copied picture compared with the window (the main window uses a smaller one,
 * it is frosted anyway); `fps` = pictures per second.
 */
export function GlassLens(props: { className: string; scale?: number; fps?: number; fog?: number; onActive?: (on: boolean) => void }) {
  const { className, scale = 1, fps = 30, fog = 6 } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [on, setOn] = useState(false);
  const onActive = props.onActive;

  useEffect(() => {
    const el = canvas.current;
    const gl = el?.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!el || !gl) return;
    let alive = true;
    let shown = false;
    const show = (v: boolean) => {
      if (shown === v) return;
      shown = v;
      setOn(v);
      onActive?.(v);
    };

    type Uniform = "size" | "radius" | "edge" | "bend" | "split" | "fog" | "zoom";
    let uniforms: Record<Uniform, WebGLUniformLocation | null>;
    try {
      const prog = gl.createProgram();
      if (!prog) return;
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const a = gl.getAttribLocation(prog, "a");
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const at = (n: Uniform) => gl.getUniformLocation(prog, n);
      uniforms = { size: at("size"), radius: at("radius"), edge: at("edge"), bend: at("bend"), split: at("split"), fog: at("fog"), zoom: at("zoom") };
    } catch {
      return;
    }

    let sized = false;
    function draw(frame: ArrayBuffer) {
      if (!el || !gl) return;
      const head = new DataView(frame, 0, 8);
      const w = head.getUint32(0, true);
      const h = head.getUint32(4, true);
      if (frame.byteLength < 8 + w * h * 4) return;
      const pixels = new Uint8Array(frame, 8, w * h * 4);
      if (el.width !== w || el.height !== h || !sized) {
        el.width = w;
        el.height = h;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        sized = true;
      } else {
        // Same size: refill the texture in place instead of making a new one 20 times a second,
        // which used up WebView2's graphics memory and left parts of long pages unpainted.
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      }
      gl.viewport(0, 0, w, h);
      const px = w / Math.max(1, el.clientWidth); // physical pixels per CSS pixel
      gl.uniform2f(uniforms.size, w, h);
      gl.uniform1f(uniforms.radius, 8 * px);
      gl.uniform1f(uniforms.edge, 20 * px);
      gl.uniform1f(uniforms.bend, 10 * px);
      gl.uniform1f(uniforms.split, 0.3);
      gl.uniform1f(uniforms.fog, fog * px); // foggy enough that the time stays easy to read
      gl.uniform1f(uniforms.zoom, 4.5 * px); // very subtle enlargement
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    async function run() {
      const ok = await glassCapture(true).catch(() => false);
      if (!ok) return;
      let failures = 0;
      while (alive) {
        const started = performance.now();
        try {
          draw(await glassFrame(scale));
          failures = 0;
          show(true);
        } catch (err) {
          // "paused": a screenshot is being taken, so the glass keeps its last picture for a moment.
          // A missed picture (e.g. the screen is locked) is fine too; many in a row means give up.
          if (String(err) !== "paused" && ++failures > 30) break;
        }
        const wait = Math.max(0, 1000 / fps - (performance.now() - started));
        await new Promise((r) => window.setTimeout(r, wait));
      }
      show(false);
    }
    void run();

    return () => {
      alive = false;
      void glassCapture(false).catch(() => undefined);
    };
  }, [onActive, scale, fps, fog]);

  return <canvas ref={canvas} className={className} data-on={on} aria-hidden="true" />;
}
