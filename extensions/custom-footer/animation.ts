import { ansi, colors } from "./index.js";
import { aquariumScene } from "./scenes/aquarium.js";
import { lifeScene } from "./scenes/life.js";
import type { Scene } from "./scenes/types.js";

/**
 * GLOBAL CONFIGURATION
 */
export const CONFIG = {
  RENDER_INTERVAL_MS: 80, // How often we trigger a re-render (fixed)
  BOX_WIDTH: 5,
  BOX_CONTENT_WIDTH: 3,
  FRAME_DURATIONS: {
    PAUSED: 500, // ms per frame when idle
    ACTIVE: 60, // ms per frame when working
    THINKING: 150, // ms per frame when thinking
  },
};

/**
 * Agent State & Time-based Animation
 *
 * Animation frame is computed from wall-clock time rather than an
 * incrementing counter. This ensures consistent visual speed regardless
 * of event-loop pressure or render frequency.
 */
type AgentState = "paused" | "active" | "thinking";
let agentState: AgentState = "paused";

// Time-based frame tracking: we accumulate a fractional frame position
// so speed transitions are seamless.
let framePosition = 0; // accumulated fractional frame index
let lastFrameTime = Date.now();

function getFrameDuration(): number {
  switch (agentState) {
    case "paused":
      return CONFIG.FRAME_DURATIONS.PAUSED;
    case "active":
      return CONFIG.FRAME_DURATIONS.ACTIVE;
    case "thinking":
      return CONFIG.FRAME_DURATIONS.THINKING;
  }
}

export function setAgentState(state: AgentState): void {
  // Flush elapsed time at the old speed before switching
  advanceFramePosition();
  agentState = state;
}

export function getAgentState(): AgentState {
  return agentState;
}

/** Advance framePosition based on elapsed wall-clock time and current speed */
function advanceFramePosition(): void {
  const now = Date.now();
  const elapsed = now - lastFrameTime;
  lastFrameTime = now;
  if (elapsed > 0) {
    framePosition += elapsed / getFrameDuration();
  }
}

/**
 * Loading Box Animation Frames
 */
export const animations: Record<string, string[][]> = {
  // matrix: [
  //   ["⢀  ", "  ⠘"],
  //   ["⢠  ", "  ⢰"],
  //   ["⢰  ", "  ⠠"],
  //   ["⠘  ", "  ⢀"],
  // ],
  // pulse: [
  //   [" . ", " . "],
  //   [" o ", " o "],
  //   [" O ", " O "],
  //   [" # ", " # "],
  // ],
  // fish: [
  //   ["<>< ", "    "],
  //   [" <><", "    "],
  //   ["    ", " <><"],
  //   ["    ", "<>< "],
  // ],
  organic: [
    // Flowing organic pattern that looks alive
    ["∴∵ ", " ∴∵"],
    [" ∴∵", "∵∴ "],
    ["∵∴ ", " ∵∴"],
    [" ∵∴", "∴∵ "],
    ["∴∵ ", "∵ ∴"],
    ["∵ ∴", " ∴∵"],
    [" ∴∵", "∴ ∵"],
    ["∴ ∵", "∵∴ "],
  ],
  flow: [
    // Water-like flowing pattern
    ["≈≈ ", " ∼∼"],
    [" ≈≈", "∼∼ "],
    ["∼∼ ", " ≈≈"],
    [" ∼∼", "≈≈ "],
    ["≈∼ ", " ≈∼"],
    [" ≈∼", "∼≈ "],
    ["∼≈ ", " ∼≈"],
    [" ∼≈", "≈∼ "],
  ],
  bloom: [
    // Organic growth pattern
    ["·  ", " · "],
    ["·· ", " ··"],
    ["∴  ", " ∴ "],
    ["∴· ", " ∴·"],
    ["∵  ", " ∵ "],
    ["∵∴ ", " ∵∴"],
    ["✧∵ ", " ✧∵"],
    ["✧✧ ", " ✧✧"],
    ["✧∵ ", " ✧∵"],
    ["∵∴ ", " ∵∴"],
    ["∵  ", " ∵ "],
    ["∴· ", " ∴·"],
    ["∴  ", " ∴ "],
    ["·· ", " ··"],
    ["·  ", " · "],
    ["   ", "   "],
  ],
};

const styleKeys = Object.keys(animations);
let currentStyleIdx = 2; // Default to "organic"
export let activeFrames = animations[styleKeys[currentStyleIdx]!]!;

export function cycleAnimation(): string {
  currentStyleIdx = (currentStyleIdx + 1) % styleKeys.length;
  const newStyle = styleKeys[currentStyleIdx]!;
  activeFrames = animations[newStyle]!;
  framePosition = 0;
  lastFrameTime = Date.now();
  return newStyle;
}

/**
 * SCENE MANAGEMENT
 */
const scenes: Scene[] = [lifeScene, aquariumScene];
let currentSceneIdx = 1;

export function getActiveScene(): Scene {
  return scenes[currentSceneIdx]!;
}

export function cycleScene(): string {
  currentSceneIdx = (currentSceneIdx + 1) % scenes.length;
  return scenes[currentSceneIdx]!.name;
}

let animationInterval: ReturnType<typeof setInterval> | null = null;

/** Get the current animation frame index, computed from wall-clock time */
function getCurrentFrame(): number {
  advanceFramePosition();
  return Math.floor(framePosition) % activeFrames.length;
}

/**
 * Renders the status block to fit exactly 'targetHeight' lines
 */
export function renderAnimationBlock(targetHeight: number): string[] {
  const frame = activeFrames[getCurrentFrame()]!;
  const accentColor = ansi.fg(colors.accent);
  const sepColor = ansi.fg(colors.sep);
  const reset = ansi.reset;

  const lines: string[] = [];

  // Top border
  lines.push(`${sepColor}┌───┐${reset}`);

  // Middle lines (content)
  const contentLines = targetHeight - 2;
  for (let i = 0; i < contentLines; i++) {
    const frameContent = frame[i % frame.length] || "   ";
    const padded = frameContent
      .padEnd(CONFIG.BOX_CONTENT_WIDTH)
      .slice(0, CONFIG.BOX_CONTENT_WIDTH);
    lines.push(
      `${sepColor}│${reset}${accentColor}${padded}${reset}${sepColor}│${reset}`,
    );
  }

  // Bottom border
  lines.push(`${sepColor}└───┘${reset}`);

  return lines;
}

let tuiReference: any = null;

export function startAnimation(tuiRef: any): void {
  tuiReference = tuiRef;
  lastFrameTime = Date.now();
  if (animationInterval) clearInterval(animationInterval);
  // Fixed-rate render trigger — frame selection is time-based,
  // so this interval only controls render frequency, not animation speed.
  animationInterval = setInterval(() => {
    tuiReference?.requestRender();
  }, CONFIG.RENDER_INTERVAL_MS);
}

export function stopAnimation(): void {
  if (animationInterval) {
    clearInterval(animationInterval);
    animationInterval = null;
  }
  framePosition = 0;
  lastFrameTime = Date.now();
  tuiReference = null;
}
