export interface LightSettings { count: number; intensity: number; speed: number; size: number; sensitivity: number; colorMode: "accent" | "rgb" }
export const DEFAULT_LIGHT_SETTINGS: Readonly<LightSettings> = { count: 4, intensity: 1, speed: 1, size: 1, sensitivity: 1, colorMode: "accent" };
export const LIGHT_RANGES = { count: [1, 8], intensity: [0, 1.5], speed: [0, 3], size: [.5, 1.8], sensitivity: [0, 2] } as const;

export function validLightSettings(value: unknown): LightSettings {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result = { ...DEFAULT_LIGHT_SETTINGS };
  if (input.colorMode === "accent" || input.colorMode === "rgb") result.colorMode = input.colorMode;
  for (const key of Object.keys(LIGHT_RANGES) as (keyof typeof LIGHT_RANGES)[]) {
    const n = input[key];
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    result[key] = Math.min(LIGHT_RANGES[key][1], Math.max(LIGHT_RANGES[key][0], n));
  }
  result.count = Math.round(result.count);
  return result;
}
