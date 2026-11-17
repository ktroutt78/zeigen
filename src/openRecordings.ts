import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

// The Recordings window (kept recordings). One instance: focus it if open.
// Shared by the main window's button, the tray item (handled in the main
// window) and Review's header link.
const RECORDINGS_LABEL = "recordings";

export async function openRecordingsWindow(): Promise<void> {
  if (await invoke<boolean>("focus_window", { label: RECORDINGS_LABEL })) return;
  new WebviewWindow(RECORDINGS_LABEL, {
    url: "/#recordings",
    title: "Recordings",
    // Four cards across at the default width (recordings.css, .rec-grid),
    // two at the minimum.
    width: 900,
    height: 680,
    minWidth: 480,
    minHeight: 360,
    resizable: true,
    center: true,
  });
}
