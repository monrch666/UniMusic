import { createHash, createHmac, randomUUID } from "node:crypto";
import type { BrowseRequest, LibraryAction, MusicPage, Playlist, Track, YandexAccount, YandexAuthState } from "../src/shared";
import { object, string, number, VkError } from "./vk";

const CLIENT_ID = "23cabbbdc6cd418abb4b39c32c41195d";
// Public Android client parameters documented by MarshalX/yandex-music-api.
const CLIENT_SECRET = "53bc75238f0c4d08a118e51fe9203300";
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const id = (v: unknown) => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw new VkError("Некорректный идентификатор Яндекс Музыки."); return n; };
export function yandexUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !/(^|\.)(yandex\.(ru|net|com)|yandexmusic\.net|ya\.ru)$/.test(url.hostname)) throw new VkError("Недопустимый адрес Яндекс Музыки.");
  return url;
}
const cover = (value: unknown) => {
  const uri = string(value); if (!uri) return undefined;
  try { return yandexUrl(`https://${uri.replace(/^https?:\/\//, "").replace("%%", "400x400")}`).href; } catch { return undefined; }
};
export function yandexTrack(value: unknown, saved = false): Track {
  const t = object(value), album = object(list(t.albums)[0]);
  return { source: "yandex", id: id(t.id), ownerId: 0, title: string(t.title), artist: list(t.artists).map(a => string(object(a).name)).join(", ") || "Неизвестный исполнитель",
    duration: number(t.durationMs) / 1000, url: "", restricted: t.error !== undefined, saved,
    cover: cover(t.coverUri) || cover(album.coverUri), album: string(album.title) || undefined,
    albumRef: album.id ? { source: "yandex", kind: "album", id: id(album.id), ownerId: 0 } : undefined,
    artists: list(t.artists).map(a => ({ id: String(object(a).id), name: string(object(a).name) })) };
}
function playlist(value: unknown): Playlist {
  const p = object(value), art = object(p.cover);
  return { source: "yandex", id: id(p.kind), ownerId: id(object(p.owner).uid), title: string(p.title), description: string(p.description), count: number(p.trackCount), cover: cover(art.uri || list(art.itemsUri)[0]) };
}

export class YandexMusic {
  private waveTracks: Track[] = [];
  private waveBatches = new Map<number, string>();
  private waveQueue?: number;
  private waveStarted = false;
  private pending?: { device: string; code: string; url: string; expires: number; interval: number; next: number };
  private generation = 0;
  constructor(private fetcher: typeof fetch, private token: () => string | null, private save: (token: string | null) => Promise<void>) {}
  private async json(url: string, body?: Record<string, string | number>, authorized = false, jsonBody = false): Promise<Record<string, unknown>> {
    const token = authorized ? this.token() : null;
    if (authorized && !token) throw new VkError("Подключите Яндекс Музыку в настройках.", 401);
    let response: Response;
    try { response = await this.fetcher(url, { method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { ...(token ? { Authorization: `OAuth ${token}` } : {}), ...(body ? { "Content-Type": jsonBody ? "application/json" : "application/x-www-form-urlencoded" } : {}) }, body: body ? jsonBody ? JSON.stringify(body) : new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])).toString() : undefined }); }
    catch { throw new VkError("Нет соединения с Яндекс Музыкой. Повторите попытку."); }
    if (response.status === 401) throw new VkError("Сессия Яндекс Музыки истекла. Подключите аккаунт заново.", 401);
    if (response.status === 403) throw new VkError("Яндекс Музыка ограничила доступ. Проверьте подписку Плюс и доступность трека.", 402);
    if (response.status === 429) throw new VkError("Слишком много запросов к Яндекс Музыке. Попробуйте позже.", 429);
    const data = object(await response.json());
    if (!response.ok && !data.error) throw new VkError("Яндекс Музыка временно недоступна.");
    return data;
  }
  private async call(path: string, body?: Record<string, string>): Promise<unknown> {
    const data = await this.json(`https://api.music.yandex.net/${path}`, body, true);
    if (data.error) throw new VkError("Яндекс Музыка не смогла выполнить действие.");
    return data.result;
  }
  async profile(): Promise<YandexAccount> {
    const status = object(await this.call("account/status")), account = object(status.account);
    return { id: id(account.uid), firstName: string(account.displayName) || string(account.login), lastName: "", plus: object(status.plus).hasPlus === true };
  }
  async auth(action: string): Promise<YandexAuthState> {
    if (action === "cancel" || action === "logout") { this.generation++; this.pending = undefined; if (action === "logout") { this.waveTracks = []; this.waveBatches.clear(); this.waveQueue = undefined; this.waveStarted = false; await this.save(null); } return { step: "idle" }; }
    if (action === "begin") {
      const generation = ++this.generation; this.pending = undefined;
      const data = await this.json("https://oauth.yandex.ru/device/code", { client_id: CLIENT_ID, device_id: randomUUID(), device_name: "UniMusic Windows" });
      if (generation !== this.generation) return { step: "idle" };
      const url = yandexUrl(string(data.verification_url || data.verification_uri));
      if (!["oauth.yandex.ru", "passport.yandex.ru", "ya.ru"].includes(url.hostname) || !string(data.device_code) || !string(data.user_code)) throw new VkError("Не удалось получить код входа Яндекса.");
      this.pending = { device: string(data.device_code), code: string(data.user_code), url: url.href, expires: Date.now() + Math.min(number(data.expires_in) || 600, 1800) * 1000, interval: Math.max(number(data.interval) || 5, 5), next: 0 };
    }
    const pending = this.pending;
    if (!pending || Date.now() >= pending.expires) { this.pending = undefined; throw new VkError("Код входа истёк. Начните подключение заново."); }
    if (action === "poll" && Date.now() >= pending.next) {
      pending.next = Date.now() + pending.interval * 1000;
      const data = await this.json("https://oauth.yandex.ru/token", { grant_type: "device_code", code: pending.device, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
      if (pending !== this.pending) return { step: "idle" };
      if (typeof data.access_token === "string" && data.access_token.length > 10 && data.access_token.length < 8192) {
        await this.save(data.access_token); this.pending = undefined; this.waveTracks = []; this.waveBatches.clear(); this.waveQueue = undefined; this.waveStarted = false;
        return { step: "complete", profile: await this.profile() };
      }
      if (data.error === "slow_down") pending.interval += 5;
      else if (data.error !== "authorization_pending") { this.pending = undefined; throw new VkError("Вход в Яндекс не подтверждён. Начните заново."); }
    }
    return { step: "waiting", code: pending.code, url: pending.url, interval: pending.interval };
  }
  async playlists(offset = 0) {
    const profile = await this.profile();
    const items = list(await this.call(`users/${profile.id}/playlists/list`)).map(playlist);
    return { items: items.slice(offset, offset + 100), count: items.length };
  }
  private async tracks(ids: unknown[]): Promise<Track[]> {
    if (!ids.length) return [];
    const ordered = ids.map(id);
    const found = list(await this.call("tracks", { "track-ids": ordered.join(","), "with-positions": "false" })).map(t => yandexTrack(t));
    const mapped = new Map(found.map(t => [t.id, t]));
    return ordered.map(id => mapped.get(id) ?? { source: "yandex", id, ownerId: 0, title: "Недоступный трек", artist: "", duration: 0, url: "", restricted: true });
  }
  async artwork(trackId: unknown): Promise<string | undefined> { return (await this.tracks([trackId]))[0]?.cover; }
  async browse(r: BrowseRequest): Promise<MusicPage> {
    const result: MusicPage = { tracks: [], playlists: [], artists: [], sections: [], count: 0 };
    const offset = Math.max(0, Math.floor(Number(r.offset) || 0));
    if (r.kind === "recommendations") {
      if (offset >= this.waveTracks.length && this.waveTracks.length < 10000) {
        const generation = this.generation;
        const params = new URLSearchParams({ settings2: "True", ...(this.waveQueue ? { queue: String(this.waveQueue) } : {}) });
        const data = object(await this.call(`rotor/station/user:onyourwave/tracks?${params}`));
        if (generation !== this.generation) throw new VkError("Аккаунт Яндекса изменился.", 401);
        const batch = string(data.batchId);
        const known = new Set(this.waveTracks.map(t => t.id));
        for (const item of list(data.sequence)) {
          const track = yandexTrack(object(item).track);
          if (!known.has(track.id)) { known.add(track.id); this.waveTracks.push(track); this.waveBatches.set(track.id, batch); }
        }
      }
      result.tracks = this.waveTracks.slice(offset, offset + 100);
      result.count = this.waveTracks.length + (result.tracks.length && this.waveTracks.length < 10000 ? 1 : 0);
      result.title = "Моя волна";
    } else if (r.kind === "library") {
      const me = await this.profile(), data = object(await this.call(`users/${me.id}/likes/tracks`));
      const refs = list(object(data.library).tracks); result.count = refs.length;
      result.tracks = (await this.tracks(refs.slice(offset, offset + 100).map(t => object(t).id))).map(t => ({ ...t, saved: true }));
    } else if (r.kind === "search") {
      const type = r.filters?.type ?? "tracks";
      const params = new URLSearchParams({ text: String(r.query ?? "").slice(0, 200), type, page: String(Math.floor(offset / 20)), "page-size": "20" });
      const data = object(object(await this.call(`search?${params}`))[type]); result.count = number(data.total);
      if (type === "tracks") result.tracks = list(data.results).map(t => yandexTrack(t));
      if (type === "playlists") result.playlists = list(data.results).map(playlist);
      if (type === "artists") result.artists = list(data.results).map(v => ({ id: String(object(v).id), name: string(object(v).name), cover: cover(object(object(v).cover).uri) }));
    } else if (r.kind === "playlist") {
      const ref = r.playlist!;
      if (ref.kind === "album") {
        const data = object(await this.call(`albums/${id(ref.id)}/with-tracks`));
        const tracks = list(data.volumes).flatMap(list); result.count = tracks.length; result.tracks = tracks.slice(offset, offset + 100).map(t => yandexTrack(t));
      } else {
        const data = object(await this.call(`users/${id(ref.ownerId)}/playlists/${id(ref.id)}`)); const refs = list(data.tracks); result.count = refs.length;
        result.tracks = await this.tracks(refs.slice(offset, offset + 100).map(t => object(t).id || object(object(t).track).id));
      }
    } else if (r.kind === "artist") {
      const data = object(await this.call(`artists/${id(r.artistId)}/tracks?page=${Math.floor(offset / 100)}&page-size=100`));
      result.tracks = list(data.tracks).map(t => yandexTrack(t)); result.count = number(object(data.pager).total) || result.tracks.length;
    } else if (r.kind === "catalog" && r.artistId) {
      const data = object(await this.call(`artists/${id(r.artistId)}/direct-albums?page=${Math.floor(offset / 100)}&page-size=100`));
      result.playlists = list(data.albums).map(v => { const a = object(v); return { source: "yandex", id: id(a.id), ownerId: 0, title: string(a.title), description: "", count: number(a.trackCount), cover: cover(a.coverUri), original: { source: "yandex", kind: "album", id: id(a.id), ownerId: 0 } }; });
      result.count = number(object(data.pager).total) || result.playlists.length;
    } else throw new VkError("Этот раздел пока не подключён для Яндекс Музыки.");
    if (r.kind !== "library" && result.tracks.length) {
      const me = await this.profile(), data = object(await this.call(`users/${me.id}/likes/tracks`));
      const liked = new Set(list(object(data.library).tracks).map(v => Number(object(v).id)));
      result.tracks = result.tracks.map(t => ({ ...t, saved: liked.has(t.id) }));
    }
    if (result.tracks.length) {
      const me = await this.profile(), data = object(await this.call(`users/${me.id}/dislikes/tracks`));
      const disliked = new Set(list(object(data.library).tracks).map(v => Number(object(v).id)));
      result.tracks = result.tracks.map(t => ({ ...t, disliked: disliked.has(t.id) }));
    }
    return result;
  }
  async library(action: LibraryAction): Promise<{ track?: Track; playlist?: Playlist }> {
    const me = await this.profile();
    if (["dislike", "undislike", "reactions"].includes(action.type) && "track" in action) {
      const trackId = id(action.track.id);
      if (action.type !== "reactions") await this.call(`users/${me.id}/dislikes/tracks/${action.type === "dislike" ? "add-multiple" : "remove"}`, { "track-ids": String(trackId) });
      const [likes, dislikes] = await Promise.all([this.call(`users/${me.id}/likes/tracks`), this.call(`users/${me.id}/dislikes/tracks`)]);
      const contains = (data: unknown) => list(object(object(data).library).tracks).some(v => Number(object(v).id) === trackId);
      return { track: { source: "yandex", id: trackId, ownerId: 0, title: "", artist: "", duration: 0, restricted: false, url: "", saved: contains(likes), disliked: contains(dislikes) } };
    }
    if (["add", "delete", "restore"].includes(action.type) && "track" in action) {
      const tracks = await this.tracks([action.track.id]);
      if (!tracks[0] || tracks[0].restricted) throw new VkError("Трек не найден в Яндекс Музыке.");
      await this.call(`users/${me.id}/likes/tracks/${action.type === "delete" ? "remove" : "add-multiple"}`, { "track-ids": String(id(action.track.id)) });
      return { track: { ...tracks[0], saved: action.type !== "delete", disliked: action.type === "delete" ? action.track.source === "yandex" && (action.track as Track).disliked : false } };
    }
    throw new VkError("Редактирование плейлистов Яндекс Музыки пока недоступно в UniMusic.");
  }
  async resolve(track: Track): Promise<Track> {
    const variants = list(await this.call(`tracks/${id(track.id)}/download-info`)).map(object);
    const full = variants.filter(v => v.preview === false && v.codec === "mp3").sort((a,b) => number(b.bitrateInKbps) - number(a.bitrateInKbps))[0];
    if (!full) throw new VkError("Яндекс не предоставил полный трек. Проверьте подписку Плюс; короткие фрагменты не воспроизводятся.", 402);
    const infoUrl = yandexUrl(string(full.downloadInfoUrl));
    const response = await this.fetcher(infoUrl, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new VkError("Не удалось получить поток Яндекс Музыки.");
    const xml = await response.text(); if (xml.length > 65536 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new VkError("Некорректный ответ аудиосервера.");
    const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? "";
    const host = tag("host"), path = tag("path"), ts = tag("ts"), salt = tag("s");
    if (!path.startsWith("/") || !/^[a-f0-9]{1,32}$/i.test(ts) || !salt || /[?#]/.test(path)) throw new VkError("Некорректный адрес потока.");
    const sign = createHash("md5").update("XGRlBW9FXlekgbPrRHuSiA" + path.slice(1) + salt).digest("hex");
    const metadata = (await this.tracks([track.id]))[0];
    return { ...track, ...metadata, saved: track.saved, disliked: track.disliked, url: yandexUrl(`https://${host}/get-mp3/${sign}/${ts}${path}`).href };
  }
  async waveFeedback(track: Track, type: string, seconds: number): Promise<void> {
    if (track.source !== "yandex" || !this.waveBatches.has(track.id)) return;
    if (!["trackStarted", "trackFinished", "skip"].includes(type) || !Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new VkError("Некорректное событие воспроизведения.");
    const params = new URLSearchParams({ "batch-id": this.waveBatches.get(track.id)! });
    if (!this.waveStarted && type === "trackStarted") {
      await this.json(`https://api.music.yandex.net/rotor/station/user:onyourwave/feedback?${params}`, { type: "radioStarted", timestamp: new Date().toISOString(), from: "desktop-unimusic" }, true, true);
      this.waveStarted = true;
    }
    const body = { type, timestamp: new Date().toISOString(), trackId: String(track.id), totalPlayedSeconds: seconds, from: "desktop-unimusic" };
    const result = await this.json(`https://api.music.yandex.net/rotor/station/user:onyourwave/feedback?${params}`, body, true, true);
    if (result.error) throw new VkError("Не удалось обновить Мою волну.");
    if (type !== "trackStarted") this.waveQueue = track.id;
  }
  async lyrics(trackId: unknown): Promise<string> {
    const track = id(trackId), timeStamp = String(Math.floor(Date.now() / 1000));
    const sign = createHmac("sha256", "p93jhgh689SBReK6ghtw62").update(`${track}${timeStamp}`).digest("base64");
    const data = object(await this.call(`tracks/${track}/lyrics?${new URLSearchParams({ format: "TEXT", timeStamp, sign })}`));
    if (!string(data.downloadUrl)) throw new VkError("Для этой песни текст недоступен.");
    const response = await this.fetcher(yandexUrl(string(data.downloadUrl)), { redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new VkError("Не удалось загрузить текст песни.");
    const text = await response.text();
    if (!text.trim() || text.length > 200000 || /^\s*</.test(text)) throw new VkError("Для этой песни текст недоступен.");
    return text;
  }
}
