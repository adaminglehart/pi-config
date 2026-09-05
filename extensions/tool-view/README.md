# Tool view

Display-only replacement for `minimal-tools`. The six public tool contracts are unchanged. Execution uses Pi's factories with the session cwd. Results and streaming updates are not modified.

## Displays

- Read: path, requested range, returned UTF-8 text size; content on expansion. Image notes and continuation notices stay visible. Pi still renders images.
- Find, grep, ls: scope, counts, small results, bounded large previews. Grep counts are observed records, not claimed totals. Context lines and tool notices are excluded.
- Bash: running marker and live tail; short success in full; start and end for long output; larger failure preview. Only Pi's `isError` decides success.
- Write: path and written line count; actual error on failure.
- Expansion: all retained text. No file access or command execution during rendering.

Collapsed output budgets are 6 screen rows for searches/live output, 8 for settled output, and 14 for failures. Headers use at most 3 rows. Omission rows count toward these budgets. Full tool notices and expansion hints are separate. Wrapping uses the current width.

Pi adds its normal separator before a self-rendered tool row. Fullscreen mouse expansion remains host-owned where supported. The renderer does not capture terminal input.

## Known limits

Head/tail selection can omit a diagnostic in the middle of a log. Expand the result to inspect retained output. Tool-level truncation may require the supplied continuation command or full-output path. The renderer never tries to recover that output itself.

Search output is unstructured. Grep labels counts as observed and reports unavailable counts for unknown formats. Unusual file names containing line delimiters can remain ambiguous.

## Checks

From the repository root:

```sh
pnpm --dir extensions exec tsx --test tool-view/*.test.ts
pnpm --dir extensions exec tsc -p tool-view/tsconfig.json
bun extensions/tool-view/prototype.ts > plans/tool-output-prototype.md
```

Tests cover contracts, actual factory execution, streaming, cancellation, images, output selection, controls, Unicode, restoration, key hints, and Pi row composition. Use Node with tsx for the complete suite; Bun's node:test compatibility has an async-suite issue.

After deployment, run `/reload` and inspect real output, mouse expansion, image display, and theme changes before treating the terminal UI as verified.
