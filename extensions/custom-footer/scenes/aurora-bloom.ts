import { BrailleCanvas } from "../rendering/braille-canvas.js";
import { spectralColor, type Palette } from "../rendering/spectral-color.js";
import type { Scene } from "../rendering/types.js";

const PALETTE: Palette = [
  [66, 255, 186], [72, 222, 255], [124, 106, 255],
  [244, 100, 225], [255, 188, 130],
];

/** Luminous ink blooms open, twist into petals, and dissolve into one another. */
export function renderAuroraBloom(width: number, seconds: number): string[] {
  const canvas = new BrailleCanvas(width);
  const t = seconds;
  const span = Math.max(7, width / 6);
  // Wider footers get more blooms, so the field never has large empty gaps.
  const count = Math.max(6, Math.round(span / 2.8));
  const blooms = Array.from({ length: count }, (_, i) => {
    const life = ((t / (12 + (i % 6) * 1.1) + i * 0.273) % 1 + 1) % 1;
    const phase = i * 0.19 + t * 0.022;
    return {
      x: span * ((i + 0.5) / count + 0.05 * 6 / count * Math.sin(t * 0.29 + i * 1.5)),
      y: 2 + 0.8 * Math.cos(t * 0.34 + i * 2.3),
      radius: 0.3 + life * 3.6,
      life,
      fade: Math.pow(Math.sin(life * Math.PI), 2),
      phase: i * 2.4,
      // The rim, inner rim, and silk each take a different step of the palette.
      rim: spectralColor(PALETTE, phase),
      inner: spectralColor(PALETTE, phase + 0.22),
      silk: spectralColor(PALETTE, phase + 0.11),
    };
  });
  const toDotX = (x: number): number => x / span * canvas.dotWidth;

  for (let py = 0; py < canvas.dotHeight; py++) {
    const y = (py + 0.5) / 4;
    for (let px = 0; px < canvas.dotWidth; px++) {
      const u = (px + 0.5) / canvas.dotWidth;
      const x = u * span;
      const edge = Math.min(1, u * 16, (1 - u) * 16);
      // A shared moving flow bends the rings, so they are never rigid circles.
      const flowX = x + 0.32 * Math.sin(y * 2.2 + x * 0.6 - t * 0.6);
      const flowY = y + 0.28 * Math.sin(x * 1.3 + t * 0.52);
      let total = 0;
      let strongest = 0;
      for (const bloom of blooms) {
        const dx = flowX - bloom.x;
        if (Math.abs(dx) > bloom.radius + 1.6) continue;
        const dy = (flowY - bloom.y) * 1.3;
        const r = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);
        const petals = 0.3 * Math.sin(angle * 3 + r * 1.4 - t * 0.85 + bloom.phase)
          + 0.12 * Math.sin(angle * 5 - t * 0.47 + bloom.phase);
        const distance = r - bloom.radius - petals;
        const strength = bloom.fade * edge;
        const rim = Math.exp(-distance * distance * 26) * strength;
        const innerRim = Math.exp(-Math.pow(distance + 0.45, 2) * 35) * 0.36 * strength;
        const silk = Math.exp(-distance * distance * 3.5) * 0.12 * strength;
        canvas.addDot(px, py, rim, bloom.rim);
        canvas.addDot(px, py, innerRim, bloom.inner);
        canvas.addDot(px, py, silk, bloom.silk);
        total += rim + innerRim;
        strongest = Math.max(strongest, rim + innerRim);
      }
      // Where two rims cross, their light adds up into a pale, bright seam.
      const overlap = total - strongest;
      if (overlap > 0.12) canvas.addDot(px, py, overlap * 1.4, [255, 250, 240]);
    }
  }

  // Pollen sparks drift outward from each rim and fade as they leave it.
  for (const [index, bloom] of blooms.entries()) {
    for (let spark = 0; spark < 5; spark++) {
      const age = ((t * 0.35 + spark * 0.2 + index * 0.37) % 1 + 1) % 1;
      const angle = spark * 1.2566 + index * 0.9 + Math.sin(t * 0.2 + spark) * 0.3;
      const reach = bloom.radius + 0.2 + age * 1.3;
      const x = toDotX(bloom.x + Math.cos(angle) * reach);
      const y = (bloom.y + Math.sin(angle) * reach / 1.3) * 4 - 0.5;
      const energy = Math.sin(age * Math.PI) * bloom.fade * 1.1;
      canvas.splat(x, y, energy, bloom.inner);
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
