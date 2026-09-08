import { BrailleCanvas } from "./braille-canvas.js";
import { spectralColor, type Palette } from "./spectral-color.js";
import type { Scene } from "./types.js";

const PALETTE: Palette = [
  [66, 255, 186], [72, 222, 255], [124, 106, 255],
  [244, 100, 225], [255, 188, 130],
];

/** Counter-rotating spiral arms: curls turn through one another, not just sway. */
export function renderAuroraVortex(width: number, seconds: number): string[] {
  const canvas = new BrailleCanvas(width);
  // Give each curl enough intermediate frames at the footer's 80 ms cadence.
  const t = seconds * 0.7;
  const span = Math.max(8, Math.min(28, width / 5));
  const vortices = Array.from({ length: 4 }, (_, i) => ({
    x: span * ((i + 0.5) / 4 + 0.045 * Math.sin(t * 0.23 + i * 1.7)),
    y: 2 + 0.72 * Math.sin(t * 0.31 + i * 2.2),
    radius: span / 7 + 0.3 * Math.sin(t * 0.37 + i),
    spin: i % 2 === 0 ? 1 : -1,
    phase: i * 1.8,
    color: spectralColor(PALETTE, i * 0.24 + t * 0.018),
  }));

  for (let py = 0; py < canvas.dotHeight; py++) {
    const y = (py + 0.5) / 4;
    for (let px = 0; px < canvas.dotWidth; px++) {
      const u = (px + 0.5) / canvas.dotWidth;
      const x = u * span;
      const edge = Math.min(1, u * 18, (1 - u) * 18);
      for (const vortex of vortices) {
        const dx = x - vortex.x;
        const dy = (y - vortex.y) * 1.5;
        const r = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);
        const reach = Math.exp(-Math.pow(r / vortex.radius, 2) * 0.85);
        // Angular phase is periodic at ±pi; spatial frequency stays bounded
        // even after hours of animation. The open eye keeps the center clear.
        const curl = angle + r * 1.45 - t * vortex.spin * 1.05 + vortex.phase;
        const filament = Math.exp(-Math.pow(Math.sin(curl), 2) * 12);
        const undercurrent = Math.exp(-Math.pow(Math.sin(curl + 0.65), 2) * 8) * 0.2;
        const eye = Math.min(1, r * r * 3);
        const surge = 0.8 + 0.2 * Math.sin(r * 3.4 - t * 1.1 + vortex.phase);
        const energy = (filament + undercurrent) * reach * eye * surge * edge * 1.15;
        canvas.addDot(px, py, energy, vortex.color);
      }
    }
  }
  return canvas.render();
}

const epoch = performance.now();
export const auroraVortexScene: Scene = {
  name: "aurora-vortex",
  height: 4,
  render: (width) => renderAuroraVortex(width, (performance.now() - epoch) / 1000),
};
