export interface AudioLevels {
  level: number;
  bass: number;
  mids: number;
  treble: number;
}

export const SILENCE: AudioLevels = { level: 0, bass: 0, mids: 0, treble: 0 };

export function measureAudio(
  frequency: Float32Array,
  waveform: Float32Array,
  sampleRate: number,
  fftSize: number,
): AudioLevels {
  if (!frequency.length || !waveform.length || sampleRate <= 0 || fftSize <= 0)
    return SILENCE;
  const band = (low: number, high: number) => {
    const start = Math.max(1, Math.floor(low * fftSize / sampleRate));
    const end = Math.min(frequency.length, Math.ceil(high * fftSize / sampleRate));
    if (end <= start) return 0;
    let power = 0;
    for (let i = start; i < end; i++) {
      // Float FFT data preserves changes above the byte analyser's -30 dB ceiling.
      const amplitude = Number.isFinite(frequency[i]) ? 10 ** (Math.min(0, frequency[i]) / 20) : 0;
      power += amplitude * amplitude;
    }
    return Math.min(1, Math.sqrt(power) * 2);
  };
  let power = 0;
  for (const value of waveform) if (Number.isFinite(value)) power += value * value;
  return {
    level: Math.min(1, Math.sqrt(power / waveform.length) * 2.2),
    bass: band(20, 250), mids: band(250, 2000), treble: band(2000, 12000),
  };
}
