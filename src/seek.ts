export function seekTimeAt(clientX: number, left: number, width: number, duration: number): number {
  if (![clientX, left, width, duration].every(Number.isFinite) || width <= 0 || duration <= 0) return 0;
  return Math.max(0, Math.min(1, (clientX - left) / width)) * duration;
}
