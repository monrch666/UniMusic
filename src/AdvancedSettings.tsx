import { useEffect, useRef, useState } from "react";
import type { AppPreferences, MusicApi } from "./shared";
import type { SettingsSection } from "./SettingsPage";

export default function AdvancedSettings({ section, api, onError, onEqualizer }: {
  section: SettingsSection; api?: MusicApi; onError: (message: string, code?: number) => void; onEqualizer: (values: number[]) => void;
}) {
  const [preferences, setPreferences] = useState<AppPreferences | null>(null);
  const [diagnostics, setDiagnostics] = useState("");
  const [saving, setSaving] = useState(false);
  const equalizer = useRef(onEqualizer); equalizer.current = onEqualizer;
  useEffect(() => {
    let active = true;
    void api?.preferences().then(r => { if (!active) return; if (r.ok) { setPreferences(r.data); equalizer.current(r.data.equalizer); } else onError(r.error); }).catch(() => { if (active) onError("Не удалось загрузить настройки."); });
    return () => { active = false; };
  }, [api]);
  async function save(value: Partial<AppPreferences>) {
    if (!api) return;
    setSaving(true);
    try { const r = await api.preferences(value); if (r.ok) { setPreferences(r.data); onEqualizer(r.data.equalizer); } else onError(r.error, r.code); }
    catch { onError("Не удалось сохранить настройки."); }
    finally { setSaving(false); }
  }
  if (!preferences || section === "yandex") return null;
  const toggle = (key: "autoCache" | "preferDownloads" | "closeToTray" | "mediaShortcuts" | "legacyAudio" | "broadcast" | "listeningEvents", label: string, hint: string) =>
    <label className="setting-toggle setting-row" key={key}><span><strong>{label}</strong><small id={`pref-${key}-hint`}>{hint}</small></span><input type="checkbox" aria-label={label} aria-describedby={`pref-${key}-hint`} disabled={saving} checked={preferences[key]} onChange={e => void save({ [key]: e.target.checked })} /></label>;
  if (section === "vk") return <section className="settings-card" aria-labelledby="vk-options-title">
    <div className="settings-card-heading"><div><h2 id="vk-options-title">Воспроизведение и приватность</h2><p>Эти параметры применяются только к VK.</p></div></div>
    {toggle("legacyAudio", "Совместимый режим аудио", "Используйте, если отдельные треки не запускаются или обрываются.")}
    {toggle("broadcast", "Музыка в статусе VK", "Показывать текущую песню на вашей странице.")}
    {toggle("listeningEvents", "Передавать события прослушивания", "Сообщать VK о воспроизведении песен в UniMusic.")}
  </section>;
  return <div className="settings-preference-grid">
    <section className="settings-card settings-sound" aria-labelledby="sound-settings-title">
      <div className="settings-card-heading"><div><h2 id="sound-settings-title">Звук</h2><p>Эквалайзер для всех музыкальных сервисов</p></div><button className="text-button" disabled={saving} onClick={() => void save({ equalizer: [0, 0, 0, 0, 0] })}>Сбросить эквалайзер</button></div>
      <fieldset className="equalizer" disabled={saving} aria-label="Эквалайзер">
        {["60 Гц", "230 Гц", "910 Гц", "3,6 кГц", "14 кГц"].map((label, i) => <label key={label}>{label}<input type="range" min={-12} max={12} step={1} value={preferences.equalizer[i]} onChange={e => {
          const values = [...preferences.equalizer]; values[i] = Number(e.target.value); setPreferences({ ...preferences, equalizer: values }); onEqualizer(values);
        }} onPointerUp={() => void save({ equalizer: preferences.equalizer })} onKeyUp={() => void save({ equalizer: preferences.equalizer })} /><output>{preferences.equalizer[i] > 0 ? "+" : ""}{preferences.equalizer[i]} дБ</output></label>)}
      </fieldset>
    </section>
    <section className="settings-card" aria-labelledby="files-settings-title">
      <div className="settings-card-heading"><div><h2 id="files-settings-title">Файлы и автокэш</h2><p>Сохранённая музыка доступна в разделе «На устройстве».</p></div></div>
      {toggle("autoCache", "Автоматически скачивать только лайкнутые песни", "При нажатии на сердце или запуске любимой записи. «Моя волна» без лайка не скачивается.")}
      {toggle("preferDownloads", "Предпочитать скачанные файлы", "Воспроизводить сохранённую копию, когда она есть на устройстве.")}
      <div className="settings-folder"><span>Папка с музыкой</span><p className="settings-path">{preferences.downloadDirectory}</p></div>
      <div className="settings-actions"><button className="button secondary" disabled={saving} onClick={async () => {
        try { const r = await api!.offline({ type: "directory" }); if (r.ok) setPreferences(p => ({ ...p!, downloadDirectory: r.data.directory })); else onError(r.error); }
        catch { onError("Не удалось выбрать папку."); }
      }}>Изменить папку</button><button className="text-button danger-action" onClick={async () => {
        if (!window.confirm("Удалить скачанные файлы? Импортированные оригиналы останутся на месте.")) return;
        try { const r = await api!.offline({ type: "clear" }); if (!r.ok) onError(r.error); }
        catch { onError("Не удалось удалить скачанные файлы."); }
      }}>Удалить скачанное</button></div>
      <p className="settings-hint">Снятие лайка отменяет автоматическую загрузку. Готовые файлы остаются. Отключение автокэша запрещает новые задания.</p>
    </section>
    <section className="settings-card" aria-labelledby="windows-settings-title">
      <div className="settings-card-heading"><div><h2 id="windows-settings-title">Windows и управление</h2><p>Поведение окна и управление с клавиатуры</p></div></div>
      {toggle("closeToTray", "Продолжать музыку в трее при закрытии окна", "Кнопка закрытия скроет UniMusic. Выход — через значок в трее.")}
      {toggle("mediaShortcuts", "Глобальные сочетания клавиш", "Управлять музыкой, даже когда открыто другое приложение.")}
      <form className="edit-music-form shortcut-form" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); void save({ shortcuts: { toggle: String(form.get("toggle")), next: String(form.get("next")), previous: String(form.get("previous")) } }); }}>
        <fieldset disabled={saving || !preferences.mediaShortcuts}>
          {([["toggle", "Пауза / воспроизведение"], ["next", "Следующий трек"], ["previous", "Предыдущий трек"]] as const).map(([key, label]) => <label key={key}>{label}<input name={key} defaultValue={preferences.shortcuts[key]} maxLength={60} /></label>)}
          <button className="text-button">Сохранить сочетания</button>
        </fieldset>
      </form>
    </section>
    <details className="settings-card settings-disclosure"><summary>Сеть<span>Подключение и прокси</span></summary><form className="edit-music-form" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void save({ proxyMode: String(data.get("mode")) as AppPreferences["proxyMode"], proxyAddress: String(data.get("proxy")) }); }}>
      <label>Подключение<select name="mode" defaultValue={preferences.proxyMode}><option value="system">Настройки Windows</option><option value="direct">Прямое подключение</option><option value="custom">Свой прокси</option></select></label>
      <label>Адрес прокси<input name="proxy" placeholder="http://127.0.0.1:8080" defaultValue={preferences.proxyAddress} /></label><button className="button secondary" disabled={saving}>Сохранить сеть</button>
    </form></details>
    <details className="settings-card settings-disclosure"><summary>Диагностика<span>Помощь при ошибках воспроизведения</span></summary><button className="text-button" onClick={async () => {
      try { const r = await api!.diagnostics(); if (r.ok) setDiagnostics(r.data); else onError(r.error); }
      catch { onError("Не удалось открыть диагностику."); }
    }}>Последняя ошибка воспроизведения</button>{diagnostics && <pre className="lyrics-text">{diagnostics}</pre>}</details>
  </div>;
}
