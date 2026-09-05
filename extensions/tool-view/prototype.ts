
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { fixtures } from "./fixtures.js";
import { renderRow } from "./row.js";

const theme = { fg: (_color: string, text: string) => text };
console.log("# Tool-view prototype\n\nSynthetic results. No tools are executed. Omitted counts refer to screen rows.\n");
for (const width of [40, 100]) {
  console.log(`## ${width} columns\n`);
  for (const [label, input] of fixtures) {
    console.log(`### ${label}\n\n\`\`\`text`);
    console.log(renderRow(input, width, theme).map(stripTerminalSequences).join("\n"));
    console.log("```\n");
  }
}
