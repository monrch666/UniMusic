import type { Artist, BrowseRequest, LibraryAction, MusicPage, Page, Playlist, Profile, Track } from "../src/shared";

export const VK_APP_ID = 2274003;
export const VK_VERSION = "5.186";
export const AUTH_USER_AGENT =
  "VKAndroidApp/8.191-56796 (Android 13; SDK 33; arm64-v8a; UniMusic; ru; 1080x1920)";
export const MUSIC_USER_AGENT =
  "VKAndroidApp/8.15-15271 (Android 13; SDK 33; arm64-v8a; UniMusic; ru; 1080x1920)";
export type Json = Record<string, unknown>;
export type Params = Record<string, string | number | undefined>;
export type Transport = (
  method: string,
  params: Params,
  oauth?: boolean,
) => Promise<Json>;
export interface Credential {
  accessToken: string;
  userId: number;
  expiresAt: number | null;
}

export class VkError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message);
  }
}

export function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}
export const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
export const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export function httpsUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}

export function apiError(value: unknown): never {
  const code = number(object(value).error_code);
  const messages: Record<number, string> = {
    5: "Сессия VK истекла. Войдите снова.",
    6: "Слишком много запросов. Попробуйте через несколько секунд.",
    9: "VK временно ограничил запросы. Попробуйте позже.",
    14: "Не удалось завершить проверку безопасности VK. Повторите попытку.",
    15: "VK не разрешил доступ к этой музыке для вашего аккаунта.",
    17: "VK требует подтверждения аккаунта. Проверьте аккаунт в приложении VK.",
    29: "Достигнут лимит запросов VK. Попробуйте позже.",
  };
  throw new VkError(
    messages[code] ??
      `Не удалось выполнить запрос VK${code ? ` (код ${code})` : ""}.`,
    code || undefined,
  );
}

export function unwrap(data: Json): unknown {
  if (data.error) apiError(data.error);
  if (!("response" in data))
    throw new VkError("VK вернул неожиданный ответ. Повторите запрос.");
  return data.response;
}

export function createTransport(fetcher: typeof fetch = fetch, deviceId?: string): Transport {
  return async (method, params, oauth = false) => {
    const body = new URLSearchParams({ v: VK_VERSION, lang: "ru", https: "1" });
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) body.set(key, String(value));
    const audioRequest = !oauth && /^(audio|catalog|stats)\./.test(method);
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": oauth || method.startsWith("auth.") || method.startsWith("ecosystem.")
        ? AUTH_USER_AGENT : MUSIC_USER_AGENT,
    };
    if (audioRequest) {
      headers["X-VK-Android-Client"] = "new";
      if (deviceId) body.set("device_id", deviceId);
      if (typeof params.access_token === "string") {
        headers.Authorization = `Bearer ${params.access_token}`;
        body.delete("access_token");
      }
    }
    let response: Response;
    try {
      response = await fetcher(
        `${oauth ? "https://oauth.vk.com/" : "https://api.vk.com/method/"}${method}`,
        {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(25_000),
          redirect: "error",
        },
      );
    } catch {
      throw new VkError(
        "Нет соединения с VK. Проверьте интернет и повторите попытку.",
      );
    }
    let data: Json;
    try {
      data = object(await response.json());
    } catch {
      throw new VkError("VK вернул ответ в неизвестном формате.");
    }
    if (!response.ok && !data.error)
      throw new VkError(`Сервер VK недоступен (HTTP ${response.status}).`);
    return data;
  };
}

function cover(value: unknown): string | undefined {
  const photo = object(value);
  return (
    httpsUrl(photo.photo_600) ||
    httpsUrl(photo.photo_300) ||
    httpsUrl(photo.photo_135) ||
    httpsUrl(photo.photo_68) ||
    undefined
  );
}

export function mapTrack(value: unknown): Track {
  const t = object(value);
  const album = object(t.album);
  return {
    id: number(t.id),
    ownerId: number(t.owner_id),
    title: string(t.title) || "Без названия",
    artist: string(t.artist) || "Неизвестный исполнитель",
    duration: Math.max(0, number(t.duration)),
    // Fenrir excludes VK's playable error stub instead of treating it as a song.
    url: string(t.url).includes("audio_api_unavailable") ? "" : httpsUrl(t.url),
    cover: cover(album.thumb),
    album: string(album.title) || undefined,
    accessKey: string(t.access_key) || undefined,
    restricted: Boolean(t.is_restricted || t.content_restricted),
    artists: Array.isArray(t.main_artists) ? t.main_artists.map(mapArtist).filter(a => a.id) : undefined,
    albumRef: number(album.id) && number(album.owner_id) ? { id: number(album.id), ownerId: number(album.owner_id), accessKey: string(album.access_key) || undefined } : undefined,
    lyricsId: number(t.lyrics_id),
    genre: number(t.genre_id),
    date: number(t.date),
    source: "vk",
  };
}

export function mapPlaylist(value: unknown): Playlist {
  const p = object(value);
  const thumbs = Array.isArray(p.thumbs) ? p.thumbs : [];
  return {
    id: number(p.id),
    ownerId: number(p.owner_id),
    title: string(p.title) || "Без названия",
    description: string(p.description),
    count: Math.max(0, number(p.count)),
    cover: cover(p.photo) || cover(thumbs[0]),
    accessKey: string(p.access_key) || undefined,
    original: number(object(p.original).id) ? {
      id: number(object(p.original).id), ownerId: number(object(p.original).owner_id),
      accessKey: string(object(p.original).access_key) || undefined,
    } : undefined,
    year: number(p.year),
    artist: string(p.artist_name) || undefined,
  };
}

export function mapArtist(value: unknown): Artist {
  const a = object(value);
  const photos = Array.isArray(object(a.photo).sizes) ? object(a.photo).sizes as unknown[] : [];
  return { id: string(a.id) || String(number(a.id) || ""), name: string(a.name) || "Исполнитель",
    cover: cover(a.photo) || httpsUrl(object(photos.at(-1)).url) || undefined };
}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export function textField(value: unknown, max = 200, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008]/.test(value))
    throw new VkError("Проверьте введённый текст.");
  return value.trim();
}
const audioId = (value: unknown) => {
  const r = trackReference(value);
  return `${r.ownerId}_${r.id}${r.accessKey ? `_${r.accessKey}` : ""}`;
};

export function mapCatalog(value: unknown): MusicPage {
  const data = object(value);
  const catalog = object(data.catalog);
  const section = object(data.section);
  const block = object(data.block);
  const sections = list(catalog.sections).map(value => {
    const s = object(value);
    return { id: string(s.id), title: string(s.title) || "Подборка", kind: "section" as const };
  });
  const blocks = list(section.blocks).map(value => {
    const b = object(value); const layout = object(b.layout);
    return { id: string(b.id), title: string(layout.title) || string(layout.name) || "Все записи", kind: "block" as const, cursor: string(b.next_from) || undefined };
  }).filter(b => b.id && b.cursor);
  const tracks = list(data.audios).map(mapTrack);
  const playlists = [...list(data.playlists), ...list(data.recommended_playlists).flatMap(p => {
    const v = object(p); return v.playlist ? [v.playlist] : [];
  })].map(mapPlaylist).filter(p => p.id);
  return { tracks, playlists, artists: list(data.artists).map(mapArtist),
    sections: [...sections, ...blocks].filter(s => s.id),
    count: tracks.length + playlists.length, next: string(section.next_from) || string(block.next_from) || undefined,
    title: string(section.title) || undefined };
}

export function offset(value: unknown): number {
  if (value === undefined) return 0;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > 1_000_000
  )
    throw new VkError("Некорректная страница.");
  return Number(value);
}

export function trackReference(value: unknown): {
  id: number;
  ownerId: number;
  accessKey?: string;
} {
  const ref = object(value);
  if (
    !Number.isSafeInteger(ref.id) ||
    Number(ref.id) <= 0 ||
    !Number.isSafeInteger(ref.ownerId) ||
    Number(ref.ownerId) === 0
  ) {
    throw new VkError("Некорректный идентификатор музыки.");
  }
  const key = string(ref.accessKey);
  if (key.length > 256 || (key && !/^[\w-]+$/.test(key)))
    throw new VkError("Некорректный ключ доступа.");
  return {
    id: Number(ref.id),
    ownerId: Number(ref.ownerId),
    accessKey: key || undefined,
  };
}

export function validCredential(value: unknown): value is Credential {
  const c = object(value);
  return (
    typeof c.accessToken === "string" &&
    /^[\w.-]{20,4096}$/.test(c.accessToken) &&
    Number.isSafeInteger(c.userId) &&
    Number(c.userId) > 0 &&
    (c.expiresAt === null ||
      (typeof c.expiresAt === "number" &&
        Number.isFinite(c.expiresAt) &&
        c.expiresAt > Date.now()))
  );
}

export class VkClient {
  constructor(
    private transport: Transport,
    private credential: Credential,
  ) {}
  private async call(method: string, params: Params = {}): Promise<unknown> {
    return unwrap(
      await this.transport(method, {
        ...params,
        access_token: this.credential.accessToken,
      }),
    );
  }
  async profile(): Promise<Profile> {
    const data = await this.call("users.get", {
      user_ids: this.credential.userId,
      fields: "photo_200",
    });
    const user = object(Array.isArray(data) ? data[0] : null);
    if (number(user.id) !== this.credential.userId)
      throw new VkError("Не удалось получить профиль VK.");
    return {
      id: number(user.id),
      firstName: string(user.first_name),
      lastName: string(user.last_name),
      avatar: httpsUrl(user.photo_200) || undefined,
    };
  }
  async tracks(start?: number, playlist?: unknown): Promise<Page<Track>> {
    const ref = playlist === undefined ? undefined : trackReference(playlist);
    return this.page(
      "audio.get",
      {
        owner_id: ref?.ownerId ?? this.credential.userId,
        playlist_id: ref?.id,
        access_key: ref?.accessKey,
        offset: offset(start),
        count: 100,
      },
      mapTrack,
    );
  }
  async search(query: unknown, start?: number): Promise<Page<Track>> {
    if (typeof query !== "string" || !query.trim() || query.length > 200)
      throw new VkError("Введите запрос длиной до 200 символов.");
    return this.page(
      "audio.search",
      { q: query.trim(), auto_complete: 1, offset: offset(start), count: 100 },
      mapTrack,
    );
  }
  async playlists(start?: number): Promise<Page<Playlist>> {
    return this.page(
      "audio.getPlaylists",
      { owner_id: this.credential.userId, offset: offset(start), count: 100 },
      mapPlaylist,
    );
  }
  async browse(value: BrowseRequest): Promise<MusicPage> {
    const r = object(value);
    const start = offset(r.offset);
    const result: MusicPage = { tracks: [], playlists: [], artists: [], sections: [], count: 0 };
    if (r.kind === "library" || r.kind === "playlist") {
      if (r.kind === "library" && r.ownerId !== undefined) {
        const owner = trackReference({ id: 1, ownerId: r.ownerId }).ownerId;
        const page = await this.page("audio.get", { owner_id: owner, count: 100, offset: start }, mapTrack);
        return { ...result, tracks: page.items, count: page.count };
      }
      const page = await this.tracks(start, r.kind === "playlist" ? r.playlist : undefined);
      return { ...result, tracks: page.items, count: page.count };
    }
    if (r.kind === "search") {
      const q = textField(r.query);
      const f = object(r.filters);
      if (f.type === "playlists" || f.type === "artists") {
        const data = object(await this.call(f.type === "artists" ? "audio.searchArtists" : "audio.searchPlaylists", { q, offset: start, count: 100 }));
        return { ...result, count: number(data.count), artists: f.type === "artists" ? list(data.items).map(mapArtist) : [], playlists: f.type === "playlists" ? list(data.items).map(mapPlaylist) : [] };
      }
      if (f.sort !== undefined && ![0, 1, 2].includes(Number(f.sort))) throw new VkError("Некорректная сортировка.");
      const page = await this.page("audio.search", { q, count: 100, offset: start, sort: f.sort as number | undefined,
        auto_complete: f.autocomplete === false ? 0 : 1, search_own: f.own ? 1 : 0,
        performer_only: f.performer ? 1 : 0, lyrics: f.lyrics ? 1 : 0 }, mapTrack);
      return { ...result, tracks: page.items, count: page.count };
    }
    if (r.kind === "artist") {
      const data = object(await this.call("audio.getAudiosByArtist", { artist_id: textField(r.artistId), offset: start, count: 100 }));
      return { ...result, tracks: list(data.items).map(mapTrack), count: number(data.count) };
    }
    if (r.kind === "recommendations" || r.kind === "popular") {
      const params: Params = { count: 100, offset: start };
      let method = "audio.getRecommendations";
      if (r.kind === "popular") {
        method = "audio.getPopular"; params.only_eng = 0;
        if (r.genre !== undefined) {
          if (!Number.isSafeInteger(r.genre) || Number(r.genre) < 0 || Number(r.genre) > 1000) throw new VkError("Некорректный жанр.");
          params.genre_id = Number(r.genre);
        }
      } else if (r.track) { params.target_audio = audioId(r.track); }
      else params.user_id = this.credential.userId;
      const data = await this.call(method, params);
      const items = list(Array.isArray(data) ? data : object(data).items);
      return { ...result, tracks: items.map(mapTrack), count: number(object(data).count) || items.length };
    }
    if (r.kind === "catalog") {
      return mapCatalog(await this.call(r.artistId ? "catalog.getAudioArtist" : "catalog.getAudio",
        r.artistId ? { artist_id: textField(r.artistId), need_blocks: 1 } : { owner_id: this.credential.userId, need_blocks: 1 }));
    }
    if (r.kind === "section" || r.kind === "block") {
      return mapCatalog(await this.call(r.kind === "section" ? "catalog.getSection" : "catalog.getBlockItems", {
        [r.kind === "section" ? "section_id" : "block_id"]: textField(r.kind === "section" ? r.sectionId : r.blockId, 2048),
        start_from: r.cursor === undefined ? undefined : textField(r.cursor, 4096),
      }));
    }
    throw new VkError("Неизвестный раздел музыки.");
  }
  async library(action: LibraryAction): Promise<{ track?: Track; playlist?: Playlist }> {
    const a = object(action);
    const owned = (value: unknown) => {
      const r = trackReference(value);
      if (r.ownerId !== this.credential.userId) throw new VkError("Можно изменять только свою коллекцию.");
      return r;
    };
    if (a.type === "createPlaylist") {
      return { playlist: mapPlaylist(await this.call("audio.createPlaylist", {
        owner_id: this.credential.userId, title: textField(a.title), description: textField(a.description, 2000, true),
      })) };
    }
    if (["editPlaylist", "deletePlaylist", "followPlaylist", "clonePlaylist", "addToPlaylist", "removeFromPlaylist"].includes(string(a.type))) {
      const ref = a.type === "followPlaylist" || a.type === "clonePlaylist" ? trackReference(a.playlist) : owned(a.playlist);
      const params: Params = { owner_id: ref.ownerId, playlist_id: ref.id, access_key: ref.accessKey };
      if (a.type === "editPlaylist") { params.title = textField(a.title); params.description = textField(a.description, 2000, true); }
      if (a.type === "addToPlaylist" || a.type === "removeFromPlaylist") {
        if (!Array.isArray(a.tracks) || !a.tracks.length || a.tracks.length > 100) throw new VkError("Выберите от 1 до 100 песен.");
        params.audio_ids = a.tracks.map(audioId).join(",");
      }
      const method = a.type === "clonePlaylist" ? "savePlaylistAsCopy" : String(a.type);
      const data = await this.call(`audio.${method}`, params);
      return a.type === "followPlaylist" || a.type === "clonePlaylist" ? { playlist: mapPlaylist(data) } : {};
    }
    if (!["add", "delete", "restore", "edit", "reorder"].includes(string(a.type))) throw new VkError("Неизвестное действие.");
    const ref = a.type === "add" ? trackReference(a.track) : owned(a.track);
    const params: Params = { owner_id: ref.ownerId, audio_id: ref.id, access_key: ref.accessKey };
    if (a.type === "edit") { params.artist = textField(a.artist); params.title = textField(a.title); }
    if (a.type === "reorder") {
      if ((a.before === undefined) === (a.after === undefined)) throw new VkError("Укажите новое место песни.");
      const id = a.before ?? a.after;
      if (!Number.isSafeInteger(id) || Number(id) <= 0) throw new VkError("Некорректное место песни.");
      params[a.before !== undefined ? "before" : "after"] = Number(id);
    }
    const data = await this.call(`audio.${a.type}`, params);
    if (a.type === "add" && number(data)) {
      return { track: mapTrack({ ...object(a.track), owner_id: this.credential.userId, id: number(data) }) };
    }
    return {};
  }
  async lyrics(value: unknown): Promise<string> {
    const data = object(await this.call("audio.getLyrics", { audio_id: audioId(value) }));
    const lyrics = object(data.lyrics);
    const text = string(data.text) || list(lyrics.text).map(v => string(object(v).text) || string(v)).join("\n") || list(lyrics.timestamps).map(v => string(object(v).line)).join("\n");
    if (!text) throw new VkError("Для этой песни текст недоступен.");
    return text + (string(data.credits) ? `\n\n${string(data.credits)}` : "");
  }
  async uploadServer(): Promise<string> {
    const data = object(await this.call("audio.getUploadServer"));
    const url = httpsUrl(data.upload_url);
    if (!url || !/(^|\.)(vk\.com|vk\.ru|userapi\.com|vkuseraudio\.net)$/i.test(new URL(url).hostname)) throw new VkError("VK вернул недопустимый сервер загрузки.");
    return url;
  }
  async saveUpload(value: unknown, artist: string, title: string): Promise<Track> {
    const data = object(value);
    return mapTrack(await this.call("audio.save", { server: String(data.server ?? ""), audio: textField(data.audio, 100_000),
      hash: textField(data.hash, 1024), artist: textField(artist), title: textField(title) }));
  }
  async played(value: unknown, events: boolean, broadcast: boolean): Promise<void> {
    const r = trackReference(value);
    if (events) await this.call("stats.trackEvents", { events: JSON.stringify([{
      e: "audio_play", audio_id: `${r.ownerId}_${r.id}`, source: "my", uuid: Date.now(),
      duration: Math.max(0, number(object(value).duration)), start_time: Math.floor(Date.now() / 1000),
    }]) });
    if (broadcast) await this.call("audio.setBroadcast", { audio: audioId(value), target_ids: this.credential.userId });
  }
  async resolveTrack(value: unknown, legacyOnly = false, preferLegacy = true): Promise<Track> {
    const ref = trackReference(value);
    const params = {
      audios: `${ref.ownerId}_${ref.id}${ref.accessKey ? `_${ref.accessKey}` : ""}`,
      // VK 5.186 returns five-second HLS stubs for some saved recordings.
      v: legacyOnly || preferLegacy ? "5.90" : VK_VERSION,
    };
    const data = await this.call("audio.getById", params);
    const first = Array.isArray(data) ? data[0] : undefined;
    if (!first) throw new VkError("Эта запись больше недоступна.");
    let track = mapTrack(first);
    if (!track.url && !track.restricted && !legacyOnly) {
      const secondary = await this.call("audio.getById", { ...params, v: preferLegacy ? VK_VERSION : "5.90" });
      if (Array.isArray(secondary) && secondary[0]) track = mapTrack(secondary[0]);
    }
    if (!track.url || track.restricted)
      throw new VkError(
        "VK не предоставил ссылку на воспроизведение этой записи.",
      );
    return track;
  }
  private async page<T>(
    method: string,
    params: Params,
    map: (item: unknown) => T,
  ): Promise<Page<T>> {
    const data = object(await this.call(method, params));
    if (!Array.isArray(data.items))
      throw new VkError("VK не вернул список музыки.");
    return {
      items: data.items.map(map),
      count: Math.max(0, number(data.count)),
    };
  }
}
