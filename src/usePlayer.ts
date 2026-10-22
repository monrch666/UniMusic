import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { BrowseRequest, MusicApi, PlaybackSnapshot, Track } from "./shared";
import { measureAudio, SILENCE } from "./audioLevels";

import { insertNext, nextAfterFailure, orderedQueue, shuffledOrder, trackKey } from "./playbackQueue";
export { trackKey } from "./playbackQueue";
export function formatTime(seconds: number): string {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function usePlayer(
  api: MusicApi | undefined,
  onError: (message: string, code?: number) => void,
) {
  const [element] = useState(() => {
    const audio = new Audio();
    audio.crossOrigin = "anonymous";
    return audio;
  });
  const audio = useRef(element);
  const analysis = useRef<{
    context: AudioContext;
    analyser: AnalyserNode;
    gain: GainNode;
    equalizer: BiquadFilterNode[];
    frequency: Float32Array<ArrayBuffer>;
    waveform: Float32Array<ArrayBuffer>;
  } | null>(null);
  const hls = useRef<Hls | null>(null);
  const sequence = useRef(0);
  const needsReload = useRef(false);
  const wanted = useRef(false);
  const failed = useRef(new Set<string>());
  const retries = useRef(0);
  const watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const failPlayback = useRef<(retryable: boolean, message: string, code?: number) => void>(() => {});
  const expectedDuration = useRef(0);
  const lastProgress = useRef(0);
  const listening = useRef({ seconds: 0, at: 0, position: 0 });
  const nextOnEnd = useRef(() => {});
  const [current, setCurrent] = useState<Track | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const queueRef = useRef<Track[]>([]);
  const order = useRef<string[]>([]);
  const source = useRef<{ request?: BrowseRequest; loaded: number; total: number }>({ loaded: 0, total: 0 });
  const [queueTotal, setQueueTotal] = useState(0);
  const [queueLoading, setQueueLoading] = useState(false);
  const filling = useRef(false);
  const hydrated = useRef(false);
  const restoredPosition = useRef(0);
  const [notice, setNotice] = useState("");
  const equalizerValues = useRef([0, 0, 0, 0, 0]);
  const preparing = useRef("");
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<"off" | "all" | "one">("off");
  const playbackMode = useRef({ repeat, shuffle });
  playbackMode.current = { repeat, shuffle };
  const latest = useRef({ current, position, shuffle, repeat });
  latest.current = { current, position, shuffle, repeat };
  const [muted, setMuted] = useState(false);
  const [volume, setVolumeState] = useState(() => {
    try {
      const saved = localStorage.getItem("unimusic-volume");
      return saved !== null && Number.isFinite(Number(saved))
        ? Math.min(1, Math.max(0, Number(saved)))
        : 0.7;
    } catch {
      return 0.7;
    }
  });

  function clearWatchdog() {
    clearTimeout(watchdog.current);
    watchdog.current = undefined;
  }
  function watchLoading() {
    if (!wanted.current) return;
    setLoading(true);
    if (watchdog.current !== undefined) return;
    watchdog.current = setTimeout(() => {
      watchdog.current = undefined;
      if (wanted.current) failPlayback.current(false, "Трек не загрузился за 20 секунд.");
    }, 20_000);
  }

  useEffect(() => {
    const element = audio.current;
    const time = () => {
      const now = performance.now();
      if (!element.paused && !element.seeking && element.readyState >= 2 && listening.current.at)
        listening.current.seconds += Math.max(0, Math.min(element.currentTime - listening.current.position, (now - listening.current.at) / 1000));
      listening.current.at = now; listening.current.position = element.currentTime;
      setPosition(element.currentTime);
      if (!element.paused && !element.seeking && element.readyState >= 2 && Math.abs(element.currentTime - lastProgress.current) > .03) {
        clearWatchdog();
        setLoading(false);
      }
      lastProgress.current = element.currentTime;
    };
    const metadata = () => {
      if (Number.isFinite(element.duration) && element.duration > 0) setDuration(element.duration);
    };
    const play = () => {
      listening.current.at = performance.now(); listening.current.position = element.currentTime;
      resumeAudio();
      clearWatchdog();
      setPlaying(true);
      setLoading(false);
    };
    const pause = () => setPlaying(false);
    const wait = () => watchLoading();
    const ready = () => setLoading(false);
    const error = () => {
      if (!hls.current && wanted.current)
        failPlayback.current(element.error?.code !== MediaError.MEDIA_ERR_DECODE, "Не удалось воспроизвести запись.");
    };
    const ended = () => {
      clearWatchdog();
      if (expectedDuration.current > 15 && element.duration < expectedDuration.current * .8)
        failPlayback.current(true, "Музыкальный сервис вернул неполную запись.");
      else nextOnEnd.current();
    };
    const events = {
      timeupdate: time,
      loadedmetadata: metadata,
      durationchange: metadata,
      playing: play,
      pause,
      waiting: wait,
      stalled: wait,
      canplay: ready,
      error,
      ended,
    };
    for (const [name, handler] of Object.entries(events))
      element.addEventListener(name, handler);
    return () => {
      sequence.current++;
      wanted.current = false;
      clearWatchdog();
      for (const [name, handler] of Object.entries(events))
        element.removeEventListener(name, handler);
      element.pause();
      hls.current?.destroy();
      void analysis.current?.context.close();
      element.removeAttribute("src");
      element.load();
    };
  }, [onError]);

  useEffect(() => {
    const graph = analysis.current;
    if (graph) {
      graph.gain.gain.setTargetAtTime(muted ? 0 : volume, graph.context.currentTime, .015);
      audio.current.volume = 1;
      audio.current.muted = false;
    } else {
      audio.current.volume = volume;
      audio.current.muted = muted;
    }
    try {
      localStorage.setItem("unimusic-volume", String(volume));
    } catch {
      /* Preferences are optional. */
    }
  }, [volume, muted]);

  function resumeAudio() {
    if (!analysis.current) {
      try {
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = .35;
        const gain = context.createGain();
        gain.gain.value = element.muted ? 0 : element.volume;
        // Analyse the original stream; output volume must not flatten the visualization.
        const source = context.createMediaElementSource(element);
        source.connect(analyser);
        const equalizer = [60, 230, 910, 3600, 14000].map(frequency => {
          const filter = context.createBiquadFilter(); filter.type = "peaking"; filter.frequency.value = frequency; filter.Q.value = 1;
          return filter;
        });
        analyser.connect(equalizer[0]);
        equalizer.forEach((filter, i) => {
          filter.gain.value = equalizerValues.current[i];
          filter.connect(equalizer[i + 1] ?? gain);
        });
        gain.connect(context.destination);
        element.volume = 1;
        element.muted = false;
        analysis.current = {
          context, analyser, gain, equalizer,
          frequency: new Float32Array(analyser.frequencyBinCount),
          waveform: new Float32Array(analyser.fftSize),
        };
      } catch { /* Playback remains available when Web Audio is unavailable. */ }
    }
    void analysis.current?.context.resume().catch(() => {});
  }

  const readAudio = useCallback(() => {
    const graph = analysis.current;
    if (!graph || graph.context.state !== "running" || element.paused) return SILENCE;
    graph.analyser.getFloatFrequencyData(graph.frequency);
    graph.analyser.getFloatTimeDomainData(graph.waveform);
    return measureAudio(graph.frequency, graph.waveform, graph.context.sampleRate, graph.analyser.fftSize);
  }, [element]);

  function updateQueue(tracks: Track[]) {
    queueRef.current = tracks;
    setQueue(tracks);
  }
  async function loadMoreQueue(): Promise<void> {
    if (!api || filling.current || !source.current.request || source.current.loaded >= source.current.total) return;
    filling.current = true; setQueueLoading(true);
    const origin = source.current;
    try {
      const result = await api.browse({ ...origin.request!, offset: origin.loaded });
      if (origin !== source.current) return;
      if (!result.ok) { onError(result.error, result.code); return; }
      origin.loaded += result.data.tracks.length;
      origin.total = result.data.tracks.length ? result.data.count : origin.loaded;
      const existing = new Set(queueRef.current.map(trackKey));
      const added = result.data.tracks.filter(t => !existing.has(trackKey(t)));
      if (!added.length) origin.total = origin.loaded;
      order.current.push(...(playbackMode.current.shuffle ? shuffledOrder(added) : added.map(trackKey)));
      updateQueue([...queueRef.current, ...added]);
      setQueueTotal(Math.max(origin.total, queueRef.current.length));
    } catch { onError("Не удалось догрузить очередь. Повторите переход к следующему треку."); }
    finally { filling.current = false; setQueueLoading(false); }
  }
  async function start(track: Track, tracks = queueRef.current, options: { legacy?: boolean; retry?: boolean; resumeAt?: number; automatic?: boolean; source?: BrowseRequest; total?: number } = {}) {
    if (!api) return;
    if (!options.retry) listening.current = { seconds: 0, at: 0, position: 0 };
    if (tracks !== queueRef.current) {
      source.current = { request: options.source, loaded: tracks.length, total: options.total ?? tracks.length };
      setQueueTotal(source.current.total);
      order.current = playbackMode.current.shuffle ? shuffledOrder(tracks, trackKey(track)) : tracks.map(trackKey);
      updateQueue(tracks);
    }
    hydrated.current = true;
    restoredPosition.current = 0;
    if (!options.retry) {
      clearWatchdog();
      retries.current = 0;
      if (!options.automatic) failed.current.clear();
    }
    wanted.current = true;
    resumeAudio();
    const request = ++sequence.current;
    failPlayback.current = (retryable, message, code) => {
      if (request !== sequence.current || !wanted.current) return;
      const globalError = code !== undefined && [5, 6, 9, 14, 17, 29, 401, 402, 429].includes(code);
      if (!globalError && retryable && retries.current < 1) {
        retries.current++;
        watchLoading();
        void start(track, queueRef.current, { legacy: true, retry: true, resumeAt: audio.current.currentTime });
        return;
      }
      clearWatchdog();
      sequence.current++;
      hls.current?.destroy();
      hls.current = null;
      audio.current.pause();
      audio.current.removeAttribute("src");
      audio.current.load();
      needsReload.current = true;
      setPlaying(false);
      setLoading(false);
      failed.current.add(trackKey(track));
      const ordered = playbackMode.current.shuffle ? orderedQueue(queueRef.current, order.current) : queueRef.current;
      const next = !globalError && nextAfterFailure(ordered, track, failed.current, playbackMode.current.repeat === "all", false);
      setNotice(`Пропущено: ${track.artist} — ${track.title}. ${message}`);
      if (next) void start(next, queueRef.current, { automatic: true });
      else if (!globalError && !(source.current.request?.source === "yandex" && source.current.request.kind === "recommendations") && source.current.loaded < source.current.total) {
        const failedRequest = sequence.current;
        void loadMoreQueue().then(() => {
          if (failedRequest !== sequence.current || !wanted.current) return;
          const remaining = playbackMode.current.shuffle ? orderedQueue(queueRef.current, order.current) : queueRef.current;
          const candidate = nextAfterFailure(remaining, track, failed.current, false, false);
          if (candidate) void start(candidate, queueRef.current, { automatic: true });
          else { wanted.current = false; onError(`«${track.title}»: ${message}`); }
        });
      }
      else {
        wanted.current = false;
        onError(globalError ? message : `«${track.title}»: ${message} Следующих доступных треков нет.`, code);
      }
    };
    needsReload.current = false;
    audio.current.pause();
    hls.current?.destroy();
    hls.current = null;
    audio.current.removeAttribute("src");
    audio.current.load();
    updateQueue(tracks);
    setCurrent(track);
    lastProgress.current = options.resumeAt ?? 0;
    setPosition(options.resumeAt ?? 0);
    setDuration(track.duration);
    expectedDuration.current = track.duration;
    watchLoading();
    let response: Awaited<ReturnType<MusicApi["resolveTrack"]>>;
    try { response = await api.resolveTrack(track, options.legacy); }
    catch {
      if (request === sequence.current) failPlayback.current(true, "Нет соединения с музыкальным сервисом.");
      return;
    }
    if (request !== sequence.current) return;
    if (!response.ok) {
      failPlayback.current(false, response.error, response.code);
      return;
    }
    const resolved = response.data;
    setCurrent(resolved);
    const element = audio.current;
    if (options.resumeAt) {
      element.addEventListener("loadedmetadata", () => {
        if (request === sequence.current && Number.isFinite(element.duration))
          element.currentTime = Math.min(options.resumeAt!, Math.max(0, element.duration - .1));
      }, { once: true });
    }
    if (/\.m3u8(?:\?|$)/i.test(resolved.url) && Hls.isSupported()) {
      // Chromium advertises native HLS but cannot reliably play every VK stream.
      const stream = new Hls({ maxBufferLength: 30, startPosition: options.resumeAt ?? -1 });
      hls.current = stream;
      let decoderRecovered = false;
      stream.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || request !== sequence.current) return;
        void api.reportPlaybackError({ type: data.type, detail: data.details, status: data.response?.code ?? 0 }).catch(() => {});
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !decoderRecovered) {
          decoderRecovered = true;
          watchLoading();
          stream.recoverMediaError();
          return;
        }
        failPlayback.current(data.type === Hls.ErrorTypes.NETWORK_ERROR,
          data.response?.code === 403 ? "VK запретил доступ к аудиопотоку."
            : data.type === Hls.ErrorTypes.NETWORK_ERROR ? "Не удалось загрузить аудиопоток VK."
            : "Не удалось прочитать формат аудиопотока VK.");
      });
      stream.attachMedia(element);
      stream.loadSource(resolved.url);
    } else {
      if (/\.m3u8(?:\?|$)/i.test(resolved.url) && !element.canPlayType("application/vnd.apple.mpegurl")) {
        failPlayback.current(false, "Этот формат потока не поддерживается.");
        return;
      }
      element.src = resolved.url;
    }
    try {
      await element.play();
    } catch (error) {
      if (
        request === sequence.current &&
        !(error instanceof DOMException && error.name === "AbortError")
      ) {
        if (!hls.current) failPlayback.current(element.error?.code !== MediaError.MEDIA_ERR_DECODE, "Воспроизведение не началось.");
      }
      return;
    }
    if (request !== sequence.current) return;
    void api.played?.(resolved).catch(() => {});
    if (!options.retry && source.current.request?.source === "yandex" && source.current.request.kind === "recommendations") void api.waveFeedback(resolved, "trackStarted", 0).catch(() => {});
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: resolved.title,
        artist: resolved.artist,
        album: resolved.album,
        artwork: resolved.cover ? [{ src: resolved.cover }] : [],
      });
    }
    return true;
  }

  function toggle() {
    const element = audio.current;
    if (!current) return;
    if (element.paused) {
      wanted.current = true;
      watchLoading();
      resumeAudio();
      if (!element.src || needsReload.current) {
        void start(current, queueRef.current, { resumeAt: restoredPosition.current || position });
        return;
      }
      void element
        .play()
        .catch(() => failPlayback.current(true, "Не удалось продолжить воспроизведение."));
    } else {
      wanted.current = false;
      clearWatchdog();
      element.pause();
      setLoading(false);
    }
  }
  async function next(ended = false) {
    if (!current || !queueRef.current.length) return;
    if (ended && repeat === "one") {
      audio.current.currentTime = 0;
      void audio.current
        .play()
        .catch(() => onError("Не удалось повторить запись."));
      return;
    }
    const before = sequence.current;
    if (api && source.current.request?.source === "yandex" && source.current.request.kind === "recommendations") {
      await api.waveFeedback(current, ended ? "trackFinished" : "skip", listening.current.seconds).catch(() => {});
      if (before !== sequence.current) return;
    }
    let active = shuffle ? orderedQueue(queueRef.current, order.current) : queueRef.current;
    let index = active.findIndex(
      (track) => trackKey(track) === trackKey(current),
    );
    if (index >= active.length - 2 && source.current.loaded < source.current.total) {
      await loadMoreQueue();
      if (before !== sequence.current) return;
      active = shuffle ? orderedQueue(queueRef.current, order.current) : queueRef.current;
      index = active.findIndex(t => trackKey(t) === trackKey(current));
    }
    const target = active[index + 1] ?? (repeat === "all" ? active[0] : undefined);
    if (target) void start(target);
    else if (ended) { wanted.current = false; setPlaying(false); }
  }
  function previous() {
    if (!current) return;
    if (audio.current.currentTime > 3) {
      audio.current.currentTime = 0;
      return;
    }
    const active = shuffle ? orderedQueue(queueRef.current, order.current) : queueRef.current;
    const index = active.findIndex(
      (track) => trackKey(track) === trackKey(current),
    );
    const target =
      active[index - 1] ?? (repeat === "all" ? active.at(-1) : undefined);
    if (target) void start(target);
    else audio.current.currentTime = 0;
  }
  function reset() {
    wanted.current = false;
    clearWatchdog();
    failed.current.clear();
    failPlayback.current = () => {};
    sequence.current++;
    hls.current?.destroy();
    hls.current = null;
    audio.current.pause();
    audio.current.removeAttribute("src");
    audio.current.load();
    setCurrent(null);
    updateQueue([]);
    source.current = { loaded: 0, total: 0 };
    order.current = [];
    hydrated.current = false;
    restoredPosition.current = 0;
    setQueueTotal(0);
    setPosition(0);
    setDuration(0);
    setLoading(false);
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
  }
  function seek(value: number) {
    const limit = audio.current.duration;
    if (Number.isFinite(limit) && limit > 0) {
      audio.current.currentTime = Math.max(0, Math.min(limit, value));
      setPosition(audio.current.currentTime);
    }
  }
  nextOnEnd.current = () => next(true);
  useEffect(() => {
    if (!current || !playing || duration <= 0 || position < duration - 8 || repeat === "one") return;
    const active = shuffle ? orderedQueue(queueRef.current, order.current) : queueRef.current;
    const index = active.findIndex(t => trackKey(t) === trackKey(current));
    const target = active[index + 1] ?? (repeat === "all" ? active[0] : undefined);
    const key = target ? `${trackKey(current)}:${trackKey(target)}` : "";
    if (!target || preparing.current === key) return;
    preparing.current = key;
    void api?.prepareTrack?.(target).catch(() => {});
  }, [current, playing, duration, position, repeat, shuffle, api]);

  async function restore() {
    reset();
    const request = sequence.current;
    const response = await api?.playback?.();
    if (request !== sequence.current) return;
    if (response?.ok && response.data) {
      const saved = response.data;
      updateQueue(saved.queue);
      order.current = saved.order;
      source.current = { request: saved.source, loaded: saved.loaded, total: saved.total };
      setQueueTotal(saved.total);
      setCurrent(saved.queue.find(t => trackKey(t) === saved.currentKey) ?? null);
      setPosition(saved.position); restoredPosition.current = saved.position;
      setDuration(saved.queue.find(t => trackKey(t) === saved.currentKey)?.duration ?? 0);
      setShuffle(saved.shuffle); setRepeat(saved.repeat);
      needsReload.current = true;
    }
    hydrated.current = true;
  }
  useEffect(() => {
    const save = () => {
      if (!hydrated.current || !api?.playback) return;
      const value = latest.current;
      const snapshot: PlaybackSnapshot = {
        queue: queueRef.current, currentKey: value.current ? trackKey(value.current) : "",
        position: audio.current.src ? audio.current.currentTime : value.position,
        shuffle: value.shuffle, repeat: value.repeat, order: order.current,
        source: source.current.request, loaded: source.current.loaded, total: source.current.total,
      };
      void api.playback(snapshot).catch(() => {});
    };
    const timer = setInterval(save, 3000);
    window.addEventListener("beforeunload", save);
    return () => { clearInterval(timer); window.removeEventListener("beforeunload", save); save(); };
  }, [api]);
  useEffect(() => api?.onCommand?.(command => {
    if (command === "toggle") toggle();
    if (command === "next") void next();
    if (command === "previous") previous();
  }));

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const handlers: Partial<
      Record<MediaSessionAction, MediaSessionActionHandler>
    > = {
      play: () => { if (audio.current.paused) toggle(); },
      pause: () => {
        wanted.current = false;
        clearWatchdog();
        audio.current.pause();
        setLoading(false);
      },
      nexttrack: () => next(),
      previoustrack: previous,
      seekto: (details) => {
        if (details.seekTime !== undefined) seek(details.seekTime);
      },
    };
    for (const [name, handler] of Object.entries(handlers))
      navigator.mediaSession.setActionHandler(
        name as MediaSessionAction,
        handler,
      );
    return () => {
      for (const name of Object.keys(handlers))
        navigator.mediaSession.setActionHandler(
          name as MediaSessionAction,
          null,
        );
    };
  });

  return {
    readAudio,
    current,
    isWave: source.current.request?.source === "yandex" && source.current.request.kind === "recommendations",
    queue: shuffle ? orderedQueue(queue, order.current) : queue,
    queueTotal, queueLoading, notice, clearNotice: () => setNotice(""),
    playing,
    loading,
    position,
    duration,
    shuffle,
    repeat,
    muted,
    volume,
    start,
    toggle,
    next,
    previous,
    reset,
    restore,
    seek,
    enqueueNext: (track: Track) => {
      const active = shuffle ? orderedQueue(queueRef.current, order.current) : queueRef.current;
      const result = insertNext(active, current, track);
      order.current = result.map(trackKey); updateQueue(result);
      setQueueTotal(Math.max(source.current.total, result.length));
    },
    removeFromQueue: (key: string) => {
      if (current && trackKey(current) === key) return;
      updateQueue(queueRef.current.filter(t => trackKey(t) !== key));
      order.current = order.current.filter(k => k !== key);
    },
    moveInQueue: (key: string, direction: -1 | 1) => {
      const active = shuffle ? orderedQueue(queueRef.current, order.current) : [...queueRef.current];
      const index = active.findIndex(t => trackKey(t) === key); const target = index + direction;
      if (index < 0 || target < 0 || target >= active.length) return;
      [active[index], active[target]] = [active[target], active[index]];
      order.current = active.map(trackKey); updateQueue(active);
    },
    setEqualizer: (values: number[]) => {
      equalizerValues.current = values;
      analysis.current?.equalizer.forEach((filter, i) => filter.gain.setTargetAtTime(values[i] ?? 0, analysis.current!.context.currentTime, .03));
    },
    toggleShuffle: () => {
      order.current = !shuffle ? shuffledOrder(queueRef.current, current ? trackKey(current) : undefined) : queueRef.current.map(trackKey);
      setShuffle(value => !value);
    },
    cycleRepeat: () =>
      setRepeat((value) =>
        value === "off" ? "all" : value === "all" ? "one" : "off",
      ),
    toggleMute: () => setMuted((value) => !value),
    setVolume: (value: number) => {
      setMuted(false);
      setVolumeState(value);
    },
  };
}
