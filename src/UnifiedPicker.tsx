import { useEffect, useState } from "react";
import type { MusicApi, Track, UnifiedPlaylist } from "./shared";

export default function UnifiedPicker({ api, tracks, onDone }: { api?: MusicApi; tracks: Track[]; onDone: () => void }) {
  const [items, setItems] = useState<UnifiedPlaylist[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  useEffect(() => { let active = true;
    if (!api) { setBusy(false); return; }
    void api.unified({ type: "list" }).then(r => { if (active) { if (r.ok) setItems(r.data); else setError(r.error); } }, () => { if (active) setError("Не удалось открыть плейлисты."); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api]);
  async function add(id?: string) {
    if (!api || busy) return;
    setBusy(true); setError("");
    try {
      const r = await api.unified(id ? { type: "add", id, tracks } : { type: "create", title, tracks });
      if (r.ok) onDone(); else setError(r.error);
    } catch { setError("Не удалось сохранить плейлист."); } finally { setBusy(false); }
  }
  return <div aria-busy={busy}>
    {error && <p role="alert">{error}</p>}
    <div className="menu-actions">{items.map(p => <button className="menu-action" key={p.id} disabled={busy} onClick={() => void add(p.id)}>{p.title}<span>{p.tracks.length}</span></button>)}</div>
    <form className="unified-create" onSubmit={e => { e.preventDefault(); void add(); }}><label>Новый плейлист<input autoFocus value={title} onChange={e => setTitle(e.target.value)} maxLength={120} placeholder="Название" /></label><button className="button primary" disabled={busy || !title.trim()}>Создать{tracks.length ? " и добавить" : ""}</button></form>
  </div>;
}
