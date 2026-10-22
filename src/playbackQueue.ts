import type { Track } from "./shared";

export const trackKey = (track: Track) => track.localId ? `local:${track.localId}` : `${track.source === "yandex" ? "yandex:" : ""}${track.ownerId}_${track.id}`;

export function shuffledOrder(queue: Track[], current?: string, random = Math.random): string[] {
  const keys = [...new Set(queue.map(trackKey))].filter(key => key !== current);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }
  return current && queue.some(t => trackKey(t) === current) ? [current, ...keys] : keys;
}

export function orderedQueue(queue: Track[], order: string[]): Track[] {
  const tracks = new Map(queue.map(t => [trackKey(t), t]));
  const keys = [...new Set([...order, ...tracks.keys()])];
  return keys.flatMap(key => tracks.has(key) ? [tracks.get(key)!] : []);
}

export function insertNext(queue: Track[], current: Track | null, track: Track): Track[] {
  if (current && trackKey(current) === trackKey(track)) return queue;
  const remaining = queue.filter(t => trackKey(t) !== trackKey(track));
  const index = current ? remaining.findIndex(t => trackKey(t) === trackKey(current)) + 1 : remaining.length;
  return [...remaining.slice(0, index), track, ...remaining.slice(index)];
}

export function nextAfterFailure(queue: Track[], current: Track, failed: Set<string>, wrap: boolean, shuffle: boolean): Track | undefined {
  const index = queue.findIndex(track => trackKey(track) === trackKey(current));
  const remaining = (index < 0 ? queue : [...queue.slice(index + 1), ...(wrap || shuffle ? queue.slice(0, index) : [])])
    .filter(track => !track.restricted && !failed.has(trackKey(track)));
  return shuffle ? remaining[Math.floor(Math.random() * remaining.length)] : remaining[0];
}
