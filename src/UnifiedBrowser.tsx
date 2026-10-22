import { useEffect, useState } from "react";
import { ArrowLeft, Pencil, Play, Plus, Trash2, X } from "lucide";
import type { MusicApi, UnifiedAction, UnifiedPlaylist } from "./shared";
import { trackKey, usePlayer, formatTime } from "./usePlayer";
import { Icon, IconButton } from "./ui";
import { Modal } from "./MusicBrowser";
import UnifiedPicker from "./UnifiedPicker";

export default function UnifiedBrowser({ api, player }: { api?: MusicApi; player: ReturnType<typeof usePlayer> }) {
  const [items, setItems] = useState<UnifiedPlaylist[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"create" | "rename" | "delete" | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const playlist = items.find(p => p.id === selected);
  async function act(action: UnifiedAction) {
    if (!api) return;
    setBusy(true); setError("");
    try { const r = await api.unified(action); if (r.ok) { setItems(r.data); setDialog(null); } else setError(r.error); }
    catch { setError("Не удалось сохранить плейлисты UniMusic."); } finally { setBusy(false); }
  }
  useEffect(() => { void act({ type: "list" }); }, [api]);
  return <section className="music-browser" aria-label="Коллекция UniMusic" aria-busy={busy}>
    <div className="section-heading"><div>{playlist && <button className="text-button back-button" onClick={() => setSelected(null)}><Icon icon={ArrowLeft} size={16} />Все плейлисты</button>}<h1>{playlist?.title ?? "UniMusic"}</h1></div>
      <div className="settings-actions">{playlist ? <><IconButton icon={Pencil} label="Переименовать плейлист" disabled={busy} onClick={() => { setName(playlist.title); setDialog("rename"); }} /><IconButton icon={Trash2} label="Удалить плейлист" disabled={busy} onClick={() => setDialog("delete")} /></> : <button className="button secondary" onClick={() => setDialog("create")}><Icon icon={Plus} size={18} />Новый плейлист</button>}</div>
    </div>
    {error && <p role="alert">{error}</p>}
    {!playlist ? <>{!items.length && <div className="empty-state"><p>Соберите треки VK и Яндекса в одном плейлисте.</p></div>}<div className="playlist-grid">{items.map(p => <button className="playlist-card unified-card" key={p.id} onClick={() => setSelected(p.id)}><div className="unified-mosaic" aria-hidden="true">{p.tracks.slice(0,4).map(t => <span key={trackKey(t)}>{t.title.slice(0,1)}</span>)}</div><strong>{p.title}</strong><span>{p.tracks.length} треков</span></button>)}</div></> : <>
      {!!playlist.tracks.length && <button className="button secondary" onClick={() => void player.start(playlist.tracks[0], playlist.tracks)}><Icon icon={Play} size={18} />Слушать</button>}
      {!playlist.tracks.length && <div className="empty-state"><p>Откройте VK или Яндекс и выберите у песни «Добавить в UniMusic».</p></div>}
      <div className="unified-tracks">{playlist.tracks.map(t => <div className="unified-track" key={trackKey(t)}><button className="unified-track-title" disabled={t.restricted} onClick={() => player.current && trackKey(player.current) === trackKey(t) ? player.toggle() : void player.start(t, playlist.tracks)}><strong>{t.title}</strong><span>{t.artist}</span></button><small>{t.source === "yandex" ? "Яндекс" : t.source === "local" ? "Файл" : "VK"}</small><span>{formatTime(t.duration)}</span><IconButton icon={X} label={`Убрать из плейлиста: ${t.title}`} disabled={busy} onClick={() => void act({ type: "remove", id: playlist.id, tracks: [t] })} /></div>)}</div>
    </>}
    {dialog && <Modal title={dialog === "create" ? "Новый плейлист UniMusic" : dialog === "rename" ? "Переименовать плейлист" : "Удалить плейлист?"} onClose={() => !busy && setDialog(null)}>
      {dialog === "create" ? <UnifiedPicker api={api} tracks={[]} onDone={() => void act({ type: "list" })} /> : dialog === "rename" ? <form className="unified-create" onSubmit={e => { e.preventDefault(); if (playlist) void act({ type: "rename", id: playlist.id, title: name }); }}><label>Название<input autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={120} /></label><button className="button primary" disabled={busy || !name.trim()}>Сохранить</button></form> : <><p>Плейлист «{playlist?.title}» будет удалён из UniMusic.</p><button className="button secondary" disabled={busy} onClick={() => playlist && void act({ type: "delete", id: playlist.id })}>Удалить</button></>}
      {error && <p role="alert">{error}</p>}
    </Modal>}
  </section>;
}
