import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REMINDER = "Only communicate with me in ASD-STE100 Simplified Technical English, both in our conversations and in any written content you produce.";

export default function promptReminders(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${REMINDER}`,
  }));
}
