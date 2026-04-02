import { aquariumScene } from "./scenes/aquarium.js";
import { lifeScene } from "./scenes/life.js";
import { nebulaScene } from "./scenes/nebula.js";
import type { Scene } from "./scenes/types.js";

/**
 * GLOBAL CONFIGURATION
 */
export const CONFIG = {
  RENDER_INTERVAL_MS: 80, // How often we trigger a re-render (fixed)
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

export function setAgentState(state: AgentState): void {
  agentState = state;
}

export function getAgentState(): AgentState {
  return agentState;
}

/**
 * SCENE MANAGEMENT
 */
const scenes: Scene[] = [nebulaScene, lifeScene, aquariumScene];
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

export function startAnimation(tuiRef: { requestRender: () => void } | null): void {
  tuiReference = tuiRef;
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
  tuiReference = null;
}
