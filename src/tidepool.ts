/**
 * TidepoolSystem — the whole experience.
 *
 *  • A glowing pool of water floats at desk height in passthrough.
 *  • Seven lights (one per note of the current mood) hover over the far rim.
 *    Pinch a light to take a copy, drop it into the pool to plant it.
 *  • A moonbeam sweeps the pool like a clock hand; every planted light it
 *    passes rings out (16 steps per loop). Inner ring = one octave up.
 *  • Dip a fingertip in the water to play along; drag it to strum.
 *  • Hold a flat palm over the pool and raise / lower it to shift the tide
 *    (filter brightness + reverb depth).
 *  • Tap the rim pebbles to change mood, tempo, or clear the pool.
 *  • Pinch the water with both hands to move the pool.
 *  • The pool remembers what you planted between visits.
 */
import {
  AdditiveBlending,
  Color,
  createSystem,
  Entity,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Raycaster,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Texture,
  TorusGeometry,
  Vector2,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import { tideAudio } from './audio.js';
import { HandState } from './hands.js';
import {
  Mote,
  Pebble,
  PebbleActions,
  Seed,
  SeedStates,
} from './tide-components.js';
import {
  createGlowTexture,
  createWaterMesh,
  Label,
  MAX_RIPPLES,
  STEPS,
} from './visuals.js';

const R = 0.2; // pool radius (m)
const INNER = 0.1; // inner ring radius — octave up inside it
const MAX_SEEDS = 32;
const STORE_KEY = 'tidepool.v1';

interface Mood {
  name: string;
  notes: number[];
  colors: number[];
  deep: number;
  shallow: number;
  beam: number;
}

const MOODS: Mood[] = [
  {
    name: 'Dawn',
    notes: [60, 62, 64, 67, 69, 72, 74],
    colors: [
      0xff7a6b, 0xffb35c, 0xffe066, 0x8ff08a, 0x5ce1e6, 0x7aa8ff, 0xd38cff,
    ],
    deep: 0x062033,
    shallow: 0x2aa5b8,
    beam: 0xfff1c9,
  },
  {
    name: 'Dusk',
    notes: [57, 60, 62, 64, 67, 69, 72],
    colors: [
      0xff5fa2, 0xff8a5c, 0xffc46b, 0xc78bff, 0x8f7bff, 0x5fb8ff, 0x63f2d2,
    ],
    deep: 0x12082a,
    shallow: 0x7a4fc9,
    beam: 0xffc9e8,
  },
  {
    name: 'Deep',
    notes: [62, 63, 67, 69, 70, 74, 75],
    colors: [
      0x39f0c8, 0x2fc4ff, 0x4f7dff, 0x9a6bff, 0x55ffa0, 0x7ff6ff, 0xbfe3ff,
    ],
    deep: 0x010b14,
    shallow: 0x0f6a7a,
    beam: 0xa8fff0,
  },
];

const TEMPOS = [
  { name: 'Drift', bpm: 72 },
  { name: 'Flow', bpm: 92 },
  { name: 'Rush', bpm: 116 },
];

const HINTS = [
  'Pinch a floating light and drop it into the pool',
  'The moonbeam rings every light it passes. Plant a few more.',
  'Dip a fingertip into the water to play along',
  'Hold your palm flat over the pool. Raise or lower it to shift the tide.',
  'Tap a pebble to change mood or tempo. Pinch the water with both hands to move the pool.',
];

interface SavedSeed {
  s: number; // slot
  t: number; // step
  r: number; // radius
}
interface SaveData {
  seeds: SavedSeed[];
  mood: number;
  tempo: number;
  tide: number;
  hint: number;
}

type Carrier = 0 | 1 | 2; // left, right, mouse

export class TidepoolSystem extends createSystem({
  motes: { required: [Mote] },
  seeds: { required: [Seed] },
  pebbles: { required: [Pebble] },
}) {
  // scene
  private pool!: Group;
  private poolEntity!: Entity;
  private water!: Mesh;
  private waterMat!: ShaderMaterial;
  private rimMat!: MeshBasicMaterial;
  private rimGlowMat!: MeshBasicMaterial;
  private glowTex!: Texture;
  private coreMats: MeshBasicMaterial[] = [];
  private haloMats: SpriteMaterial[] = [];
  private seedGeo = new SphereGeometry(0.011, 20, 14);
  private moteGeo = new SphereGeometry(0.015, 24, 16);
  private hint!: Label;
  private tideLabel!: Label;
  private pebbleLabels = new Map<string, Label>();
  private tideRing!: Mesh;
  private tideRingMat!: MeshBasicMaterial;

  // state
  private clock = 0;
  private phase = 0; // loop position 0..1
  private moodIndex = 0;
  private tempoIndex = 1;
  private tide = 0.6;
  private tideSent = -1;
  private hintIndex = 0;
  private hintTimer = 0;
  private plantedCount = 0;
  private dripCount = 0;
  private tideUsed = 0;
  private rippleCursor = 0;
  private hands = [new HandState('left'), new HandState('right')];
  private carry: (Entity | null)[] = [null, null, null];
  private touching = [false, false];
  private lastDripPos = [new Vector3(), new Vector3()];
  private lastDripTime = [0, 0];
  private palmHold = [0, 0];
  private pebbleArmed = new Map<Entity, boolean>();
  private holdingPool = [false, false];
  private moving = false;
  private moveStartMid = new Vector3();
  private moveStartPos = new Vector3();
  private moveStartYaw = 0;
  private moveStartAngle = 0;
  private placed = false;
  private placeTimer = -1;
  private boundSession: XRSession | null = null;
  private saveTimer = -1;
  private welcomeBack = 0;

  // scratch
  private v1 = new Vector3();
  private v2 = new Vector3();
  private v3 = new Vector3();
  private headPos = new Vector3();
  private headQuat = new Quaternion();
  private originMat = new Matrix4();
  private tmpColor = new Color();
  private raycaster = new Raycaster();
  private ndc = new Vector2();
  private mouseLocal = new Vector3();
  private mouseActive = false;
  private listener = {
    px: 0,
    py: 0,
    pz: 0,
    fx: 0,
    fy: 0,
    fz: -1,
    ux: 0,
    uy: 1,
    uz: 0,
  };

  init(): void {
    this.glowTex = createGlowTexture();
    const saved = this.load();

    // ── pool ──────────────────────────────────────────────────────────
    this.pool = new Group();
    this.pool.name = 'Tidepool';
    this.poolEntity = this.world.createTransformEntity(this.pool);
    this.water = createWaterMesh(R);
    this.waterMat = this.water.material as ShaderMaterial;
    this.pool.add(this.water);

    this.rimMat = new MeshBasicMaterial({ color: 0x9fe8ff });
    const rim = new Mesh(new TorusGeometry(R, 0.0035, 12, 160), this.rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.name = 'TidepoolRim';
    this.pool.add(rim);
    this.rimGlowMat = new MeshBasicMaterial({
      color: 0x58c9ff,
      transparent: true,
      opacity: 0.25,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const rimGlow = new Mesh(
      new TorusGeometry(R, 0.012, 10, 160),
      this.rimGlowMat,
    );
    rimGlow.rotation.x = Math.PI / 2;
    this.pool.add(rimGlow);

    // tide indicator ring (appears under the palm)
    this.tideRingMat = new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.tideRing = new Mesh(new RingGeometry(0.03, 0.036, 48), this.tideRingMat);
    this.tideRing.rotation.x = -Math.PI / 2;
    this.tideRing.position.y = 0.004;
    this.tideRing.renderOrder = 3;
    this.pool.add(this.tideRing);

    // shared per-note materials (recoloured when the mood changes)
    for (let i = 0; i < 7; i++) {
      this.coreMats.push(new MeshBasicMaterial({ color: 0xffffff }));
      this.haloMats.push(
        new SpriteMaterial({
          map: this.glowTex,
          color: 0xffffff,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      );
    }

    // ── motes (source lights) ────────────────────────────────────────
    for (let i = 0; i < 7; i++) {
      const g = new Group();
      g.name = `Mote${i}`;
      const core = new Mesh(this.moteGeo, this.coreMats[i]);
      const halo = new Sprite(this.haloMats[i]);
      halo.scale.setScalar(0.085);
      g.add(core, halo);
      const e = this.world.createTransformEntity(g, this.poolEntity);
      e.addComponent(Mote, { slot: i });
      this.layoutMote(g, i, 0);
    }

    // ── pebbles (fingertip buttons on the near rim) ─────────────────
    const actions = [
      PebbleActions.Mood,
      PebbleActions.Tempo,
      PebbleActions.Clear,
    ];
    const pebbleGeo = new SphereGeometry(0.017, 24, 16);
    actions.forEach((action, i) => {
      const a = Math.PI + (i - 1) * 0.5;
      const rr = R + 0.045;
      const g = new Group();
      g.name = `Pebble_${action}`;
      const mat = new MeshStandardMaterial({
        color: action === 'clear' ? 0x9aa6b2 : 0xdfe9ef,
        roughness: 0.35,
        metalness: 0.1,
        emissive: new Color(action === 'clear' ? 0x3a1a22 : 0x123040),
      });
      const stone = new Mesh(pebbleGeo, mat);
      stone.scale.set(1.15, 0.55, 1);
      g.add(stone);
      g.position.set(Math.sin(a) * rr, 0.004, -Math.cos(a) * rr);
      const label = new Label(0.11, 512, 160, 56);
      label.mesh.position.set(0, 0.05, 0);
      g.add(label.mesh);
      this.pebbleLabels.set(action, label);
      const e = this.world.createTransformEntity(g, this.poolEntity);
      e.addComponent(Pebble, { action });
      this.pebbleArmed.set(e, true);
    });

    // ── labels ───────────────────────────────────────────────────────
    this.hint = new Label(0.36, 1024, 300, 58);
    this.hint.mesh.position.set(0, 0.3, -0.1);
    this.pool.add(this.hint.mesh);
    this.tideLabel = new Label(0.14, 512, 128, 52);
    this.tideLabel.mat.opacity = 0;
    this.pool.add(this.tideLabel.mesh);

    // ── restore ──────────────────────────────────────────────────────
    if (saved) {
      this.moodIndex = saved.mood % MOODS.length;
      this.tempoIndex = saved.tempo % TEMPOS.length;
      this.tide = saved.tide;
      this.hintIndex = Math.min(saved.hint, HINTS.length);
      for (const s of saved.seeds.slice(0, MAX_SEEDS)) {
        const e = this.spawnSeed(s.s, null);
        e.setValue(Seed, 'step', s.t);
        e.setValue(Seed, 'radius', s.r);
        e.setValue(Seed, 'high', s.r < INNER);
        e.setValue(Seed, 'state', SeedStates.Resting);
        this.placeSeedOnSurface(e);
      }
      this.plantedCount = saved.seeds.length;
      if (saved.seeds.length > 0) this.welcomeBack = 6;
    }
    this.applyMood();
    this.refreshPebbleLabels();
    this.updateHint(0);
    this.placeForDesktop();

    // ── session / input wiring ──────────────────────────────────────
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        if (state === VisibilityState.NonImmersive) {
          this.placed = false;
          this.placeTimer = -1;
          this.placeForDesktop();
          for (let i = 0; i < 2; i++) this.hands[i].bind(null);
        } else if (!this.placed && this.placeTimer < 0) {
          this.placeTimer = 0.35;
          tideAudio.ensure();
          tideAudio.setDrone(MOODS[this.moodIndex].notes[0]);
        }
      }),
    );
    this.setupMouse();
    if (import.meta.env.DEV) {
      (globalThis as Record<string, unknown>).__tidepool = this;
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // persistence
  private load(): SaveData | null {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw) as SaveData;
      if (!Array.isArray(d.seeds)) return null;
      return d;
    } catch {
      return null;
    }
  }

  private queueSave(): void {
    this.saveTimer = 0.5;
  }

  private save(): void {
    const seeds: SavedSeed[] = [];
    for (const e of this.queries.seeds.entities) {
      if (e.getValue(Seed, 'state') !== SeedStates.Resting) continue;
      seeds.push({
        s: e.getValue(Seed, 'slot') ?? 0,
        t: e.getValue(Seed, 'step') ?? 0,
        r: Math.round((e.getValue(Seed, 'radius') ?? 0.1) * 1000) / 1000,
      });
    }
    const data: SaveData = {
      seeds,
      mood: this.moodIndex,
      tempo: this.tempoIndex,
      tide: Math.round(this.tide * 100) / 100,
      hint: this.hintIndex,
    };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch {
      /* storage unavailable — fine */
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // layout / placement
  private layoutMote(g: Group, slot: number, t: number): void {
    const a = ((slot / 6) * 2 - 1) * 1.15; // spread over the far half
    const rr = R * 0.82;
    g.position.set(
      Math.sin(a) * rr,
      0.12 + Math.sin(t * 1.3 + slot * 0.9) * 0.008,
      -Math.cos(a) * rr,
    );
  }

  private placeForDesktop(): void {
    this.pool.position.set(0, 1.12, 0.32);
    this.pool.rotation.set(0, 0, 0);
  }

  private placeInFrontOfHead(): void {
    const cam = this.world.camera;
    cam.getWorldPosition(this.headPos);
    cam.getWorldQuaternion(this.headQuat);
    const f = this.v1.set(0, 0, -1).applyQuaternion(this.headQuat);
    f.y = 0;
    if (f.lengthSq() < 1e-4) f.set(0, 0, -1);
    f.normalize();
    this.pool.position.set(
      this.headPos.x + f.x * 0.4,
      this.headPos.y - 0.38,
      this.headPos.z + f.z * 0.4,
    );
    this.pool.rotation.set(0, Math.atan2(-f.x, -f.z), 0);
    this.placed = true;
  }

  // ───────────────────────────────────────────────────────────────────
  // seeds
  private spawnSeed(slot: number, carrier: Carrier | null): Entity {
    const g = new Group();
    g.name = 'Seed';
    const core = new Mesh(this.seedGeo, this.coreMats[slot]);
    const halo = new Sprite(this.haloMats[slot]);
    halo.scale.setScalar(0.06);
    g.add(core, halo);
    const e = this.world.createTransformEntity(g, this.poolEntity);
    e.addComponent(Seed, {
      slot,
      state: SeedStates.Carried,
      age: 0,
      pulse: 1,
    });
    if (carrier !== null) this.carry[carrier] = e;
    return e;
  }

  private placeSeedOnSurface(e: Entity): void {
    const step = e.getValue(Seed, 'step') ?? 0;
    const r = e.getValue(Seed, 'radius') ?? 0.1;
    const a = (step / STEPS) * Math.PI * 2;
    e.object3D!.position.set(Math.sin(a) * r, 0.008, -Math.cos(a) * r);
  }

  /** Drop a carried seed at pool-local point p. Returns false if outside. */
  private releaseSeed(e: Entity, p: Vector3): boolean {
    const horiz = Math.hypot(p.x, p.z);
    const inZone = horiz < R * 1.08 && p.y > -0.08 && p.y < 0.32;
    if (!inZone) {
      this.dissolveSeed(e);
      return false;
    }
    let count = 0;
    let oldest: Entity | null = null;
    let oldestAge = -1;
    for (const s of this.queries.seeds.entities) {
      if (s.getValue(Seed, 'state') !== SeedStates.Resting) continue;
      count++;
      const age = s.getValue(Seed, 'age') ?? 0;
      if (age > oldestAge) {
        oldestAge = age;
        oldest = s;
      }
    }
    if (count >= MAX_SEEDS && oldest) this.dissolveSeed(oldest);

    const a01 = (Math.atan2(p.x, -p.z) / (Math.PI * 2) + 1) % 1;
    const step = Math.round(a01 * STEPS) % STEPS;
    const r = Math.min(R - 0.022, Math.max(0.035, horiz));
    e.setValue(Seed, 'step', step);
    e.setValue(Seed, 'radius', r);
    e.setValue(Seed, 'high', r < INNER);
    e.setValue(Seed, 'state', SeedStates.Falling);
    e.setValue(Seed, 'age', 0);
    // keep current height; the update loop drops it onto its step
    const a = (step / STEPS) * Math.PI * 2;
    e.object3D!.position.set(
      Math.sin(a) * r,
      Math.max(0.02, p.y),
      -Math.cos(a) * r,
    );
    return true;
  }

  private dissolveSeed(e: Entity): void {
    if (e.getValue(Seed, 'state') === SeedStates.Dissolving) return;
    e.setValue(Seed, 'state', SeedStates.Dissolving);
    e.setValue(Seed, 'age', 0);
    for (let i = 0; i < 3; i++) if (this.carry[i] === e) this.carry[i] = null;
    e.object3D!.getWorldPosition(this.v3);
    tideAudio.dissolve(this.v3.x, this.v3.y, this.v3.z);
    this.queueSave();
  }

  private seedMidi(e: Entity): number {
    const slot = e.getValue(Seed, 'slot') ?? 0;
    const high = e.getValue(Seed, 'high') ?? false;
    return MOODS[this.moodIndex].notes[slot] + (high ? 12 : 0);
  }

  private ringSeed(e: Entity, velocity: number): void {
    const o = e.object3D!;
    o.getWorldPosition(this.v3);
    tideAudio.note(this.seedMidi(e), this.v3.x, this.v3.y, this.v3.z, velocity);
    e.setValue(Seed, 'pulse', 1);
    const slot = e.getValue(Seed, 'slot') ?? 0;
    this.addRipple(o.position.x, o.position.z, 0.9 * velocity, slot);
  }

  // ───────────────────────────────────────────────────────────────────
  // ripples
  private addRipple(x: number, z: number, strength: number, slot: number) {
    const u = this.waterMat.uniforms;
    const i = this.rippleCursor;
    this.rippleCursor = (i + 1) % MAX_RIPPLES;
    u.uRipples.value[i].set(x, -z, this.clock, strength);
    this.tmpColor.set(MOODS[this.moodIndex].colors[slot]);
    u.uRippleColors.value[i].set(
      this.tmpColor.r,
      this.tmpColor.g,
      this.tmpColor.b,
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // mood / tempo / pebbles
  private applyMood(): void {
    const m = MOODS[this.moodIndex];
    for (let i = 0; i < 7; i++) {
      this.coreMats[i].color.set(m.colors[i]).multiplyScalar(1.15);
      this.haloMats[i].color.set(m.colors[i]);
    }
    const u = this.waterMat.uniforms;
    (u.uDeep.value as Color).set(m.deep);
    (u.uShallow.value as Color).set(m.shallow);
    (u.uBeam.value as Color).set(m.beam);
    this.rimMat.color.set(m.shallow).lerp(this.tmpColor.set(0xffffff), 0.55);
    this.rimGlowMat.color.set(m.shallow);
    if (tideAudio.ready) tideAudio.setDrone(m.notes[0]);
  }

  private refreshPebbleLabels(): void {
    this.pebbleLabels.get('mood')?.set(MOODS[this.moodIndex].name, 'mood');
    this.pebbleLabels.get('tempo')?.set(TEMPOS[this.tempoIndex].name, 'tempo');
    this.pebbleLabels.get('clear')?.set('Clear', 'pool');
  }

  private triggerPebble(e: Entity): void {
    const action = e.getValue(Pebble, 'action');
    e.setValue(Pebble, 'press', 1);
    e.object3D!.getWorldPosition(this.v3);
    if (action === PebbleActions.Mood) {
      this.moodIndex = (this.moodIndex + 1) % MOODS.length;
      this.applyMood();
      tideAudio.tick(this.v3.x, this.v3.y, this.v3.z, 1);
      // a little arpeggio to announce the new mood
      const notes = MOODS[this.moodIndex].notes;
      [0, 2, 4].forEach((n, k) =>
        setTimeout(
          () => tideAudio.note(notes[n] + 12, this.v3.x, this.v3.y, this.v3.z, 0.5, 1.2),
          80 + k * 110,
        ),
      );
    } else if (action === PebbleActions.Tempo) {
      this.tempoIndex = (this.tempoIndex + 1) % TEMPOS.length;
      tideAudio.tick(this.v3.x, this.v3.y, this.v3.z, 1.3);
    } else {
      tideAudio.tick(this.v3.x, this.v3.y, this.v3.z, 0.7);
      for (const s of this.queries.seeds.entities) {
        if (s.getValue(Seed, 'state') === SeedStates.Resting) {
          this.dissolveSeed(s);
        }
      }
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        this.addRipple(Math.sin(a) * 0.12, -Math.cos(a) * 0.12, 0.6, i % 7);
      }
    }
    this.refreshPebbleLabels();
    this.queueSave();
  }

  // ───────────────────────────────────────────────────────────────────
  // onboarding
  private advanceHints(): void {
    let target = this.hintIndex;
    if (target === 0 && this.plantedCount >= 1) target = 1;
    if (target === 1 && this.plantedCount >= 3) target = 2;
    if (target === 2 && this.dripCount >= 1) target = 3;
    if (target === 3 && this.tideUsed > 0.6) target = 4;
    if (target !== this.hintIndex) {
      this.hintIndex = target;
      this.hintTimer = 0;
      this.queueSave();
    }
  }

  private updateHint(delta: number): void {
    this.hintTimer += delta;
    if (this.welcomeBack > 0) {
      this.welcomeBack -= delta;
      this.hint.set('Welcome back', 'your pool kept its lights');
      this.hint.mat.opacity = Math.min(1, this.welcomeBack);
      return;
    }
    if (this.hintIndex < HINTS.length) {
      const last = this.hintIndex === HINTS.length - 1;
      this.hint.set(HINTS[this.hintIndex], `${this.hintIndex + 1} / ${HINTS.length}`);
      const fade = last ? Math.max(0, Math.min(1, (14 - this.hintTimer) / 2)) : 1;
      this.hint.mat.opacity = Math.min(1, this.hintTimer * 2) * fade;
      if (last && this.hintTimer > 14) {
        this.hintIndex = HINTS.length;
        this.queueSave();
      }
    } else {
      this.hint.mat.opacity = 0;
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // desktop preview (mouse) — handy for judges without a headset nearby
  private setupMouse(): void {
    const el = this.world.renderer.domElement;
    const toNdc = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      this.ndc.set(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -((ev.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(this.ndc, this.world.camera);
    };
    const onMove = (ev: PointerEvent) => {
      if (this.world.visibilityState.peek() !== VisibilityState.NonImmersive)
        return;
      toNdc(ev);
      // intersect the horizontal plane 6 cm above the water
      this.pool.updateMatrixWorld();
      const ray = this.raycaster.ray;
      const planeY = this.pool.position.y + 0.06;
      if (Math.abs(ray.direction.y) > 1e-4) {
        const t = (planeY - ray.origin.y) / ray.direction.y;
        if (t > 0) {
          this.v2.copy(ray.direction).multiplyScalar(t).add(ray.origin);
          this.mouseLocal.copy(this.v2);
          this.pool.worldToLocal(this.mouseLocal);
          this.mouseActive = true;
        }
      }
    };
    const onDown = (ev: PointerEvent) => {
      if (this.world.visibilityState.peek() !== VisibilityState.NonImmersive)
        return;
      tideAudio.ensure();
      if (tideAudio.ready && !this.droneStarted) {
        this.droneStarted = true;
        tideAudio.setDrone(MOODS[this.moodIndex].notes[0]);
      }
      onMove(ev);
      // pebbles / motes / seeds first
      const pick: { e: Entity | null } = { e: null };
      let bestKind = '';
      let bestDist = Infinity;
      const consider = (e: Entity, kind: string) => {
        const hits = this.raycaster.intersectObject(e.object3D!, true);
        for (const h of hits) {
          if (h.object instanceof Sprite) continue;
          if (h.distance < bestDist) {
            bestDist = h.distance;
            pick.e = e;
            bestKind = kind;
          }
          break;
        }
      };
      for (const e of this.queries.pebbles.entities) consider(e, 'pebble');
      for (const e of this.queries.motes.entities) consider(e, 'mote');
      for (const e of this.queries.seeds.entities) {
        if (e.getValue(Seed, 'state') === SeedStates.Resting) consider(e, 'seed');
      }
      const carried = this.carry[2];
      const best = pick.e;
      if (best && bestKind === 'pebble') {
        this.triggerPebble(best);
        return;
      }
      if (!carried && best && bestKind === 'mote') {
        const slot = best.getValue(Mote, 'slot') ?? 0;
        this.spawnSeed(slot, 2);
        best.object3D!.getWorldPosition(this.v3);
        tideAudio.note(MOODS[this.moodIndex].notes[slot], this.v3.x, this.v3.y, this.v3.z, 0.6, 1.2);
        return;
      }
      if (!carried && best && bestKind === 'seed') {
        best.setValue(Seed, 'state', SeedStates.Carried);
        this.carry[2] = best;
        return;
      }
      const waterHit = this.raycaster.intersectObject(this.water, false)[0];
      if (carried) {
        if (waterHit) {
          this.v2.copy(waterHit.point);
          this.pool.worldToLocal(this.v2);
          this.v2.y = 0.06;
          if (this.releaseSeed(carried, this.v2)) this.plantedCount++;
        } else {
          this.dissolveSeed(carried);
        }
        this.carry[2] = null;
        return;
      }
      if (waterHit) {
        this.v2.copy(waterHit.point);
        this.pool.worldToLocal(this.v2);
        this.dripAt(this.v2, 0.8);
      }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    this.cleanupFuncs.push(
      () => el.removeEventListener('pointermove', onMove),
      () => el.removeEventListener('pointerdown', onDown),
    );
  }
  private droneStarted = false;

  private dripAt(local: Vector3, velocity: number): void {
    const horiz = Math.hypot(local.x, local.z);
    const a01 = (Math.atan2(local.x, -local.z) / (Math.PI * 2) + 1) % 1;
    const slot = Math.min(6, Math.floor(a01 * 7));
    const midi = MOODS[this.moodIndex].notes[slot] + (horiz < INNER ? 12 : 0);
    this.v3.set(local.x, 0, local.z);
    this.pool.localToWorld(this.v3);
    tideAudio.drip(midi, this.v3.x, this.v3.y, this.v3.z, velocity);
    this.addRipple(local.x, local.z, 1.1 * velocity, slot);
    this.dripCount++;
  }

  // ───────────────────────────────────────────────────────────────────
  // XR session binding (hand input sources + select events)
  private bindSession(session: XRSession | undefined): void {
    if (session === this.boundSession) return;
    this.boundSession = session ?? null;
    if (!session) return;
    const onStart = (ev: XRInputSourceEvent) => {
      tideAudio.ensure();
      if (tideAudio.ready && !this.droneStarted) {
        this.droneStarted = true;
        tideAudio.setDrone(MOODS[this.moodIndex].notes[0]);
      }
      if (!ev.inputSource.hand) return;
      const h = ev.inputSource.handedness === 'left' ? 0 : 1;
      this.hands[h].selectFlag = true;
    };
    const onEnd = (ev: XRInputSourceEvent) => {
      if (!ev.inputSource.hand) return;
      const h = ev.inputSource.handedness === 'left' ? 0 : 1;
      this.hands[h].selectFlag = false;
    };
    session.addEventListener('selectstart', onStart);
    session.addEventListener('selectend', onEnd);
    this.cleanupFuncs.push(() => {
      session.removeEventListener('selectstart', onStart);
      session.removeEventListener('selectend', onEnd);
    });
  }

  private syncHandSources(session: XRSession): void {
    let left: XRInputSource | null = null;
    let right: XRInputSource | null = null;
    for (const src of session.inputSources) {
      if (!src.hand) continue;
      if (src.handedness === 'left') left = src;
      else if (src.handedness === 'right') right = src;
    }
    if (this.hands[0].source !== left) this.hands[0].bind(left);
    if (this.hands[1].source !== right) this.hands[1].bind(right);
  }

  // ───────────────────────────────────────────────────────────────────
  update(delta: number): void {
    const dt = Math.min(delta, 0.05);
    this.clock += dt;
    const immersive =
      this.world.visibilityState.peek() !== VisibilityState.NonImmersive;

    if (this.placeTimer >= 0) {
      this.placeTimer -= dt;
      if (this.placeTimer < 0) this.placeInFrontOfHead();
    }

    // listener follows the head
    const cam = this.world.camera;
    cam.getWorldPosition(this.headPos);
    cam.getWorldQuaternion(this.headQuat);
    if (tideAudio.ready) {
      const L = this.listener;
      L.px = this.headPos.x;
      L.py = this.headPos.y;
      L.pz = this.headPos.z;
      this.v1.set(0, 0, -1).applyQuaternion(this.headQuat);
      L.fx = this.v1.x;
      L.fy = this.v1.y;
      L.fz = this.v1.z;
      this.v1.set(0, 1, 0).applyQuaternion(this.headQuat);
      L.ux = this.v1.x;
      L.uy = this.v1.y;
      L.uz = this.v1.z;
      tideAudio.updateListener(L);
    }

    this.pool.updateMatrixWorld();

    // ── hands ──
    if (immersive) {
      const session = this.world.xrSession;
      const frame = this.world.xrFrame;
      const ref = this.world.xrReferenceSpace;
      this.bindSession(session);
      if (session && frame && ref) {
        this.syncHandSources(session);
        this.world.player.updateMatrixWorld();
        this.originMat.copy(this.world.player.matrixWorld);
        for (const h of this.hands) h.update(frame, ref, this.originMat, dt);
        this.handleHands(dt);
      }
    } else if (this.carry[2] && this.mouseActive) {
      this.carry[2].object3D!.position.copy(this.mouseLocal);
    }

    // ── sequencer ──
    const loopDur = (60 / TEMPOS[this.tempoIndex].bpm) * 8; // 16 eighth notes
    const prevPos = this.phase * STEPS;
    this.phase += dt / loopDur;
    const curPos = this.phase * STEPS;
    for (let k = Math.floor(prevPos) + 1; k <= Math.floor(curPos); k++) {
      const step = k % STEPS;
      for (const e of this.queries.seeds.entities) {
        if (e.getValue(Seed, 'state') !== SeedStates.Resting) continue;
        if (e.getValue(Seed, 'step') !== step) continue;
        this.ringSeed(e, step % 4 === 0 ? 1 : 0.8);
      }
    }
    if (this.phase >= 1) this.phase -= 1;

    // ── seeds ──
    for (const e of this.queries.seeds.entities) {
      const o = e.object3D!;
      const state = e.getValue(Seed, 'state');
      const age = (e.getValue(Seed, 'age') ?? 0) + dt;
      e.setValue(Seed, 'age', age);
      let pulse = e.getValue(Seed, 'pulse') ?? 0;
      pulse = Math.max(0, pulse - dt * 2.5);
      e.setValue(Seed, 'pulse', pulse);
      if (state === SeedStates.Falling) {
        o.position.y -= dt * (0.4 + age * 6);
        if (o.position.y <= 0.008) {
          o.position.y = 0.008;
          e.setValue(Seed, 'state', SeedStates.Resting);
          this.ringSeed(e, 0.9);
          this.queueSave();
        }
        o.scale.setScalar(1.2);
      } else if (state === SeedStates.Resting) {
        o.position.y = 0.008 + Math.sin(this.clock * 2 + age) * 0.0015;
        o.scale.setScalar(1 + pulse * 0.9);
      } else if (state === SeedStates.Carried) {
        o.scale.setScalar(1.35 + Math.sin(this.clock * 8) * 0.08);
      } else if (state === SeedStates.Dissolving) {
        const k = Math.max(0, 1 - age / 0.5);
        o.scale.setScalar(k * 1.6);
        o.position.y += dt * 0.08;
        if (age > 0.5) e.dispose();
      }
    }

    // ── motes ──
    for (const e of this.queries.motes.entities) {
      const slot = e.getValue(Mote, 'slot') ?? 0;
      const g = e.object3D as Group;
      this.layoutMote(g, slot, this.clock);
      // brighten when the beam passes over their angle
      const a = ((slot / 6) * 2 - 1) * 1.15;
      const a01 = (a / (Math.PI * 2) + 1) % 1;
      const behind = (this.phase - a01 + 1) % 1;
      const glow = Math.exp(-behind * 25);
      g.children[1].scale.setScalar(0.075 + glow * 0.03);
    }

    // ── pebbles ──
    for (const e of this.queries.pebbles.entities) {
      let press = e.getValue(Pebble, 'press') ?? 0;
      press = Math.max(0, press - dt * 4);
      e.setValue(Pebble, 'press', press);
      const stone = e.object3D!.children[0];
      stone.position.y = -press * 0.006;
      // labels face the viewer
      const label = e.object3D!.children[1];
      label.lookAt(this.headPos);
    }

    // ── tide (visual + audio) ──
    this.waterMat.uniforms.uTime.value = this.clock;
    this.waterMat.uniforms.uSweep.value = this.phase;
    this.waterMat.uniforms.uTide.value = this.tide;
    this.waterMat.uniforms.uGlow.value = 0.7 + this.tide * 0.5;
    if (Math.abs(this.tide - this.tideSent) > 0.01) {
      this.tideSent = this.tide;
      tideAudio.setTide(this.tide);
    }

    // ── labels / hints ──
    this.advanceHints();
    this.updateHint(dt);
    this.hint.mesh.position.y = 0.3 + Math.sin(this.clock * 0.8) * 0.004;
    this.hint.mesh.lookAt(this.headPos);
    this.tideLabel.mesh.lookAt(this.headPos);
    this.tideLabel.mat.opacity = Math.max(0, this.tideLabel.mat.opacity - dt * 1.2);
    this.tideRingMat.opacity = Math.max(0, this.tideRingMat.opacity - dt * 2);

    if (this.saveTimer >= 0) {
      this.saveTimer -= dt;
      if (this.saveTimer < 0) this.save();
    }
  }

  // ───────────────────────────────────────────────────────────────────
  private handleHands(dt: number): void {
    const local = this.v2;
    for (let i = 0; i < 2; i++) {
      const h = this.hands[i];
      const carried = this.carry[i];

      if (!h.present) {
        if (carried) this.dissolveSeed(carried);
        this.holdingPool[i] = false;
        this.touching[i] = false;
        this.palmHold[i] = 0;
        continue;
      }

      // ── pinch: pick up a light ──
      if (h.pinchStarted) {
        tideAudio.ensure();
        let best: Entity | null = null;
        let bestD = 0.06;
        let kind = '';
        for (const e of this.queries.motes.entities) {
          e.object3D!.getWorldPosition(this.v1);
          const d = this.v1.distanceTo(h.pinchPoint);
          if (d < bestD) {
            bestD = d;
            best = e;
            kind = 'mote';
          }
        }
        for (const e of this.queries.seeds.entities) {
          if (e.getValue(Seed, 'state') !== SeedStates.Resting) continue;
          e.object3D!.getWorldPosition(this.v1);
          const d = this.v1.distanceTo(h.pinchPoint);
          if (d < Math.min(bestD, 0.045)) {
            bestD = d;
            best = e;
            kind = 'seed';
          }
        }
        if (best && kind === 'mote') {
          const slot = best.getValue(Mote, 'slot') ?? 0;
          this.spawnSeed(slot, i as Carrier);
          tideAudio.note(
            MOODS[this.moodIndex].notes[slot],
            h.pinchPoint.x,
            h.pinchPoint.y,
            h.pinchPoint.z,
            0.6,
            1.2,
          );
        } else if (best && kind === 'seed') {
          best.setValue(Seed, 'state', SeedStates.Carried);
          this.carry[i] = best;
          this.queueSave();
        } else {
          local.copy(h.pinchPoint);
          this.pool.worldToLocal(local);
          const horiz = Math.hypot(local.x, local.z);
          this.holdingPool[i] = horiz < R + 0.08 && Math.abs(local.y) < 0.12;
        }
      }

      // ── carry ──
      const c = this.carry[i];
      if (c) {
        local.copy(h.pinchPoint);
        this.pool.worldToLocal(local);
        c.object3D!.position.copy(local);
        if (h.pinchEnded) {
          if (this.releaseSeed(c, local)) this.plantedCount++;
          this.carry[i] = null;
        }
      }
      if (h.pinchEnded) this.holdingPool[i] = false;

      // ── fingertip in the water ──
      if (!h.pinching && !c) {
        local.copy(h.indexTip);
        this.pool.worldToLocal(local);
        const horiz = Math.hypot(local.x, local.z);
        const inside = horiz < R - 0.005 && local.y < 0.006 && local.y > -0.06;
        if (inside) {
          const moved = local.distanceTo(this.lastDripPos[i]);
          if (
            !this.touching[i] ||
            (moved > 0.03 && this.clock - this.lastDripTime[i] > 0.07)
          ) {
            const vel = Math.min(1, 0.45 + h.tipSpeed * 0.6);
            this.dripAt(local, vel);
            this.lastDripPos[i].copy(local);
            this.lastDripTime[i] = this.clock;
          }
        }
        this.touching[i] = inside;
      } else {
        this.touching[i] = false;
      }

      // ── palm over the pool: tide ──
      local.copy(h.palm);
      this.pool.worldToLocal(local);
      const palmHoriz = Math.hypot(local.x, local.z);
      const palmDown = h.palmFacing.y < -0.7;
      if (
        h.openness > 0.85 &&
        palmDown &&
        !h.pinching &&
        !c &&
        palmHoriz < R + 0.04 &&
        local.y > 0.03 &&
        local.y < 0.42
      ) {
        this.palmHold[i] += dt;
      } else {
        this.palmHold[i] = 0;
      }
      if (this.palmHold[i] > 0.5) {
        const target = Math.min(1, Math.max(0, (local.y - 0.05) / 0.3));
        this.tide += (target - this.tide) * Math.min(1, dt * 4);
        this.tideUsed += dt;
        this.tideRing.position.set(local.x, 0.004, local.z);
        this.tideRing.scale.setScalar(0.6 + this.tide * 1.6);
        this.tideRingMat.opacity = 0.75;
        this.tideRingMat.color.set(MOODS[this.moodIndex].beam);
        this.tideLabel.mesh.position.set(local.x, local.y + 0.07, local.z);
        this.tideLabel.set(
          this.tide > 0.66 ? 'Bright tide' : this.tide > 0.33 ? 'Mid tide' : 'Low tide',
          `${Math.round(this.tide * 100)}%`,
        );
        this.tideLabel.mat.opacity = 1;
        this.queueSave();
      }
    }

    // ── pebbles (fingertip press) — nearest free fingertip across hands ──
    for (const e of this.queries.pebbles.entities) {
      e.object3D!.getWorldPosition(this.v1);
      let d = Infinity;
      for (const h of this.hands) {
        if (!h.present || h.pinching) continue;
        d = Math.min(d, this.v1.distanceTo(h.indexTip));
      }
      const armed = this.pebbleArmed.get(e) ?? true;
      if (armed && d < 0.024) {
        this.pebbleArmed.set(e, false);
        this.triggerPebble(e);
      } else if (!armed && d > 0.045) {
        this.pebbleArmed.set(e, true);
      }
    }

    // ── two-hand pinch on the water: move the pool ──
    const both =
      this.holdingPool[0] &&
      this.holdingPool[1] &&
      this.hands[0].pinching &&
      this.hands[1].pinching;
    if (both) {
      const a = this.hands[0].pinchPoint;
      const b = this.hands[1].pinchPoint;
      const mid = this.v1.copy(a).add(b).multiplyScalar(0.5);
      const ang = Math.atan2(b.x - a.x, b.z - a.z);
      if (!this.moving) {
        this.moving = true;
        this.moveStartMid.copy(mid);
        this.moveStartPos.copy(this.pool.position);
        this.moveStartYaw = this.pool.rotation.y;
        this.moveStartAngle = ang;
      }
      this.pool.position.copy(this.moveStartPos).add(mid).sub(this.moveStartMid);
      this.pool.rotation.y = this.moveStartYaw + (ang - this.moveStartAngle);
      this.rimGlowMat.opacity = 0.6;
    } else if (this.moving) {
      this.moving = false;
      this.rimGlowMat.opacity = 0.25;
    }
  }
}
