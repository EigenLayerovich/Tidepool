# Tidepool

**Pinch light from the air. Let the tide play it.**

Tidepool is a hands-first, seated music toy for Meta Quest, built with the Immersive Web SDK (WebXR).
A small glowing pool of water appears at desk height in mixed reality (passthrough). Seven lights float over it, one per note of the current mood.

- **Pinch a light** and drop it into the pool to plant it. A moonbeam sweeps the pool like a clock hand, and every light it passes rings out. The angle sets *when* it plays (16 steps per loop); lights inside the inner ring play an octave higher.
- **Dip a fingertip** into the water to play along. Drag it through the water to strum.
- **Hold your palm flat** over the pool and raise or lower it to shift the tide, from muffled and deep to bright and airy.
- **Tap the rim pebbles** to change the mood (Dawn, Dusk, Deep), the tempo (Drift, Flow, Rush), or clear the pool.
- **Pinch a planted light** to move it, or toss it out of the pool to remove it.
- **Pinch the water's edge with both hands** to move and rotate the pool.
- The pool **remembers** what you planted, so it's waiting for you next time.

No controllers needed. Everything works within a two-foot radius while seated.

## Run locally

```bash
npm install
npm run dev        # managed dev server + IWER emulator
npm run build      # production build in dist/
```

Open the dev URL on a Quest on the same network, or use the built-in emulator on desktop.
Without a headset, **Desktop preview** lets you click a light and then click the pool.

## Tech

- Immersive Web SDK 1.1 (ECS, XR session, passthrough AR, hand tracking)
- Raw WebXR hand joints (`XRFrame.fillPoses`) for pinch, fingertip touch and palm orientation
- Custom GLSL water shader: up to 24 coloured ripples, the sweeping moonbeam and step ticks
- WebAudio synth: FM-shimmer bell voices, HRTF spatial panning per light, a generated convolution reverb, an ambient drone and a water bed, with a "tide" low-pass filter
- `localStorage` persistence

## Deploy

Pushing to `main` builds the app and deploys `dist/` to GitHub Pages (see `.github/workflows/deploy.yml`).
