import { test } from "node:test";
import assert from "node:assert/strict";
import { startBlockedReason, type StartInputs } from "./startReason.ts";

const base: StartInputs = {
  state: "idle",
  sourceKind: "display",
  picked: false,
  displays: 2,
  windows: 3,
  permissionDenied: false,
};
const r = (o: Partial<StartInputs>) => startBlockedReason({ ...base, ...o });

test("no reason when Start is enabled or busy", () => {
  assert.equal(r({ picked: true }), null);
  assert.equal(r({ state: "countdown" }), null);
  assert.equal(r({ state: "recording" }), null);
});

test("one reason per source", () => {
  assert.equal(r({}), "Pick a display to start");
  assert.equal(r({ sourceKind: "window" }), "Pick a window to start");
  assert.equal(r({ sourceKind: "window", windows: 0 }), "No windows to record. Open one, then pick it");
  assert.equal(r({ sourceKind: "area" }), "Select an area to start");
});

test("most actionable first: permission, then enumeration, then the pick", () => {
  assert.equal(r({ permissionDenied: true, displays: 0, sourceKind: "window" }), "Allow Screen Recording in System Settings to start");
  assert.equal(r({ displays: 0, sourceKind: "area" }), "Looking for displays…");
  // With displays listed, the denied permission isn't what blocks Start.
  assert.equal(r({ permissionDenied: true }), "Pick a display to start");
});
