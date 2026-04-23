/**
 * pi-animations — Animated working indicator
 *
 * Adapted from https://github.com/arpagon/pi-animations by arpagon (MIT)
 * Includes: neural-pulse, neon-bounce, aurora1, aurora
 *
 * Commands:
 *   /animation              Show status + list
 *   /animation showcase     Interactive browser
 *   /animation <name>       Set animation
 *   /animation on|off|random
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ═══════════════════════════════════════════════════════════════
// ANSI helpers
// ═══════════════════════════════════════════════════════════════

const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const bold = "\x1b[1m";
const nobold = "\x1b[22m";
const reset = "\x1b[0m";

// Pi gradient (magenta → purple → cyan)
const PI_GRAD = [
  [255, 0, 135],
  [175, 95, 175],
  [135, 95, 215],
  [95, 95, 255],
  [95, 175, 255],
  [0, 255, 255],
];

function hsl(h: number, s = 1, l = 0.5): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return rgb(
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  );
}

function lerpGrad(grad: number[][], t: number): [number, number, number] {
  const i = Math.floor(t * (grad.length - 1));
  const i2 = Math.min(i + 1, grad.length - 1);
  const lt = (t * (grad.length - 1)) % 1;
  return [
    Math.round(grad[i][0] + (grad[i2][0] - grad[i][0]) * lt),
    Math.round(grad[i][1] + (grad[i2][1] - grad[i][1]) * lt),
    Math.round(grad[i][2] + (grad[i2][2] - grad[i][2]) * lt),
  ];
}

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

type AnimationFn = (frame: number, width: number) => string | string[];

// ═══════════════════════════════════════════════════════════════
// Animations
// ═══════════════════════════════════════════════════════════════

// ─── Neural Pulse (1-line) ───────────────────────────────────
const neuralPulse: AnimationFn = (f, w) => {
  const N = Math.min(14, Math.floor(w / 4));
  const d = rgb(60, 60, 80);
  const pulse = [
    rgb(80, 80, 120),
    rgb(120, 100, 200),
    rgb(180, 140, 255),
    rgb(220, 180, 255),
    rgb(255, 220, 255),
    rgb(220, 180, 255),
    rgb(180, 140, 255),
  ];
  let line = "";
  for (let i = 0; i < N; i++) {
    const dist = (((i - f * 0.5) % N) + N) % N;
    const pi = dist < pulse.length ? Math.floor(dist) : -1;
    line += (pi >= 0 ? pulse[pi] : d) + (pi >= 0 ? "●" : "○");
    if (i < N - 1) {
      const cd = (((i + 0.5 - f * 0.5) % N) + N) % N;
      line +=
        (cd < pulse.length
          ? pulse[Math.min(Math.floor(cd), pulse.length - 1)]
          : d) + "──";
    }
  }
  return line + reset;
};

// ─── Neon Bounce (1-line) ────────────────────────────────────
const bounceTrail: { pos: number; age: number; color: number[] }[] = [];
const trailGlyphs = ["█", "▓", "▒", "░", "·"];

const neonBounce: AnimationFn = (f, w) => {
  // Match neural-pulse width: 14 nodes * 3 chars - 2 = 40
  const W = Math.min(40, w);
  const cycle = (f * 0.6) % (W * 2);
  const pos = Math.floor(cycle < W ? cycle : W * 2 - cycle);
  const [r, g, b] = lerpGrad(PI_GRAD, pos / W);
  bounceTrail.push({ pos, age: 0, color: [r, g, b] });
  const buf = new Array(W).fill(" ");
  for (const t of bounceTrail) {
    if (t.age < trailGlyphs.length && t.pos < W) {
      const fade = Math.max(0, 1 - t.age / 5);
      buf[t.pos] =
        rgb(
          Math.round(t.color[0] * fade),
          Math.round(t.color[1] * fade),
          Math.round(t.color[2] * fade),
        ) + trailGlyphs[Math.min(t.age, trailGlyphs.length - 1)];
    }
    t.age++;
  }
  if (pos < W)
    buf[pos] =
      bold +
      rgb(Math.min(255, r + 50), Math.min(255, g + 50), Math.min(255, b + 50)) +
      "█" +
      nobold;
  while (bounceTrail.length > 0 && bounceTrail[0].age > 5) bounceTrail.shift();
  return rgb(80, 80, 100) + "▐" + buf.join("") + rgb(80, 80, 100) + "▌" + reset;
};

// ─── Aurora (1-line) ─────────────────────────────────────────
const aurora1: AnimationFn = (f, w) => {
  const W = Math.min(40, w);
  const auroraChars = " ░▒▓█▓▒░";
  let line = "";
  for (let x = 0; x < W; x++) {
    const v1 = Math.sin(x * 0.08 + f * 0.04);
    const v2 = Math.sin(x * 0.12 - f * 0.03);
    const v3 = Math.sin(x * 0.06 + f * 0.05);
    const n = (v1 + v2 + v3 + 3) / 6;
    const hue = (x * 3 + f * 2) % 360;
    const sat = 0.7 + n * 0.3;
    const lum = 0.15 + n * 0.45;
    const ci = Math.floor(n * (auroraChars.length - 1));
    line += hsl(hue, sat, lum) + auroraChars[ci];
  }
  return line + reset;
};

// ─── Aurora 3-line ───────────────────────────────────────────
const aurora3: AnimationFn = (f, w) => {
  const W = w;
  const H = 3;
  const auroraChars = " ░▒▓█▓▒░";
  const lines: string[] = [];
  for (let y = 0; y < H; y++) {
    let line = "";
    for (let x = 0; x < W; x++) {
      const v1 = Math.sin(x * 0.08 + f * 0.04 + y * 1.2);
      const v2 = Math.sin(x * 0.12 - f * 0.03 + y * 0.8);
      const v3 = Math.sin((x + y * 10) * 0.06 + f * 0.05);
      const n = (v1 + v2 + v3 + 3) / 6;
      const hue = (x * 3 + f * 2 + y * 40) % 360;
      const sat = 0.7 + n * 0.3;
      const lum = 0.15 + n * 0.45;
      const ci = Math.floor(n * (auroraChars.length - 1));
      line += hsl(hue, sat, lum) + auroraChars[ci];
    }
    lines.push(line + reset);
  }
  return lines;
};

// ═══════════════════════════════════════════════════════════════
// Registry
// ═══════════════════════════════════════════════════════════════

interface AnimationDef {
  name: string;
  fn: AnimationFn;
  description: string;
  lines: number;
}

const ANIMATIONS: AnimationDef[] = [
  {
    name: "neural-pulse",
    fn: neuralPulse,
    description: "Energy pulses along neural pathway",
    lines: 1,
  },
  {
    name: "neon-bounce",
    fn: neonBounce,
    description: "Neon ball bouncing",
    lines: 1,
  },
  {
    name: "aurora1",
    fn: aurora1,
    description: "🌌 Aurora borealis (1-line)",
    lines: 1,
  },
  {
    name: "aurora",
    fn: aurora3,
    description: "🌌 Aurora borealis (3-line)",
    lines: 3,
  },
];

function getAnimation(name: string): AnimationDef | undefined {
  return ANIMATIONS.find((a) => a.name === name);
}

// ═══════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════

const STATE_KEY = Symbol.for("pi.ext.animations.state");
const CONFIG_NAME = "pi-animations.json";

// ─── Config persistence ─────────────────────────────────────
interface AnimConfig {
  anim?: string;
  randomMode?: boolean;
  enabled?: boolean;
}

function getConfigPath(): string {
  return join(getAgentDir(), "extensions", CONFIG_NAME);
}

function loadConfig(): AnimConfig {
  const cfgPath = getConfigPath();
  if (!existsSync(cfgPath)) return {};
  try {
    return JSON.parse(readFileSync(cfgPath, "utf-8")) as AnimConfig;
  } catch {
    return {};
  }
}

function saveConfig(config: AnimConfig): void {
  const dir = join(getAgentDir(), "extensions");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2) + "\n");
}

function resolveWidth(): number {
  return (process.stdout.columns || 80) - 4;
}

interface AnimState {
  anim: string;
  randomMode: boolean;
  frame: number;
  timer: ReturnType<typeof setInterval> | null;
  enabled: boolean;
}

function renderFrame(animName: string, frame: number, width: number): string[] {
  const anim = getAnimation(animName);
  if (!anim) return ["Working..."];
  const result = anim.fn(frame, width);
  return Array.isArray(result) ? result : [result];
}

function pickRandom(): string {
  return ANIMATIONS[Math.floor(Math.random() * ANIMATIONS.length)].name;
}

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();
  const state: AnimState = {
    anim: cfg.anim ?? "neural-pulse",
    randomMode: cfg.randomMode ?? false,
    enabled: cfg.enabled ?? true,
    frame: 0,
    timer: null,
  };
  (globalThis as Record<symbol, AnimState>)[STATE_KEY] = state;

  function persistConfig() {
    saveConfig({
      anim: state.anim,
      randomMode: state.randomMode,
      enabled: state.enabled,
    });
  }

  // ─── Animation ─────────────────────────────────────────────
  let lastAnimLines = 0;

  function startAnimation(ctx: ExtensionContext) {
    stopAnimation(ctx);
    if (!state.enabled) return;
    state.frame = 0;
    lastAnimLines = 0;
    const animName = state.randomMode ? pickRandom() : state.anim;
    state.timer = setInterval(() => {
      // Guard against firing after stopAnimation() — avoids leaving a
      // stale frame in pendingWorkingMessage when the interval sneaks in
      // between pi-core's agent_end (which destroys the loader) and the
      // extension's async agent_end handler (which clears the interval).
      if (!state.timer) return;
      state.frame++;
      const w = resolveWidth();
      const lines = renderFrame(animName, state.frame, w);
      if (lines.length === 1) {
        if (lastAnimLines > 1) ctx.ui.setWidget("anim-multi", undefined);
        ctx.ui.setWorkingMessage(lines[0]);
        lastAnimLines = 1;
      } else {
        if (lastAnimLines <= 1) ctx.ui.setWorkingMessage(undefined);
        ctx.ui.setWidget("anim-multi", lines);
        lastAnimLines = lines.length;
      }
    }, 60);
  }

  function stopAnimation(ctx?: ExtensionContext) {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    if (lastAnimLines > 1 && ctx) {
      ctx.ui.setWidget("anim-multi", undefined);
    }
    lastAnimLines = 0;
  }

  // ─── Events ────────────────────────────────────────────────
  pi.on("agent_start", async (_e, ctx) => {
    startAnimation(ctx);
  });

  pi.on("agent_end", async (_e, ctx) => {
    stopAnimation(ctx);
    ctx.ui.setWorkingMessage();
  });

  pi.on("session_shutdown", async () => {
    stopAnimation();
  });

  // ─── Showcase ──────────────────────────────────────────────
  async function runShowcase(ctx: ExtensionContext) {
    await ctx.ui
      .custom((tui, theme, _keybindings, done) => {
        let idx = 0;
        let frame = 0;

        const timer = setInterval(() => {
          frame++;
          tui.requestRender();
        }, 50);

        return {
          invalidate() {},
          dispose() {
            clearInterval(timer);
          },
          handleInput(data: string) {
            if (matchesKey(data, "escape") || data === "q") {
              clearInterval(timer);
              done(null);
            } else if (
              matchesKey(data, "right") ||
              data === "l" ||
              data === "n"
            ) {
              idx = (idx + 1) % ANIMATIONS.length;
              frame = 0;
            } else if (
              matchesKey(data, "left") ||
              data === "h" ||
              data === "p"
            ) {
              idx = (idx - 1 + ANIMATIONS.length) % ANIMATIONS.length;
              frame = 0;
            } else if (matchesKey(data, "enter") || data === " ") {
              clearInterval(timer);
              done(ANIMATIONS[idx].name);
            }
          },
          render(width: number): string[] {
            const anim = ANIMATIONS[idx];
            const w = Math.min(resolveWidth(), width - 4);
            const raw = anim.fn(frame, w);
            const rendered = Array.isArray(raw) ? raw : [raw];
            const out: string[] = [];
            out.push("");
            out.push(theme.fg("accent", "  ▶ Animation Showcase"));
            out.push("");
            for (const line of rendered) out.push(`  ${line}`);
            out.push("");
            out.push(
              theme.fg("muted", `  [${idx + 1}/${ANIMATIONS.length}] `) +
                theme.fg("text", anim.name) +
                theme.fg("muted", ` (${anim.lines}L) — ${anim.description}`),
            );
            out.push("");
            out.push(
              theme.fg(
                "dim",
                "  ←/→ switch  •  Enter/Space select  •  Esc/q quit",
              ),
            );
            out.push("");
            return out;
          },
        };
      })
      .then((selectedName) => {
        if (selectedName) {
          state.enabled = true;
          state.randomMode = false;
          state.anim = selectedName as string;
          persistConfig();
          ctx.ui.notify(`Animation set to: ${selectedName}`, "info");
        }
      });
  }

  // ─── /animation command ────────────────────────────────────
  pi.registerCommand("animation", {
    description: "Animated working indicator: showcase, set <name>, on/off",
    getArgumentCompletions: (prefix) => {
      const items = [
        {
          value: "showcase",
          label: "showcase",
          description: "Browse all animations interactively",
        },
        { value: "on", label: "on", description: "Enable animations" },
        { value: "off", label: "off", description: "Disable animations" },
        {
          value: "random",
          label: "random",
          description: "Random animation each time",
        },
        ...ANIMATIONS.map((a) => ({
          value: a.name,
          label: a.name,
          description: `[${a.lines}L] ${a.description}`,
        })),
      ];
      if (!prefix) return items;
      return items.filter((i) => i.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      // No args: show status
      if (!arg) {
        const status = state.enabled
          ? `Animation: ${state.anim}${state.randomMode ? "  (random)" : ""}`
          : "Animations disabled";
        const list = ANIMATIONS.map(
          (a) => `  ${a.name.padEnd(16)} [${a.lines}L] ${a.description}`,
        ).join("\n");
        ctx.ui.notify(
          `${status}\n\nAnimations:\n${list}\n\nUsage:\n  /animation showcase    Browse & pick\n  /animation <name>      Set animation\n  /animation on|off|random`,
          "info",
        );
        return;
      }

      // showcase
      if (arg === "showcase") {
        await runShowcase(ctx);
        return;
      }

      // on/off/random
      if (arg === "off") {
        state.enabled = false;
        stopAnimation();
        ctx.ui.setWorkingMessage();
        persistConfig();
        ctx.ui.notify("Animations disabled", "info");
        return;
      }
      if (arg === "on") {
        state.enabled = true;
        state.randomMode = false;
        persistConfig();
        ctx.ui.notify("Animations enabled", "info");
        return;
      }
      if (arg === "random") {
        state.enabled = true;
        state.randomMode = true;
        persistConfig();
        ctx.ui.notify("Random mode enabled", "info");
        return;
      }

      // Set animation
      const anim = getAnimation(arg);
      if (!anim) {
        ctx.ui.notify(`Unknown: "${arg}". Try /animation showcase`, "error");
        return;
      }

      state.enabled = true;
      state.randomMode = false;
      state.anim = arg;
      persistConfig();
      ctx.ui.notify(`Animation set to: ${arg}`, "info");
    },
  });
}
