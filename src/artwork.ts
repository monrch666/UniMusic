export interface ArtworkPalette { primary: string; secondary: string; rgbLights?: boolean }
export const DEFAULT_PALETTE: ArtworkPalette = { primary: "rgb(197 180 255)", secondary: "rgb(141 219 213)", rgbLights: true };
export const usesRgbLights = (palette: ArtworkPalette, mode: "accent" | "rgb") => mode === "rgb" || palette.rgbLights === true;

export function paletteFromPixels(pixels: Uint8ClampedArray): ArtworkPalette {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let visible = 0, colored = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const [r, g, b, a] = pixels.subarray(i, i + 4);
    if (a < 160) continue;
    visible++;
    const maximum = Math.max(r, g, b), minimum = Math.min(r, g, b);
    if (maximum < 24 || minimum > 235 || maximum - minimum < 18 || (maximum - minimum) / maximum < .12) continue;
    colored++;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count++; bucket.r += r; bucket.g += g; bucket.b += b;
    buckets.set(key, bucket);
  }
  const colors = [...buckets.values()].sort((a, b) => b.count - a.count)
    .map(c => [c.r / c.count, c.g / c.count, c.b / c.count]);
  if (!colors.length || colored / visible < .03) return DEFAULT_PALETTE;
  const primary = colors[0];
  const secondary = colors.find(c => Math.hypot(...c.map((v, i) => v - primary[i])) > 70)
    ?? primary.map(v => v * .6 + 255 * .4);
  const soften = (color: number[]) => {
    const lift = Math.max(1, 180 / Math.max(...color));
    return `rgb(${color.map(v => Math.round(v * lift * .7 + 130 * .3)).join(" ")})`;
  };
  return { primary: soften(primary), secondary: soften(secondary) };
}

export function loadArtwork(src: string): Promise<{ cover: string; palette: ArtworkPalette }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      let palette = DEFAULT_PALETTE;
      try {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (context) { context.drawImage(image, 0, 0, 32, 32); palette = paletteFromPixels(context.getImageData(0, 0, 32, 32).data); }
      } catch { /* Keep the artwork visible when pixel sampling is unavailable. */ }
      resolve({ cover: src, palette });
    };
    image.onerror = () => reject(new Error("Artwork unavailable"));
    image.src = src;
  });
}
