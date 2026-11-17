/**
 * Tidepool audio engine — a small WebAudio synth with spatial voices,
 * a generated reverb tail, an ambient drone bed and a "tide" filter that the
 * player shapes with an open palm.
 */

export interface Listenable {
  px: number;
  py: number;
  pz: number;
  fx: number;
  fy: number;
  fz: number;
  ux: number;
  uy: number;
  uz: number;
}

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class TideAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private bus!: GainNode;
  private tideFilter!: BiquadFilterNode;
  private wet!: GainNode;
  private dry!: GainNode;
  private droneGain!: GainNode;
  private droneOscs: OscillatorNode[] = [];
  private noiseFilter!: BiquadFilterNode;
  private noiseBuffer!: AudioBuffer;
  private activeVoices = 0;

  /** Must be called from a user gesture (entering XR, click). */
  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state !== 'running') void this.ctx.resume();
      return;
    }
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    comp.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(comp);

    this.bus = ctx.createGain();
    this.tideFilter = ctx.createBiquadFilter();
    this.tideFilter.type = 'lowpass';
    this.tideFilter.Q.value = 0.7;
    this.tideFilter.frequency.value = 4200;
    this.bus.connect(this.tideFilter);

    this.dry = ctx.createGain();
    this.dry.gain.value = 0.75;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.45;
    const verb = ctx.createConvolver();
    verb.buffer = this.makeImpulse(3.4, 2.6);
    this.tideFilter.connect(this.dry).connect(this.master);
    this.tideFilter.connect(verb).connect(this.wet).connect(this.master);

    // noise buffer shared by water bed and splashes
    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // ambient bed: soft drone + filtered water noise
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0;
    this.droneGain.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 4);
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 500;
    this.droneGain.connect(droneFilter).connect(this.bus);

    const water = ctx.createBufferSource();
    water.buffer = this.noiseBuffer;
    water.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'lowpass';
    this.noiseFilter.frequency.value = 420;
    const waterGain = ctx.createGain();
    waterGain.gain.value = 0.018;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(this.noiseFilter.frequency);
    lfo.start();
    water.connect(this.noiseFilter).connect(waterGain).connect(this.bus);
    water.start();

    if (ctx.state !== 'running') void ctx.resume();
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  setDrone(rootMidi: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const o of this.droneOscs) {
      try {
        o.stop(t + 2.5);
      } catch {
        /* already stopped */
      }
    }
    this.droneOscs = [];
    const notes = [rootMidi - 24, rootMidi - 17, rootMidi - 12];
    for (const n of notes) {
      for (const det of [-4, 4]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = midiToHz(n);
        o.detune.value = det;
        const g = ctx.createGain();
        g.gain.value = 0;
        g.gain.linearRampToValueAtTime(0.33, t + 3);
        o.connect(g).connect(this.droneGain);
        o.start(t);
        this.droneOscs.push(o);
      }
    }
  }

  /** tide 0..1 → darker/quieter … brighter/airier */
  setTide(tide: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const freq = 380 * Math.pow(9000 / 380, tide);
    this.tideFilter.frequency.setTargetAtTime(freq, t, 0.08);
    this.wet.gain.setTargetAtTime(0.25 + 0.45 * (1 - tide), t, 0.2);
  }

  updateListener(l: Listenable): void {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    if (L.positionX) {
      const t = this.ctx.currentTime;
      L.positionX.setValueAtTime(l.px, t);
      L.positionY.setValueAtTime(l.py, t);
      L.positionZ.setValueAtTime(l.pz, t);
      L.forwardX.setValueAtTime(l.fx, t);
      L.forwardY.setValueAtTime(l.fy, t);
      L.forwardZ.setValueAtTime(l.fz, t);
      L.upX.setValueAtTime(l.ux, t);
      L.upY.setValueAtTime(l.uy, t);
      L.upZ.setValueAtTime(l.uz, t);
    } else {
      L.setPosition(l.px, l.py, l.pz);
      L.setOrientation(l.fx, l.fy, l.fz, l.ux, l.uy, l.uz);
    }
  }

  private panner(x: number, y: number, z: number): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 0.4;
    p.rolloffFactor = 0.6;
    if (p.positionX) {
      p.positionX.value = x;
      p.positionY.value = y;
      p.positionZ.value = z;
    } else {
      p.setPosition(x, y, z);
    }
    p.connect(this.bus);
    return p;
  }

  /** A soft glassy bell — the voice of every light in the pool. */
  note(
    midi: number,
    x: number,
    y: number,
    z: number,
    velocity = 1,
    length = 1.8,
  ): void {
    if (!this.ready) return;
    if (this.activeVoices > 28) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.005;
    const f = midiToHz(midi);
    const out = this.panner(x, y, z);
    const env = ctx.createGain();
    const peak = 0.22 * velocity;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.008);
    env.gain.exponentialRampToValueAtTime(peak * 0.35, t + 0.25);
    env.gain.exponentialRampToValueAtTime(0.0001, t + length);
    env.connect(out);

    const o1 = ctx.createOscillator();
    o1.type = 'sine';
    o1.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = f * 2;
    o2.detune.value = 3;
    const g2 = ctx.createGain();
    g2.gain.value = 0.18;
    // FM shimmer that fades fast — gives a "struck glass" onset
    const mod = ctx.createOscillator();
    mod.frequency.value = f * 3.5;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(f * 0.9, t);
    modGain.gain.exponentialRampToValueAtTime(1, t + 0.35);
    mod.connect(modGain).connect(o1.frequency);

    o1.connect(env);
    o2.connect(g2).connect(env);
    const end = t + length + 0.05;
    for (const o of [o1, o2, mod]) {
      o.start(t);
      o.stop(end);
    }
    this.activeVoices++;
    o1.onended = () => {
      this.activeVoices--;
      out.disconnect();
    };
  }

  /** Water drop: a short pitched "bloop" plus a sprinkle of noise. */
  drip(midi: number, x: number, y: number, z: number, velocity = 1): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.003;
    const out = this.panner(x, y, z);
    const f = midiToHz(midi);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f * 0.6, t);
    o.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.16 * velocity, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.25);
    this.splash(out, t, 0.05 * velocity, 2600, 0.12);
    // a quieter bell so drips are musical, not just noise
    this.note(midi, x, y, z, 0.55 * velocity, 1.1);
    o.onended = () => out.disconnect();
  }

  private splash(
    out: AudioNode,
    t: number,
    gain: number,
    freq: number,
    len: number,
  ): void {
    const ctx = this.ctx!;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(freq, t);
    bp.frequency.exponentialRampToValueAtTime(freq * 0.4, t + len);
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    n.connect(bp).connect(g).connect(out);
    n.start(t, Math.random());
    n.stop(t + len + 0.02);
  }

  /** A light dissolving back into the air. */
  dissolve(x: number, y: number, z: number): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this.panner(x, y, z);
    this.splash(out, t, 0.06, 5200, 0.7);
    setTimeout(() => out.disconnect(), 1200);
  }

  /** Pebble tap. */
  tick(x: number, y: number, z: number, pitch = 1): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const out = this.panner(x, y, z);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(900 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(420 * pitch, t + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.1);
    o.onended = () => out.disconnect();
  }
}

export const tideAudio = new TideAudio();
