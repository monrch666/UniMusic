import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppPreferences, BrowseRequest, PlaybackSnapshot, Track } from "../src/shared";
import { object, string, number, VkError } from "./vk";
import { trackKey } from "../src/playbackQueue";

export function selectAutoCacheTrack(track: Track, enabled: boolean, vkUserId?: number, savedTracks: Record<string, Track | null> = {}): Track | null {
  if (!enabled || track.source === "local" || track.restricted) return null;
  const key = trackKey(track);
  const saved = key in savedTracks ? savedTracks[key] : track;
  if (!saved || saved.restricted || saved.disliked || saved.saved === false || saved.source === "local") return null;
  return (saved.source === "yandex" ? saved.saved === true : saved.ownerId === vkUserId) ? saved : null;
}

export const defaultPreferences = (directory: string): AppPreferences => ({
  preferDownloads: true, autoCache: true, legacyAudio: true, closeToTray: false, mediaShortcuts: false,
  broadcast: false, listeningEvents: false, downloadDirectory: directory,
  shortcuts: { toggle: "CommandOrControl+Alt+Space", next: "CommandOrControl+Alt+Right", previous: "CommandOrControl+Alt+Left" },
  proxyMode: "system", proxyAddress: "", equalizer: [0, 0, 0, 0, 0],
});

export function validatePreferences(value: unknown, previous: AppPreferences): AppPreferences {
  const v = object(value); const result = { ...previous };
  for (const name of ["preferDownloads", "autoCache", "legacyAudio", "closeToTray", "mediaShortcuts", "broadcast", "listeningEvents"] as const)
    if (name in v) {
      if (typeof v[name] !== "boolean") throw new VkError("Некорректная настройка.");
      result[name] = v[name];
    }
  if ("proxyMode" in v) {
    if (!["system", "direct", "custom"].includes(string(v.proxyMode))) throw new VkError("Некорректный режим сети.");
    result.proxyMode = v.proxyMode as AppPreferences["proxyMode"];
  }
  for (const name of ["proxyAddress"] as const) {
    if (!(name in v)) continue;
    if (typeof v[name] !== "string" || v[name].length > 2048) throw new VkError("Некорректный адрес.");
    const address = v[name].trim();
    if (address) {
      let url: URL;
      try { url = new URL(address); } catch { throw new VkError("Введите полный адрес с протоколом."); }
      const allowed = ["http:", "https:", "socks5:"];
      if (!allowed.includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new VkError("Адрес не должен содержать пароль, параметры или фрагмент.");
      if (name === "proxyAddress" && url.pathname !== "" && url.pathname !== "/") throw new VkError("У прокси не должно быть пути.");
    }
    result[name] = address.replace(/\/$/, "");
  }
  if (result.proxyMode === "custom" && !result.proxyAddress) throw new VkError("Укажите адрес прокси.");
  if ("equalizer" in v) {
    if (!Array.isArray(v.equalizer) || v.equalizer.length !== 5 || v.equalizer.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 12))
      throw new VkError("Значения эквалайзера должны быть от −12 до +12 дБ.");
    result.equalizer = [...v.equalizer];
  }
  if ("shortcuts" in v) {
    const shortcuts = object(v.shortcuts);
    const resultKeys = { ...previous.shortcuts };
    for (const key of ["toggle", "next", "previous"] as const) {
      const value = string(shortcuts[key]);
      if (!/^(?:(?:CommandOrControl|Control|Alt|Shift)\+){1,3}(?:Space|Left|Right|Up|Down|[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(value)) throw new VkError("Укажите сочетание, например Control+Alt+Space.");
      resultKeys[key] = value;
    }
    if (new Set(Object.values(resultKeys)).size !== 3) throw new VkError("Сочетания должны отличаться.");
    result.shortcuts = resultKeys;
  }
  // Download paths are selected only through the native folder dialog.
  return result;
}

export function durableTrack(value: unknown): Track {
  const v = object(value);
  if (v.source === "remote") throw new VkError("Источник музыки больше не поддерживается.");
  if (!Number.isSafeInteger(v.id) || Number(v.id) <= 0 || !Number.isSafeInteger(v.ownerId))
    throw new VkError("Некорректный трек.");
  const reference = object(v.albumRef);
  let cover: string | undefined;
  if (v.source === "yandex") try {
    const url = new URL(string(v.cover));
    if (url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash && /(^|\.)yandex\.(net|ru|com)$/.test(url.hostname)) cover = url.href;
  } catch { /* Transient proxy URLs are never persisted. */ }
  return { id: Number(v.id), ownerId: Number(v.ownerId), title: string(v.title).slice(0, 500),
    artist: string(v.artist).slice(0, 500), duration: Math.max(0, number(v.duration)), url: "", restricted: v.restricted === true,
    album: string(v.album).slice(0, 500) || undefined, accessKey: /^[\w-]{1,256}$/.test(string(v.accessKey)) ? string(v.accessKey) : undefined,
    folder: string(v.folder).slice(0, 200) || undefined,
    localId: /^[\w-]{1,100}$/.test(string(v.localId)) ? string(v.localId) : undefined,
    saved: typeof v.saved === "boolean" ? v.saved : undefined,
    disliked: typeof v.disliked === "boolean" ? v.disliked : undefined,
    cover,
    source: v.source === "local" || v.source === "yandex" ? v.source : "vk",
    lyricsId: number(v.lyricsId), genre: number(v.genre), date: number(v.date),
    artists: Array.isArray(v.artists) ? v.artists.slice(0, 20).map(a => ({ id: string(object(a).id).slice(0, 200), name: string(object(a).name).slice(0, 200) })) : undefined,
    albumRef: Number.isSafeInteger(reference.id) && Number.isSafeInteger(reference.ownerId) ? {
      source: reference.source === "yandex" ? "yandex" : "vk", kind: reference.kind === "album" ? "album" : undefined,
      id: Number(reference.id), ownerId: Number(reference.ownerId), accessKey: string(reference.accessKey).slice(0, 256) || undefined,
    } : undefined,
  };
}
export function validateSnapshot(value: unknown): PlaybackSnapshot | null {
  if (value === null) return null;
  const v = object(value);
  if (!Array.isArray(v.queue) || v.queue.length > 50_000 || !Array.isArray(v.order) || v.order.length > 50_000) throw new VkError("Некорректная очередь.");
  const queue = v.queue.map(durableTrack);
  const keys = new Set(queue.map(t => t.localId ? `local:${t.localId}` : `${t.source === "yandex" ? "yandex:" : ""}${t.ownerId}_${t.id}`));
  const source = object(v.source);
  // Only identifiers and search parameters survive restart; never signed media URLs.
  const savedSource: BrowseRequest | undefined = ["library", "playlist", "search", "artist", "recommendations", "popular", "local"].includes(string(source.kind))
    ? { source: source.source === "yandex" ? "yandex" : "vk", kind: source.kind as BrowseRequest["kind"], query: string(source.query).slice(0, 200) || undefined,
      artistId: string(source.artistId).slice(0, 200) || undefined, genre: number(source.genre), ownerId: number(source.ownerId) || undefined,
      playlist: source.playlist ? { source: object(source.playlist).source === "yandex" ? "yandex" : "vk", kind: object(source.playlist).kind === "album" ? "album" : undefined, id: number(object(source.playlist).id), ownerId: number(object(source.playlist).ownerId), accessKey: string(object(source.playlist).accessKey).slice(0, 256) || undefined } : undefined,
      track: source.track ? { id: number(object(source.track).id), ownerId: number(object(source.track).ownerId), accessKey: string(object(source.track).accessKey).slice(0, 256) || undefined } : undefined,
      filters: source.filters ? { type: ["tracks", "artists", "playlists"].includes(string(object(source.filters).type)) ? object(source.filters).type as "tracks" | "artists" | "playlists" : "tracks",
        own: object(source.filters).own === true, performer: object(source.filters).performer === true, lyrics: object(source.filters).lyrics === true,
        autocomplete: object(source.filters).autocomplete !== false, sort: [0,1,2].includes(number(object(source.filters).sort)) ? number(object(source.filters).sort) as 0|1|2 : 1 } : undefined } : undefined;
  return { queue, currentKey: keys.has(string(v.currentKey)) ? string(v.currentKey) : "",
    position: Math.max(0, Math.min(number(v.position), 86400)), shuffle: v.shuffle === true,
    repeat: v.repeat === "all" || v.repeat === "one" ? v.repeat : "off",
    order: [...new Set(v.order.filter(k => typeof k === "string" && keys.has(k)))],
    source: savedSource, loaded: Math.max(queue.length, Math.floor(number(v.loaded))),
    total: Math.max(queue.length, Math.floor(number(v.total))) };
}

export class JsonFile<T> {
  private pending = Promise.resolve();
  constructor(private directory: string, private name: string) {}
  async read(fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(join(this.directory, this.name), "utf8")) as T; } catch { return fallback; }
  }
  write(value: T): Promise<void> {
    const content = JSON.stringify(value);
    const action = this.pending.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true });
      const path = join(this.directory, this.name);
      await writeFile(`${path}.tmp`, content);
      await rename(`${path}.tmp`, path);
    });
    this.pending = action;
    return action;
  }
}
