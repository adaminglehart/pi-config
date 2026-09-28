import { describe, expect, test } from "bun:test";
import { parsePinnedNpmPackages } from "./stage-package-deps.ts";

describe("parsePinnedNpmPackages", () => {
  test("extracts exact unscoped and scoped npm package pins", () => {
    expect(
      parsePinnedNpmPackages({
        packages: [
          "npm:pi-subagents@0.65.1",
          "npm:@example/pi-extension@1.2.3",
          "git:github.com/example/pi-extension",
        ],
      }),
    ).toEqual([
      { name: "pi-subagents", version: "0.65.1", spec: "pi-subagents@0.65.1" },
      {
        name: "@example/pi-extension",
        version: "1.2.3",
        spec: "@example/pi-extension@1.2.3",
      },
    ]);
  });

  test("rejects npm packages without exact versions", () => {
    expect(() =>
      parsePinnedNpmPackages({ packages: ["npm:pi-subagents@^0.65.1"] })
    ).toThrow("npm package must have an exact version");
  });
});
