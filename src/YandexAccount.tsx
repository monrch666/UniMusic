import { useEffect, useState } from "react";
import type { MusicApi, YandexAccount as Account, YandexAuthState } from "./shared";

export default function YandexAccount({ api, profile, onProfile }: { api?: MusicApi; profile: Account | null; onProfile: (profile: Account | null) => void }) {
  const [state, setState] = useState<YandexAuthState>({ step: "idle" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(action: "begin" | "cancel" | "open" | "logout") {
    if (!api) return;
    setBusy(true); setError("");
    try { const result = await api.yandexAuth(action);
      if (!result.ok) { setError(result.error); return; }
      setState(result.data);
      if (action === "logout") onProfile(null);
    } catch { setError("Не удалось подключиться к Яндексу."); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (state.step !== "waiting" || !api) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api.yandexAuth("poll");
        if (!active) return;
        if (!result.ok) { setError(result.error); setState({ step: "idle" }); return; }
        if (result.data.step === "complete") { onProfile(result.data.profile!); setState(result.data); return; }
        if (result.data.step === "idle") { setState(result.data); return; }
        timer = setTimeout(poll, (result.data.interval ?? 5) * 1000);
      } catch { if (active) { setError("Не удалось проверить вход. Подключите аккаунт ещё раз."); setState({ step: "idle" }); } }
    };
    timer = setTimeout(poll, (state.interval ?? 5) * 1000);
    return () => { active = false; clearTimeout(timer); void api.yandexAuth("cancel"); };
  }, [state.step, api]);
  return <section className="settings-card yandex-account" aria-label="Аккаунт Яндекс Музыки">
    <div className="service-account-heading"><span className="service-symbol service-symbol-yandex">Я</span><div><h2>{profile ? profile.firstName : "Аккаунт Яндекс Музыки"}</h2><p>{profile ? "Аккаунт подключён" : "Подключите аккаунт, чтобы открыть любимые треки и плейлисты."}</p></div></div>
    {profile && <div className="service-subscription"><span>Яндекс Плюс</span><strong className={profile.plus ? "subscription-active" : ""}>{profile.plus ? "Подключён" : "Не подключён"}</strong></div>}
    {error && <p role="alert">{error}</p>}
    {state.step === "waiting" ? <div className="yandex-code"><p>Введите этот код на странице Яндекса:</p><strong>{state.code}</strong><div className="settings-actions">
      <button className="button primary" disabled={busy} onClick={() => void act("open")}>Открыть страницу Яндекса</button>
      <button className="text-button" disabled={busy} onClick={() => void act("cancel")}>Отмена</button>
    </div><p role="status">Ждём подтверждения входа…</p></div> : <div className="settings-actions">
      <button className="button secondary" disabled={busy || !api} onClick={() => void act("begin")}>{profile ? "Подключить другой аккаунт" : "Подключить Яндекс Музыку"}</button>
      {profile && <button className="text-button" disabled={busy} onClick={() => void act("logout")}>Отключить Яндекс Музыку</button>}
    </div>}
    <p className="service-note">«Моя волна» запускается на главной. Автокэш сохраняет только лайкнутые песни; параметры звука и файлов находятся в разделе UniMusic.</p>
  </section>;
}
