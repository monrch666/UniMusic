import { useState, type CSSProperties } from "react";
import { formatTime } from "./usePlayer";
import { seekTimeAt } from "./seek";

export default function SeekBar({ position, duration, disabled, onSeek }: {
  position: number; duration: number; disabled: boolean; onSeek: (value: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const hint = hover ?? (focused ? position : null);
  return <div className="seek-row">
    <span>{formatTime(position)}</span>
    <div className="seek-control" onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      setHover(seekTimeAt(event.clientX, rect.left, rect.width, duration));
    }} onPointerLeave={() => setHover(null)}>
      <input type="range" aria-label="Позиция воспроизведения" aria-valuetext={formatTime(position)} min={0} max={duration || 1} step={.1}
        value={Math.min(position, duration || 1)} onChange={event => onSeek(Number(event.target.value))} disabled={disabled}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={{ "--progress": `${duration ? position / duration * 100 : 0}%` } as CSSProperties} />
      {hint !== null && !disabled && <output className="seek-tooltip" aria-hidden="true" style={{ left: `${Math.max(4, Math.min(96, duration ? hint / duration * 100 : 0))}%` }}>{formatTime(hint)}</output>}
    </div>
    <span>{formatTime(duration)}</span>
  </div>;
}
