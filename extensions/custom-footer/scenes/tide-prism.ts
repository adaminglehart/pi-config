import { lightGlyph, spectralColor, type Palette } from "./spectral-color.js";
import type { Scene } from "./types.js";

const GLYPHS = " .·:░▒▓█";
const PALETTE: Palette = [
  [64, 148, 255], [83, 255, 222], [163, 113, 255],
  [255, 89, 163], [255, 165, 93], [255, 229, 154],
];

/** Keep Tide's underlying flow; add light on top rather than speed it up. */
export function renderTidePrism(width: number, seconds: number): string[] {
  const lines: string[] = [];
  const t = seconds;
  const span = Math.min(14, Math.max(5, width / 10));

  for (let row = 0; row < 4; row++) {
    let line = "";
    for (let col = 0; col < width; col++) {
      const u = (col + 0.5) / width;
      const x = u * span;
      const y = (row + 0.5) * 0.65;
      // These coordinates, field, and swell match the original Tide exactly.
      const warpX = x + 0.85 * Math.sin(y * 1.4 + t * 0.21)
        + 0.42 * Math.sin(x * 0.72 - y * 1.1 - t * 0.16);
      const warpY = y + 0.72 * Math.sin(x * 0.82 - t * 0.23)
        + 0.3 * Math.cos(x * 1.6 + y * 0.7 + t * 0.13);
      const field = Math.sin(warpX * 1.12 + warpY * 1.3)
        + 0.58 * Math.cos(warpX * 0.71 - warpY * 1.8 + t * 0.12);
      const phase = field * 1.9 + t * 0.18;
      const filament = Math.exp(-Math.pow(Math.sin(phase), 2) * 6);
      const body = (0.5 + 0.5 * Math.sin(field * 2 - t * 0.16)) * 0.45;
      const swell = 0.7 + 0.3 * Math.sin(warpX * 0.55 + warpY - t * 0.32);
      const edge = Math.min(1, u * 16, (1 - u) * 16);
      const base = (body + filament * 0.8) * swell;
      const colorPhase = field * 0.16 + u * 0.35 + row * 0.045 + t * 0.018;
      let intensity = base;
      let color = spectralColor(PALETTE, colorPhase);
      let pearl = filament * filament * 0.55;

      // A second, offset contour acts as a colored rim behind the main wave.
      const refraction = 0.18 * Math.sin(warpX * 1.8 - warpY + t * 0.38);
      const rim = Math.exp(-Math.pow(Math.sin(phase + 0.75 + refraction), 2) * 16);
      const glint = Math.pow(Math.max(0, Math.sin(
        warpX * 2.6 + warpY * 1.7 - t * 0.85,
      )), 12) * filament;
      const rimColor = spectralColor(PALETTE, colorPhase + 0.19);
      const blend = rim * 0.62;
      color = [
        color[0] * (1 - blend) + rimColor[0] * blend,
        color[1] * (1 - blend) + rimColor[1] * blend,
        color[2] * (1 - blend) + rimColor[2] * blend,
      ];
      intensity += rim * 0.22 * swell + glint * 0.18;
      pearl = Math.min(0.8, pearl + glint * 0.3);

      intensity = Math.min(1, intensity * edge);
      const glyph = GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(intensity * GLYPHS.length))]!;
      line += lightGlyph(glyph, [
        color[0] * (1 - pearl) + 232 * pearl,
        color[1] * (1 - pearl) + 255 * pearl,
        color[2] * (1 - pearl) + 248 * pearl,
      ], 0.32 + Math.min(1, intensity * 1.4) * 0.68);
    }
    lines.push(line + "\x1b[0m");
  }
  return lines;
}

const epoch = performance.now();
export const tidePrismScene: Scene = {
  name: "tide-prism",
  height: 4,
  render: (width) => renderTidePrism(width, (performance.now() - epoch) / 1000),
};
