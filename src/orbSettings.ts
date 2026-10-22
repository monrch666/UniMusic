export interface OrbSettings { enabled: boolean; placement: "circle" | "background"; sensitivity: number; speed: number; opacity: number }
export const DEFAULT_ORB_SETTINGS: Readonly<OrbSettings> = { enabled: true, placement: "circle", sensitivity: 1, speed: 1, opacity: 1 };
export const ORB_RANGES = { sensitivity: [0, 2], speed: [0, 3], opacity: [.1, 1] } as const;

export function validOrbSettings(value: unknown): OrbSettings {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result = { ...DEFAULT_ORB_SETTINGS };
  if (typeof input.enabled === "boolean") result.enabled = input.enabled;
  if (input.placement === "circle" || input.placement === "background") result.placement = input.placement;
  for (const key of Object.keys(ORB_RANGES) as (keyof typeof ORB_RANGES)[]) {
    const n = input[key];
    if (typeof n === "number" && Number.isFinite(n)) result[key] = Math.min(ORB_RANGES[key][1], Math.max(ORB_RANGES[key][0], n));
  }
  return result;
}
