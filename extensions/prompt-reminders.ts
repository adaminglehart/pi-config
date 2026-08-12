import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REMINDER = "Only speak to me in ASD-STE100 Simplified Technical English.";

export default function promptReminders(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${REMINDER}`,
  }));
}
