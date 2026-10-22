import { useEffect, useState, type CSSProperties } from "react";
import MusicOrb from "./MusicOrb";
import { ORB_MODES, type OrbMode } from "./orbGeometry";
import type { AudioLevels } from "./audioLevels";
import { DEFAULT_PALETTE, loadArtwork, usesRgbLights } from "./artwork";
import { DEFAULT_LIGHT_SETTINGS, LIGHT_RANGES, validLightSettings, type LightSettings } from "./lightSettings";
import { DEFAULT_ORB_SETTINGS, ORB_RANGES, validOrbSettings, type OrbSettings } from "./orbSettings";

const LIGHT_DRIVER = { ...DEFAULT_ORB_SETTINGS, enabled: false };

export default function Settings({ mode, onMode, playing, readAudio, cover, respectMotion, onRespectMotion, lightsEnabled, onLightsEnabled, lightSettings, onLightSettings, orbSettings, onOrbSettings }: {
  mode: OrbMode; onMode: (mode: OrbMode) => void;
  playing: boolean; readAudio: () => AudioLevels; cover?: string;
  respectMotion: boolean; onRespectMotion: (value: boolean) => void;
  lightsEnabled: boolean; onLightsEnabled: (value: boolean) => void;
  lightSettings: LightSettings; onLightSettings: (value: LightSettings) => void;
  orbSettings: OrbSettings; onOrbSettings: (value: OrbSettings) => void;
}) {
  const [systemReduced, setSystemReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [palette, setPalette] = useState(DEFAULT_PALETTE);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReduced(media.matches);
    media.addEventListener("change", update); return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    let active = true;
    setPalette(DEFAULT_PALETTE);
    if (cover) void loadArtwork(cover).then(art => { if (active) setPalette(art.palette); }, () => {});
    return () => { active = false; };
  }, [cover]);
  const rgb = usesRgbLights(palette, lightSettings.colorMode);
  const lightStyle = {
    "--light-intensity": lightSettings.intensity, "--light-size": lightSettings.size, "--light-sensitivity": lightSettings.sensitivity,
    "--ambient-one": rgb ? "rgb(255 64 72)" : palette.primary, "--ambient-two": rgb ? "rgb(56 225 124)" : palette.secondary,
    "--ambient-three": rgb ? "rgb(66 104 255)" : palette.primary, "--ambient-four": rgb ? "rgb(177 77 255)" : palette.secondary,
  } as CSSProperties;
  return <div className="visual-settings">
    <section className="settings-card orb-settings-card" aria-labelledby="orb-settings-title">
      <div className="settings-card-heading">
        <div><h2 id="orb-settings-title">Orbs</h2><p>Форма, расположение и реакция на музыку</p></div>
        <div className="settings-card-actions"><button className="text-button" onClick={() => onOrbSettings({ ...DEFAULT_ORB_SETTINGS })}>По умолчанию</button>
          <Switch label="Показывать Orbs" checked={orbSettings.enabled} onChange={enabled => onOrbSettings({ ...orbSettings, enabled })} />
        </div>
      </div>
      <div className="orb-settings-layout">
        <fieldset className="orb-mode-fieldset" disabled={!orbSettings.enabled}>
          <legend>Режим Orbs</legend><div className="mode-gallery">
            {ORB_MODES.map(option => <label key={option.value} className={`mode-option ${mode === option.value ? "selected" : ""}`}>
              <div className="settings-preview" aria-hidden="true"><MusicOrb playing={playing && orbSettings.enabled} idle={orbSettings.enabled} mode={option.value} respectMotion={respectMotion} readAudio={readAudio} settings={orbSettings} /></div>
              <div className="mode-caption"><input type="radio" name="orb-mode" value={option.value} checked={mode === option.value} onChange={() => onMode(option.value)} aria-describedby={`mode-${option.value}-description`} /><strong>{option.title}</strong></div>
              <small id={`mode-${option.value}-description`}>{option.description}</small>
            </label>)}
          </div>
        </fieldset>
        <div><fieldset className="light-controls" disabled={!orbSettings.enabled} aria-label="Параметры Orbs">
          <div className="orb-placement"><label htmlFor="orb-placement">Расположение</label><select id="orb-placement" value={orbSettings.placement} onChange={event => onOrbSettings(validOrbSettings({ ...orbSettings, placement: event.target.value }))}><option value="circle">В круге</option><option value="background">На заднем плане</option></select></div>
          {([["sensitivity", "Чувствительность к звуку"], ["speed", "Скорость вращения"], ["opacity", "Непрозрачность"]] as const).map(([key, label]) =>
            <Range key={key} id={`orb-${key}`} label={label} value={orbSettings[key]} bounds={ORB_RANGES[key]} text={key === "speed" ? `${Number(orbSettings[key].toFixed(2))}×` : `${Math.round(orbSettings[key] * 100)}%`} onChange={value => onOrbSettings(validOrbSettings({ ...orbSettings, [key]: value }))} />)}
        </fieldset>
        <div className="motion-preferences"><label className="setting-toggle"><input type="checkbox" checked={respectMotion} onChange={event => onRespectMotion(event.target.checked)} /><span>Учитывать настройки анимации Windows</span></label>
          {systemReduced && respectMotion && <p className="settings-hint" role="status">В Windows уменьшено движение. Отключите эту настройку, чтобы включить анимацию Orbs.</p>}
        </div></div>
      </div>
    </section>
    <section className={`settings-card settings-lights-card visualizer ${playing ? "is-playing" : ""}`} style={lightStyle} data-light-colors={rgb ? "rgb" : "accent"} aria-labelledby="light-settings-title">
      {lightsEnabled && <><div className="ambient-lights" aria-hidden="true">{Array.from({ length: lightSettings.count }, (_, i) => <i key={i} />)}</div><MusicOrb className="settings-light-driver" playing={playing} readAudio={readAudio} respectMotion={respectMotion} lightSettings={lightSettings} settings={LIGHT_DRIVER} /></>}
      <div className="settings-light-content">
        <div className="settings-card-heading"><div><h2 id="light-settings-title">Фоновые огни</h2><p>Предпросмотр на фоне этого блока. Включите музыку, чтобы увидеть реакцию на звук.</p></div>
          <div className="settings-card-actions"><button className="text-button" onClick={() => { onLightSettings({ ...DEFAULT_LIGHT_SETTINGS }); onLightsEnabled(true); }}>По умолчанию</button><Switch label="Фоновые огни" checked={lightsEnabled} onChange={onLightsEnabled} /></div>
        </div>
        <fieldset className="light-controls" disabled={!lightsEnabled} aria-label="Параметры фоновых огней">
          <div className="orb-placement"><label htmlFor="light-color-mode">Цвет огней</label><select id="light-color-mode" value={lightSettings.colorMode} onChange={event => onLightSettings(validLightSettings({ ...lightSettings, colorMode: event.target.value }))}><option value="rgb">Полное RGB</option><option value="accent">Акцент</option></select><p className="settings-hint">{lightSettings.colorMode === "accent" ? "Из обложки; без неё и для чёрно-белой — RGB." : "Плавная смена всех оттенков."}</p></div>
          {([["count", "Количество"], ["intensity", "Интенсивность"], ["speed", "Скорость движения"], ["size", "Размер пятен"], ["sensitivity", "Реакция на музыку"]] as const).map(([key, label]) =>
            <Range key={key} id={`light-${key}`} label={label} value={lightSettings[key]} bounds={LIGHT_RANGES[key]} step={key === "count" ? 1 : .05} text={key === "count" ? String(lightSettings[key]) : key === "speed" ? `${Number(lightSettings[key].toFixed(2))}×` : `${Math.round(lightSettings[key] * 100)}%`} onChange={value => onLightSettings(validLightSettings({ ...lightSettings, [key]: value }))} />)}
        </fieldset>
      </div>
    </section>
  </div>;
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="setting-switch"><span className="sr-only">{label}</span><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /><span className="switch-track" aria-hidden="true" /></label>;
}

function Range({ id, label, value, bounds, text, step = .05, onChange }: {
  id: string; label: string; value: number; bounds: readonly [number, number]; text: string; step?: number; onChange: (value: number) => void;
}) {
  return <div className="light-control"><div><label htmlFor={id}>{label}</label><output htmlFor={id}>{text}</output></div><input id={id} type="range" min={bounds[0]} max={bounds[1]} step={step} value={value} aria-valuetext={text} onChange={event => onChange(event.target.valueAsNumber)} style={{ "--progress": `${(value - bounds[0]) / (bounds[1] - bounds[0]) * 100}%` } as CSSProperties} /></div>;
}
