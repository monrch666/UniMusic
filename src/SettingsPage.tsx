import type { ReactNode } from "react";
import { Disc3, Settings2 } from "lucide";
import type { MusicApi, Profile, YandexAccount as Account } from "./shared";
import { Cover, Icon } from "./ui";
import AdvancedSettings from "./AdvancedSettings";
import YandexAccount from "./YandexAccount";

export type SettingsSection = "unimusic" | "yandex" | "vk";

export default function SettingsPage({ section, onSection, children, api, profile, yandexProfile, onYandexProfile, onLogin, onLogout, onError, onEqualizer }: {
  section: SettingsSection; onSection: (section: SettingsSection) => void; children: ReactNode;
  api?: MusicApi; profile: Profile | null; yandexProfile: Account | null;
  onYandexProfile: (profile: Account | null) => void; onLogin: () => void; onLogout: () => void;
  onError: (message: string, code?: number) => void; onEqualizer: (values: number[]) => void;
}) {
  return <section className="settings-page" aria-labelledby="settings-title">
    <header className="settings-heading"><h1 id="settings-title">Настройки</h1><p>Приложение и музыкальные сервисы</p></header>
    <nav className="settings-sections" aria-label="Разделы настроек">
      {([['unimusic', 'UniMusic'], ['yandex', 'Яндекс Музыка'], ['vk', 'VK Музыка']] as const).map(([value, title]) =>
        <button key={value} aria-current={section === value ? "page" : undefined} onClick={() => onSection(value)}><Icon icon={value === "unimusic" ? Settings2 : Disc3} size={18} />{title}</button>)}
    </nav>
    <div className="settings-section" key={section}>
      {section === "unimusic" && children}
      {section === "yandex" && <YandexAccount api={api} profile={yandexProfile} onProfile={onYandexProfile} />}
      {section === "vk" && <section className="settings-card service-account" aria-labelledby="vk-account-title">
        <div className="service-account-heading">
          {profile ? <Cover className="service-avatar" src={profile.avatar} title={profile.firstName} /> : <span className="service-symbol">VK</span>}
          <div><h2 id="vk-account-title">{profile ? `${profile.firstName} ${profile.lastName}`.trim() : "Аккаунт VK"}</h2><p>{profile ? "Аккаунт подключён" : "Войдите, чтобы слушать свою музыку и плейлисты."}</p></div>
        </div>
        <button className="button secondary" disabled={!api} onClick={profile ? onLogout : onLogin}>{profile ? "Отключить VK" : "Подключить VK"}</button>
      </section>}
      <AdvancedSettings section={section} api={api} onError={onError} onEqualizer={onEqualizer} />
    </div>
  </section>;
}
