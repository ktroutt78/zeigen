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
    width: 560,
    height: 520,
    minWidth: 420,
    minHeight: 280,
    resizable: true,
    center: true,
  });
}
