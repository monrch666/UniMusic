import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PALETTE, paletteFromPixels, usesRgbLights } from "../src/artwork";

test("cover palette selects dominant and distinct secondary colors", () => {
  const pixels = new Uint8ClampedArray([220, 40, 20, 255, 220, 40, 20, 255, 30, 60, 230, 255]);
  assert.deepEqual(paletteFromPixels(pixels), { primary: "rgb(193 67 53)", secondary: "rgb(60 81 200)" });
});
test("transparent, monochrome and missing covers enable RGB lights", () => {
  for (const pixels of [[], [255, 20, 20, 0], [0, 0, 0, 255, 255, 255, 255, 255], [120, 120, 120, 255]])
    assert.deepEqual(paletteFromPixels(new Uint8ClampedArray(pixels)), DEFAULT_PALETTE);
  assert.equal(DEFAULT_PALETTE.rgbLights, true);
});

test("near-gray covers and monochrome artwork with a tiny color mark retain RGB lights", () => {
  const pixels = new Uint8ClampedArray(100 * 4);
  for (let i = 0; i < 100; i++) pixels.set([120, 124, 130, 255], i * 4);
  pixels.set([220, 40, 20, 255]);
  assert.equal(paletteFromPixels(pixels).rgbLights, true);
  pixels.set([220, 40, 20, 255], 4); pixels.set([220, 40, 20, 255], 8);
  assert.notEqual(paletteFromPixels(pixels).rgbLights, true);
});
test("single-color cover gets a related brighter secondary shade", () => {
  const palette = paletteFromPixels(new Uint8ClampedArray([30, 50, 200, 255]));
  assert.notEqual(palette.primary, palette.secondary);
  assert.notDeepEqual(palette, DEFAULT_PALETTE);
});
test("dark cover colors are lifted enough to illuminate the dark background", () => {
  const palette = paletteFromPixels(new Uint8ClampedArray([20, 40, 80, 255]));
  assert.equal(palette.primary, "rgb(71 102 165)");
});

test("Full RGB overrides colorful artwork and Accent retains automatic monochrome fallback", () => {
  const colorful = paletteFromPixels(new Uint8ClampedArray([220, 40, 20, 255]));
  const grayscale = paletteFromPixels(new Uint8ClampedArray([120, 120, 120, 255]));
  assert.equal(usesRgbLights(colorful, "accent"), false);
  assert.equal(usesRgbLights(colorful, "rgb"), true);
  assert.equal(usesRgbLights(grayscale, "accent"), true);
  assert.equal(usesRgbLights(DEFAULT_PALETTE, "accent"), true);
});
