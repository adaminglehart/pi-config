import { BrailleCanvas } from "./braille-canvas.js";
import { spectralColor, type Palette } from "./spectral-color.js";
import type { Scene } from "./types.js";

const PALETTE: Palette = [
  [66, 255, 186], [72, 222, 255], [124, 106, 255],
  [244, 100, 225], [255, 188, 130],
];

/** Luminous ink blooms open, twist into petals, and dissolve into one another. */
export function renderAuroraBloom(width: number, seconds: number): string[] {
  const canvas = new BrailleCanvas(width);
  const t = seconds;
  const span = Math.max(7, Math.min(24, width / 6));
  const blooms = Array.from({ length: 6 }, (_, i) => {
    const life = ((t / (12 + i * 1.1) + i * 0.273) % 1 + 1) % 1;
    return {
      x: span * ((i + 0.5) / 6 + 0.05 * Math.sin(t * 0.29 + i * 1.5)),
      y: 2 + 0.8 * Math.cos(t * 0.34 + i * 2.3),
      radius: 0.3 + life * 3.6,
      fade: Math.pow(Math.sin(life * Math.PI), 2),
      phase: i * 2.4,
      color: spectralColor(PALETTE, i * 0.19 + t * 0.022),
    };
  });

  for (let py = 0; py < canvas.dotHeight; py++) {
    const y = (py + 0.5) / 4;
    for (let px = 0; px < canvas.dotWidth; px++) {
      const u = (px + 0.5) / canvas.dotWidth;
      const x = u * span;
      const edge = Math.min(1, u * 16, (1 - u) * 16);
      // A shared moving flow bends the rings, so they are never rigid circles.
      const flowX = x + 0.32 * Math.sin(y * 2.2 + x * 0.6 - t * 0.6);
      const flowY = y + 0.28 * Math.sin(x * 1.3 + t * 0.52);
      for (const bloom of blooms) {
        const dx = flowX - bloom.x;
        const dy = (flowY - bloom.y) * 1.3;
        const r = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);
        const petals = 0.3 * Math.sin(angle * 3 + r * 1.4 - t * 0.85 + bloom.phase)
          + 0.12 * Math.sin(angle * 5 - t * 0.47 + bloom.phase);
        const distance = r - bloom.radius - petals;
        const rim = Math.exp(-distance * distance * 26);
        const innerRim = Math.exp(-Math.pow(distance + 0.45, 2) * 35) * 0.36;
        const silk = Math.exp(-distance * distance * 3.5) * 0.12;
        canvas.addDot(px, py, (rim + innerRim + silk) * bloom.fade * edge, bloom.color);
      }
    }
  }
  return canvas.render();
}

const epoch = performance.now();
export const auroraBloomScene: Scene = {
  name: "aurora-bloom",
  height: 4,
  render: (width) => renderAuroraBloom(width, (performance.now() - epoch) / 1000),
};
