// The start/stop hotkey, stored in the global-shortcut plugin's format
// ("CmdOrCtrl+Shift+P"), shown with Mac symbols ("⇧⌘P"). Pure, so it is
// unit-tested (hotkey.test.ts).

const MODS: Record<string, string> = {
  cmdorctrl: "⌘",
  commandorcontrol: "⌘",
  cmdorcontrol: "⌘",
  commandorctrl: "⌘",
  cmd: "⌘",
  command: "⌘",
  super: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  control: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
};
const MOD_ORDER = "⌃⌥⇧⌘";

const KEY_GLYPHS: Record<string, string> = {
  arrowup: "↑",
  up: "↑",
  arrowdown: "↓",
  down: "↓",
  arrowleft: "←",
  left: "←",
  arrowright: "→",
  right: "→",
  enter: "↩",
  backspace: "⌫",
  delete: "⌦",
  tab: "⇥",
  escape: "⎋",
  esc: "⎋",
  home: "↖",
  end: "↘",
  pageup: "⇞",
  pagedown: "⇟",
  space: "Space",
  minus: "-",
  equal: "=",
  bracketleft: "[",
  bracketright: "]",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  comma: ",",
  period: ".",
  slash: "/",
  backquote: "`",
};

function keyGlyph(key: string): string {
  const k = key.toLowerCase();
  if (KEY_GLYPHS[k]) return KEY_GLYPHS[k];
  const m = /^(?:key|digit)(.)$/i.exec(key);
  if (m) return m[1].toUpperCase();
  return key.length === 1 ? key.toUpperCase() : key;
}

// "CmdOrCtrl+Shift+P" -> "⇧⌘P": modifiers in macOS order (⌃ ⌥ ⇧ ⌘), then the key.
export function hotkeyGlyphs(combo: string): string {
  const mods: string[] = [];
  let key = "";
  for (const part of combo.split("+").map((s) => s.trim()).filter(Boolean)) {
    const g = MODS[part.toLowerCase()];
    if (g) mods.push(g);
    else key = keyGlyph(part);
  }
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return mods.join("") + key;
}

// The fields of a KeyboardEvent the recorder reads.
export type KeyPress = {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

export type Captured =
  | { kind: "wait" } // only modifiers so far
  | { kind: "cancel" } // Esc
  | { kind: "refused"; message: string }
  | { kind: "combo"; combo: string };

const MODIFIER_CODES = /^(Meta|Control|Alt|Shift|OS)(Left|Right)?$|^(CapsLock|Fn|FnLock)$/;

// One keydown in the recorder -> what to do with it. Uses the physical key
// (event.code), so Option's special characters don't leak in.
export function captureKey(e: KeyPress): Captured {
  if (e.code === "Escape") return { kind: "cancel" };
  if (!e.code || MODIFIER_CODES.test(e.code)) return { kind: "wait" };
  const key = e.code.replace(/^Key(.)$/, "$1").replace(/^Digit(.)$/, "$1");
  const fn = /^F\d{1,2}$/.test(key);
  if (!fn && !(e.metaKey || e.ctrlKey || e.altKey)) {
    return { kind: "refused", message: "Add ⌘, ⌃ or ⌥ to the key (function keys work alone)" };
  }
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("CmdOrCtrl");
  parts.push(key);
  return { kind: "combo", combo: parts.join("+") };
}
