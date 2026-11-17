/**
 * Procedural visuals for Tidepool: the water surface shader (ripples, sweeping
 * moonbeam, step ticks, caustics), glow sprites and text labels.
 * Everything here is runtime-only (uses DOM canvas), so it lives outside the
 * shared asset manifest.
 */
import {
  AdditiveBlending,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  Vector3,
  Vector4,
} from '@iwsdk/core';

export const MAX_RIPPLES = 24;
export const STEPS = 16;

const vert = /* glsl */ `
varying vec2 vPos;
void main() {
  vPos = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const frag = /* glsl */ `
#define MAX_RIPPLES ${MAX_RIPPLES}
#define STEPS ${STEPS}.0
uniform float uTime;
uniform float uRadius;
uniform float uSweep;
uniform float uTide;
uniform float uGlow;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uBeam;
uniform vec4 uRipples[MAX_RIPPLES];   // x, y, startTime, strength
uniform vec3 uRippleColors[MAX_RIPPLES];
varying vec2 vPos;

float caustic(vec2 p, float t) {
  float v = 0.0;
  v += sin(p.x * 61.0 + t * 0.9 + sin(p.y * 47.0 + t * 0.7));
  v += sin(p.y * 53.0 - t * 1.1 + sin(p.x * 39.0 - t * 0.5));
  v += sin((p.x + p.y) * 41.0 + t * 0.6);
  return v / 3.0;
}

void main() {
  float r = length(vPos) / uRadius;
  if (r > 1.0) discard;
  // pool body: deep centre, brighter rim
  vec3 col = mix(uDeep, uShallow, smoothstep(0.0, 1.0, r * r));
  float c = caustic(vPos, uTime);
  col += uShallow * 0.18 * smoothstep(0.55, 1.0, c) * (0.4 + 0.6 * uTide);

  // ripples
  vec3 rip = vec3(0.0);
  float ripA = 0.0;
  for (int i = 0; i < MAX_RIPPLES; i++) {
    vec4 rp = uRipples[i];
    float age = uTime - rp.z;
    if (age < 0.0 || age > 3.0 || rp.w <= 0.0) continue;
    float d = distance(vPos, rp.xy);
    float front = age * 0.16;
    float w = exp(-pow((d - front) / 0.009, 2.0));
    float w2 = exp(-pow((d - front * 0.72) / 0.006, 2.0)) * 0.5;
    float fade = exp(-age * 1.5) * rp.w;
    float core = exp(-d * d / 0.0004) * exp(-age * 5.0) * rp.w;
    float v = (w + w2) * fade + core;
    rip += uRippleColors[i] * v;
    ripA += v;
  }
  col += rip * 1.6;

  // moonbeam sweep: a bright leading edge with a fading trail
  float ang = atan(vPos.x, vPos.y);               // 0 = far side, clockwise
  float a01 = fract(ang / 6.2831853 + 1.0);
  float behind = fract(uSweep - a01 + 1.0);       // 0 at the beam, grows behind it
  float beam = exp(-behind * 90.0) * 0.55 + exp(-behind * 14.0) * 0.07;
  beam *= smoothstep(0.08, 0.3, r);
  col += uBeam * beam * (0.55 + 0.45 * uTide);

  // step ticks around the rim + inner "octave" ring
  float stepA = fract(a01 * STEPS + 0.5) - 0.5;
  float tick = exp(-stepA * stepA * 420.0) * exp(-pow((r - 0.93) * 30.0, 2.0));
  float beat = mod(floor(a01 * STEPS + 0.5), 4.0) < 0.5 ? 1.0 : 0.45;
  col += uShallow * tick * 0.9 * beat;
  float ring = exp(-pow((r - 0.5) * 70.0, 2.0)) * 0.18;
  col += uShallow * ring;

  float alpha = 0.72 + 0.25 * smoothstep(0.75, 1.0, r) + ripA * 0.3 + beam * 0.2;
  alpha *= smoothstep(1.0, 0.97, r);
  col *= uGlow;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  #include <colorspace_fragment>
}
`;

export function createWaterMaterial(radius: number): ShaderMaterial {
  const ripples: Vector4[] = [];
  const colors: Vector3[] = [];
  for (let i = 0; i < MAX_RIPPLES; i++) {
    ripples.push(new Vector4(0, 0, -100, 0));
    colors.push(new Vector3(1, 1, 1));
  }
  return new ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uRadius: { value: radius },
      uSweep: { value: 0 },
      uTide: { value: 0.6 },
      uGlow: { value: 1 },
      uDeep: { value: new Color(0x031a2a) },
      uShallow: { value: new Color(0x1f8fa8) },
      uBeam: { value: new Color(0xbfeaff) },
      uRipples: { value: ripples },
      uRippleColors: { value: colors },
    },
  });
}

export function createWaterMesh(radius: number): Mesh {
  const geo = new CircleGeometry(radius, 128);
  const mesh = new Mesh(geo, createWaterMaterial(radius));
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 1;
  mesh.name = 'TidepoolWater';
  return mesh;
}

/** Soft round glow used for halos around lights. */
export function createGlowTexture(): Texture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.65)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

export function glowMaterial(tex: Texture, color: Color): MeshBasicMaterial {
  return new MeshBasicMaterial({
    map: tex,
    color,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}

/** A billboard text label rendered to a canvas texture; text can be updated. */
export class Label {
  readonly mesh: Mesh;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tex: CanvasTexture;
  private text = '';
  private sub = '';
  readonly mat: MeshBasicMaterial;

  constructor(
    widthM: number,
    private pxW = 1024,
    private pxH = 256,
    private fontPx = 64,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new CanvasTexture(this.canvas);
    this.tex.colorSpace = SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mat = new MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    this.mesh = new Mesh(
      new PlaneGeometry(widthM, (widthM * pxH) / pxW),
      this.mat,
    );
    this.mesh.renderOrder = 5;
  }

  set(text: string, sub = ''): void {
    if (text === this.text && sub === this.sub) return;
    this.text = text;
    this.sub = sub;
    const { ctx, pxW, pxH, fontPx } = this;
    ctx.clearRect(0, 0, pxW, pxH);
    if (!text && !sub) {
      this.tex.needsUpdate = true;
      return;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,10,20,0.9)';
    ctx.shadowBlur = 14;
    const font = '"Avenir Next", "Segoe UI", system-ui, sans-serif';
    const lines = this.wrap(text, `600 ${fontPx}px ${font}`, pxW * 0.92);
    const subPx = Math.round(fontPx * 0.62);
    const total = lines.length * fontPx * 1.2 + (sub ? subPx * 1.5 : 0);
    let y = pxH / 2 - total / 2 + fontPx * 0.6;
    ctx.fillStyle = '#eafcff';
    ctx.font = `600 ${fontPx}px ${font}`;
    for (const l of lines) {
      ctx.fillText(l, pxW / 2, y);
      y += fontPx * 1.2;
    }
    if (sub) {
      ctx.font = `500 ${subPx}px ${font}`;
      ctx.fillStyle = 'rgba(160,230,245,0.9)';
      ctx.fillText(sub, pxW / 2, y + subPx * 0.2);
    }
    this.tex.needsUpdate = true;
  }

  private wrap(text: string, font: string, maxW: number): string[] {
    const ctx = this.ctx;
    ctx.font = font;
    const words = text.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }
}
