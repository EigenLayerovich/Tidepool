/**
 * Tidepool component declarations (system-free module).
 */
import { createComponent, Types } from '@iwsdk/core';

/** A floating source light above the pool. Pinch it to take a copy. */
export const Mote = createComponent('Mote', {
  slot: { type: Types.Int8, default: 0, min: 0, max: 6 },
});

export const SeedStates = {
  Carried: 'carried',
  Falling: 'falling',
  Resting: 'resting',
  Dissolving: 'dissolving',
} as const;

/** A light living in (or carried towards) the pool. */
export const Seed = createComponent('Seed', {
  slot: { type: Types.Int8, default: 0 },
  step: { type: Types.Int8, default: 0 },
  high: { type: Types.Boolean, default: false },
  state: {
    type: Types.Enum,
    enum: SeedStates,
    default: SeedStates.Carried,
  },
  age: { type: Types.Float32, default: 0 },
  pulse: { type: Types.Float32, default: 0 },
  radius: { type: Types.Float32, default: 0.1 },
});

/** Rim pebbles that act as fingertip buttons. */
export const PebbleActions = {
  Mood: 'mood',
  Tempo: 'tempo',
  Clear: 'clear',
} as const;

export const Pebble = createComponent('Pebble', {
  action: {
    type: Types.Enum,
    enum: PebbleActions,
    default: PebbleActions.Mood,
  },
  press: { type: Types.Float32, default: 0 },
});
