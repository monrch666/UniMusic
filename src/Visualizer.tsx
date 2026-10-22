import { trackKey } from "./playbackQueue";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { MorphIcon } from "morphicons/react";
import { LoaderCircle, Pause, Play, Radio, SkipBack, SkipForward } from "lucide";
import MusicOrb from "./MusicOrb";
import type { AudioLevels } from "./audioLevels";
import type { OrbMode } from "./orbGeometry";
import { DEFAULT_PALETTE, loadArtwork, usesRgbLights, type ArtworkPalette } from "./artwork";
import Lyrics from "./Lyrics";
import { Icon, IconButton } from "./ui";
import type { MusicApi, Track } from "./shared";
import type { LightSettings } from "./lightSettings";
import type { OrbSettings } from "./orbSettings";

interface Scene { key: string; title: string; artist: string; cover?: string; palette: ArtworkPalette }
const EMPTY: Scene = { key: "empty", title: "\u00a0", artist: "\u00a0", palette: DEFAULT_PALETTE };

export default function Visualizer({ lyricsOpen, onCloseLyrics, api, track, playing, loading, readAudio, mode, respectMotion, lightsEnabled, lightSettings, orbSettings, onBrowse, onToggle, onPrevious, onNext, onWave, waveLaunching, waveActive }: {
  lyricsOpen: boolean;
  onCloseLyrics: () => void;
  api?: MusicApi;
  track: Track | null;
  playing: boolean;
  loading: boolean;
  readAudio: () => AudioLevels;
  mode: OrbMode;
  respectMotion: boolean;
  lightsEnabled: boolean;
  lightSettings: LightSettings;
  orbSettings: OrbSettings;
  onBrowse: () => void;
  onToggle: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onWave: () => void;
  waveLaunching: boolean;
  waveActive: boolean;
}) {
  const [scenes, setScenes] = useState<{ current: Scene; previous?: Scene }>({ current: EMPTY });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let active = true;
    const next: Scene = track ? { key: trackKey(track), title: track.title, artist: track.artist, palette: DEFAULT_PALETTE } : EMPTY;
    const commit = (art?: { cover: string; palette: ArtworkPalette }) => {
      if (!active) return;
      clearTimeout(timer.current);
      setScenes(old => ({ current: { ...next, ...art }, previous: old.current.key !== next.key ? old.current : old.previous }));
      timer.current = setTimeout(() => setScenes(old => ({ current: old.current })), 950);
    };
    if (track?.cover) void loadArtwork(track.cover).then(commit, () => commit());
    else commit();
    return () => { active = false; };
  }, [track?.source, track?.id, track?.ownerId, track?.cover, track?.title, track?.artist]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const layers = [...(scenes.previous ? [{ scene: scenes.previous, previous: true }] : []), { scene: scenes.current, previous: false }];
  const palette = scenes.current.palette;
  const rgbLights = usesRgbLights(palette, lightSettings.colorMode);
  const style = { "--cover-accent": palette.primary, "--cover-secondary": palette.secondary,
    "--light-intensity": lightSettings.intensity, "--light-size": lightSettings.size, "--light-sensitivity": lightSettings.sensitivity,
    "--ambient-one": rgbLights ? "rgb(255 64 72)" : palette.primary,
    "--ambient-two": rgbLights ? "rgb(56 225 124)" : palette.secondary,
    "--ambient-three": rgbLights ? "rgb(66 104 255)" : palette.primary,
    "--ambient-four": rgbLights ? "rgb(177 77 255)" : palette.secondary,
  } as CSSProperties;
  const orb = <MusicOrb playing={playing} idle mode={mode} respectMotion={respectMotion} readAudio={readAudio} lightSettings={lightSettings} settings={orbSettings} />;
  return <section style={style} data-light-colors={rgbLights ? "rgb" : "accent"} data-motion={respectMotion ? "system" : "full"} className={`visualizer ${lyricsOpen ? "with-lyrics" : ""} ${playing ? "is-playing" : ""} ${!orbSettings.enabled ? "orbs-disabled" : ""} ${orbSettings.placement === "background" ? "orbs-background" : ""} ${scenes.current.cover || scenes.previous?.cover ? "has-cover" : ""}`} aria-label="Главный экран">
    <div className="album-backdrop" aria-hidden="true">{layers.map(({ scene, previous }) => scene.cover && <img key={scene.key} className={previous ? "is-previous" : "is-current"} src={scene.cover} alt="" />)}</div>
    {orbSettings.placement === "background" && <div className="background-orbs">{orb}</div>}
    {lightsEnabled && <div className="ambient-lights" aria-hidden="true">{Array.from({ length: lightSettings.count }, (_, i) => <i key={i} />)}</div>}
    <div className="listening-scene">
      <div className="caption-stack title-stack">{layers.map(({ scene, previous }) => <h1 key={scene.key} aria-hidden={previous || undefined} className={`song-title ${previous ? "is-previous" : "is-current"}`}>{scene.title}</h1>)}</div>
      <div className="orb-stage">
        <div className="orb-aura" aria-hidden="true" />
        <div className="orb-disc">
          <div className="orb-album" aria-hidden="true">{layers.map(({ scene, previous }) => scene.cover && <img key={scene.key} className={previous ? "is-previous" : "is-current"} src={scene.cover} alt="" />)}</div>
          {orbSettings.placement === "circle" && orb}
          <IconButton className="orb-previous" icon={SkipBack} label="Предыдущий трек у Orbs" disabled={!track} onClick={onPrevious} />
          <button className={`orb-play ${loading || waveLaunching ? "is-loading" : ""}`} onClick={track ? onToggle : onBrowse}
            aria-label={waveLaunching ? "Подбираем Мою волну" : loading ? "Загрузка трека" : track ? playing ? "Приостановить музыку" : "Воспроизвести музыку" : "Выбрать музыку"} disabled={loading || waveLaunching}>
            <MorphIcon icon={loading || waveLaunching ? LoaderCircle : playing ? Pause : Play} size={72} reducedMotion="user" aria-hidden="true" />
          </button>
          <IconButton className="orb-next" icon={SkipForward} label="Следующий трек у Orbs" disabled={!track} onClick={onNext} />
        </div>
      </div>
      <div className="caption-stack artist-stack">{layers.map(({ scene, previous }) => <p key={scene.key} aria-hidden={previous || undefined} className={`song-artist ${previous ? "is-previous" : "is-current"}`}>{scene.artist}</p>)}</div>
      <div className="wave-launch-slot" inert={waveActive || waveLaunching}><button className={`wave-launch ${waveLaunching || waveActive ? "is-leaving" : ""}`} disabled={waveLaunching || waveActive} aria-label="Включить Мою волну" onClick={onWave}><Icon icon={Radio} size={18} /><span>Моя волна</span></button></div>
    </div>
    {lyricsOpen && <Lyrics key={track ? trackKey(track) : "empty"} track={track} api={api} onClose={onCloseLyrics} />}
  </section>;
}
