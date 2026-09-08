import { BrailleCanvas } from "./braille-canvas.js";
import { spectralColor, type Palette, type RGB } from "./spectral-color.js";
import type { Scene } from "./types.js";

const TAU = Math.PI * 2;
const PALETTE: Palette = [
  [72, 244, 255], [96, 135, 255], [197, 103, 255],
  [255, 100, 175], [255, 197, 117], [129, 255, 210],
];
const STAR: RGB = [166, 190, 255];

/** A torus knot, rotated in three axes and projected with real depth. */
function orbitPoint(angle: number, t: number, orb: number): readonly [number, number, number] {
  const p = orb % 3 === 2 ? 3 : 2;
  const q = orb % 3 === 0 ? 3 : orb % 3 === 1 ? 5 : 4;
  const tube = 0.65 + 0.12 * Math.sin(t * 0.3 + orb);
  const radius = 1.65 + tube * Math.cos(q * angle);
  const x = radius * Math.cos(p * angle);
  const y = radius * Math.sin(p * angle);
  const z = tube * Math.sin(q * angle);
  const yaw = t * 0.29 + orb * 1.7;
  const pitch = t * 0.37 + orb * 0.8;
  const roll = t * 0.13 - orb * 0.6;
  const xx = x * Math.cos(yaw) + z * Math.sin(yaw);
  const zz = -x * Math.sin(yaw) + z * Math.cos(yaw);
  const yy = y * Math.cos(pitch) - zz * Math.sin(pitch);
  const depth = y * Math.sin(pitch) + zz * Math.cos(pitch);
  const perspective = 5 / (6 - depth);
  return [
    (xx * Math.cos(roll) - yy * Math.sin(roll)) * perspective,
    (xx * Math.sin(roll) + yy * Math.cos(roll)) * perspective,
    depth,
  ];
}

/** Celestial kinetic sculpture: luminous knots, orbiting comets, and quiet stars. */
export function renderOrbit(width: number, seconds: number): string[] {
  const canvas = new BrailleCanvas(width);
  const t = seconds;
  const count = Math.max(1, Math.min(5, Math.round(width / 42)));
  const groupWidth = canvas.dotWidth / count;

  // Fixed positions and continuous pulses keep the background calm.
  for (let star = 0; star < Math.floor(width / 7); star++) {
    const x = ((star * 0.61803398875 + 0.13) % 1) * (canvas.dotWidth - 1);
    const y = ((star * 0.41421356237 + 0.27) % 1) * 15;
    const pulse = Math.pow(0.5 + 0.5 * Math.sin(t * 0.75 + star * 2.3), 8);
    canvas.splat(x, y, 0.12 + pulse * 0.5, STAR);
  }

  for (let orb = 0; orb < count; orb++) {
    const cx = groupWidth * (orb + 0.5);
    const cy = 7.5 + 0.45 * Math.sin(t * 0.43 + orb * 2);
    const scaleX = groupWidth * 0.18;
    const scaleY = 2.65;
    const samples = Math.max(96, Math.ceil(groupWidth * 3));
    for (let sample = 0; sample < samples; sample++) {
      const angle = sample / samples * TAU;
      const [x, y, depth] = orbitPoint(angle, t, orb);
      const color = spectralColor(PALETTE, sample / samples + orb * 0.21 + t * 0.025);
      // Rear arcs are dimmer; front arcs pass through with a pale luminous core.
      const energy = 0.3 + (depth + 2.5) * 0.11;
      canvas.splat(cx + x * scaleX, cy + y * scaleY, energy, color);
    }

    for (let comet = 0; comet < 2; comet++) {
      const head = t * (comet === 0 ? 0.85 : -0.65) + orb * 1.4 + comet * Math.PI;
      for (let tail = 0; tail < 30; tail++) {
        const angle = head - tail * 0.022 * (comet === 0 ? 1 : -1);
        const [x, y] = orbitPoint(angle, t, orb);
        const color = spectralColor(PALETTE, angle / TAU + orb * 0.21 + t * 0.025);
        const pearl = Math.exp(-tail * 0.2) * 0.8;
        const light: RGB = [
          color[0] * (1 - pearl) + 255 * pearl,
          color[1] * (1 - pearl) + 255 * pearl,
          color[2] * (1 - pearl) + 255 * pearl,
        ];
        canvas.splat(cx + x * scaleX, cy + y * scaleY,
          Math.exp(-tail * 0.11) * 1.3, light);
      }
    }
  }
  return canvas.render();
}

const epoch = performance.now();
export const orbitScene: Scene = {
  name: "orbit",
  height: 4,
  render: (width) => renderOrbit(width, (performance.now() - epoch) / 1000),
};
