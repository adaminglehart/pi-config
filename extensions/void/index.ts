/**
 * VOID — Personal Presence Footer
 * A theatrical, minimal presence display inspired by NAVI
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ═════════════════════════════════════════════════════════════════════════════
// TrueColor Palette — Midnight Theater
// ═════════════════════════════════════════════════════════════════════════════
const Colors = {
  yami: [12, 6, 14] as const,
  nikki: [237, 224, 204] as const,
  tsuki: [200, 184, 144] as const,
  sumi: [154, 138, 120] as const,
  kurenai: [224, 72, 72] as const,
  bara: [208, 104, 120] as const,
  kin: [216, 184, 104] as const,
  fuji: [168, 88, 168] as const,
  koke: [130, 160, 110] as const,
  aoi: [96, 128, 160] as const,
  hai: [120, 104, 90] as const,
  rosoku: [230, 185, 100] as const,
  kage: [74, 50, 56] as const,
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// Symbol System
// ═════════════════════════════════════════════════════════════════════════════
const Symbols = {
  frame: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  pointer: "›",
  selected: "●",
  unselected: "○",
  stages: ["☽", "◐", "◑", "●"] as const,
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// Entity Visual States
// ═════════════════════════════════════════════════════════════════════════════
const EntityFrames: Record<string, string[][]> = {
  idle: [
    ["  ☽  ", " ·☽· ", "  ○  "],
    [" ·☽· ", "☽ ○ ☽", " ·○· "],
  ],
  thinking: [
    ["  ◐  ", " ·◐· ", "  ◑  "],
    [" ◐·◑ ", "· ◉ ·", " ◑·◐ "],
  ],
  happy: [
    ["  ★  ", " ·★· ", "  ☽  "],
    [" ☽★☽ ", "· ● ·", " ·★· "],
  ],
  sleep: [
    ["  ·  ", " ·○· ", "  ·  "],
    [" · · ", "· ○ ·", " · · "],
  ],
  excited: [
    ["  ✦  ", " ★✦★ ", "  ✦  "],
    [" ✦★✦ ", "★ ● ★", " ✦★✦ "],
  ],
  coding: [
    ["  ※  ", " ·※· ", "  ·  "],
    [" ·※· ", "※ ◉ ※", " ·※· "],
  ],
} as const;

const StatusLines: Record<string, string[]> = {
  idle: ["· · ·", "—— ——", "☽ · · ·", "○ · ○ · ○"],
  thinking: ["· › · › ·", "☽ → ●", "◐ · ◑ · ◐", "※ · ※ · ※"],
  happy: ["—— ✦ ——", "★ · ★ · ★", "● ● ●", "☽ → ★"],
  sleep: ["· · ·", "○ · ○", "— — —", "· ○ ·"],
  excited: ["✦ ★ ✦ ★ ✦", "★ · ★ · ★", "● ✦ ● ✦ ●", "✦ ✦ ✦ ✦ ✦"],
  coding: ["※ · ※ · ※", "· ◉ · ◉ ·", "※ › ※ › ※", "◉ · ◉ · ◉"],
} as const;

// ═════════════════════════════════════════════════════════════════════════════
// Level Progression
// ═════════════════════════════════════════════════════════════════════════════
const LevelThresholds: number[] = (() => {
  const t: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < 30; i++) {
    cumulative += 50_000 * Math.pow(2, i);
    t.push(cumulative);
  }
  return t;
})();

const LevelTitles = ["○", "◐", "◑", "●", "☽", "★", "✦", "◈", "◉", "※"] as const;
const NodeNames = [
  "†-I",
  "†-II",
  "☽-A",
  "☽-B",
  "★-01",
  "★-02",
  "◈-i",
  "◉-i",
] as const;

// ═════════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════════
type EntityMood =
  | "idle"
  | "thinking"
  | "happy"
  | "sleep"
  | "excited"
  | "coding";

interface EntityState {
  xp: number;
  totalTurns: number;
  born: string;
  totalTokens: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  hue: number;
  size: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// ANSI Helpers (matching custom-footer pattern)
// ═════════════════════════════════════════════════════════════════════════════
const _rst = "\x1b[0m";
const _fg24 = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const _px24 = (k: keyof typeof Colors) =>
  _fg24(Colors[k][0], Colors[k][1], Colors[k][2]);

/** Calculate visible width accounting for ANSI codes and wide chars */
function visWidth(s: string): number {
  const plain = s
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\]8;;[^\x07]*\x07/g, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) || 0;
    if (cp >= 0x1100 && cp <= 0x115f) w += 2;
    else if (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) w += 2;
    else if (cp >= 0xac00 && cp <= 0xd7a3) w += 2;
    else if (cp >= 0xf900 && cp <= 0xfaff) w += 2;
    else if (cp >= 0xff01 && cp <= 0xff60) w += 2;
    else w += 1;
  }
  return w;
}

/** Pad content to exact visual width */
function padContent(content: string, width: number): string {
  const visible = visWidth(content);
  const pad = Math.max(0, width - visible);
  return content + " ".repeat(pad);
}

/** Truncate content to exact width */
function truncateContent(s: string, width: number): string {
  let result = "";
  let w = 0;
  let inAnsi = false;
  let inLink = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inLink) {
      result += ch;
      if (ch === "\x07") inLink = false;
      continue;
    }
    if (ch === "\x1b") {
      if (s.slice(i, i + 3) === "\x1b]8;") {
        inLink = true;
        result += ch;
        continue;
      }
      inAnsi = true;
      result += ch;
      continue;
    }
    if (inAnsi) {
      result += ch;
      if (ch === "m") inAnsi = false;
      continue;
    }
    const cp = ch.codePointAt(0) || 0;
    const charW =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
        ? 2
        : 1;
    if (w + charW > width) break;
    w += charW;
    result += ch;
  }
  // Pad if shorter
  if (w < width) result += " ".repeat(width - w);
  return result;
}

function softMarquee(
  text: string,
  width: number,
  tick: number,
  hold = 5,
  gap = 8,
): string {
  if (width <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  const padded = [...chars, ...Array.from(" ".repeat(gap))];
  const maxOffset = Math.max(0, padded.length - width);
  const cycle = hold + maxOffset + hold;
  const phase = tick % Math.max(1, cycle);
  const offset =
    phase < hold ? 0 : phase < hold + maxOffset ? phase - hold : maxOffset;
  return padded.slice(offset, offset + width).join("");
}

// ═════════════════════════════════════════════════════════════════════════════
// Entity Class
// ═════════════════════════════════════════════════════════════════════════════
class Entity {
  state: EntityState;
  name: string;
  mood: EntityMood = "idle";
  coreMood: EntityMood = "idle";
  frame: number = 0;

  constructor() {
    this.state = {
      xp: 0,
      totalTurns: 0,
      born: new Date().toISOString(),
      totalTokens: 0,
    };
    this.name = NodeNames[Math.floor(Math.random() * NodeNames.length)];
  }

  getStage(): number {
    const l = this.getLevel();
    if (l <= 2) return 0;
    if (l <= 5) return 1;
    if (l <= 8) return 2;
    return 3;
  }

  getLevel(): number {
    for (let i = 0; i < LevelThresholds.length; i++) {
      if (this.state.totalTokens < LevelThresholds[i]) return i + 1;
    }
    return LevelThresholds.length + 1;
  }

  getTitle(): string {
    return LevelTitles[Math.min(this.getLevel() - 1, LevelTitles.length - 1)];
  }

  getProgress(): { current: number; needed: number } {
    const level = this.getLevel();
    const prev = level >= 2 ? LevelThresholds[level - 2] : 0;
    const next = LevelThresholds[level - 1] || prev + 50_000;
    return { current: this.state.totalTokens - prev, needed: next - prev };
  }

  getFrame(): string {
    const stage = this.getStage();
    const frames = EntityFrames[this.mood] || EntityFrames.idle;
    const stageFrames = frames[stage] || frames[0];
    return stageFrames[this.frame % stageFrames.length];
  }

  getStatusLine(): string {
    const lines = StatusLines[this.mood] || StatusLines.idle;
    return lines[this.frame % lines.length];
  }

  setMood(m: EntityMood) {
    this.coreMood = m;
    this.mood = m;
    this.frame = 0;
  }

  nextFrame() {
    this.frame = (this.frame + 1) % 1000;
  }

  addXP(tokens: number): { leveledUp: boolean; newLevel: number } {
    const prevLevel = this.getLevel();
    this.state.totalTokens += tokens;
    const newLevel = this.getLevel();
    return { leveledUp: newLevel > prevLevel, newLevel };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Token-Reactive Particle Field
// ═════════════════════════════════════════════════════════════════════════════
class ParticleField {
  particles: Particle[] = [];
  hueBase: number = 0;
  activityLevel: number = 0.3;

  private readonly MAX_PARTICLES = 150;
  private readonly DREAM_CHARS = ["·", "∘", "°", "✦", "✧", "※", "○", "◦", "◌"];

  private readonly DreamPalette: [number, number, number][] = [
    [224 / 255, 72 / 255, 72 / 255],
    [216 / 255, 184 / 255, 104 / 255],
    [168 / 255, 88 / 255, 168 / 255],
    [208 / 255, 104 / 255, 120 / 255],
    [216 / 255, 200 / 255, 136 / 255],
  ];

  private lerpColor(hue: number): [number, number, number] {
    const h = ((hue % 360) + 360) % 360;
    const segment = h / 72;
    const idx = Math.floor(segment) % 5;
    const next = (idx + 1) % 5;
    const t = segment - Math.floor(segment);
    const [r1, g1, b1] = this.DreamPalette[idx];
    const [r2, g2, b2] = this.DreamPalette[next];
    return [r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t];
  }

  spawn(tokensThisTurn: number, isWorking: boolean) {
    this.activityLevel *= 0.95;
    this.activityLevel = Math.max(0.1, this.activityLevel);

    if (tokensThisTurn > 0) {
      const burst = Math.min(1, tokensThisTurn / 5000);
      this.activityLevel = Math.min(1, this.activityLevel + burst * 0.5);
    }
    if (isWorking) {
      this.activityLevel = Math.min(1, this.activityLevel + 0.1);
    }

    const energy = this.activityLevel;
    const spawnCount = Math.floor(1 + energy * 4 + Math.random() * 2);
    this.hueBase = (this.hueBase + 0.5 + energy * 2) % 360;

    for (
      let i = 0;
      i < spawnCount && this.particles.length < this.MAX_PARTICLES;
      i++
    ) {
      const spread = 0.3 + energy * 0.5;
      const spawnX = 0.5 + (Math.random() - 0.5) * spread * 2;
      const spawnY = 0.4 + Math.random() * 0.6;
      const baseAngle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.5;
      const speed = 0.003 + energy * 0.02 + Math.random() * 0.01;
      const life = isWorking
        ? 0.3 + Math.random() * 0.5
        : 0.8 + Math.random() * 1.2;
      const size = 0.1 + energy * 0.4 + Math.random() * 0.2;
      const posHue = spawnX * 72;
      const hue = (this.hueBase + posHue + Math.random() * 40) % 360;

      this.particles.push({
        x: Math.max(0, Math.min(1, spawnX)),
        y: Math.max(0, Math.min(1, spawnY)),
        vx: Math.cos(baseAngle) * speed,
        vy: Math.sin(baseAngle) * speed * 0.6,
        life,
        maxLife: life,
        hue,
        size: Math.min(1.2, size),
      });
    }
  }

  spawnAmbient() {
    if (this.particles.length >= 20) return;
    if (Math.random() > 0.08) return;
    this.particles.push({
      x: 0.1 + Math.random() * 0.8,
      y: 0.7 + Math.random() * 0.3,
      vx: (Math.random() - 0.5) * 0.001,
      vy: -0.001 - Math.random() * 0.002,
      life: 2.0 + Math.random() * 2.0,
      maxLife: 3.5,
      hue: Math.random() * 360,
      size: 0.05 + Math.random() * 0.08,
    });
  }

  update(dt: number) {
    const energy = this.activityLevel;
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt * (0.5 / p.maxLife);
      p.vy += -0.0002 * dt;
      p.vx += (Math.random() - 0.5) * 0.001 * dt;
      const friction = 0.997 - energy * 0.002;
      p.vx *= friction;
      p.vy *= friction;
      if (energy > 0.5) {
        p.vx += (Math.random() - 0.5) * energy * 0.003 * dt;
        p.vy += (Math.random() - 0.5) * energy * 0.002 * dt;
      }
    }
    this.particles = this.particles.filter(
      (p) =>
        p.life > 0 && p.x >= -0.1 && p.x <= 1.1 && p.y >= -0.1 && p.y <= 1.1,
    );
  }

  render(cols: number, rows: number): string[] {
    const size = rows * cols;
    const gridR = new Float32Array(size);
    const gridG = new Float32Array(size);
    const gridB = new Float32Array(size);

    const glow: [number, number, number][] = [
      [0, -1, 0.35],
      [0, 1, 0.35],
      [-1, 0, 0.2],
      [1, 0, 0.2],
      [-1, -1, 0.12],
      [-1, 1, 0.12],
      [1, -1, 0.12],
      [1, 1, 0.12],
    ];

    for (const p of this.particles) {
      const col = Math.floor(p.x * cols);
      const row = Math.floor(p.y * rows);
      if (row < 0 || row >= rows || col < 0 || col >= cols) continue;

      const fade = Math.max(0, p.life / p.maxLife);
      const intensity = p.size * fade;
      const [cr, cg, cb] = this.lerpColor(p.hue);

      const ci = row * cols + col;
      gridR[ci] += cr * intensity;
      gridG[ci] += cg * intensity;
      gridB[ci] += cb * intensity;

      for (const [dr, dc, mult] of glow) {
        const nr = row + dr,
          nc = col + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
          const gi = nr * cols + nc;
          const g = intensity * mult;
          gridR[gi] += cr * g;
          gridG[gi] += cg * g;
          gridB[gi] += cb * g;
        }
      }
    }

    const lines: string[] = [];
    for (let r = 0; r < rows; r++) {
      let line = "";
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const brightness = Math.max(gridR[i], gridG[i], gridB[i]);

        if (brightness < 0.05) {
          line += " ";
          continue;
        }

        const boosted = Math.min(1.3, brightness + this.activityLevel * 0.15);
        const charIdx = Math.min(
          this.DREAM_CHARS.length - 1,
          Math.round(boosted * (this.DREAM_CHARS.length - 1)),
        );
        const ch = this.DREAM_CHARS[charIdx];

        const warmth =
          0.4 + Math.min(1.3, boosted) * 0.6 + this.activityLevel * 0.1;
        const rr = Math.min(255, Math.round(gridR[i] * warmth * 260));
        const gg = Math.min(255, Math.round(gridG[i] * warmth * 260));
        const bb = Math.min(255, Math.round(gridB[i] * warmth * 260));

        line += `\x1b[38;2;${rr};${gg};${bb}m${ch}\x1b[0m`;
      }
      lines.push(line);
    }
    return lines;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Main Renderer
// ═════════════════════════════════════════════════════════════════════════════
function renderVoid(
  entity: Entity,
  particles: ParticleField,
  width: number,
  marqueeTick: number,
  workingFrame: number,
  isWorking: boolean,
  sessionTokens: { input: number; output: number; total: number },
): string[] {
  const S = Symbols;
  const lines: string[] = [];

  // Colors (following custom-footer pattern)
  const borderColor = _px24("kage");
  const kurenai = _px24("kurenai");
  const tsuki = _px24("tsuki");
  const kin = _px24("kin");
  const hai = _px24("hai");
  const sumi = _px24("sumi");
  const rosoku = _px24("rosoku");

  // Inner width (subtract 2 for borders)
  const innerW = width - 2;

  // ── Top border ──
  lines.push(
    borderColor + S.frame.tl + S.frame.h.repeat(innerW) + S.frame.tr + _rst,
  );

  // ── Row 1: Entity info ──
  const nameTag = ` ${entity.name} `;
  const levelTag = ` ${entity.getTitle()} `;
  const stageTag = ` ${S.stages[entity.getStage()] || S.stages[0]} `;

  const prog = entity.getProgress();
  const barW = 8;
  const xpFilled = Math.round((prog.current / prog.needed) * barW);
  const xpColorStart =
    xpFilled >= barW * 0.8
      ? kurenai
      : xpFilled >= barW * 0.5
        ? kin
        : _px24("bara");
  const xpBar =
    xpColorStart +
    S.selected.repeat(xpFilled) +
    _rst +
    hai +
    S.unselected.repeat(barW - xpFilled) +
    _rst;

  const fmtK = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1000
        ? `${(n / 1000).toFixed(0)}k`
        : `${n}`;
  const tokenStr =
    sessionTokens.total > 0 ? sumi + fmtK(sessionTokens.total) + _rst : "";

  const row1Content =
    kurenai +
    nameTag +
    _rst +
    tsuki +
    levelTag +
    _rst +
    kin +
    stageTag +
    _rst +
    " " +
    xpBar +
    " " +
    tokenStr;
  const row1Padded = padContent(row1Content, innerW);
  lines.push(
    borderColor +
      S.frame.v +
      _rst +
      row1Padded +
      borderColor +
      S.frame.v +
      _rst,
  );

  // ── Row 2: Face + spinner + status ──
  const spinnerPhases = ["◐", "◑", "●", "◑", "◐", "○"];
  const spinner = isWorking
    ? rosoku + spinnerPhases[workingFrame % spinnerPhases.length] + _rst
    : "";
  const face = entity.getFrame();
  const statusLine = entity.getStatusLine();
  const statusWidth = innerW - 15;

  const row2Content =
    kurenai +
    face +
    _rst +
    " " +
    spinner +
    (spinner ? " " : "") +
    tsuki +
    softMarquee(statusLine, Math.max(5, statusWidth), marqueeTick, 8, 10) +
    _rst;
  const row2Padded = padContent(row2Content, innerW);
  lines.push(
    borderColor +
      S.frame.v +
      _rst +
      row2Padded +
      borderColor +
      S.frame.v +
      _rst,
  );

  // ── Row 3: Particle field ──
  const particleRows = particles.render(innerW, 1);
  const pLine = particleRows[0] || "";
  const pLineTruncated = truncateContent(pLine, innerW);
  const pLinePadded = padContent(pLineTruncated, innerW);
  lines.push(
    borderColor +
      S.frame.v +
      _rst +
      pLinePadded +
      borderColor +
      S.frame.v +
      _rst,
  );

  // ── Bottom border ──
  lines.push(
    borderColor + S.frame.bl + S.frame.h.repeat(innerW) + S.frame.br + _rst,
  );

  return lines;
}

// ═════════════════════════════════════════════════════════════════════════════
// Main Extension
// ═════════════════════════════════════════════════════════════════════════════
export default function voidExtension(pi: ExtensionAPI) {
  const entity = new Entity();
  const particles = new ParticleField();

  let ctx: ExtensionContext | null = null;
  let workingFrame = 0;
  let isWorking = false;
  let marqueeTick = 0;
  let lastTokens = { input: 0, output: 0, total: 0 };
  let lastRenderedLines = "";

  let animTimer: ReturnType<typeof setInterval> | null = null;
  let marqueeTimer: ReturnType<typeof setInterval> | null = null;
  let particleTimer: ReturnType<typeof setInterval> | null = null;
  let workingTimer: ReturnType<typeof setInterval> | null = null;

  function startWorking() {
    isWorking = true;
    workingFrame = 0;
    if (workingTimer) clearInterval(workingTimer);
    workingTimer = setInterval(() => {
      workingFrame++;
      if (workingFrame % 3 === 0) entity.nextFrame();
      render();
    }, 120);
  }

  function stopWorking() {
    isWorking = false;
    if (workingTimer) {
      clearInterval(workingTimer);
      workingTimer = null;
    }
  }

  function startMarquee() {
    if (marqueeTimer) return;
    marqueeTimer = setInterval(() => {
      marqueeTick++;
      render();
    }, 450);
  }

  function stopMarquee() {
    if (marqueeTimer) {
      clearInterval(marqueeTimer);
      marqueeTimer = null;
    }
  }

  function startAnim() {
    if (animTimer) return;
    animTimer = setInterval(() => {
      entity.nextFrame();
      render();
    }, 800);
  }

  function stopAnim() {
    if (animTimer) {
      clearInterval(animTimer);
      animTimer = null;
    }
  }

  function startParticles() {
    if (particleTimer) return;
    particleTimer = setInterval(() => {
      const tokenData = (globalThis as any).__piTokenUsageData;
      const tokensThisTurn = tokenData
        ? (tokenData.input || 0) + (tokenData.output || 0) - lastTokens.total
        : 0;

      if (tokenData) {
        lastTokens = {
          input: tokenData.input || 0,
          output: tokenData.output || 0,
          total: (tokenData.input || 0) + (tokenData.output || 0),
        };
      }

      particles.spawn(Math.max(0, tokensThisTurn), isWorking);
      particles.spawnAmbient();
      particles.update(1);
      render();
    }, 100);
  }

  function stopParticles() {
    if (particleTimer) {
      clearInterval(particleTimer);
      particleTimer = null;
    }
  }

  function render() {
    if (!ctx?.hasUI) return;

    const width = process.stdout.columns || 100;
    const lines = renderVoid(
      entity,
      particles,
      width,
      marqueeTick,
      workingFrame,
      isWorking,
      lastTokens,
    );

    const linesKey = lines.join("\n");
    if (linesKey !== lastRenderedLines) {
      lastRenderedLines = linesKey;
      ctx.ui.setWidget("void", lines, { placement: "aboveEditor" });
    }
  }

  pi.on("session_start", async (_e, c) => {
    ctx = c;
    startAnim();
    startMarquee();
    startParticles();
  });

  pi.on("turn_start", () => {
    entity.setMood("thinking");
    startWorking();
  });

  pi.on("turn_end", () => {
    stopWorking();
    entity.state.totalTurns++;

    const tokenData = (globalThis as any).__piTokenUsageData;
    if (tokenData) {
      const total = (tokenData.input || 0) + (tokenData.output || 0);
      const result = entity.addXP(total);
      if (result.leveledUp) {
        entity.setMood("excited");
        ctx?.ui.notify(
          `Entity evolved to L${result.newLevel} — ${entity.getTitle()}`,
          "info",
        );
        setTimeout(() => {
          if (entity.mood === "excited") entity.setMood("idle");
        }, 8000);
      }
    }

    if (entity.mood !== "excited") {
      entity.setMood("happy");
      setTimeout(() => {
        if (entity.mood === "happy") entity.setMood("idle");
      }, 5000);
    }
  });

  pi.on("input", () => {
    if (entity.mood === "sleep") entity.setMood("idle");
  });

  pi.on("session_shutdown", async () => {
    stopAnim();
    stopMarquee();
    stopParticles();
    stopWorking();
  });
}
