import { aquariumScene } from "./scenes/aquarium.js";
import { nebulaScene } from "./scenes/nebula.js";
import type { Scene } from "./scenes/types.js";

/**
 * GLOBAL CONFIGURATION
 */
export const CONFIG = {
  /** How often we advance the animation frame and trigger a re-render.
   *  The two-layer cache (scene cache + full footer cache) ensures that
   *  renders triggered by *other* sources (Loader, animations extension,
   *  input events) return identical strings and are skipped by the TUI
   *  diff — so this interval doesn't compete with them. */
  RENDER_INTERVAL_MS: 150,
};

/**
 * Agent State
 */
type AgentState = "paused" | "active" | "thinking";
let agentState: AgentState = "paused";

export function setAgentState(state: AgentState): void {
  agentState = state;
}

export function getAgentState(): AgentState {
  return agentState;
}

/**
 * SCENE MANAGEMENT
 */
const scenes: Scene[] = [nebulaScene, aquariumScene];
let currentSceneIdx = 0;

export function getActiveScene(): Scene {
  return scenes[currentSceneIdx]!;
}

export function cycleScene(): string {
  currentSceneIdx = (currentSceneIdx + 1) % scenes.length;
  return scenes[currentSceneIdx]!.name;
}

let animationInterval: ReturnType<typeof setInterval> | null = null;

let tuiReference: { requestRender: () => void } | null = null;

/**
 * Scene render cache.
 *
 * The TUI calls the footer's render() on *every* requestRender() — not just
 * our animation ticks but also input events, agent streaming, etc.
 * If the scene recomputes from Date.now() each time, every render produces
 * different ANSI strings, the TUI diff sees "changed" lines, and clears +
 * rewrites them (\x1b[2K]) causing visible flicker.
 *
 * We cache the scene output and only refresh it on our own animation tick.
 * Renders triggered by other events reuse the cache → identical strings →
 * TUI diff skips those lines → no flicker.
 */
let sceneCacheLines: string[] = [];
let sceneCacheWidth = 0;
let sceneCacheTick = 0;
let currentTick = 0;

export function getCurrentTick(): number {
  return currentTick;
}

export function getSceneCache(width: number, contextPercent: number): string[] {
  const scene = getActiveScene();
  if (currentTick !== sceneCacheTick || width !== sceneCacheWidth) {
    sceneCacheLines = scene.render(width, contextPercent);
    sceneCacheTick = currentTick;
    sceneCacheWidth = width;
  }
  return sceneCacheLines;
}

export function startAnimation(
  tuiRef: { requestRender: () => void } | null,
): void {
  tuiReference = tuiRef;
  if (animationInterval) clearInterval(animationInterval);
  animationInterval = setInterval(() => {
    currentTick++;
    tuiReference?.requestRender();
  }, CONFIG.RENDER_INTERVAL_MS);
}

export function stopAnimation(): void {
  if (animationInterval) {
    clearInterval(animationInterval);
    animationInterval = null;
  }
  tuiReference = null;
}
