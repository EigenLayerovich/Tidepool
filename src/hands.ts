/**
 * Raw hand-joint reader. Reads all 25 WebXR hand joints per hand every frame
 * (no allocation), and derives the few signals Tidepool needs: pinch point and
 * pinch state (with hysteresis), index fingertip, palm centre / palm-facing
 * direction and whether the hand is open.
 */
import { Matrix4, Vector3 } from '@iwsdk/core';

// XRHand joint order (WebXR Hand Input spec)
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_TIP = 9;
const MIDDLE_MCP = 10;
const MIDDLE_TIP = 14;
const RING_TIP = 19;
const PINKY_MCP = 20;
const PINKY_TIP = 24;

const PINCH_ON = 0.022;
const PINCH_OFF = 0.038;

export class HandState {
  readonly handedness: 'left' | 'right';
  present = false;
  pinching = false;
  pinchStarted = false;
  pinchEnded = false;
  /** set externally from XR select events (pinch reported by the runtime) */
  selectFlag = false;
  pinchPoint = new Vector3();
  indexTip = new Vector3();
  thumbTip = new Vector3();
  wrist = new Vector3();
  palm = new Vector3();
  /** direction the palm is facing, world space */
  palmFacing = new Vector3();
  open = false;
  openness = 0;
  /** index-tip velocity, m/s */
  tipSpeed = 0;

  spaces: XRJointSpace[] = [];
  source: XRInputSource | null = null;
  readonly mats = new Float32Array(25 * 16);
  private prevTip = new Vector3();
  private tmp = new Vector3();
  private m = new Matrix4();

  constructor(h: 'left' | 'right') {
    this.handedness = h;
  }

  bind(source: XRInputSource | null): void {
    this.source = source;
    this.spaces.length = 0;
    if (source?.hand) {
      for (const space of source.hand.values()) this.spaces.push(space);
    }
    if (!source) {
      this.present = false;
      this.pinching = false;
      this.selectFlag = false;
    }
  }

  private jointPos(index: number, out: Vector3, origin: Matrix4): Vector3 {
    const o = index * 16;
    out.set(this.mats[o + 12], this.mats[o + 13], this.mats[o + 14]);
    return out.applyMatrix4(origin);
  }

  update(
    frame: XRFrame,
    ref: XRReferenceSpace,
    origin: Matrix4,
    delta: number,
  ): void {
    this.pinchStarted = false;
    this.pinchEnded = false;
    if (this.spaces.length < 25) {
      this.markLost();
      return;
    }
    let ok = false;
    const f = frame as XRFrame & {
      fillPoses?: (s: XRSpace[], r: XRSpace, m: Float32Array) => boolean;
    };
    if (typeof f.fillPoses === 'function') {
      ok = f.fillPoses(this.spaces, ref, this.mats);
    } else {
      ok = true;
      for (let i = 0; i < 25; i++) {
        const p = frame.getJointPose?.(this.spaces[i], ref);
        if (!p) {
          ok = false;
          break;
        }
        this.mats.set(p.transform.matrix, i * 16);
      }
    }
    if (!ok) {
      this.markLost();
      return;
    }
    const wasPresent = this.present;
    this.present = true;

    this.jointPos(THUMB_TIP, this.thumbTip, origin);
    this.jointPos(INDEX_TIP, this.indexTip, origin);
    this.jointPos(WRIST, this.wrist, origin);
    this.jointPos(MIDDLE_MCP, this.palm, origin);
    this.palm.lerp(this.wrist, 0.35);
    this.pinchPoint.copy(this.thumbTip).lerp(this.indexTip, 0.5);

    if (wasPresent && delta > 0) {
      this.tipSpeed = this.prevTip.distanceTo(this.indexTip) / delta;
    } else {
      this.tipSpeed = 0;
    }
    this.prevTip.copy(this.indexTip);

    // Palm facing: joint -Y points into the palm (WebXR hand spec).
    this.m.fromArray(this.mats, MIDDLE_MCP * 16).premultiply(origin);
    const e = this.m.elements;
    this.palmFacing.set(-e[4], -e[5], -e[6]).normalize();

    // openness: average fingertip distance from wrist
    let sum = 0;
    for (const tip of [INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP]) {
      sum += this.jointPos(tip, this.tmp, origin).distanceTo(this.wrist);
    }
    const avg = sum / 4;
    this.openness = Math.min(1, Math.max(0, (avg - 0.09) / (0.17 - 0.09)));
    this.open = this.openness > 0.7;

    const gap = this.thumbTip.distanceTo(this.indexTip);
    const was = this.pinching;
    let now = was ? gap < PINCH_OFF : gap < PINCH_ON;
    if (this.selectFlag) now = true;
    this.pinching = now;
    this.pinchStarted = now && !was;
    this.pinchEnded = !now && was;
    // keep the unused metacarpals referenced for future gestures
    void INDEX_MCP;
    void PINKY_MCP;
  }

  private markLost(): void {
    if (this.pinching) this.pinchEnded = true;
    this.present = false;
    this.pinching = false;
    this.open = false;
    this.tipSpeed = 0;
  }
}
