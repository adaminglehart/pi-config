import { ansi, colors } from "../index.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Scene } from "./types.js";

const CONFIG = {
  MAX_FISH_COUNT: 25,
  CONTEXT_PERCENT_PER_FISH: 4,
  AQUARIUM_ROWS: 3,
  // Speed in characters per second — range gives visible variety
  MIN_SPEED: 1.5,
  MAX_SPEED_VARIANCE: 4.0,
  SPRITES: {
    RIGHT: ["><>", "><(((º>", "><*))>", "><))))°>", "~ᴗ~)", "><(((·>"],
    LEFT: ["<><", "<°)))<", "<*))><", "<°))))><", "(~ᴗ~", "<·)))><"],
  },
};

interface Fish {
  x: number;
  y: number;
  speed: number;
  dir: 1 | -1;
  visual: string;
}

let aquariumFish: Fish[] = [];
let manualFishCount = 0;
let lastRenderTime = Date.now();

function randomizeFish(fish: Fish, width: number) {
  fish.y = Math.floor(Math.random() * CONFIG.AQUARIUM_ROWS);
  fish.speed = CONFIG.MIN_SPEED + Math.random() * CONFIG.MAX_SPEED_VARIANCE;
  fish.dir = Math.random() > 0.5 ? 1 : -1;

  const pool = fish.dir === 1 ? CONFIG.SPRITES.RIGHT : CONFIG.SPRITES.LEFT;
  fish.visual = pool[Math.floor(Math.random() * pool.length)]!;

  fish.x = fish.dir === 1 ? -15 : width + 15;
}

function init() {
  aquariumFish = Array.from({ length: 100 }, () => {
    const fish = {} as Fish;
    randomizeFish(fish, 100);
    fish.x = Math.random() * 120 - 10;
    fish.speed = CONFIG.MIN_SPEED + Math.random() * CONFIG.MAX_SPEED_VARIANCE;
    return fish;
  });
}

init();

export const aquariumScene: Scene = {
  name: "aquarium",
  height: CONFIG.AQUARIUM_ROWS,
  render(width: number, contextPercent: number): string[] {
    const now = Date.now();
    const dt = Math.min((now - lastRenderTime) / 1000, 0.5); // seconds, capped to avoid jumps
    lastRenderTime = now;

    const contextFish =
      Math.floor((contextPercent || 0) / CONFIG.CONTEXT_PERCENT_PER_FISH) + 1;
    const numFish = Math.min(100, contextFish + manualFishCount);

    const buffer: string[][] = Array.from(
      { length: CONFIG.AQUARIUM_ROWS },
      () => new Array(width).fill(" "),
    );

    for (let i = 0; i < numFish; i++) {
      const fish = aquariumFish[i]!;
      fish.x += fish.speed * fish.dir * dt;

      const vWidth = visibleWidth(fish.visual);
      if (fish.dir === 1 && fish.x > width + 5) randomizeFish(fish, width);
      if (fish.dir === -1 && fish.x < -vWidth - 5) randomizeFish(fish, width);

      const startX = Math.floor(fish.x);
      for (let vIdx = 0; vIdx < vWidth; vIdx++) {
        const x = startX + vIdx;
        if (x >= 0 && x < width) {
          buffer[fish.y]![x] =
            ansi.fg(colors.input) + fish.visual[vIdx] + ansi.reset;
        }
      }
    }

    return buffer.map((row) => row.join(""));
  },
  onCommand() {
    manualFishCount++;
  },
};
