import { BrailleCanvas } from "../rendering/braille-canvas.js";
import { spectralColor, type Palette, type RGB } from "../rendering/spectral-color.js";
import type { Scene } from "../rendering/types.js";

const HORIZON = 8;
const CAMERA_HEIGHT = 6;
const FOCAL = 30;
const SUN_RADIUS = 8.5;
// Gradients use phases below (n - 1) / n so they never wrap back to the start.
const SUN: Palette = [[255, 238, 150], [255, 178, 92], [255, 92, 138], [206, 58, 196]];
const GRID: Palette = [[255, 70, 200], [176, 84, 255], [70, 190, 255]];
const MOUNTAIN: RGB = [88, 70, 190];
const RIDGE: RGB = [96, 226, 255];
const ROAD: RGB = [110, 240, 255];
const STAR: RGB = [190, 200, 255];
const FAR_RIDGE: RGB = [150, 92, 230];
const TOWER: RGB = [255, 90, 210];
const WINDOW: RGB = [120, 230, 255];
const TRUNK: RGB = [255, 96, 170];
const FROND: Palette = [[90, 255, 190], [60, 200, 230], [130, 110, 255]];

function fade(color: RGB, amount: number): RGB {
  return [color[0] * amount, color[1] * amount, color[2] * amount];
}

function random(a: number, b: number): number {
  const value = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

/** A palm silhouette whose fronds sway slowly in a warm night wind. */
function drawPalm(canvas: BrailleCanvas, baseX: number, lean: number, t: number, seed: number): void {
  const topX = baseX + lean * 5;
  const topY = 2;
  for (let step = 0; step <= 40; step++) {
    const s = step / 40;
    const y = canvas.dotHeight - 0.5 - (canvas.dotHeight - 0.5 - topY) * s;
    canvas.addDot(Math.round(baseX + lean * 5 * s * s), Math.floor(y), 0.7, fade(TRUNK, 0.7 + s * 0.3));
  }
  for (let frond = 0; frond < 7; frond++) {
    const direction = frond < 3 ? -1 : frond < 6 ? 1 : lean;
    const reach = frond === 6 ? 3 : 5 + (frond % 3) * 2.5;
    const lift = frond % 3 === 0 ? 2.4 : frond % 3 === 1 ? 1.4 : 0.6;
    const sway = Math.sin(t * 0.7 + seed + frond * 1.3) * 0.5;
    for (let step = 1; step <= 20; step++) {
      const u = step / 20;
      const x = topX + direction * reach * u * 1.6;
      const y = topY - lift * u + (5 + sway) * u * u;
      const color = spectralColor(FROND, 0.1 + u * 0.55);
      canvas.addDot(Math.round(x), Math.floor(y), 0.8, fade(color, 1 - u * 0.25));
    }
  }
}

function smoothstep(from: number, to: number, value: number): number {
  const x = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return x * x * (3 - 2 * x);
}

/** An endless night drive toward a sliced sun over a curving neon grid. */
export function renderNeonHorizon(width: number, seconds: number): string[] {
  const canvas = new BrailleCanvas(width);
  const t = seconds;
  const w = canvas.dotWidth;
  const cx = w / 2;
  // Palms line the roadside; wider footers get a second, outer pair.
  const inner = Math.max(96, w * 0.3);
  const palms = [-1, 1].flatMap((side) => [
    { x: cx + side * inner, lean: side * 0.8, seed: side },
    ...(w > 420 ? [{ x: cx + side * w * 0.44, lean: -side * 0.6, seed: side * 3 }] : []),
  ]);
  // Mountains part around each palm crown so its silhouette stays clear.
  const palmClearing = (x: number): number => palms.reduce(
    (clear, palm) => clear * smoothstep(8, 20, Math.abs(x - palm.x - palm.lean * 5)), 1);
  // The road bends slowly; far grid lines swing more than near ones.
  const curve = 0.05 * Math.sin(t * 0.13) + 0.025 * Math.sin(t * 0.31 + 1);

  for (let star = 0; star < Math.floor(width / 5); star++) {
    const x = ((star * 0.61803398875 + 0.21) % 1) * w;
    const y = ((star * 0.7548776662 + 0.1) % 1) * (HORIZON - 2);
    if (Math.abs(x - cx) < SUN_RADIUS + 4) continue;
    const twinkle = Math.pow(0.5 + 0.5 * Math.sin(t * (0.6 + star % 5 * 0.17) + star * 1.9), 6);
    canvas.addDot(Math.floor(x), Math.floor(y), 0.3 + twinkle, fade(STAR, 0.35 + twinkle * 0.65));
  }

  // A rare shooting star crosses the sky with a fading tail.
  const meteorPeriod = 11;
  const meteor = Math.floor(t / meteorPeriod);
  const meteorAge = t - meteor * meteorPeriod;
  if (meteorAge < 1.3 && w > 0) {
    const seed = Math.sin(meteor * 12.9898) * 43758.5453;
    const startX = (seed - Math.floor(seed)) * w;
    const direction = meteor % 2 === 0 ? 1 : -1;
    for (let tail = 0; tail < 18; tail++) {
      const age = meteorAge - tail * 0.018;
      if (age < 0) break;
      const energy = Math.exp(-tail * 0.17) * Math.sin(meteorAge / 1.3 * Math.PI);
      canvas.splat(startX + direction * age * 70, 0.5 + age * 3.2, energy * 1.4,
        fade([230, 245, 255], 0.4 + energy * 0.6));
    }
  }

  // Ridges mirror onto the wet ground, broken up by a slow shimmer.
  const reflect = (x: number, peak: number, color: RGB, light: number): void => {
    const shimmer = Math.sin(x * 0.45 + t * 0.5 + Math.sin(x * 0.13) * 2);
    if (shimmer < -0.3) return;
    const y = Math.min(canvas.dotHeight - 1, HORIZON + 1 + Math.min(HORIZON - 1, peak) * 0.8);
    canvas.addDot(x, Math.round(y), 0.3, fade(color, light));
  };

  // A far range stands behind the near ridges in dim violet.
  for (let x = 0; x < w; x++) {
    const clearing = smoothstep(SUN_RADIUS + 26, SUN_RADIUS + 60, Math.abs(x - cx)) * palmClearing(x);
    const peak = (3.4 + 1.8 * Math.sin(x * 0.033 + 4.1) + 0.9 * Math.sin(x * 0.11 + 1.7)) * clearing;
    if (peak < 1) continue;
    canvas.splat(x, HORIZON - Math.min(HORIZON - 1, peak), 0.55, fade(FAR_RIDGE, 0.55));
    reflect(x, peak, FAR_RIDGE, 0.4);
  }

  // A neon city flanks the sun; the tallest towers blink on their antennas.
  for (const side of [-1, 1]) {
    let edge = SUN_RADIUS + 3;
    for (let tower = 0; edge < SUN_RADIUS + 34; tower++) {
      const seed = side * 31 + tower;
      const span = 3 + Math.floor(random(seed, 1) * 4);
      const height = 2 + Math.floor(random(seed, 2) * 5 * (1 - (edge - SUN_RADIUS) / 50));
      const left = side < 0 ? cx - edge - span : cx + edge;
      const top = HORIZON - height;
      const glow = fade(TOWER, 0.5 + random(seed, 3) * 0.35);
      for (let x = left; x <= left + span; x++) canvas.addDot(Math.round(x), top, 0.5, glow);
      for (let y = top + 1; y < HORIZON; y++) {
        canvas.addDot(Math.round(left), y, 0.4, fade(glow, 0.7));
        canvas.addDot(Math.round(left + span), y, 0.4, fade(glow, 0.7));
        for (let x = left + 2; x < left + span - 1; x += 2) {
          if (random(seed * 7 + x, y) < 0.5) canvas.addDot(Math.round(x), y, 0.3, fade(WINDOW, 0.6));
        }
      }
      if (height >= 5 && Math.sin(t * 2.4 + seed) > 0.4) {
        canvas.addDot(Math.round(left + span / 2), top - 1, 0.9, [255, 70, 90]);
      }
      edge += span + 1 + Math.floor(random(seed, 4) * 3);
    }
  }

  // Wireframe ridges rise in ranges on both sides and give way to the city.
  for (let x = 0; x < w; x++) {
    const clearing = smoothstep(SUN_RADIUS + 34, SUN_RADIUS + 52, Math.abs(x - cx)) * palmClearing(x);
    const range = Math.sin(x * 0.021 + 0.7) + 0.55 * Math.sin(x * 0.057 + 2.1);
    const peak = (range * 2.6 + 1.2 * Math.sin(x * 0.16 + 0.4) + 0.45 * Math.sin(x * 0.41)
      + 1.2) * clearing;
    if (peak < 0.8) continue;
    const ridge = HORIZON - Math.min(HORIZON - 1, peak);
    canvas.splat(x, ridge, 0.75, fade(RIDGE, 0.5 + 0.4 * clearing));
    reflect(x, peak, RIDGE, 0.5);
    for (let y = Math.ceil(ridge + 1.5); y < HORIZON; y++) {
      if ((x + y * 3) % 7 === 0) canvas.addDot(x, y, 0.35, fade(MOUNTAIN, 0.6));
    }
  }

  // The sun sits on the horizon; its slits drift down and widen toward the base.
  const sunCenterY = HORIZON + 1;
  for (let y = 0; y < HORIZON; y++) {
    const dy = y + 0.5 - sunCenterY;
    const half = Math.sqrt(Math.max(0, SUN_RADIUS * SUN_RADIUS - dy * dy));
    const depth = (y + 0.5 - (sunCenterY - SUN_RADIUS)) / SUN_RADIUS;
    const gap = smoothstep(0.35, 1, depth) * 0.55;
    const band = ((y - t * 1.3) / 2.4 % 1 + 1) % 1;
    if (band < gap) continue;
    const color = spectralColor(SUN, Math.min(0.74, depth * 0.74));
    for (let x = Math.ceil(cx - half); x < cx + half; x++) canvas.addDot(x, y, 1.1, color);
  }

  for (let x = 0; x < w; x++) {
    const glow = 0.6 + 0.4 * Math.exp(-Math.pow((x - cx) / (SUN_RADIUS * 2.5), 2));
    canvas.addDot(x, HORIZON, 1, fade([255, 110, 190], glow));
  }

  // The sun reflects on the wet road as a warm, shimmering column.
  for (let y = HORIZON + 1; y < canvas.dotHeight; y++) {
    const spread = (y - HORIZON) * 0.9 + 2;
    for (let x = Math.ceil(cx - spread); x < cx + spread; x++) {
      const shimmer = Math.sin(y * 2.3 - t * 3.1 + Math.sin(x * 0.9 + t) * 1.5);
      if (shimmer < 0.55) continue;
      const falloff = 1 - Math.abs(x - cx) / spread;
      const color = spectralColor(SUN, 0.3 + (y - HORIZON) / 16);
      canvas.addDot(x, y, 0.3 + falloff * 0.4, fade(color, 0.35 + falloff * 0.55));
    }
  }

  // Cross lines rush toward the viewer across a floor that narrows toward
  // the sun. They speed up as they come closer and fade at their ends.
  const roadX = (offset: number, y: number): number => {
    const z = CAMERA_HEIGHT / (y - HORIZON);
    return cx + (offset + curve * z * z) * FOCAL / z;
  };
  const spacing = 1.5;
  const scroll = (t * 0.9) % spacing;
  let lastRow = -1;
  for (let line = 1; line < 12; line++) {
    const z = line * spacing - scroll;
    if (z < 0.8) continue;
    const y = Math.round(HORIZON + CAMERA_HEIGHT / z);
    if (y < HORIZON + 3 || y >= canvas.dotHeight || y === lastRow) continue;
    lastRow = y;
    const fog = smoothstep(3.5, 0.9, z);
    const color = fade(spectralColor(GRID, Math.min(0.66, z / 10)), 0.35 + 0.65 * fog);
    const left = roadX(-2.6, y);
    const right = roadX(2.6, y);
    for (let x = Math.max(0, Math.ceil(left)); x < Math.min(w, right); x++) {
      const end = Math.min(1, (x - left) / (right - left) * 5, (right - x) / (right - left) * 5);
      canvas.addDot(x, y, 0.35 + fog * 0.4, fade(color, 0.3 + 0.7 * end));
    }
  }

  // The road's edges converge on the sun and bend with the curve. Each edge
  // is sampled densely enough to stay continuous as it flattens out.
  const top = HORIZON + 1.5;
  const bottom = canvas.dotHeight - 0.5;
  for (const offset of [-1.25, 1.25]) {
    const samples = Math.ceil(Math.abs(roadX(offset, bottom) - roadX(offset, top)) * 1.5);
    for (let sample = 0; sample <= samples; sample++) {
      const y = top + (bottom - top) * sample / samples;
      const near = smoothstep(top, bottom, y);
      canvas.addDot(Math.round(roadX(offset, y)), Math.floor(y), 0.6 + near * 0.25,
        fade(ROAD, 0.55 + near * 0.45));
    }
  }
  // Center dashes race toward the viewer.
  for (let y = HORIZON + 2; y < canvas.dotHeight; y += 0.25) {
    const z = CAMERA_HEIGHT / (y - HORIZON);
    if (((z + t * 1.1) / 0.9 % 1 + 1) % 1 > 0.45) continue;
    canvas.addDot(Math.round(roadX(0, y)), Math.floor(y), 0.75, [255, 236, 190]);
  }

  for (const palm of palms) drawPalm(canvas, palm.x, palm.lean, t, palm.seed);
  return canvas.render();
}

const epoch = performance.now();
export const neonHorizonScene: Scene = {
  name: "neon-horizon",
  height: 4,
  render: (width) => renderNeonHorizon(width, (performance.now() - epoch) / 1000),
};
