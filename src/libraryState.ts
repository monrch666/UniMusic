import type { Track } from "./shared";
import { trackKey } from "./playbackQueue";

export function updateSavedTracks(previous: Record<string, Track | null>, original: Track, saved: Track | null, removed?: Track | null) {
  const next = { ...previous, [trackKey(original)]: saved };
  if (saved) next[trackKey(saved)] = saved;
  if (removed) {
    for (const [key, value] of Object.entries(next)) {
      if (value && trackKey(value) === trackKey(removed)) next[key] = null;
    }
    next[trackKey(removed)] = null;
  }
  return next;
}
