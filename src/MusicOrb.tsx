import { useEffect, useRef } from "react";
import { MODE_FRAMES, resolvePreset } from "thinking-orbs/engine";
import { SILENCE, type AudioLevels } from "./audioLevels";
import { deformOrbPoint, ORB_MODES, type OrbMode } from "./orbGeometry";
import { advanceLightMotion, createLightMotion } from "./lightMotion";
import { DEFAULT_LIGHT_SETTINGS, type LightSettings } from "./lightSettings";
import { DEFAULT_ORB_SETTINGS, type OrbSettings } from "./orbSettings";

export default function MusicOrb({
  playing, readAudio, mode = "orbits", respectMotion = true, idle = false, className = "", lightSettings = DEFAULT_LIGHT_SETTINGS, settings = DEFAULT_ORB_SETTINGS,
}: {
  playing: boolean;
  readAudio: () => AudioLevels;
  mode?: OrbMode;
  respectMotion?: boolean;
  idle?: boolean;
  className?: string;
  lightSettings?: Readonly<LightSettings>;
  settings?: Readonly<OrbSettings>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const phase = useRef(1.6);
  const levels = useRef<AudioLevels>({ ...SILENCE });
  const lightMotion = useRef(createLightMotion());

  useEffect(() => {
    const node = canvas.current!;
    const ctx = node.getContext("2d");
    if (!ctx) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const preset = resolvePreset(ORB_MODES.find(option => option.value === mode)!.state, 64);
    let visible = true;
    let request = 0;
    let last = 0;
    const size = 480;

    function draw(now: number) {
      request = 0;
      const reduced = respectMotion && motion.matches;
      const animate = (playing || idle) && !reduced && !document.hidden && visible;
      if (animate && now - last < 32) { request = requestAnimationFrame(draw); return; }
      const delta = last ? Math.min(.1, (now - last) / 1000) : 1 / 30;
      last = now;
      const target = playing && !reduced ? readAudio() : SILENCE;
      for (const key of ["level", "bass", "mids", "treble"] as const) {
        const current = levels.current[key];
        levels.current[key] = animate ? current + (target[key] - current) * (1 - Math.exp(-delta / (target[key] > current ? .035 : .18))) : 0;
      }
      const signal = levels.current;
      const orbSignal = { level: Math.min(1, signal.level * settings.sensitivity), bass: Math.min(1, signal.bass * settings.sensitivity), mids: Math.min(1, signal.mids * settings.sensitivity), treble: Math.min(1, signal.treble * settings.sensitivity) };
      if (animate && settings.enabled) phase.current += delta * preset.speed * .18 * settings.speed;
      ctx!.clearRect(0, 0, size, size);
      // Keep the shared FFT/light loop running when only the particles are disabled.
      if (settings.enabled) {
        const frame = MODE_FRAMES[preset.mode](size, phase.current, preset.opts);
        ctx!.globalAlpha = settings.opacity;
        for (const line of frame.lines) {
          ctx!.strokeStyle = `rgba(160,179,226,${(line.a ?? 1) * (.3 + orbSignal.level * .35)})`;
          ctx!.lineWidth = line.w * (1 + orbSignal.level * .7);
          const start = deformOrbPoint(line.x1, line.y1, size, phase.current, orbSignal);
          const end = deformOrbPoint(line.x2, line.y2, size, phase.current, orbSignal);
          ctx!.beginPath(); ctx!.moveTo(...start); ctx!.lineTo(...end); ctx!.stroke();
        }
        for (const dot of frame.dots) {
          const [x, y] = deformOrbPoint(dot.x, dot.y, size, phase.current, orbSignal);
          const depth = Math.max(0, Math.min(1, 1 - dot.white));
          const alpha = Math.min(1, (dot.a ?? 1) * (.16 + depth * .84) * (1 + orbSignal.level * .65));
          ctx!.fillStyle = `rgba(${Math.round(150 + depth * 94)},${Math.round(167 + depth * 65)},255,${alpha})`;
          ctx!.beginPath();
          ctx!.arc(x, y, Math.max(.45, dot.r * (1 + orbSignal.treble * .85)), 0, Math.PI * 2);
          ctx!.fill();
        }
      }
      node.style.setProperty("--energy", String(signal.level));
      node.dataset.energy = signal.level.toFixed(3);
      node.dataset.motion = animate ? "running" : "still";
      node.dataset.mode = mode;
      const panel = node.closest<HTMLElement>(".visualizer");
      if (panel) for (const key of ["level", "bass", "mids", "treble"] as const)
        panel.style.setProperty(`--${key}`, String(signal[key]));
      const lights = panel?.querySelectorAll<HTMLElement>(".ambient-lights i");
      if (lights?.length) {
        const positions = advanceLightMotion(lightMotion.current, signal, animate ? delta : 0, lightSettings);
        lights.forEach((light, i) => {
          const p = positions[i];
          if (!p) return;
          light.style.transform = `translate3d(${p.x.toFixed(3)}%, ${p.y.toFixed(3)}%, 0) rotate(${p.rotate.toFixed(3)}deg)`;
          if (panel?.dataset.lightColors === "rgb") light.style.setProperty("--light-color", `hsl(${p.hue.toFixed(2)} 82% 62%)`);
          else light.style.removeProperty("--light-color");
        });
      }
      if (animate) request = requestAnimationFrame(draw);
    }
    function restart() {
      cancelAnimationFrame(request); last = 0;
      request = requestAnimationFrame(draw);
    }
    const resize = new ResizeObserver(() => {
      const pixels = Math.max(1, Math.round(node.clientWidth * Math.min(devicePixelRatio || 1, 2)));
      node.width = node.height = pixels;
      ctx.setTransform(pixels / size, 0, 0, pixels / size, 0, 0);
      restart();
    });
    const intersection = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; restart(); });
    resize.observe(node); intersection.observe(node.closest(".visualizer") ?? node);
    motion.addEventListener("change", restart);
    document.addEventListener("visibilitychange", restart);
    restart();
    return () => {
      cancelAnimationFrame(request); resize.disconnect(); intersection.disconnect();
      motion.removeEventListener("change", restart);
      document.removeEventListener("visibilitychange", restart);
    };
  }, [playing, readAudio, idle, mode, respectMotion, lightSettings, settings]);

  return <canvas ref={canvas} className={`music-orb ${className}`} role="img" aria-hidden={!settings.enabled || undefined} aria-label="Сфера из частиц, реагирующая на музыку" />;
}
