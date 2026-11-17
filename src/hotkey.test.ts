// node --test src/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureKey, hotkeyGlyphs } from "./hotkey.ts";

test("hotkeyGlyphs: modifiers in macOS order, then the key", () => {
  assert.equal(hotkeyGlyphs("CmdOrCtrl+Shift+P"), "⇧⌘P");
  assert.equal(hotkeyGlyphs("Shift+Alt+Ctrl+CmdOrCtrl+K"), "⌃⌥⇧⌘K");
  assert.equal(hotkeyGlyphs("Alt+Shift+5"), "⌥⇧5");
  assert.equal(hotkeyGlyphs("CmdOrCtrl+Space"), "⌘Space");
  assert.equal(hotkeyGlyphs("Ctrl+ArrowUp"), "⌃↑");
  assert.equal(hotkeyGlyphs("F5"), "F5");
  assert.equal(hotkeyGlyphs("Ctrl+Alt+KeyR"), "⌃⌥R");
  assert.equal(hotkeyGlyphs("CmdOrCtrl+Shift+Minus"), "⇧⌘-");
});

const k = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  captureKey({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("captureKey: builds the stored combo", () => {
  assert.deepEqual(k("KeyP", { metaKey: true, shiftKey: true }), { kind: "combo", combo: "Shift+CmdOrCtrl+P" });
  assert.deepEqual(k("Digit5", { altKey: true, shiftKey: true }), { kind: "combo", combo: "Alt+Shift+5" });
  assert.deepEqual(k("Space", { ctrlKey: true }), { kind: "combo", combo: "Ctrl+Space" });
  assert.deepEqual(k("ArrowUp", { ctrlKey: true, altKey: true }), { kind: "combo", combo: "Ctrl+Alt+ArrowUp" });
});

test("captureKey: function keys work alone", () => {
  assert.deepEqual(k("F5"), { kind: "combo", combo: "F5" });
  assert.deepEqual(k("F12", { shiftKey: true }), { kind: "combo", combo: "Shift+F12" });
});

test("captureKey: a key without ⌘ ⌃ or ⌥ is refused, Shift alone too", () => {
  assert.equal(k("KeyP").kind, "refused");
  assert.equal(k("KeyP", { shiftKey: true }).kind, "refused");
});

test("captureKey: modifiers alone wait, Esc cancels", () => {
  assert.deepEqual(k("ShiftLeft", { shiftKey: true }), { kind: "wait" });
  assert.deepEqual(k("MetaRight", { metaKey: true }), { kind: "wait" });
  assert.deepEqual(k("Escape", { metaKey: true }), { kind: "cancel" });
});

test("stored combos round-trip to the symbols", () => {
  const r = k("KeyP", { metaKey: true, shiftKey: true });
  assert.equal(r.kind === "combo" && hotkeyGlyphs(r.combo), "⇧⌘P");
});
