import { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide";
import { Icon } from "./ui";
import type { MusicApi, UpdateState } from "./shared";
import { version } from "../package.json";

export default function UpdateSettings({ api }: { api?: MusicApi }) {
  const [state, setState] = useState<UpdateState>({ status: "disabled", currentVersion: version });
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!api) return;
    let active = true;
    const unsubscribe = api.onUpdate(value => { if (active) setState(value); });
    void Promise.all([api.updates("status"), api.preferences()]).then(([update, preferences]) => {
      if (!active) return;
      if (update.ok) setState(update.data);
      if (preferences.ok) { setEnabled(preferences.data.autoUpdates); setLoaded(true); }
      else setError(preferences.error);
    }).catch(() => { if (active) setError("Не удалось загрузить настройки обновления."); });
    return () => { active = false; unsubscribe(); };
  }, [api]);
  const busy = state.status === "checking" || state.status === "downloading";
  const messages: Record<UpdateState["status"], string> = {
    idle: "Проверяем новые версии при запуске",
    checking: "Проверяем обновления…",
    downloading: `Загружаем версию ${state.version ?? ""} · ${state.progress ?? 0}%`,
    ready: `Версия ${state.version} готова. Установится после полного выхода из приложения.`,
    current: "Установлена последняя версия",
    error: state.error ?? "Не удалось проверить обновления. Попробуйте позже.",
    disabled: enabled ? "Проверка доступна в установленной или Portable-версии для Windows" : "Автоматические обновления отключены",
  };
  async function toggle(value: boolean) {
    if (!api) return;
    setSaving(true); setError("");
    try {
      const result = await api.preferences({ autoUpdates: value });
      if (result.ok) setEnabled(result.data.autoUpdates); else setError(result.error);
    } catch { setError("Не удалось сохранить настройку."); }
    finally { setSaving(false); }
  }
  return <section className="settings-card update-settings" aria-labelledby="update-settings-title">
    <div className="settings-card-heading"><div><h2 id="update-settings-title">Обновления</h2><p>UniMusic {state.currentVersion}</p></div>
      <button className="button secondary" disabled={!api || !loaded || !enabled || saving || busy || state.status === "ready" || state.status === "disabled"} onClick={async () => {
        setError("");
        try { const result = await api!.updates("check"); if (result.ok) setState(result.data); else setError(result.error); }
        catch { setError("Не удалось проверить обновления."); }
      }}><Icon icon={busy ? LoaderCircle : RefreshCw} size={16} />{busy ? state.status === "checking" ? "Проверяем…" : "Загрузка…" : "Проверить обновления"}</button>
    </div>
    <label className="setting-row"><span><strong>Автоматические обновления</strong><small id="auto-updates-hint">Новые версии скачиваются с GitHub в фоне. Обновление установится после полного выхода, без прерывания музыки.</small></span>
      <input type="checkbox" aria-label="Автоматические обновления" aria-describedby="auto-updates-hint" checked={enabled} disabled={!api || !loaded || saving} onChange={event => void toggle(event.target.checked)} />
    </label>
    <p className="update-status" role="status">{error || messages[state.status]}</p>
    {state.status === "downloading" && <progress max={100} value={state.progress ?? 0} aria-label="Загрузка обновления" />}
  </section>;
}
