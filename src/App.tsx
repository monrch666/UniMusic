import { validOrbSettings } from "./orbSettings";
import { validLightSettings } from "./lightSettings";
import UnifiedBrowser from "./UnifiedBrowser";
import SettingsPage, { type SettingsSection } from "./SettingsPage";
import { updateSavedTracks } from "./libraryState";
import MusicBrowser from "./MusicBrowser";
import { Icon, IconButton, Cover } from "./ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Captions,
  Heart,
  ThumbsDown,
  Disc3,
  House,
  Library,
  ListMusic,
  ListOrdered,
  LoaderCircle,
  LogIn,
  LogOut,
  Maximize2,
  Minus,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Search,
  Settings2,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide";
import type { IconInput } from "morphicons";
import type { Profile, Track, YandexAccount as YandexProfile, MusicSource } from "./shared";
import { trackKey, usePlayer } from "./usePlayer";
import LoginDialog from "./LoginDialog";
import Visualizer from "./Visualizer";
import Settings from "./Settings";
import SeekBar from "./SeekBar";
import { validOrbMode, type OrbMode } from "./orbGeometry";
import { version } from "../package.json";

type View = "library" | "search" | "playlists" | "visualizer" | "settings";
const api = window.unimusic;
function savedSetting(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export default function App() {
  useEffect(() => {
    document.title = `UniMusic ${version}`;
    document.documentElement.classList.toggle("native-shell", Boolean(api));
  }, []);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [yandexProfile, setYandexProfile] = useState<YandexProfile | null>(null);
  const [unifiedOpen, setUnifiedOpen] = useState(() => savedSetting("unimusic-collection") !== "service");
  useEffect(() => { try { localStorage.setItem("unimusic-collection", unifiedOpen ? "unified" : "service"); } catch { /* Keep the choice in memory. */ } }, [unifiedOpen]);
  const [source, setSource] = useState<MusicSource>(() => savedSetting("unimusic-source") === "yandex" ? "yandex" : "vk");
  useEffect(() => { try { localStorage.setItem("unimusic-source", source); } catch { /* Keep the current choice in memory. */ } }, [source]);
  useEffect(() => { void api?.yandexSession().then(r => { if (r.ok) setYandexProfile(r.data); }); }, []);
  const [booting, setBooting] = useState(true);
  const [sessionError, setSessionError] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [view, setView] = useState<View>("visualizer");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("unimusic");
  const [orbMode, setOrbMode] = useState<OrbMode>(() => validOrbMode(savedSetting("unimusic-orb-mode")));
  const [orbSettings, setOrbSettings] = useState(() => {
    try { return validOrbSettings(JSON.parse(savedSetting("unimusic-orb-settings") ?? "null")); }
    catch { return validOrbSettings(null); }
  });
  const [lightSettings, setLightSettings] = useState(() => {
    try { return validLightSettings(JSON.parse(savedSetting("unimusic-light-settings") ?? "null")); }
    catch { return validLightSettings(null); }
  });
  const [lightsEnabled, setLightsEnabled] = useState(() => savedSetting("unimusic-ambient-lights") !== "false");
  const [respectMotion, setRespectMotion] = useState(() => savedSetting("unimusic-orb-respect-motion") !== "false");
  useEffect(() => {
    try {
      localStorage.setItem("unimusic-orb-settings", JSON.stringify(orbSettings));
      localStorage.setItem("unimusic-light-settings", JSON.stringify(lightSettings));
      localStorage.setItem("unimusic-ambient-lights", String(lightsEnabled));
      localStorage.setItem("unimusic-orb-mode", orbMode);
      localStorage.setItem("unimusic-orb-respect-motion", String(respectMotion));
    } catch { /* Preferences remain available in memory when storage is unavailable. */ }
  }, [orbMode, respectMotion, lightsEnabled, lightSettings, orbSettings]);
  const [error, setError] = useState("");
  const [queueOpen, setQueueOpen] = useState(false);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [savedTracks, setSavedTracks] = useState<Record<string, Track | null>>({});
  const [savingTrack, setSavingTrack] = useState(false);
  const [dislikedTracks, setDislikedTracks] = useState<Record<string, boolean>>({});
  useEffect(() => setDislikedTracks({}), [yandexProfile?.id]);
  const [waveLaunching, setWaveLaunching] = useState(false);
  const [libraryRevision, setLibraryRevision] = useState(0);
  useEffect(() => setSavedTracks({}), [profile?.id]);
  const searchInput = useRef<HTMLInputElement>(null);

  const reportError = useCallback((message: string, code?: number) => {
    setError(message);
    if (code === 5) setProfile(null);
    if (code === 401) setYandexProfile(null);
  }, []);
  const player = usePlayer(api, reportError);

  const currentKey = player.current ? trackKey(player.current) : "";
  const savedCurrent = currentKey in savedTracks ? savedTracks[currentKey] : (player.current?.source === "yandex" ? player.current.saved : player.current?.ownerId === profile?.id) ? player.current : null;
  async function toggleCurrentSaved() {
    const track = player.current;
    if (!track || !api || savingTrack) return;
    if (track.source === "yandex" ? !yandexProfile : !profile) { if (track.source === "yandex") openSettings("yandex"); else openLogin(); return; }
    setSavingTrack(true);
    try {
      const result = await api.library({ type: savedCurrent ? "delete" : "add", track: savedCurrent ?? track });
      if (!result.ok) { reportError(result.error, result.code); return; }
      setSavedTracks(old => updateSavedTracks(old, track, savedCurrent ? null : result.data.track ?? track, savedCurrent));
      if (!savedCurrent) setDislikedTracks(old => ({ ...old, [trackKey(track)]: false }));
      setLibraryRevision(value => value + 1);
    } catch { reportError("Не удалось изменить вашу музыку. Попробуйте ещё раз."); }
    finally { setSavingTrack(false); }
  }

  const dislikedCurrent = player.current ? dislikedTracks[currentKey] ?? player.current.disliked ?? false : false;
  useEffect(() => {
    const track = player.current;
    if (!api || track?.source !== "yandex" || !yandexProfile) return;
    let active = true;
    void api.library({ type: "reactions", track }).then(result => {
      if (!active || !result.ok || !result.data.track) return;
      setSavedTracks(old => ({ ...old, [trackKey(track)]: result.data.track!.saved ? track : null }));
      setDislikedTracks(old => ({ ...old, [trackKey(track)]: !!result.data.track!.disliked }));
    }).catch(() => {});
    return () => { active = false; };
  }, [currentKey, yandexProfile?.id]);
  useEffect(() => { if (savedCurrent) setDislikedTracks(old => old[currentKey] ? { ...old, [currentKey]: false } : old); }, [currentKey, !!savedCurrent]);
  async function toggleCurrentDislike() {
    const track = player.current;
    if (!api || !track || track.source !== "yandex" || savingTrack) return;
    setSavingTrack(true);
    try {
      const result = await api.library({ type: dislikedCurrent ? "undislike" : "dislike", track });
      if (!result.ok) { reportError(result.error, result.code); return; }
      setDislikedTracks(old => ({ ...old, [trackKey(track)]: !dislikedCurrent }));
      if (!dislikedCurrent) {
        setSavedTracks(old => ({ ...old, [trackKey(track)]: null }));
        if (player.isWave) void player.next();
      }
      setLibraryRevision(value => value + 1);
    } catch { reportError("Не удалось изменить оценку песни."); }
    finally { setSavingTrack(false); }
  }
  async function startWave() {
    if (!api || waveLaunching) return;
    if (!yandexProfile) { openSettings("yandex"); return; }
    if (player.isWave && player.current && !player.playing) { player.toggle(); return; }
    setWaveLaunching(true); setError("");
    try {
      const request = { source: "yandex" as const, kind: "recommendations" as const };
      const result = await api.browse(request);
      if (!result.ok) { reportError(result.error, result.code); return; }
      const track = result.data.tracks.find(t => !t.restricted && !t.disliked);
      if (!track) { reportError("Яндекс пока не подобрал доступные треки. Попробуйте ещё раз."); return; }
      setSource("yandex");
      await player.start(track, result.data.tracks, { source: request, total: result.data.count });
    } catch { reportError("Не удалось включить Мою волну."); }
    finally { setWaveLaunching(false); }
  }

  async function restore() {
    if (!api) {
      setBooting(false);
      return;
    }
    setBooting(true);
    setError("");
    setSessionError(false);
    try {
      const response = await api.session();
      if (response.ok) setProfile(response.data);
      else {
        reportError(response.error, response.code);
        setSessionError(response.code !== 5);
      }
    } catch {
      setError("Не удалось загрузить сессию. Попробуйте ещё раз.");
      setSessionError(true);
    } finally {
      setBooting(false);
    }
  }
  useEffect(() => {
    void restore();
    void api?.preferences?.().then(r => { if (r.ok) player.setEqualizer(r.data.equalizer); });
  }, []);
  useEffect(() => {
    if (!booting) void player.restore();
  }, [profile?.id, booting]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setView("search");
        setError("");
        searchInput.current?.focus();
      }
      if (
        event.code === "Space" &&
        !(
          event.target instanceof HTMLElement &&
          (event.target.closest("input, textarea, button, dialog") ||
            event.target.isContentEditable)
        )
      ) {
        event.preventDefault();
        player.toggle();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [player.toggle]);

  useEffect(() => { if (view === "search") searchInput.current?.focus(); }, [view]);

  function navigate(next: View) {
    setView(next);
    setError("");
    if (next === "search") searchInput.current?.focus();
  }
  function openLogin() {
    if (api) {
      setError("");
      setLoginOpen(true);
    }
  }
  function openSettings(section?: SettingsSection) {
    if (section) setSettingsSection(section);
    navigate("settings");
    setQueueOpen(false);
  }
  async function logout() {
    if (!api) return;
    const response = await api.logout();
    if (response.ok) {
      setProfile(null);
      setError("");
        setView("visualizer");
    } else reportError(response.error, response.code);
  }
  return (
    <div className={`app-shell view-${view}`}>
      <header className="titlebar">
          <a
            className="brand"
            href="#"
            onClick={(event) => {
              event.preventDefault();
              navigate("visualizer");
            }}
            aria-label="UniMusic — главный экран"
            title={`UniMusic ${version}`}
          >
            <span className="brand-mark">
              <Icon icon={Disc3} size={26} />
            </span>
            <span>
              uni<span className="brand-light">music</span>
            </span>
          </a>
          <nav aria-label="Основная навигация">
            <button
              className={`nav-item ${view === "visualizer" ? "selected" : ""}`}
              aria-label="Главная" title="Главная"
              aria-current={view === "visualizer" ? "page" : undefined}
              onClick={() => navigate("visualizer")}
            >
              <Icon icon={House} />
              <span>Главная</span>
            </button>
            <button
              className={`nav-item ${view === "library" ? "selected" : ""}`}
              aria-label="Моя музыка" title="Моя музыка"
              aria-current={view === "library" ? "page" : undefined}
              onClick={() => navigate("library")}
            >
              <Icon icon={Library} />
              <span>Моя музыка</span>
            </button>
            <button
              className={`nav-item ${view === "search" ? "selected" : ""}`}
              aria-label="Поиск" title="Поиск"
              aria-current={view === "search" ? "page" : undefined}
              onClick={() => navigate("search")}
            >
              <Icon icon={Search} />
              <span>Поиск</span>
            </button>
            <button
              className={`nav-item ${view === "playlists" ? "selected" : ""}`}
              aria-label="Плейлисты" title="Плейлисты"
              aria-current={view === "playlists" ? "page" : undefined}
              onClick={() => navigate("playlists")}
            >
              <Icon icon={ListMusic} />
              <span>Плейлисты</span>
            </button>
          </nav>
        <div className="header-account">
          {source === "yandex" ? <button className="connect-account" onClick={() => openSettings("yandex")} disabled={!api} aria-label="Аккаунт Яндекс Музыки"><Icon icon={yandexProfile ? Disc3 : LogIn} size={18} /><span>{yandexProfile?.firstName ?? "Войти в Яндекс"}</span></button> : profile ? <>
            <Cover src={profile.avatar} title={profile.firstName} className="avatar" />
            <span className="account-name">{profile.firstName}</span>
            <IconButton icon={LogOut} label="Выйти из VK" onClick={() => void logout()} />
          </> : <button className="connect-account" aria-label="Войти в аккаунт VK" onClick={openLogin} disabled={!api || booting}><Icon icon={LogIn} size={18} /><span>Войти в VK</span></button>}
          <span className="header-divider" aria-hidden="true" />
          <IconButton icon={Settings2} label="Настройки" active={view === "settings"} onClick={() => openSettings()} />
        </div>
        <div className="window-controls">
          <IconButton
            icon={Minus}
            label="Свернуть"
            onClick={() => api?.window("minimize")}
          />
          <IconButton
            icon={Maximize2}
            label="Развернуть"
            onClick={() => api?.window("maximize")}
          />
          <IconButton
            className="window-close"
            icon={X}
            label="Закрыть приложение"
            onClick={() => api?.window("close")}
          />
        </div>
      </header>
      <div className="workspace">
        <div className="main-column">
          <main className={`content ${view === "visualizer" ? "visualizer-content" : ""}`} id="main-content">
            {!api && (
              <div className="error-banner" role="status">
                Это предварительный просмотр интерфейса. Для подключения VK
                запустите Windows-приложение командой npm run dev.
              </div>
            )}
            {error && (
              <div className="error-banner" role="alert">
                <span>{error}</span>
                <button
                  onClick={() =>
                    source === "yandex" ? (yandexProfile ? setRefresh(n => n + 1) : openSettings("yandex")) : sessionError
                      ? void restore()
                      : profile
                        ? setRefresh((value) => value + 1)
                        : openLogin()
                  }
                >
                  {source === "yandex" ? yandexProfile ? "Повторить" : "Подключить" : sessionError || profile ? "Повторить" : "Войти"}
                </button>
                <IconButton
                  icon={X}
                  label="Скрыть сообщение"
                  onClick={() => setError("")}
                />
              </div>
            )}
            {view === "visualizer" && <Visualizer lyricsOpen={lyricsOpen} onCloseLyrics={() => setLyricsOpen(false)} api={api} track={player.current} playing={player.playing} loading={player.loading} readAudio={player.readAudio} mode={orbMode} respectMotion={respectMotion} lightsEnabled={lightsEnabled} lightSettings={lightSettings} orbSettings={orbSettings} onToggle={player.toggle} onPrevious={player.previous} onNext={() => void player.next()} onWave={() => void startWave()} waveLaunching={waveLaunching} waveActive={player.isWave && (player.playing || player.loading) && !waveLaunching} onBrowse={() => navigate("library")} />}
            {view === "settings" && <SettingsPage section={settingsSection} onSection={setSettingsSection} api={api} profile={profile} yandexProfile={yandexProfile} onYandexProfile={value => { setYandexProfile(value); if (value) { setSource("yandex"); setUnifiedOpen(false); } setSavedTracks({}); setRefresh(n => n + 1); }} onLogin={openLogin} onLogout={() => void logout()} onError={reportError} onEqualizer={player.setEqualizer}>
              <Settings mode={orbMode} onMode={setOrbMode} playing={player.playing} readAudio={player.readAudio} cover={player.current?.cover} respectMotion={respectMotion} onRespectMotion={setRespectMotion} lightsEnabled={lightsEnabled} onLightsEnabled={setLightsEnabled} lightSettings={lightSettings} onLightSettings={setLightSettings} orbSettings={orbSettings} onOrbSettings={setOrbSettings} />
            </SettingsPage>}
            {(view === "library" || view === "search" || view === "playlists") && <>
              <div className="source-switch" role="group" aria-label="Музыкальный сервис">{view !== "search" && <button aria-pressed={unifiedOpen} onClick={() => { setUnifiedOpen(true); setError(""); }}>UniMusic</button>}{(["vk", "yandex"] as const).map(item => <button key={item} aria-pressed={(view === "search" || !unifiedOpen) && source === item} onClick={() => { setUnifiedOpen(false); setSource(item); setError(""); }}>{item === "vk" ? "VK Музыка" : "Яндекс Музыка"}</button>)}</div>
              {view !== "search" && unifiedOpen ? <UnifiedBrowser api={api} player={player} /> : <MusicBrowser source={source} savedTracks={savedTracks} setSavedTracks={setSavedTracks} libraryRevision={libraryRevision} key={`${source}-${view}-${(source === "yandex" ? yandexProfile : profile)?.id}-${refresh}`} view={view} profile={source === "yandex" ? yandexProfile : profile} api={api} player={player} onError={reportError} onLogin={() => source === "yandex" ? openSettings("yandex") : openLogin()} searchRef={searchInput} />}
            </>}
          </main>
        </div>
        {queueOpen && (
          <aside className="queue-panel" aria-label="Очередь воспроизведения">
            <div className="queue-heading">
              <div>
                <h2>Очередь</h2>
              </div>
              <IconButton
                icon={X}
                label="Закрыть очередь"
                onClick={() => setQueueOpen(false)}
              />
            </div>
            <p className="queue-count">{player.queue.length} из {player.queueTotal} треков</p>
            {player.notice && <p className="queue-notice" role="status">{player.notice}<button onClick={player.clearNotice}>Скрыть</button></p>}
            {player.queue.length ? (
              <div className="queue-list">
                {player.queue.map((track, index) => (
                  <div className="queue-item" key={trackKey(track)}><button
                    className={`queue-track ${player.current && trackKey(player.current) === trackKey(track) ? "current" : ""}`}
                    key={`${trackKey(track)}_${index}`}
                    onClick={() => player.current && trackKey(player.current) === trackKey(track) ? player.toggle() : void player.start(track)}
                    disabled={track.restricted}
                  >
                    <Cover src={track.cover} title={track.title} />
                    <span>
                      <strong>{track.title}</strong>
                      <small>{track.artist}</small>
                    </span>
                  </button><div className="queue-actions">
                    <button aria-label={`Выше: ${track.title}`} disabled={index === 0} onClick={() => player.moveInQueue(trackKey(track), -1)}>↑</button>
                    <button aria-label={`Ниже: ${track.title}`} disabled={index === player.queue.length - 1} onClick={() => player.moveInQueue(trackKey(track), 1)}>↓</button>
                    <button aria-label={`Убрать: ${track.title}`} disabled={player.current && trackKey(player.current) === trackKey(track) || false} onClick={() => player.removeFromQueue(trackKey(track))}>×</button>
                  </div></div>
                ))}
              </div>
            ) : (
              <Empty
                icon={ListOrdered}
                title="Очередь пуста"
                text="Включите трек, чтобы увидеть очередь."
              />
            )}
          </aside>
        )}
      </div>
      <footer className="player" aria-label="Плеер">
          <div className="playback-buttons">
            <button
              className="play-button"
              title={player.playing ? "Пауза" : "Воспроизвести"}
              aria-label={player.playing ? "Пауза" : "Воспроизвести"}
              onClick={player.toggle}
              disabled={!player.current || player.loading}
            >
              <Icon
                icon={
                  player.loading ? LoaderCircle : player.playing ? Pause : Play
                }
                className={player.loading ? "spinning" : ""}
                size={23}
              />
            </button>
            <IconButton
              icon={SkipBack}
              label="Предыдущий трек"
              onClick={player.previous}
              disabled={!player.current}
            />

            <IconButton
              icon={SkipForward}
              label="Следующий трек"
              onClick={() => player.next()}
              disabled={!player.current}
            />
          </div>

        <div className="now-playing">
          <button className="player-cover" aria-label="Открыть главную" onClick={() => navigate("visualizer")}>
            <Cover src={player.current?.cover} title={player.current?.title || "UniMusic"} />
          </button>
          <div>
            <strong>
              {player.current?.title || "Выберите трек"}
            </strong>
            <span>{player.current?.artist || "Моя музыка или поиск"}</span>
          </div>
          <IconButton icon={Heart} className="heart-button" label={savedCurrent ? "Убрать лайк с текущей песни" : "Мне нравится текущая песня"} active={!!savedCurrent} disabled={savingTrack || !player.current || player.current.source === "local"} onClick={() => void toggleCurrentSaved()} />
          {player.current?.source === "yandex" && <IconButton icon={ThumbsDown} label={dislikedCurrent ? "Отменить дизлайк текущей песни" : "Не рекомендовать текущую песню"} active={dislikedCurrent} disabled={savingTrack} onClick={() => void toggleCurrentDislike()} />}
        </div>
        <div className="playback">
          <SeekBar position={player.position} duration={player.duration} disabled={!player.current} onSeek={player.seek} />
        </div>
        <div className="player-options">
            <IconButton
              icon={Shuffle}
              label="Перемешать"
              active={player.shuffle}
              onClick={player.toggleShuffle}
              disabled={!player.current}
            />
            <IconButton
              icon={player.repeat === "one" ? Repeat1 : Repeat}
              label={
                player.repeat === "off"
                  ? "Повтор выключен"
                  : player.repeat === "all"
                    ? "Повтор очереди"
                    : "Повтор трека"
              }
              active={player.repeat !== "off"}
              onClick={player.cycleRepeat}
              disabled={!player.current}
            />

          <IconButton
            icon={player.muted || player.volume === 0 ? VolumeX : Volume2}
            label={player.muted ? "Включить звук" : "Выключить звук"}
            onClick={player.toggleMute}
          />
          <input
            className="volume-slider"
            type="range"
            aria-label="Громкость"
            min={0}
            max={1}
            step={0.01}
            value={player.muted ? 0 : player.volume}
            onChange={(event) => player.setVolume(Number(event.target.value))}
            style={
              {
                "--progress": `${player.muted ? 0 : player.volume * 100}%`,
              } as React.CSSProperties
            }
          />
          <IconButton icon={lyricsOpen && view === "visualizer" ? X : Captions} label="Текст песни" active={lyricsOpen && view === "visualizer"} disabled={!player.current || !api} onClick={() => { setLyricsOpen(view !== "visualizer" || !lyricsOpen); navigate("visualizer"); setQueueOpen(false); }} />
          <span className="player-divider" />
          <IconButton
            icon={queueOpen ? X : ListOrdered}
            label={queueOpen ? "Скрыть очередь" : "Показать очередь"}
            active={queueOpen}
            onClick={() => setQueueOpen((value) => !value)}
          />
        </div>
      </footer>
      {loginOpen && api && (
        <LoginDialog
          api={api}
          onClose={() => setLoginOpen(false)}
          onLogin={(value) => {
            setProfile(value);
            setLoginOpen(false);
            setSessionError(false);
            setError("");
          }}
        />
      )}
    </div>
  );
}

function Empty({
  icon,
  title,
  text,
}: {
  icon: IconInput;
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon icon={icon} size={28} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
