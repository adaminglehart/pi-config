/**
 * Supernova Extension — Dazzling ASCII supernova animation
 *
 * Inspired by sourcegraph/amp's animated-supernova widget.
 * Renders a full terminal-width supernova explosion through multiple phases:
 *   1. Dense star (small bright core)
 *   2. Collapse & flash (bright burst)
 *   3. Explosion (shockwave expanding outward)
 *   4. Nebula formation (diffuse remnant with cooling colors)
 *   5. Fade to black
 *
 * Usage: /supernova
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";

// ═══════════════════════════════════════════════════════════════════════════
// Constants & Types
// ═══════════════════════════════════════════════════════════════════════════

const TICK_MS = 50;
const TOTAL_DURATION_S = 12;
const TOTAL_FRAMES = (TOTAL_DURATION_S * 1000) / TICK_MS;

// Character intensity palette (low → high)
const CHARS_BY_INTENSITY = [
  " ",    // 0 - empty
  ".",    // 1
  "·",    // 2
  "∴",    // 3
  "∵",    // 4
  "░",    // 5
  "▒",    // 6
  "▓",    // 7
  "█",    // 8
  "✦",    // 9 - bright stellar
  "✧",    // 10
  "*",    // 11
  "◆",    // 12
  "◇",    // 13
  "●",    // 14 - peak
];

// Color temperature ramp (hot → cool) using 256-color ANSI
// White → Blue-White → Yellow → Orange → Red → Dark Red → Dim
const TEMP_COLORS = [
  "231",  // 0 - white hot
  "195",  // 1 - blue-white
  "159",  // 2 - light blue
  "117",  // 3 - blue
  "229",  // 4 - yellow-white
  "228",  // 5 - yellow
  "222",  // 6 - gold
  "216",  // 7 - orange
  "210",  // 8 - light red
  "204",  // 9 - red
  "198",  // 10 - hot pink
  "162",  // 11 - magenta
  "126",  // 12 - dark magenta
  "90",   // 13 - purple
  "54",   // 14 - dark purple
  "236",  // 15 - near black
];

// ═══════════════════════════════════════════════════════════════════════════
// Pseudo-random noise (deterministic, no dependencies)
// ═══════════════════════════════════════════════════════════════════════════

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h = h ^ (h >>> 16);
  return (h & 0x7fffffff) / 0x7fffffff; // 0..1
}

function noise2d(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  // Smoothstep
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

// ═══════════════════════════════════════════════════════════════════════════
// Supernova Renderer
// ═══════════════════════════════════════════════════════════════════════════

interface SupernovaState {
  frame: number;
  seed: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function renderSupernova(
  state: SupernovaState,
  gridW: number,
  gridH: number,
): string[] {
  const t = state.frame / TOTAL_FRAMES; // 0..1 normalized time
  const cx = gridW / 2;
  const cy = gridH / 2;
  // Aspect ratio correction: terminal chars are ~2:1
  const aspect = 2.2;

  const lines: string[] = [];
  const reset = "\x1b[0m";

  for (let row = 0; row < gridH; row++) {
    let line = "";
    for (let col = 0; col < gridW; col++) {
      // Distance from center (aspect-corrected)
      const dx = (col - cx) / aspect;
      const dy = row - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxR = Math.max(gridH / 2, gridW / aspect / 2);
      const normDist = dist / maxR; // 0=center, 1=edge

      // Angle from center (for asymmetric features)
      const angle = Math.atan2(dy, dx);

      // ─── Phase calculations ───
      let intensity = 0;
      let temperature = 0; // 0=hot, 1=cool

      if (t < 0.08) {
        // Phase 1: Dense star — small bright core pulsating
        const phase = t / 0.08;
        const coreRadius = 0.08 + 0.02 * Math.sin(phase * Math.PI * 6);
        if (normDist < coreRadius) {
          intensity = 1.0 - normDist / coreRadius;
          intensity *= 0.6 + 0.4 * Math.sin(phase * Math.PI * 4);
        }
        // Faint corona
        if (normDist < 0.2) {
          const corona = (0.2 - normDist) / 0.2 * 0.15;
          intensity = Math.max(intensity, corona);
        }
        temperature = 0.1; // Very hot
      } else if (t < 0.15) {
        // Phase 2: Collapse & Flash — blinding burst
        const phase = (t - 0.08) / 0.07;
        const flashRadius = 0.05 + phase * 0.8;
        if (normDist < flashRadius) {
          const falloff = 1.0 - normDist / flashRadius;
          intensity = falloff * falloff;
          // Peak flash at mid-phase
          const flashPeak = 1.0 - Math.abs(phase - 0.5) * 2;
          intensity *= 0.5 + 0.5 * flashPeak;
        }
        temperature = phase * 0.2; // Still very hot
      } else if (t < 0.55) {
        // Phase 3: Explosion — expanding shockwave with turbulence
        const phase = (t - 0.15) / 0.4;
        const waveRadius = phase * 1.2;
        const waveWidth = 0.08 + phase * 0.15;

        // Main shockwave ring
        const waveDist = Math.abs(normDist - waveRadius);
        if (waveDist < waveWidth) {
          const ringIntensity = 1.0 - waveDist / waveWidth;
          intensity = ringIntensity * ringIntensity * (1.0 - phase * 0.3);
        }

        // Inner glow (hot remnant core)
        if (normDist < waveRadius * 0.6) {
          const coreGlow = (1.0 - normDist / (waveRadius * 0.6)) * (1.0 - phase * 0.7);
          intensity = Math.max(intensity, coreGlow * 0.7);
        }

        // Turbulent ejecta (noise-driven filaments)
        const noiseScale = 3.0 + phase * 2;
        const turb = fbm(
          col / gridW * noiseScale + state.seed,
          row / gridH * noiseScale,
          state.seed,
          3,
        );
        if (normDist < waveRadius + 0.1 && normDist > waveRadius * 0.2) {
          const ejectaStrength = turb * 0.5 * (1.0 - phase * 0.4);
          const radialFalloff = 1.0 - Math.abs(normDist - waveRadius * 0.7) / (waveRadius * 0.5);
          if (radialFalloff > 0) {
            intensity = Math.max(intensity, ejectaStrength * clamp(radialFalloff, 0, 1));
          }
        }

        // Asymmetric jets (along two random-ish axes)
        const jetAngle1 = state.seed * 6.28;
        const jetAngle2 = jetAngle1 + Math.PI;
        for (const ja of [jetAngle1, jetAngle2]) {
          const angleDiff = Math.abs(Math.atan2(Math.sin(angle - ja), Math.cos(angle - ja)));
          if (angleDiff < 0.3) {
            const jetStrength = (0.3 - angleDiff) / 0.3;
            const jetReach = phase * 1.5;
            if (normDist < jetReach) {
              const jetFalloff = 1.0 - normDist / jetReach;
              intensity = Math.max(intensity, jetStrength * jetFalloff * 0.6 * (1.0 - phase * 0.5));
            }
          }
        }

        temperature = 0.15 + phase * 0.5; // Gradually cooling
      } else if (t < 0.85) {
        // Phase 4: Nebula formation — diffuse expanding remnant
        const phase = (t - 0.55) / 0.3;
        const nebulaRadius = 0.7 + phase * 0.4;

        // Diffuse nebula cloud (noise-driven)
        const noiseScale = 4.0;
        const n1 = fbm(
          col / gridW * noiseScale + state.seed,
          row / gridH * noiseScale + t * 0.5,
          state.seed,
          4,
        );
        const n2 = fbm(
          col / gridW * noiseScale * 1.5 + state.seed + 10,
          row / gridH * noiseScale * 1.5,
          state.seed + 5,
          3,
        );
        const nebulaDensity = (n1 * 0.6 + n2 * 0.4);

        if (normDist < nebulaRadius) {
          const edgeFalloff = 1.0 - (normDist / nebulaRadius);
          intensity = nebulaDensity * edgeFalloff * (1.0 - phase * 0.5);
          // Slightly brighter filaments
          if (nebulaDensity > 0.55) {
            intensity *= 1.3;
          }
        }

        // Fading core
        if (normDist < 0.15) {
          const coreFade = (0.15 - normDist) / 0.15 * (1.0 - phase);
          intensity = Math.max(intensity, coreFade * 0.4);
        }

        temperature = 0.4 + phase * 0.4; // Cooling into reds/purples
      } else {
        // Phase 5: Fade to black
        const phase = (t - 0.85) / 0.15;
        const nebulaRadius = 1.1;
        const noiseScale = 4.0;
        const n1 = fbm(
          col / gridW * noiseScale + state.seed,
          row / gridH * noiseScale + t * 0.3,
          state.seed,
          3,
        );
        if (normDist < nebulaRadius) {
          const edgeFalloff = 1.0 - (normDist / nebulaRadius);
          intensity = n1 * edgeFalloff * (1.0 - phase) * 0.4;
        }
        temperature = 0.7 + phase * 0.3; // Very cool, dimming
      }

      intensity = clamp(intensity, 0, 1);
      temperature = clamp(temperature, 0, 1);

      // Map to character
      const charIdx = Math.floor(intensity * (CHARS_BY_INTENSITY.length - 1));
      const ch = CHARS_BY_INTENSITY[charIdx]!;

      // Map to color
      const colorIdx = Math.floor(temperature * (TEMP_COLORS.length - 1));
      const color = TEMP_COLORS[colorIdx]!;

      if (ch === " ") {
        line += " ";
      } else {
        // Slight brightness variation via bold for high intensity
        const bold = intensity > 0.7 ? "\x1b[1m" : "";
        line += `${bold}\x1b[38;5;${color}m${ch}${reset}`;
      }
    }
    lines.push(line);
  }

  return lines;
}

// ═══════════════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════════════

class SupernovaComponent {
  private state: SupernovaState;
  private interval: ReturnType<typeof setInterval> | null = null;
  private onClose: () => void;
  private tui: { requestRender: () => void };
  private cachedLines: string[] = [];
  private cachedWidth = 0;
  private version = 0;
  private cachedVersion = -1;
  private looping: boolean;

  constructor(
    tui: { requestRender: () => void },
    onClose: () => void,
    looping: boolean,
  ) {
    this.tui = tui;
    this.onClose = onClose;
    this.looping = looping;
    this.state = {
      frame: 0,
      seed: Math.random(),
    };
    this.startAnimation();
  }

  private startAnimation(): void {
    this.interval = setInterval(() => {
      this.state.frame++;
      if (this.state.frame >= TOTAL_FRAMES) {
        if (this.looping) {
          this.state.frame = 0;
          this.state.seed = Math.random(); // New explosion each loop
        } else {
          this.dispose();
          this.onClose();
          return;
        }
      }
      this.version++;
      this.tui.requestRender();
    }, TICK_MS);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q" || data === "Q") {
      this.dispose();
      this.onClose();
      return;
    }
    // Space restarts with new seed
    if (data === " " || data === "r" || data === "R") {
      this.state.frame = 0;
      this.state.seed = Math.random();
      this.version++;
      this.tui.requestRender();
    }
    // L toggles looping
    if (data === "l" || data === "L") {
      this.looping = !this.looping;
      this.version++;
      this.tui.requestRender();
    }
  }

  invalidate(): void {
    this.cachedWidth = 0;
  }

  render(width: number): string[] {
    if (width === this.cachedWidth && this.cachedVersion === this.version) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
    const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
    const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
    const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
    // Reserve 3 lines for header + border + footer, 2 for borders around grid
    const gridH = Math.max(8, Math.min(30, process.stdout.rows - 6));
    const gridW = Math.min(width - 4, 100); // Bound to avoid insane width

    // Calculate progress
    const progress = this.state.frame / TOTAL_FRAMES;
    const phaseName = progress < 0.08 ? "Star"
      : progress < 0.15 ? "Collapse"
      : progress < 0.55 ? "Explosion"
      : progress < 0.85 ? "Nebula"
      : "Fade";

    // Header
    const title = `${bold(cyan("SUPERNOVA"))} │ ${yellow(phaseName)}`;
    const loopLabel = this.looping ? dim("loop:on") : dim("loop:off");
    const progressBar = renderProgressBar(progress, 20);
    const headerContent = `${title} ${progressBar} ${loopLabel}`;
    const headerPad = Math.max(0, gridW - visibleWidth(headerContent));

    // Top border
    lines.push(padLine(dim(` ╭${"─".repeat(gridW)}╮`), width));

    // Header
    lines.push(padLine(
      dim(" │") + headerContent + " ".repeat(headerPad) + dim("│"),
      width,
    ));

    // Separator
    lines.push(padLine(dim(` ├${"─".repeat(gridW)}┤`), width));

    // Render the supernova grid
    const supernovaLines = renderSupernova(this.state, gridW, gridH);
    for (const sLine of supernovaLines) {
      const contentPad = Math.max(0, gridW - visibleWidth(sLine));
      lines.push(padLine(
        dim(" │") + sLine + " ".repeat(contentPad) + dim("│"),
        width,
      ));
    }

    // Separator
    lines.push(padLine(dim(` ├${"─".repeat(gridW)}┤`), width));

    // Footer
    const footer = `${bold("SPACE")} restart ${dim("│")} ${bold("L")} loop ${dim("│")} ${bold("Q/ESC")} quit`;
    const footerPad = Math.max(0, gridW - visibleWidth(footer));
    lines.push(padLine(
      dim(" │") + footer + " ".repeat(footerPad) + dim("│"),
      width,
    ));

    // Bottom border
    lines.push(padLine(dim(` ╰${"─".repeat(gridW)}╯`), width));

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.cachedVersion = this.version;

    return lines;
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

function renderProgressBar(progress: number, barWidth: number): string {
  const filled = Math.round(progress * barWidth);
  const empty = barWidth - filled;
  const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
  const bright = (s: string) => `\x1b[38;5;213m${s}\x1b[0m`;
  return dim("[") + bright("█".repeat(filled)) + dim("░".repeat(empty)) + dim("]");
}

function padLine(line: string, width: number): string {
  const vis = visibleWidth(line);
  const padding = Math.max(0, width - vis);
  return line + " ".repeat(padding);
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function supernova(pi: ExtensionAPI) {
  pi.registerCommand("supernova", {
    description: "Watch a supernova explode in ASCII art ✦",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Supernova requires interactive mode", "error");
        return;
      }

      const looping = args?.includes("loop") ?? false;

      await ctx.ui.custom((tui, _theme, _kb, done) => {
        return new SupernovaComponent(
          tui,
          () => done(undefined),
          looping,
        );
      });
    },
  });
}
