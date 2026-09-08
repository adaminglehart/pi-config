import { AQUARIUM_ROWS, aquariumCreatures, aquariumRandom } from "./aquarium-life.js";
import { lightGlyph, spectralColor, type Palette, type RGB } from "./spectral-color.js";
import type { Scene } from "./types.js";

const FISH_COLORS: Palette = [
  [255, 199, 78], [255, 120, 133], [175, 141, 255],
  [88, 224, 241], [117, 244, 170],
];
const CORAL_COLORS: readonly RGB[] = [[42, 167, 130], [202, 99, 143], [56, 139, 190]];

function paint(buffer: string[][], row: number, x: number, text: string, color: RGB, light: number): void {
  for (const glyph of text) {
    if (x >= 0 && x < buffer[row]!.length) buffer[row]![x] = lightGlyph(glyph, color, light);
    x++;
  }
}

/** Tropical schools over rippling blue water, swaying coral, and rising bubbles. */
export function renderAquarium(width: number, seconds: number, seed: number, extraFish = 0): string[] {
  const t = seconds;
  const buffer = Array.from({ length: AQUARIUM_ROWS }, () => Array<string>(width).fill(" "));

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
    paint(buffer, 2, x - 1, "╲│╱", color, 0.65);
    paint(buffer, 1, x, Math.sin(phase) > 0 ? "╱" : "╲", color, 0.45);
  }

  for (let bubble = 0; bubble < Math.floor(width / 16); bubble++) {
    const life = (t / (3.5 + aquariumRandom(seed, bubble + 200) * 3)
      + aquariumRandom(seed, bubble + 201)) % 1;
    const y = 3.5 - life * 5;
    const x = Math.floor(aquariumRandom(seed, bubble + 202) * width
      + Math.sin(t * 0.8 + bubble) * 1.2);
    for (let row = 0; row < AQUARIUM_ROWS; row++) {
      const glow = Math.exp(-Math.pow(row + 0.5 - y, 2) * 5);
      if (glow > 0.18) paint(buffer, row, x, "°", [121, 212, 236], glow * 0.68);
    }
  }

  for (const creature of aquariumCreatures(width, t, seed, extraFish)) {
    for (let i = 0; i < creature.sprite.length; i++) {
      const x = creature.x + i;
      if (x < 0 || x >= width) continue;
      const glyph = creature.sprite[i]!;
      const color = glyph === "o" ? [240, 253, 229] as const
        : spectralColor(FISH_COLORS, creature.hue + i * 0.035 + t * 0.005);
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
