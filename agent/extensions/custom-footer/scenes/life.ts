import { ansi, colors } from "../index.js";
import type { Scene } from "./types.js";

/**
 * Conway's Game of Life Scene
 */

const CONFIG = {
  SEED_DENSITY: 0.96, // Lower = more cells (currently ~8% density)
  UPDATE_INTERVAL_MS: 500,
  STALE_GENERATION_LIMIT: 100,
  MIN_ALIVE_THRESHOLD: 5,
};

let grid: number[][] = [];
let lastWidth = 0;
let lastHeight = 0;
let generation = 0;
let lastUpdate = 0;

function initGrid(width: number, height: number) {
  grid = Array.from({ length: height }, () =>
    Array.from({ length: width }, () =>
      Math.random() > CONFIG.SEED_DENSITY ? 1 : 0,
    ),
  );
  lastWidth = width;
  lastHeight = height;
  generation = 0;
}

function getNextGen() {
  const next = grid.map((row, y) =>
    row.map((cell, x) => {
      let neighbors = 0;
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          if (i === 0 && j === 0) continue;
          const ny = y + i;
          const nx = x + j;
          if (ny >= 0 && ny < lastHeight && nx >= 0 && nx < lastWidth) {
            neighbors += grid[ny]![nx]!;
          }
        }
      }

      if (cell === 1) {
        return neighbors === 2 || neighbors === 3 ? 1 : 0;
      } else {
        return neighbors === 3 ? 1 : 0;
      }
    }),
  );
  grid = next;
  generation++;
}

export const lifeScene: Scene = {
  name: "life",
  height: 3,
  render(width: number, contextPercent: number): string[] {
    // Initialize or resize if needed
    if (width !== lastWidth) {
      initGrid(width, 3);
    }

    // Slowly evolve based on generation vs time
    const now = Date.now();
    if (now - lastUpdate > CONFIG.UPDATE_INTERVAL_MS) {
      getNextGen();
      lastUpdate = now;

      // Periodically re-seed if it dies out or gets stale
      const aliveCount = grid.flat().filter((c) => c === 1).length;
      if (
        aliveCount < CONFIG.MIN_ALIVE_THRESHOLD ||
        generation > CONFIG.STALE_GENERATION_LIMIT
      ) {
        initGrid(width, 3);
      }
    }

    const aliveChar = "●";
    const deadChar = " ";

    return grid.map((row) =>
      row
        .map((cell) =>
          cell === 1
            ? ansi.fg(colors.input) + aliveChar + ansi.reset
            : deadChar,
        )
        .join(""),
    );
  },
  onCommand() {
    // Manual re-seed
    initGrid(lastWidth, 3);
  },
};
