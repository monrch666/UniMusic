import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, rm, stat, open } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { parseFile } from "music-metadata";
import type { DownloadEntry, OfflineState, Track, TrackInfo } from "../src/shared";
import { durableTrack, JsonFile } from "./state";
import { MediaProxy } from "./media";
import { VkError } from "./vk";

type Stored = DownloadEntry & { path?: string; coverPath?: string; managed?: boolean; automatic?: boolean };
const key = (t: Track) => t.localId ?? `${t.source === "yandex" ? "yandex:" : ""}${t.ownerId}_${t.id}`;
export const safeFileName = (value: string) => value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 140) || "Audio";

async function saveResponse(response: Response, path: string, limit: number, progress: (bytes: number) => void): Promise<number> {
  if (!response.ok || !response.body) throw new VkError("Аудиопоток недоступен.");
  const file = await open(path, "w"); let bytes = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > limit) throw new VkError("Файл превышает 1 ГБ.");
      await file.writeFile(chunk); progress(bytes);
    }
  } finally { await file.close(); }
  return bytes;
}

// Materialize only opaque, validated proxy resources. FFmpeg never receives a network URL.
export async function saveHls(url: string, folder: string, fetcher: (url: string) => Promise<Response>, signal: AbortSignal,
  progress: (value: number) => void, depth = 0): Promise<string> {
  if (depth > 4) throw new VkError("Слишком сложный HLS-поток.");
  const response = await fetcher(url);
  if (!response.ok) throw new VkError("Не удалось получить HLS-поток.");
  const text = await response.text();
  if (text.length > 1_048_576 || !text.trimStart().startsWith("#EXTM3U")) throw new VkError("Некорректный HLS.");
  const lines = text.split(/\r?\n/);
  const variants = lines.flatMap((line, i) => line.startsWith("#EXT-X-STREAM-INF:") && lines[i + 1] ? [{ url: lines[i + 1], bandwidth: Number(/BANDWIDTH=(\d+)/.exec(line)?.[1]) || 0 }] : []);
  if (variants.length) return saveHls(variants.sort((a, b) => b.bandwidth - a.bandwidth)[0].url, folder, fetcher, signal, progress, depth + 1);
  if (!text.includes("#EXT-X-ENDLIST")) throw new VkError("Скачивание бесконечного потока не поддерживается.");
  const links = [...new Set(lines.flatMap(line => line.startsWith("#") ? [...line.matchAll(/\bURI="([^"]+)"/g)].map(m => m[1]) : line.trim() ? [line.trim()] : []))];
  if (links.length > 10_000) throw new VkError("Поток слишком большой.");
  let bytes = 0;
  const names = new Map<string, string>();
  for (const [index, link] of links.entries()) {
    signal.throwIfAborted();
    if (!link.startsWith("unimusic-media://stream/")) throw new VkError("Недопустимый ресурс HLS.");
    const result = await fetcher(link);
    if (!result.ok) throw new VkError("Не удалось скачать фрагмент.");
    const name = `part-${index}.bin`;
    bytes += await saveResponse(result, join(folder, name), 1_073_741_824 - bytes, () => {});
    names.set(link, name); progress((index + 1) / links.length * .85);
  }
  const local = lines.map(line => line.startsWith("#")
    ? line.replace(/\bURI="([^"]+)"/g, (_, uri: string) => `URI="${names.get(uri)}"`)
    : line.trim() ? names.get(line.trim())! : line).join("\n");
  const path = join(folder, "input.m3u8");
  await writeFile(path, local); return path;
}

export class OfflineStore {
  private entries: Stored[] = [];
  private jobs = new Map<string, AbortController>();
  private completions = new Map<string, Promise<void>>();
  private running = false;
  private repairingCovers = false;
  private attemptedCovers = new Set<string>();
  private file: JsonFile<Stored[]>;
  constructor(private root: string, private media: MediaProxy, private directory: () => string,
    private resolver: (track: Track) => Promise<Track>, private coverResolver?: (track: Track) => Promise<string | undefined>) {
    this.file = new JsonFile(root, "offline.json");
  }
  async init() {
    this.entries = (await this.file.read([])).filter(e => e && typeof e.id === "string" && e.track).map(e =>
      e.state === "downloading" || e.state === "queued" ? { ...e, state: "cancelled" as const } : e);
  }
  private persist() { return this.file.write(this.entries); }
  private repairCovers() {
    if (!this.coverResolver || this.repairingCovers) return;
    this.repairingCovers = true;
    void (async () => {
      for (const entry of this.entries) {
        if (!/^[\w-]{1,100}$/.test(entry.id) || entry.state !== "complete" || entry.track.source !== "yandex" || entry.coverPath || this.attemptedCovers.has(entry.id)) continue;
        this.attemptedCovers.add(entry.id);
        try {
          const url = await this.coverResolver!(entry.track);
          if (!url) continue;
          const response = await this.media.handle(new Request(url));
          const mime = response.headers.get("content-type")?.split(";")[0];
          const ext = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : undefined;
          if (!response.ok || !ext || Number(response.headers.get("content-length")) > 8_388_608) { await response.body?.cancel(); continue; }
          const data = new Uint8Array(await response.arrayBuffer());
          if (!data.length || data.length > 8_388_608 || !this.entries.includes(entry)) continue;
          await mkdir(join(this.root, "covers"), { recursive: true });
          const path = join(this.root, "covers", `${entry.id}.${ext}`);
          await writeFile(path, data);
          if (!this.entries.includes(entry)) { await rm(path, { force: true }); continue; }
          entry.coverPath = path; await this.persist();
        } catch { /* Offline artwork repair must never delay playback. */ }
      }
    })().finally(() => { this.repairingCovers = false; });
  }
  state(): OfflineState {
    this.repairCovers();
    return { directory: this.directory(), bytes: this.entries.reduce((sum, e) => sum + (e.state === "complete" ? e.bytes : 0), 0),
      entries: this.entries.map(({ path: _path, managed: _managed, automatic: _automatic, coverPath, ...e }) => ({
        ...e, track: { ...e.track, cover: coverPath ? this.media.registerFile(coverPath) : e.track.cover },
      })) };
  }
  async resolve(track: Track): Promise<Track | null> {
    const entry = this.entries.find(e => e.path && key(e.track) === key(track));
    if (!entry?.path) return null;
    try { await stat(entry.path); } catch { return null; }
    this.repairCovers();
    return { ...entry.track, url: this.media.registerFile(entry.path), cover: entry.coverPath ? this.media.registerFile(entry.coverPath) : track.cover ?? entry.track.cover };
  }
  path(id: string): string {
    const entry = this.entries.find(e => e.id === id && e.state === "complete");
    if (!entry?.path) throw new VkError("Файл не найден.");
    return entry.path;
  }
  async upload(id: string, send: (path: string, track: Track) => Promise<void>) {
    const input = this.path(id); const entry = this.entries.find(e => e.id === id)!;
    const metadata = await parseFile(input);
    if (metadata.format.codec?.includes("Layer 3")) { await send(input, entry.track); return; }
    const folder = join(this.root, "uploads"); await mkdir(folder, { recursive: true });
    const output = join(folder, `${randomUUID()}.mp3`);
    try {
      const binary = typeof ffmpeg === "string" ? ffmpeg.replace(/app\.asar([\\/])/, "app.asar.unpacked$1") : "";
      await new Promise<void>((resolve, reject) => {
        const process = spawn(binary, ["-nostdin", "-v", "error", "-protocol_whitelist", "file", "-i", input, "-vn", "-c:a", "libmp3lame", "-q:a", "2", output], { windowsHide: true, stdio: "ignore", signal: AbortSignal.timeout(180_000) });
        process.on("error", reject); process.on("exit", code => code === 0 ? resolve() : reject(new VkError("Не удалось подготовить MP3 для VK.")));
      });
      await send(output, entry.track);
    } finally { await rm(output, { force: true }); }
  }
  async info(track: Track): Promise<TrackInfo | null> {
    const entry = this.entries.find(e => key(e.track) === key(track) && e.state === "complete");
    if (!entry?.path) return null;
    const metadata = await parseFile(entry.path);
    return { format: metadata.format.container ?? "Audio", bitrate: metadata.format.bitrate, size: (await stat(entry.path)).size, source: entry.managed ? "Скачанный файл" : "Локальный файл" };
  }
  async import(paths: string[]) {
    for (const path of paths) {
      if (this.entries.some(e => e.path === path)) continue;
      try {
        const metadata = await parseFile(path);
        const id = randomUUID();
        const cover = metadata.common.picture?.[0];
        let coverPath: string | undefined;
        if (cover && cover.data.length < 8_388_608 && ["image/jpeg", "image/png"].includes(cover.format)) {
          await mkdir(join(this.root, "covers"), { recursive: true });
          coverPath = join(this.root, "covers", `${id}.${cover.format === "image/png" ? "png" : "jpg"}`);
          await writeFile(coverPath, cover.data);
        }
        this.entries.push({ id, track: { id: Date.now(), ownerId: 0, localId: id, source: "local", folder: basename(dirname(path)), title: metadata.common.title ?? basename(path),
          artist: metadata.common.artist ?? "Неизвестный исполнитель", album: metadata.common.album, duration: metadata.format.duration ?? 0, url: "", restricted: false },
          state: "complete", progress: 1, bytes: (await stat(path)).size, path, coverPath, managed: false });
      } catch { throw new VkError(`Не удалось прочитать файл «${basename(path)}».`); }
      await this.persist();
    }
  }
  async enqueue(values: Track[], replace = false, automatic = false) {
    if (!Array.isArray(values) || !values.length || values.length > 100) throw new VkError("Выберите от 1 до 100 треков.");
    for (const value of values) {
      const track = durableTrack(value);
      if (track.source === "local") continue;
      const existing = this.entries.find(e => key(e.track) === key(track));
      if (existing && !automatic) existing.automatic = false;
      if (existing && (this.jobs.has(existing.id) || ["queued", "downloading"].includes(existing.state) || existing.state === "complete" && !replace)) continue;
      if (existing) Object.assign(existing, { track, state: "queued", progress: 0, error: undefined, automatic });
      else this.entries.push({ id: randomUUID(), track, state: "queued", progress: 0, bytes: 0, managed: true, automatic });
    }
    await this.persist(); void this.run().catch(() => {
      for (const entry of this.entries) if (["queued", "downloading"].includes(entry.state)) {
        entry.state = "error"; entry.error = "Не удалось сохранить состояние загрузок. Проверьте свободное место.";
      }
    });
  }
  async cancelAutoCache(track: Track) {
    const entry = this.entries.find(e => key(e.track) === key(track) && e.automatic);
    if (entry) await this.cancel(entry.id);
  }
  async cancel(id: string) {
    const entry = this.entries.find(e => e.id === id);
    if (!entry || !["queued", "downloading"].includes(entry.state)) return;
    entry.state = "cancelled"; this.jobs.get(id)?.abort(); await this.persist();
  }
  async remove(id: string) {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return;
    await this.cancel(id);
    await this.completions.get(id);
    // Imported originals are never removed; only files bearing our generated ID are owned here.
    if (entry.managed && entry.path && basename(entry.path).endsWith(`-${entry.id}.mp3`)) await rm(entry.path, { force: true });
    if (entry.coverPath && resolve(entry.coverPath).startsWith(resolve(this.root, "covers") + sep)) await rm(entry.coverPath, { force: true });
    this.entries = this.entries.filter(e => e !== entry); await this.persist();
  }
  async clear() { for (const e of [...this.entries]) if (e.managed) await this.remove(e.id); }
  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const entry = this.entries.find(e => e.state === "queued");
        if (!entry) break;
        const abort = new AbortController(); this.jobs.set(entry.id, abort);
        let finish!: () => void;
        this.completions.set(entry.id, new Promise(resolve => { finish = resolve; }));
        entry.state = "downloading";
        let folder: string | undefined;
        try {
          const resolved = await this.resolver(entry.track);
          abort.signal.throwIfAborted();
          const directory = this.directory(); await mkdir(directory, { recursive: true });
          folder = join(directory, `.unimusic-${entry.id}`); await mkdir(folder, { recursive: true });
          const fetcher = (url: string) => this.media.handle(new Request(url, { signal: abort.signal }));
          let input: string;
          const hls = /\.m3u8(?:\?|$)/i.test(resolved.url);
          if (hls) input = await saveHls(resolved.url, folder, fetcher, abort.signal, n => { entry.progress = n; });
          else {
            const response = await fetcher(resolved.url);
            if (!response.ok || !response.body) throw new VkError("Аудиопоток недоступен.");
            const total = Number(response.headers.get("content-length")) || 0;
            input = join(folder, "input.audio");
            await saveResponse(response, input, 1_073_741_824, bytes => { entry.progress = total ? Math.min(.85, bytes / total * .85) : 0; });
          }
          let coverPath: string | undefined;
          if (resolved.cover) {
            try {
              const response = await fetcher(resolved.cover);
              const data = new Uint8Array(await response.arrayBuffer());
              const mime = response.headers.get("content-type") ?? "";
              if (response.ok && data.length < 8_388_608 && /image\/(jpeg|png|webp)/.test(mime)) {
                coverPath = join(folder, mime.includes("webp") ? "cover.webp" : mime.includes("png") ? "cover.png" : "cover.jpg"); await writeFile(coverPath, data);
              }
            } catch { /* Cover failure does not discard a downloaded recording. */ }
          }
          const output = join(folder, "output.mp3");
          const original = !hls ? await parseFile(input) : null;
          const copyAudio = original?.format.codec?.includes("Layer 3");
          const args = ["-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,crypto,data", ...(hls ? ["-allowed_extensions", "ALL"] : []), "-i", input,
            ...(coverPath ? ["-i", coverPath] : []), "-map", "0:a:0", ...(coverPath ? ["-map", "1:v:0", "-c:v", "mjpeg", "-disposition:v", "attached_pic"] : []),
            "-c:a", copyAudio ? "copy" : "libmp3lame", ...(!copyAudio ? ["-q:a", "2"] : []), "-id3v2_version", "3", "-metadata", `title=${entry.track.title}`,
            "-metadata", `artist=${entry.track.artist}`, "-metadata", `album=${entry.track.album ?? ""}`, output];
          const binary = typeof ffmpeg === "string" ? ffmpeg.replace(/app\.asar([\\/])/, "app.asar.unpacked$1") : "";
          if (!binary) throw new VkError("FFmpeg недоступен.");
          await new Promise<void>((resolve, reject) => {
            const process = spawn(binary, args, { windowsHide: true, stdio: "ignore", signal: abort.signal });
            process.on("error", reject); process.on("exit", code => code === 0 ? resolve() : reject(new VkError("Не удалось сохранить аудиофайл.")));
          });
          const metadata = await parseFile(output);
          if (entry.track.duration > 20 && (metadata.format.duration ?? 0) < entry.track.duration * .8) throw new VkError("VK вернул неполный аудиопоток.");
          abort.signal.throwIfAborted();
          if (entry.path) {
            const old = await parseFile(entry.path).catch(() => null);
            if (old && (old.format.bitrate ?? 0) >= (metadata.format.bitrate ?? 0)) {
              entry.state = "complete"; entry.progress = 1; entry.error = "Сохранена версия с более высоким или равным битрейтом."; continue;
            }
          }
          const path = join(directory, `${safeFileName(`${entry.track.artist} — ${entry.track.title}`)}-${entry.id}.mp3`);
          await rename(output, path);
          const previousPath = entry.path;
          if (coverPath) {
            const picture = metadata.common.picture?.[0];
            if (picture) {
              await mkdir(join(this.root, "covers"), { recursive: true });
              entry.coverPath = join(this.root, "covers", `${entry.id}.jpg`); await writeFile(entry.coverPath, picture.data);
            }
          }
          Object.assign(entry, { path, bytes: (await stat(path)).size, progress: 1, state: "complete", error: undefined });
          if (previousPath && previousPath !== path && basename(previousPath).endsWith(`-${entry.id}.mp3`)) await rm(previousPath, { force: true }).catch(() => {});
        } catch (error) {
          entry.state = abort.signal.aborted ? "cancelled" : "error";
          entry.error = abort.signal.aborted ? undefined : error instanceof VkError ? error.message : "Не удалось скачать файл. Повторите попытку.";
          if (entry.path) { entry.state = "complete"; entry.progress = 1; }
        } finally {
          this.jobs.delete(entry.id);
          if (folder && basename(folder) === `.unimusic-${entry.id}`) await rm(folder, { recursive: true, force: true }).catch(() => {});
          try { await this.persist(); } finally { finish(); this.completions.delete(entry.id); }
        }
      }
    } finally { this.running = false; }
  }
}
