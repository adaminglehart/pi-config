import type { Scene } from "./types.js";

/**
 * Nebula Scene — Continuous supernova-style nebula
 *
 * Directly replicates the supernova animation's rendering approach:
 * distance from a wandering center, angle, two blended FBM noise fields,
 * edge falloff, and a separate temperature→color mapping.
 * Runs as a seamless loop rather than a one-shot explosion.
 */

// ─── Noise (identical to supernova.ts) ───

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h = h ^ (h >>> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}

function noise2d(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const n00 = hash(ix, iy, seed);
  const n10 = hash(ix + 1, iy, seed);
  const n01 = hash(ix, iy + 1, seed);
  const n11 = hash(ix + 1, iy + 1, seed);

  const nx0 = n00 + sx * (n10 - n00);
  const nx1 = n01 + sx * (n11 - n01);
  return nx0 + sy * (nx1 - nx0);
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let val = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    val += amp * noise2d(x * freq, y * freq, seed + i * 7);
    amp *= 0.5;
    freq *= 2;
  }
  return val;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ─── Character + color ramps (identical to supernova.ts) ───

const CHARS = [
  " ", ".", "·", "∴", "∵", "░", "▒", "▓", "█", "✦", "✧", "*", "◆", "◇", "●",
];

const TEMP_COLORS = [
  "231", "195", "159", "117", "229", "228", "222", "216",
  "210", "204", "198", "162", "126", "90", "54", "236",
];

// ─── Config ───

const SCENE_HEIGHT = 4;
const ASPECT = 2.2;
const SEED = 0.42;

// ─── State ───

let startTime = Date.now();

export const nebulaScene: Scene = {
  name: "nebula",
  height: SCENE_HEIGHT,

  render(width: number, _contextPercent: number): string[] {
    const now = Date.now();
    const t = (now - startTime) / 1000;
    const reset = "\x1b[0m";

    // Center wanders slowly on a Lissajous path
    const centerX = width * (0.5 + 0.3 * Math.sin(t * 0.05));
    const centerY = SCENE_HEIGHT * (0.5 + 0.2 * Math.cos(t * 0.07));

    const maxR = Math.max(SCENE_HEIGHT / 2, width / ASPECT / 2);
    // Nebula radius breathes slowly, with per-angle noise for ragged edges
    const baseRadius = 0.8 + 0.15 * Math.sin(t * 0.08);

    const lines: string[] = [];

    for (let row = 0; row < SCENE_HEIGHT; row++) {
      let line = "";
      for (let col = 0; col < width; col++) {
        // Distance + angle from wandering center (supernova-style)
        const dx = (col - centerX) / ASPECT;
        const dy = row - centerY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const normDist = dist / maxR;
        const angle = Math.atan2(dy, dx);

        // Vary radius by angle so the edge is ragged, not a clean circle
        const edgeNoise = fbm(angle * 2 + t * 0.05, normDist * 3, 5555, 2);
        const nebulaRadius = baseRadius + (edgeNoise - 0.5) * 0.25;

        // ── Nebula density: two FBM fields blended, exactly like supernova ──
        const noiseScale = 4.0;
        const n1 = fbm(
          col / width * noiseScale + SEED,
          row / SCENE_HEIGHT * noiseScale + t * 0.3,
          SEED * 0x7fffffff,
          4,
        );
        const n2 = fbm(
          col / width * noiseScale * 1.5 + SEED + 10,
          row / SCENE_HEIGHT * noiseScale * 1.5,
          (SEED + 5) * 0x7fffffff,
          3,
        );
        const nebulaDensity = n1 * 0.6 + n2 * 0.4;

        let intensity = 0;
        let temperature = 0;

        // ── Main nebula cloud with edge falloff ──
        if (normDist < nebulaRadius) {
          const edgeFalloff = 1.0 - normDist / nebulaRadius;
          intensity = nebulaDensity * edgeFalloff;
          // Brighter filaments (supernova-style)
          if (nebulaDensity > 0.55) {
            intensity *= 1.3;
          }
        }

        // ── Fading core glow ──
        if (normDist < 0.15) {
          const coreFade = (0.15 - normDist) / 0.15;
          intensity = Math.max(intensity, coreFade * 0.3);
        }

        // ── Angle-dependent asymmetry (like supernova jets, but subtle) ──
        const jetAngle = t * 0.04; // Slowly rotating
        const angleDiff = Math.abs(
          Math.atan2(Math.sin(angle - jetAngle), Math.cos(angle - jetAngle)),
        );
        if (angleDiff < 0.5 && normDist < nebulaRadius * 1.2) {
          const jetBoost = (0.5 - angleDiff) / 0.5 * 0.15;
          intensity += jetBoost * (1.0 - normDist / (nebulaRadius * 1.2));
        }

        // Temperature cycles slowly — gives color variation over time
        temperature = 0.3 + 0.3 * Math.sin(t * 0.035 + normDist * 2.0 + angle * 0.3);

        intensity = clamp(intensity, 0, 1);
        temperature = clamp(temperature, 0, 1);

        // Map to character (supernova-style)
        const charIdx = Math.floor(intensity * (CHARS.length - 1));
        const ch = CHARS[charIdx]!;

        // Map to color (supernova-style temperature ramp)
        const colorIdx = Math.floor(temperature * (TEMP_COLORS.length - 1));
        const color = TEMP_COLORS[colorIdx]!;

        if (ch === " ") {
          line += " ";
        } else {
          const bold = intensity > 0.7 ? "\x1b[1m" : "";
          line += `${bold}\x1b[38;5;${color}m${ch}${reset}`;
        }
      }
      lines.push(line);
    }

    return lines;
  },

  onCommand() {
    startTime = Date.now();
  },
};
