import type { AudioLevels } from "./audioLevels";
import { DEFAULT_LIGHT_SETTINGS, type LightSettings } from "./lightSettings";

export const createLightMotion = () => ({ time: 0, phase: 0, colorPhase: 0, mean: 0, previous: 0, lastBeat: -10, interval: 0, pulse: 0 });
export type LightMotion = ReturnType<typeof createLightMotion>;

export function advanceLightMotion(state: LightMotion, audio: AudioLevels, delta: number, settings: Readonly<LightSettings> = DEFAULT_LIGHT_SETTINGS) {
  const dt = Math.max(0, Math.min(.1, delta));
  state.time += dt;
  const energy = (audio.bass * .7 + audio.level * .3) * settings.sensitivity;
  state.mean += (energy - state.mean) * (1 - Math.exp(-dt / .45));
  const beat = energy > Math.max(.035, state.mean * 1.22) && energy > state.previous + .012 && state.time - state.lastBeat > .25;
  if (beat) {
    const gap = state.time - state.lastBeat;
    if (gap >= .25 && gap <= 1.5) state.interval = state.interval ? state.interval * .6 + gap * .4 : gap;
    state.lastBeat = state.time;
    state.pulse = 1;
  } else state.pulse *= Math.exp(-dt / .22);
  if (state.time - state.lastBeat > 2.5) state.interval = 0;
  state.previous = energy;
  // Tempo is estimated from actual onsets; silence never advances the lights.
  const pace = state.interval ? .5 / state.interval : .5;
  state.phase += dt * settings.speed * (audio.level * settings.sensitivity * .4 + energy * pace * .9 + (energy > .01 ? state.pulse * .4 : 0));
  state.colorPhase += dt * (audio.level * .5 + energy * .35 + (energy > .01 ? state.pulse * .08 : 0));
  return Array.from({ length: settings.count }, (_, i) => {
    const p = state.phase, seed = i * 2.37;
    return {
      x: Math.sin(p * (.61 + i * .09) + seed) * 24 + Math.sin(p * 1.13 - seed) * 10,
      y: Math.cos(p * (.47 + i * .07) - seed) * 18 + Math.sin(p * .83 + seed) * 9,
      rotate: Math.sin(p * .39 + seed) * 18,
      hue: (state.colorPhase * 55 + [0, 115, 225, 285][i % 4] + Math.floor(i / 4) * 37) % 360,
    };
  });
}
