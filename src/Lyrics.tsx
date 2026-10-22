import { useEffect, useRef, useState } from "react";
import { X } from "lucide";
import { IconButton } from "./ui";
import type { MusicApi, Track } from "./shared";

export default function Lyrics({ track, api, onClose }: { track: Track | null; api?: MusicApi; onClose: () => void }) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    region.current?.focus({ preventScroll: true });
    if (!track || !api || track.source === "local") {
      setText("Для этого трека текст недоступен."); setLoading(false); return;
    }
    void api.lyrics(track).then(result => {
      if (active) setText(result.ok ? result.data || "Текст песни пока не найден." : result.error);
    }, () => { if (active) setText("Не удалось загрузить текст песни. Закройте и откройте его ещё раз."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [track?.id, track?.ownerId, track?.source, api]);
  return <aside ref={region} className="scene-lyrics" aria-label="Текст текущей песни" tabIndex={-1} onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); document.querySelector<HTMLButtonElement>('.player-options [aria-label="Текст песни"]')?.focus(); }
  }}>
    <IconButton icon={X} label="Закрыть текст песни" onClick={() => { onClose(); document.querySelector<HTMLButtonElement>('.player-options [aria-label="Текст песни"]')?.focus(); }} />
    <div className="scene-lyrics-scroll" tabIndex={0} aria-label="Строки песни" aria-busy={loading}>
      {loading ? <p role="status">Загружаем текст…</p> : <p className="scene-lyrics-text">{text}</p>}
    </div>
  </aside>;
}
