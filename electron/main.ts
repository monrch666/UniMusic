import { UnifiedStore } from "./unified";
import { AppUpdates } from "./updates";
import electronUpdater from "electron-updater";
import { spawn } from "node:child_process";
import { YandexMusic } from "./yandex";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  nativeTheme,
  protocol,
  safeStorage,
  session,
  clipboard,
  dialog,
  shell,
  Tray,
  nativeImage,
  globalShortcut,
} from "electron";
import { release } from "node:os";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, rename, rm, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DirectAuth, trustedVkUrl } from "./auth";
import { withCaptcha, type CaptchaChallenge } from "./captcha";
import { MediaProxy, MEDIA_SCHEME } from "./media";
import { defaultPreferences, durableTrack, JsonFile, selectAutoCacheTrack, validatePreferences, validateSnapshot } from "./state";
import { updateSavedTracks } from "../src/libraryState";
import { OfflineStore } from "./offline";
import {
  createTransport,
  object,
  validCredential,
  VkClient,
  VkError,
  type Credential,
  type Transport,
} from "./vk";
import type { AppPreferences, AuthAction, BrowseRequest, LibraryAction, Result, Track } from "../src/shared";

const here = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let captchaWindow: BrowserWindow | null = null;
let credential: Credential | null = null;
let auth: DirectAuth;
let accountGeneration = 0;
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const media = new MediaProxy((input, init) => net.fetch(input instanceof URL ? input.href : input, init), code => {
  void writeFile(join(app.getPath("userData"), "playback-diagnostics.json"), JSON.stringify({ at: new Date().toISOString(), source: "media", code })).catch(() => {});
});
let transport: Transport;
let preferences: AppPreferences;
let preferenceFile: JsonFile<AppPreferences>;
let offline: OfflineStore;
let unified: UnifiedStore;
let yandex: YandexMusic;
let yandexToken: string | null = null;
let tray: Tray | null = null;
let quitting = false;
let updates: AppUpdates;
let updateHelperStarted = false;
const updatesSupported = app.isPackaged && process.platform === "win32" && !process.env.UNIMUSIC_TEST_USER_DATA;
async function launchPortableUpdate(restart = false): Promise<boolean> {
  if (updateHelperStarted || !updates.hasPendingPortable) return false;
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", updates.helper,
    "-Manifest", updates.manifest, "-ParentProcessId", String(process.pid), "-PortableFile", process.env.PORTABLE_EXECUTABLE_FILE!, ...(restart ? ["-Restart"] : [])],
  { detached: true, windowsHide: true, stdio: "ignore" });
  return new Promise(resolve => {
    child.once("error", () => resolve(false));
    child.once("spawn", () => { updateHelperStarted = true; child.unref(); resolve(true); });
  });
}
let savedTracks: Record<string, Track | null> = {};
const prepared = new Map<string, { track: Track; expires: number }>();
const preparedKey = (track: Track) => `${credential?.userId ?? 0}:${track.localId ?? `${track.source === "yandex" ? "yandex:" : ""}${track.ownerId}_${track.id}`}`;
const snapshots = new Map<number, JsonFile<string | null>>();
function snapshotFile() {
  const id = credential?.userId ?? 0;
  if (!snapshots.has(id)) snapshots.set(id, new JsonFile(app.getPath("userData"), `queue-${id}.enc.json`));
  return snapshots.get(id)!;
}
async function resolveAudio(value: unknown, legacy = false, useCache = true): Promise<Track> {
  const requested = durableTrack(value);
  if (requested.source === "local" || useCache && preferences.preferDownloads) {
    const cached = await offline.resolve(requested);
    if (cached) return cached;
    if (requested.source === "local") throw new VkError("Локальный файл перемещён или удалён.");
  }
  const track = requested.source === "yandex" ? await yandex.resolve(requested) : await client().resolveTrack(value, legacy, preferences.legacyAudio);
  return { ...track, url: media.register(track.url), cover: track.cover ? media.register(track.cover) : undefined };
}
async function applyPreferences() {
  await session.defaultSession.setProxy(preferences.proxyMode === "custom"
    ? { mode: "fixed_servers", proxyRules: preferences.proxyAddress } : { mode: preferences.proxyMode });
  globalShortcut.unregisterAll();
  if (preferences.mediaShortcuts) for (const [command, key] of Object.entries(preferences.shortcuts))
    if (!globalShortcut.register(key, () => mainWindow?.webContents.send("music:command", command))) throw new VkError(`Сочетание ${key} занято другим приложением.`);
  if (preferences.closeToTray && !tray) {
    tray = new Tray(nativeImage.createFromPath(join(app.getAppPath(), "assets/unimusic.png")).resize({ width: 16, height: 16 }));
    tray.setToolTip("UniMusic");
    const show = () => { mainWindow?.show(); mainWindow?.focus(); };
    tray.on("click", show);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Открыть UniMusic", click: show },
      { label: "Воспроизвести / пауза", click: () => mainWindow?.webContents.send("music:command", "toggle") },
      { label: "Следующий трек", click: () => mainWindow?.webContents.send("music:command", "next") },
      { type: "separator" }, { label: "Выход", click: () => app.quit() },
    ]));
  } else if (!preferences.closeToTray) { tray?.destroy(); tray = null; }
}

app.setName("UniMusic");
if (process.env.UNIMUSIC_TEST_USER_DATA) {
  app.setPath("userData", process.env.UNIMUSIC_TEST_USER_DATA);
  app.setPath("sessionData", process.env.UNIMUSIC_TEST_USER_DATA);
}

function sessionFile(): string {
  return join(app.getPath("userData"), "session.enc");
}
async function saveCredential(value: Credential): Promise<void> {
  if (!safeStorage.isEncryptionAvailable())
    throw new VkError(
      "Windows не предоставила шифрование для хранения сессии.",
    );
  const encrypted = safeStorage.encryptString(JSON.stringify(value));
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(`${sessionFile()}.tmp`, encrypted);
  await rename(`${sessionFile()}.tmp`, sessionFile());
  credential = value;
  savedTracks = {};
  accountGeneration++;
}
async function clearCredential(): Promise<void> {
  prepared.clear();
  media.clear();
  credential = null;
  savedTracks = {};
  accountGeneration++;
  await rm(sessionFile(), { force: true });
}
async function restoreCredential(): Promise<void> {
  try {
    const value: unknown = JSON.parse(
      safeStorage.decryptString(await readFile(sessionFile())),
    );
    if (validCredential(value)) credential = value;
    else await clearCredential();
  } catch {
    // Keep an unreadable encrypted session intact for its original Windows runtime.
  }
}

function client(): VkClient {
  if (!credential || !validCredential(credential))
    throw new VkError("Войдите в VK, чтобы открыть музыку.", 5);
  return new VkClient(transport, credential);
}

async function protect<T>(action: () => Promise<T>): Promise<Result<T>> {
  const generation = accountGeneration;
  try {
    return { ok: true, data: await action() };
  } catch (error) {
    if (error instanceof VkError) {
      if (error.code === 5 && generation === accountGeneration)
        await clearCredential();
      return { ok: false, error: error.message, code: error.code };
    }
    return {
      ok: false,
      error: "Не удалось выполнить действие. Повторите попытку.",
    };
  }
}

function trustedSender(
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
): boolean {
  return (
    mainWindow !== null &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame
  );
}

async function solveCaptcha(challenge: CaptchaChallenge): Promise<string> {
  const url = trustedVkUrl(challenge.url);
  if (!url || !mainWindow) throw new VkError("Недопустимый адрес проверки VK.");
  if (captchaWindow) throw new VkError("Проверка VK уже открыта.");
  return new Promise((resolve, reject) => {
    const window = new BrowserWindow({
      parent: mainWindow!,
      modal: true,
      width: 480,
      height: 650,
      title: "Проверка VK",
      icon: join(app.getAppPath(), "assets/unimusic.ico"),
      backgroundColor: "#14131b",
      webPreferences: {
        preload: join(here, "../preload/captcha.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        partition: "unimusic-captcha",
      },
    });
    captchaWindow = window;
    let finished = false;
    const timer = setTimeout(() => {
      window.close();
    }, 5 * 60_000);
    const imagePage = join(here, "../renderer/captcha.html");
    const imagePageUrl =
      !app.isPackaged && process.env.ELECTRON_RENDERER_URL
        ? new URL("captcha.html", `${process.env.ELECTRON_RENDERER_URL}/`).href
        : pathToFileURL(imagePage).href;
    const fromWindow = (event: Electron.IpcMainEvent) =>
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      (challenge.kind === "web"
        ? Boolean(trustedVkUrl(event.senderFrame.url))
        : event.senderFrame.url.split("?")[0] === imagePageUrl);
    const onResult = (event: Electron.IpcMainEvent, data: unknown) => {
      if (
        !fromWindow(event) ||
        typeof data !== "string" ||
        data.length > 16_384
      )
        return;
      try {
        const token = object(JSON.parse(data)).token;
        if (typeof token !== "string" || !token || token.length > 8192) return;
        finished = true;
        resolve(token);
        window.close();
      } catch {
        /* The captcha may emit intermediate events. */
      }
    };
    const onClose = (event: Electron.IpcMainEvent) => {
      if (fromWindow(event)) window.close();
    };
    ipcMain.on("captcha:result", onResult);
    ipcMain.on("captcha:close", onClose);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    const guardNavigation = (event: Electron.Event, target: string) => {
      if (!trustedVkUrl(target)) event.preventDefault();
    };
    window.webContents.on("will-navigate", guardNavigation);
    window.webContents.on("will-redirect", guardNavigation);
    window.on("closed", () => {
      clearTimeout(timer);
      ipcMain.removeListener("captcha:result", onResult);
      ipcMain.removeListener("captcha:close", onClose);
      captchaWindow = null;
      if (!finished)
        reject(new VkError("Проверка VK закрыта. Можно повторить её."));
    });
    let loading: Promise<void>;
    if (challenge.kind === "image") {
      const target = new URL(imagePageUrl);
      target.searchParams.set("image", url);
      loading = window.loadURL(target.href);
    } else {
      const target = new URL(url);
      target.searchParams.set("scheme", "dark");
      // The captcha is browser content; Android's API user agent breaks its runtime detection.
      loading = window.loadURL(target.href);
    }
    void loading.catch(() => {
      if (!window.isDestroyed()) window.close();
    });
  });
}

function registerIpc(): void {
  const handle = (
    name: string,
    action: (...args: unknown[]) => Promise<unknown>,
  ) => {
    ipcMain.handle(name, (event, ...args: unknown[]) => {
      if (!trustedSender(event))
        return { ok: false, error: "Недопустимый источник запроса." };
      return protect(() => action(...args));
    });
  };
  handle("music:updates", async action => {
    if (action === "status") return updates.state;
    if (action !== "check") throw new VkError("Неизвестное действие обновления.");
    void updates.check();
    return updates.state;
  });
  handle("music:yandexSession", async () => yandexToken ? yandex.profile() : null);
  handle("music:yandexAuth", async action => {
    if (!["begin", "poll", "cancel", "open", "logout"].includes(String(action))) throw new VkError("Неизвестное действие входа.");
    const state = await yandex.auth(String(action));
    if (action === "open" && state.url) await shell.openExternal(state.url);
    return state;
  });
  handle("music:session", async () =>
    credential ? await client().profile() : null,
  );
  handle("music:auth", async (action) => {
    const result = await auth.act(action as AuthAction);
    if (result.step === "complete") result.profile = await client().profile();
    return result;
  });
  handle("music:logout", async () => {
    auth.reset();
    captchaWindow?.close();
    await clearCredential();
    await session.fromPartition("unimusic-captcha").clearStorageData();
    return null;
  });
  handle("music:tracks", async (value) => {
    const options = object(value);
    return client().tracks(
      options.offset as number | undefined,
      options.playlist,
    );
  });
  handle("music:search", async (query, start) =>
    client().search(query, start as number | undefined),
  );
  handle("music:playlists", async (start, source) =>
    source === "yandex" ? yandex.playlists(Math.max(0, Number(start) || 0)) : client().playlists(start as number | undefined),
  );
  handle("music:resolve", async (value, legacy) => {
    const key = preparedKey(durableTrack(value)); const ready = prepared.get(key); prepared.delete(key);
    return !legacy && ready && ready.expires > Date.now() ? ready.track : resolveAudio(value, legacy === true);
  });
  handle("music:prepare", async value => {
    const generation = accountGeneration; const track = durableTrack(value); const key = preparedKey(track);
    if (prepared.has(key)) return null;
    const resolved = await resolveAudio(value);
    if (generation === accountGeneration) {
      if (prepared.size >= 2) prepared.delete(prepared.keys().next().value!);
      prepared.set(key, { track: resolved, expires: Date.now() + 15_000 });
    }
    return null;
  });
  handle("music:browse", async value => {
    const request = object(value) as unknown as BrowseRequest;
    if (request.kind === "local") {
      const all = offline.state().entries.filter(e => e.state === "complete" && (request.source !== "yandex" || e.track.source === "yandex")).map(e => e.track)
        .filter(t => !request.query || `${t.title} ${t.artist} ${t.album ?? ""}`.toLowerCase().includes(String(request.query).toLowerCase()));
      const offset = Math.max(0, Math.floor(Number(request.offset) || 0));
      return { tracks: all.slice(offset, offset + 100), playlists: [], artists: [], sections: [], count: all.length };
    }
    return request.source === "yandex" ? yandex.browse(request) : client().browse(request);
  });
  handle("music:library", async value => {
    const action = value as LibraryAction;
    const generation = accountGeneration;
    const source = object(value).source === "yandex" || object(object(value).track).source === "yandex" || object(object(value).playlist).source === "yandex" ? "yandex" : "vk";
    const result = await (source === "yandex" ? yandex.library(action) : client().library(action));
    if (generation !== accountGeneration || !("track" in action) || !["add", "restore", "delete", "dislike", "undislike", "reactions"].includes(action.type)) return result;
    const original = durableTrack({ ...action.track, source });
    const liked = action.type === "add" || action.type === "restore" || action.type !== "delete" && action.type !== "dislike" && result.track?.saved === true && !result.track.disliked;
    const saved = liked ? { ...original, ...(action.type === "add" || action.type === "restore" ? result.track : undefined), saved: true, disliked: false } : null;
    savedTracks = updateSavedTracks(savedTracks, original, saved, saved ? undefined : original);
    if (!saved) await offline.cancelAutoCache(original).catch(() => {});
    else if (action.type === "add" || action.type === "restore") {
      const target = selectAutoCacheTrack(saved, preferences.autoCache, credential?.userId, savedTracks);
      if (target) void offline.enqueue([target], false, true).catch(() => {});
    }
    return result;
  });
  handle("music:unified", value => unified.run(value));
  handle("music:waveFeedback", async (track, type, seconds) => { await yandex.waveFeedback(durableTrack(track), String(type), Number(seconds)); return null; });
  handle("music:lyrics", async value => object(value).source === "yandex" ? yandex.lyrics(object(value).id) : client().lyrics(value));
  handle("music:preferences", async value => {
    if (value !== undefined) {
      const previous = preferences;
      preferences = validatePreferences(value, preferences);
      prepared.clear();
      try {
        await applyPreferences();
        await preferenceFile.write(preferences);
        await updates.setEnabled(Boolean(updatesSupported && preferences.autoUpdates));
      }
      catch (error) { preferences = previous; await applyPreferences(); throw error; }
    }
    return preferences;
  });
  handle("music:playback", async value => {
    const file = snapshotFile();
    if (value !== undefined) {
      const data = validateSnapshot(value);
      if (!safeStorage.isEncryptionAvailable()) throw new VkError("Хранилище Windows недоступно.");
      await file.write(data ? safeStorage.encryptString(JSON.stringify(data)).toString("base64") : null);
      return null;
    }
    const encrypted = await file.read(null);
    if (!encrypted) return null;
    try { return validateSnapshot(JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, "base64")))); }
    catch { return null; }
  });
  handle("music:offline", async value => {
    const action = object(value);
    if (action.type === "import") {
      const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openFile", "multiSelections"], filters: [{ name: "Аудио", extensions: ["mp3", "flac", "m4a", "aac", "wav", "ogg"] }] });
      if (!result.canceled) await offline.import(result.filePaths);
    } else if (action.type === "directory") {
      const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory", "createDirectory"], defaultPath: preferences.downloadDirectory });
      if (!result.canceled && result.filePaths[0]) {
        preferences.downloadDirectory = result.filePaths[0]; await preferenceFile.write(preferences);
      }
    } else if (action.type === "download") await offline.enqueue(action.tracks as Track[], action.replace === true);
    else if (action.type === "cancel") await offline.cancel(String(action.id));
    else if (action.type === "remove") await offline.remove(String(action.id));
    else if (action.type === "clear") await offline.clear();
    else if (action.type === "reveal") shell.showItemInFolder(offline.path(String(action.id)));
    else if (action.type === "upload") {
      const vk = client();
      await offline.upload(String(action.id), async (path, track) => {
        if ((await stat(path)).size > 200_000_000) throw new VkError("Размер файла превышает 200 МБ.");
        const url = await vk.uploadServer();
        const body = new FormData(); body.append("file", new Blob([await readFile(path)]), "audio.mp3");
        const result = await net.fetch(url, { method: "POST", body, redirect: "error", signal: AbortSignal.timeout(180_000) });
        if (!result.ok) throw new VkError("VK не принял файл.");
        await vk.saveUpload(await result.json(), track.artist, track.title);
      });
    } else if (action.type !== "list") throw new VkError("Неизвестное действие с файлами.");
    return offline.state();
  });
  handle("music:trackInfo", async value => {
    const track = durableTrack(value); const local = await offline.info(track);
    if (local) return local;
    const resolved = await resolveAudio(track);
    const response = await media.handle(new Request(resolved.url, { method: "HEAD" }));
    const size = Number(response.headers.get("content-length")) || undefined;
    const hls = resolved.url.includes(".m3u8");
    return { format: hls ? "HLS / AAC" : response.headers.get("content-type") ?? "Audio", size: hls ? undefined : size,
      bitrate: !hls && size && track.duration ? size * 8 / track.duration : undefined, source: track.source === "yandex" ? "Яндекс Музыка" : "VK" };
  });
  handle("music:copyTrack", async (value, kind) => {
    const track = durableTrack(value);
    if (!["text", "link", "attachment"].includes(String(kind))) throw new VkError("Неизвестный формат.");
    if (track.source === "yandex" && kind === "link") { clipboard.writeText(`https://music.yandex.ru/track/${track.id}`); return null; }
    if (kind !== "text" && track.source !== "vk") throw new VkError("У локального файла нет ссылки VK.");
    clipboard.writeText(kind === "link" ? `https://vk.com/audio${track.ownerId}_${track.id}` : kind === "attachment" ? `audio${track.ownerId}_${track.id}` : `${track.artist} — ${track.title}`);
    return null;
  });
  handle("music:copyText", async value => {
    if (typeof value !== "string" || value.length > 100_000) throw new VkError("Текст слишком длинный.");
    clipboard.writeText(value); return null;
  });
  handle("music:played", async value => {
    const track = durableTrack(value);
    if (track.source === "local" || track.restricted) return null;
    const target = selectAutoCacheTrack(track, preferences.autoCache, credential?.userId, savedTracks);
    if (target) void offline.enqueue([target], false, true).catch(() => {});
    if (track.source !== "yandex" && (preferences.broadcast || preferences.listeningEvents)) await client().played(value, preferences.listeningEvents, preferences.broadcast);
    return null;
  });
  handle("music:diagnostics", async () => {
    try {
      const data = object(JSON.parse(await readFile(join(app.getPath("userData"), "playback-diagnostics.json"), "utf8")));
      return JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key, value]) => ["at", "source", "code", "type", "detail", "status"].includes(key) && (typeof value === "number" || typeof value === "string" && /^[\w:.\-TZ ]{1,100}$/.test(value)))), null, 2);
    } catch { return "Ошибки воспроизведения не записаны."; }
  });
  handle("music:playbackError", async (value) => {
    const data = object(value);
    if (typeof data.type !== "string" || typeof data.detail !== "string" ||
      !/^[a-zA-Z]{1,64}$/.test(data.type) || !/^[a-zA-Z]{1,64}$/.test(data.detail)) return null;
    const status = Number.isInteger(data.status) && Number(data.status) >= 0 && Number(data.status) <= 599 ? data.status : 0;
    await writeFile(join(app.getPath("userData"), "playback-diagnostics.json"), JSON.stringify({ at: new Date().toISOString(), source: "hls", type: data.type, detail: data.detail, status }));
    return null;
  });
  ipcMain.on("music:window", (event, action: unknown) => {
    if (!trustedSender(event) || !mainWindow) return;
    if (action === "minimize") mainWindow.minimize();
    if (action === "maximize")
      mainWindow.isMaximized()
        ? mainWindow.unmaximize()
        : mainWindow.maximize();
    if (action === "close") mainWindow.close();
  });
}

function createWindow(): void {
  const mica = process.platform === "win32" && Number(release().split(".")[2]) >= 22621;
  nativeTheme.themeSource = "dark";
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 920,
    minHeight: 680,
    title: "UniMusic",
    icon: join(app.getAppPath(), "assets/unimusic.ico"),
    backgroundColor: mica ? "#00000000" : "#141413",
    backgroundMaterial: mica ? "mica" : "none",
    frame: false,
    show: false,
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", event => {
    if (preferences.closeToTray && !quitting) { event.preventDefault(); mainWindow?.hide(); }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(here, "../renderer/index.html"));
}

void app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  protocol.handle(MEDIA_SCHEME, request => media.handle(request));
  await mkdir(app.getPath("userData"), { recursive: true });
  unified = new UnifiedStore(app.getPath("userData"));
  preferenceFile = new JsonFile(app.getPath("userData"), "preferences.json");
  const defaults = defaultPreferences(join(app.getPath("music"), "UniMusic"));
  const saved = await preferenceFile.read(defaults);
  try { preferences = validatePreferences(saved, { ...defaults, downloadDirectory: typeof saved.downloadDirectory === "string" ? saved.downloadDirectory : defaults.downloadDirectory }); }
  catch { preferences = defaults; }
  const portablePath = process.env.PORTABLE_EXECUTABLE_FILE;
  updates = new AppUpdates({
    version: app.getVersion(), directory: join(app.getPath("userData"), "updates", "portable"),
    arch: process.arch, enabled: Boolean(updatesSupported && preferences.autoUpdates), portablePath,
    installed: updatesSupported && !portablePath ? electronUpdater.autoUpdater : undefined,
    fetcher: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
    onChange: state => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("music:update-state", state); },
  });
  if (await updates.resumePortable() && await launchPortableUpdate(true)) { app.quit(); return; }
  offline = new OfflineStore(app.getPath("userData"), media, () => preferences.downloadDirectory, track => resolveAudio(track, false, false), async track => {
    const cover = await yandex.artwork(track.id); return cover ? media.register(cover) : undefined;
  });
  await offline.init();
  try { await applyPreferences(); } catch { preferences.mediaShortcuts = false; await applyPreferences(); }
  let deviceId: string;
  const deviceFile = join(app.getPath("userData"), "device-id");
  try {
    deviceId = await readFile(deviceFile, "utf8");
    if (!/^[a-f0-9]{16}$/.test(deviceId)) throw new Error("Invalid device ID");
  } catch {
    deviceId = randomBytes(8).toString("hex");
    await writeFile(deviceFile, deviceId);
  }
  await restoreCredential();
  const yandexFile = join(app.getPath("userData"), "yandex-session.enc");
  try { const saved = safeStorage.decryptString(await readFile(yandexFile)); if (saved.length > 10 && saved.length < 8192) yandexToken = saved; } catch { /* Preserve unreadable Windows sessions. */ }
  yandex = new YandexMusic((input, init) => net.fetch(input instanceof URL ? input.href : input, init), () => yandexToken, async token => {
    if (token) {
      if (!safeStorage.isEncryptionAvailable()) throw new VkError("Хранилище Windows недоступно.");
      await writeFile(`${yandexFile}.tmp`, safeStorage.encryptString(token)); await rename(`${yandexFile}.tmp`, yandexFile);
    } else await rm(yandexFile, { force: true });
    yandexToken = token; savedTracks = {}; prepared.clear(); accountGeneration++;
  });
  transport = withCaptcha(createTransport((input, init) =>
    net.fetch(input instanceof URL ? input.href : input, init), deviceId), solveCaptcha);
  auth = new DirectAuth(transport, deviceId, saveCredential);
  registerIpc();
  createWindow();
  mainWindow!.webContents.once("did-finish-load", () => { void updates.check(); });
});
app.on("window-all-closed", () => {
  auth?.reset();
  app.quit();
});
app.on("before-quit", () => {
  quitting = true; globalShortcut.unregisterAll();
  if (updates?.hasPendingPortable) void launchPortableUpdate();
  updates?.stop();
});
