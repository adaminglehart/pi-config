import { AQUARIUM_ROWS, aquariumCreatures, aquariumRandom } from "../rendering/aquarium-life.js";
import { lightGlyph, spectralColor, type Palette, type RGB } from "../rendering/spectral-color.js";
import type { Scene } from "../rendering/types.js";

const FISH_COLORS: Palette = [
  [255, 199, 78], [255, 120, 133], [175, 141, 255],
  [88, 224, 241], [117, 244, 170],
];
const CORAL_COLORS: readonly RGB[] = [[42, 167, 130], [202, 99, 143], [56, 139, 190]];
const KELP_BASE: RGB = [46, 150, 92];
const KELP_TIP: RGB = [140, 230, 120];
const SHAFT: RGB = [90, 160, 210];
const JELLY: RGB = [255, 120, 200];
const JELLY_GLOW: RGB = [170, 130, 255];
const JELLY_TRIP = 26;

function mix(from: RGB, to: RGB, amount: number): RGB {
  return [
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ];
}

function paint(buffer: string[][], row: number, x: number, text: string, color: RGB, light: number): void {
  if (row < 0 || row >= buffer.length) return;
  for (const glyph of text) {
    if (x >= 0 && x < buffer[row]!.length) buffer[row]![x] = lightGlyph(glyph, color, light);
    x++;
  }
}

/** Tropical schools over rippling blue water, swaying coral, and rising bubbles. */
export function renderAquarium(width: number, seconds: number, seed: number, extraFish = 0): string[] {
  const t = seconds;
  const buffer = Array.from({ length: AQUARIUM_ROWS }, () => Array<string>(width).fill(" "));

  // Sunlight slants down from the surface in soft shafts that drift slowly.
  for (let row = 0; row < AQUARIUM_ROWS; row++) {
    for (let col = 0; col < width; col++) {
      const phase = (col + row * 2.4) * 0.09 - t * 0.12 + Math.sin(col * 0.013 + t * 0.05) * 2;
      const shaft = Math.pow(Math.max(0, Math.sin(phase)), 10) * (1 - row * 0.15);
      if (shaft > 0.45) buffer[row]![col] = lightGlyph("░", SHAFT, 0.14 + shaft * 0.2);
    }
  }

  // The water stays dim enough that every bright creature remains readable.
  for (let row = 0; row < AQUARIUM_ROWS; row++) {
    for (let col = 0; col < width; col++) {
      const wave = Math.sin(col * 0.19 + row * 1.8 - t * 0.35
        + Math.sin(col * 0.07 + t * 0.23));
      if (wave > 0.75) {
        const glyph = wave > 0.96 && row === 0 ? "~" : "·";
        buffer[row]![col] = lightGlyph(glyph, [40, 105, 156], 0.32 + (wave - 0.75) * 1.2);
      }
    }
  }

  const plants = Math.max(1, Math.floor(width / 26));
  for (let plant = 0; plant < plants; plant++) {
    const phase = t * 0.65 + plant * 2.1;
    const x = Math.floor((plant + 0.5) * width / plants + Math.sin(phase) * 0.8);
    const color = CORAL_COLORS[plant % CORAL_COLORS.length]!;
    paint(buffer, AQUARIUM_ROWS - 1, x - 1, "╲│╱", color, 0.65);
    paint(buffer, AQUARIUM_ROWS - 2, x, Math.sin(phase) > 0 ? "╱" : "╲", color, 0.45);
  }

  // Kelp grows from the floor and ripples in the current.
  const kelps = Math.max(1, Math.floor(width / 40));
  for (let kelp = 0; kelp < kelps; kelp++) {
    const base = Math.floor((kelp + 0.25 + aquariumRandom(seed, kelp + 400) * 0.2) * width / kelps);
    const height = 2 + Math.floor(aquariumRandom(seed, kelp + 401) * (AQUARIUM_ROWS - 1));
    for (let level = 0; level < height; level++) {
      const bend = level / Math.max(1, height - 1);
      const sway = Math.sin(t * 0.9 + kelp * 1.7 - level * 0.8);
      const x = base + Math.round(Math.sin(t * 0.5 + kelp + level * 0.6) * 0.7 * bend);
      paint(buffer, AQUARIUM_ROWS - 1 - level, x, sway > 0 ? ")" : "(", mix(KELP_BASE, KELP_TIP, bend),
        0.55 + bend * 0.3);
    }
  }

  // Now and then a jellyfish pulses its way up through the water.
  for (let jelly = 0; jelly < Math.max(1, Math.floor(width / 90)); jelly++) {
    const period = 38 + jelly * 7;
    const start = aquariumRandom(seed, jelly + 500) * period;
    const trip = Math.floor((t + start) / period);
    const age = (t + start) % period;
    if (age >= JELLY_TRIP) continue;
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.2 + jelly);
    const bellRow = Math.round(AQUARIUM_ROWS - age / JELLY_TRIP * (AQUARIUM_ROWS + 2));
    const x = Math.floor(aquariumRandom(seed, trip * 31 + jelly + 501) * (width - 3)
      + Math.sin(t * 0.3 + jelly) * 3);
    const color = mix(JELLY, JELLY_GLOW, pulse);
    if (bellRow >= 0 && bellRow < AQUARIUM_ROWS) {
      paint(buffer, bellRow, x, pulse > 0.5 ? "(~)" : "(-)", color, 0.75 + pulse * 0.25);
    }
    if (bellRow + 1 >= 0 && bellRow + 1 < AQUARIUM_ROWS) {
      paint(buffer, bellRow + 1, x, pulse > 0.5 ? "|||" : ")|(", color, 0.45 + pulse * 0.3);
    }
  }

  for (let bubble = 0; bubble < Math.floor(width / 16); bubble++) {
    const life = (t / (3.5 + aquariumRandom(seed, bubble + 200) * 3)
      + aquariumRandom(seed, bubble + 201)) % 1;
    const y = AQUARIUM_ROWS + 0.5 - life * (AQUARIUM_ROWS + 2);
    const x = Math.floor(aquariumRandom(seed, bubble + 202) * width
      + Math.sin(t * 0.8 + bubble) * 1.2);
    for (let row = 0; row < AQUARIUM_ROWS; row++) {
      const glow = Math.exp(-Math.pow(row + 0.5 - y, 2) * 5);
      if (glow > 0.18) paint(buffer, row, x, "°", [121, 212, 236], glow * 0.68);
    }
  }

  const creatures = aquariumCreatures(width, t, seed, extraFish);
  // Fish breathe small bubbles that rise from their heads and fall behind.
  for (const creature of creatures) {
    if (creature.sprite.includes("_") || creature.row === 0) continue;
    const phase = (t * 0.22 + creature.hue * 13) % 1;
    if (phase >= 0.28) continue;
    const direction = creature.row % 2 === 1 ? -1 : 1;
    const rise = Math.floor(phase / 0.14);
    const head = direction === 1 ? creature.x + creature.sprite.length - 1 : creature.x;
    paint(buffer, creature.row - 1 - rise, head - direction * rise, rise === 0 ? "°" : "·",
      [150, 220, 240], 0.7 - rise * 0.2);
  }

  for (const creature of creatures) {
    // Each lane shares a color family, so fish read as schools.
    const school = aquariumRandom(seed, creature.row + 300);
    for (let i = 0; i < creature.sprite.length; i++) {
      const x = creature.x + i;
      if (x < 0 || x >= width) continue;
      const glyph = creature.sprite[i]!;
      const color = glyph === "o" ? [240, 253, 229] as const
        : spectralColor(FISH_COLORS, school + creature.hue * 0.1 + i * 0.012 + t * 0.004);
      const shimmer = 0.82 + 0.18 * Math.sin(t * 0.7 + creature.hue * 6 + i * 0.5);
      buffer[creature.row]![x] = lightGlyph(glyph, color, glyph === "o" ? 1 : shimmer);
    }
  }
  return buffer.map((row) => row.join("") + "\x1b[0m");
}

const epoch = performance.now();
const seed = Math.floor(Math.random() * 0x7fffffff);
let extraFish = 0;

export const aquariumScene: Scene = {
  name: "aquarium",
  height: AQUARIUM_ROWS,
  render: (width) => renderAquarium(width, (performance.now() - epoch) / 1000, seed, extraFish),
  onCommand() {
    extraFish = Math.min(3, extraFish + 1);
  },
};
