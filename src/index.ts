import { VisibilityState, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { tideAudio } from './audio.js';
import { TidepoolSystem } from './tidepool.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(TidepoolSystem);

  const overlay = document.getElementById('landing');
  const enter = document.getElementById('enter-xr') as HTMLButtonElement | null;
  const note = document.getElementById('xr-note');
  if (enter) {
    enter.addEventListener('click', () => {
      tideAudio.ensure();
      world.launchXR();
    });
  }
  if (!world.xrEnabled && enter && note) {
    enter.disabled = true;
    note.textContent =
      'Open this page in the Meta Quest Browser to step in. Desktop preview: click a light, then click the pool.';
  }
  const unhide = document.getElementById('preview');
  unhide?.addEventListener('click', () => {
    tideAudio.ensure();
    overlay?.classList.add('mini');
  });
  world.visibilityState.subscribe((state) => {
    overlay?.classList.toggle('hidden', state !== VisibilityState.NonImmersive);
  });
});
