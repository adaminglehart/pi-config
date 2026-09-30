import { BrailleCanvas } from "../rendering/braille-canvas.js";
import type { RGB } from "../rendering/spectral-color.js";
import type { Scene } from "../rendering/types.js";

const TAU = Math.PI * 2;
/** Each knot has its own warm front and cool back, so depth reads as color. */
const KNOTS: readonly { front: RGB; back: RGB }[] = [
  { front: [255, 196, 112], back: [84, 110, 255] },
  { front: [255, 112, 186], back: [60, 196, 255] },
  { front: [140, 255, 206], back: [148, 84, 255] },
  { front: [255, 236, 150], back: [255, 70, 130] },
  { front: [120, 226, 255], back: [196, 86, 255] },
  { front: [255, 150, 96], back: [40, 210, 190] },
];
const STAR: RGB = [166, 190, 255];
const NEBULA: readonly RGB[] = [[70, 40, 130], [30, 80, 120], [110, 40, 110]];
const DEPTH = 2.4;

function mix(from: RGB, to: RGB, amount: number): RGB {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

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

/** Celestial kinetic sculpture: luminous knots, orbiting comets, and a quiet nebula. */
export function renderOrbit(width: number, seconds: number): string[] {
  const canvas = new BrailleCanvas(width);
  const t = seconds;
  const count = Math.max(1, Math.min(6, Math.round(width / 34)));
  const groupWidth = canvas.dotWidth / count;

  // A slow nebula drifts behind the knots. Fixed per-dot thresholds dither it,
  // so dots switch on and off gradually as the field moves.
  for (let py = 0; py < canvas.dotHeight; py++) {
    for (let px = 0; px < canvas.dotWidth; px++) {
      const x = px / 24;
      const y = py / 6;
      const field = Math.sin(x * 1.3 + Math.sin(y * 1.7 + t * 0.05) * 1.4 - t * 0.04)
        + 0.6 * Math.sin(x * 0.55 - y * 1.1 + t * 0.03 + 2);
      const threshold = ((px * 0.7548776662 + py * 0.56984029) % 1) * 1.8 + 0.45;
      if (field < threshold) continue;
      const tone = NEBULA[Math.floor((x * 0.2 + y * 0.3) % NEBULA.length)]!;
      canvas.addDot(px, py, 0.2, tone);
    }
  }

  // Fixed positions and continuous pulses keep the background calm.
  for (let star = 0; star < Math.floor(width / 5); star++) {
    const x = ((star * 0.61803398875 + 0.13) % 1) * (canvas.dotWidth - 1);
    const y = ((star * 0.41421356237 + 0.27) % 1) * 15;
    const pulse = Math.pow(0.5 + 0.5 * Math.sin(t * 0.75 + star * 2.3), 8);
    canvas.splat(x, y, 0.2 + pulse * 0.6, mix(STAR, [255, 255, 255], pulse));
  }

  for (let orb = 0; orb < count; orb++) {
    const knot = KNOTS[orb % KNOTS.length]!;
    const cx = groupWidth * (orb + 0.5);
    const cy = 7.5 + 0.3 * Math.sin(t * 0.43 + orb * 2);
    const scaleX = groupWidth * 0.2;
    const scaleY = 3.05;
    const samples = Math.max(120, Math.ceil(groupWidth * 3.5));
    for (let sample = 0; sample < samples; sample++) {
      const angle = sample / samples * TAU;
      const [x, y, depth] = orbitPoint(angle, t, orb);
      // Front arcs are warm and bright with a pale core; back arcs recede into
      // a dim, cool color. Energy weighting lets the front arc win at crossings.
      const near = Math.min(1, Math.max(0, (depth + DEPTH) / (DEPTH * 2)));
      const color = mix(mix(knot.back, [0, 0, 0], 0.45), knot.front, near);
      const pearl = Math.pow(near, 6) * 0.6;
      canvas.splat(cx + x * scaleX, cy + y * scaleY, 0.25 + near * near * 0.95,
        mix(color, [255, 255, 255], pearl));
    }

    for (let comet = 0; comet < 2; comet++) {
      const head = t * (comet === 0 ? 0.85 : -0.65) + orb * 1.4 + comet * Math.PI;
      for (let tail = 0; tail < 56; tail++) {
        const angle = head - tail * 0.02 * (comet === 0 ? 1 : -1);
        const [x, y, depth] = orbitPoint(angle, t, orb);
        const near = Math.min(1, Math.max(0, (depth + DEPTH) / (DEPTH * 2)));
        const pearl = Math.exp(-tail * 0.12) * 0.9;
        const light = mix(mix(knot.back, knot.front, 0.5 + near * 0.5), [255, 255, 255], pearl);
        canvas.splat(cx + x * scaleX, cy + y * scaleY, Math.exp(-tail * 0.06) * 1.4, light);
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
