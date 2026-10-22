import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AppUpdater, UpdateCheckResult } from "electron-updater";
import type { UpdateState } from "../src/shared";

export const UPDATE_REPOSITORY = "https://github.com/monrch666/UniMusic";
const RELEASE_API = "https://api.github.com/repos/monrch666/UniMusic/releases/latest";
const MAX_DOWNLOAD = 1024 * 1024 * 1024;
type InstalledUpdater = Pick<AppUpdater, "on" | "checkForUpdates" | "autoDownload" | "autoInstallOnAppQuit" | "autoRunAppAfterInstall" | "allowPrerelease" | "allowDowngrade" | "logger">;
export interface UpdateAsset { version: string; name: string; url: string; size: number; sha256: string }
interface PendingUpdate { version: string; target: string; file: string; sha256: string }

export function versionParts(value: unknown): number[] | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
export function newerVersion(candidate: string, current: string): boolean {
  const a = versionParts(candidate), b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function releaseAsset(value: unknown, current: string, kind: "Setup" | "Portable", arch: string): UpdateAsset | null {
  const release = value as Record<string, unknown> | null;
  if (!release || typeof release !== "object" || release.draft !== false || release.prerelease !== false) return null;
  const tag = release.tag_name;
  if (typeof tag !== "string") return null;
  const version = tag.replace(/^v/, "");
  if (!newerVersion(version, current)) return null;
  if (!["x64", "arm64", "ia32"].includes(arch)) throw new Error("Архитектура обновления не поддерживается.");
  const name = `UniMusic-${kind}-${version}-${arch}.exe`;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find(item => item?.name === name);
  const url = `${UPDATE_REPOSITORY}/releases/download/${tag}/${name}`;
  if (!asset || asset.state !== "uploaded" || asset.browser_download_url !== url ||
    !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_DOWNLOAD ||
    typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest))
    throw new Error("Обновление ещё не опубликовано полностью. Проверка повторится при следующем запуске.");
  if (kind === "Setup" && !assets.some(item => item?.name === "latest.yml" && item.state === "uploaded"))
    throw new Error("В релизе отсутствует файл обновления latest.yml.");
  return { version, name, url, size: asset.size, sha256: asset.digest.slice(7) };
}
export async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export class AppUpdates {
  state: UpdateState;
  private checking?: Promise<UpdateState>;
  private stopped = false;
  private controller?: AbortController;
  private pending?: PendingUpdate;
  private cancellation?: UpdateCheckResult["cancellationToken"];
  private generation = 0;
  readonly manifest: string;
  readonly helper: string;
  constructor(private options: {
    version: string; directory: string; arch: string; enabled: boolean;
    portablePath?: string; installed?: InstalledUpdater; fetcher: typeof fetch;
    onChange: (state: UpdateState) => void;
  }) {
    this.state = { currentVersion: options.version, status: options.enabled ? "idle" : "disabled" };
    this.manifest = join(options.directory, "pending.json");
    this.helper = join(options.directory, "apply.ps1");
    const updater = options.installed;
    if (updater && !options.portablePath) {
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = options.enabled;
      updater.autoRunAppAfterInstall = false;
      updater.allowPrerelease = false;
      updater.allowDowngrade = false;
      updater.logger = null;
      updater.on("download-progress", info => this.change({ status: "downloading", progress: Math.floor(info.percent) }));
      updater.on("update-downloaded", info => this.change({ status: "ready", version: info.version, progress: 100 }));
      updater.on("error", () => this.change({ status: "error", error: "Не удалось загрузить обновление. Текущая версия продолжит работать." }));
    }
  }
  private change(patch: Partial<UpdateState>) {
    if (this.stopped || !this.options.enabled && patch.status !== "disabled") return;
    this.state = { ...this.state, ...patch };
    this.options.onChange({ ...this.state });
  }
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.options.enabled) return;
    this.options.enabled = enabled;
    this.generation++;
    if (this.options.installed) this.options.installed.autoInstallOnAppQuit = enabled;
    if (!enabled) {
      this.controller?.abort(); this.cancellation?.cancel(); this.pending = undefined;
      this.change({ status: "disabled", error: undefined, progress: undefined, version: undefined });
      await rm(this.manifest, { force: true }).catch(() => {});
    } else {
      await this.checking;
      this.change({ status: "idle", error: undefined });
      void this.check();
    }
  }
  check(): Promise<UpdateState> {
    if (this.state.status === "disabled" || this.state.status === "ready") return Promise.resolve(this.state);
    if (this.checking) return this.checking;
    this.checking = this.run().finally(() => { this.checking = undefined; });
    return this.checking;
  }
  private async run(): Promise<UpdateState> {
    const generation = this.generation;
    this.change({ status: "checking", error: undefined, version: undefined, progress: undefined });
    try {
      const response = await this.options.fetcher(RELEASE_API, {
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15000),
      });
      if (generation !== this.generation || this.stopped) return this.state;
      if (response.status === 404) { this.change({ status: "current" }); return this.state; }
      if (!response.ok) throw new Error("Проверка обновлений временно недоступна. Повторите позже.");
      const asset = releaseAsset(await response.json(), this.options.version, this.options.portablePath ? "Portable" : "Setup", this.options.arch);
      if (generation !== this.generation || this.stopped) return this.state;
      if (!asset) { this.change({ status: "current" }); return this.state; }
      this.change({ status: "downloading", version: asset.version, progress: 0 });
      if (this.options.portablePath) await this.downloadPortable(asset, generation);
      else {
        if (!this.options.installed) throw new Error("Обновление доступно только в Windows-приложении.");
        const result = await this.options.installed.checkForUpdates();
        this.cancellation = result?.cancellationToken;
        if (generation !== this.generation || this.stopped) { this.cancellation?.cancel(); await result?.downloadPromise?.catch(() => {}); return this.state; }
        if (result?.downloadPromise) await result.downloadPromise;
        if (this.state.status === "downloading") this.change({ status: "current", version: undefined, progress: undefined });
      }
    } catch (error) {
      if (generation === this.generation) this.change({ status: "error", error: error instanceof Error && !/https?:|[\\/]|abort|fetch/i.test(error.message)
        ? error.message : "Не удалось загрузить обновление. Проверка повторится при следующем запуске." });
    }
    return this.state;
  }
  private async downloadPortable(asset: UpdateAsset, generation: number) {
    await mkdir(this.options.directory, { recursive: true });
    const file = join(this.options.directory, asset.name), part = `${file}.part`;
    let cached = false;
    try { cached = (await stat(file)).size === asset.size && await fileDigest(file) === asset.sha256; } catch { /* Download a fresh copy. */ }
    if (!cached) {
      const controller = new AbortController(); this.controller = controller;
      let idle = setTimeout(() => controller.abort(), 30000);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const response = await this.options.fetcher(asset.url, { credentials: "omit", signal: controller.signal });
        if (!response.ok || !response.body || (response.headers.has("content-length") && Number(response.headers.get("content-length")) !== asset.size))
          throw new Error("Не удалось скачать файл обновления.");
        handle = await open(part, "w");
        const reader = response.body.getReader(), hash = createHash("sha256");
        let bytes = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          clearTimeout(idle); idle = setTimeout(() => controller.abort(), 30000);
          bytes += value.byteLength;
          if (bytes > asset.size) throw new Error("Размер файла обновления не совпадает.");
          hash.update(value);
          await handle.writeFile(value);
          const progress = Math.floor(bytes / asset.size * 100);
          if (progress !== this.state.progress) this.change({ progress });
        }
        if (bytes !== asset.size || hash.digest("hex") !== asset.sha256) throw new Error("Контрольная сумма обновления не совпадает.");
        await handle.sync(); await handle.close(); handle = undefined;
        await rename(part, file);
      } finally {
        clearTimeout(idle); controller.abort(); this.controller = undefined;
        await handle?.close(); await rm(part, { force: true });
      }
    }
    if (!this.options.enabled || this.stopped || generation !== this.generation) return;
    const pending = { version: asset.version, target: resolve(this.options.portablePath!), file, sha256: asset.sha256 };
    await writeFile(this.helper, PORTABLE_UPDATE_SCRIPT, "utf8");
    await rm(join(this.options.directory, "failed"), { force: true });
    await writeFile(`${this.manifest}.tmp`, JSON.stringify(pending), "utf8");
    if (!this.options.enabled || this.stopped || generation !== this.generation) return;
    await rename(`${this.manifest}.tmp`, this.manifest);
    if (!this.options.enabled || this.stopped || generation !== this.generation) { await rm(this.manifest, { force: true }); return; }
    this.pending = pending;
    this.change({ status: "ready", progress: 100 });
  }
  async resumePortable(): Promise<boolean> {
    if (!this.options.portablePath || !this.options.enabled) return false;
    try {
      try { await stat(join(this.options.directory, "failed")); return false; } catch { /* No previous installation failure. */ }
      const saved: PendingUpdate = JSON.parse(await readFile(this.manifest, "utf8"));
      if (!versionParts(saved.version) || saved.target !== resolve(this.options.portablePath) ||
        saved.file !== join(this.options.directory, `UniMusic-Portable-${saved.version}-${this.options.arch}.exe`) ||
        !/^[a-f0-9]{64}$/.test(saved.sha256)) return false;
      if (!newerVersion(saved.version, this.options.version)) {
        await rm(saved.file, { force: true }); await rm(this.manifest, { force: true }); await rm(this.helper, { force: true });
        return false;
      }
      if (await fileDigest(saved.file) !== saved.sha256) return false;
      await writeFile(this.helper, PORTABLE_UPDATE_SCRIPT, "utf8");
      this.pending = saved;
      return true;
    } catch { return false; }
  }
  get hasPendingPortable() { return this.options.enabled && Boolean(this.pending); }
  stop() { this.stopped = true; this.controller?.abort(); }
}

// The helper runs outside the Portable launcher and waits until its EXE is unlocked.
export const PORTABLE_UPDATE_SCRIPT = String.raw`param([string]$Manifest, [int]$ParentProcessId, [string]$PortableFile, [switch]$Restart)
$ErrorActionPreference = 'Stop'
$lock = $null
$failed = Join-Path ([IO.Path]::GetDirectoryName($Manifest)) 'failed'
function Start-UpdatedApp {
  Get-ChildItem Env: | Where-Object { $_.Name -like 'PORTABLE_EXECUTABLE_*' } | Remove-Item
  Start-Process -FilePath $PortableFile -WorkingDirectory ([IO.Path]::GetDirectoryName($PortableFile)) -WindowStyle Hidden
}
try {
  Wait-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try { $lock = [IO.File]::Open($Manifest + '.lock', 'OpenOrCreate', 'ReadWrite', 'None'); break }
    catch { Start-Sleep -Milliseconds 500 }
  }
  if ($null -eq $lock) { throw 'Update is busy' }
  if (-not (Test-Path -LiteralPath $Manifest)) { if ($Restart) { Start-UpdatedApp }; exit 0 }
  $update = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  $target = [IO.Path]::GetFullPath($update.target)
  $source = [IO.Path]::GetFullPath($update.file)
  if ($target -ne [IO.Path]::GetFullPath($PortableFile) -or [IO.Path]::GetExtension($target) -ne '.exe' -or $source -eq $target) { throw 'Invalid update target' }
  if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $update.sha256) { throw 'Invalid update checksum' }
  $replacement = $target + '.unimusic-new'
  $backup = $target + '.unimusic-old'
  $installed = $false
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try {
      Copy-Item -LiteralPath $source -Destination $replacement -Force
      [IO.File]::Replace($replacement, $target, $backup)
      $installed = $true
      break
    } catch { Start-Sleep -Milliseconds 500 }
  }
  if (-not $installed) { Remove-Item -LiteralPath $replacement -Force -ErrorAction SilentlyContinue; throw 'Update file is locked' }
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $update.sha256) {
    [IO.File]::Replace($backup, $target, $null)
    throw 'Invalid installed checksum'
  }
  Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Manifest -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $failed -Force -ErrorAction SilentlyContinue
  if ($Restart) { Start-UpdatedApp }
} catch {
  Set-Content -LiteralPath $failed -Value 'Update could not be installed' -ErrorAction SilentlyContinue
  if ($Restart) { Start-UpdatedApp }
} finally { if ($null -ne $lock) { $lock.Dispose() } }
`;
