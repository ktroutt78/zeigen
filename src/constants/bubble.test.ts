import { test } from "node:test";
import assert from "node:assert/strict";
import { bubbleScaleFor, shapeForRoundness, sizeForScale } from "./bubble.ts";

test("bubbleScaleFor: S / M / L relative to the recorded size", () => {
  assert.equal(bubbleScaleFor("medium", "medium"), 1);
  assert.equal(bubbleScaleFor("medium", "large"), 320 / 240);
  assert.equal(bubbleScaleFor("large", "small"), 180 / 320);
});

test("sizeForScale: round-trips and maps the old Small", () => {
  for (const r of ["small", "medium", "large"] as const) {
    for (const t of ["small", "medium", "large"] as const) {
      assert.equal(sizeForScale(r, bubbleScaleFor(r, t)), t);
    }
  }
  assert.equal(sizeForScale("medium", 0.5), "small"); // the old Normal / Small "Small"
});

test("shapeForRoundness: presets and old slider values", () => {
  assert.equal(shapeForRoundness(null), "circle");
  assert.equal(shapeForRoundness(0.52), "rounded");
  assert.equal(shapeForRoundness(0), "square");
  assert.equal(shapeForRoundness(0.9), "circle");
  assert.equal(shapeForRoundness(0.1), "square");
});
