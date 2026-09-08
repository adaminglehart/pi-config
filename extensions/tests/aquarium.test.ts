/// <reference types="bun" />

import assert from "node:assert/strict";
import { afterEach, mock, spyOn, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { aquariumScene, renderAquarium } from "../custom-footer/scenes/aquarium.js";
import { aquariumCreatures, aquariumRandom, AQUARIUM_ROWS } from "../custom-footer/scenes/aquarium-life.js";

const stripColor = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

afterEach(() => mock.restore());

test("aquarium keeps its three-row size at every terminal width", () => {
  assert.equal(aquariumScene.height, 3);
  for (const width of [0, 1, 2, 20, 40, 80, 120, 240]) {
    for (const seed of [0, 42, 913]) {
      for (const time of [0, 0.08, 1, 30, 3600]) {
        const lines = renderAquarium(width, time, seed);
        assert.equal(lines.length, AQUARIUM_ROWS);
        for (const line of lines) {
          assert.equal(visibleWidth(line), width);
          assert.ok(line.endsWith("\x1b[0m"));
          assert.doesNotMatch(stripColor(line), /[\x00-\x1f]|undefined|NaN/);
          for (const color of line.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)) {
            for (const channel of color.slice(1)) assert.ok(Number(channel) <= 255);
          }
        }
      }
    }
  }
});

test("seeded populations vary, but stay populated and do not overlap", () => {
  for (const width of [40, 80, 120, 240]) {
    const counts = new Set<number>();
    for (let seed = 0; seed < 24; seed++) {
      for (let frame = 0; frame < 100; frame++) {
        const creatures = aquariumCreatures(width, frame * 1.37, seed);
        counts.add(creatures.length);
        assert.ok(creatures.length >= Math.floor(width / 12), `Too few creatures at ${width} columns`);
        assert.ok(creatures.length <= AQUARIUM_ROWS * Math.floor((width + 20) / 18));
        const occupied = new Set<string>();
        for (const creature of creatures) {
          assert.equal(visibleWidth(creature.sprite), creature.sprite.length);
          for (let x = Math.max(0, creature.x); x < Math.min(width, creature.x + creature.sprite.length); x++) {
            const cell = `${creature.row}:${x}`;
            assert.ok(!occupied.has(cell), `Overlapping sprites at ${cell}`);
            occupied.add(cell);
          }
        }
      }
    }
    assert.ok(counts.size >= 3, "Expected a variable creature count");
  }
});

test("frames are deterministic, colorful, and different across session seeds", () => {
  const frame = renderAquarium(120, 5, 42);
  assert.deepEqual(renderAquarium(120, 5, 42), frame);
  assert.notDeepEqual(renderAquarium(120, 5, 913), frame);
  assert.notDeepEqual(renderAquarium(120, 10, 42), frame);
  assert.ok(new Set(frame.join("").match(/\x1b\[38;2;[0-9;]+m/g)).size > 40);
  for (const seed of [0, 42, 0x7fffffff]) {
    for (const index of [-10000, 0, 10000]) {
      const sample = aquariumRandom(seed, index);
      assert.ok(sample >= 0 && sample < 1);
      assert.equal(aquariumRandom(seed, index), sample);
    }
  }
});

test("population changes happen at the edges, not in the middle of a school", () => {
  const width = 120;
  for (const seed of [0, 42, 913]) {
    for (let frame = 0; frame < 400; frame++) {
      const before = aquariumCreatures(width, frame * 0.08, seed);
      const after = aquariumCreatures(width, (frame + 1) * 0.08, seed);
      for (const creature of after) {
        const previous = before.find((fish) => fish.row === creature.row && fish.hue === creature.hue);
        if (previous) {
          assert.ok(Math.abs(creature.x - previous.x) <= 1);
        } else {
          assert.ok(creature.x <= 1 || creature.x + creature.sprite.length >= width - 1);
        }
      }
      for (const creature of before) {
        if (!after.some((fish) => fish.row === creature.row && fish.hue === creature.hue)) {
          assert.ok(creature.x <= 1 || creature.x + creature.sprite.length >= width - 1);
        }
      }
    }
  }
});

test("runtime population is independent of context usage", () => {
  const now = performance.now() + 10000;
  spyOn(performance, "now").mockReturnValue(now);
  const emptyContext = aquariumScene.render(120, 0);
  for (const percent of [10, 50, 99, 100, Number.NaN]) {
    assert.deepEqual(aquariumScene.render(120, percent), emptyContext);
  }
});

test("manual additions are bounded and cannot cause overlapping creatures", () => {
  const now = performance.now() + 10000;
  spyOn(performance, "now").mockReturnValue(now);
  for (let i = 0; i < 3; i++) aquariumScene.onCommand?.(undefined);
  const capped = aquariumScene.render(120, 0);
  for (let i = 0; i < 100; i++) aquariumScene.onCommand?.(undefined);
  assert.deepEqual(aquariumScene.render(120, 100), capped);
  for (let frame = 0; frame < 100; frame++) {
    const creatures = aquariumCreatures(120, frame * 0.91, 42, 3);
    const occupied = new Set<string>();
    for (const fish of creatures) {
      for (let x = Math.max(0, fish.x); x < Math.min(120, fish.x + fish.sprite.length); x++) {
        const cell = `${fish.row}:${x}`;
        assert.ok(!occupied.has(cell));
        occupied.add(cell);
      }
    }
  }
});
