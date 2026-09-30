import { BrailleCanvas } from "../rendering/braille-canvas.js";
import type { RGB } from "../rendering/spectral-color.js";
import type { Scene } from "../rendering/types.js";

type Shape = "peony" | "willow" | "ring" | "crackle" | "heart"
  | "palm" | "crossette" | "saturn" | "pinwheel" | "star";

interface Burst {
  launch: number;
  rise: number;
  x: number;
  y: number;
  shape: Shape;
  /** Particle colors, cycled by particle index: one, two-tone, or rainbow. */
  colors: readonly RGB[];
  /** Second color for Saturn rings, crossette splits, and palm tips. */
  accent: RGB;
  fadeColor: RGB;
  seed: number;
}

/** Cumulative odds for each shape. Hearts stay rare, so each is a surprise. */
const SHAPE_ODDS: readonly (readonly [Shape, number])[] = [
  ["heart", 0.05], ["willow", 0.16], ["ring", 0.25], ["crackle", 0.34],
  ["palm", 0.44], ["crossette", 0.54], ["saturn", 0.63], ["pinwheel", 0.72],
  ["star", 0.8], ["peony", 1],
];

const COLORS: readonly RGB[] = [
  [255, 84, 120], [255, 178, 72], [120, 220, 255], [182, 122, 255],
  [110, 255, 170], [255, 120, 220], [255, 236, 140],
];
const GOLD: RGB = [255, 196, 104];
const GRAVITY = 3.2;
const SKYLINE: RGB = [78, 88, 150];
const WINDOW: RGB = [255, 206, 128];
const LANE_WIDTH = 42;
const FINALE_PERIOD = 90;
const FINALE_LENGTH = 7;

function hash(a: number, b: number): number {
  let value = (Math.imul(a, 0x27d4eb2d) ^ Math.imul(b + 0x165667b1, 0x9e3779b9)) | 0;
  value = Math.imul(value ^ (value >>> 15), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}

function mix(from: RGB, to: RGB, amount: number): RGB {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

function lifetime(shape: Shape): number {
  switch (shape) {
    case "willow": return 3.6;
    case "palm": return 3;
    case "crackle": case "crossette": return 2.8;
    case "saturn": case "pinwheel": return 2.5;
    default: return 2.3;
  }
}

function particleCount(shape: Shape): number {
  switch (shape) {
    case "ring": return 44;
    case "heart": return 52;
    case "palm": return 56;
    case "crossette": return 40;
    case "saturn": return 64;
    case "pinwheel": return 48;
    case "star": return 60;
    default: return 56;
  }
}

function trailLength(shape: Shape): number {
  return shape === "willow" ? 11 : shape === "palm" ? 8 : shape === "pinwheel" ? 6 : 5;
}

function makeBurst(seed: number, launch: number, x: number, lane: number): Burst {
  const roll = hash(seed, 1);
  const shape = SHAPE_ODDS.find(([, odds]) => roll < odds)![0];
  const pick = (salt: number): RGB => COLORS[Math.floor(hash(seed, salt) * COLORS.length)]!;
  const colorIndex = Math.floor(hash(seed, 2) * COLORS.length);
  const color = COLORS[colorIndex]!;
  // The accent is always a clearly different hue from the main color.
  const accent = COLORS[(colorIndex + 2 + Math.floor(hash(seed, 6) * (COLORS.length - 3))) % COLORS.length]!;
  const mode = hash(seed, 7);
  let colors: readonly RGB[] = [color];
  if (shape === "willow" || shape === "palm") colors = [GOLD];
  else if (shape === "heart") colors = [[255, 92, 150]];
  else if (mode < 0.15) {
    const start = Math.floor(hash(seed, 8) * COLORS.length);
    colors = COLORS.map((_, i) => COLORS[(start + i) % COLORS.length]!);
  } else if (mode < 0.4 && shape !== "saturn") colors = [color, accent];
  return {
    launch,
    rise: 0.8 + hash(seed, 3) * 0.35,
    x,
    y: 3.5 + hash(seed, 4) * 2.5 + lane % 2,
    shape,
    colors,
    accent: shape === "palm" ? [255, 250, 220] : accent,
    fadeColor: shape === "willow" || shape === "palm" ? [255, 120, 60] : pick(5),
    seed,
  };
}

/** Every burst that is visible at `t`, from staggered lanes plus the finale. */
function activeBursts(dotWidth: number, t: number): Burst[] {
  const bursts: Burst[] = [];
  const lanes = Math.max(1, Math.floor(dotWidth / LANE_WIDTH));
  const laneWidth = dotWidth / lanes;
  for (let lane = 0; lane < lanes; lane++) {
    const period = 2 + hash(lane, 7) * 1.4;
    const offset = hash(lane, 8) * period;
    const latest = Math.floor((t + offset) / period);
    for (let slot = latest - 3; slot <= latest; slot++) {
      const seed = lane * 7919 + slot;
      if (hash(seed, 9) < 0.18) continue;
      const launch = slot * period - offset + hash(seed, 10) * 0.6;
      const x = laneWidth * (lane + 0.2 + hash(seed, 11) * 0.6);
      const burst = makeBurst(seed, launch, x, lane);
      if (t >= launch && t < launch + burst.rise + lifetime(burst.shape)) bursts.push(burst);
    }
  }

  // A grand finale fills the sky with rapid bursts once per cycle.
  const cycle = Math.floor(t / FINALE_PERIOD);
  const finaleStart = cycle * FINALE_PERIOD + FINALE_PERIOD - FINALE_LENGTH - 4;
  const latest = Math.floor((t - finaleStart) / 0.3);
  for (let slot = Math.max(0, latest - 16); slot <= latest; slot++) {
    const launch = finaleStart + slot * 0.3;
    if (launch > finaleStart + FINALE_LENGTH) break;
    const seed = 1_000_003 + cycle * 101 + slot;
    const burst = makeBurst(seed, launch, dotWidth * (0.05 + hash(seed, 12) * 0.9), slot);
    if (t >= launch && t < launch + burst.rise + lifetime(burst.shape)) bursts.push(burst);
  }
  return bursts;
}

/** Closed-form motion with air drag and gravity, so any frame renders directly. */
function flight(
  x: number, y: number, vx: number, vy: number, age: number, drag: number, gravity: number,
): readonly [number, number] {
  const spread = (1 - Math.exp(-drag * age)) / drag;
  return [x + vx * spread, y + vy * spread + gravity / drag * (age - spread)];
}

/** A five-pointed star outline; `u` walks once around its ten edges. */
function starPoint(u: number, rotation: number): readonly [number, number] {
  const edge = Math.floor(u * 10);
  const f = u * 10 - edge;
  const vertex = (i: number): readonly [number, number] => {
    const radius = i % 2 === 0 ? 1 : 0.42;
    const angle = rotation + i / 10 * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  };
  const [x0, y0] = vertex(edge);
  const [x1, y1] = vertex(edge + 1);
  return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
}

/** Where particle `index` is `age` seconds after the burst, plus its color. */
function particleAt(burst: Burst, index: number, count: number, age: number): {
  x: number; y: number; color: RGB;
} {
  const angle = index / count * Math.PI * 2 + hash(burst.seed, index + 20) * 0.2;
  const color = burst.colors[index % burst.colors.length]!;
  const at = (vx: number, vy: number, drag = 1.9, gravity = GRAVITY) => {
    const [x, y] = flight(burst.x, burst.y, vx, vy, age, drag, gravity);
    return { x, y, color };
  };
  switch (burst.shape) {
    case "ring": {
      const tilt = 0.3 + hash(burst.seed, 13) * 0.3;
      return at(Math.cos(angle) * 17, Math.sin(angle) * 17 * tilt);
    }
    case "heart": {
      const x = Math.pow(Math.sin(angle), 3);
      const y = -(13 * Math.cos(angle) - 5 * Math.cos(2 * angle)
        - 2 * Math.cos(3 * angle) - Math.cos(4 * angle)) / 16;
      return at(x * 17, y * 7.5, 1.9, GRAVITY * 0.4);
    }
    case "willow":
      return at(Math.cos(angle) * 13, Math.sin(angle) * 5.5 - 2, 1.3, GRAVITY * 1.25);
    case "palm": {
      // Seven thick arms: several stars share each direction at staggered speeds.
      const arm = index % 7;
      const along = Math.floor(index / 7) / Math.ceil(count / 7);
      const armAngle = arm / 7 * Math.PI * 2 + hash(burst.seed, 14) + Math.PI / 14;
      const speed = 8 + along * 8;
      const point = at(Math.cos(armAngle) * speed * 1.4, Math.sin(armAngle) * speed * 0.7 - 2.5,
        1.5, GRAVITY * 1.3);
      return { ...point, color: mix(color, burst.accent, along * along) };
    }
    case "crossette": {
      // Eight stars fly out, then each splits into four smaller stars.
      const parent = Math.floor(index / 5);
      const child = index % 5;
      const parentAngle = parent / Math.ceil(count / 5) * Math.PI * 2 + hash(burst.seed, 15);
      const vx = Math.cos(parentAngle) * 13;
      const vy = Math.sin(parentAngle) * 6.5;
      const split = 0.55;
      if (age < split || child === 4) return at(vx, vy);
      const [sx, sy] = flight(burst.x, burst.y, vx, vy, split, 1.9, GRAVITY);
      const childAngle = parentAngle + child * Math.PI / 2 + Math.PI / 4;
      const [x, y] = flight(sx, sy, Math.cos(childAngle) * 13, Math.sin(childAngle) * 7,
        age - split, 2.2, GRAVITY);
      return { x, y, color: burst.accent };
    }
    case "saturn": {
      // A small planet with a wide, tilted ring in a second color.
      const half = Math.floor(count / 2);
      if (index < half) return at(Math.cos(angle * 2) * 6, Math.sin(angle * 2) * 4.5);
      const tilt = hash(burst.seed, 16) * 0.3 - 0.15;
      const ringAngle = (index - half) / (count - half) * Math.PI * 2;
      const rx = Math.cos(ringAngle) * 20;
      const ry = Math.sin(ringAngle) * 5.5;
      const point = at(rx * Math.cos(tilt) - ry * Math.sin(tilt), rx * Math.sin(tilt) + ry * Math.cos(tilt));
      return { ...point, color: burst.accent };
    }
    case "pinwheel": {
      // Curved arms keep turning as they open, like a spinning wheel of sparks.
      const arm = index % 4;
      const along = 0.35 + Math.floor(index / 4) / Math.ceil(count / 4) * 0.65;
      const spin = hash(burst.seed, 17) < 0.5 ? -1 : 1;
      const radius = (1 - Math.exp(-1.6 * age)) / 1.6 * 12 * along;
      const turn = arm / 4 * Math.PI * 2 + spin * (age * 2.2 + along * 1.8);
      const color = burst.colors[arm % burst.colors.length]!;
      return {
        x: burst.x + Math.cos(turn) * radius * 1.8,
        y: burst.y + Math.sin(turn) * radius * 0.8 + GRAVITY * 0.3 * age * age,
        color,
      };
    }
    case "star": {
      const [x, y] = starPoint(index / count, hash(burst.seed, 18) * 0.6 - 0.3);
      return at(x * 17, y * 8.5, 1.9, GRAVITY * 0.5);
    }
    default: {
      const speed = 7 + hash(burst.seed, index + 60) * 5;
      return at(Math.cos(angle) * speed * 1.9, Math.sin(angle) * speed * 0.75);
    }
  }
}

function drawBurst(canvas: BrailleCanvas, burst: Burst, t: number): number {
  const age = t - burst.launch;
  if (age < burst.rise) {
    // The rocket climbs on an easing arc with a short spark tail.
    for (let tail = 0; tail < 7; tail++) {
      const s = Math.max(0, age - tail * 0.035) / burst.rise;
      const eased = 1 - (1 - s) * (1 - s);
      const y = canvas.dotHeight - (canvas.dotHeight - burst.y) * eased;
      const x = burst.x + Math.sin(s * 5 + burst.seed) * 0.6;
      canvas.splat(x, y, Math.exp(-tail * 0.45) * 0.95, mix([255, 230, 180], [255, 130, 60], tail / 7));
    }
    return 0;
  }

  const burstAge = age - burst.rise;
  const life = lifetime(burst.shape);
  const remaining = 1 - burstAge / life;
  const count = particleCount(burst.shape);
  const trail = trailLength(burst.shape);
  const trailStep = burst.shape === "willow" || burst.shape === "palm" ? 0.07 : 0.04;

  if (burstAge < 0.18) {
    canvas.splat(burst.x, burst.y, (1 - burstAge / 0.18) * 2.4, [255, 255, 240]);
  }
  for (let index = 0; index < count; index++) {
    for (let step = 0; step < trail; step++) {
      const sampleAge = burstAge - step * trailStep;
      if (sampleAge < 0) break;
      const particle = particleAt(burst, index, count, sampleAge);
      let energy = Math.pow(remaining, 1.3) * (1 - step / trail) * 1.1;
      let color = mix(particle.color, burst.fadeColor, Math.min(1, burstAge / life * 1.4));
      // A white-hot flash cools into the burst color.
      color = mix(color, [255, 255, 245], Math.max(0, 1 - burstAge / 0.35) * 0.8);
      if (burst.shape === "crackle" && burstAge > life * 0.45) {
        // Late in life each star breaks into glitter that twinkles on and off.
        const flicker = hash(burst.seed + index, Math.floor(t * 14) + step);
        energy *= flicker > 0.45 ? 1.4 : 0;
        color = mix(color, [255, 250, 220], 0.6);
      }
      canvas.splat(particle.x, particle.y, energy, color);
    }
  }
  return Math.pow(remaining, 2);
}

/** Night fireworks over a city skyline whose windows catch the light. */
export function renderFireworks(width: number, seconds: number): string[] {
  const canvas = new BrailleCanvas(width);
  const t = seconds;
  const w = canvas.dotWidth;
  const glow: { x: number; color: RGB; light: number }[] = [];

  for (const burst of activeBursts(w, t)) {
    const light = drawBurst(canvas, burst, t);
    if (light > 0) glow.push({ x: burst.x, color: burst.colors[0]!, light });
  }

  // Rooftops, walls, and windows catch the light of nearby bursts.
  let block = 0;
  for (let left = -3; left < w; block++) {
    const span = 6 + Math.floor(hash(block, 30) * 11);
    const height = 2 + Math.floor(hash(block, 31) * 4);
    const top = canvas.dotHeight - height;
    const center = left + span / 2;
    let light = 0;
    let lit: RGB = SKYLINE;
    for (const source of glow) {
      const reach = source.light * Math.exp(-Math.pow((center - source.x) / 40, 2));
      if (reach > light) lit = source.color;
      light = Math.max(light, reach);
    }
    const edge = mix(SKYLINE, lit, Math.min(0.8, light * 1.2));
    const edgeLight = 0.45 + light * 0.55;
    for (let x = left; x < left + span; x++) {
      canvas.addDot(x, top, 0.3 + light * 0.4, mix([0, 0, 0], edge, edgeLight));
    }
    for (let y = top + 1; y < canvas.dotHeight; y++) {
      canvas.addDot(left, y, 0.25, mix([0, 0, 0], edge, edgeLight * 0.8));
      for (let x = left + 2; x < left + span - 1; x += 2) {
        if ((y - top) % 2 === 1) continue;
        const windowSeed = hash(block * 131 + x - left, y);
        // Each window switches on or off every few minutes, never mid-glance.
        if (hash(Math.floor(t / 40 + windowSeed * 9), block * 17 + x + y) < 0.55) continue;
        canvas.addDot(x, y, 0.25, mix([0, 0, 0], mix(WINDOW, lit, light * 0.5), 0.6 + light * 0.4));
      }
    }
    left += span + Math.floor(hash(block, 32) * 3);
  }
  return canvas.render();
}

const epoch = performance.now();
export const fireworksScene: Scene = {
  name: "fireworks",
  height: 4,
  render: (width) => renderFireworks(width, (performance.now() - epoch) / 1000),
};
