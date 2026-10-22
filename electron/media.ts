import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { extname } from "node:path";
import { MUSIC_USER_AGENT } from "./vk";

export const MEDIA_SCHEME = "unimusic-media";
const VK_MEDIA_HOST = /(^|\.)(vkuseraudio\.(net|ru|com)|vk-cdn\.net|userapi\.com|vk\.com|vk\.ru)$/i;

const YANDEX_MEDIA_HOST = /(^|\.)(yandex\.(net|ru|com)|yandexmusic\.net)$/i;
const allowedMediaHost = (url: URL, origin: string) => (YANDEX_MEDIA_HOST.test(new URL(origin).hostname) ? YANDEX_MEDIA_HOST : VK_MEDIA_HOST).test(url.hostname);

function safeUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new Error("Invalid media address");
  return url;
}

export class MediaProxy {
  private resources = new Map<string, { url: string; origin: string }>();
  private files = new Map<string, string>();
  constructor(private fetcher: typeof fetch, private failure: (code: string) => void = () => {}) {}
  clear() { this.resources.clear(); this.files.clear(); }

  registerFile(path: string): string {
    const existing = [...this.files].find(([, file]) => file === path);
    const id = existing?.[0] ?? randomUUID();
    this.files.set(id, path);
    return `${MEDIA_SCHEME}://file/${id}/audio${extname(path)}`;
  }
  private async file(request: Request, path: string): Promise<Response> {
    const { size } = await stat(path);
    let start = 0, end = size - 1, partial = false;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      partial = true;
    }
    const mime: Record<string, string> = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".flac": "audio/flac", ".ogg": "audio/ogg", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
    const headers = new Headers({ "Content-Type": mime[extname(path).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": String(Math.max(0, end - start + 1)), "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*" });
    if (partial) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    const body = request.method === "HEAD" || !size ? null : Readable.toWeb(createReadStream(path, { start, end, signal: request.signal })) as ReadableStream<Uint8Array>;
    return new Response(body, { status: partial ? 206 : 200, headers });
  }

  register(value: string, origin = safeUrl(value).origin): string {
    const url = safeUrl(value);
    if (url.origin !== origin && !allowedMediaHost(url, origin)) throw new Error("Foreign media address");
    const id = randomUUID();
    this.resources.set(id, { url: url.href, origin });
    if (this.resources.size > 8192) this.resources.delete(this.resources.keys().next().value!);
    const extension = /\.(m3u8|mp3|aac|m4a|mp4|ts|jpg|jpeg|png|webp|svg)$/i.exec(url.pathname)?.[0] ?? ".bin";
    return `${MEDIA_SCHEME}://stream/${id}/audio${extension}`;
  }

  private async fetchResource(url: URL, request: Request, headers: Headers): Promise<Response> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => abort.abort(), 60_000);
    };
    arm();
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: request.method, headers, redirect: "manual",
        signal: AbortSignal.any([request.signal, abort.signal]),
      });
    } finally { clearTimeout(timer!); }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let cancelled = false;
    const failure = this.failure;
    return new Response(new ReadableStream({
      async pull(controller) {
        // A slow but progressing song must not expire on a wall-clock deadline.
        arm();
        try {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (error) {
          if (cancelled) return;
          if (!request.signal.aborted) failure("NETWORK_READ_ERROR");
          controller.error(error);
        } finally { clearTimeout(timer); }
      },
      async cancel(reason) {
        cancelled = true;
        clearTimeout(timer);
        abort.abort();
        await reader.cancel(reason).catch(() => {});
      },
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  private playlist(text: string, base: URL, origin: string): string {
    const link = (value: string) => this.register(new URL(value, base).href, origin);
    return text.split(/\r?\n/).map(line => {
      if (line.startsWith("#")) return line.replace(/\bURI="([^"]+)"/g, (_all, uri: string) => `URI="${link(uri)}"`);
      return line.trim() ? link(line.trim()) : line;
    }).join("\n");
  }

  async handle(request: Request): Promise<Response> {
    const target = new URL(request.url);
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
    if (target.hostname === "file") {
      const path = this.files.get(target.pathname.split("/")[1]);
      try { return path ? await this.file(request, path) : new Response(null, { status: 404 }); }
      catch { return new Response(null, { status: 404 }); }
    }
    const source = target.hostname === "stream" ? this.resources.get(target.pathname.split("/")[1]) : undefined;
    if (!source) return new Response(null, { status: 404 });
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405 });
    try {
      let url = safeUrl(source.url);
      const headers = new Headers({ "User-Agent": MUSIC_USER_AGENT });
      const range = request.headers.get("range");
      if (range && /^bytes=\d*-\d*$/.test(range)) headers.set("Range", range);
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 4; redirects++) {
        response = await this.fetchResource(url, request, headers);
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirects === 4) throw new Error("Invalid redirect");
        url = safeUrl(new URL(location, url).href);
        if (url.username || url.password || (url.origin !== source.origin && !allowedMediaHost(url, source.origin))) throw new Error("Foreign redirect");
      }
      if (!response) throw new Error("Missing media response");
      const resultHeaders = new Headers({ "Access-Control-Allow-Origin": "*" });
      for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"])
        if (response.headers.has(name)) resultHeaders.set(name, response.headers.get(name)!);
      if (!response.ok) {
        this.failure(`HTTP_${response.status}`);
        await response.body?.cancel();
        resultHeaders.delete("content-length");
        resultHeaders.delete("content-range");
        return new Response(null, { status: response.status, headers: resultHeaders });
      }
      if (request.method !== "HEAD" && (/\.m3u8$/i.test(url.pathname) || /mpegurl/i.test(response.headers.get("content-type") ?? ""))) {
        if (Number(response.headers.get("content-length")) > 1_048_576) throw new Error("Oversized playlist");
        const text = await response.text();
        if (text.length > 1_048_576 || !text.trimStart().startsWith("#EXTM3U")) throw new Error("Invalid playlist");
        resultHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
        resultHeaders.delete("content-length");
        resultHeaders.delete("content-range");
        return new Response(this.playlist(text, url, source.origin), { headers: resultHeaders });
      }
      return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers: resultHeaders });
    } catch {
      if (!request.signal.aborted) this.failure("NETWORK_OR_PLAYLIST_ERROR");
      return new Response(null, { status: 502, headers: { "Access-Control-Allow-Origin": "*" } });
    }
  }
}
