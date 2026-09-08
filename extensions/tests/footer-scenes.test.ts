import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { auroraVortexScene, renderAuroraVortex } from "../custom-footer/scenes/aurora-vortex.js";
import { auroraBloomScene, renderAuroraBloom } from "../custom-footer/scenes/aurora-bloom.js";
import { tidePrismScene, renderTidePrism } from "../custom-footer/scenes/tide-prism.js";
import { orbitScene, renderOrbit } from "../custom-footer/scenes/orbit.js";
import { BrailleCanvas } from "../custom-footer/scenes/braille-canvas.js";
import { lightGlyph, spectralColor, type Palette } from "../custom-footer/scenes/spectral-color.js";
import {
  cycleScene, getActiveScene, getCurrentTick, getSceneCache,
  getSceneNames, selectScene,
} from "../custom-footer/animation.js";

const stripColor = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

const renderers = [
  renderAuroraVortex, renderAuroraBloom, renderTidePrism, renderOrbit,
];

for (const render of renderers) {
  test(`${render.name}: four-row dimensions, valid color, no control leakage`, () => {
    for (const width of [0, 1, 2, 20, 80, 120, 240]) {
      for (const time of [0, 0.08, 1, 10, 60, 3600]) {
        const lines = render(width, time);
        assert.equal(lines.length, 4);
        for (const line of lines) {
          assert.equal(visibleWidth(line), width);
          assert.ok(line.endsWith("\x1b[0m"));
          assert.doesNotMatch(stripColor(line), /[\x00-\x1f]|undefined|NaN/);
          for (const color of line.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)) {
            for (const channel of color.slice(1)) {
              assert.ok(Number(channel) >= 0 && Number(channel) <= 255);
            }
          }
        }
      }
    }
  });

  test(`${render.name}: deterministic frames and gradual motion`, () => {
    const initial = render(120, 0);
    assert.deepEqual(render(120, 0), initial);
    assert.notDeepEqual(render(120, 10), initial);
    for (let frame = 0; frame < 100; frame++) {
      const before = render(120, frame * 0.08).map(stripColor).join("");
      const after = render(120, (frame + 1) * 0.08).map(stripColor).join("");
      let changed = 0;
      for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed++;
      assert.ok(changed / before.length < 0.35, `Too many changed cells: ${changed}`);
    }
    const colors = new Set(initial.join("").match(/\x1b\[38;2;[0-9;]+m/g));
    assert.ok(colors.size > 30, "Expected a rich color range");
  });
}

test("all new runtime scenes keep the original four-row height", () => {
  for (const scene of [
    auroraVortexScene, auroraBloomScene, tidePrismScene, orbitScene,
  ]) {
    assert.equal(scene.height, 4);
    assert.equal(scene.render(80, 50).length, scene.height);
  }
});

test("palette wraps smoothly and light channels stay in range", () => {
  const palette: Palette = [[255, 0, 0], [0, 255, 255]];
  assert.deepEqual(spectralColor(palette, 0), spectralColor(palette, 1));
  assert.deepEqual(spectralColor(palette, -0.25), spectralColor(palette, 0.75));
  assert.equal(lightGlyph(" ", [255, 255, 255], 1), " ");
  assert.equal(lightGlyph("*", [255, 128, 0], 2), "\x1b[38;2;255;255;0m*");
});

test("scene selection updates both caches immediately; other renders reuse the frame", () => {
  assert.deepEqual(getSceneNames(), [
    "aurora-vortex", "aurora-bloom", "tide-prism", "orbit", "aquarium",
  ]);
  selectScene("aurora-vortex");
  assert.equal(getSceneCache(0, 0).length, 4);
  const first = getSceneCache(80, 0);
  assert.strictEqual(getSceneCache(80, 0), first);
  const tick = getCurrentTick();
  assert.equal(selectScene("aurora-bloom"), "aurora-bloom");
  assert.ok(getCurrentTick() > tick);
  assert.notDeepEqual(getSceneCache(80, 0), first);
  assert.equal(getActiveScene().name, "aurora-bloom");
  assert.equal(cycleScene(), "tide-prism");
  assert.equal(cycleScene(), "orbit");
  assert.equal(cycleScene(), "aquarium");
  assert.equal(cycleScene(), "aurora-vortex");
  const selectedTick = getCurrentTick();
  assert.equal(selectScene("missing"), undefined);
  assert.equal(getCurrentTick(), selectedTick);
  assert.equal(getActiveScene().name, "aurora-vortex");
  assert.ok(getSceneCache(37, 0).every((line) => visibleWidth(line) === 37));
});

test("every option can be selected by name without a timer tick", () => {
  for (const scene of [
    auroraVortexScene, auroraBloomScene, tidePrismScene, orbitScene,
  ]) {
    const before = getCurrentTick();
    assert.equal(selectScene(scene.name), scene.name);
    assert.strictEqual(getActiveScene(), scene);
    assert.ok(getCurrentTick() > before);
    const frame = getSceneCache(80, 0);
    assert.equal(frame.length, 4);
    assert.strictEqual(frame, getSceneCache(80, 0));
  }
  selectScene("aurora-vortex");
});

test("Braille dots map to the correct terminal cell and clip at the boundary", () => {
  const canvas = new BrailleCanvas(2);
  canvas.addDot(0, 0, 1, [255, 0, 0]);
  canvas.addDot(1, 3, 1, [255, 0, 0]);
  canvas.addDot(2, 4, 1, [0, 255, 0]);
  canvas.addDot(-1, 0, 1, [255, 255, 255]);
  canvas.addDot(4, 0, 1, [255, 255, 255]);
  canvas.addDot(0, 16, 1, [255, 255, 255]);
  assert.deepEqual(canvas.render().map(stripColor), [
    String.fromCharCode(0x2800 + 1 + 128) + " ",
    " " + String.fromCharCode(0x2801),
    "  ", "  ",
  ]);
});

test("fractional splats spread light between dots without changing cell width", () => {
  const canvas = new BrailleCanvas(1);
  canvas.splat(0.5, 0.5, 1, [100, 200, 255]);
  assert.equal(stripColor(canvas.render()[0]!), String.fromCharCode(0x2800 + 1 + 2 + 8 + 16));
  assert.ok(canvas.render().every((line) => visibleWidth(line) === 1));
  assert.deepEqual(new BrailleCanvas(0).render().map(stripColor), ["", "", "", ""]);
});

test("bloom lifetimes end without a visible reset", () => {
  for (let bloom = 0; bloom < 6; bloom++) {
    const boundary = (1 - (bloom * 0.273 % 1)) * (12 + bloom * 1.1);
    const before = renderAuroraBloom(120, boundary - 0.001).map(stripColor).join("");
    const after = renderAuroraBloom(120, boundary + 0.001).map(stripColor).join("");
    let changed = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed++;
    assert.ok(changed / before.length < 0.04);
  }
});

test("removed scenes cannot be selected", () => {
  selectScene("aurora-bloom");
  const tick = getCurrentTick();
  for (const name of ["orbit-cluster", "aurora-bloom-garden", "nebula", "aurora", "tide", "tide-reef"]) {
    assert.equal(selectScene(name), undefined);
    assert.equal(getActiveScene().name, "aurora-bloom");
    assert.equal(getCurrentTick(), tick);
  }
  selectScene("aurora-vortex");
});
