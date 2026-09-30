import type { TextContent } from "@earendil-works/pi-ai";

type MessageContent = string | readonly { type: string }[];

function isTextPart(part: { type: string }): part is TextContent {
  return part.type === "text";
}

/** Join the text parts of message content. Other part types are skipped. */
export function messageText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n");
}
