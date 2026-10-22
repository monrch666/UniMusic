import type { OrbState } from "thinking-orbs/engine";
import type { AudioLevels } from "./audioLevels";

export const ORB_MODES = [
  { value: "orbits", title: "Орбиты", state: "working", description: "Частицы на пересекающихся орбитах" },
  { value: "wave", title: "Волна", state: "listening", description: "Волна проходит по поверхности сферы" },
  { value: "braid", title: "Сплетение", state: "weaving", description: "Линии плавно переплетаются в пространстве" },
] as const satisfies readonly { value: string; title: string; state: OrbState; description: string }[];
export type OrbMode = typeof ORB_MODES[number]["value"];
export function validOrbMode(value: unknown): OrbMode {
  return ORB_MODES.find(mode => mode.value === value)?.value ?? "orbits";
}

export function deformOrbPoint(x: number, y: number, size: number, phase: number, signal: AudioLevels): [number, number] {
  const dx = x - size / 2, dy = y - size / 2;
  const angle = Math.atan2(dy, dx);
  const swell = 1 + signal.level * .16 + signal.bass * .20
    + signal.mids * Math.sin(angle * 4 + phase) * .10;
  return [size / 2 + dx * swell, size / 2 + dy * swell];
}
