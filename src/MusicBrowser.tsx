import UnifiedPicker from "./UnifiedPicker";
import { updateSavedTracks } from "./libraryState";
import { useEffect, useRef, useState, type ReactNode, type RefObject, type Dispatch, type SetStateAction } from "react";
import { ArrowLeft, ArrowRight, Heart, Disc3, Download, Ellipsis, Info, ListEnd, ListMinus, ListPlus, Pause, Play, Plus, Radio, RefreshCw, Search, Share2, X } from "lucide";
import type { IconInput } from "morphicons";
import type { BrowseRequest, LibraryAction, MusicApi, MusicPage, OfflineAction, OfflineState, Playlist, Profile, Track } from "./shared";
import { formatTime, trackKey, usePlayer } from "./usePlayer";
import { Cover, Icon, IconButton } from "./ui";
import QRCode from "qrcode";

const empty: MusicPage = { tracks: [], playlists: [], artists: [], sections: [], count: 0 };
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement; ref.current?.showModal(); return () => previous?.focus(); }, []);
  return <dialog ref={ref} className="music-dialog" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="dialog-heading"><h2>{title}</h2><IconButton icon={X} label="Закрыть диалог" onClick={onClose} /></div>{children}
  </dialog>;
}
type Player = ReturnType<typeof usePlayer>;
type Popup = { kind: "unified"; track: Track } | { kind: "track"; track: Track } | { kind: "playlist"; playlist: Playlist } |
  { kind: "share" | "manage"; track: Track } |
  { kind: "editTrack"; track: Track } | { kind: "editPlaylist"; playlist?: Playlist } |
  { kind: "choosePlaylist"; tracks: Track[] } | { kind: "text"; title: string; text: string } |
  { kind: "confirm"; title: string; action: LibraryAction } | { kind: "qr"; title: string; image: string };

export default function MusicBrowser({ source = "vk", savedTracks, setSavedTracks, libraryRevision, view, profile, api, player, onError, onLogin, searchRef }: {
  source?: "vk" | "yandex";
  savedTracks: Record<string, Track | null>; setSavedTracks: Dispatch<SetStateAction<Record<string, Track | null>>>; libraryRevision: number;
  view: "library" | "search" | "playlists"; profile: Profile | null; api?: MusicApi; player: Player;
  onError: (message: string, code?: number) => void; onLogin: () => void; searchRef: RefObject<HTMLInputElement | null>;
}) {
  const [request, setRequest] = useState<BrowseRequest>({ source, kind: view === "search" ? "search" : "library" });
  const [page, setPage] = useState<MusicPage>(empty);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [title, setTitle] = useState(view === "library" ? "Моя музыка" : view === "search" ? "Поиск музыки" : "Плейлисты");
  const [loading, setLoading] = useState(false);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [undo, setUndo] = useState<Track | null>(null);
  const [choices, setChoices] = useState<Playlist[]>([]);
  const [selection, setSelection] = useState<string[] | null>(null);
  const [offline, setOffline] = useState<OfflineState | null>(null);
  const [grouping, setGrouping] = useState("all");
  const [group, setGroup] = useState("");
  const [filterFailed, setFilterFailed] = useState(false);
  const generation = useRef(0);
  const ownPlaylists = view === "playlists" && !playlist && request.kind === "library";
  const local = request.kind === "local";
  const online = !local;
  const canLoad = api && (!online || profile) && (request.kind !== "search" || request.query);
  async function load(more = false) {
    if (!canLoad || !api) return;
    const id = ++generation.current; setLoading(true);
    try {
      const loaded = page.tracks.length + page.playlists.length + page.artists.length;
      const result = ownPlaylists ? await api.playlists(more ? loaded : 0, source) :
        await api.browse({ ...request, offset: more ? loaded : 0, cursor: more ? page.next : request.cursor });
      if (id !== generation.current) return;
      if (!result.ok) { setFilterFailed(true); onError(result.error, result.code); return; }
      const data: MusicPage = "items" in result.data ? { ...empty, playlists: result.data.items, count: result.data.count } : result.data;
      if (source === "yandex") setSavedTracks(old => {
        const next = { ...old }; for (const track of data.tracks) if (typeof track.saved === "boolean") next[trackKey(track)] = track.saved ? track : null; return next;
      });
      if (more && !data.tracks.length && !data.playlists.length && !data.artists.length) { data.count = loaded; data.next = undefined; }
      setPage(old => more ? { ...data, tracks: [...old.tracks, ...data.tracks], playlists: [...old.playlists, ...data.playlists], artists: [...old.artists, ...data.artists], sections: data.sections.length ? data.sections : old.sections } : data);
    } catch { setFilterFailed(true); onError("Не удалось загрузить музыку."); }
    finally { if (id === generation.current) setLoading(false); }
  }
  useEffect(() => { setPage(empty); setFilter(""); setSelection(null); void load(); return () => { generation.current++; }; }, [JSON.stringify(request), profile?.id, ownPlaylists]);
  useEffect(() => { if (libraryRevision) void load(); }, [libraryRevision]);
  useEffect(() => {
    if (!local || !api) return;
    let active = true;
    const poll = async () => { const response = await api.offline({ type: "list" }); if (active && response.ok) setOffline(response.data); };
    void poll(); const timer = setInterval(() => void poll(), 1500);
    return () => { active = false; clearInterval(timer); };
  }, [local, api]);
  function open(next: BrowseRequest, label: string, selected: Playlist | null = null) {
    setRequest({ ...next, source }); setTitle(label); setPlaylist(selected); setPopup(null); setMessage("");
  }
  async function mutate(action: LibraryAction) {
    if (!api || busy) return;
    setBusy(true);
    try {
      const actionSource = "track" in action ? action.track.source : "playlist" in action ? action.playlist.source : source;
      const response = await api.library({ ...action, source: actionSource === "yandex" ? "yandex" : source });
      if (!response.ok) { onError(response.error, response.code); return; }
      setPopup(null); setMessage("Готово"); await load();
      if (action.type === "delete") setUndo(page.tracks.find(t => trackKey(t) === trackKey(action.track as Track)) ?? action.track as Track);
      if (action.type === "restore") setSavedTracks(old => updateSavedTracks(old, action.track as Track, response.data.track ?? action.track as Track));
      if (action.type === "deletePlaylist") { setPlaylist(null); setRequest({ kind: "library" }); setTitle("Плейлисты"); }
      return response.data;
    } finally { setBusy(false); }
  }
  async function files(action: OfflineAction) {
    if (!api) return;
    const response = await api.offline(action);
    if (response.ok) { setOffline(response.data); setPopup(null); setMessage(action.type === "upload" ? "Файл добавлен в VK" : "Готово"); if (local) await load(); }
    else onError(response.error, response.code);
  }
  async function toggleSaved(track: Track) {
    const key = trackKey(track);
    const saved = key in savedTracks ? savedTracks[key] : (track.source === "yandex" ? track.saved : track.ownerId === profile?.id) ? track : null;
    const result = await mutate({ type: saved ? "delete" : "add", track: saved ?? track });
    if (result) {
      setSavedTracks(old => updateSavedTracks(old, track, saved ? null : result.track ?? track, saved));
      setMessage(saved ? "Удалено из вашей музыки" : "Добавлено в вашу музыку");
    }
  }
  async function openArtist(name: string, id?: string) {
    if (!profile || !api) { onLogin(); return; }
    if (id) { open({ kind: "artist", artistId: id }, name); return; }
    setBusy(true);
    try {
      const result = await api.browse({ source, kind: "search", query: name, filters: { type: "artists" } });
      const artist = result.ok ? result.data.artists.find(a => a.name.toLocaleLowerCase() === name.toLocaleLowerCase()) : undefined;
      if (artist) open({ kind: "artist", artistId: artist.id }, artist.name);
      else { open({ kind: "search", query: name, filters: { performer: true } }, name); setMessage("У этой записи нет страницы исполнителя. Показаны его треки."); }
    } finally { setBusy(false); }
  }
  async function text(title: string, action: Promise<{ ok: true; data: string } | { ok: false; error: string; code?: number }>) {
    setBusy(true);
    try { const result = await action; if (result.ok) setPopup({ kind: "text", title, text: result.data }); else onError(result.error, result.code); }
    finally { setBusy(false); }
  }
  async function choose(tracks: Track[]) {
    if (!api) return;
    const items: Playlist[] = [];
    setBusy(true);
    try {
      let offset = 0;
      for (;;) {
        const response = await api.playlists(offset, source);
        if (!response.ok) { onError(response.error, response.code); return; }
        items.push(...response.data.items.filter(p => p.ownerId === profile?.id));
        offset += response.data.items.length;
        if (!response.data.items.length || offset >= response.data.count) break;
      }
      setChoices(items); setPopup({ kind: "choosePlaylist", tracks });
    } finally { setBusy(false); }
  }
  const tracks = page.tracks.filter(t => (!filter || `${t.title} ${t.artist} ${t.album ?? ""}`.toLowerCase().includes(filter.toLowerCase())) && (!group || (grouping === "album" ? t.album : t.folder) === group));
  const shownPlaylists = page.playlists.filter(p => !filter || `${p.title} ${p.description ?? ""}`.toLowerCase().includes(filter.toLowerCase()));
  const selectedTracks = page.tracks.filter(t => selection?.includes(trackKey(t)));
  const play = (track: Track) => player.current && trackKey(track) === trackKey(player.current) ? player.toggle()
    : void player.start(track, page.tracks, { source: request, total: page.count });
  const hasMore = page.next || page.tracks.length + page.playlists.length + page.artists.length < page.count;
  useEffect(() => { setFilterFailed(false); }, [filter]);
  useEffect(() => {
    if (!loading && !filterFailed && hasMore && filter && (playlist || ownPlaylists || source === "yandex" && request.kind === "library")) void load(true);
  }, [filter, loading, filterFailed, hasMore, page.tracks.length, page.playlists.length]);
  const button = (label: string, onClick: () => void, disabled = false, icon?: IconInput) => <button key={label} className="menu-action" disabled={busy || disabled} onClick={onClick}>{icon && <Icon icon={icon} size={19} />}<span>{label}</span></button>;
  return <section className="music-browser">
    {view === "search" && <form className="search-box" role="search" onSubmit={e => { e.preventDefault(); if (query.trim()) open({ kind: "search", query: query.trim(), filters: request.filters }, "Поиск музыки"); }}>
      <Icon icon={Search} /><input ref={searchRef} aria-label={source === "yandex" ? "Поиск по Яндекс Музыке" : "Поиск по VK Music"} placeholder="Трек, исполнитель или альбом" maxLength={200} value={query} onChange={e => setQuery(e.target.value)} />
      <button className="search-submit" aria-label="Найти музыку"><Icon icon={ArrowRight} /></button>
    </form>}
    {view === "library" && <div className="collection-tabs" aria-label="Разделы музыки">
      {([["library", "Коллекция"], ["catalog", "Каталог"], ["recommendations", "Для вас"], ["popular", "Популярное"], ["local", "На устройстве"]] as const).filter(([kind]) => source === "vk" || kind === "library" || kind === "local").map(([kind, label]) =>
        <button key={kind} aria-pressed={request.kind === kind} onClick={() => open({ kind }, kind === "library" ? "Моя музыка" : source === "yandex" && kind === "recommendations" ? "Моя волна" : label)}>{source === "yandex" && kind === "recommendations" ? "Моя волна" : label}</button>)}
    </div>}
    <div className="section-heading"><div>
      {(playlist || ["artist", "section", "block"].includes(request.kind)) && <button className="text-button back-button" onClick={() => open({ kind: "library" }, view === "playlists" ? "Плейлисты" : "Моя музыка")}><Icon icon={ArrowLeft} size={16} />{view === "playlists" ? "Все плейлисты" : "Назад"}</button>}
      <div className="heading-line"><h1>{title}</h1><span className="count-badge">{page.count || ""}</span></div>
      {playlist?.description && <p>{playlist.description}</p>}{view === "search" && request.query && <p>Результаты по запросу «{request.query}»</p>}
    </div><div className="section-actions">
      {!!tracks.length && <button className="button primary listen-all" onClick={() => void player.start(tracks[0], page.tracks, { source: request, total: page.count })}><Icon icon={Play} size={16} />Слушать всё</button>}
      {ownPlaylists && profile && source === "vk" && <IconButton icon={Plus} label="Создать плейлист" onClick={() => setPopup({ kind: "editPlaylist" })} />}
      {playlist && source === "vk" && <IconButton icon={Ellipsis} label="Действия с плейлистом" onClick={() => setPopup({ kind: "playlist", playlist })} />}
      <IconButton icon={RefreshCw} label="Обновить" disabled={loading} onClick={() => void load()} />
    </div></div>
    {message && <div className="action-status" role="status">{message}{undo && <button onClick={() => { void mutate({ type: "restore", track: undo }); setUndo(null); }}>Вернуть удалённый трек</button>}<button aria-label="Скрыть уведомление" onClick={() => setMessage("")}>×</button></div>}
    {view === "search" && source === "yandex" && <div className="browser-filters"><label>Искать<select value={request.filters?.type ?? "tracks"} onChange={e => setRequest(r => ({ ...r, filters: { type: e.target.value as "tracks" | "artists" | "playlists" } }))}><option value="tracks">Треки</option><option value="artists">Исполнителей</option><option value="playlists">Плейлисты</option></select></label></div>}
    {view === "search" && source === "vk" && <div className="browser-filters">
      <label>Искать<select value={request.filters?.type ?? "tracks"} onChange={e => setRequest(r => ({ ...r, kind: "search", filters: { ...r.filters, type: e.target.value as "tracks" | "artists" | "playlists" } }))}><option value="tracks">Треки</option><option value="artists">Исполнителей</option><option value="playlists">Плейлисты</option></select></label>
      <label>Порядок<select value={request.filters?.sort ?? 1} onChange={e => setRequest(r => ({ ...r, filters: { ...r.filters, sort: Number(e.target.value) as 0 | 1 | 2 } }))}><option value={1}>По релевантности</option><option value={0}>По дате</option><option value={2}>По длительности</option></select></label>
      {([["own", "В моей музыке"], ["performer", "По исполнителю"], ["lyrics", "С текстом"], ["autocomplete", "Автодополнение"]] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={request.filters?.[key] ?? key === "autocomplete"} onChange={e => setRequest(r => ({ ...r, filters: { ...r.filters, [key]: e.target.checked } }))} />{label}</label>)}
    </div>}
    {request.kind === "popular" && <label className="browser-filters">Жанр<select value={request.genre ?? 0} onChange={e => setRequest(r => ({ ...r, genre: Number(e.target.value) }))}>
      {[[0,"Все жанры"],[1,"Rock"],[2,"Pop"],[3,"Rap & Hip-Hop"],[5,"Dance & House"],[7,"Indie Pop"],[8,"Alternative"],[9,"Electropop & Disco"],[10,"Jazz & Blues"],[11,"Drum & Bass"],[18,"Other"],[19,"Speech"],[21,"Metal"]].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
    </select></label>}
    {!online || profile ? <>
      {view !== "search" && <div className="collection-tools">
        <form onSubmit={e => { e.preventDefault(); if (source === "vk" && request.kind === "library" && !ownPlaylists && filter.trim()) open({ kind: "search", query: filter, filters: { own: true } }, `Моя музыка · ${filter}`);
          else if (local) setRequest(r => ({ ...r, query: filter })); }}>
          <input aria-label="Найти в коллекции" placeholder="Найти в коллекции" value={filter} onChange={e => setFilter(e.target.value)} /><button type="submit" aria-label="Поиск в коллекции"><Icon icon={Search} size={16} /></button>
        </form>
        {!!page.tracks.length && <button className="text-button" onClick={() => setSelection(selection ? null : [])}>{selection ? "Отменить выбор" : "Выбрать"}</button>}
        {local && <button className="button secondary" onClick={() => void files({ type: "import" })}>Добавить файлы</button>}
      </div>}
      {local && <div className="browser-filters"><label>Группировать<select value={grouping} onChange={e => { setGrouping(e.target.value); setGroup(""); }}><option value="all">Все файлы</option><option value="album">По альбомам</option><option value="folder">По папкам</option></select></label>
        {grouping !== "all" && <label>{grouping === "album" ? "Альбом" : "Папка"}<select value={group} onChange={e => setGroup(e.target.value)}><option value="">Все</option>{[...new Set(page.tracks.map(t => grouping === "album" ? t.album : t.folder).filter(Boolean))].map(name => <option key={name}>{name}</option>)}</select></label>}
        <span>{((offline?.bytes ?? 0) / 1048576).toFixed(1)} МБ на устройстве</span></div>}
      {selection && <div className="selection-toolbar"><span>Выбрано {selection.length} / 100</span><button onClick={() => setSelection(tracks.slice(0, 100).map(trackKey))}>Выбрать видимые</button>{source === "vk" && <button disabled={!selection.length} onClick={() => void choose(selectedTracks)}>В плейлист</button>}<button disabled={!selection.length} onClick={() => void files({ type: "download", tracks: selectedTracks })}>Скачать</button></div>}
      {!!page.sections.length && <div className="collection-tabs">{page.sections.map(section => <button key={section.id} onClick={() => open({ kind: section.kind, ...(section.kind === "section" ? { sectionId: section.id } : { blockId: section.id, cursor: section.cursor }) }, section.title)}>{section.title}</button>)}</div>}
      {!!page.artists.length && <div className="artist-grid">{page.artists.map(artist => <button key={artist.id} onClick={() => open({ kind: "artist", artistId: artist.id }, artist.name)}><Cover src={artist.cover} title={artist.name} /><strong>{artist.name}</strong></button>)}</div>}
      {request.kind === "artist" && <button className="text-button" onClick={() => open({ kind: "catalog", artistId: request.artistId }, `${title} · Альбомы`)}>Открыть альбомы исполнителя</button>}
      {!!page.playlists.length && <div className="playlist-grid">{shownPlaylists.map(item => <div key={`${item.ownerId}_${item.id}`} className="playlist-item"><button className="playlist-card" onClick={() => open({ kind: "playlist", playlist: item.original ?? item }, item.title, item)}><div className="playlist-art"><Cover src={item.cover} title={item.title} /></div><strong>{item.title}</strong><span>{item.count} треков</span></button>{source === "vk" && <IconButton icon={Ellipsis} label={`Действия: ${item.title}`} onClick={() => setPopup({ kind: "playlist", playlist: item })} />}</div>)}</div>}
      <div className="track-list" role="list" aria-label={title}>{tracks.map((track, index) => {
        const active = player.current && trackKey(track) === trackKey(player.current);
        const vk = track.source !== "local";
        const saved = trackKey(track) in savedTracks ? !!savedTracks[trackKey(track)] : (track.source === "yandex" ? !!track.saved : track.ownerId === profile?.id);
        const inPlaylist = !!playlist && playlist.ownerId === profile?.id;
        return <div className={`track-row ${active ? "current" : ""}`} role="listitem" key={trackKey(track)}>
          {selection ? <input type="checkbox" aria-label={`Выбрать: ${track.title}`} checked={selection.includes(trackKey(track))} onChange={e => setSelection(old => e.target.checked ? [...old!, trackKey(track)].slice(0, 100) : old!.filter(k => k !== trackKey(track)))} /> :
            <button className="track-index" aria-label={`${active && player.playing ? "Пауза" : "Слушать"}: ${track.title}`} onClick={() => play(track)} disabled={track.restricted}><span className="row-number">{String(index + 1).padStart(2, "0")}</span><span className="row-play"><Icon icon={active && player.playing ? Pause : Play} size={16} /></span></button>}
          <div className="track-description"><button className="row-cover-button" aria-label={`Воспроизвести обложку: ${track.title}`} disabled={track.restricted} onClick={() => play(track)}><Cover src={track.cover} title={track.title} /></button><span>
            <button className="row-title-button" disabled={track.restricted} onClick={() => play(track)}><strong>{track.title}</strong></button>
            <span className="track-artists">{track.artists?.length ? track.artists.map((artist, i) => <span key={artist.id}>{i > 0 && <span className="artist-separator">, </span>}<button disabled={busy} onClick={() => void openArtist(artist.name, artist.id)} title={`Открыть исполнителя: ${artist.name}`}>{artist.name}</button></span>) : <button disabled={busy} title={`Открыть исполнителя: ${track.artist}`} onClick={() => void openArtist(track.artist)}>{track.artist}</button>}{track.restricted && <span> · Недоступно</span>}</span>
          </span></div>
          <span className="album-column">{track.album ?? "—"}</span><span className="track-time">{formatTime(track.duration)}</span>
          <div className="track-actions">
            {vk && <><IconButton icon={Heart} className="heart-button" active={saved} label={`${saved ? "Убрать лайк" : "Мне нравится"}: ${track.title}`} disabled={busy || !profile} onClick={() => void toggleSaved(track)} />
              {source === "vk" && <IconButton icon={inPlaylist ? ListMinus : ListPlus} label={`${inPlaylist ? "Убрать из плейлиста" : "Добавить в плейлист"}: ${track.title}`} disabled={busy || !profile} onClick={() => inPlaylist ? void mutate({ type: "removeFromPlaylist", playlist: playlist!, tracks: [track] }) : void choose([track])} />}</>}
            <IconButton icon={Ellipsis} label={`Действия: ${track.title}`} onClick={() => setPopup({ kind: "track", track })} />
          </div>
        </div>;
      })}</div>
      {loading && <p className="loading-state" role="status">Загружаем музыку…</p>}
      {!loading && !page.count && !page.sections.length && <div className="empty-state"><h3>{view === "search" && !request.query ? "Что будем слушать?" : "Здесь пока нет музыки"}</h3><p>{local ? "Добавьте аудиофайлы с компьютера или скачайте песни из меню трека." : "Выберите раздел или измените запрос."}</p></div>}
      {hasMore && <div className="load-more"><button className="button secondary" disabled={loading} onClick={() => void load(true)}>Показать ещё</button></div>}
      {local && offline && <div className="download-list"><h2>Загрузки и файлы</h2>{offline.entries.map(entry => <div className="download-row" key={entry.id}><div><strong>{entry.track.title}</strong><small>{entry.error || ({ queued: "В очереди", downloading: "Скачивается", complete: "На устройстве", cancelled: "Отменено", error: "Ошибка" }[entry.state])}</small>{entry.state === "downloading" && <progress max={1} value={entry.progress || undefined} aria-label={`Скачивание ${entry.track.title}`} />}</div>
        {["queued", "downloading"].includes(entry.state) ? <button onClick={() => void files({ type: "cancel", id: entry.id })}>Отменить</button> : entry.state === "complete" ? <>
          <button onClick={() => void files({ type: "reveal", id: entry.id })}>Показать файл</button>
          {entry.track.source === "vk" && <button onClick={() => void files({ type: "download", tracks: [entry.track], replace: true })}>Проверить качество</button>}
          {profile && entry.track.source === "local" && <button onClick={() => { if (window.confirm(`Загрузить «${entry.track.title}» в вашу музыку VK?`)) void files({ type: "upload", id: entry.id }); }}>Загрузить в VK</button>}
        </> : <button onClick={() => void files({ type: "download", tracks: [entry.track] })}>Повторить</button>}
        <button onClick={() => { if (window.confirm(entry.track.source === "local" ? "Убрать файл из приложения? Оригинал останется." : "Удалить скачанный файл с устройства?")) void files({ type: "remove", id: entry.id }); }}>Удалить</button>
      </div>)}</div>}
    </> : <div className="empty-state"><h3>Подключите свою музыку</h3><button className="button primary" onClick={onLogin}>{source === "yandex" ? "Подключить Яндекс Музыку" : "Войти в VK"}</button>{view === "library" && <button className="text-button" onClick={() => open({ kind: "local" }, "На устройстве")}>Открыть локальные файлы</button>}</div>}
    {popup && <Modal title={popup.kind === "text" || popup.kind === "confirm" || popup.kind === "qr" ? popup.title : popup.kind === "choosePlaylist" ? "Добавить в плейлист" : popup.kind === "editPlaylist" ? popup.playlist ? "Изменить плейлист" : "Новый плейлист" : "track" in popup ? popup.track.title : popup.playlist.title} onClose={() => !busy && setPopup(null)}>
      {popup.kind === "unified" && <UnifiedPicker api={api} tracks={[popup.track]} onDone={() => { setPopup(null); setMessage("Добавлено в UniMusic"); }} />}
      {popup.kind === "track" && <div className="menu-actions">
        {button("Добавить в UniMusic", () => setPopup({ kind: "unified", track: popup.track }), false, ListPlus)}
        {button("Слушать следующим", () => { player.enqueueNext(popup.track); setPopup(null); }, false, ListEnd)}
        {button("Скачать", () => void files({ type: "download", tracks: [popup.track] }), popup.track.source === "local", Download)}
        {popup.track.source !== "local" && <>
          {source === "vk" && button("Похожие треки", () => open({ kind: "recommendations", track: popup.track }, `Похожие на «${popup.track.title}»`), false, Radio)}
          {popup.track.albumRef && button("Альбом", () => open({ kind: "playlist", playlist: popup.track.albumRef }, popup.track.album ?? "Альбом"), false, Disc3)}
        </>}
        {button("Поделиться", () => setPopup({ kind: "share", track: popup.track }), false, Share2)}
        {button("Сведения и правка", () => setPopup({ kind: "manage", track: popup.track }), false, Info)}
      </div>}
      {(popup.kind === "share" || popup.kind === "manage") && <div className="menu-actions">
        {button("Назад", () => setPopup({ kind: "track", track: popup.track }), false, ArrowLeft)}
        {popup.kind === "share" ? <>
          {button("Скопировать название", () => void text("Название", api!.copyTrack(popup.track, "text").then(r => r.ok ? { ok: true, data: "Название скопировано." } : r)))}
          {popup.track.source !== "local" && <>
            {button("Скопировать ссылку", () => void text("Ссылка", api!.copyTrack(popup.track, "link").then(r => r.ok ? { ok: true, data: "Ссылка скопирована." } : r)))}
            {popup.track.source !== "yandex" && button("Код вложения VK", () => void text("Вложение VK", api!.copyTrack(popup.track, "attachment").then(r => r.ok ? { ok: true, data: "Код вложения скопирован." } : r)))}
            {button("QR-код ссылки", () => { void QRCode.toDataURL(popup.track.source === "yandex" ? `https://music.yandex.ru/track/${popup.track.id}` : `https://vk.com/audio${popup.track.ownerId}_${popup.track.id}`, { width: 280, margin: 2 }).then(image => setPopup({ kind: "qr", title: popup.track.title, image })); })}
          </>}
        </> : <>
          {button("Информация о файле", () => void text("Информация", api!.trackInfo(popup.track).then(r => r.ok ? { ok: true, data: `${r.data.source}\n${r.data.format}${r.data.bitrate ? `\n≈ ${Math.round(r.data.bitrate / 1000)} кбит/с` : ""}${r.data.size ? `\n${(r.data.size / 1048576).toFixed(1)} МБ` : ""}` } : r)))}
          {popup.track.ownerId === profile?.id && <>
            {button("Изменить название и исполнителя", () => setPopup({ kind: "editTrack", track: popup.track }))}
            {request.kind === "library" && button("Поднять в начало коллекции", () => void mutate({ type: "reorder", track: popup.track, before: page.tracks[0].id }), page.tracks[0]?.id === popup.track.id)}
          </>}
        </>}
      </div>}
      {popup.kind === "playlist" && <div className="menu-actions">{popup.playlist.ownerId === profile?.id ? <>
        {button("Изменить", () => setPopup({ kind: "editPlaylist", playlist: popup.playlist }))}
        {button("Удалить плейлист", () => setPopup({ kind: "confirm", title: "Удалить плейлист из VK?", action: { type: "deletePlaylist", playlist: popup.playlist } }))}
      </> : button("Подписаться", () => void mutate({ type: "followPlaylist", playlist: popup.playlist }))}
        {button("Создать копию", () => void mutate({ type: "clonePlaylist", playlist: popup.playlist }))}
      </div>}
      {(popup.kind === "editTrack" || popup.kind === "editPlaylist") && <form className="edit-music-form" onSubmit={e => {
        e.preventDefault(); const data = new FormData(e.currentTarget);
        if (popup.kind === "editTrack") void mutate({ type: "edit", track: popup.track, title: String(data.get("title")), artist: String(data.get("artist")) });
        else void mutate(popup.playlist ? { type: "editPlaylist", playlist: popup.playlist, title: String(data.get("title")), description: String(data.get("description")) } : { type: "createPlaylist", title: String(data.get("title")), description: String(data.get("description")) });
      }}>
        <label>Название<input name="title" required maxLength={200} defaultValue={popup.kind === "editTrack" ? popup.track.title : popup.playlist?.title} autoFocus /></label>
        {popup.kind === "editTrack" ? <label>Исполнитель<input name="artist" required maxLength={200} defaultValue={popup.track.artist} /></label> : <label>Описание<textarea name="description" maxLength={2000} defaultValue={popup.playlist?.description} /></label>}
        <button className="button primary" disabled={busy}>Сохранить</button>
      </form>}
      {popup.kind === "choosePlaylist" && <div className="menu-actions">{choices.length ? choices.map(item => button(item.title, () => void mutate({ type: "addToPlaylist", playlist: item, tracks: popup.tracks }))) : <p>Создайте свой плейлист в разделе «Плейлисты».</p>}</div>}
      {popup.kind === "text" && <><pre className="lyrics-text">{popup.text}</pre><button className="text-button" onClick={() => void api?.copyText(popup.text)}>Скопировать текст</button></>}
      {popup.kind === "qr" && <img className="track-qr" src={popup.image} alt="QR-код ссылки на трек" />}
      {popup.kind === "confirm" && <><p>Изменение сохранится в вашем аккаунте VK.</p><button className="button primary" disabled={busy} onClick={() => void mutate(popup.action)}>Удалить</button></>}
      {busy && <p role="status">Выполняется…</p>}
    </Modal>}
  </section>;
}
